package layout_test

import (
	"reflect"
	"testing"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

func everyCard(layout.Card) bool { return true }

// The cards come in the order of reading the stored tree, each with the number of cuts above it that divide the kept cards.
func TestSlicedReadsTheTreeOfCuts(t *testing.T) {
	size := 300.0
	grid, err := layout.New(&layout.State{Root: &layout.Node{Cut: "y", Kids: []layout.Kid{
		{Share: 0.5, Node: &layout.Node{Cut: "x", Kids: []layout.Kid{{Share: 0.5, Node: &layout.Node{Card: "a"}}, {Share: 0.5, Node: &layout.Node{Card: "b"}}}}},
		{Share: 0.5, Node: &layout.Node{Card: "c"}},
	}}}, layout.Options{Width: &size, Height: &size})
	if err != nil {
		t.Fatal(err)
	}
	got := grid.Sliced(everyCard)
	want := []layout.SlicedCard{{ID: "a", Cuts: 2}, {ID: "b", Cuts: 2}, {ID: "c", Cuts: 1}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("the order is %v, want %v", got, want)
	}
	alone := grid.Sliced(func(card layout.Card) bool { return card.ID == "c" })
	if !reflect.DeepEqual(alone, []layout.SlicedCard{{ID: "c"}}) {
		t.Fatalf("the kept card is %v", alone)
	}
}
