package layout_test

import (
	"reflect"
	"testing"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

func slicedGrid(t *testing.T, cards []layout.Card, lines int) *layout.Grid {
	t.Helper()
	size := 300.0
	edges := make([]float64, lines)
	for index := range edges {
		edges[index] = float64(index) * size / float64(lines-1)
	}
	state := layout.State{Xs: edges, Ys: append([]float64{}, edges...), Cards: cards}
	grid, err := layout.New(&state, layout.Options{Width: &size, Height: &size})
	if err != nil {
		t.Fatal(err)
	}
	return grid
}

func everyCard(layout.Card) bool { return true }

// The cards come in the order of reading the tree of cuts, each with the number of cuts above it.
func TestSlicedReadsTheTreeOfCuts(t *testing.T) {
	grid := slicedGrid(t, []layout.Card{
		{ID: "a", C0: 0, C1: 1, R0: 0, R1: 1},
		{ID: "b", C0: 1, C1: 2, R0: 0, R1: 1},
		{ID: "c", C0: 0, C1: 2, R0: 1, R1: 2},
	}, 3)
	got, ok := grid.Sliced(everyCard)
	want := []layout.SlicedCard{{ID: "a", Cuts: 2}, {ID: "b", Cuts: 2}, {ID: "c", Cuts: 1}}
	if !ok || !reflect.DeepEqual(got, want) {
		t.Fatalf("the order is %v (%v), want %v", got, ok, want)
	}
	alone, ok := grid.Sliced(func(card layout.Card) bool { return card.ID == "c" })
	if !ok || !reflect.DeepEqual(alone, []layout.SlicedCard{{ID: "c"}}) {
		t.Fatalf("the kept card is %v (%v)", alone, ok)
	}
}

// A pinwheel has no cut that divides it, so it has no order.
func TestSlicedRefusesAPinwheel(t *testing.T) {
	grid := slicedGrid(t, []layout.Card{
		{ID: "a", C0: 0, C1: 2, R0: 0, R1: 1},
		{ID: "b", C0: 2, C1: 3, R0: 0, R1: 2},
		{ID: "c", C0: 1, C1: 3, R0: 2, R1: 3},
		{ID: "d", C0: 0, C1: 1, R0: 1, R1: 3},
		{ID: "e", C0: 1, C1: 2, R0: 1, R1: 2},
	}, 4)
	if order, ok := grid.Sliced(everyCard); ok {
		t.Fatalf("a pinwheel has the order %v", order)
	}
}
