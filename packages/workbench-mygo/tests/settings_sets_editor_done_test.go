package workbench_test

import "testing"

// TestTheEditorOfASetEndsWithItsDoneButton checks that the row of an edited set and the editor both show the button 완료
// (docs/spec/settings.md#stored-sets-and-links).
func TestTheEditorOfASetEndsWithItsDoneButton(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]any{"page": "sets"})
	f.click("core.settings-tab.create", "")
	status := f.modal()
	if status.Editing == nil || *status.Editing != "set-2" {
		t.Fatalf("the new set is not edited: %+v", status)
	}
	// One 완료 is the row of the edited set and one is the editor, which ends the editor (docs/spec/settings.md#stored-sets-and-links).
	if got := status.labelsWithKeyPrefix("core.settings-tab.edit", "done:set-2"); len(got) != 2 {
		t.Fatalf("the edited set shows the button 완료 %d times, want 2 (its row and its editor): %q", len(got), got)
	}
}
