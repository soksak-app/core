package adapter

import (
	"testing"
	"unsafe"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

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

// A preparation that took over a transaction whose frame an earlier preparation asked for, and which presented in it, hears that frame:
// the window has held its frames since that frame, so it drew the lines that the newer preparation places, and another frame would
// wait for the commit that waits for the notice. The trace records that frame, and the window keeps its hold; the window of the
// check is none, so a frame that the notice asked for fails the check.
func TestAPreparationAfterTheFrameOfItsTransactionHearsThatFrame(t *testing.T) {
	trace := &tracePlatform{}
	t.Cleanup(platform.Substitute(trace))
	f := &Frontend{name: "main", framework: &Framework{transaction: true}, held: true, transacted: true}
	var heard []error
	if err := f.AfterPresentation(func(err error) { heard = append(heard, err) }); err != nil {
		t.Fatal(err)
	}
	if len(heard) != 1 || heard[0] != nil || !f.held {
		t.Fatalf("the notice of the preparation heard %v, and the window is held %v", heard, f.held)
	}
	if trace.requested != 1 || trace.presented != 1 {
		t.Fatalf("the trace recorded %d requests and %d presentations of the frame of the transaction", trace.requested, trace.presented)
	}
}

// The frame that opened the layout of its window is the frame of the transaction once it presented in it, as when its scene changed
// nothing; a frame that waits for a drawable or found none leaves the preparation to ask for its own. The report of the frame tells
// it, so the window holds its frames from that report. The window of the check holds its frames already, so the report asks the
// window for nothing.
func TestTheFrameThatOpensTheLayoutIsItsFrameOnceItPresented(t *testing.T) {
	for outcome, framed := range map[ui.FrameOutcome]bool{
		ui.FrameTransaction: true, ui.FrameImmediate: true, ui.FrameUndamaged: true, ui.FrameStashed: false, ui.FrameSkipped: false,
	} {
		f := &Frontend{framework: &Framework{transaction: true}, held: true, opening: true}
		f.frameEnded(outcome)
		if f.framed != framed || f.opening {
			t.Fatalf("after the outcome %v the window is framed %v and opening %v", outcome, f.framed, f.opening)
		}
	}
}

// A frame built for a capture leaves its presentation to the next frame of the surface, so the layout waits for the report of
// that frame. The window of the check is none, so a hold fails the check.
func TestTheOpeningFrameOfACaptureLeavesTheLayoutToTheNextFrame(t *testing.T) {
	f := &Frontend{framework: &Framework{transaction: true}, opening: true}
	f.frameEnded(ui.FrameHeld)
	if !f.opening || f.framed || f.held {
		t.Fatalf("after a frame of a capture the window is opening %v, framed %v and held %v", f.opening, f.framed, f.held)
	}
}

// The frame that opens the layout asks the window for no notice: a notice asks for a frame, which the window would draw after the
// commit with nothing changed, and which the report of the opening frame would announce, so the window would not be settled. The
// window of the check is none, so a call to it fails the check.
func TestTheFrameThatOpensTheLayoutAsksForNoFrame(t *testing.T) {
	f := &Frontend{framework: &Framework{transaction: true}}
	f.openedInFrame()
	if !f.opening || f.held {
		t.Fatalf("the frame that opened the layout left the window opening %v and held %v", f.opening, f.held)
	}
}

// The report of a frame after the end of the layout that it opened changes nothing: no transaction holds the window, and the next
// one has a frame of its own. The window of the check is none, so a hold fails the check.
func TestTheReportOfAFrameAfterItsLayoutChangesNothing(t *testing.T) {
	f := &Frontend{framework: &Framework{}}
	f.frameEnded(ui.FrameTransaction)
	if f.framed || f.held {
		t.Fatalf("a report after the transaction made the window framed %v and held %v", f.framed, f.held)
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
