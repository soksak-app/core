package adapter

import (
	"testing"
	"unsafe"

	"github.com/egoist/mygo"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform"
)

func TestAStepRecordCarriesTheNamesOfTheEventLog(t *testing.T) {
	for kind, want := range map[mygo.StepKind]string{mygo.StepSelector: "selector", mygo.StepBlock: "block", mygo.StepCallback: "callback"} {
		got := stepRecord(mygo.StepRecord{Kind: kind, Callback: "hitTest:", Entry: 1, Return: 2, Forwarded: 3, Wait: 4}, "main")
		if want := (host.StepRecord{Window: "main", Kind: want, Callback: "hitTest:", Entry: 1, Return: 2, Forwarded: 3, Wait: 4}); got != want {
			t.Fatalf("the record is %+v, want %+v", got, want)
		}
	}
}

func TestRecordStepsEndsWhenItsStopReturns(t *testing.T) {
	stop := (&Framework{}).RecordSteps(func(host.StepRecord) {}, func(uint64) {})
	stop()
}

// placementPlatform takes the placement of the surface hosts.
type placementPlatform struct{ platform.Platform }

func (placementPlatform) SetSurfaceBounds(unsafe.Pointer, float64, float64, float64, float64) {}
func (placementPlatform) SetSurfaceHiddenHandle(unsafe.Pointer, bool)                         {}

func TestAPlacementStoresTheNativeViewElementsOfTheWindow(t *testing.T) {
	f := &Frontend{frames: host.NewWindowFrames("main")}
	f.placeSurfaces(placementPlatform{}, []mygo.NativePlacement{{View: 1}, {View: 2}})
	if got := f.frames.NativeViews(); got != 2 {
		t.Fatalf("after a placement of two views the window holds %d native view elements", got)
	}
	f.placeSurfaces(placementPlatform{}, nil)
	if got := f.frames.NativeViews(); got != 0 {
		t.Fatalf("after a placement of no view the window holds %d native view elements", got)
	}
}
