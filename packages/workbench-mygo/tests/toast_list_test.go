package workbench_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
)

// core.toasts reports the shown toasts and whether the line form shows the list of its other toasts
// (docs/spec/notifications.md#commands-and-statuses).
func TestTheToastStatusReportsTheListState(t *testing.T) {
	f := noticeShell(t, map[string]any{"toastStyle": "line"}, "first failed", "second failed")
	var state struct {
		Toasts   []json.RawMessage `json:"toasts"`
		ListOpen *bool             `json:"listOpen"`
	}
	if err := json.Unmarshal([]byte(f.status("core.toasts")), &state); err != nil || state.ListOpen == nil || *state.ListOpen || len(state.Toasts) != 2 {
		t.Fatalf("core.toasts is %s, want two toasts and listOpen false (%v)", f.status("core.toasts"), err)
	}
}

// The count of the line form runs core.toasts.list {open}, which shows the other toasts as a column under the line, and Escape closes
// that list before it closes anything else (docs/spec/notifications.md#toasts).
func TestTheLineCountRunsTheListAndEscapeClosesIt(t *testing.T) {
	f := noticeShell(t, map[string]any{"toastStyle": "line"}, "first failed", "second failed", "third failed")
	f.click("core.toasts.more", "")
	f.settle()
	if !toastListOpen(t, f) {
		t.Fatalf("the count did not open the toast list: %s", f.status("core.toasts"))
	}
	if !f.tester.HasText("first failed") || !f.tester.HasText("second failed") {
		t.Fatalf("the open list does not show the other toasts: %q", f.tester.Texts())
	}
	f.tester.Key(0, ui.KeyEscape)
	f.settle()
	if toastListOpen(t, f) {
		t.Fatal("Escape did not close the toast list")
	}
}

// core.toasts.list refuses an open that is not a boolean with -32602 and the text of the registry schema check, as the web registry
// does for a command whose params schema is not met (packages/plugin-api/index.js).
func TestTheToastListRefusesANonBooleanOpen(t *testing.T) {
	f := noticeShell(t, map[string]any{"toastStyle": "line"}, "first failed")
	err := f.finish("core.toasts.list", map[string]any{"open": "yes"})
	if err == nil || !strings.Contains(err.Error(), "invalid params for core.toasts.list") {
		t.Fatalf("core.toasts.list of a text open answered %v", err)
	}
}

// toastListOpen reads listOpen of core.toasts.
func toastListOpen(t *testing.T, f *tabShell) bool {
	t.Helper()
	var state struct {
		ListOpen bool `json:"listOpen"`
	}
	if err := json.Unmarshal([]byte(f.status("core.toasts")), &state); err != nil {
		t.Fatalf("core.toasts is %s: %v", f.status("core.toasts"), err)
	}
	return state.ListOpen
}
