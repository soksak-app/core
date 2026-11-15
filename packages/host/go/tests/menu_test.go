package host_test

import (
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// TestUndoAndRedoKeepTheFrameworkTitle checks that the undo and redo items of the application menu are system items of the
// contract table: AppKit sets the title of an item with the undo: or redo: action from the undo manager when it validates the
// menu, so the host gives them no title and no shortcut and the framework role provides both (docs/spec/host-contract.md#application-menu).
// contract: menu.application.edit-undo-and-redo-are-framework-items
func TestUndoAndRedoKeepTheFrameworkTitle(t *testing.T) {
	for _, language := range []string{"ko", "en"} {
		menus, err := host.ApplicationMenuFor(language)
		if err != nil {
			t.Fatalf("the %s menu was not built: %v", language, err)
		}
		found := map[string]bool{}
		for _, menu := range menus {
			for _, item := range menu.Items {
				if item.Role != "undo" && item.Role != "redo" {
					continue
				}
				found[item.Role] = true
				if item.Title != "" || item.Key != "" {
					t.Errorf("the %s item %s has the title %q and the key %q instead of those of the framework", language, item.Role, item.Title, item.Key)
				}
			}
		}
		if !found["undo"] || !found["redo"] {
			t.Errorf("the %s menu lacks an undo or redo item: %v", language, found)
		}
	}
}
