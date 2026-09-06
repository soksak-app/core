// Native surfaces and native modals for the soksak example.
//
// On every commit the page declares the frame of each surface and sends any
// [data-native-modal] element it opens. A surface is created as a webview added
// to the main window on the declared frame. A modal is created as a window
// attached over the point the page declares, because a page cannot draw over a
// webview the system composites and two webviews in one window both set the
// cursor.
//
// Both load from the application's own scheme, import its runtime and receive
// its events.
package main

import (
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
	// Whether URL points outside this application. Its own addresses are served
	// by its asset server. Deciding by plugin kind here would require editing
	// this file for every plugin the page adds.
	External bool `json:"external"`
	Visible  bool `json:"visible"`
	// Whether the page asked for this surface to be dimmed after losing focus.
	Dim bool `json:"dim"`
	// The colour the webview displays before its document renders.
	Background [3]float64 `json:"background"`
	Rect
}

type SyncRequest struct {
	Viewport Viewport `json:"viewport"`
	// Whether this is the last update or one of a continuing run. During a run
	// the surfaces are put in a live resize, in which WKWebView keeps the last
	// rendered content instead of showing unrendered white.
	Settled  bool      `json:"settled"`
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

// UpdateRequest is new content for an open modal. It carries what the page
// measured of the element and nothing else: a modal that is already open keeps
// its position and size.
type UpdateRequest struct {
	ID string `json:"id"`
	OverlayContent
}

type modal struct {
	// The modal is a window of this application, attached over the point the page
	// put it at.
	window  *application.WebviewWindow
	content OverlayContent
	// Where the page last put it, in the main window's content.
	at Rect
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
	views map[string]*application.Webview
	// A surface is a native view, so a press on it never reaches the page. This
	// maps a pressed view to the surface id the page uses.
	named map[uintptr]string
	// The surfaces in a live resize. A surface receives the start and the end of
	// a run, not one call per frame.
	live map[string]bool
	// Whether a run of updates is in progress. Only changes are emitted.
	running bool
	modals  map[string]*modal
	shapes  map[string]*nativeShape
	shells  *Shells
	watch   sync.Once

	// The theme the main page last set. A page calls Theme after loading.
	theme Theme
}

// forward emits one shell's output until the shell ends.
//
// The output is emitted as an event. Every page receives it and the page
// rendering that shell filters by id.
func (s *Surfaces) forward(id string) {
	lines := s.shells.Listen(id)
	defer s.shells.Unlisten(id, lines)
	for text := range lines {
		application.Get().Event.Emit("shell-output", ShellOutput{ID: id, Text: text})
	}
}

// ShellOutput is one piece of a shell's output, as a page receives it.
type ShellOutput struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

// Theme returns the current theme. A page calls it once after loading and
// subscribes to the theme event for later changes.
func (s *Surfaces) Theme() Theme {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.theme
}

// ShellOpen opens the shell behind a terminal surface and forwards its output.
//
// A page that reloads calls this again for a shell that is already running. Only
// a shell this call started gets a forwarder, so the output is not emitted twice.
func (s *Surfaces) ShellOpen(id string) error {
	started, err := s.shells.Open(id)
	if err != nil {
		return err
	}
	if started {
		go s.forward(id)
	}
	return nil
}

// ShellWrite sends one line to a shell.
func (s *Surfaces) ShellWrite(id string, text string) error {
	return s.shells.Write(id, text)
}

// OverlayPick emits the key and value a modal's page changed. The main page
// decides what they mean.
func (s *Surfaces) OverlayPick(id string, key string, value string) error {
	application.Get().Event.Emit("overlay-pick", map[string]string{
		"id": id, "key": key, "value": value,
	})
	return nil
}

func NewSurfaces(shells *Shells) *Surfaces {
	return &Surfaces{
		views:  map[string]*application.Webview{},
		named:  map[uintptr]string{},
		live:   map[string]bool{},
		modals: map[string]*modal{},
		shapes: map[string]*nativeShape{},
		shells: shells,
	}
}

// OverlayShow creates a modal's window and stores its content.
//
// The window is created hidden and stays hidden until the page reports that its
// content is rendered; showing it earlier displays an empty window. It is
// attached at the same point, so it is never drawn at the wrong position.
func (s *Surfaces) OverlayShow(req OverlayRequest) error {
	s.mu.Lock()
	if was := s.modals[req.ID]; was != nil {
		s.mu.Unlock()
		s.OverlayHide(req.ID)
		s.mu.Lock()
	}
	s.modals[req.ID] = &modal{
		window: application.Get().Window.NewWithOptions(application.WebviewWindowOptions{
			Name:      "modal-" + req.ID,
			Title:     req.Title,
			URL:       "overlay.html?id=" + req.ID,
			Width:     int(max1(req.Rect.W)),
			Height:    int(max1(req.Rect.H)),
			Frameless: true,
			Hidden:    true,
			BackgroundColour: application.NewRGBA(
				uint8(req.Background[0]), uint8(req.Background[1]),
				uint8(req.Background[2]), uint8(req.Background[3]*255)),
			Mac: application.MacWindow{CornerRadius: req.Radius},
		}),
		at: req.Rect,
		content: OverlayContent{
			CSS: req.CSS, ClassName: req.ClassName, HTML: req.HTML, Border: req.Border,
		},
	}
	s.mu.Unlock()
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

// OverlayPlace moves an open modal's window. The page decides the position; a
// drag on the card's grip changes it.
func (s *Surfaces) OverlayPlace(req PlaceRequest) error {
	win, ok := mainWindow()
	if !ok {
		return nil
	}
	s.mu.Lock()
	live, held := s.modals[req.ID]
	if held {
		live.at = req.Rect
	}
	s.mu.Unlock()
	if !held {
		return nil
	}
	live.window.Attach(win, req.Rect.X, req.Rect.Y)
	return nil
}

// OverlayHide closes a modal's window and deletes its record. A record without a
// window has no reader.
func (s *Surfaces) OverlayHide(id string) error {
	s.mu.Lock()
	live, ok := s.modals[id]
	if !ok {
		s.mu.Unlock()
		return nil
	}
	delete(s.modals, id)
	s.mu.Unlock()

	live.window.Detach()
	live.window.Close()
	// The modal took the keyboard when it opened, so the page gets it back.
	if win, ok := mainWindow(); ok {
		win.Focus()
	}
	application.Get().Event.Emit("windows-changed")
	return nil
}

// OverlayUpdate replaces an open modal's content without rebuilding its view.
// A modal whose controls change the page's state is redrawn while it is open.
func (s *Surfaces) OverlayUpdate(req UpdateRequest) error {
	content := req.OverlayContent
	s.mu.Lock()
	live, ok := s.modals[req.ID]
	if ok {
		live.content = content
	}
	s.mu.Unlock()
	if !ok {
		return nil
	}
	application.Get().Event.Emit("modal-content", ModalContentEvent{ID: req.ID, Content: content})
	return nil
}

// ModalContentEvent is new content for one modal, as its page receives it.
type ModalContentEvent struct {
	ID      string         `json:"id"`
	Content OverlayContent `json:"content"`
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

// ModalReady shows the modal's window and attaches it over the declared point.
// The page calls it once its content is rendered.
//
// The size is not set here. The main page measured the element and the window was
// created at that size; measuring the same markup inside the window would apply a
// different constraint and produce a different size.
func (s *Surfaces) ModalReady(id string) {
	win, ok := mainWindow()
	if !ok {
		return
	}
	s.mu.Lock()
	live, held := s.modals[id]
	s.mu.Unlock()
	if !held {
		return
	}
	live.window.Show()
	live.window.Attach(win, live.at.X, live.at.Y)
	live.window.Focus()
	// 모달은 자기 창이므로 이 앱이 가진 창이 하나 늘었다. 창이 붙고 떨어지는 것을
	// 알리는 통지는 AppKit 에 없고, 붙이는 것은 여기다. 그래서 여기서 알린다.
	application.Get().Event.Emit("windows-changed")
}

// run emits run-began and run-ended. The page reports whether more updates
// follow; this emits an event only when that changes.
func (s *Surfaces) run(going bool) {
	if s.running == going {
		return
	}
	s.running = going
	if going {
		application.Get().Event.Emit("run-began")
		return
	}
	application.Get().Event.Emit("run-ended")
}

// resizing starts and ends a surface's live resize. The two calls are paired, so
// the state of each surface is kept here and only changes are passed on.
func (s *Surfaces) resizing(id string, view *application.Webview, live bool) {
	if s.live[id] == live {
		return
	}
	if live {
		s.live[id] = true
	} else {
		delete(s.live, id)
	}
	surfaceResizing(view.NativeView(), live)
}

// up converts a top-left y to the bottom-left y AppKit uses.
func up(viewport Viewport, y, h float64) float64 { return viewport.H - y - h }

// press reports whether the view is a surface and emits its id. The page decides
// what the press means.
func (s *Surfaces) press(view uintptr) bool {
	id, ok := s.named[view]
	if !ok {
		return false
	}
	application.Get().Event.Emit("surface-pressed", id)
	return true
}

// point emits one step of a left-button drag in the page's coordinates. Phase is
// 0 for a press, 1 for a move, 2 for a release.
//
// A divider's grab area is wider than the passage between two cards, so when the
// passage is one line wide that area lies under the surfaces. The page matches
// the point against its own dividers.
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

// SetTheme records the theme and emits it to the pages already open. The main
// page calls it when a theme is chosen, not on every render.
func (s *Surfaces) SetTheme(theme Theme) error {
	s.mu.Lock()
	s.theme = theme
	s.mu.Unlock()
	application.Get().Event.Emit("theme", theme)
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
	s.run(!req.Settled)
	wanted := map[string]bool{}
	for _, surface := range req.Surfaces {
		wanted[surface.ID] = true
		w, h := max1(surface.W), max1(surface.H)
		// A webview with no area is not visible to anyone, so it is hidden
		// rather than left as a one pixel view.
		visible := surface.Visible && surface.W >= 1 && surface.H >= 1

		alpha := alphaFor(surface.Dim)
		if view, live := s.views[surface.ID]; live {
			s.resizing(surface.ID, view, !req.Settled)
			view.SetBounds(surface.X, surface.Y, w, h)
			view.SetHidden(!visible)
			surfaceAlpha(view.NativeView(), alpha)
			continue
		}
		bg := surface.Background
		view, err := win.AddWebview(application.WebviewOptions{
			URL:    surface.URL,
			X:      surface.X,
			Y:      surface.Y,
			Width:  w,
			Height: h,
			BackgroundColour: application.NewRGB(
				uint8(bg[0]), uint8(bg[1]), uint8(bg[2])),
			// A webview renders only the area it has laid out and fills the rest
			// with white. A surface grows while a boundary is dragged, so that
			// area appears on every frame of the drag.
			Transparent: true,
			Hidden:      !surface.Visible,
		})
		if view == nil {
			log.Printf("surface %s: no webview in a window on this platform", surface.ID)
			continue
		}
		surfaceAlpha(view.NativeView(), alpha)
		s.views[surface.ID] = view
		s.named[uintptr(view.NativeView())] = surface.ID
	}

	// The page is the only writer of this list, so a surface missing from it is
	// a surface that is gone.
	for id, view := range s.views {
		if wanted[id] {
			continue
		}
		s.resizing(id, view, false)
		delete(s.named, uintptr(view.NativeView()))
		view.Close()
		delete(s.views, id)
		s.shells.Close(id)
	}
}
