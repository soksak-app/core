package layout_test

import (
	"testing"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// TestWindowSidebarsPlacedFollowsTheOrder checks the place of the window sidebars against the place that the order gives them
// (docs/spec/external-sidebars.md#verification).
func TestWindowSidebarsPlacedFollowsTheOrder(t *testing.T) {
	order := []string{"left", "right", "top", "bottom"}
	topFirst := []string{"top", "left", "right", "bottom"}
	arrange := func(t *testing.T, order []string) *layout.Grid {
		t.Helper()
		width, height := 1000.0, 800.0
		grid, err := layout.New(&layout.State{Xs: []float64{0, 1}, Ys: []float64{0, 1}, Cards: []layout.Card{{ID: "main", C0: 0, C1: 1, R0: 0, R1: 1}}},
			layout.Options{Width: &width, Height: &height})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := layout.ArrangeWindowSidebars(grid, order, order, map[string]layout.WindowSidebar{}, 190, func(string) bool { return true }); err != nil {
			t.Fatal(err)
		}
		return grid
	}
	if grid := arrange(t, order); !layout.WindowSidebarsPlaced(grid, order) || layout.WindowSidebarsPlaced(grid, topFirst) {
		t.Fatal("the default arrangement is not the place of the default order only")
	}
	if grid := arrange(t, topFirst); !layout.WindowSidebarsPlaced(grid, topFirst) || layout.WindowSidebarsPlaced(grid, order) {
		t.Fatal("the arrangement with top first is not the place of that order only")
	}
	grid := arrange(t, order)
	if !grid.SetFixed("top", false) || layout.WindowSidebarsPlaced(grid, order) {
		t.Fatal("a top sidebar that is not fixed was accepted")
	}
}

// TestAGridHoldsOneSidebarOfASide checks that no grid holds two cards of one side, so WindowSidebarsPlaced counts one window sidebar per
// side (docs/spec/external-sidebars.md#verification): a state with two cards of a side is refused, and an arranged grid refuses a second
// card of a side.
func TestAGridHoldsOneSidebarOfASide(t *testing.T) {
	order := []string{"left", "right", "top", "bottom"}
	width, height := 1000.0, 800.0
	options := layout.Options{Width: &width, Height: &height}
	two := map[string][2]layout.Card{
		"left":   {{ID: "left", C0: 0, C1: 1, R0: 0, R1: 3}, {ID: "left", C0: 1, C1: 2, R0: 0, R1: 3}},
		"right":  {{ID: "right", C0: 2, C1: 3, R0: 0, R1: 3}, {ID: "right", C0: 1, C1: 2, R0: 0, R1: 3}},
		"top":    {{ID: "top", C0: 0, C1: 3, R0: 0, R1: 1}, {ID: "top", C0: 0, C1: 3, R0: 1, R1: 2}},
		"bottom": {{ID: "bottom", C0: 0, C1: 3, R0: 2, R1: 3}, {ID: "bottom", C0: 0, C1: 3, R0: 1, R1: 2}},
	}
	lines := []float64{0, .2, .8, 1}
	for _, side := range order {
		cards := two[side]
		if _, err := layout.New(&layout.State{Xs: lines, Ys: lines, Cards: cards[:]}, options); err == nil || err.Error() != "soksak: two cards are called "+side {
			t.Fatalf("a state with two %s sidebars: %v", side, err)
		}
		grid, err := layout.New(&layout.State{Xs: []float64{0, 1}, Ys: []float64{0, 1}, Cards: []layout.Card{{ID: "main", C0: 0, C1: 1, R0: 0, R1: 1}}}, options)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := layout.ArrangeWindowSidebars(grid, order, order, map[string]layout.WindowSidebar{}, 190, func(string) bool { return true }); err != nil {
			t.Fatal(err)
		}
		id, size := side, 190.0
		if _, ok := grid.InsertAt(layout.WindowAxis(side), 0, layout.InsertInit{ID: &id, Size: &size}); ok {
			t.Fatalf("an arranged grid took a second %s sidebar", side)
		}
		if !layout.WindowSidebarsPlaced(grid, order) {
			t.Fatalf("the refused %s sidebar changed the arrangement", side)
		}
	}
}
