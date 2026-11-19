package layout_test

import (
	"encoding/json"
	"testing"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The answers of CanSplit hold until the arrangement or the size of the plane changes: the workbench sizes the plane in each frame,
// and a frame at the same size asks again without a trial split of each card.
func TestAResizeToTheSameSizeKeepsTheAnswersOfCanSplit(t *testing.T) {
	grid := slicedGrid(t, []layout.Card{
		{ID: "a", C0: 0, C1: 1, R0: 0, R1: 2},
		{ID: "b", C0: 1, C1: 2, R0: 0, R1: 2},
	}, 3)
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
// every card header in each draw, and a draw without a layout change, as on a pointer move, runs no trial operation.
func TestTheHeaderAnswersOfAGroupTreeHoldUntilTheLayoutChanges(t *testing.T) {
	gap, minimum, width, height := 12.0, 96.0, 1400.0, 900.0
	grid, err := layout.New(nil, layout.Options{Gap: &gap, MinSize: &minimum, Width: &width, Height: &height})
	if err != nil {
		t.Fatal(err)
	}
	state := layout.State{Xs: []float64{0, 1}, Ys: []float64{0, 1}, Cards: []layout.Card{{ID: "card-1", C0: 0, C1: 1, R0: 0, R1: 1}},
		PaidBy: map[string]layout.Paid{}}
	tree, err := layout.ReadTree(state, json.RawMessage(`[]`), json.RawMessage(`"card-1"`), json.RawMessage(`1`),
		layout.GroupOptions{Head: 32}, grid)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := tree.CreateGroup("card-1", "right", nil, false); err != nil {
		t.Fatal(err)
	}
	ask := func() {
		for _, id := range tree.Cards() {
			tree.CanSplit(id, "right")
			tree.CanSplit(id, "bottom")
			tree.CanGroup(id)
			tree.CanClose(id)
		}
	}
	ask()
	first := tree.Probes()
	if first == 0 {
		t.Fatal("the header answers ran no trial operation")
	}
	ask()
	if got := tree.Probes(); got != first {
		t.Fatalf("a second draw without a layout change ran %d trial operations, want none", got-first)
	}
	if _, err := tree.Split("card-1", "bottom", nil, false); err != nil {
		t.Fatal(err)
	}
	ask()
	if got := tree.Probes(); got == first {
		t.Fatal("after a split the header answers were kept")
	}
	grid.Resize(width-200, height)
	moved := tree.Probes()
	ask()
	if got := tree.Probes(); got == moved {
		t.Fatal("after a resize of the plane the header answers were kept")
	}
}
