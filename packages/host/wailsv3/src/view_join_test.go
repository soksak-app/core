package host

import (
	"testing"
	"unsafe"
)

// contract: view.presentation-wait.joins
// A shown view joins the open transaction once, and its presentation ends the wait without an abandon.
func TestAShownViewJoinsTheOpenTransactionOnce(t *testing.T) {
	s, fake, _ := newLifecycleSurfaces(t, &fakeClock{})
	window := unsafe.Pointer(new(int))
	shown := []Placement{{ID: "probe-surface", Visible: true}}
	if err := s.joinShownViews(window, 7, shown); err != nil {
		t.Fatalf("join: %v", err)
	}
	if len(fake.joins) != 1 {
		t.Fatalf("the shown view joined %d transactions, want 1", len(fake.joins))
	}
	if fake.joins[0].ticket != 7 || fake.joins[0].window != window {
		t.Fatalf("the join has ticket %d and window %p, want 7 and the window of the layout", fake.joins[0].ticket, fake.joins[0].window)
	}
	if err := s.joinShownViews(window, 7, shown); err != nil {
		t.Fatalf("second join: %v", err)
	}
	if len(fake.joins) != 1 {
		t.Fatalf("a view that waits joined again: %d joins", len(fake.joins))
	}
	fake.joins[0].presented()
	if s.presentation.waits("probe-surface") {
		t.Fatalf("the presentation did not end the wait")
	}
	if fake.joins[0].abandons != 0 {
		t.Fatalf("the presentation abandoned the native join")
	}
	if err := s.joinShownViews(window, 8, shown); err != nil {
		t.Fatalf("join after presentation: %v", err)
	}
	if len(fake.joins) != 2 {
		t.Fatalf("the view joined %d transactions after its presentation, want 2", len(fake.joins))
	}
}

// contract: view.presentation-wait.joins
// Each end without presentation abandons the native join of the view once: the process end, the hidden view and the unresponsive notice.
func TestEachEndWithoutPresentationAbandonsTheViewJoin(t *testing.T) {
	shown := []Placement{{ID: "probe-surface", Visible: true}}
	window := unsafe.Pointer(new(int))
	for _, reason := range []string{"process-ended", "hidden", "unresponsive"} {
		t.Run(reason, func(t *testing.T) {
			isolateTraceRecords(t)
			s, fake, native := newLifecycleSurfaces(t, &fakeClock{})
			s.views = map[string]*nativeWebview{"probe-surface": {}}
			events := recordWindowEvents(s)
			if err := s.joinShownViews(window, 7, shown); err != nil {
				t.Fatalf("join: %v", err)
			}
			if len(fake.joins) != 1 {
				t.Fatalf("the shown view joined %d transactions, want 1", len(fake.joins))
			}
			switch reason {
			case "process-ended":
				endView(t, s, fake)
			case "hidden":
				if err := s.syncView("probe-surface", native, "probe", "ui/page.html", false); err != nil {
					t.Fatalf("hide the view: %v", err)
				}
			case "unresponsive":
				s.viewResponsiveness("probe-surface", "probe", false)
			}
			if fake.joins[0].abandons != 1 {
				t.Fatalf("the %s end abandoned the native join %d times, want 1", reason, fake.joins[0].abandons)
			}
			if s.presentation.waits("probe-surface") {
				t.Fatalf("the %s end left the view waiting", reason)
			}
			var abandoned []map[string]any
			for _, event := range *events {
				if event.name == "view-presentation-abandoned" {
					data, _ := event.data.(map[string]any)
					abandoned = append(abandoned, data)
				}
			}
			if len(abandoned) != 1 {
				t.Fatalf("the %s end sent %d view-presentation-abandoned notices, want 1: %v", reason, len(abandoned), *events)
			}
			if abandoned[0]["surface"] != "probe-surface" || abandoned[0]["reason"] != reason {
				t.Fatalf("the %s notice carries %v, want its surface and reason", reason, abandoned[0])
			}
		})
	}
}
