package layout_test

import (
	"testing"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// treeValue is node in the form of the cases: a split is {direction, size, children} and a card is {card, size}.
func treeValue(node *layout.TreeNode) any {
	if node == nil {
		return nil
	}
	if node.Direction == "" {
		return map[string]any{"card": node.Card, "size": node.Size}
	}
	children := make([]any, len(node.Children))
	for i := range node.Children {
		children[i] = treeValue(&node.Children[i])
	}
	return map[string]any{"direction": node.Direction, "size": node.Size, "children": children}
}

// contract: layout.tree.one-tree-per-arrangement
func TestTheTreeOfEachArrangementIsTheTreeOfTheCase(t *testing.T) {
	var file struct {
		Description string `json:"description"`
		Cases       []struct {
			Name   string       `json:"name"`
			Layout layout.State `json:"layout"`
			Root   any          `json:"root"`
		} `json:"cases"`
	}
	caseFile(t, "tree.json", &file)
	if len(file.Cases) == 0 {
		t.Fatal("tree.json holds no case")
	}
	for _, c := range file.Cases {
		t.Run(c.Name, func(t *testing.T) {
			root, err := layout.Tree(c.Layout)
			if err != nil {
				t.Fatal(err)
			}
			if err := same(decoded(t, treeValue(root)), c.Root, "root"); err != nil {
				t.Fatal(err)
			}
		})
	}
}
