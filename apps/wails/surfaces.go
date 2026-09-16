// Native surfaces and native modals for the soksak example.
//
// On every commit the page declares the frame of each surface and sends any
// [data-native-modal] element it opens. A surface is created as a webview added
// to the main window on the declared frame. Modals use another webview in the
// same window. webview.go owns their messages and native/ routes pointer input.
// The framework supplies the main window and the asset server.
package main

import (
	"errors"
	"fmt"
	"log"
	"net/url"
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
	ID string `json:"id"`
	// The asset server resolves this application's own addresses and passes the
	// rest through, so this host does not need to know which is which.
	URL     string `json:"url"`
	Visible bool   `json:"visible"`
	// Whether the page asked for this surface to be dimmed after losing focus.
	Dim bool `json:"dim"`
	Rect
}

type SyncRequest struct {
	// 연속적인 배치 갱신이 종료되었는지 나타낸다.
	Settled  bool      `json:"settled"`
	Surfaces []Surface `json:"surfaces"`
}

// The page's theme, forwarded to the pages this host serves.
type Theme struct {
	Scheme string            `json:"scheme"`
	Tokens map[string]string `json:"tokens"`
}

// What a [data-native-modal] element needs in order to be rendered in another view.
type OverlayRequest struct {
	Mode      string  `json:"mode"`
	Card      Rect    `json:"card"`
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	Rect      Rect    `json:"rect"`
	ClassName string  `json:"className"`
	HTML      string  `json:"html"`
	CSS       string  `json:"css"`
	Border    string  `json:"border"`
	Radius    float64 `json:"radius"`
}

// What the modal's view requests once it has loaded.
type OverlayContent struct {
	Mode      string `json:"mode"`
	Card      Rect   `json:"card"`
	Title     string `json:"title"`
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

// modal is what the child overlay webview is drawing now.
//
// The page shows one [data-native-modal] element at a time and closes it before
// it shows the next, so one record is enough and it names which modal it holds.
type modal struct {
	instance uint64
	// The element's id. The modal's own page names it in every call it makes, and
	// a call naming another modal is one the closed modal sent last.
	id      string
	content OverlayContent
	// Whether the page has rendered and the webview has been revealed.
	shown bool
}

type Surfaces struct {
	window   *application.WebviewWindow
	projects map[string]bool
	root     string
	ready    bool
	monitor  uintptr

	// Guards modal state and theme across host calls.
	// Views are only touched on the main thread and need no lock, so no path
	// holding this lock waits for the main thread.
	mu    sync.Mutex
	views map[string]*nativeWebview
	// A surface is a native view, so a press on it never reaches the page. This
	// maps a pressed view to the surface id the page uses.
	named map[uintptr]string
	// The surfaces in a live resize. A surface receives the start and the end of
	// a run, not one call per frame.
	live map[string]bool
	// Whether a run of updates is in progress. The page reports that on every
	// commit, and this is what makes run-began and run-ended the two edges of a
	// run rather than one message per frame.
	running         bool
	lastPreparation uint64
	// Whether the page has committed. This is what makes page-ready an edge.
	first sync.Once
	// The overlay is a webview inside main, created for each showing and closed
	// when dismissed. Instance numbers reject replies from an earlier showing.
	modalView *nativeWebview
	nextModal uint64
	modal     *modal
	shapes    map[string]*nativeShape
	shells    *Shells
	watch     sync.Once

	// The theme the main page last set. A page calls Theme after loading.
	theme Theme
}

// ShellOutput is one piece of a shell's output, as a page receives it.
type ShellOutput struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

// errNoWindow is returned when this application's window is gone. Every call
// here places or reads something in that window, so none of them can succeed.
var errNoWindow = errors.New("the main window is gone")

// WindowControls reports the area the window's own buttons occupy, in the page's
// coordinates. The page leaves that much of its first row empty. An empty rect
// means the window draws none.
func (s *Surfaces) WindowControls() (Rect, error) {
	win, ok := s.window, s.window != nil
	if !ok {
		return Rect{}, errNoWindow
	}
	var at Rect
	application.InvokeSync(func() { at = windowControls(win.NativeWindow()) })
	return at, nil
}

// Theme returns the current theme. A page calls it once after loading and
// subscribes to the theme event for later changes.
func (s *Surfaces) Theme() Theme {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.theme
}

// ShellOpen opens the shell behind a terminal surface. A page that reloads calls
// it again for a shell that is already running, which is left alone.
func (s *Surfaces) ShellOpen(id string) error {
	s.mu.Lock()
	root := s.root
	s.mu.Unlock()
	_, err := s.shells.Open(id, root)
	return err
}

// ShellWrite sends one line to a shell.
func (s *Surfaces) ShellWrite(id string, text string) error {
	return s.shells.Write(id, text)
}

// OverlayPick emits the key and value a modal's page changed. The main page
// decides what they mean.
func (s *Surfaces) OverlayPick(id string, instance uint64, key string, value string) error {
	s.mu.Lock()
	current := s.modal != nil && s.modal.id == id && s.modal.instance == instance
	s.mu.Unlock()
	if current {
		s.emit("overlay-pick", map[string]string{
			"id": id, "key": key, "value": value,
		})
	}
	return nil
}

func NewSurfaces(win *application.WebviewWindow) *Surfaces {
	s := &Surfaces{
		window: win, projects: map[string]bool{},
		views:  map[string]*nativeWebview{},
		named:  map[uintptr]string{},
		live:   map[string]bool{},
		shapes: map[string]*nativeShape{},
		// 아직 테마를 받지 않았을 때의 값. 빈 맵이 아니면 JSON 에 null 이 실리고,
		// 이 값을 받는 페이지는 토큰을 순회하다 멈춘다.
		theme: Theme{Tokens: map[string]string{}},
	}
	s.shells = NewShells(func(id, text string) { s.emit("shell-output", ShellOutput{ID: id, Text: text}) })
	return s
}

// OverlayShow renders one marked element in a hidden child webview. The view
// becomes visible only after its own document reports that it has rendered.
func (s *Surfaces) OverlayShow(req OverlayRequest) (Rect, error) {
	win, ok := s.window, s.window != nil
	if !ok {
		return Rect{}, errNoWindow
	}
	s.mu.Lock()
	previous := s.modal
	s.mu.Unlock()
	if previous != nil {
		_ = s.OverlayHide(previous.id)
	}
	var at Rect
	application.InvokeSync(func() { at = modalAligned(win.NativeWindow(), req.Rect) })
	s.mu.Lock()
	s.nextModal++
	instance := s.nextModal
	s.modal = &modal{
		id: req.ID, instance: instance,
		content: OverlayContent{Mode: req.Mode, Card: req.Card, Title: req.Title, CSS: req.CSS, ClassName: req.ClassName, HTML: req.HTML, Border: req.Border},
	}
	s.mu.Unlock()
	view, err := newNativeWebview(s, nativeWebviewOptions{
		URL: "about:blank", Hidden: true, Transparent: true,
		FillParent: req.Mode == "dialog",
		X:          at.X, Y: at.Y, Width: at.W, Height: at.H,
	})
	if err != nil {
		s.mu.Lock()
		s.modal = nil
		s.mu.Unlock()
		return Rect{}, err
	}
	application.InvokeSync(func() { modalViewConfigure(view.NativeView(), req.Title, req.Radius) })
	s.mu.Lock()
	s.modalView = view
	s.mu.Unlock()
	// Publish the view before starting a document that can call ModalReady.
	err = view.SetURL(fmt.Sprintf("overlay.html?id=%s&instance=%d", url.QueryEscape(req.ID), instance))
	if err != nil {
		_ = s.OverlayHide(req.ID)
		return Rect{}, err
	}
	return at, nil
}

// ShapeRequest is a rectangle the page draws above the surfaces.
//
// A shape is a plain layer-backed view, not a webview. Its fill and its line
// carry an alpha channel and composite over whatever the surfaces are showing;
// a webview cannot do that, because WebKit paints its own opaque background.
type ShapeRequest struct {
	ID        string     `json:"id"`
	Rect      Rect       `json:"rect"`
	Radius    float64    `json:"radius"`
	LineWidth float64    `json:"lineWidth"`
	Fill      [4]float64 `json:"fill"`
	Line      [4]float64 `json:"line"`
}

// SetShape draws the rectangle, creating its view on first use.
func (s *Surfaces) SetShape(req ShapeRequest) error {
	win, ok := s.window, s.window != nil
	if !ok {
		return errNoWindow
	}
	x, y := req.Rect.X, req.Rect.Y
	w, h := max1(req.Rect.W), max1(req.Rect.H)
	// 도형은 뷰이고 뷰는 주 스레드에서만 다룬다. 이 맵도 그렇게 다루면 잠금이 필요
	// 없고, 주 스레드가 잠금을 기다리는 일도 없다.
	application.InvokeSync(func() {
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
	application.InvokeSync(func() {
		shape, ok := s.shapes[id]
		if !ok {
			return
		}
		delete(s.shapes, id)
		shape.destroy()
	})
	return nil
}

// PlaceRequest is the new frame of an open modal's view. The page decides it; a
// drag on the card's grip changes the position and new content changes the size.
type PlaceRequest struct {
	ID   string `json:"id"`
	Rect Rect   `json:"rect"`
	Card Rect   `json:"card"`
}

// OverlayPlace changes the child webview's frame in the main window.
func (s *Surfaces) OverlayPlace(req PlaceRequest) (Rect, error) {
	win, ok := s.window, s.window != nil
	if !ok {
		return Rect{}, errNoWindow
	}
	s.mu.Lock()
	live, view := s.modal, s.modalView
	held := live != nil && live.id == req.ID && view != nil
	s.mu.Unlock()
	if !held {
		return Rect{}, nil
	}
	var at Rect
	application.InvokeSync(func() {
		at = modalAligned(win.NativeWindow(), req.Rect)
		view.SetBounds(at.X, at.Y, at.W, at.H)
	})
	s.mu.Lock()
	live.content.Card = req.Card
	s.mu.Unlock()
	s.emit("modal-position", map[string]any{"id": req.ID, "instance": live.instance, "card": req.Card})
	return at, nil
}

// OverlayHide destroys the child webview and returns keyboard focus to main.
func (s *Surfaces) OverlayHide(id string) error {
	s.mu.Lock()
	if s.modal == nil || s.modal.id != id {
		s.mu.Unlock()
		return nil
	}
	view := s.modalView
	s.modal, s.modalView = nil, nil
	s.mu.Unlock()
	s.setBackground(false)
	if view != nil {
		application.InvokeSync(func() { modalViewFocus(view.NativeView(), false) })
		view.Close()
	}
	return nil
}

// discardOverlay removes the old main document's modal when navigation commits.
// Its DOM and answer callback are gone, so the native view has no owner.
func (s *Surfaces) discardOverlay() {
	s.mu.Lock()
	view := s.modalView
	s.modal, s.modalView = nil, nil
	s.mu.Unlock()
	s.setBackground(false)
	if view != nil {
		view.Close()
	}
}

// OverlayUpdate replaces an open modal's content without rebuilding its view.
// A modal whose controls change the page's state is redrawn while it is open.
func (s *Surfaces) OverlayUpdate(req UpdateRequest) {
	content := req.OverlayContent
	s.mu.Lock()
	ok := s.modal != nil && s.modal.id == req.ID
	var instance uint64
	if ok {
		instance = s.modal.instance
		s.modal.content = content
	}
	s.mu.Unlock()
	if !ok {
		return
	}
	s.emit("modal-content", ModalContentEvent{ID: req.ID, Instance: instance, Content: content})
}

// ModalContentEvent is new content for one modal, as its page receives it.
type ModalContentEvent struct {
	Instance uint64         `json:"instance"`
	ID       string         `json:"id"`
	Content  OverlayContent `json:"content"`
}

// ModalContent returns the content the modal's view requests after loading.
func (s *Surfaces) ModalContent(id string, instance uint64) OverlayContent {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.modal != nil && s.modal.id == id && s.modal.instance == instance {
		return s.modal.content
	}
	return OverlayContent{}
}

// ModalReady reveals this showing exactly once. A destroyed document's late
// report cannot reveal or focus a newer showing of the same modal.
func (s *Surfaces) ModalReady(id string, instance uint64) {
	s.mu.Lock()
	live, view := s.modal, s.modalView
	first := live != nil && live.id == id && live.instance == instance && !live.shown && view != nil
	current := live != nil && live.id == id && live.instance == instance
	dialog := first && live.content.Mode == "dialog"
	if first {
		live.shown = true
	}
	s.mu.Unlock()
	if !first {
		if current {
			s.emit("modal-rendered", id)
		}
		return
	}
	application.InvokeSync(func() {
		s.setBackground(dialog)
		view.SetHidden(false)
		modalViewFocus(view.NativeView(), true)
	})
	s.emit("modal-rendered", id)
}

func (s *Surfaces) dialog() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.modal != nil && s.modal.content.Mode == "dialog"
}

func (s *Surfaces) setBackground(enabled bool) {
	if win, ok := s.window, s.window != nil; ok {
		win.ExecJS(fmt.Sprintf("window.__soksakBackground = %t", enabled))
	}
	application.InvokeSync(func() {
		for _, view := range s.views {
			view.setBackground(enabled)
		}
	})
}

// run emits run-began and run-ended. The page reports whether more updates
// follow; this emits an event only when that changes.
func (s *Surfaces) run(going bool) {
	if s.running == going {
		return
	}
	s.running = going
	if going {
		s.emit("run-began")
		return
	}
	s.emit("run-ended")
}

// resizing starts and ends a surface's live resize. The two calls are paired, so
// the state of each surface is kept here and only changes are passed on.
func (s *Surfaces) resizing(id string, view *nativeWebview, live bool) {
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
// press reports whether the view is a surface and emits its id. The page decides
// what the press means.
func (s *Surfaces) press(view uintptr) bool {
	id, ok := s.named[view]
	if !ok {
		return false
	}
	s.emit("surface-pressed", id)
	return true
}

// point emits one step of a left-button drag in the page's coordinates. Phase is
// 0 for a press, 1 for a move, 2 for a release.
//
// A divider's grab area is wider than the passage between two cards, so when the
// passage is one line wide that area lies under the surfaces. The page matches
// the point against its own dividers.
func (s *Surfaces) point(phase int, x float64, y float64) {
	s.emit("surface-input", InputStep{Phase: phase, X: x, Y: y})
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

// srgba converts the page's 0-255 channels to the 0-1 range AppKit takes. The
// alpha arrives already in that range.
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
	// 토큰이 없는 테마를 그대로 두면 다음 Theme 호출이 JSON 의 null 을 반환하고,
	// 그것을 받은 페이지는 토큰을 순회하다 멈춘다.
	if theme.Tokens == nil {
		theme.Tokens = map[string]string{}
	}
	s.mu.Lock()
	s.theme = theme
	s.mu.Unlock()
	s.emit("theme", theme)
	return nil
}

// SyncSurfaces makes the surface views match the frames the page declared.
//
// The work runs on the main thread: these are AppKit calls, and a service call
// arrives on a goroutine of its own.
func (s *Surfaces) SyncSurfaces(req SyncRequest) (PreparedSurfaces, error) {
	win, ok := s.window, s.window != nil
	if !ok {
		return PreparedSurfaces{}, errNoWindow
	}
	// The page has committed, so its window is on screen and its surfaces exist.
	// Anything that has to run once the application is drawn starts from here.
	s.first.Do(func() { s.emit("page-ready") })
	var prepared PreparedSurfaces
	var gone []string
	done := make(chan bool, 1)
	application.InvokeSync(func() {
		s.lastPreparation++
		prepared.Ticket = s.lastPreparation
		beginSurfaceLayout(win.NativeWindow(), prepared.Ticket, func(allowed bool) {
			if allowed {
				gone, prepared.Placements = s.apply(win, req)
				s.watch.Do(func() { s.monitor = watchMouse(win.NativeWindow(), s) })
			}
			done <- allowed
		})
	})
	if !<-done {
		return prepared, errNoWindow
	}
	// 셸을 끝내는 것은 그 프로세스를 기다리는 일이다. 주 스레드에서 기다리면 기다리는
	// 동안 화면이 멈춘다.
	for _, id := range gone {
		s.shells.Close(id)
	}
	return prepared, nil
}

// Placement is where one surface actually sits, in the page's coordinates. The
// page declares a rect and the host aligns it to the display's pixels, so the
// two differ and the page is told by how much.
type Placement struct {
	ID string `json:"id"`
	Rect
}

type PreparedSurfaces struct {
	Ticket     uint64      `json:"ticket"`
	Placements []Placement `json:"placements"`
}

// PresentSurfaces confirms DOM presentation without blocking the AppKit thread.
type PresentRequest struct {
	PreparedSurfaces
	Settled bool `json:"settled"`
}

func (s *Surfaces) PresentSurfaces(req PresentRequest) ([]Placement, error) {
	win, ok := s.window, s.window != nil
	if !ok {
		return nil, errNoWindow
	}
	done := make(chan []Placement, 1)
	var waiting bool
	application.InvokeSync(func() {
		waiting = afterSurfacePresentation(win.NativeWindow(), func() {
			out := make([]Placement, 0, len(req.Placements))
			for _, p := range req.Placements {
				view := s.views[p.ID]
				if view == nil {
					continue
				}
				out = append(out, Placement{ID: p.ID, Rect: surfaceFrame(view.NativeView())})
			}
			committed := commitSurfaceLayout(win.NativeWindow(), req.Ticket)
			if committed && req.Settled {
				s.run(false)
			}
			done <- out
		})
	})
	if !waiting {
		return nil, errors.New("native presentation is unavailable")
	}
	return <-done, nil
}

// apply creates, moves and removes the surface views, and returns the ids whose
// views are gone. The shells behind them are ended by the caller, off this
// thread.
func (s *Surfaces) apply(win *application.WebviewWindow, req SyncRequest) ([]string, []Placement) {
	if !req.Settled {
		s.run(true)
	}
	wanted := map[string]bool{}
	placed := make([]Placement, 0, len(req.Surfaces))
	place := func(id string, view *nativeWebview, want Rect) {
		want = modalAligned(win.NativeWindow(), want)
		view.SetBounds(want.X, want.Y, want.W, want.H)
		placed = append(placed, Placement{ID: id, Rect: surfaceFrame(view.NativeView())})
	}
	for _, surface := range req.Surfaces {
		wanted[surface.ID] = true
		w, h := max1(surface.W), max1(surface.H)
		// A webview with no area is not visible to anyone, so it is hidden
		// rather than left as a one pixel view.
		visible := surface.Visible && surface.W >= 1 && surface.H >= 1

		alpha := alphaFor(surface.Dim)
		want := Rect{X: surface.X, Y: surface.Y, W: w, H: h}
		if view, live := s.views[surface.ID]; live {
			s.resizing(surface.ID, view, !req.Settled)
			place(surface.ID, view, want)
			view.SetHidden(!visible)
			surfaceAlpha(view.NativeView(), alpha)
			continue
		}
		view, err := newNativeWebview(s, nativeWebviewOptions{
			URL:    surface.URL,
			X:      surface.X,
			Y:      surface.Y,
			Width:  w,
			Height: h,

			Hidden: !visible,
		})
		if err != nil {
			log.Printf("surface %s: %v", surface.ID, err)
			continue
		}
		surfaceAlpha(view.NativeView(), alpha)
		view.setBackground(s.dialog())
		s.views[surface.ID] = view
		s.named[uintptr(view.NativeView())] = surface.ID
		place(surface.ID, view, want)
	}

	// The page is the only writer of this list, so a surface missing from it is
	// a surface that is gone.
	var gone []string
	for id, view := range s.views {
		if wanted[id] {
			continue
		}
		s.resizing(id, view, false)
		delete(s.named, uintptr(view.NativeView()))
		view.Close()
		delete(s.views, id)
		gone = append(gone, id)
	}
	return gone, placed
}
