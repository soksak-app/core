package workbench_test

import (
	"testing"

	"github.com/egoist/mygo/ui"
	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// The menu of the settings tab follows the menu of the settings design (docs/spec/settings.md#menu): it starts at the top of the tab with
// the search field, then the group labels and the items, 204 points wide with items 30 points high, and no two of them overlap.
func TestTheSettingsMenuFollowsTheDesign(t *testing.T) {
	f, _, _ := twoProjects(t)
	f.run("core.settings.open", nil)
	tree := f.tester.ElementTree()
	tab, ok := exposedNode(tree, "core.settings-tab", "")
	if !ok {
		t.Fatal("the settings tab is not drawn")
	}
	find, ok := exposedNode(tree, "core.settings-tab.find", "")
	if !ok {
		t.Fatal("the menu has no search field")
	}
	if find.Bounds.Y != tab.Bounds.Y+10 || find.Bounds.X != tab.Bounds.X+8 {
		t.Fatalf("the search field stands at %v in the tab %v, want the menu padding 8 by 10 from the top left of the tab", find.Bounds, tab.Bounds)
	}
	if find.Bounds.H != 28 {
		t.Fatalf("the search field is %.2f high, want 28", find.Bounds.H)
	}
	var column []ui.ElementNode
	labels := map[string]bool{}
	var walk func(nodes []ui.ElementNode)
	walk = func(nodes []ui.ElementNode) {
		for _, node := range nodes {
			if node.Bounds.X < tab.Bounds.X+204 && node.Bounds.Y >= tab.Bounds.Y {
				if key, ok := node.Key.(workbench.Exposed); ok && (key.Name == "core.settings-tab.nav" || key.Name == "core.settings-tab.find") {
					column = append(column, node)
				} else if node.Role == ui.RoleText && (node.Text == "설정" || node.Text == "플러그인") {
					labels[node.Text] = true
					column = append(column, node)
				}
			}
			walk(node.Children)
		}
	}
	walk(tree)
	if !labels["설정"] || !labels["플러그인"] {
		t.Fatalf("the menu has the group labels %v, want 설정 and 플러그인", labels)
	}
	for _, node := range column {
		if key, ok := node.Key.(workbench.Exposed); ok && key.Name == "core.settings-tab.nav" {
			// The menu is 204 wide with the padding 8 at each side and the border 1 at its right, as the grid column of the web tab.
			if node.Bounds.H != 30 || node.Bounds.W != 204-16-1 {
				t.Fatalf("the item %q is %.2f×%.2f, want 187×30", node.Label, node.Bounds.W, node.Bounds.H)
			}
		}
	}
	for i := 1; i < len(column); i++ {
		above, below := column[i-1].Bounds, column[i].Bounds
		if below.Y < above.Y+above.H {
			t.Fatalf("%q at %v overlaps %q at %v", column[i].Label, below, column[i-1].Label, above)
		}
	}
}
