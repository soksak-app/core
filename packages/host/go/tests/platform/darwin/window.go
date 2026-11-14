//go:build darwin

package darwin

import (
	"testing"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	"github.com/soksak-app/core/packages/host/go/tests/platform/darwin/testlibrary"
)

// Window creates a borderless native window with a content view of the given size in points and closes it when the test ends.
// The window is not ordered on screen. AppKit requires the main thread, so onMain is the function of the test that runs a task
// on the main thread and returns when it returned (runOnMainThread of the tests of the Go language host library); creation and
// the close at the end of the test run through it, and the native functions refuse on another thread. The native test interface
// must be installed (testplatform.InstallMainThread, normally in TestMain). The returned handle is the platform.Window of the
// darwin layer, and a test uses it through platform.Current() inside onMain.
func Window(t testing.TB, onMain func(func()), width, height float64) platform.Window {
	t.Helper()
	return window(t, onMain, width, height, requireNativeFunctions().SpHostTestWindowCreate)
}

// TitledWindow creates the window of Window with the title bar styles of a framework window: the standard window buttons and a hidden
// title bar over a content view that fills the window, so the operations of the platform on the title bar and the window controls
// run on it. The window has no main web view, as the window of a framework that draws its workbench in native views has none.
func TitledWindow(t testing.TB, onMain func(func()), width, height float64) platform.Window {
	t.Helper()
	return window(t, onMain, width, height, requireNativeFunctions().SpHostTestWindowCreateTitled)
}

func window(t testing.TB, onMain func(func()), width, height float64, create func(float64, float64, *unsafe.Pointer) *byte) platform.Window {
	t.Helper()
	functions := requireNativeFunctions()
	var handle unsafe.Pointer
	var failure *byte
	onMain(func() { failure = create(width, height, &handle) })
	if err := testlibrary.Error(failure); err != nil {
		t.Fatalf("the native test window of size %gx%g was not created: %v", width, height, err)
	}
	t.Cleanup(func() {
		var failure *byte
		onMain(func() { failure = functions.SpHostTestWindowClose(handle) })
		if err := testlibrary.Error(failure); err != nil {
			t.Errorf("the native test window was not closed: %v", err)
		}
	})
	return platform.Window(uintptr(handle))
}

// WindowWithMainPage creates the window of Window and gives it the main web view that a framework gives its window: a web view that
// fills the content view and has loaded the page fixture of native/darwin/tests/fixtures, named by its file name. The platform registers
// the web view as the main web view of the window, so the operations of the platform that need it, such as the creation of a web
// view, the creation of a surface and the facts of the window, run on the window. The web view closes with the window at the end of
// the test. The creation and the registration run through onMain, and the wait for the load runs on the goroutine of the test, because
// the main thread delivers the navigation.
func WindowWithMainPage(t testing.TB, onMain func(func()), width, height float64, fixture string) platform.Window {
	t.Helper()
	return mainPage(t, onMain, Window(t, onMain, width, height), fixture)
}

// TitledWindowWithMainPage is WindowWithMainPage on the window of TitledWindow.
func TitledWindowWithMainPage(t testing.TB, onMain func(func()), width, height float64, fixture string) platform.Window {
	t.Helper()
	return mainPage(t, onMain, TitledWindow(t, onMain, width, height), fixture)
}

func mainPage(t testing.TB, onMain func(func()), window platform.Window, fixture string) platform.Window {
	t.Helper()
	functions := requireNativeFunctions()
	name := append([]byte(fixture), 0)
	var view unsafe.Pointer
	var failure *byte
	onMain(func() { failure = functions.SpHostTestWindowMainWebview(unsafe.Pointer(window), &name[0], &view) })
	if err := testlibrary.Error(failure); err != nil {
		t.Fatalf("the main web view of the native test window was not created: %v", err)
	}
	if err := testlibrary.Error(functions.SpHostTestWebviewLoaded(view)); err != nil {
		t.Fatalf("the main page %s of the native test window did not load: %v", fixture, err)
	}
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	var registered error
	onMain(func() { registered = system.SetMainWebview(window) })
	if registered != nil {
		t.Fatalf("the main web view of the native test window was not registered: %v", registered)
	}
	return window
}

// ReleaseHeldPresentations releases the presentation waits that the fault point SOKSAK_FAULT_VIEW_PRESENTATION=hold of the native
// library holds: each callback that the point holds runs on the main thread of the library after this call, and a wait that begins
// after it is held again while the point is set.
func ReleaseHeldPresentations(t testing.TB) {
	t.Helper()
	if err := testlibrary.Error(requireNativeFunctions().SpHostTestViewPresentationRelease()); err != nil {
		t.Fatalf("the held presentations were not released: %v", err)
	}
}

// ImageRegions returns the number of image region views that the window holds, read from the native library on the main thread.
func ImageRegions(t testing.TB, onMain func(func()), window platform.Window) uint64 {
	t.Helper()
	var count uint64
	var failure *byte
	onMain(func() {
		failure = requireNativeFunctions().SpHostTestWindowImageRegions(unsafe.Pointer(window), &count)
	})
	if err := testlibrary.Error(failure); err != nil {
		t.Fatalf("the image regions of the window were not read: %v", err)
	}
	return count
}

// KeysWait returns the key wait of the window: whether its keys wait, whether they wait for the decision of the workbench and whether
// they wait for a modal web view, read from the native library on the main thread.
func KeysWait(t testing.TB, onMain func(func()), window platform.Window) (waiting, decision, modal bool) {
	t.Helper()
	var failure *byte
	onMain(func() {
		failure = requireNativeFunctions().SpHostTestWindowKeysWait(unsafe.Pointer(window), &waiting, &decision, &modal)
	})
	if err := testlibrary.Error(failure); err != nil {
		t.Fatalf("the key wait of the window was not read: %v", err)
	}
	return waiting, decision, modal
}

// PresentLeaseFrame presents a fresh frame of the native raster size into the image region, which is in the lease mode and placed in a
// laid-out surface, with the identity generation, raster and sequence. The region holds the frame, so its close runs the release
// callback of the lease with that identity.
func PresentLeaseFrame(t testing.TB, onMain func(func()), region unsafe.Pointer, generation, raster uint64, sequence int32) {
	t.Helper()
	var failure *byte
	onMain(func() {
		failure = requireNativeFunctions().SpHostTestRegionPresentLease(region, generation, raster, sequence)
	})
	if err := testlibrary.Error(failure); err != nil {
		t.Fatalf("the frame was not presented into the region: %v", err)
	}
}

// OpenKeyWait opens the key wait of the window as the release of a press on the workbench does, with the wait for the decision of the
// workbench set when decision is true, on the main thread.
func OpenKeyWait(t testing.TB, onMain func(func()), window platform.Window, decision bool) {
	t.Helper()
	var failure *byte
	onMain(func() {
		failure = requireNativeFunctions().SpHostTestWindowOpenKeyWait(unsafe.Pointer(window), decision)
	})
	if err := testlibrary.Error(failure); err != nil {
		t.Fatalf("the key wait of the window was not opened: %v", err)
	}
}
