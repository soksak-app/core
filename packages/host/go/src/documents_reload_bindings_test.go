package host

import (
	"path/filepath"
	"testing"
	"unsafe"
)

// A main page reload ends the documents of every surface of the window. The views that the reloaded page creates on two other
// surfaces stay bound to their own surfaces: each native view names the surface it was created for, and the view of that surface
// resolves to that surface when a request of its page is authorized.
// contract: surface.view.reload-keeps-bindings
func TestAReloadKeepsEachViewBoundToItsOwnSurface(t *testing.T) {
	probe := newViewProbe(t, Theme{})
	if err := probe.attach(t, nullOriginStart(), "ui/page.html"); err != nil {
		t.Fatalf("attach the first view: %v", err)
	}
	const secondSurface = "probe-surface-b"
	view, err := probe.s.createRegisteredSurface(runOnMainThread, secondSurface, func() (unsafe.Pointer, error) { return system.CreateSurface(probe.window) })
	if err != nil {
		t.Fatalf("create the second surface: %v", err)
	}
	probe.s.views[secondSurface] = view
	second := view.handle
	runOnMainThread(func() {
		system.SetSurfaceBounds(second, 0, 0, 500, 400)
		system.SetSurfaceHiddenHandle(second, false)
	})
	t.Cleanup(func() {
		runOnMainThread(func() {
			probe.s.closeSurfaceDocuments(secondSurface, "test-cleanup")
			system.CloseSurface(second)
		})
	})
	folder, err := filepath.Abs(filepath.Join("testdata", "view-plugin"))
	if err != nil {
		t.Fatal(err)
	}
	runOnMainThread(func() {
		err := probe.s.attachView(secondSurface, second, viewStoreDirectory(t), folder, "probe", "ui/page.html", testdataText(t, "view-channel.js"), nullOriginStart())
		if err != nil {
			t.Errorf("attach the second view: %v", err)
		}
	})

	s := probe.s
	// Each page view of a surface is a native webview of the window, which a request of the page names by its id; the id of the view
	// resolves to the surface that the native view of the page is named for (exposure.go surfaceOf).
	const firstView, secondView = uint64(710001), uint64(710002)
	nativeViews[firstView] = &nativeWebview{owner: s, id: firstView, handle: probe.surface}
	nativeViews[secondView] = &nativeWebview{owner: s, id: secondView, handle: second}
	t.Cleanup(func() { delete(nativeViews, firstView); delete(nativeViews, secondView) })
	// Before the reload each view resolves to its own surface, so a later difference is the reload's.
	if got := s.surfaceOf(firstView); got != "probe-surface" {
		t.Fatalf("the first view resolves to %q before the reload, want probe-surface", got)
	}
	if got := s.surfaceOf(secondView); got != secondSurface {
		t.Fatalf("the second view resolves to %q before the reload, want %s", got, secondSurface)
	}
	s.host.relay = &Relay[relayTarget]{waiting: map[uint64]*relayWaiter[relayTarget]{}}
	s.reloadCancelLayout = func() error { return nil }
	s.reloadKeysPageEnded = func() {}
	s.reloadHideSurface = func(unsafe.Pointer, bool) {}
	s.reloadCloseImage = func(unsafe.Pointer) {}
	probe.main(func() {
		if _, err := s.reloadSurfaceDocuments(); err != nil {
			t.Errorf("reload the surface documents: %v", err)
		}
	})

	// The reloaded page creates the view of each surface again.
	runOnMainThread(func() {
		if err := s.attachView("probe-surface", probe.surface, viewStoreDirectory(t), folder, "probe", "ui/page.html", testdataText(t, "view-channel.js"), nullOriginStart()); err != nil {
			t.Errorf("attach the first view after the reload: %v", err)
		}
		if err := s.attachView(secondSurface, second, viewStoreDirectory(t), folder, "probe", "ui/page.html", testdataText(t, "view-channel.js"), nullOriginStart()); err != nil {
			t.Errorf("attach the second view after the reload: %v", err)
		}
	})

	// A request of a view is authorized as the surface of that view: the view of the first surface names the first surface, and the
	// view of the second surface names the second one.
	if got := s.surfaceOf(firstView); got != "probe-surface" {
		t.Fatalf("the first view resolves to %q after the reload, want probe-surface", got)
	}
	if got := s.surfaceOf(secondView); got != secondSurface {
		t.Fatalf("the second view resolves to %q after the reload, want %s", got, secondSurface)
	}
}
