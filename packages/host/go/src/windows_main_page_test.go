package host

import (
	"errors"
	"io/fs"
	"reflect"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	support "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
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

// windowSetup is the platform of the operating system that records the calls of the preparation of a window in their order. Each call
// goes on to the platform of the operating system.
type windowSetup struct {
	platform.Platform
	calls []string
}

func (p *windowSetup) SetTitlebarHeight(window platform.Window, height float64) error {
	p.calls = append(p.calls, "titlebar")
	return p.Platform.SetTitlebarHeight(window, height)
}

func (p *windowSetup) ObserveResponder(window platform.Window, changed func()) (unsafe.Pointer, error) {
	p.calls = append(p.calls, "responder")
	return p.Platform.ObserveResponder(window, changed)
}

func (p *windowSetup) ObserveCursor(window platform.Window, changed func()) (unsafe.Pointer, error) {
	p.calls = append(p.calls, "cursor")
	return p.Platform.ObserveCursor(window, changed)
}

func (p *windowSetup) ObserveSheet(window platform.Window, changed func()) (unsafe.Pointer, error) {
	p.calls = append(p.calls, "sheet")
	return p.Platform.ObserveSheet(window, changed)
}

func (p *windowSetup) PlaceNewWindow(window platform.Window) error {
	p.calls = append(p.calls, "place")
	return p.Platform.PlaceNewWindow(window)
}

// nativePagelessFramework is a framework without a main page whose steps run on the main thread of the native library. It is defined
// with the window of a test that has no main web view.
type nativePagelessFramework struct{ pagelessFramework }

func (nativePagelessFramework) Step(task func()) { stepOnMainThread(task) }

// endObservations ends the observations of the window of s that the host started, when the test did not close the window.
func endObservations(s *Surfaces) {
	runOnMainThread(func() {
		if s.responderObservation != nil {
			system.EndResponderObservation(s.responderObservation)
			s.responderObservation = nil
		}
		if s.cursorObservation != nil {
			system.EndCursorObservation(s.cursorObservation)
			s.cursorObservation = nil
		}
		if s.sheetObservation != nil {
			system.EndSheetObservation(s.sheetObservation)
			s.sheetObservation = nil
		}
	})
}

// realPagelessWindow is the window of a test of the platform of the operating system: a window with the title bar of a framework window
// and no main web view, whose host is the host of the framework f and whose platform records through use. The observations of the window
// end with the test.
func realPagelessHost(t *testing.T, window Frontend, use func(platform.Platform) platform.Platform, paged bool) (*Host, *Surfaces) {
	t.Helper()
	current, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	previousFramework, previousSystem := framework, system
	system = use(current)
	if paged {
		framework = pagedEventFramework{nativePagelessFramework{pagelessFramework{window: window}}}
	} else {
		framework = nativePagelessFramework{pagelessFramework{window: window}}
	}
	t.Cleanup(func() { framework, system = previousFramework, previousSystem })
	host := &Host{windows: map[uint]*Surfaces{}, owners: map[string]*Surfaces{}, sidecars: &Sidecars{}, quit: &Quit{}, relay: NewRelay[relayTarget]()}
	s := host.newWindow("main", "")
	t.Cleanup(func() { endObservations(s) })
	return host, s
}

// contract: application.window.no-main-page-calls-no-main-web-view
func TestAWindowWithoutAMainPageCallsNoMainWebViewOperation(t *testing.T) {
	native := support.TitledWindow(t, runOnMainThread, 1200, 800)
	window := &pagelessWindow{native: native}
	var calls *windowSetup
	// A main web view operation on a window without a main web view fails in the platform, and the failure ends the process.
	_, s := realPagelessHost(t, window, func(current platform.Platform) platform.Platform {
		calls = &windowSetup{Platform: current}
		return calls
	}, false)
	if strings.Join(calls.calls, ",") != "titlebar,responder,cursor,sheet,place" {
		t.Fatalf("the window preparation made the calls %v, want the title bar, the responder observation, the cursor observation, the sheet observation and the placement", calls.calls)
	}
	if window.shows != 1 {
		t.Fatalf("the window was shown %d times, want once", window.shows)
	}
	var row float64
	var err error
	runOnMainThread(func() { row, err = system.TitlebarHeight(native) })
	if err != nil || row != initialTitlebarHeight {
		t.Fatalf("the title bar of the prepared window is %v, %v, want %d", row, err, initialTitlebarHeight)
	}
	if s.responderObservation == nil || s.cursorObservation == nil || s.sheetObservation == nil {
		t.Fatal("the window preparation started no observation of the responder, the cursor or the sheet")
	}
}

// placingCalls records whether the window was shown when the host placed it. The placement goes on to the platform of the operating system.
type placingCalls struct {
	platform.Platform
	window      *pagelessWindow
	placedShown []int
}

func (p *placingCalls) PlaceNewWindow(window platform.Window) error {
	if window != p.window.native {
		return errors.New("the placement names another window")
	}
	p.placedShown = append(p.placedShown, p.window.shows)
	return p.Platform.PlaceNewWindow(window)
}

// A framework places a new window on the display of the key window of the active application, which for an application that is
// not active is the display of another application, so the host places every new window before it shows it (window_reveal.h).
// contract: application.window.new-window-placed-before-show
func TestANewWindowIsPlacedBeforeItShows(t *testing.T) {
	window := &pagelessWindow{native: support.TitledWindow(t, runOnMainThread, 1200, 800)}
	var calls *placingCalls
	realPagelessHost(t, window, func(current platform.Platform) platform.Platform {
		calls = &placingCalls{Platform: current, window: window}
		return calls
	}, false)
	if !reflect.DeepEqual(calls.placedShown, []int{0}) || window.shows != 1 {
		t.Fatalf("the window was placed %d times with the shows %v before each placement and shown %d times, want one placement before the one show",
			len(calls.placedShown), calls.placedShown, window.shows)
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

// goneWindowReads reports each read of the on-screen state of a window that has no native window, which the platform refuses.
type goneWindowReads struct {
	platform.Platform
	read chan struct{}
}

func (p *goneWindowReads) WindowOnScreen(window platform.Window) (bool, error) {
	if window == 0 {
		p.read <- struct{}{}
	}
	return p.Platform.WindowOnScreen(window)
}

// A window that closes may still report a change of its state, and with no native window there is nothing to read.
// contract: application.window.gone-window-reads-no-state-on-change
func TestAWindowThatIsGoneReadsNoStateOnAChange(t *testing.T) {
	window := &eventWindow{pagelessWindow: pagelessWindow{native: support.TitledWindow(t, runOnMainThread, 1200, 800)}, listeners: map[WindowEvent][]func(){}}
	calls := &goneWindowReads{read: make(chan struct{}, 4)}
	realPagelessHost(t, window, func(current platform.Platform) platform.Platform {
		calls.Platform = current
		return calls
	}, false)
	window.native = 0
	for _, listener := range window.listeners[WindowMove] {
		listener()
	}
	// A change reads the window on screen in a step of the main thread, which ran before the listener returned.
	select {
	case <-calls.read:
		t.Fatal("a change of a window that is gone read its state and reported an error")
	default:
	}
}

// pagedEventFramework is a framework with a main page whose window holds the listeners of its window events.
type pagedEventFramework struct{ nativePagelessFramework }

func (pagedEventFramework) MainPage() bool { return true }

// mainWebviewCalls records each operation that places the main web view of a window. Each call goes on to the platform of the
// operating system, so a placement of a window without a main web view fails in it and ends the process.
type mainWebviewCalls struct {
	platform.Platform
	placed []string
}

func (p *mainWebviewCalls) SetMainWebview(window platform.Window) error {
	p.placed = append(p.placed, "main webview")
	return p.Platform.SetMainWebview(window)
}

func (p *mainWebviewCalls) ConfigureMainWindow(window platform.Window, dark bool) error {
	p.placed = append(p.placed, "main window")
	return p.Platform.ConfigureMainWindow(window, dark)
}

func (p *mainWebviewCalls) PrepareWindow(window platform.Window) error {
	p.placed = append(p.placed, "prepare")
	return p.Platform.PrepareWindow(window)
}

func (p *mainWebviewCalls) MainWebview(window platform.Window) (unsafe.Pointer, error) {
	p.placed = append(p.placed, "read main webview")
	return p.Platform.MainWebview(window)
}

func (p *mainWebviewCalls) FileDrop(view unsafe.Pointer, dropped func(string)) error {
	p.placed = append(p.placed, "file drop")
	return p.Platform.FileDrop(view, dropped)
}

// A window that closed may still report a resize or a show, as a window that leaves full screen while a quit closes it does. Its
// main web view has left the window, so the window places nothing: a placement would fail, and its failure would end the
// process before the quit finishes.
// contract: application.window.closed-window-places-no-main-web-view
func TestAClosedWindowPlacesNoMainWebView(t *testing.T) {
	window := &eventWindow{listeners: map[WindowEvent][]func(){}}
	calls := &mainWebviewCalls{}
	_, s := realPagelessHost(t, window, func(current platform.Platform) platform.Platform {
		calls.Platform = current
		return calls
	}, true)
	window.native = support.TitledWindow(t, runOnMainThread, 1200, 800)
	mainThreadStep(func() { s.closed = true })
	for _, event := range []WindowEvent{WindowResize, WindowShow} {
		for _, listener := range window.listeners[event] {
			listener()
		}
	}
	if len(calls.placed) != 0 {
		t.Fatalf("a closed window placed its main web view with %v", calls.placed)
	}
}

// rasterReads reports each read of the placement of an image, the first step of a raster refresh. The read goes on to the platform of the
// operating system.
type rasterReads struct {
	platform.Platform
	placed chan unsafe.Pointer
}

func (p *rasterReads) SurfacePlacedImage(image unsafe.Pointer) bool {
	p.placed <- image
	return p.Platform.SurfacePlacedImage(image)
}

// contract: application.window.scale-change-refreshes-rasters
func TestAChangeOfTheBackingScaleRefreshesTheRastersOfTheWindow(t *testing.T) {
	current, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	native := support.TitledWindowWithMainPage(t, runOnMainThread, 400, 300, "main-page.html")
	window := &eventWindow{pagelessWindow: pagelessWindow{native: native}, listeners: map[WindowEvent][]func(){}}
	calls := &rasterReads{placed: make(chan unsafe.Pointer, 4)}
	_, s := realPagelessHost(t, window, func(current platform.Platform) platform.Platform {
		calls.Platform = current
		return calls
	}, false)
	var surface, handle unsafe.Pointer
	runOnMainThread(func() {
		surface, err = current.CreateSurface(native)
		if err == nil {
			handle, err = current.CreateImage(surface, "picture", func(string) {}, nil)
		}
	})
	if err != nil {
		t.Fatalf("create the image region: %v", err)
	}
	t.Cleanup(func() {
		runOnMainThread(func() {
			current.CloseImage(handle)
			current.CloseSurface(surface)
		})
	})
	key := ImageKey{Surface: "tab", Name: "picture"}
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
	// The window state is read before the drawing state is taken as sent, so a listener of the window finds no change of the drawing state and
	// sends no message to the supplier of the image, which this region (reserved without a supplier) has none.
	var read error
	runOnMainThread(func() { read = s.readOnScreen() })
	if read != nil {
		t.Fatalf("read the window state: %v", read)
	}
	s.images.DrawingChanges()
	for _, listener := range window.listeners[WindowMove] {
		listener()
	}
	// A move reads the window in a step of the main thread, which ran before the listener returned, and starts no refresh of
	// the rasters.
	select {
	case <-calls.placed:
		t.Fatal("a move refreshed the rasters")
	default:
	}
	if len(window.listeners[WindowScaleChanged]) == 0 {
		t.Fatal("the window does not listen to a change of the backing scale")
	}
	for _, listener := range window.listeners[WindowScaleChanged] {
		listener()
	}
	got := <-calls.placed
	if got != handle {
		t.Fatalf("the refresh read the placement of %p, want %p", got, handle)
	}
}

// contract: application.window.no-main-page-stages-no-page-script
func TestOnlyAFrameworkWithAMainPageReadsTheBackgroundScript(t *testing.T) {
	previousScript := backgroundScript
	t.Cleanup(func() { backgroundScript = previousScript })
	empty := fstest.MapFS{}
	if err := readBackgroundScript(empty, false); err != nil {
		t.Fatalf("a staging without a main page has no background script, and its read failed: %v", err)
	}
	if err := readBackgroundScript(empty, true); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("a framework with a main page read a staging without its background script: %v", err)
	}
	if err := readBackgroundScript(fstest.MapFS{"background.js": {Data: []byte("script")}}, true); err != nil || backgroundScript != "script" {
		t.Fatalf("the background script is %q, %v", backgroundScript, err)
	}
}

// contract: application.window.no-main-page-calls-no-main-web-view
func TestAWindowWithoutAMainPageSetsNoWindowOverlays(t *testing.T) {
	if err := setWindowOverlays(false, platform.Window(1), nil); err != nil {
		t.Fatal(err)
	}
}

// A window without a main page draws the workbench in its content view, so a first responder outside every web view and surface host
// is the owner workbench, except the diagnostic input reference, a view of the host that stays a native view. A native view of a
// surface stays the owner native with its surface, and in a window with a main page a view outside the web views is a native view.
// contract: window.responder.outside-the-web-views-follows-the-main-page
func TestTheFirstResponderOutsideTheWebViewsFollowsTheMainPage(t *testing.T) {
	named := map[uint64]string{10: "tab-view"}
	surface := "tab-view"
	if content, want := windowResponder("ContentView", 0, 0, false, false, false, named, nil, 0), (WindowResponder{Class: "ContentView", Owner: "workbench"}); !reflect.DeepEqual(content, want) {
		t.Fatalf("content view responder %+v, want %+v", content, want)
	}
	if reference, want := windowResponder("NSTextView", 0, 0, false, true, false, named, nil, 0), (WindowResponder{Class: "NSTextView", Owner: "native"}); !reflect.DeepEqual(reference, want) {
		t.Fatalf("input reference responder %+v, want %+v", reference, want)
	}
	if view, want := windowResponder("NativeRegion", 0, 10, false, false, false, named, nil, 0), (WindowResponder{Class: "NativeRegion", Owner: "native", Surface: &surface}); !reflect.DeepEqual(view, want) {
		t.Fatalf("surface view responder %+v, want %+v", view, want)
	}
	if view, want := windowResponder("NSWindow", 0, 0, false, false, true, named, nil, 0), (WindowResponder{Class: "NSWindow", Owner: "native"}); !reflect.DeepEqual(view, want) {
		t.Fatalf("responder of a window with a main page %+v, want %+v", view, want)
	}
}

// layoutEndCalls records each cancel of the layout transactions of a window and each work that the host queued for the UI thread. Each
// call goes on to the platform of the operating system, and the cancel reports to cancelled.
type layoutEndCalls struct {
	platform.Platform
	mu        sync.Mutex
	queued    int
	cancelled chan platform.Window
}

func (p *layoutEndCalls) EnqueueUI(work func()) error {
	p.mu.Lock()
	p.queued++
	p.mu.Unlock()
	return p.Platform.EnqueueUI(work)
}

func (p *layoutEndCalls) CancelLayout(window platform.Window) error {
	p.cancelled <- window
	return p.Platform.CancelLayout(window)
}

func (p *layoutEndCalls) queuedWorks() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.queued
}

// The end of the web content process of the main page ends the page that holds the layout tickets of the window, so the host cancels
// every layout transaction of the window: it queues that cancel for the UI thread in the turn in which it learns of that end
// (docs/spec/native-surfaces.md#layout-transaction).
// contract: application.window.page-end-cancels-layout
func TestTheEndOfThePageProcessCancelsTheLayoutOfItsWindow(t *testing.T) {
	native := support.TitledWindow(t, runOnMainThread, 400, 300)
	window := &eventWindow{pagelessWindow: pagelessWindow{native: native}, listeners: map[WindowEvent][]func(){}}
	calls := &layoutEndCalls{cancelled: make(chan platform.Window, 4)}
	realPagelessHost(t, window, func(current platform.Platform) platform.Platform {
		calls.Platform = current
		return calls
	}, false)
	// The queued work of the UI thread runs after the step of the turn that queued it, so the step reads the state of the turn.
	runOnMainThread(func() {
		for _, listener := range window.listeners[WindowWorkbenchEnded] {
			listener()
		}
		if len(calls.cancelled) != 0 || calls.queuedWorks() != 1 {
			t.Errorf("the end of the page process cancelled the layouts of %d windows in its turn and queued %d works, want none cancelled and one queued",
				len(calls.cancelled), calls.queuedWorks())
		}
	})
	if got := <-calls.cancelled; got != native {
		t.Fatalf("the end of the page process cancelled the layouts of %v, want window %v once", got, native)
	}
}

// nativeSteppingFramework is a framework without a main page whose steps run on the main thread of the native library and tell
// whether a main-thread step runs.
type nativeSteppingFramework struct {
	pagelessFramework
	inStep *bool
}

func (f nativeSteppingFramework) Step(task func()) {
	stepOnMainThread(func() {
		*f.inStep = true
		defer func() { *f.inStep = false }()
		task()
	})
}

// contentSizeReads records, for each read of the content size of a window, whether it ran in a main-thread step. The read goes on to the
// platform of the operating system, which refuses a window that is gone.
type contentSizeReads struct {
	platform.Platform
	inStep *bool
	reads  []bool
}

func (p *contentSizeReads) WindowContentSize(window platform.Window) (float64, float64, error) {
	p.reads = append(p.reads, *p.inStep)
	return p.Platform.WindowContentSize(window)
}

// A framework calls the listener of a window event outside the main thread, and the window state can be read only in a
// main-thread step: a read of the content size outside it ends the process, as the start of the Wails host did. The resize
// reads the content size that it records in the main-thread step of its change.
// contract: windows.events.resize-size-read-in-main-thread-step
func TestAResizeReadsTheContentSizeInAMainThreadStep(t *testing.T) {
	current, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	window := &eventWindow{pagelessWindow: pagelessWindow{native: support.TitledWindow(t, runOnMainThread, 400, 300)}, listeners: map[WindowEvent][]func(){}}
	inStep := false
	previousFramework, previousSystem := framework, system
	calls := &contentSizeReads{Platform: current, inStep: &inStep}
	framework, system = nativeSteppingFramework{pagelessFramework: pagelessFramework{window: window}, inStep: &inStep}, calls
	t.Cleanup(func() { framework, system = previousFramework, previousSystem })
	host := &Host{windows: map[uint]*Surfaces{}, owners: map[string]*Surfaces{}}
	s := host.newWindow("main", "")
	t.Cleanup(func() { endObservations(s) })
	// A window that closed reads no on-screen state in the step, so the step holds only the read of the content size.
	window.native = 0
	calls.reads = nil
	for _, listener := range window.listeners[WindowResize] {
		listener()
	}
	if !reflect.DeepEqual(calls.reads, []bool{true}) {
		t.Fatalf("the resize read the content size %d times, in a main-thread step %v, want once in a step", len(calls.reads), calls.reads)
	}
}
