package host

import (
	"testing"
	"unsafe"
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
	for _, reason := range []string{"process-ended", "hidden", "unresponsive"} {
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
	if _, err := w.end("probe-surface", "timeout"); err == nil {
		t.Fatalf("an end with the reason timeout was accepted")
	}
}

// deferredUIPlatform queues EnqueueUI work until the test runs the queue, as the UI queue does when the current framework event
// callback has not ended.
type deferredUIPlatform struct {
	*lifecyclePlatform
	queued []func()
}

func (p *deferredUIPlatform) EnqueueUI(run func()) error {
	p.queued = append(p.queued, run)
	return nil
}

func (p *deferredUIPlatform) runQueued() {
	for len(p.queued) > 0 {
		run := p.queued[0]
		p.queued = p.queued[1:]
		run()
	}
}

// contract: view.presentation-wait.presented-before-end
// A presentation that completes on its native callback ends the wait as presented before a later hide: the hide ends no wait, writes
// no abandoned record and calls no native abandon, and the queued end of the presentation finds no wait.
func TestAHideAfterAPresentedCallbackEndsNoWait(t *testing.T) {
	isolateTraceRecords(t)
	s, fake, native := newLifecycleSurfaces(t, &fakeClock{})
	queue := &deferredUIPlatform{lifecyclePlatform: fake}
	saved := system
	system = queue
	t.Cleanup(func() { system = saved })
	events := recordWindowEvents(s)
	window := unsafe.Pointer(new(int))
	shown := []Placement{{ID: "probe-surface", Visible: true}}
	if err := s.joinShownViews(window, 7, shown); err != nil {
		t.Fatalf("join: %v", err)
	}
	if len(fake.joins) != 1 {
		t.Fatalf("the shown view joined %d transactions, want 1", len(fake.joins))
	}
	fake.joins[0].presented()
	if err := s.syncView("probe-surface", native, "probe", "ui/page.html", false, nullOriginStart()); err != nil {
		t.Fatalf("hide the view: %v", err)
	}
	queue.runQueued()
	if got := bufferedTraces(t, "host.trace.view.presentation-abandoned"); len(got) != 0 {
		t.Fatalf("abandoned records after a completed presentation: %v, want none", got)
	}
	if fake.joins[0].abandons != 0 {
		t.Fatalf("the hide abandoned the native join of a completed presentation %d times", fake.joins[0].abandons)
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
