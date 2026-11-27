package workbench_test

import (
	"math"
	"testing"

	"github.com/egoist/mygo/ui"
)

// setupRowTextNode returns the first element of the tree whose label is the text, found at any depth.
func setupRowTextNode(nodes []ui.ElementNode, label string) (ui.ElementNode, bool) {
	for _, node := range nodes {
		if node.Label == label {
			return node, true
		}
		if found, ok := setupRowTextNode(node.Children, label); ok {
			return found, true
		}
	}
	return ui.ElementNode{}, false
}

// A setup row keeps its name in the label area and its state and file in the control column, which starts 260 points before the end of
// the row, as the rows of the other groups do (docs/spec/settings.md#rows).
func TestTheSetupRowKeepsItsStateInTheControlColumn(t *testing.T) {
	host := &setupHost{states: []setupAnswer{{parts: setupMissing}}}
	f := setupShell(t, host)
	f.click("core.chrome.settings", "")
	f.run("core.settings-tab.nav", map[string]any{"page": "agents"})
	f.tester.SetSize(1200, 3200)
	f.settle()
	nodes := f.tester.ElementTree()
	keys := f.modal().keys("core.settings-tab.setup")
	if len(keys) == 0 {
		t.Fatal("the agent group has no setup row")
	}
	row, ok := exposedNode(nodes, "core.settings-tab.setup", keys[0])
	if !ok {
		t.Fatalf("no setup row %q", keys[0])
	}
	const file = "/Users/person/.local/bin/sok"
	caption, ok := setupRowTextNode(nodes, file)
	if !ok {
		t.Fatalf("the file %q of the row is not in the tree", file)
	}
	want := row.Bounds.X + row.Bounds.W - 260
	if math.Abs(float64(caption.Bounds.X-want)) > 0.5 {
		t.Fatalf("the file caption starts at x %v, the control column of the row at %v (row %+v)", caption.Bounds.X, want, row.Bounds)
	}
}
