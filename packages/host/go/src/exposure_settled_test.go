package host

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// settledFrontend is the window of a settled wait test: its settled presentation is a function that stands for the block.
type settledFrontend struct {
	frontendRecord
	window    platform.Window
	present   func()
	presented error
}

func (f *settledFrontend) NativeWindow() platform.Window { return f.window }

func (f *settledFrontend) SettledPresentation() (unsafe.Pointer, error) {
	if f.presented != nil {
		return nil, f.presented
	}
	return unsafe.Pointer(&f.present), nil
}

// settledPlatform is the platform of a settled wait test: its settled wait runs the block that it takes on the window, and
// reports the time of the screen.
type settledPlatform struct {
	platform.Platform
	window    platform.Window
	displayed float64
	failure   error
	waits     int
}

func (p *settledPlatform) AfterSettled(window platform.Window, present unsafe.Pointer, done func(displayed float64, err error)) error {
	p.waits++
	if window != p.window {
		done(0, errors.New("the settled wait took another window"))
		return nil
	}
	(*(*func())(present))()
	done(p.displayed, p.failure)
	return nil
}

func settledSurfaces(t *testing.T, window *settledFrontend, fake *settledPlatform) *Surfaces {
	t.Helper()
	saved, savedFramework := system, framework
	system, framework = fake, stepFramework{}
	t.Cleanup(func() { system, framework = saved, savedFramework })
	return &Surfaces{window: window, images: NewImages()}
}

// The settled wait brings the content to the screen through the settled presentation of the Frontend.
// contract: exposure.settled-wait.presents-through-the-frontend
func TestSettledWaitBringsTheContentThroughTheFrontend(t *testing.T) {
	native := platform.Window(1)
	var brought int
	window := &settledFrontend{window: native, present: func() { brought++ }}
	fake := &settledPlatform{window: native, displayed: 12.5}
	displayed, err := settledSurfaces(t, window, fake).presented()
	if err != nil {
		t.Fatalf("the settled wait failed: %v", err)
	}
	if displayed != 12.5 {
		t.Fatalf("the settled wait reported %v, want the time of the screen", displayed)
	}
	if brought == 0 || brought != fake.waits {
		t.Fatalf("the block ran %d times in %d settled waits", brought, fake.waits)
	}
}

// A settled presentation that the Frontend cannot make ends the wait with its error, before the settled wait of the platform.
// contract: exposure.settled-wait.presents-through-the-frontend
func TestSettledWaitEndsWithTheFailureOfTheFrontend(t *testing.T) {
	refused := errors.New("the main web view is gone")
	fake := &settledPlatform{}
	_, err := settledSurfaces(t, &settledFrontend{presented: refused}, fake).presented()
	if !errors.Is(err, refused) {
		t.Fatalf("the settled wait ended with %v, want the error of the Frontend", err)
	}
	if fake.waits != 0 {
		t.Fatalf("the platform waited %d times without a presentation", fake.waits)
	}
}

// The failure of the block ends the settled wait.
// contract: exposure.settled-wait.presents-through-the-frontend
func TestSettledWaitEndsWithTheFailureOfThePresentation(t *testing.T) {
	native := platform.Window(1)
	failed := errors.New("the document did not finish")
	window := &settledFrontend{window: native, present: func() {}}
	_, err := settledSurfaces(t, window, &settledPlatform{window: native, failure: failed}).presented()
	if !errors.Is(err, failed) {
		t.Fatalf("the settled wait ended with %v, want the failure of the block", err)
	}
}

// A window whose workbench holds a placement behind a running one presents that placement only after the workbench placed it:
// the wait asks the workbench for its last placement and settles the window only after the workbench answered.
// contract: exposure.window-presented.waits-for-the-last-placement
func TestThePresentedWindowWaitsForThePlacementThatItsWorkbenchHolds(t *testing.T) {
	asked := make(chan struct{})
	committed := make(chan struct{})
	var presentedAt []string
	placed := func(time.Duration) error {
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
		displayed, err := lastPlacementPresented(placed, settled, presented, time.Second)
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

// A placement that fails, or a workbench that does not answer within the limit, ends the wait with that failure before the
// window settles.
// contract: exposure.window-presented.waits-for-the-last-placement
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
	if _, err := lastPlacementPresented(func(time.Duration) error { return failure }, never, none, time.Second); !errors.Is(err, failure) {
		t.Fatalf("a failed placement answered %v", err)
	}
	const limit = 20 * time.Millisecond
	relay := NewRelay[string]()
	var within time.Duration
	_, err := lastPlacementPresented(func(asked time.Duration) error {
		within = asked
		// The workbench takes the request and answers nothing.
		return relay.Request("window", asked, func(uint64) error { return nil }).Error
	}, never, none, limit)
	if within != limit {
		t.Fatalf("the wait asked the workbench with the limit %s", within)
	}
	var timeout *RPCError
	if !errors.As(err, &timeout) || timeout.Code != codeTimeout {
		t.Fatalf("a workbench that does not answer ended the wait with %v", err)
	}
	if !strings.Contains(err.Error(), "the last placement of the window") {
		t.Fatalf("the failure does not name the last placement: %v", err)
	}
}
