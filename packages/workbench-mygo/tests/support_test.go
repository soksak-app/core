package workbench_test

import (
	"encoding/json"
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// keyed returns the element of the frame with the element name and the item, as the element tree of U4 gives it.
func keyed(nodes []ui.ElementNode, name, item string) (ui.ElementNode, bool) {
	for _, node := range nodes {
		if exposed, ok := node.Key.(workbench.Exposed); ok && exposed.Name == name && exposed.Item == item {
			return node, true
		}
		if found, ok := keyed(node.Children, name, item); ok {
			return found, true
		}
	}
	return ui.ElementNode{}, false
}

// element fails the test when the frame has no element with the name and the item.
func element(t *testing.T, tt *ui.Tester, name, item string) ui.ElementNode {
	t.Helper()
	node, ok := keyed(tt.ElementTree(), name, item)
	if !ok {
		t.Fatalf("no element %s %s; the texts are %q", name, item, tt.Texts())
	}
	return node
}

// press clicks the middle of the element with the name and the item.
func press(t *testing.T, tt *ui.Tester, name, item string) {
	t.Helper()
	node := element(t, tt, name, item)
	tt.ClickAt(node.Bounds.X+node.Bounds.W/2, node.Bounds.Y+node.Bounds.H/2)
}

// call is a command that a screen ran.
type call struct {
	name   string
	params map[string]any
}

// recorder returns a binder whose commands keep each run in calls.
func recorder(t *testing.T, calls *[]call, commands ...string) *workbench.Binder {
	t.Helper()
	r := registry(t)
	for _, name := range commands {
		r.Command(name, func(raw json.RawMessage) (any, error) {
			var params map[string]any
			if err := json.Unmarshal(raw, &params); err != nil {
				return nil, err
			}
			*calls = append(*calls, call{name, params})
			return nil, nil
		})
	}
	return workbench.NewBinder(r, func(command string, err error) { t.Errorf("%s: %v", command, err) })
}

// sidebarCommands are the commands that the frame of a sidebar runs.
var sidebarCommands = []string{"core.sidebar.section.fold", "core.sidebar.section.select", "core.sidebar.section.size", "core.settings.set"}

// keyedAt returns the element of the frame with the positional name of a screen that has no binder yet.
func keyedAt(nodes []ui.ElementNode, name workbench.ElementName) (ui.ElementNode, bool) {
	for _, node := range nodes {
		if node.Key == name {
			return node, true
		}
		if found, ok := keyedAt(node.Children, name); ok {
			return found, true
		}
	}
	return ui.ElementNode{}, false
}

func positional(t *testing.T, tt *ui.Tester, name string, index int) ui.ElementNode {
	t.Helper()
	node, ok := keyedAt(tt.ElementTree(), workbench.ElementName{Name: name, Index: index})
	if !ok {
		t.Fatalf("no element %s %d; the texts are %q", name, index, tt.Texts())
	}
	return node
}

func pressPositional(t *testing.T, tt *ui.Tester, name string, index int) {
	t.Helper()
	node := positional(t, tt, name, index)
	tt.ClickAt(node.Bounds.X+node.Bounds.W/2, node.Bounds.Y+node.Bounds.H/2)
}

func record(calls *[]call) workbench.RunCommand {
	return func(name string, params map[string]any) { *calls = append(*calls, call{name, params}) }
}
