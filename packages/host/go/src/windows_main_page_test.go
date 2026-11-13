package host

import (
	"errors"
	"io/fs"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"
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
	native platform.Window
	shows  int
}

func (w *pagelessWindow) NativeWindow() platform.Window     { return w.native }
func (w *pagelessWindow) OnWindowEvent(WindowEvent, func()) {}
func (w *pagelessWindow) OnClosing(func() bool)             {}
func (w *pagelessWindow) Show()                             { w.shows++ }

// pagelessPlatform answers the window operations of a window without a main page. Every other operation, among them each operation
// of a main web view, panics through the nil interface.
type pagelessPlatform struct {
	platform.Platform
	calls []string
}

func (p *pagelessPlatform) WindowContentSize(platform.Window) (float64, float64, error) {
	return 1200, 800, nil
}

func (p *pagelessPlatform) SetTitlebarHeight(platform.Window, float64) error {
	p.calls = append(p.calls, "titlebar")
	return nil
}

func (p *pagelessPlatform) ObserveResponder(platform.Window, func()) (unsafe.Pointer, error) {
	p.calls = append(p.calls, "responder")
	return nil, nil
}

func (p *pagelessPlatform) ObserveCursor(platform.Window, func()) (unsafe.Pointer, error) {
	p.calls = append(p.calls, "cursor")
	return nil, nil
}

func (p *pagelessPlatform) ObserveSheet(platform.Window, func()) (unsafe.Pointer, error) {
	p.calls = append(p.calls, "sheet")
	return nil, nil
}

func (p *pagelessPlatform) PlaceNewWindow(platform.Window) error {
	p.calls = append(p.calls, "place")
	return nil
}

// contract: application.window.no-main-page-calls-no-main-web-view
func TestAWindowWithoutAMainPageCallsNoMainWebViewOperation(t *testing.T) {
	window := &pagelessWindow{native: platform.Window(1)}
	previousFramework, previousSystem := framework, system
	fake := &pagelessPlatform{}
	framework, system = pagelessFramework{window: window}, fake
	t.Cleanup(func() { framework, system = previousFramework, previousSystem })
	host := &Host{windows: map[uint]*Surfaces{}, owners: map[string]*Surfaces{}}
	host.newWindow("main", "")
	if strings.Join(fake.calls, ",") != "titlebar,responder,cursor,sheet,place" {
		t.Fatalf("the window preparation made the calls %v, want the title bar, the responder observation, the cursor observation, the sheet observation and the placement", fake.calls)
	}
	if window.shows != 1 {
		t.Fatalf("the window was shown %d times, want once", window.shows)
	}
}

// placingPlatform records whether the window was shown when the host placed it.
type placingPlatform struct {
	pagelessPlatform
	window      *pagelessWindow
	placedShown []int
}

func (p *placingPlatform) PlaceNewWindow(window platform.Window) error {
	if window != p.window.native {
		return errors.New("the placement names another window")
	}
	p.placedShown = append(p.placedShown, p.window.shows)
	return nil
}

// A framework places a new window on the display of the key window of the active application, which for an application that is
// not active is the display of another application, so the host places every new window before it shows it (window_reveal.h).
// contract: application.window.new-window-placed-before-show
func TestANewWindowIsPlacedBeforeItShows(t *testing.T) {
	window := &pagelessWindow{native: platform.Window(1)}
	previousFramework, previousSystem := framework, system
	fake := &placingPlatform{window: window}
	framework, system = pagelessFramework{window: window}, fake
	t.Cleanup(func() { framework, system = previousFramework, previousSystem })
	host := &Host{windows: map[uint]*Surfaces{}, owners: map[string]*Surfaces{}}
	host.newWindow("main", "")
	if !reflect.DeepEqual(fake.placedShown, []int{0}) || window.shows != 1 {
		t.Fatalf("the window was placed %d times with the shows %v before each placement and shown %d times, want one placement before the one show",
			len(fake.placedShown), fake.placedShown, window.shows)
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

func (p *goneWindowPlatform) WindowOnScreen(window platform.Window) (bool, error) {
	if window == 0 {
		p.read <- struct{}{}
		return false, errors.New("window on screen: the window is gone")
	}
	return true, nil
}

// A window that closes may still report a change of its state, and with no native window there is nothing to read.
// contract: application.window.gone-window-reads-no-state-on-change
func TestAWindowThatIsGoneReadsNoStateOnAChange(t *testing.T) {
	window := &eventWindow{pagelessWindow: pagelessWindow{native: platform.Window(1)}, listeners: map[WindowEvent][]func(){}}
	previousFramework, previousSystem := framework, system
	fake := &goneWindowPlatform{read: make(chan struct{}, 4)}
	framework, system = pagelessFramework{window: window}, fake
	t.Cleanup(func() { framework, system = previousFramework, previousSystem })
	host := &Host{windows: map[uint]*Surfaces{}, owners: map[string]*Surfaces{}}
	host.newWindow("main", "")
	window.native = 0
	for _, listener := range window.listeners[WindowMove] {
		listener()
	}
	// A change reads the window on screen in a step of the main thread, which ran before the listener returned.
	select {
	case <-fake.read:
		t.Fatal("a change of a window that is gone read its state and reported an error")
	default:
	}
}

// pagedEventFramework is a framework with a main page whose window holds the listeners of its window events.
type pagedEventFramework struct{ pagelessFramework }

func (pagedEventFramework) MainPage() bool { return true }

// mainWebviewPlatform records each operation that places the main web view of a window.
type mainWebviewPlatform struct {
	pagelessPlatform
	placed []string
}

func (p *mainWebviewPlatform) WindowOnScreen(platform.Window) (bool, error) { return true, nil }

func (p *mainWebviewPlatform) SetMainWebview(platform.Window) error {
	p.placed = append(p.placed, "main webview")
	return nil
}

func (p *mainWebviewPlatform) ConfigureMainWindow(platform.Window, bool) error {
	p.placed = append(p.placed, "main window")
	return nil
}

func (p *mainWebviewPlatform) PrepareWindow(platform.Window) error {
	p.placed = append(p.placed, "prepare")
	return nil
}

func (p *mainWebviewPlatform) MainWebview(platform.Window) (unsafe.Pointer, error) {
	p.placed = append(p.placed, "read main webview")
	return unsafe.Pointer(new(byte)), nil
}

func (p *mainWebviewPlatform) FileDrop(unsafe.Pointer, func(string)) error {
	p.placed = append(p.placed, "file drop")
	return nil
}

// A window that closed may still report a resize or a show, as a window that leaves full screen while a quit closes it does. Its
// main web view has left the window, so the window places nothing: a placement would fail, and its failure would end the
// process before the quit finishes.
// contract: application.window.closed-window-places-no-main-web-view
func TestAClosedWindowPlacesNoMainWebView(t *testing.T) {
	window := &eventWindow{listeners: map[WindowEvent][]func(){}}
	previousFramework, previousSystem := framework, system
	fake := &mainWebviewPlatform{}
	framework, system = pagedEventFramework{pagelessFramework{window: window}}, fake
	t.Cleanup(func() { framework, system = previousFramework, previousSystem })
	host := &Host{windows: map[uint]*Surfaces{}, owners: map[string]*Surfaces{}}
	s := host.newWindow("main", "")
	window.native = platform.Window(1)
	mainThreadStep(func() { s.closed = true })
	for _, event := range []WindowEvent{WindowResize, WindowShow} {
		for _, listener := range window.listeners[event] {
			listener()
		}
	}
	if len(fake.placed) != 0 {
		t.Fatalf("a closed window placed its main web view with %v", fake.placed)
	}
}

// rasterPlatform reports each read of the placement of an image, the first step of a raster refresh.
type rasterPlatform struct {
	pagelessPlatform
	placed chan unsafe.Pointer
}

func (p *rasterPlatform) WindowOnScreen(platform.Window) (bool, error) { return true, nil }

func (p *rasterPlatform) SurfacePlacedImage(image unsafe.Pointer) bool {
	p.placed <- image
	return false
}

// contract: application.window.scale-change-refreshes-rasters
func TestAChangeOfTheBackingScaleRefreshesTheRastersOfTheWindow(t *testing.T) {
	window := &eventWindow{pagelessWindow: pagelessWindow{native: platform.Window(1)}, listeners: map[WindowEvent][]func(){}}
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
	// A move reads the window in a step of the main thread, which ran before the listener returned, and starts no refresh of
	// the rasters.
	select {
	case <-fake.placed:
		t.Fatal("a move refreshed the rasters")
	default:
	}
	if len(window.listeners[WindowScaleChanged]) == 0 {
		t.Fatal("the window does not listen to a change of the backing scale")
	}
	for _, listener := range window.listeners[WindowScaleChanged] {
		listener()
	}
	got := <-fake.placed
	if got != handle {
		t.Fatalf("the refresh read the placement of %p, want %p", got, handle)
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
	if err := setWindowOverlays(platform.Window(1), nil); err != nil {
		t.Fatal(err)
	}
}

// A window without a main page draws the workbench in its content view, so a first responder outside every web view and surface host
// is the owner workbench, except the diagnostic input reference, a view of the host that stays a native view. A native view of a
// surface stays the owner native with its surface, and in a window with a main page a view outside the web views is a native view.
// contract: window.responder.outside-the-web-views-follows-the-main-page
func TestTheFirstResponderOutsideTheWebViewsFollowsTheMainPage(t *testing.T) {
	previous := framework
	t.Cleanup(func() { framework = previous })
	named := map[uint64]string{10: "tab-view"}
	surface := "tab-view"
	framework = pagelessFramework{}
	if content, want := windowResponder("ContentView", 0, 0, false, false, named, nil, 0), (WindowResponder{Class: "ContentView", Owner: "workbench"}); !reflect.DeepEqual(content, want) {
		t.Fatalf("content view responder %+v, want %+v", content, want)
	}
	if reference, want := windowResponder("NSTextView", 0, 0, false, true, named, nil, 0), (WindowResponder{Class: "NSTextView", Owner: "native"}); !reflect.DeepEqual(reference, want) {
		t.Fatalf("input reference responder %+v, want %+v", reference, want)
	}
	if view, want := windowResponder("NativeRegion", 0, 10, false, false, named, nil, 0), (WindowResponder{Class: "NativeRegion", Owner: "native", Surface: &surface}); !reflect.DeepEqual(view, want) {
		t.Fatalf("surface view responder %+v, want %+v", view, want)
	}
	framework = pagedFramework{}
	if view, want := windowResponder("NSWindow", 0, 0, false, false, named, nil, 0), (WindowResponder{Class: "NSWindow", Owner: "native"}); !reflect.DeepEqual(view, want) {
		t.Fatalf("responder of a window with a main page %+v, want %+v", view, want)
	}
}

// pageLayoutEndPlatform records each cancel of the layout transactions of a window and each give of its keys, and runs each
// step of the UI queue at once.
type pageLayoutEndPlatform struct {
	pagelessPlatform
	cancelled []platform.Window
	keys      []platform.Window
	queued    []func()
}

func (p *pageLayoutEndPlatform) KeysPageEnded(window platform.Window) {
	p.keys = append(p.keys, window)
}

// EnqueueUI keeps the work for the test, which runs it as the UI thread runs the work that the host queued.
func (p *pageLayoutEndPlatform) EnqueueUI(work func()) error {
	p.queued = append(p.queued, work)
	return nil
}

func (p *pageLayoutEndPlatform) CancelLayout(window platform.Window) error {
	p.cancelled = append(p.cancelled, window)
	return nil
}

// The end of the web content process of the main page ends the page that holds the layout tickets of the window, so the host cancels
// every layout transaction of the window: it queues that cancel for the UI thread in the turn in which it learns of that end
// (docs/spec/native-surfaces.md#layout-transaction).
// contract: application.window.page-end-cancels-layout
func TestTheEndOfThePageProcessCancelsTheLayoutOfItsWindow(t *testing.T) {
	window := &eventWindow{pagelessWindow: pagelessWindow{native: platform.Window(7)}, listeners: map[WindowEvent][]func(){}}
	previousFramework, previousSystem := framework, system
	fake := &pageLayoutEndPlatform{}
	framework, system = pagelessFramework{window: window}, fake
	t.Cleanup(func() { framework, system = previousFramework, previousSystem })
	host := &Host{windows: map[uint]*Surfaces{}, owners: map[string]*Surfaces{}, quit: &Quit{}, relay: NewRelay[relayTarget]()}
	host.newWindow("main", "")
	for _, listener := range window.listeners[WindowWorkbenchEnded] {
		listener()
	}
	if len(fake.cancelled) != 0 || len(fake.queued) != 1 {
		t.Fatalf("the end of the page process cancelled the layouts of %v in its turn and queued %d works, want none cancelled and one queued",
			fake.cancelled, len(fake.queued))
	}
	fake.queued[0]()
	if len(fake.cancelled) != 1 || fake.cancelled[0] != platform.Window(7) {
		t.Fatalf("the end of the page process cancelled the layouts of %v, want window 7 once", fake.cancelled)
	}
}

// steppingFramework is a framework without a main page that tells whether a main-thread step runs.
type steppingFramework struct {
	pagelessFramework
	inStep *bool
}

func (f steppingFramework) Step(task func()) {
	*f.inStep = true
	defer func() { *f.inStep = false }()
	task()
}

// contentSizePlatform records, for each read of the content size of a window, whether it ran in a main-thread step.
type contentSizePlatform struct {
	pagelessPlatform
	inStep *bool
	reads  []bool
}

func (p *contentSizePlatform) WindowContentSize(platform.Window) (float64, float64, error) {
	p.reads = append(p.reads, *p.inStep)
	return 0, 0, errors.New("window content size: the window is gone")
}

// A framework calls the listener of a window event outside the main thread, and the window state can be read only in a
// main-thread step: a read of the content size outside it ends the process, as the start of the Wails host did. The resize
// reads the content size that it records in the main-thread step of its change.
// contract: windows.events.resize-size-read-in-main-thread-step
func TestAResizeReadsTheContentSizeInAMainThreadStep(t *testing.T) {
	window := &eventWindow{pagelessWindow: pagelessWindow{native: platform.Window(1)}, listeners: map[WindowEvent][]func(){}}
	inStep := false
	previousFramework, previousSystem := framework, system
	fake := &contentSizePlatform{inStep: &inStep}
	framework, system = steppingFramework{pagelessFramework: pagelessFramework{window: window}, inStep: &inStep}, fake
	t.Cleanup(func() { framework, system = previousFramework, previousSystem })
	host := &Host{windows: map[uint]*Surfaces{}, owners: map[string]*Surfaces{}}
	host.newWindow("main", "")
	// A window that closed reads no on-screen state in the step, so the step holds only the read of the content size.
	window.native = 0
	for _, listener := range window.listeners[WindowResize] {
		listener()
	}
	if !reflect.DeepEqual(fake.reads, []bool{true}) {
		t.Fatalf("the resize read the content size %d times, in a main-thread step %v, want once in a step", len(fake.reads), fake.reads)
	}
}
