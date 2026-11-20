// The rectangle operations of a group card change the stored tree as tree operations, so the structure inside the group stays as it is
// stored (docs/spec/groups.md#commands).
package layout_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// columnOfRows is a group card-5 whose tree is a column of two rows with their lines at one coordinate, beside the card e. A tree laid
// again from the cells reads those lines as a row of two columns.
func columnOfRows(t *testing.T) *layout.GroupTree {
	t.Helper()
	gap, minimum, width, height := 12.0, 96.0, 1400.0, 900.0
	grid, err := layout.New(nil, layout.Options{Gap: &gap, MinSize: &minimum, Width: &width, Height: &height})
	if err != nil {
		t.Fatal(err)
	}
	var state layout.State
	if err := json.Unmarshal([]byte(`{"root":{"cut":"x","kids":[
		{"share":0.5,"node":{"box":"card-5","data":{"name":"그룹 1","leader":"card-1"},"inner":{"cut":"y","kids":[
			{"share":0.5,"node":{"cut":"x","kids":[{"share":0.5,"node":{"card":"card-1"}},{"share":0.5,"node":{"card":"card-2"}}]}},
			{"share":0.5,"node":{"cut":"x","kids":[{"share":0.5,"node":{"card":"card-3"}},{"share":0.5,"node":{"card":"card-4"}}]}}]}}},
		{"share":0.5,"node":{"card":"card-6"}}]}}`), &state); err != nil {
		t.Fatal(err)
	}
	tree, err := layout.ReadTree(state, nil, json.RawMessage(`"card-5"`), json.RawMessage(`6`), layout.GroupOptions{Head: 32}, grid)
	if err != nil {
		t.Fatal(err)
	}
	return tree
}

// shape is the tree of a node with its cuts and their kids, without shares.
func shape(n *layout.Node) string {
	switch {
	case n.Box != "":
		return n.Box + "(" + shape(n.Inner) + ")"
	case n.Card != "":
		return n.Card
	}
	kids := []string{}
	for _, kid := range n.Kids {
		kids = append(kids, shape(kid.Node))
	}
	return string(n.Cut) + "[" + strings.Join(kids, " ") + "]"
}

func TestAnAddToAGroupKeepsTheTreeInsideIt(t *testing.T) {
	tree := columnOfRows(t)
	born, err := tree.AddCard("card-5", nil)
	if err != nil {
		t.Fatal(err)
	}
	// The members stand as one cut along y, so the new card at the right edge wraps that cut with it in a cut of two halves.
	want := "x[card-5(x[y[x[card-1 card-2] x[card-3 card-4]] " + born + "]) card-6]"
	if got := shape(tree.Grid().ToJSON().Root); got != want {
		t.Fatalf("after the add the tree is %s, want %s", got, want)
	}
}

func TestASplitOfAGroupCardKeepsTheTreeInsideIt(t *testing.T) {
	tree := columnOfRows(t)
	born, err := tree.Split("card-5", "right", nil)
	if err != nil {
		t.Fatal(err)
	}
	// The new card joins the cut that holds the group card as one more kid of an even cut, and the tree inside the box stays.
	want := "x[card-5(y[x[card-1 card-2] x[card-3 card-4]]) " + born + " card-6]"
	if got := shape(tree.Grid().ToJSON().Root); got != want {
		t.Fatalf("after the split the tree is %s, want %s", got, want)
	}
}

func TestAGroupOfAGroupCardKeepsTheTreeInsideIt(t *testing.T) {
	tree := columnOfRows(t)
	group, born, err := tree.CreateGroup("card-5", "right", nil)
	if err != nil {
		t.Fatal(err)
	}
	want := "x[" + group + "(x[card-5(y[x[card-1 card-2] x[card-3 card-4]]) " + born + "]) card-6]"
	if got := shape(tree.Grid().ToJSON().Root); got != want {
		t.Fatalf("after the group the tree is %s, want %s", got, want)
	}
}
