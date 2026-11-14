package host

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	support "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
)

// realPresentedFrontend is the window of a settled wait test whose settled presentation is the main presentation of its native window,
// which the platform makes as the framework does.
type realPresentedFrontend struct {
	frontendRecord
	window platform.Window
}

func (f *realPresentedFrontend) NativeWindow() platform.Window { return f.window }
func (f *realPresentedFrontend) SettledPresentation() (unsafe.Pointer, error) {
	return system.MainPresentation(f.window)
}

// realSettledSurfaces returns the surfaces of a window of the real platform with the window, and the framework that runs its steps on
// the main thread.
func realSettledSurfaces(t *testing.T, withMainPage bool) *Surfaces {
	t.Helper()
	useCurrentPlatformForViews(t)
	saved := framework
	framework = mainThreadFramework{}
	t.Cleanup(func() { framework = saved })
	var native platform.Window
	if withMainPage {
		native = support.WindowWithMainPage(t, runOnMainThread, 400, 300, "main-page.html")
	} else {
		native = support.Window(t, runOnMainThread, 400, 300)
	}
	return &Surfaces{window: &realPresentedFrontend{window: native}, images: NewImages()}
}

// The settled wait brings the content to the screen through the settled presentation of the Frontend: the main presentation of the window
// of the real platform settles, and the wait answers the time of the screen.
// contract: exposure.settled-wait.presents-through-the-frontend
func TestSettledWaitBringsTheContentThroughTheFrontend(t *testing.T) {
	displayed, err := realSettledSurfaces(t, true).presented(context.Background())
	if err != nil {
		t.Fatalf("the settled wait failed: %v", err)
	}
	if displayed <= 0 {
		t.Fatalf("the settled wait reported %v, want the time of the screen", displayed)
	}
}

// A settled presentation that the Frontend cannot make ends the wait with its error, before the settled wait of the platform: a window
// without a main web view has no main presentation.
// contract: exposure.settled-wait.presents-through-the-frontend
func TestSettledWaitEndsWithTheFailureOfTheFrontend(t *testing.T) {
	_, err := realSettledSurfaces(t, false).presented(context.Background())
	if err == nil || err.Error() != "native presentation is unavailable" {
		t.Fatalf("the settled wait ended with %v, want the error of the Frontend", err)
	}
}

// A window whose workbench holds a placement behind a running one presents that placement only after the workbench placed it:
// the wait asks the workbench for its last placement and settles the window only after the workbench answered.
// contract: exposure.window-presented.waits-for-the-last-placement
func TestThePresentedWindowWaitsForThePlacementThatItsWorkbenchHolds(t *testing.T) {
	asked := make(chan struct{})
	committed := make(chan struct{})
	var presentedAt []string
	placed := func() error {
		close(asked)
		<-committed
		presentedAt = append(presentedAt, "placed")
		return nil
	}
	settled := func() <-chan struct{} {
		presentedAt = append(presentedAt, "settled")
		done := make(chan struct{})
		close(done)
		return done
	}
	presented := func() (float64, error) {
		presentedAt = append(presentedAt, "presented")
		return 12.5, nil
	}
	type result struct {
		displayed float64
		err       error
	}
	answer := make(chan result, 1)
	go func() {
		displayed, err := lastPlacementPresented(placed, settled, presented)
		answer <- result{displayed, err}
	}()
	<-asked
	select {
	case got := <-answer:
		t.Fatalf("the window answered %v while its workbench held a placement", got)
	default:
	}
	close(committed)
	got := <-answer
	if got.err != nil || got.displayed != 12.5 {
		t.Fatalf("after the placement the window answered %v, %v", got.displayed, got.err)
	}
	if !reflect.DeepEqual(presentedAt, []string{"placed", "settled", "presented"}) {
		t.Fatalf("the window waited in the order %v", presentedAt)
	}
}

// A placement that fails ends the wait with that failure before the window settles. The wait for the answer of the workbench
// has no limit: a workbench that takes the request and answers nothing keeps it open until the window closes, which ends it
// with 1003 that names the last placement.
// contract: exposure.window-presented.waits-for-the-last-placement, exposure.window-presented.ends-by-events
func TestThePresentedWindowFailsWithItsLastPlacement(t *testing.T) {
	failure := errors.New("surface presentation failed")
	never := func() <-chan struct{} {
		t.Fatal("the wait went on after its last placement failed")
		return nil
	}
	none := func() (float64, error) {
		t.Fatal("the window presented after its last placement failed")
		return 0, nil
	}
	if _, err := lastPlacementPresented(func() error { return failure }, never, none); !errors.Is(err, failure) {
		t.Fatalf("a failed placement answered %v", err)
	}
	relay := NewRelay[string]()
	_, err := lastPlacementPresented(func() error {
		// The workbench takes the request and answers nothing; the close of its window is the event that ends the request.
		return relay.Request("window", func(uint64) error {
			relay.Abandon(func(target string) bool { return target == "window" })
			return nil
		}).Error
	}, never, none)
	var closed *RPCError
	if !errors.As(err, &closed) || closed.Code != codeNoWindow {
		t.Fatalf("a workbench whose window closed ended the wait with %v", err)
	}
	if !strings.Contains(err.Error(), "the last placement of the window") {
		t.Fatalf("the failure does not name the last placement: %v", err)
	}
}
