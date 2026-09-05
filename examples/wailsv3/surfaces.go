// Native surfaces and native modals for the soksak example.
//
// The example declares, on every commit, the frame each surface should occupy,
// and hands over any [data-native-modal] element it opens. Each of those becomes
// a webview inside the main window, placed on the frame the page asked for.
//
// Wails has no API for adding a webview to a window, but it hands over the
// window itself, and a webview is a native view like any other. See
// native_darwin.go.
//
// A view added that way is outside the app's asset server, which answers a
// scheme only its own webview knows. The local pages a surface or a modal needs
// are therefore served over http on the loopback address; see serve.go.
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
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	URL     string `json:"url"`
	Visible bool   `json:"visible"`
	// Whether the page asked for this surface to stand back, having lost focus.
	Dim bool `json:"dim"`
	// Which of two overlapping surfaces is on top.
	Layer int `json:"layer"`
	// The colour the view starts on, so a resize never uncovers white.
	Background [3]float64 `json:"background"`
	Rect
}

type SyncRequest struct {
	Viewport Viewport  `json:"viewport"`
	Theme    Theme     `json:"theme"`
	Surfaces []Surface `json:"surfaces"`
}

// Viewport is the page's own size, used to work out how far the page sits
// inside the window's content view: on macOS that is the height of the title bar.
type Viewport struct {
	W float64 `json:"w"`
	H float64 `json:"h"`
}

// The page's theme, carried to the pages this host serves.
type Theme struct {
	Scheme string            `json:"scheme"`
	Tokens map[string]string `json:"tokens"`
}

// What a [data-native-modal] element needs in order to be drawn elsewhere.
type OverlayRequest struct {
	ID         string     `json:"id"`
	Viewport   Viewport   `json:"viewport"`
	Rect       Rect       `json:"rect"`
	ClassName  string     `json:"className"`
	HTML       string     `json:"html"`
	CSS        string     `json:"css"`
	Border     string     `json:"border"`
	Radius     float64    `json:"radius"`
	Background [3]float64 `json:"background"`
}

// What the modal's own view asks for once it has loaded.
type OverlayContent struct {
	CSS       string `json:"css"`
	ClassName string `json:"className"`
	HTML      string `json:"html"`
	Border    string `json:"border"`
}

type modal struct {
	view    *nativeView
	content OverlayContent
	radius  float64
}

// Where one surface was last put, and whether a press could land on it.
//
// Kept in the order the page declared them: a press is answered topmost first,
// and with every layer equal the later declaration is the one on top.
type placement struct {
	id      string
	frame   Rect
	layer   int
	visible bool
	alpha   float64
}

type Surfaces struct {
	mu sync.Mutex
	// A surface is a native view, so a press on it never reaches the page. This
	// is what lets a press be named.
	views  map[string]*nativeView
	placed []placement
	modals map[string]*modal
	shells *Shells
	pages  *Pages
	watch  sync.Once
}

func NewSurfaces(shells *Shells, pages *Pages) *Surfaces {
	return &Surfaces{
		views:  map[string]*nativeView{},
		modals: map[string]*modal{},
		shells: shells,
		pages:  pages,
	}
}

// OverlayShow places a modal's view and hands it its content.
//
// The view is created here, after the surface views, which is what puts it above
// them. It is not revealed until it reports the size it needs.
func (s *Surfaces) OverlayShow(req OverlayRequest) error {
	win, ok := mainWindow()
	if !ok {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	live := s.modals[req.ID]
	if live == nil {
		live = &modal{}
		s.modals[req.ID] = live
	}
	live.content = OverlayContent{
		CSS: req.CSS, ClassName: req.ClassName, HTML: req.HTML, Border: req.Border,
	}
	live.radius = req.Radius

	application.InvokeSync(func() {
		insetX, insetY := inset(win, req.Viewport)
		x, y := req.Rect.X+insetX, req.Rect.Y+insetY
		if live.view != nil {
			live.view.destroy()
		}
		url := s.pages.URL("overlay.html?id=" + req.ID)
		live.view = newNativeView(win.NativeWindow(), url, x, y,
			max1(req.Rect.W), max1(req.Rect.H), srgb(req.Background))
		if live.view != nil {
			live.view.setHidden(true)
		}
	})
	return nil
}

func (s *Surfaces) OverlayHide(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	live, ok := s.modals[id]
	if !ok || live.view == nil {
		return nil
	}
	view := live.view
	live.view = nil
	application.InvokeSync(view.destroy)
	return nil
}

// ModalContent is what the modal's own view asks for once it has loaded.
func (s *Surfaces) ModalContent(id string) OverlayContent {
	s.mu.Lock()
	defer s.mu.Unlock()
	if live, ok := s.modals[id]; ok {
		return live.content
	}
	return OverlayContent{}
}

// ModalFit gives the view the size its page found it needs, clips its corners
// and reveals it. Revealing any earlier would show a view of the wrong shape.
func (s *Surfaces) ModalFit(id string, w, h float64) {
	s.mu.Lock()
	live, ok := s.modals[id]
	if !ok || live.view == nil {
		s.mu.Unlock()
		return
	}
	view, radius := live.view, live.radius
	s.mu.Unlock()

	application.InvokeSync(func() {
		view.resize(max1(w), max1(h))
		view.setCornerRadius(radius)
		view.raise()
		view.setHidden(false)
	})
}

// surfaceAt names the surface a point lands on, or "" for a point on none.
//
// Invisible or transparent is not there to be pressed: a surface parked behind
// the one a person is looking at still holds its rectangle, which is what keeps
// its layout. Where two of them cover the point the topmost answers — by layer,
// and with those equal by the order the page declared them.
func surfaceAt(placed []placement, x, y float64) string {
	found := ""
	layer := 0
	for _, p := range placed {
		if !p.visible || p.alpha <= 0 {
			continue
		}
		if x < p.frame.X || y < p.frame.Y || x >= p.frame.X+p.frame.W || y >= p.frame.Y+p.frame.H {
			continue
		}
		if found == "" || p.layer >= layer {
			found = p.id
			layer = p.layer
		}
	}
	return found
}

// press tells the page which surface a press landed on. The page decides what
// that means; here it is only named.
func (s *Surfaces) press(x, y float64) {
	s.mu.Lock()
	hit := surfaceAt(s.placed, x, y)
	s.mu.Unlock()
	if hit == "" {
		return
	}
	application.Get().Event.Emit("surface-pressed", hit)
}

// How solid a surface is drawn. Dimming is the page's decision; this is only
// the number it comes out as.
func alphaFor(dim bool) float64 {
	if dim {
		return 0.45
	}
	return 1
}

// srgb turns the page's 0-255 channels into the 0-1 AppKit wants.
func srgb(c [3]float64) [3]float64 {
	return [3]float64{c[0] / 255, c[1] / 255, c[2] / 255}
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

// inset reports how far the page sits inside the area views are placed in.
func inset(win *application.WebviewWindow, viewport Viewport) (float64, float64) {
	cw, ch := contentSize(win.NativeWindow())
	if cw <= 0 || ch <= 0 {
		return 0, 0
	}
	x := (cw - viewport.W) / 2
	if x < 0 {
		x = 0
	}
	y := ch - viewport.H - x
	if y < 0 {
		y = 0
	}
	return x, y
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
	s.pages.SetTheme(req.Theme)

	s.mu.Lock()
	defer s.mu.Unlock()

	application.InvokeSync(func() {
		insetX, insetY := inset(win, req.Viewport)
		s.apply(win, req, insetX, insetY)
		s.watch.Do(func() {
			pressed = s.press
			watchMouse(win.NativeWindow())
		})
	})
	return nil
}

func (s *Surfaces) apply(win *application.WebviewWindow, req SyncRequest, insetX, insetY float64) {

	wanted := map[string]bool{}
	s.placed = s.placed[:0]
	for _, surface := range req.Surfaces {
		wanted[surface.ID] = true
		x, y := surface.X+insetX, surface.Y+insetY
		w, h := surface.W, surface.H
		if w < 1 {
			w = 1
		}
		if h < 1 {
			h = 1
		}

		alpha := alphaFor(surface.Dim)
		s.placed = append(s.placed, placement{
			id: surface.ID, frame: Rect{X: x, Y: y, W: w, H: h},
			layer: surface.Layer, visible: surface.Visible, alpha: alpha,
		})
		if view, live := s.views[surface.ID]; live {
			view.setFrame(x, y, w, h)
			view.setHidden(!surface.Visible)
			view.setAlpha(alpha)
			continue
		}
		url := surface.URL
		if surface.Kind != "browser" {
			url = s.pages.URL(surface.URL)
		}
		view := newNativeView(win.NativeWindow(), url, x, y, w, h, srgb(surface.Background))
		if view == nil {
			log.Printf("surface %s: no native view on this platform", surface.ID)
			continue
		}
		view.setAlpha(alpha)
		s.views[surface.ID] = view
	}

	// The page is the only writer of this list, so a surface missing from it is
	// a surface that is gone.
	for id, view := range s.views {
		if wanted[id] {
			continue
		}
		view.destroy()
		delete(s.views, id)
		s.shells.Close(id)
	}
}
