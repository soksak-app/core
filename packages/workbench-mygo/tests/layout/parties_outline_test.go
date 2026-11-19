// The outer outline of a party is the outline of the presented rectangles of its cards: adjacent cards join at half the gap, and the
// outline is inset by half the border width, which is the rail width of the declaration. The Go party model returns the same loops
// that the outline function of the layout returns for those rectangles.
package layout_test

import (
	"reflect"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// contract: workbench.parties.drawing
func TestPartyOutlineIsTheOutlineOfItsCardRects(t *testing.T) {
	state := layout.State{
		Xs: []float64{0, 100, 200},
		Ys: []float64{0, 100},
		Cards: []layout.Card{
			{ID: "a", C0: 0, C1: 1, R0: 0, R1: 1},
			{ID: "b", C0: 1, C1: 2, R0: 0, R1: 1},
		},
	}
	gap := 8.0
	options := layout.DefaultOptions()
	options.Gap = &gap
	grid, err := layout.New(&state, options)
	if err != nil {
		t.Fatal(err)
	}
	declared, err := workbench.ReadDeclarations()
	if err != nil {
		t.Fatal(err)
	}
	border := declared.ChromeNumber("theme-rail-w", "px")
	parties := layout.NewParties(shownPalette(t))
	if _, err := parties.Run(grid, "core.party.create", []byte(`{"cards":["a","b"]}`)); err != nil {
		t.Fatal(err)
	}
	got, err := parties.Outline(grid, "p1", border)
	if err != nil {
		t.Fatal(err)
	}
	rects := []layout.Rect{}
	for _, id := range []string{"a", "b"} {
		rect, ok := grid.Rect(id)
		if !ok {
			t.Fatalf("card %s has no rect", id)
		}
		rects = append(rects, rect)
	}
	pad, inset := gap/2, border/2
	want := layout.ComputeOutline(rects, layout.OutlineOptions{Pad: &pad, Inset: &inset}).Loops
	// Two touching cards join into one loop, so the outline is not empty and not two loops.
	if len(got) != 1 {
		t.Fatalf("party outline has %d loops, want one loop for two touching cards", len(got))
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("party outline %v, want the outline of the card rects %v", got, want)
	}
}
