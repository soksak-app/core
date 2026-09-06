// Native surfaces and native modals for the soksak example.
//
// On every commit the page declares the frame each surface occupies, and it
// sends any [data-native-modal] element it opens. Each becomes a webview inside
// the main window, positioned on the declared frame.
//
// Wails has no API for adding a webview to a window, but it exposes the window,
// and a webview is a native view. See native_darwin.go.
//
// A view added that way cannot reach the app's asset server, which serves a
// scheme only its own webview resolves. The local pages a surface or a modal
// needs are served over http on a loopback address instead; see serve.go.
package main

import (
	"encoding/json"
	"log"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Rect is a frame in CSS pixels, relative to the page viewport.
type Rect struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

type Surface struct {
	ID  string `json:"id"`
	URL string `json:"url"`
	// Whether URL points outside this host. This host's own addresses are served
	// by the loopback server. Deciding by plugin kind here would require editing
	// this file for every plugin the page adds.
	External bool `json:"external"`
	Visible  bool `json:"visible"`
	// Whether the page asked for this surface to be dimmed after losing focus.
	Dim bool `json:"dim"`
	// The colour the view shows before its page paints, so a resize shows no white.
	Background [3]float64 `json:"background"`
	Rect
}

type SyncRequest struct {
	Viewport Viewport  `json:"viewport"`
	Surfaces []Surface `json:"surfaces"`
}

// Viewport is the page's own height. The page's view starts at the window content
// view's origin, so the height alone converts a rect measured from the page's top
// left into the bottom-left frame AppKit expects.
type Viewport struct {
	H float64 `json:"h"`
}

// The page's theme, forwarded to the pages this host serves.
type Theme struct {
	Scheme string            `json:"scheme"`
	Tokens map[string]string `json:"tokens"`
}

// What a [data-native-modal] element needs in order to be rendered in another view.
type OverlayRequest struct {
	ID         string     `json:"id"`
	Title      string     `json:"title"`
	Viewport   Viewport   `json:"viewport"`
	Rect       Rect       `json:"rect"`
	ClassName  string     `json:"className"`
	HTML       string     `json:"html"`
	CSS        string     `json:"css"`
	Border     string     `json:"border"`
	Radius     float64    `json:"radius"`
	Background [4]float64 `json:"background"`
}

// What the modal's view requests once it has loaded.
type OverlayContent struct {
	CSS       string `json:"css"`
	ClassName string `json:"className"`
	HTML      string `json:"html"`
	Border    string `json:"border"`
}

type modal struct {
	view    *nativeOverlay
	content OverlayContent
	radius  float64
}

// Where one surface was last placed. Held in the order the page declared them.
type placement struct {
	id      string
	frame   Rect
	layer   int
	visible bool
	alpha   float64
}

type Surfaces struct {
	// Guards modals, which the pages this host serves read over HTTP. Views are
	// only touched on the main thread and need no lock.
	mu    sync.Mutex
	views map[string]*nativeView
	// A surface is a native view, so a press on it never reaches the page. This
	// maps a pressed view to the surface id the page uses.
	named  map[uintptr]string
	modals map[string]*modal
	shapes map[string]*nativeShape
	shells *Shells
	pages  *Pages
	watch  sync.Once
}

// Message is one call from a page this app serves. The page names itself, so the
// answer goes back to the view that asked.
type Message struct {
	Name  string  `json:"name"`
	ID    string  `json:"id"`
	Text  string  `json:"text"`
	Key   string  `json:"key"`
	Value string  `json:"value"`
	W     float64 `json:"w"`
	H     float64 `json:"h"`
}

// answer dispatches one message from a surface or modal page.
func (s *Surfaces) answer(payload string) {
	var m Message
	if err := json.Unmarshal([]byte(payload), &m); err != nil {
		return
	}
	switch m.Name {
	case "terminal.open":
		if err := s.shells.Open(m.ID); err != nil {
			return
		}
		go s.forward(m.ID)
	case "terminal.write":
		_ = s.shells.Write(m.ID, m.Text)
	case "overlay.content":
		s.deliverModal(m.ID, "content", s.ModalContent(m.ID))
	case "overlay.ready":
		s.ModalReady(m.ID)
	case "overlay.pick":
		application.Get().Event.Emit("overlay-pick", map[string]string{
			"id": m.ID, "key": m.Key, "value": m.Value,
		})
	}
}

// boot is the value a page starts with, injected before its first script runs.
// A page that had to fetch this would spend a connection to get what this app
// already holds.
func (s *Surfaces) boot() string {
	payload, err := json.Marshal(s.pages.Theme())
	if err != nil {
		return "null"
	}
	return string(payload)
}

// forward sends one shell's output to the page showing it, until the shell ends.
func (s *Surfaces) forward(id string) {
	lines := s.shells.Listen(id)
	defer s.shells.Unlisten(id, lines)
	for text := range lines {
		s.deliverSurface(id, "output", text)
	}
}

// page is anything this app serves a document to: a surface's view, or the modal's
// own window. Both hold a webview on the same message channel.
type page interface {
	eval(js string)
}

// deliver runs __spDeliver in a page. Script runs on the main thread.
//
// The caller passes a page it holds. There is no test for nothing here: a nil
// pointer inside an interface is not nil, so a test would pass one through and
// the call would land on nothing anyway.
func deliver(view page, name string, value any) {
	payload, err := json.Marshal(value)
	if err != nil {
		return
	}
	call, err := json.Marshal(name)
	if err != nil {
		return
	}
	application.InvokeSync(func() {
		view.eval("window.__spDeliver(" + string(call) + "," + string(payload) + ")")
	})
}

func (s *Surfaces) deliverSurface(id, name string, value any) {
	s.mu.Lock()
	view, ok := s.views[id]
	s.mu.Unlock()
	// A shell can print after its surface is gone. Reading the map without asking
	// whether the key is there hands deliver a pointer that is nil but typed, and
	// the nil test inside an interface does not see it.
	if !ok {
		return
	}
	deliver(view, name, value)
}

func (s *Surfaces) deliverModal(id, name string, value any) {
	s.mu.Lock()
	live := s.modals[id]
	s.mu.Unlock()
	if live == nil {
		return
	}
	deliver(live.view, name, value)
}

// Tell sends the theme to every page this app serves. A page reads the theme it
// started with from the script injected into it, so this is only the change.
func (s *Surfaces) Tell(name string, value any) {
	s.mu.Lock()
	views := make([]page, 0, len(s.views)+len(s.modals))
	for _, view := range s.views {
		views = append(views, view)
	}
	for _, live := range s.modals {
		views = append(views, live.view)
	}
	s.mu.Unlock()
	for _, view := range views {
		deliver(view, name, value)
	}
}

func NewSurfaces(shells *Shells, pages *Pages) *Surfaces {
	made := &Surfaces{
		views:  map[string]*nativeView{},
		named:  map[uintptr]string{},
		modals: map[string]*modal{},
		shapes: map[string]*nativeShape{},
		shells: shells,
		pages:  pages,
	}
	onSurfaceMessage = made.answer
	return made
}

// OverlayShow creates a modal's view and stores its content.
//
// The view is created after the surface views, which places it above them. It
// stays hidden until it reports the size it needs.
func (s *Surfaces) OverlayShow(req OverlayRequest) error {
	win, ok := mainWindow()
	if !ok {
		return nil
	}
	application.InvokeSync(func() {
		s.mu.Lock()
		defer s.mu.Unlock()

		if was := s.modals[req.ID]; was != nil {
			was.view.destroy()
		}
		x, y := req.Rect.X, up(req.Viewport, req.Rect.Y, max1(req.Rect.H))
		url := s.pages.URL("overlay.html?id=" + req.ID + "&framework=wailsv3")
		view := newNativeOverlay(win.NativeWindow(), url, req.Title, x, y,
			max1(req.Rect.W), max1(req.Rect.H), srgba(req.Background), s.boot())
		// A platform with no window to make has no modal. Recording one whose view
		// is nil leaves an entry every reader has to test, and one that misses the
		// test calls a method on nothing.
		if view == nil {
			log.Printf("modal %s: no native window on this platform", req.ID)
			delete(s.modals, req.ID)
			return
		}
		s.modals[req.ID] = &modal{
			view:   view,
			radius: req.Radius,
			content: OverlayContent{
				CSS: req.CSS, ClassName: req.ClassName, HTML: req.HTML, Border: req.Border,
			},
		}
	})
	return nil
}

// ShapeRequest is a rectangle the page draws above the surfaces.
//
// A shape is a plain layer-backed view, not a webview. Its fill and its line
// carry an alpha channel and composite over whatever the surfaces are showing;
// a webview cannot do that, because WebKit paints its own opaque background.
type ShapeRequest struct {
	ID        string     `json:"id"`
	Viewport  Viewport   `json:"viewport"`
	Rect      Rect       `json:"rect"`
	Radius    float64    `json:"radius"`
	LineWidth float64    `json:"lineWidth"`
	Fill      [4]float64 `json:"fill"`
	Line      [4]float64 `json:"line"`
}

// SetShape draws the rectangle, creating its view on first use.
func (s *Surfaces) SetShape(req ShapeRequest) error {
	win, ok := mainWindow()
	if !ok {
		return nil
	}
	x, y := req.Rect.X, up(req.Viewport, req.Rect.Y, max1(req.Rect.H))
	w, h := max1(req.Rect.W), max1(req.Rect.H)
	application.InvokeSync(func() {
		s.mu.Lock()
		defer s.mu.Unlock()

		shape := s.shapes[req.ID]
		if shape == nil {
			shape = newNativeShape(win.NativeWindow(), x, y, w, h)
			if shape == nil {
				return
			}
			s.shapes[req.ID] = shape
		} else {
			shape.setFrame(x, y, w, h)
		}
		shape.setStyle(req.Radius, req.LineWidth, srgba(req.Fill), srgba(req.Line))
		shape.raise()
	})
	return nil
}

// ClearShape removes the rectangle.
func (s *Surfaces) ClearShape(id string) error {
	s.mu.Lock()
	shape, ok := s.shapes[id]
	if !ok {
		s.mu.Unlock()
		return nil
	}
	delete(s.shapes, id)
	s.mu.Unlock()

	application.InvokeSync(shape.destroy)
	return nil
}

// PlaceRequest is the new position of an open modal's view. The page decides the
// position; a drag on the card's grip is what changes it.
type PlaceRequest struct {
	ID       string   `json:"id"`
	Viewport Viewport `json:"viewport"`
	Rect     Rect     `json:"rect"`
}

// OverlayPlace moves an open modal's view.
func (s *Surfaces) OverlayPlace(req PlaceRequest) error {
	s.mu.Lock()
	live, ok := s.modals[req.ID]
	if !ok {
		s.mu.Unlock()
		return nil
	}
	view := live.view
	s.mu.Unlock()

	x, y := req.Rect.X, up(req.Viewport, req.Rect.Y, max1(req.Rect.H))
	application.InvokeSync(func() {
		view.setFrame(x, y, max1(req.Rect.W), max1(req.Rect.H))
	})
	return nil
}

// OverlayHide closes a modal's window and forgets it. The entry goes with the
// window: a modal that is recorded but has no window is a state nothing needs.
func (s *Surfaces) OverlayHide(id string) error {
	s.mu.Lock()
	live, ok := s.modals[id]
	if !ok {
		s.mu.Unlock()
		return nil
	}
	delete(s.modals, id)
	s.mu.Unlock()

	application.InvokeSync(live.view.destroy)
	return nil
}

// OverlayUpdate replaces an open modal's content without rebuilding its view.
// A modal whose controls change the page's state is redrawn while it is open.
func (s *Surfaces) OverlayUpdate(req OverlayRequest) error {
	content := OverlayContent{
		CSS: req.CSS, ClassName: req.ClassName, HTML: req.HTML, Border: req.Border,
	}
	s.mu.Lock()
	live, ok := s.modals[req.ID]
	if ok {
		live.content = content
	}
	s.mu.Unlock()
	if !ok {
		return nil
	}
	s.pages.NotifyModal(req.ID, content)
	return nil
}

// ModalContent returns the content the modal's view requests after loading.
func (s *Surfaces) ModalContent(id string) OverlayContent {
	s.mu.Lock()
	defer s.mu.Unlock()
	if live, ok := s.modals[id]; ok {
		return live.content
	}
	return OverlayContent{}
}

// ModalReady clips the modal's corners and shows it. A child window is always
// above its parent, so there is nothing to raise. The page reports this once
// its content is on screen; showing it earlier displays an empty view.
//
// The size is not set here. The main page measured the element and the view was
// created at that size, so a second measurement taken inside the view would be
// of the same element under a different constraint and the two would disagree.
func (s *Surfaces) ModalReady(id string) {
	s.mu.Lock()
	live, ok := s.modals[id]
	if !ok {
		s.mu.Unlock()
		return
	}
	view, radius := live.view, live.radius
	s.mu.Unlock()

	application.InvokeSync(func() {
		view.setCornerRadius(radius)
		view.show()
	})
}

// up converts a top-left y to the bottom-left y AppKit uses.
func up(viewport Viewport, y, h float64) float64 { return viewport.H - y - h }

// press reports whether the view is one of the surfaces and sends its id to the
// page. What the press means is decided by the page.
func (s *Surfaces) press(view uintptr) bool {
	id, ok := s.named[view]
	if !ok {
		return false
	}
	application.Get().Event.Emit("surface-pressed", id)
	return true
}

// point sends one step of a left-button drag to the page, in the page's
// coordinates. Phase is 0 for a press, 1 for a move, 2 for a release.
//
// A divider's grab area is wider than the passage between two cards, so when the
// passage is one line wide that area lies over the surfaces. The page matches the
// point against its own dividers and decides what it means.
func (s *Surfaces) point(phase int, x float64, y float64) {
	application.Get().Event.Emit("surface-input", InputStep{Phase: phase, X: x, Y: y})
}

// InputStep is one step of a drag, as the page receives it.
type InputStep struct {
	Phase int     `json:"phase"`
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
}

// alphaFor returns the alpha for a surface. The page decides whether to dim it.
func alphaFor(dim bool) float64 {
	if dim {
		return 0.45
	}
	return 1
}

// srgb converts the page's 0-255 channels to the 0-1 range AppKit takes.
func srgb(c [3]float64) [3]float64 {
	return [3]float64{c[0] / 255, c[1] / 255, c[2] / 255}
}

// srgba is srgb with the alpha the page reported, which arrives already 0-1.
func srgba(c [4]float64) [4]float64 {
	return [4]float64{c[0] / 255, c[1] / 255, c[2] / 255, c[3]}
}

func max1(v float64) float64 {
	if v < 1 {
		return 1
	}
	return v
}

func mainWindow() (*application.WebviewWindow, bool) {
	w, ok := application.Get().Window.GetByName("main")
	if !ok {
		return nil, false
	}
	win, ok := w.(*application.WebviewWindow)
	return win, ok
}

// Report writes one line from the page's checks into this app's log. The page
// cannot write a file, and its console is not visible outside a debugger.
func (s *Surfaces) Report(line string) error {
	log.Println(line)
	return nil
}

// SetTheme records the theme the page is now drawn in, for the pages this host
// serves. The page calls it when a theme is chosen, not on every render.
func (s *Surfaces) SetTheme(theme Theme) error {
	s.pages.SetTheme(theme)
	return nil
}

// SyncSurfaces makes the surface views match the frames the page declared.
//
// The work runs on the main thread: these are AppKit calls, and a service call
// arrives on a goroutine of its own.
func (s *Surfaces) SyncSurfaces(req SyncRequest) error {
	win, ok := mainWindow()
	if !ok {
		return nil
	}
	application.InvokeSync(func() {
		s.apply(win, req)
		s.watch.Do(func() {
			pressed = s.press
			pointed = s.point
			watchMouse(win.NativeWindow())
		})
	})
	return nil
}

func (s *Surfaces) apply(win *application.WebviewWindow, req SyncRequest) {
	wanted := map[string]bool{}
	for _, surface := range req.Surfaces {
		wanted[surface.ID] = true
		w, h := max1(surface.W), max1(surface.H)
		x, y := surface.X, up(req.Viewport, surface.Y, h)

		alpha := alphaFor(surface.Dim)
		if view, live := s.views[surface.ID]; live {
			view.setFrame(x, y, w, h)
			view.setHidden(!surface.Visible)
			view.setAlpha(alpha)
			continue
		}
		url := surface.URL
		if !surface.External {
			url = s.pages.URL(surface.URL)
		}
		bg := srgb(surface.Background)
		view := newNativeView(win.NativeWindow(), url, x, y, w, h,
			[4]float64{bg[0], bg[1], bg[2], 1}, s.boot())
		if view == nil {
			log.Printf("surface %s: no native view on this platform", surface.ID)
			continue
		}
		view.setAlpha(alpha)
		s.views[surface.ID] = view
		s.named[view.id()] = surface.ID
	}

	// The page is the only writer of this list, so a surface missing from it is
	// a surface that is gone.
	for id, view := range s.views {
		if wanted[id] {
			continue
		}
		delete(s.named, view.id())
		view.destroy()
		delete(s.views, id)
		s.shells.Close(id)
	}
}
