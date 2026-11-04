package workbench_test

import (
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// keyed returns the element of the frame with the element name, as the element tree of U4 gives it.
func keyed(nodes []ui.ElementNode, name workbench.ElementName) (ui.ElementNode, bool) {
	for _, node := range nodes {
		if node.Key == name {
			return node, true
		}
		if found, ok := keyed(node.Children, name); ok {
			return found, true
		}
	}
	return ui.ElementNode{}, false
}

// element fails the test when the frame has no element with the name.
func element(t *testing.T, tt *ui.Tester, name string, index int) ui.ElementNode {
	t.Helper()
	node, ok := keyed(tt.ElementTree(), workbench.ElementName{Name: name, Index: index})
	if !ok {
		t.Fatalf("no element %s %d; the texts are %q", name, index, tt.Texts())
	}
	return node
}

// press clicks the middle of the element with the name.
func press(t *testing.T, tt *ui.Tester, name string, index int) {
	t.Helper()
	node := element(t, tt, name, index)
	tt.ClickAt(node.Bounds.X+node.Bounds.W/2, node.Bounds.Y+node.Bounds.H/2)
}

// call is a command that a screen ran.
type call struct {
	name   string
	params map[string]any
}

// recorder returns a RunCommand that keeps each command in calls.
func recorder(calls *[]call) workbench.RunCommand {
	return func(name string, params map[string]any) { *calls = append(*calls, call{name, params}) }
}
