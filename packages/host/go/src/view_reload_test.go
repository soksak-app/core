package host

import (
	"strings"
	"testing"
	"time"
	"unsafe"
)

// contract: view.reload.restarts-once
// Reloading a ready view ends its view once, creates it once, and counts no failure, so a reload never stops the restarts.
func TestReloadingAReadyViewEndsAndCreatesItsViewOnce(t *testing.T) {
	s, views, _ := newLifecycleSurfaces(t)
	restart, err := s.reloadView("probe-surface", viewTestEpoch, closersOf(views))
	if err != nil {
		t.Fatalf("reload of a ready view: %v, want it restarted", err)
	}
	if restart == nil {
		t.Fatal("reload of a ready view returned no record to create the view from")
	}
	if len(views.closed) != 1 {
		t.Fatalf("closed documents %d after one reload, want 1", len(views.closed))
	}
	if step := views.sync(t, s, restart.native, restart.visible, restart.start); step != viewSyncCreate {
		t.Fatalf("the synchronization after the reload planned step %d, want the creation of the view", step)
	}
	if len(views.created) != 2 {
		t.Fatalf("created views %d after one reload, want 2", len(views.created))
	}
	if failures := s.viewRecords().failures["probe-surface"]; len(failures) != 0 {
		t.Fatalf("failures %v after a reload, want none counted", failures)
	}
}

// contract: view.reload.clears-stop
// A reload of a view that stopped its restarts clears the stop, so its next failure is the first one of a new count.
func TestReloadingAStoppedViewClearsItsRestartStop(t *testing.T) {
	s, views, _ := newLifecycleSurfaces(t)
	for _, offset := range []time.Duration{0, 60 * time.Second, 120 * time.Second, 180 * time.Second} {
		endView(t, s, views, viewTestEpoch.Add(offset))
	}
	if !s.viewRecords().stopped["probe-surface"] {
		t.Fatal("the view did not stop after four failures, so the reload test has no stopped view")
	}
	restart, err := s.reloadView("probe-surface", viewTestEpoch.Add(200*time.Second), closersOf(views))
	if err != nil || restart == nil {
		t.Fatalf("reload of a stopped view: record %v, error %v, want the view created again", restart, err)
	}
	if s.viewRecords().stopped["probe-surface"] {
		t.Fatal("the reload left the view stopped")
	}
	if step := views.sync(t, s, restart.native, restart.visible, restart.start); step != viewSyncCreate {
		t.Fatalf("the synchronization after the reload planned step %d, want the creation of the view", step)
	}
	if !s.viewRecords().fail("probe-surface", viewTestEpoch.Add(210*time.Second)) {
		t.Fatal("the first failure after the reload stopped the view, want it counted from zero")
	}
}

// contract: view.reload.refuses-unknown-tab
// A reload of a surface without a view record is refused, and the error names the tab.
func TestReloadingAnUnknownTabIsRefusedWithItsId(t *testing.T) {
	s, views, _ := newLifecycleSurfaces(t)
	_, err := s.reloadView("tab-unknown", viewTestEpoch, closersOf(views))
	if err == nil || !strings.Contains(err.Error(), "tab-unknown") {
		t.Fatalf("reload of an unknown tab: error %v, want a refusal that names tab-unknown", err)
	}
}

// closersOf returns the closers that record the closed documents and images of the test views.
func closersOf(views *lifecycleViews) viewClosers {
	return viewClosers{
		document: func(handle unsafe.Pointer) { views.closed = append(views.closed, handle) },
		image:    func(handle unsafe.Pointer) { views.closedImages = append(views.closedImages, handle) },
	}
}
