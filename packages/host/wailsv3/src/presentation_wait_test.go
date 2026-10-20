package host

import "testing"

// contract: view.presentation-wait.ends
// A view joins the presentation wait once per change: a second join of a waiting view does not join again.
func TestAViewJoinsThePresentationWaitOncePerChange(t *testing.T) {
	var w presentationWait
	if !w.begin("probe-surface") {
		t.Fatalf("the first join of the view does not join the wait")
	}
	if w.begin("probe-surface") {
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
		w.begin("probe-surface")
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
// A presentation of the view ends its wait without the abandoned event, and an end that is not a reason of the wait is refused.
func TestPresentationEndsTheWaitWithoutAnAbandonedEvent(t *testing.T) {
	isolateTraceRecords(t)
	var w presentationWait
	w.begin("probe-surface")
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
