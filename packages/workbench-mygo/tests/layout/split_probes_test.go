package layout_test

import (
	"encoding/json"
	"testing"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The answers of CanSplit hold until the arrangement or the size of the plane changes: the workbench sizes the plane in each frame,
// and a frame at the same size asks again without a trial split of each card.
func TestAResizeToTheSameSizeKeepsTheAnswersOfCanSplit(t *testing.T) {
	size := 300.0
	grid, err := layout.New(&layout.State{Root: &layout.Node{Cut: "x", Kids: []layout.Kid{
		{Share: 0.5, Node: &layout.Node{Card: "a"}}, {Share: 0.5, Node: &layout.Node{Card: "b"}},
	}}}, layout.Options{Width: &size, Height: &size})
	if err != nil {
		t.Fatal(err)
	}
	ask := func() {
		for _, id := range []string{"a", "b"} {
			for _, axis := range []layout.Axis{"x", "y"} {
				grid.CanSplit(id, axis)
			}
		}
	}
	ask()
	first := grid.Probes()
	if first == 0 {
		t.Fatal("CanSplit answered without a trial split")
	}
	grid.Resize(grid.Width(), grid.Height())
	ask()
	if got := grid.Probes(); got != first {
		t.Fatalf("after a resize to the same size CanSplit ran %d trial splits, want none", got-first)
	}
	grid.Resize(grid.Width()-100, grid.Height())
	ask()
	if got := grid.Probes(); got == first {
		t.Fatal("after a resize to another size CanSplit kept its answers")
	}
}

// The answers of CanSplit, CanGroup and CanClose of a space with groups hold until the layout changes: the workbench asks them for
// every card header in each draw, and a draw without a layout change, as on a pointer move, runs no trial operation and builds no
// layout token (F937-10-1).
func TestTheHeaderAnswersOfAGroupTreeHoldUntilTheLayoutChanges(t *testing.T) {
	gap, minimum, width, height := 12.0, 96.0, 1400.0, 900.0
	grid, err := layout.New(nil, layout.Options{Gap: &gap, MinSize: &minimum, Width: &width, Height: &height})
	if err != nil {
		t.Fatal(err)
	}
	state := layout.State{Root: &layout.Node{Card: "card-1"}}
	tree, err := layout.ReadTree(state, nil, json.RawMessage(`"card-1"`), json.RawMessage(`1`),
		layout.GroupOptions{Head: 32}, grid)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := tree.CreateGroup("card-1", "right", nil); err != nil {
		t.Fatal(err)
	}
	ask := func() {
		for _, id := range tree.Cards() {
			tree.CanSplit(id, "right")
			tree.CanSplit(id, "bottom")
			tree.CanGroup(id, "right")
			tree.CanGroup(id, "bottom")
			tree.CanClose(id)
		}
	}
	ask()
	first := tree.Probes()
	if first == 0 {
		t.Fatal("the header answers ran no trial operation")
	}
	tokens := tree.Tokens()
	ask()
	if got := tree.Probes(); got != first {
		t.Fatalf("a second draw without a layout change ran %d trial operations, want none", got-first)
	}
	if got := tree.Tokens(); got != tokens {
		t.Fatalf("a second draw without a layout change built %d layout tokens, want none", got-tokens)
	}
	if _, err := tree.Split("card-1", "bottom", nil); err != nil {
		t.Fatal(err)
	}
	ask()
	if got := tree.Probes(); got == first {
		t.Fatal("after a split the header answers were kept")
	}
	if got := tree.Tokens(); got == tokens {
		t.Fatal("after a split the header answers built no layout token")
	}
	grid.Resize(width-200, height)
	moved := tree.Probes()
	ask()
	if got := tree.Probes(); got == moved {
		t.Fatal("after a resize of the plane the header answers were kept")
	}
}
