package host

import (
	"path/filepath"
	"testing"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	support "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
)

// A surface that a preparation creates has no element in the frame of the transaction, which was built before the surface existed,
// so the preparation places it in its box, and the element of the next frame keeps that place: a window without a main page has
// it at the commit in the place that the preparation reports, where the element of the next frame shows it
// (docs/spec/hosts.md#native-views). A surface that the preparation finds keeps the place that its element gives it. The window and the
// surfaces are of the real platform, which reads the frame of each surface host back; the framework declares that its windows have no main
// page, which decides the preparation, and the window holds the main web view that the creation of a surface host needs of the platform.
// contract: surface-layout.created-surface-placed-without-a-main-page
func TestAPreparationPlacesTheSurfaceThatItCreatesInAWindowWithoutAMainPage(t *testing.T) {
	useCurrentPlatformForViews(t)
	native := support.WindowWithMainPage(t, runOnMainThread, 1200, 800, "main-page.html")
	window := &pagelessWindow{native: native}
	previousFramework := framework
	framework = pagelessFramework{window: window}
	t.Cleanup(func() { framework = previousFramework })
	s := &Surfaces{window: window, invoke: func(task func()) { task() }, views: map[string]*nativeWebview{}, named: map[uintptr]string{},
		compositions: map[string]SurfaceComposition{}, surfacePlugins: map[string]string{}, images: NewImages(), documents: NewDocuments(),
		sidecars: &Sidecars{}}
	// The views of the two surfaces exist before the preparation, so it only places them: their documents are web views of the real
	// platform in a surface that the test creates for them.
	var host unsafe.Pointer
	var err error
	runOnMainThread(func() { host, err = system.CreateSurface(native) })
	if err != nil {
		t.Fatal(err)
	}
	folder, err := filepath.Abs(filepath.Join("testdata", "view-plugin"))
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"new", "found"} {
		key := DocumentKey{Surface: id, Name: viewRegionName}
		if err := s.documents.Reserve(key); err != nil {
			t.Fatal(err)
		}
		var document unsafe.Pointer
		runOnMainThread(func() {
			document, err = system.CreateDocument(host, platform.DocumentOptions{Directory: viewStoreDirectory(t), Folder: folder, Plugin: "probe",
				Label: ProcessLabel("probe", "")}, func(string) {})
		})
		if err != nil {
			t.Fatal(err)
		}
		s.documents.Set(key, document)
	}
	t.Cleanup(func() {
		runOnMainThread(func() {
			for _, id := range []string{"new", "found"} {
				if document, err := s.documents.Get(DocumentKey{Surface: id, Name: viewRegionName}); err == nil {
					system.CloseDocument(document)
				}
			}
			system.CloseSurface(host)
		})
	})
	// The surface that the preparation finds has a frame of its own, which the element of its frame gave it.
	foundFrame := Rect{X: 5, Y: 6, W: 70, H: 30}
	var found *nativeWebview
	runOnMainThread(func() {
		found, err = s.createRegisteredSurface(mainThreadStep, "found", func() (unsafe.Pointer, error) { return system.CreateSurface(native) })
		if err == nil {
			system.SetSurfaceBounds(found.handle, foundFrame.X, foundFrame.Y, foundFrame.W, foundFrame.H)
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	s.views["found"] = found
	t.Cleanup(func() {
		runOnMainThread(func() {
			for _, view := range s.views {
				system.CloseSurface(view.handle)
			}
		})
	})
	start := &ViewStart{}
	var placed []Placement
	runOnMainThread(func() {
		_, placed, err = s.apply(window, SyncRequest{Settled: true, Surfaces: []Surface{
			{ID: "new", Visible: true, Plugin: "p", Rect: Rect{X: 10, Y: 20, W: 300, H: 200}, Start: start},
			{ID: "found", Visible: true, Plugin: "p", Rect: Rect{X: 40, Y: 50, W: 100, H: 80}, Start: start},
		}})
	})
	if err != nil {
		t.Fatal(err)
	}
	// The box of the new surface is the rectangle that the platform aligns to the pixels of the window.
	var aligned platformRect
	runOnMainThread(func() { aligned, _, err = system.AlignRect(native, platformRect{X: 10, Y: 20, W: 300, H: 200}) })
	if err != nil {
		t.Fatal(err)
	}
	want := Rect(aligned)
	var created, kept platform.Rect
	runOnMainThread(func() {
		created = system.SurfaceFrame(s.views["new"].handle)
		kept = system.SurfaceFrame(found.handle)
	})
	if Rect(created) != want {
		t.Fatalf("the created surface host has the frame %v, want its aligned box %v", created, want)
	}
	if Rect(kept) != foundFrame {
		t.Fatalf("the preparation set the frame %v of a surface that its element places, which had %v", kept, foundFrame)
	}
	if len(placed) != 2 || placed[0].Rect != want {
		t.Fatalf("the preparation reports the placements %v", placed)
	}
}
