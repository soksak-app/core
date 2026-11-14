package host

import (
	"errors"
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	support "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
)

// contract: view.presentation-wait.ends
// A view joins the presentation wait once per change: a second join of a waiting view does not join again.
func TestAViewJoinsThePresentationWaitOncePerChange(t *testing.T) {
	var w presentationWait
	if !w.begin("probe-surface", nil) {
		t.Fatalf("the first join of the view does not join the wait")
	}
	if w.begin("probe-surface", nil) {
		t.Fatalf("a second join of the waiting view joined again")
	}
}

// contract: view.presentation-wait.ends
// Each end without presentation writes host.trace.view.presentation-abandoned with the surface and the reason, and each end ends the
// wait once: an end of a view that does not wait writes nothing.
func TestEachEndWithoutPresentationWritesTheAbandonedEvent(t *testing.T) {
	for _, reason := range []string{"process-ended", "hidden", "unresponsive", "input", "closed"} {
		isolateTraceRecords(t)
		var w presentationWait
		w.begin("probe-surface", nil)
		abandoned, err := w.end("probe-surface", reason)
		if err != nil || !abandoned {
			t.Fatalf("end %s: abandoned %v, error %v; want the wait to end without presentation", reason, abandoned, err)
		}
		got := bufferedTraces(t, "host.trace.view.presentation-abandoned")
		if len(got) != 1 || got[0]["surface"] != "probe-surface" || got[0]["reason"] != reason {
			t.Fatalf("abandoned records for %s: %v, want one for probe-surface", reason, got)
		}
		if again, _ := w.end("probe-surface", reason); again {
			t.Fatalf("a second end %s ended a wait that had ended", reason)
		}
	}
}

// contract: view.presentation-wait.ends
// An end without presentation calls the abandon of the native join once, and the presentation of the view does not call it.
func TestEachEndWithoutPresentationAbandonsTheNativeJoin(t *testing.T) {
	isolateTraceRecords(t)
	var w presentationWait
	abandons := 0
	abandon := func() error {
		abandons++
		return nil
	}
	w.begin("probe-surface", abandon)
	if _, err := w.end("probe-surface", "process-ended"); err != nil {
		t.Fatalf("process-ended: %v", err)
	}
	if abandons != 1 {
		t.Fatalf("the process-ended end abandoned the native join %d times, want 1", abandons)
	}
	w.begin("probe-surface", abandon)
	if _, err := w.end("probe-surface", "presented"); err != nil {
		t.Fatalf("presented: %v", err)
	}
	if abandons != 1 {
		t.Fatalf("the presented end abandoned the native join, %d abandons in total", abandons)
	}
}

// contract: view.presentation-wait.ends
// A presentation of the view ends its wait without the abandoned event, and an end that is not a reason of the wait is refused.
func TestPresentationEndsTheWaitWithoutAnAbandonedEvent(t *testing.T) {
	isolateTraceRecords(t)
	var w presentationWait
	w.begin("probe-surface", nil)
	abandoned, err := w.end("probe-surface", "presented")
	if err != nil || abandoned {
		t.Fatalf("presented: abandoned %v, error %v; want the wait to end with its presentation", abandoned, err)
	}
	if got := bufferedTraces(t, "host.trace.view.presentation-abandoned"); len(got) != 0 {
		t.Fatalf("abandoned records after a presentation: %v, want none", got)
	}
	// Cancellation aborts its layout transaction (cancelTicket), so it is not a reason that ends a wait.
	if _, err := w.end("probe-surface", "cancelled"); err == nil {
		t.Fatalf("an end with the reason cancelled was accepted")
	}
}

// contract: view.presentation-wait.presented-before-end
// A presentation that completes on its native callback ends the wait as presented before a later hide: the hide ends no wait, writes
// no abandoned record and calls no native abandon, and the queued end of the presentation finds no wait.
func TestAHideAfterAPresentedCallbackEndsNoWait(t *testing.T) {
	isolateTraceRecords(t)
	s, views, native := newLifecycleSurfaces(t)
	joins := &viewJoins{}
	events := recordWindowEvents(s)
	window := platform.Window(1)
	shown := []Placement{{ID: "probe-surface", Visible: true}}
	if err := joins.shown(s, window, 7, shown); err != nil {
		t.Fatalf("join: %v", err)
	}
	if len(joins.requests) != 1 {
		t.Fatalf("the shown view joined %d transactions, want 1", len(joins.requests))
	}
	// The native receiver of the presentation runs first, and the end that it queues for the UI thread runs after the hide.
	request := joins.requests[0]
	s.viewJoinPresented(request)
	views.sync(t, s, native, false, nullOriginStart())
	s.endPresentationWaitFor(request.surface, request.ticket, request.generation, "presented")
	if got := bufferedTraces(t, "host.trace.view.presentation-abandoned"); len(got) != 0 {
		t.Fatalf("abandoned records after a completed presentation: %v, want none", got)
	}
	if joins.abandons[0] != 0 {
		t.Fatalf("the hide abandoned the native join of a completed presentation %d times", joins.abandons[0])
	}
	if s.presentation.waits("probe-surface") {
		t.Fatalf("the completed presentation left its wait open")
	}
	for _, event := range *events {
		if event.name == "view-presentation-abandoned" {
			t.Fatalf("the window received view-presentation-abandoned after a completed presentation: %+v", event)
		}
	}
}

// contract: view.presentation-wait.invisible-present-defers-end
// An invisible root placement at a presentation joins nothing and ends no wait; the wait of a view that is shown ends at the sync that
// applies its invisibility, with one abandoned record.
func TestAnInvisiblePlacementAtPresentEndsNoWaitUntilItsSync(t *testing.T) {
	isolateTraceRecords(t)
	s, views, native := newLifecycleSurfaces(t)
	joins := &viewJoins{}
	window := platform.Window(1)
	shown := []Placement{{ID: "probe-surface", Visible: true}}
	if err := joins.shown(s, window, 7, shown); err != nil {
		t.Fatalf("join: %v", err)
	}
	hidden := []Placement{{ID: "probe-surface", Visible: false}}
	if err := joins.shown(s, window, 8, hidden); err != nil {
		t.Fatalf("present an invisible placement: %v", err)
	}
	if !s.presentation.waits("probe-surface") {
		t.Fatalf("the presentation of an invisible placement ended the wait before its sync")
	}
	if got := bufferedTraces(t, "host.trace.view.presentation-abandoned"); len(got) != 0 {
		t.Fatalf("abandoned records at present: %v, want none", got)
	}
	views.sync(t, s, native, false, nullOriginStart())
	got := bufferedTraces(t, "host.trace.view.presentation-abandoned")
	if len(got) != 1 || got[0]["surface"] != "probe-surface" || got[0]["reason"] != "hidden" {
		t.Fatalf("abandoned records at sync: %v, want one hidden record for probe-surface", got)
	}
	if joins.abandons[0] != 1 {
		t.Fatalf("the sync abandoned the native join %d times, want 1", joins.abandons[0])
	}
}

// runFrontend records the events that the window publishes.
type runFrontend struct {
	frontendRecord
	events []string
}

func (f *runFrontend) Emit(name string, _ ...any) { f.events = append(f.events, name) }

// The cancel of a ticket or of the window ends the run with its transaction: the settled waits of the run are released and
// run-ended is published once (docs/spec/native-surfaces.md#layout-transaction).
// contract: surface-layout.run-ends-with-its-transaction
func TestTheCancelOfALayoutEndsTheRun(t *testing.T) {
	for _, tc := range []struct {
		name   string
		cancel func(*Surfaces, platform.Window) error
	}{
		{"ticket", func(s *Surfaces, window platform.Window) error { return s.cancelLayoutPresentation(window, 41) }},
		{"window", func(s *Surfaces, window platform.Window) error { return s.cancelAllLayoutPresentations(window) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			useCurrentPlatformForViews(t)
			window := support.Window(t, runOnMainThread, 320, 200)
			s, _, _ := newLifecycleSurfaces(t)
			frontend := &runFrontend{}
			s.window = frontend
			s.run(true)
			settled := make(chan struct{})
			s.settled = append(s.settled, settled)
			select {
			case <-settled:
				t.Fatal("the settled wait ended while the run goes on")
			default:
			}
			var cancelled error
			runOnMainThread(func() { cancelled = tc.cancel(s, window) })
			if err := cancelled; err != nil {
				t.Fatalf("cancel the layout: %v", err)
			}
			select {
			case <-settled:
			default:
				t.Fatal("the cancel of the layout left the settled wait of the run")
			}
			if s.running || len(frontend.events) != 2 || frontend.events[1] != "run-ended" {
				t.Fatalf("after the cancel: running %v, events %v, want run-began then run-ended", s.running, frontend.events)
			}
		})
	}
}

// contract: view.presentation-wait.ends, view.presentation-wait.cancel-clears-ticket
// The cancel of a ticket removes the wait of that ticket before it abandons the native join of the wait, so an abandon that
// reaches the host again finds no wait of the cancelled ticket, and the wait of another ticket stays.
func TestCancellationRemovesOnlyItsTicketBeforeAbandoningTheNativeJoin(t *testing.T) {
	isolateTraceRecords(t)
	var w presentationWait
	abandons := 0
	w.beginFor("cancelled-surface", 41, 1, &presentationSignal{}, func() error {
		if w.waits("cancelled-surface") {
			t.Error("the native join was abandoned while the wait of its ticket remained")
		}
		abandons++
		return nil
	})
	w.beginFor("other-surface", 42, 1, &presentationSignal{}, nil)
	if err := w.cancelTicket(41); err != nil {
		t.Fatalf("cancel ticket 41: %v", err)
	}
	if abandons != 1 || w.waits("cancelled-surface") || !w.waits("other-surface") {
		t.Fatalf("after the cancel of ticket 41: %d abandons, cancelled waits %v, other waits %v; want 1, false, true",
			abandons, w.waits("cancelled-surface"), w.waits("other-surface"))
	}
}

// contract: view.presentation-wait.joins
// The cancel of every layout of a window removes every wait before it abandons the native join of each, so no abandon finds a
// wait that the cancel ends.
func TestAWindowCancelRemovesAllWaitsBeforeAbandoningEachNativeJoin(t *testing.T) {
	isolateTraceRecords(t)
	var w presentationWait
	abandons := 0
	for surface, ticket := range map[string]uint64{"reload-first-surface": 51, "reload-second-surface": 52} {
		w.beginFor(surface, ticket, 1, &presentationSignal{}, func() error {
			if w.waits("reload-first-surface") || w.waits("reload-second-surface") {
				t.Errorf("the native join of %s was abandoned while a wait of the cancel remained", surface)
			}
			abandons++
			return nil
		})
	}
	if err := w.cancelAll(); err != nil {
		t.Fatalf("cancel all: %v", err)
	}
	if abandons != 2 {
		t.Fatalf("the cancel of every layout abandoned %d native joins, want 2", abandons)
	}
}

// contract: view.presentation-wait.cancel-clears-ticket
// A failed abandon of a native join is reported with its layout and its view, in the text that both hosts give.
func TestAFailedAbandonOfACancelNamesItsLayoutAndItsView(t *testing.T) {
	isolateTraceRecords(t)
	refused := func() error { return errors.New("the join ended") }
	var ticket presentationWait
	ticket.beginFor("refused-surface", 41, 1, &presentationSignal{}, refused)
	if err := ticket.cancelTicket(41); err == nil || err.Error() != "abandoning presentation joins for layout 41: view refused-surface: the join ended" {
		t.Fatalf("the cancel of ticket 41 answered %v", err)
	}
	var window presentationWait
	window.beginFor("refused-surface", 51, 1, &presentationSignal{}, refused)
	if err := window.cancelAll(); err == nil || err.Error() != "abandoning presentation joins: layout 51, view refused-surface: the join ended" {
		t.Fatalf("the cancel of every layout answered %v", err)
	}
}
