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
	dock := func(t *testing.T, order []string) *layout.Grid {
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
	if grid := dock(t, order); !layout.WindowSidebarsPlaced(grid, order) || layout.WindowSidebarsPlaced(grid, topFirst) {
		t.Fatal("the default dock is not the place of the default order only")
	}
	if grid := dock(t, topFirst); !layout.WindowSidebarsPlaced(grid, topFirst) || layout.WindowSidebarsPlaced(grid, order) {
		t.Fatal("the dock with top first is not the place of that order only")
	}
	grid := dock(t, order)
	if !grid.SetFixed("top", false) || layout.WindowSidebarsPlaced(grid, order) {
		t.Fatal("a top sidebar that is not fixed was accepted")
	}
}
