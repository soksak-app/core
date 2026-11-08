//go:build e2e

package adapter_test

// Checks the surfaces of a window of the mygo framework adapter: the native view that holds them and the placement of a surface host
// by the native view element that draws it. A placement runs in a presented frame, so these tests need a display
// (docs/operations/examples.md#test-kinds).

import (
	"sync/atomic"
	"testing"
	"unsafe"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform"
	adapter "github.com/soksak-app/core/packages/host/mygo/src"
	"github.com/soksak-app/core/packages/host/mygo/tests/support"
)

// surfaceWorkbench draws one native view element in a box of 200 by 100 at (30, 40), once a surface host is given.
type surfaceWorkbench struct {
	support.SceneWorkbench
	view atomic.Uintptr
}

func (w *surfaceWorkbench) Build(window host.Frontend) func(c *ui.Context) {
	return func(c *ui.Context) {
		if view := w.view.Load(); view != 0 {
			ui.NativeView(c, view, 0).Absolute().Left(30).Top(40).Size(200, 100)
		}
	}
}

// openSurface opens a window of surfaceWorkbench and makes a surface host in it.
func openSurface(t *testing.T) (*surfaceWorkbench, *adapter.Frontend, platform.Platform, unsafe.Pointer) {
	t.Helper()
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	workbench := &surfaceWorkbench{}
	window := adapter.NewFramework(workbench).NewWindow(host.WindowOptions{Name: t.Name(), Title: "soksak", Width: 400, Height: 300}).(*adapter.Frontend)
	t.Cleanup(window.Window().Destroy)
	var surface unsafe.Pointer
	mygo.RunOnMain(func() { surface, err = system.CreateSurface(window.NativeWindow()) })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { mygo.RunOnMain(func() { system.CloseSurface(surface) }) })
	return workbench, window, system, surface
}

// The surface hosts of a window lie in its native view, because the window has no main web view.
func TestE2EASurfaceHostLiesInTheNativeViewOfTheWindow(t *testing.T) {
	openSurface(t)
}

// A native view element places the surface host that it names in the frame that draws it.
func TestE2EANativeViewElementPlacesItsSurfaceHost(t *testing.T) {
	workbench, window, system, surface := openSurface(t)
	workbench.view.Store(uintptr(surface))
	window.Window().Invalidate()
	support.Wait(t, "the placement of the surface host", func() bool {
		var frame platform.Rect
		mygo.RunOnMain(func() { frame = system.SurfaceFrame(surface) })
		return frame == platform.Rect{X: 30, Y: 40, W: 200, H: 100}
	})
	if got := window.Frames().NativeViews(); got != 1 {
		t.Fatalf("the window holds %d native view elements, want the 1 that it placed", got)
	}
}
