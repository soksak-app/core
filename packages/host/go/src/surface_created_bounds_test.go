package host

import (
	"testing"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// createdPlatform answers the calls of a preparation that creates a surface in a window without a main page, and records the frames
// that it sets on the surface hosts.
type createdPlatform struct {
	pagelessPlatform
	bounds map[unsafe.Pointer]Rect
}

func (*createdPlatform) CreateSurface(platform.Window) (unsafe.Pointer, error) {
	return unsafe.Pointer(new(byte)), nil
}

func (*createdPlatform) AlignRect(_ platform.Window, at platformRect) (platformRect, float64, error) {
	return platformRect{X: at.X + 0.5, Y: at.Y + 0.5, W: at.W, H: at.H}, 2, nil
}

func (p *createdPlatform) SetSurfaceBounds(surface unsafe.Pointer, x, y, w, h float64) {
	p.bounds[surface] = Rect{X: x, Y: y, W: w, H: h}
}

func (*createdPlatform) SetSurfaceHiddenHandle(unsafe.Pointer, bool)                            {}
func (*createdPlatform) SetSurfaceAlphaHandle(unsafe.Pointer, float64)                          {}
func (*createdPlatform) PlaceDocument(unsafe.Pointer, float64, float64, float64, float64, bool) {}

// A surface that a preparation creates has no element in the frame of the transaction, which was built before the surface existed,
// so the preparation places it in its box, and the element of the next frame keeps that place: a window without a main page has
// it at the commit in the place that the preparation reports, where the element of the next frame shows it
// (docs/spec/hosts.md#native-views). A surface that the preparation finds keeps the place that its element gives it.
// contract: surface-layout.created-surface-placed-without-a-main-page
func TestAPreparationPlacesTheSurfaceThatItCreatesInAWindowWithoutAMainPage(t *testing.T) {
	window := &pagelessWindow{native: platform.Window(1)}
	fake := &createdPlatform{bounds: map[unsafe.Pointer]Rect{}}
	previousFramework, previousSystem := framework, system
	framework, system = pagelessFramework{window: window}, fake
	t.Cleanup(func() { framework, system = previousFramework, previousSystem })
	s := &Surfaces{window: window, invoke: func(task func()) { task() }, views: map[string]*nativeWebview{}, named: map[uintptr]string{},
		compositions: map[string]SurfaceComposition{}, surfacePlugins: map[string]string{}, images: NewImages(), documents: NewDocuments(),
		sidecars: &Sidecars{}}
	for _, id := range []string{"new", "found"} {
		key := DocumentKey{Surface: id, Name: viewRegionName}
		if err := s.documents.Reserve(key); err != nil {
			t.Fatal(err)
		}
		s.documents.Set(key, unsafe.Pointer(new(byte)))
	}
	found, err := s.createRegisteredSurface(mainThreadStep, "found", func() (unsafe.Pointer, error) { return fake.CreateSurface(1) })
	if err != nil {
		t.Fatal(err)
	}
	s.views["found"] = found
	start := &ViewStart{}
	_, placed, err := s.apply(window, SyncRequest{Settled: true, Surfaces: []Surface{
		{ID: "new", Visible: true, Plugin: "p", Rect: Rect{X: 10, Y: 20, W: 300, H: 200}, Start: start},
		{ID: "found", Visible: true, Plugin: "p", Rect: Rect{X: 40, Y: 50, W: 100, H: 80}, Start: start},
	}})
	if err != nil {
		t.Fatal(err)
	}
	want := Rect{X: 10.5, Y: 20.5, W: 300, H: 200}
	if got, ok := fake.bounds[s.views["new"].handle]; !ok || got != want {
		t.Fatalf("the created surface host has the frame %v (set %v), want its aligned box %v", got, ok, want)
	}
	if got, ok := fake.bounds[found.handle]; ok {
		t.Fatalf("the preparation set the frame %v of a surface that its element places", got)
	}
	if len(placed) != 2 || placed[0].Rect != want {
		t.Fatalf("the preparation reports the placements %v", placed)
	}
}
