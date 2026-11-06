package host

import (
	"errors"
	"io/fs"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"
	"time"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// pagelessFramework is a framework whose windows have no main page.
type pagelessFramework struct {
	frameworkRecord
	window Frontend
}

func (pagelessFramework) MainPage() bool                     { return false }
func (pagelessFramework) Step(task func())                   { task() }
func (f pagelessFramework) NewWindow(WindowOptions) Frontend { return f.window }

// pagelessWindow is a window of pagelessFramework that records its show.
type pagelessWindow struct {
	frontendRecord
	native unsafe.Pointer
	shows  int
}

func (w *pagelessWindow) NativeWindow() unsafe.Pointer      { return w.native }
func (w *pagelessWindow) OnWindowEvent(WindowEvent, func()) {}
func (w *pagelessWindow) OnClosing(func() bool)             {}
func (w *pagelessWindow) Show()                             { w.shows++ }

// pagelessPlatform answers the window operations of a window without a main page. Every other operation, among them each operation
// of a main web view, panics through the nil interface.
type pagelessPlatform struct {
	platform.Platform
	calls []string
}

func (p *pagelessPlatform) SetTitlebarHeight(unsafe.Pointer, float64) error {
	p.calls = append(p.calls, "titlebar")
	return nil
}

func (p *pagelessPlatform) ObserveResponder(unsafe.Pointer, func()) (unsafe.Pointer, error) {
	p.calls = append(p.calls, "responder")
	return nil, nil
}

// contract: application.window.no-main-page-calls-no-main-web-view
func TestAWindowWithoutAMainPageCallsNoMainWebViewOperation(t *testing.T) {
	window := &pagelessWindow{native: unsafe.Pointer(new(byte))}
	previousFramework, previousSystem := framework, system
	fake := &pagelessPlatform{}
	framework, system = pagelessFramework{window: window}, fake
	t.Cleanup(func() { framework, system = previousFramework, previousSystem })
	host := &Host{windows: map[uint]*Surfaces{}, owners: map[string]*Surfaces{}}
	host.newWindow("main", "")
	if strings.Join(fake.calls, ",") != "titlebar,responder" {
		t.Fatalf("the window preparation made the calls %v, want the title bar and the responder observation", fake.calls)
	}
	if window.shows != 1 {
		t.Fatalf("the window was shown %d times, want once", window.shows)
	}
}

// eventWindow is a pageless window that holds the listeners of its window events.
type eventWindow struct {
	pagelessWindow
	listeners map[WindowEvent][]func()
}

func (w *eventWindow) OnWindowEvent(event WindowEvent, listener func()) {
	w.listeners[event] = append(w.listeners[event], listener)
}

// goneWindowPlatform reports a read of the state of a window that has no native window, which the real platform refuses.
type goneWindowPlatform struct {
	pagelessPlatform
	read chan struct{}
}

func (p *goneWindowPlatform) WindowOnScreen(window unsafe.Pointer) (bool, error) {
	if window == nil {
		p.read <- struct{}{}
		return false, errors.New("window on screen: the window is gone")
	}
	return true, nil
}

// A window that closes may still report a change of its state, and with no native window there is nothing to read.
// contract: application.window.gone-window-reads-no-state-on-change
func TestAWindowThatIsGoneReadsNoStateOnAChange(t *testing.T) {
	window := &eventWindow{pagelessWindow: pagelessWindow{native: unsafe.Pointer(new(byte))}, listeners: map[WindowEvent][]func(){}}
	previousFramework, previousSystem := framework, system
	fake := &goneWindowPlatform{read: make(chan struct{}, 4)}
	framework, system = pagelessFramework{window: window}, fake
	t.Cleanup(func() { framework, system = previousFramework, previousSystem })
	host := &Host{windows: map[uint]*Surfaces{}, owners: map[string]*Surfaces{}}
	host.newWindow("main", "")
	window.native = nil
	for _, listener := range window.listeners[WindowMove] {
		listener()
	}
	select {
	case <-fake.read:
		t.Fatal("a change of a window that is gone read its state and reported an error")
	case <-time.After(100 * time.Millisecond):
	}
}

// rasterPlatform reports each read of the placement of an image, the first step of a raster refresh.
type rasterPlatform struct {
	pagelessPlatform
	placed chan unsafe.Pointer
}

func (p *rasterPlatform) WindowOnScreen(unsafe.Pointer) (bool, error) { return true, nil }

func (p *rasterPlatform) SurfacePlacedImage(image unsafe.Pointer) bool {
	p.placed <- image
	return false
}

// contract: application.window.scale-change-refreshes-rasters
func TestAChangeOfTheBackingScaleRefreshesTheRastersOfTheWindow(t *testing.T) {
	window := &eventWindow{pagelessWindow: pagelessWindow{native: unsafe.Pointer(new(byte))}, listeners: map[WindowEvent][]func(){}}
	previousFramework, previousSystem := framework, system
	fake := &rasterPlatform{placed: make(chan unsafe.Pointer, 4)}
	framework, system = pagelessFramework{window: window}, fake
	t.Cleanup(func() { framework, system = previousFramework, previousSystem })
	host := &Host{windows: map[uint]*Surfaces{}, owners: map[string]*Surfaces{}}
	s := host.newWindow("main", "")
	key := ImageKey{Surface: "tab", Name: "picture"}
	handle := unsafe.Pointer(new(byte))
	if err := s.images.Reserve(key, &ImageOwner{}); err != nil {
		t.Fatal(err)
	}
	if !s.images.Set(key, handle) {
		t.Fatal("the image is not stored")
	}
	if err := s.images.SetVisible(key, true); err != nil {
		t.Fatal(err)
	}
	s.images.SetSurfaceVisible(key.Surface, true)
	// The drawing state of the image is already sent, so the listeners of the window have no message for its supplier.
	s.images.DrawingChanges()
	for _, listener := range window.listeners[WindowMove] {
		listener()
	}
	select {
	case <-fake.placed:
		t.Fatal("a move refreshed the rasters")
	case <-time.After(100 * time.Millisecond):
	}
	if len(window.listeners[WindowScaleChanged]) == 0 {
		t.Fatal("the window does not listen to a change of the backing scale")
	}
	for _, listener := range window.listeners[WindowScaleChanged] {
		listener()
	}
	select {
	case got := <-fake.placed:
		if got != handle {
			t.Fatalf("the refresh read the placement of %p, want %p", got, handle)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a change of the backing scale did not refresh the rasters")
	}
}

// contract: application.window.no-main-page-stages-no-page-script
func TestOnlyAFrameworkWithAMainPageReadsTheBackgroundScript(t *testing.T) {
	previousFramework, previousScript := framework, backgroundScript
	t.Cleanup(func() { framework, backgroundScript = previousFramework, previousScript })
	empty := fstest.MapFS{}
	framework = pagelessFramework{}
	if err := readBackgroundScript(empty); err != nil {
		t.Fatalf("a staging without a main page has no background script, and its read failed: %v", err)
	}
	framework = pagedFramework{}
	if err := readBackgroundScript(empty); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("a framework with a main page read a staging without its background script: %v", err)
	}
	if err := readBackgroundScript(fstest.MapFS{"background.js": {Data: []byte("script")}}); err != nil || backgroundScript != "script" {
		t.Fatalf("the background script is %q, %v", backgroundScript, err)
	}
}

// pagedFramework is a framework whose windows show a main page.
type pagedFramework struct{ frameworkRecord }

func (pagedFramework) MainPage() bool { return true }

// contract: application.window.no-main-page-calls-no-main-web-view
func TestAWindowWithoutAMainPageSetsNoWindowOverlays(t *testing.T) {
	previousFramework, previousSystem := framework, system
	framework, system = pagelessFramework{}, &pagelessPlatform{}
	t.Cleanup(func() { framework, system = previousFramework, previousSystem })
	if err := setWindowOverlays(unsafe.Pointer(new(byte)), nil); err != nil {
		t.Fatal(err)
	}
}

// A window without a main page draws the workbench in its content view, so a first responder outside every web view and surface host
// is the owner workbench. A native view of a surface stays the owner native with its surface, and in a window with a main page a view
// outside the web views is a native view.
// contract: window.responder.outside-the-web-views-follows-the-main-page
func TestTheFirstResponderOutsideTheWebViewsFollowsTheMainPage(t *testing.T) {
	previous := framework
	t.Cleanup(func() { framework = previous })
	named := map[uint64]string{10: "tab-view"}
	surface := "tab-view"
	framework = pagelessFramework{}
	if content, want := windowResponder("ContentView", 0, 0, false, named, nil, 0), (WindowResponder{Class: "ContentView", Owner: "workbench"}); !reflect.DeepEqual(content, want) {
		t.Fatalf("content view responder %+v, want %+v", content, want)
	}
	if view, want := windowResponder("NativeRegion", 0, 10, false, named, nil, 0), (WindowResponder{Class: "NativeRegion", Owner: "native", Surface: &surface}); !reflect.DeepEqual(view, want) {
		t.Fatalf("surface view responder %+v, want %+v", view, want)
	}
	framework = pagedFramework{}
	if view, want := windowResponder("NSWindow", 0, 0, false, named, nil, 0), (WindowResponder{Class: "NSWindow", Owner: "native"}); !reflect.DeepEqual(view, want) {
		t.Fatalf("responder of a window with a main page %+v, want %+v", view, want)
	}
}
