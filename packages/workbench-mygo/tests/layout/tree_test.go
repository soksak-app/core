package layout_test

import (
	"encoding/json"
	"math"
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

// An arriving box keeps the shares of its inner node: a box that a withdraw took out lands with its members in their proportions
// (packages/soksak/docs/layout.md#add-and-remove).
func TestAnArrivingBoxKeepsTheSharesOfItsInnerNode(t *testing.T) {
	var state layout.State
	if err := json.Unmarshal([]byte(`{"root":{"cut":"x","kids":[
		{"share":0.5,"node":{"box":"g","inner":{"cut":"y","kids":[{"share":0.3,"node":{"card":"a"}},{"share":0.7,"node":{"card":"b"}}]}}},
		{"share":0.25,"node":{"card":"c"}},{"share":0.25,"node":{"card":"d"}}]}}`), &state); err != nil {
		t.Fatal(err)
	}
	gap, minimum, width, height := 24.0, 96.0, 1200.0, 800.0
	grid, err := layout.New(&state, layout.Options{Gap: &gap, MinSize: &minimum, Width: &width, Height: &height})
	if err != nil {
		t.Fatal(err)
	}
	// The box lands across a cut, which wraps the target, and along an even cut, which gives it 1/(k+1).
	for _, to := range []struct {
		target string
		side   layout.Side
	}{{"d", "bottom"}, {"c", "right"}} {
		left, err := grid.Withdraw("g")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := grid.Insert(layout.Target{to.target}, to.side, left); err != nil {
			t.Fatal(err)
		}
		var box func(n *layout.Node) *layout.Node
		box = func(n *layout.Node) *layout.Node {
			if n.Box == "g" {
				return n
			}
			for _, kid := range n.Kids {
				if found := box(kid.Node); found != nil {
					return found
				}
			}
			return nil
		}
		stored := grid.ToJSON()
		g := box(stored.Root)
		if g == nil || len(g.Inner.Kids) != 2 || math.Abs(g.Inner.Kids[0].Share-0.3) > 1e-9 {
			raw, _ := json.Marshal(stored) // silent: the state is plain data.
			t.Fatalf("beside %s the box is stored in %s, not with the shares 0.3 and 0.7", to.target, raw)
		}
	}
}

// setHeads names the head that is not a finite number from zero with the text of its value.
func TestSetHeadsNamesTheHeadItRefuses(t *testing.T) {
	var state layout.State
	if err := json.Unmarshal([]byte(`{"root":{"cut":"x","kids":[
		{"share":0.5,"node":{"box":"g","inner":{"cut":"y","kids":[{"share":0.5,"node":{"card":"a"}},{"share":0.5,"node":{"card":"b"}}]}}},
		{"share":0.5,"node":{"card":"c"}}]}}`), &state); err != nil {
		t.Fatal(err)
	}
	grid, err := layout.New(&state, layout.Options{})
	if err != nil {
		t.Fatal(err)
	}
	for px, want := range map[float64]string{-1: `soksak: the head of "g" is -1`, math.Inf(1): `soksak: the head of "g" is Infinity`} {
		if err := grid.SetHeads(map[string]float64{"g": px}); err == nil || err.Error() != want {
			t.Fatalf("setHeads of %v throws %v, not %q", px, err, want)
		}
	}
}

// An id that the grid issues names no node of the tree: a box takes an id of the same form as a card, so an issued id that only skips
// the cards gave a new card the id of a box, and the tree held two nodes of one id.
func TestAnIssuedIDNamesNoBox(t *testing.T) {
	var state layout.State
	if err := json.Unmarshal([]byte(`{"root":{"cut":"x","kids":[
		{"share":0.5,"node":{"box":"card-1","inner":{"cut":"y","kids":[{"share":0.5,"node":{"card":"a"}},{"share":0.5,"node":{"card":"b"}}]}}},
		{"share":0.5,"node":{"card":"c"}}]}}`), &state); err != nil {
		t.Fatal(err)
	}
	width, height := 1000.0, 600.0
	grid, err := layout.New(&state, layout.Options{Width: &width, Height: &height})
	if err != nil {
		t.Fatal(err)
	}
	size := 200.0
	id, ok := grid.InsertAt("x", 0, layout.InsertInit{Size: &size})
	if !ok {
		t.Fatal("insertAt at the left edge is refused")
	}
	if id == "card-1" {
		t.Fatalf("insertAt issued %s, the id of a box", id)
	}
	if err := layout.CheckState(grid.ToJSON()); err != nil {
		t.Fatalf("the state after insertAt is refused: %s", err)
	}
}
