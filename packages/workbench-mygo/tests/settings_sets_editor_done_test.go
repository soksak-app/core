package workbench_test

import "testing"

// TestTheEditorOfASetHasNoDoneButton checks that the row of an edited set shows 완료 once and the editor has no 완료 button
// (design settings-renew.html, function setEditor and renderSets; docs/spec/settings.md#stored-sets-and-links).
func TestTheEditorOfASetHasNoDoneButton(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]any{"page": "sets"})
	f.click("core.settings-tab.create", "")
	status := f.modal()
	if status.Editing == nil || *status.Editing != "set-2" {
		t.Fatalf("the new set is not edited: %+v", status)
	}
	if got := status.labelsWithKeyPrefix("core.settings-tab.edit", "done:set-2"); len(got) != 1 {
		t.Fatalf("the edited set shows the buttons 완료 %d times, want once in its row only: %q", len(got), got)
	}
}
