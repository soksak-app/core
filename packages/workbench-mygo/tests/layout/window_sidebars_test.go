package layout_test

import (
	"encoding/json"
	"fmt"
	"math"
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
		grid, err := layout.New(&layout.State{Root: &layout.Node{Card: "main"}},
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
	row := func(ids ...string) *layout.Node {
		cut := &layout.Node{Cut: "x"}
		for _, id := range ids {
			cut.Kids = append(cut.Kids, layout.Kid{Share: 1 / float64(len(ids)), Node: &layout.Node{Card: id}})
		}
		return cut
	}
	grid, err := layout.New(&layout.State{Root: &layout.Node{Cut: "y", Kids: []layout.Kid{
		{Share: 0.25, Node: row("main", "fifth")}, {Share: 0.25, Node: &layout.Node{Card: "third"}}, {Share: 0.5, Node: row("second", "fourth")},
	}}}, layout.Options{Width: &width, Height: &height})
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
	column := &layout.Node{Cut: "y"}
	for _, id := range full {
		column.Kids = append(column.Kids, layout.Kid{Share: 1 / float64(len(full)), Node: &layout.Node{Card: id}})
	}
	tight, err := layout.New(&layout.State{Root: column}, layout.Options{Width: &width, Height: &height})
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

// TestTheLastWindowSidebarLeavesWhenItsSwitchTurnsOff checks that the sidebar of the only side that is on leaves the plane when its switch
// turns off (docs/spec/external-sidebars.md#window-controls): an arrangement without any side is not the refused arrangement of an
// earlier plane state.
func TestTheLastWindowSidebarLeavesWhenItsSwitchTurnsOff(t *testing.T) {
	order := []string{"left", "right", "top", "bottom"}
	for _, side := range order {
		width, height := 1000.0, 800.0
		grid, err := layout.New(&layout.State{Root: &layout.Node{Card: "main"}},
			layout.Options{Width: &width, Height: &height})
		if err != nil {
			t.Fatal(err)
		}
		records := map[string]layout.WindowSidebar{}
		on := true
		shown := func(s string) bool { return on && s == side }
		if changed, err := layout.ArrangeWindowSidebars(grid, order, order, records, 190, shown); err != nil || !changed {
			t.Fatalf("%s: the switch on did not dock the sidebar: changed %v err %v", side, changed, err)
		}
		if _, ok := grid.Card(side); !ok {
			t.Fatalf("%s: the sidebar is missing while its switch is on", side)
		}
		on = false
		changed, err := layout.ArrangeWindowSidebars(grid, order, order, records, 190, shown)
		if err != nil {
			t.Fatalf("%s: the switch off refused: %v", side, err)
		}
		if _, ok := grid.Card(side); ok || !changed {
			t.Fatalf("%s: the sidebar stays on the plane after its switch turned off: changed %v cards %v", side, changed, grid.Cards())
		}
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
	for _, side := range order {
		twice := &layout.Node{Cut: layout.WindowAxis(side), Kids: []layout.Kid{{Share: 0.5, Node: &layout.Node{Card: side}}, {Share: 0.5, Node: &layout.Node{Card: side}}}}
		if _, err := layout.New(&layout.State{Root: twice}, options); err == nil || err.Error() != "soksak: card "+side+" is stored twice" {
			t.Fatalf("a state with two %s sidebars: %v", side, err)
		}
		grid, err := layout.New(&layout.State{Root: &layout.Node{Card: "main"}}, options)
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

// TestAHiddenWindowSidebarGivesItsRoomInProportion checks that a window sidebar that leaves is withdrawn: the other kids of its cut take
// its room in proportion to their sizes, not its neighbour alone (docs/spec/external-sidebars.md).
func TestAHiddenWindowSidebarGivesItsRoomInProportion(t *testing.T) {
	var state layout.State
	if err := json.Unmarshal([]byte(`{"root":{"cut":"x","kids":[
		{"share":0.2,"node":{"card":"left","fixed":true,"width":200}},
		{"share":0.6,"node":{"card":"a"}},{"share":0.2,"node":{"card":"b"}}]}}`), &state); err != nil {
		t.Fatal(err)
	}
	width, height, gap := 1000.0, 800.0, 0.0
	grid, err := layout.New(&state, layout.Options{Width: &width, Height: &height, Gap: &gap})
	if err != nil {
		t.Fatal(err)
	}
	order := []string{"left", "right", "top", "bottom"}
	records := map[string]layout.WindowSidebar{"left": layout.SidebarSize("left", 200)}
	if _, err := layout.ArrangeWindowSidebars(grid, order, order, records, 190, func(string) bool { return false }); err != nil {
		t.Fatal(err)
	}
	a, _ := grid.Rect("a") // silent: a is a card of the grid.
	b, _ := grid.Rect("b") // silent: b is a card of the grid.
	if math.Abs(a.W-750) > 0.5 || math.Abs(b.W-250) > 0.5 {
		t.Fatalf("after the hide a is %v and b %v wide, not 750 and 250", a.W, b.W)
	}
}

// TestADockAndAHideRestoreTheWidthsOfTheCards checks that the dock of a window sidebar adds a fixed leaf, whose room the cards that are
// not fixed give by one factor, and its hide withdraws it, so a dock and a hide restore every width (docs/spec/external-sidebars.md).
func TestADockAndAHideRestoreTheWidthsOfTheCards(t *testing.T) {
	for _, gap := range []float64{0, 24} {
		var state layout.State
		if err := json.Unmarshal([]byte(`{"root":{"cut":"x","kids":[{"share":0.75,"node":{"cut":"y","kids":[
			{"share":0.5,"node":{"card":"a"}},{"share":0.5,"node":{"card":"c"}}]}},{"share":0.25,"node":{"card":"b"}}]}}`), &state); err != nil {
			t.Fatal(err)
		}
		width, height := 1400.0, 900.0
		grid, err := layout.New(&state, layout.Options{Width: &width, Height: &height, Gap: &gap})
		if err != nil {
			t.Fatal(err)
		}
		widths := func() [2]float64 {
			a, _ := grid.Rect("a") // silent: a is a card of the grid.
			b, _ := grid.Rect("b") // silent: b is a card of the grid.
			return [2]float64{a.W, b.W}
		}
		before := widths()
		order := []string{"left", "right", "top", "bottom"}
		sides := []string{"left", "right"}
		records := map[string]layout.WindowSidebar{}
		shown := true
		if _, err := layout.ArrangeWindowSidebars(grid, order, sides, records, 190, func(string) bool { return shown }); err != nil {
			t.Fatal(err)
		}
		docked := widths()
		// The dock scales the fractions of the cards by one factor, and the corridors are costs of the cut, so the drawn ratio holds.
		if ratio := docked[0] / docked[1]; math.Abs(ratio-before[0]/before[1]) > 1e-6 {
			t.Fatalf("gap %v: the docked cards are %v wide, whose ratio %v is not the ratio of %v", gap, docked, ratio, before)
		}
		shown = false
		if _, err := layout.ArrangeWindowSidebars(grid, order, sides, records, 190, func(string) bool { return shown }); err != nil {
			t.Fatal(err)
		}
		if after := widths(); math.Abs(after[0]-before[0]) > 1e-6 || math.Abs(after[1]-before[1]) > 1e-6 {
			t.Fatalf("gap %v: a dock and a hide leave the cards %v wide, not %v (docked %v)", gap, after, before, docked)
		}
	}
}
