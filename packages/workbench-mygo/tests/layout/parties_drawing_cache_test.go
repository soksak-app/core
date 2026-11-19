// The drawings of the parties are computed once for each change of their inputs: the presented rectangles of the party cards, the
// gap, and the parties. Every frame draws the parties, so a frame that follows no change reads the drawings that the last change
// computed (docs/spec/parties.md#drawing).
package layout_test

import (
	"reflect"
	"testing"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// drawingGrid returns a grid of three cards in a row, with a party of the first two cards led by the first.
func drawingGrid(t *testing.T) (*layout.Grid, *layout.Parties) {
	t.Helper()
	state := layout.State{
		Xs: []float64{0, 400, 800, 1200},
		Ys: []float64{0, 400},
		Cards: []layout.Card{
			{ID: "a", C0: 0, C1: 1, R0: 0, R1: 1},
			{ID: "b", C0: 1, C1: 2, R0: 0, R1: 1},
			{ID: "c", C0: 2, C1: 3, R0: 0, R1: 1},
		},
	}
	grid, err := layout.New(&state, layout.DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	grid.Resize(1200, 400)
	parties := layout.NewParties(shownPalette(t), 2)
	if _, err := parties.Run(grid, "core.party.create", []byte(`{"cards":["a","b"],"leader":"a"}`)); err != nil {
		t.Fatal(err)
	}
	return grid, parties
}

// drawingsOf returns the drawings of the parties of grid and fails the test on an error.
func drawingsOf(t *testing.T, grid *layout.Grid, parties *layout.Parties) []layout.Drawing {
	t.Helper()
	drawings, err := parties.Drawings(grid)
	if err != nil {
		t.Fatal(err)
	}
	if len(drawings) != 1 || len(drawings[0].Outline.Loops) == 0 || len(drawings[0].Outline.Loops[0]) == 0 {
		t.Fatalf("the drawings are %+v", drawings)
	}
	return drawings
}

// sameComputation tells whether two drawings hold the outline of one computation.
func sameComputation(a, b []layout.Drawing) bool {
	return &a[0].Outline.Loops[0][0] == &b[0].Outline.Loops[0][0]
}

// contract: workbench.parties.drawing
func TestPartyDrawingsAreComputedOncePerChange(t *testing.T) {
	grid, parties := drawingGrid(t)
	first := drawingsOf(t, grid, parties)
	for frame := 1; frame < 5; frame++ {
		if next := drawingsOf(t, grid, parties); !sameComputation(first, next) {
			t.Fatalf("frame %d without a change computed the party drawings again", frame)
		}
	}
	for _, change := range []struct {
		name  string
		apply func()
	}{
		{"a boundary move", func() {
			from := grid.BoundaryPos("x", 1)
			if reached := grid.MoveBoundary("x", 1, from+20, false); reached == from {
				t.Fatalf("the boundary stays at %v", from)
			}
		}},
		{"a resize", func() { grid.Resize(1500, 600) }},
		{"a gap change", func() { grid.SetGap(grid.Gap() + 4) }},
		{"a party color change", func() {
			if _, err := parties.Run(grid, "core.party.update", []byte(`{"party":"p1","color":"#123456"}`)); err != nil {
				t.Fatal(err)
			}
		}},
		{"a party member change", func() {
			if _, err := parties.Run(grid, "core.party.add", []byte(`{"party":"p1","card":"c"}`)); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		before := drawingsOf(t, grid, parties)
		change.apply()
		after := drawingsOf(t, grid, parties)
		if sameComputation(before, after) {
			t.Fatalf("after %s the party drawings were not computed again", change.name)
		}
		fresh := layout.NewParties(shownPalette(t), 2)
		if err := fresh.Restore(grid, parties.Stored()); err != nil {
			t.Fatal(err)
		}
		if want := drawingsOf(t, grid, fresh); !reflect.DeepEqual(after, want) {
			t.Fatalf("after %s the party drawings are %+v, want %+v", change.name, after, want)
		}
		if again := drawingsOf(t, grid, parties); !sameComputation(after, again) {
			t.Fatalf("after %s a frame without a change computed the party drawings again", change.name)
		}
	}
}
