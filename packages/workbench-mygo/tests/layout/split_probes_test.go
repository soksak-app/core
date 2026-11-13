package layout_test

import (
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
