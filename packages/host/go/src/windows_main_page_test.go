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
