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

// tracePlatform is a platform that records the layout trace of the frame of a transaction: the requests and the presentations.
type tracePlatform struct {
	platform.Platform
	platform.Capturer
	requested, presented int
}

func (p *tracePlatform) LayoutTraceRequested() func() {
	p.requested++
	return func() { p.presented++ }
}

// A preparation that took over the layout that a frame of its window opened has that frame for its frame once it presented in the
// transaction: the notice comes at once, the window keeps its hold, and no second frame waits for the commit that waits for the
// notice (docs/spec/hosts.md#native-views). The window of the check is none, so a frame that the notice asked for fails the check.
func TestAPreparationThatTakesOverTheLayoutOfAPresentedFrameHearsThatFrame(t *testing.T) {
	trace := &tracePlatform{}
	t.Cleanup(platform.Substitute(trace))
	f := &Frontend{name: "main", framework: &Framework{transaction: true}, held: true, framed: true}
	var heard []error
	if err := f.AfterPresentation(func(err error) { heard = append(heard, err) }); err != nil {
		t.Fatal(err)
	}
	if len(heard) != 1 || heard[0] != nil {
		t.Fatalf("the notice of the preparation heard %v", heard)
	}
	if !f.held {
		t.Fatal("the notice released the window inside the transaction")
	}
	if trace.requested != 1 || trace.presented != 1 {
		t.Fatalf("the trace recorded %d requests and %d presentations of the frame of the transaction", trace.requested, trace.presented)
	}
}

// The frame that opened the layout of its window is the frame of the transaction once it presented in it, as when its scene changed
// nothing; a frame that found no drawable, or that the window held, leaves the preparation to ask for its own. The window of the check
// holds its frames already, so the notice asks the window for nothing.
func TestTheFrameThatOpensTheLayoutIsItsFrameOnceItPresented(t *testing.T) {
	for presentation, framed := range map[mygo.Presentation]bool{
		mygo.Presented: true, mygo.PresentNoDamage: true, mygo.PresentNoDrawable: false, mygo.PresentHeld: false,
	} {
		f := &Frontend{framework: &Framework{transaction: true}, held: true, opening: true}
		f.openingPresented(presentation, nil)
		if f.framed != framed || f.opening {
			t.Fatalf("after %v the window is framed %v and opening %v", presentation, f.framed, f.opening)
		}
	}
}

// The notice of a frame that opened a layout that ended before it presented changes nothing: no transaction holds the window, and
// the next one has a frame of its own. The window of the check is none, so a hold fails the check.
func TestTheNoticeOfAnOpeningFrameAfterItsLayoutChangesNothing(t *testing.T) {
	f := &Frontend{framework: &Framework{}}
	f.openingPresented(mygo.Presented, nil)
	if f.framed || f.held {
		t.Fatalf("a notice after the transaction made the window framed %v and held %v", f.framed, f.held)
	}
}

// A layout that starts while nothing builds a frame of the window, or while the window holds its frames, has no frame that opened it.
func TestALayoutOutsideTheFrameOfItsWindowHasNoOpeningFrame(t *testing.T) {
	for _, f := range []*Frontend{{}, {building: true, held: true}} {
		if f.opensLayout(0) {
			t.Fatalf("the layout opens in the frame of the window building %v and held %v", f.building, f.held)
		}
	}
}
