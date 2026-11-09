package layout_test

import (
	"fmt"
	"strings"
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

// TestASidebarWithoutRoomDocksAtTheLargestFittingSize checks that a sidebar whose saved size leaves the content cards no room docks at
// the largest size that the plane holds (docs/spec/external-sidebars.md#fixed-placement-and-persistence): the layout refuses an
// insertion that takes a card below its minimum, and a missing sidebar or a refused arrangement is not that contract.
func TestASidebarWithoutRoomDocksAtTheLargestFittingSize(t *testing.T) {
	order := []string{"left", "right", "top", "bottom"}
	width, height := 1000.0, 800.0
	grid, err := layout.New(&layout.State{
		Xs: []float64{0, 0.5, 1},
		Ys: []float64{0, 0.25, 0.5, 0.75, 1},
		Cards: []layout.Card{
			{ID: "main", C0: 0, C1: 1, R0: 0, R1: 1},
			{ID: "second", C0: 0, C1: 1, R0: 2, R1: 3},
			{ID: "third", C0: 0, C1: 2, R0: 1, R1: 2},
			{ID: "fourth", C0: 1, C1: 2, R0: 2, R1: 3},
			{ID: "fifth", C0: 1, C1: 2, R0: 0, R1: 1},
		},
	}, layout.Options{Width: &width, Height: &height})
	if err != nil {
		t.Fatal(err)
	}
	records := map[string]layout.WindowSidebar{}
	if _, err := layout.ArrangeWindowSidebars(grid, order, order, records, 190, func(string) bool { return true }); err != nil {
		t.Fatalf("the crowded plane refused the arrangement: %v", err)
	}
	top, ok := grid.Card("top")
	if !ok {
		t.Fatal("the top sidebar is missing while its switch is on")
	}
	if top.Height == nil || *top.Height <= 0 || *top.Height >= 190 {
		t.Fatalf("the top sidebar is not docked at a reduced size: %+v", top)
	}
	minimum := grid.MinSize()
	for _, id := range []string{"main", "second", "third", "fourth", "fifth"} {
		rect := grid.Rects()[id]
		if rect.H < minimum-0.5 || rect.W < minimum-0.5 {
			t.Fatalf("%s is drawn at %s below the minimum", id, fmtSize(rect.W, rect.H))
		}
	}
	if !layout.WindowSidebarsArranged(grid, order) {
		t.Fatal("the reduced sidebar does not stand at its place")
	}
	// A settle that changes nothing moves nothing and the record follows the size that the plane holds.
	if changed, err := layout.ArrangeWindowSidebars(grid, order, order, records, 190, func(string) bool { return true }); err != nil || changed {
		t.Fatalf("a quiet settle docked again: changed %v err %v", changed, err)
	}
	if top, _ := grid.Card("top"); records["top"].Height != *top.Height {
		t.Fatalf("the record does not hold the size that the plane holds: record %+v card %+v", records["top"], top)
	}
	// The plane that holds no size for a sidebar docks the others, names the side it cannot place, and a quiet settle does not
	// attempt the refused arrangement again.
	full := []string{"main", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"}
	tight, err := layout.New(&layout.State{
		Xs: []float64{0, 1},
		Ys: []float64{0, 0.11, 0.22, 0.33, 0.44, 0.55, 0.66, 0.77, 0.88, 1},
		Cards: []layout.Card{
			{ID: full[0], C0: 0, C1: 1, R0: 0, R1: 1}, {ID: full[1], C0: 0, C1: 1, R0: 1, R1: 2},
			{ID: full[2], C0: 0, C1: 1, R0: 2, R1: 3}, {ID: full[3], C0: 0, C1: 1, R0: 3, R1: 4},
			{ID: full[4], C0: 0, C1: 1, R0: 4, R1: 5}, {ID: full[5], C0: 0, C1: 1, R0: 5, R1: 6},
			{ID: full[6], C0: 0, C1: 1, R0: 6, R1: 7}, {ID: full[7], C0: 0, C1: 1, R0: 7, R1: 8},
		},
	}, layout.Options{Width: &width, Height: &height})
	if err != nil {
		t.Fatal(err)
	}
	sides := []string{"top"}
	_, err = layout.ArrangeWindowSidebars(tight, order, sides, map[string]layout.WindowSidebar{}, 190, func(string) bool { return true })
	if err == nil || !strings.Contains(err.Error(), "cannot place window sidebars top") {
		t.Fatalf("the plane that holds no height refused nothing: %v", err)
	}
	if _, ok := tight.Card("top"); ok {
		t.Fatal("the dock left a sidebar where no size holds")
	}
	// The refused arrangement is not attempted again while the plane stands still.
	if changed, err := layout.ArrangeWindowSidebars(tight, order, sides, map[string]layout.WindowSidebar{}, 190, func(string) bool { return true }); err != nil || changed {
		t.Fatalf("a quiet settle attempted the refused arrangement: changed %v err %v", changed, err)
	}
}

func fmtSize(w, h float64) string {
	return fmt.Sprintf("%.1fx%.1f", w, h)
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
