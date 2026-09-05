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
	ID   string `json:"id"`
	Kind string `json:"kind"`
	URL  string `json:"url"`
	// Whether URL points outside this host. An address of this host's own is
	// served by the loopback server; naming the kind here would mean editing
	// this file for every plugin the page adds.
	External bool `json:"external"`
	Visible  bool `json:"visible"`
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
	Surfaces []Surface `json:"surfaces"`
}

// Viewport is the page's own height. The page's view starts at the window
// content view's origin, so the height is all that is needed to turn a rect
// measured from the page's top left into the frame AppKit wants.
type Viewport struct {
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
	// Guards modals, which the pages this host serves read over HTTP. Views are
	// touched on the main thread only and need no lock.
	mu    sync.Mutex
	views map[string]*nativeView
	// A surface is a native view, so a press on it never reaches the page. This
	// is what names the surface a pressed view draws.
	named  map[uintptr]string
	modals map[string]*modal
	shells *Shells
	pages  *Pages
	watch  sync.Once
}

func NewSurfaces(shells *Shells, pages *Pages) *Surfaces {
	return &Surfaces{
		views:  map[string]*nativeView{},
		named:  map[uintptr]string{},
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
	application.InvokeSync(func() {
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

		x, y := req.Rect.X, up(req.Viewport, req.Rect.Y, max1(req.Rect.H))
		if live.view != nil {
			live.view.destroy()
		}
		url := s.pages.URL("overlay.html?id=" + req.ID + "&framework=wailsv3")
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
	live, ok := s.modals[id]
	if !ok || live.view == nil {
		s.mu.Unlock()
		return nil
	}
	view := live.view
	live.view = nil
	s.mu.Unlock()

	application.InvokeSync(view.destroy)
	return nil
}

// OverlayUpdate replaces what an open modal draws, without rebuilding its view.
// A modal whose controls change what the page holds is redrawn while it stands.
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
// up turns a top-left y into the bottom-left one AppKit measures.
func up(viewport Viewport, y, h float64) float64 { return viewport.H - y - h }

// press reports whether the view is one of the surfaces, and names it to the
// page when it is. The page decides what a press means; here it is only named.
func (s *Surfaces) press(view uintptr) bool {
	id, ok := s.named[view]
	if !ok {
		return false
	}
	application.Get().Event.Emit("surface-pressed", id)
	return true
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

// Report writes one line from the page's own checks into this app's log. The
// page has no file to write to and its console is not read when the app runs
// outside a debugger.
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
		view := newNativeView(win.NativeWindow(), url, x, y, w, h, srgb(surface.Background))
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
