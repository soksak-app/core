//go:build diagnostics

package host

import (
	"strings"
	"testing"
)

// The override is set by diagnostics.motion, published with the motion event, and cleared by null.
func TestDiagnosticMotionSetsTheOverrideAndPublishesIt(t *testing.T) {
	e, s, window := heldEndpoint(t)
	conn := endpointConnection(t)
	if err := call(t, e, conn, "diagnostics.motion", `{"window":"window-a","reduce":true}`); err != nil {
		t.Fatal(err)
	}
	if got := s.ReduceMotion(); got == nil || !*got {
		t.Fatalf("the override after reduce true is %v, want true", got)
	}
	window.mu.Lock()
	last := window.events[len(window.events)-1]
	window.mu.Unlock()
	if last.name != "motion" {
		t.Fatalf("the last event is %q, want motion", last.name)
	}
	if payload := last.data[0].(map[string]any); payload["reduce"] == nil || !*payload["reduce"].(*bool) {
		t.Fatalf("the motion event carries %v, want reduce true", payload)
	}
	if err := call(t, e, conn, "diagnostics.motion", `{"window":"window-a","reduce":null}`); err != nil {
		t.Fatal(err)
	}
	if got := s.ReduceMotion(); got != nil {
		t.Fatalf("the override after reduce null is %v, want the platform value", *got)
	}
}

// A value that is not a boolean or null is refused, and the override does not change.
func TestDiagnosticMotionRefusesAnyOtherValue(t *testing.T) {
	e, s, _ := heldEndpoint(t)
	conn := endpointConnection(t)
	for _, params := range []string{
		`{"window":"window-a","reduce":"yes"}`,
		`{"window":"window-a","reduce":1}`,
		`{"window":"window-a"}`,
	} {
		err := call(t, e, conn, "diagnostics.motion", params)
		if err == nil || !strings.Contains(err.Error(), "reduce must be a boolean or null") {
			t.Fatalf("%s: got error %v, want reduce must be a boolean or null", params, err)
		}
	}
	if got := s.ReduceMotion(); got != nil {
		t.Fatalf("a refused request set the override to %v", *got)
	}
}
