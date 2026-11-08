//go:build e2e

package adapter_test

// Checks the native view of a window of the mygo framework adapter, which holds the surface hosts of the window. A window and its
// views need a display, so these tests are end-to-end checks (docs/operations/examples.md#test-kinds). The placement of a surface
// host by the native view element that draws it needs a surface that is an element of a window of a host, so it is checked by
// TestE2EAViewPageShowsInASurfaceHostOfTheNativeView with the host session of platform/darwin/system.

import (
	"testing"
	"unsafe"

	"github.com/egoist/mygo"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	"github.com/soksak-app/core/packages/host/mygo/tests/support"
)

// The surface hosts of a window lie in its native view, because the window has no main web view.
func TestE2EASurfaceHostLiesInTheNativeViewOfTheWindow(t *testing.T) {
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	_, _, window := support.Open(t, t.Name())
	var surface unsafe.Pointer
	mygo.RunOnMain(func() { surface, err = system.CreateSurface(window.NativeWindow()) })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { mygo.RunOnMain(func() { system.CloseSurface(surface) }) })
}
