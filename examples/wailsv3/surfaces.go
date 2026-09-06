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
	"errors"
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
	ID string `json:"id"`
	// The asset server resolves this application's own addresses and passes the
	// rest through, so this host does not need to know which is which.
	URL     string `json:"url"`
	Visible bool   `json:"visible"`
	// Whether the page asked for this surface to be dimmed after losing focus.
	Dim bool `json:"dim"`
	// The colour the webview displays before its document renders.
	Background [3]float64 `json:"background"`
	Rect
}

type SyncRequest struct {
	// Whether this is the last update or one of a continuing run. During a run
	// the surfaces are put in a live resize, in which WKWebView keeps the last
	// rendered content instead of showing unrendered white.
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
	ID         string     `json:"id"`
	Title      string     `json:"title"`
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
	// The frame the window was last placed at, in the main window's content.
	at Rect
	// Whether the page has reported its content drawn, which is when the window
	// is shown and attached.
	shown bool
}

type Surfaces struct {
	// Guards modals and theme, which the pages this host serves read over HTTP.
	// Views are only touched on the main thread and need no lock, so no path
	// holding this lock waits for the main thread.
	mu    sync.Mutex
	views map[string]*application.Webview
	// A surface is a native view, so a press on it never reaches the page. This
	// maps a pressed view to the surface id the page uses.
	named map[uintptr]string
	// The surfaces in a live resize. A surface receives the start and the end of
	// a run, not one call per frame.
	live map[string]bool
	// Whether a run of updates is in progress. The page reports that on every
	// commit, and this is what makes run-began and run-ended the two edges of a
	// run rather than one message per frame.
	running bool
	// Whether the page has committed. This is what makes page-ready an edge.
	first  sync.Once
	modals map[string]*modal
	shapes map[string]*nativeShape
	shells *Shells
	watch  sync.Once

	// The theme the main page last set. A page calls Theme after loading.
	theme Theme
}

// emitShellOutput sends one line of a shell's output as an event. Every page
// receives it and the page rendering that shell filters by id.
func emitShellOutput(id string, text string) {
	application.Get().Event.Emit("shell-output", ShellOutput{ID: id, Text: text})
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
	win, ok := mainWindow()
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
	_, err := s.shells.Open(id)
	return err
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
		// 아직 테마를 받지 않았을 때의 값. 빈 맵이 아니면 JSON 에 null 이 실리고,
		// 이 값을 받는 페이지는 토큰을 순회하다 멈춘다.
		theme:  Theme{Tokens: map[string]string{}},
	}
}

// OverlayShow creates a modal's window, stores its content, and reports the
// frame the window was created at.
//
// The window is created hidden and stays hidden until the page reports that its
// content is rendered; showing it earlier displays an empty window. It is
// attached at the same point, so it is never drawn at the wrong position.
func (s *Surfaces) OverlayShow(req OverlayRequest) (Rect, error) {
	win, ok := mainWindow()
	if !ok {
		return Rect{}, errNoWindow
	}
	// 같은 id 의 모달이 열려 있으면 닫는다. 없으면 아무 일도 하지 않는다.
	s.OverlayHide(req.ID)
	var at Rect
	var sx, sy int
	application.InvokeSync(func() {
		at = modalAligned(win.NativeWindow(), req.Rect)
		sx, sy = modalOnScreen(win.NativeWindow(), at)
	})
	// 창을 만드는 것은 주 스레드의 일이고 이 호출은 그것이 끝날 때까지 기다린다.
	// 잠금을 쥔 채로 기다리면, 주 스레드에서 같은 잠금을 잡는 호출과 서로를 기다린다.
	live := &modal{
		window: application.Get().Window.NewWithOptions(application.WebviewWindowOptions{
			Name:      "modal-" + req.ID,
			Title:     req.Title,
			URL:       "overlay.html?id=" + req.ID,
			Width:     int(at.W),
			Height:    int(at.H),
			Frameless: true,
			Hidden:    true,
			// 최종 자리에 만든다. 자리를 주지 않으면 화면 가운데에 만들어지고,
			// 표시한 뒤에 옮기게 되어 가운데에 한 번 그려진다.
			InitialPosition: application.WindowXY,
			X:               sx,
			Y:               sy,
			BackgroundColour: application.NewRGBA(
				uint8(req.Background[0]), uint8(req.Background[1]),
				uint8(req.Background[2]), uint8(req.Background[3]*255)),
			Mac: application.MacWindow{CornerRadius: req.Radius},
		}),
		at: at,
		content: OverlayContent{
			CSS: req.CSS, ClassName: req.ClassName, HTML: req.HTML, Border: req.Border,
		},
	}
	application.InvokeSync(func() { modalConfigure(live.window.NativeWindow(), req.Title) })
	s.mu.Lock()
	s.modals[req.ID] = live
	s.mu.Unlock()
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
	win, ok := mainWindow()
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
}

// OverlayPlace moves and resizes an open modal's window and reports where it
// ended up. The page decides both; a drag on the card's grip changes the
// position and new content changes the size.
//
// The frame reported is the one applied, which is the page's rect snapped to the
// display's pixels. The page declares a rect and the host places the window on
// whole pixels, so the two differ and the page is told by how much.
func (s *Surfaces) OverlayPlace(req PlaceRequest) (Rect, error) {
	win, ok := mainWindow()
	if !ok {
		return Rect{}, errNoWindow
	}
	s.mu.Lock()
	live, held := s.modals[req.ID]
	// shown 은 모달 문서의 호출이 다른 고루틴에서 기록한다. 잠금 밖에서 읽으면 이미
	// 표시된 모달을 표시 전으로 보고 붙이지 않는다.
	shown := held && live.shown
	s.mu.Unlock()
	if !held {
		return Rect{}, nil
	}
	var at Rect
	application.InvokeSync(func() {
		at = modalAligned(win.NativeWindow(), req.Rect)
		// 내용이 바뀌면 카드의 크기도 바뀐다. 크기를 함께 적용하지 않으면 창은
		// 만들어진 크기를 유지하고 그 안의 카드가 늘어나거나 잘린다.
		live.window.SetSize(int(at.W), int(at.H))
		// 붙이는 것은 창을 화면에 올리는 일이므로, 내용이 그려졌다고 페이지가
		// 보고하기 전에는 자리만 기록한다.
		if !shown {
			sx, sy := modalOnScreen(win.NativeWindow(), at)
			live.window.SetPosition(sx, sy)
		} else if err := live.window.Attach(win, at.X, at.Y); err != nil {
			log.Printf("modal %s: %v", req.ID, err)
		}
	})
	s.mu.Lock()
	live.at = at
	s.mu.Unlock()
	return at, nil
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
func (s *Surfaces) OverlayUpdate(req UpdateRequest) {
	content := req.OverlayContent
	s.mu.Lock()
	live, ok := s.modals[req.ID]
	if ok {
		live.content = content
	}
	s.mu.Unlock()
	if !ok {
		return
	}
	application.Get().Event.Emit("modal-content", ModalContentEvent{ID: req.ID, Content: content})
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
		log.Print("modal ready: ", errNoWindow)
		return
	}
	s.mu.Lock()
	live, held := s.modals[id]
	var at Rect
	// 모달 문서는 렌더링할 때마다 보고하고, 이 애플리케이션은 문서가 로드되기 전에
	// 보낸 내용 갱신을 로드 후에 전달한다. 표시는 한 번만 한다.
	first := held && !live.shown
	if held {
		at = live.at
		live.shown = true
	}
	s.mu.Unlock()
	if !first {
		return
	}
	live.window.Show()
	if err := live.window.Attach(win, at.X, at.Y); err != nil {
		log.Printf("modal %s: %v", id, err)
	}
	live.window.Focus()
	// 모달이 키보드를 가져가므로 앱의 창을 다시 main 으로 만든다. 그러지 않으면 그
	// 창의 제목 표시줄이 모달이 열려 있는 동안 비활성으로 그려진다.
	application.InvokeSync(func() { windowMakeMain(win.NativeWindow()) })
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
	application.Get().Event.Emit("theme", theme)
	return nil
}

// SyncSurfaces makes the surface views match the frames the page declared.
//
// The work runs on the main thread: these are AppKit calls, and a service call
// arrives on a goroutine of its own.
func (s *Surfaces) SyncSurfaces(req SyncRequest) ([]Placement, error) {
	win, ok := mainWindow()
	if !ok {
		return nil, errNoWindow
	}
	// The page has committed, so its window is on screen and its surfaces exist.
	// Anything that has to run once the application is drawn starts from here.
	s.first.Do(func() { application.Get().Event.Emit("page-ready") })
	var placed []Placement
	var gone []string
	application.InvokeSync(func() {
		gone = s.apply(win, req)
		placed = s.placements(req)
		s.watch.Do(func() {
			pressed = s.press
			pointed = s.point
			watchMouse(win.NativeWindow())
		})
	})
	// 셸을 끝내는 것은 그 프로세스를 기다리는 일이다. 주 스레드에서 기다리면 기다리는
	// 동안 화면이 멈춘다.
	for _, id := range gone {
		s.shells.Close(id)
	}
	return placed, nil
}

// Placement is where one surface actually sits, in the page's coordinates. The
// page declares a rect and the host aligns it to the display's pixels, so the
// two differ and the page is told by how much.
type Placement struct {
	ID string `json:"id"`
	Rect
}

// placements reads back the frame of every surface the page declared.
func (s *Surfaces) placements(req SyncRequest) []Placement {
	out := make([]Placement, 0, len(req.Surfaces))
	for _, surface := range req.Surfaces {
		view, live := s.views[surface.ID]
		if !live {
			continue
		}
		out = append(out, Placement{ID: surface.ID, Rect: surfaceFrame(view.NativeView())})
	}
	return out
}

// apply creates, moves and removes the surface views, and returns the ids whose
// views are gone. The shells behind them are ended by the caller, off this
// thread.
func (s *Surfaces) apply(win *application.WebviewWindow, req SyncRequest) []string {
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
			Hidden:      !visible,
		})
		if err != nil {
			log.Printf("surface %s: %v", surface.ID, err)
			continue
		}
		surfaceAlpha(view.NativeView(), alpha)
		s.views[surface.ID] = view
		s.named[uintptr(view.NativeView())] = surface.ID
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
	return gone
}
