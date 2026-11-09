package adapter

import (
	"testing"
	"unsafe"

	"github.com/egoist/mygo"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// contract: window.frames.steps-reach-the-class-frame
func TestAStepRecordCarriesTheNamesOfTheEventLog(t *testing.T) {
	for kind, want := range map[mygo.StepKind]string{mygo.StepSelector: "selector", mygo.StepBlock: "block", mygo.StepCallback: "callback"} {
		got := stepRecord(mygo.StepRecord{Kind: kind, Callback: "hitTest:", Entry: 1, Return: 2, Forwarded: 3, Wait: 4}, "main")
		if want := (host.StepRecord{Window: "main", Kind: want, Callback: "hitTest:", Entry: 1, Return: 2, Forwarded: 3, Wait: 4}); got != want {
			t.Fatalf("the record is %+v, want %+v", got, want)
		}
	}
}

// contract: window.frames.step-recording-follows-the-policy
func TestRecordStepsEndsWhenItsStopReturns(t *testing.T) {
	stop := (&Framework{}).RecordSteps(func(host.StepRecord) {}, func(uint64) {})
	stop()
}

// placementPlatform takes the placement of the surface hosts.
type placementPlatform struct{ platform.Platform }

func (placementPlatform) SetSurfaceBounds(unsafe.Pointer, float64, float64, float64, float64) {}
func (placementPlatform) SetSurfaceHiddenHandle(unsafe.Pointer, bool)                         {}

// contract: window.frames.native-views-of-the-last-placement
func TestAPlacementStoresTheNativeViewElementsOfTheWindow(t *testing.T) {
	var first, second int
	surfaces := map[uintptr]unsafe.Pointer{1: unsafe.Pointer(&first), 2: unsafe.Pointer(&second)}
	surface := func(view uintptr) (unsafe.Pointer, bool) {
		handle, ok := surfaces[view]
		return handle, ok
	}
	f := &Frontend{frames: host.NewWindowFrames("main")}
	f.placeSurfaces(placementPlatform{}, surface, []mygo.NativePlacement{{View: 1}, {View: 2}})
	if got := f.frames.NativeViews(); got != 2 {
		t.Fatalf("after a placement of two views the window holds %d native view elements", got)
	}
	f.placeSurfaces(placementPlatform{}, surface, nil)
	if got := f.frames.NativeViews(); got != 0 {
		t.Fatalf("after a placement of no view the window holds %d native view elements", got)
	}
}

// contract: window.frames.steps-reach-the-class-frame
func TestAStepWithoutAFocusedWindowBelongsToTheOnlyOpenWindow(t *testing.T) {
	one := &Framework{frontends: map[*mygo.Window]*Frontend{{}: {name: "main"}}}
	if got := one.stepWindow(); got != "main" {
		t.Fatalf("the only window gives %q", got)
	}
	two := &Framework{frontends: map[*mygo.Window]*Frontend{{}: {name: "main"}, {}: {name: "second"}}}
	if got := two.stepWindow(); got != "" {
		t.Fatalf("two windows give %q", got)
	}
}

// A frame that a layout transaction holds draws inside it, so it opens no layout of its own and reaches no host.
func TestAFrameInsideALayoutTransactionOpensNoLayout(t *testing.T) {
	f := &Frontend{framework: &Framework{transaction: true}}
	ticket, err := f.OpenLayout()
	if err != nil || ticket != 0 {
		t.Fatalf("a frame inside a layout transaction opened the layout %d (%v)", ticket, err)
	}
}
