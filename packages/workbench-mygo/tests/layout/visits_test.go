// The work of each tree operation is linear in the nodes of the tree (packages/soksak/docs/layout.md#cuts): the grid counts the nodes
// that its last operation visited (Visits), and a test bounds that count on a tree of 500 cards instead of a time.
package layout_test

import (
	"fmt"
	"testing"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// visitsPerNode is the most visits of one operation per node of the tree: an operation passes over the tree a fixed number of times, to
// read the lines (derive), to build the tree of cuts with its index, to run its correction passes and to write the lines back (commit),
// while an operation that scans the tree once per card that it touches visits hundreds of times as many nodes on 500 cards.
const visitsPerNode = 24

// growth is the most that the visits of one operation grow when the tree has four times the cards: four for linear work, sixteen for
// work that is quadratic in the cards.
const growth = 4.5

// wideTree is a tree of columns × rows cards: an x cut of columns y cuts, each of rows cards.
func wideTree(columns, rows int) (layout.State, int) {
	root := &layout.Node{Cut: "x"}
	nodes := 1
	for c := range columns {
		column := &layout.Node{Cut: "y"}
		nodes++
		for r := range rows {
			column.Kids = append(column.Kids, layout.Kid{Share: 1 / float64(rows), Node: &layout.Node{Card: fmt.Sprintf("c%d-%d", c, r)}})
			nodes++
		}
		root.Kids = append(root.Kids, layout.Kid{Share: 1 / float64(columns), Node: column})
	}
	return layout.State{Root: root}, nodes
}

// TestEachTreeOperationVisitsTheNodesOfTheTreeAFewTimes runs each operation on a tree of 500 cards and bounds the nodes that it
// visited.
func TestEachTreeOperationVisitsTheNodesOfTheTreeAFewTimes(t *testing.T) {
	small, large := visitsOn(t, 20, 25), visitsOn(t, 40, 50)
	for name, visits := range small {
		if ratio := float64(large[name]) / float64(visits); ratio > growth {
			t.Errorf("%s visited %.1f times the nodes on 2000 cards as on 500, more than %v", name, ratio, growth)
		}
	}
}

// visitsOn runs each operation on a tree of columns × rows cards, bounds the nodes that it visited and returns them by operation.
func visitsOn(t *testing.T, columns, rows int) map[string]int {
	t.Helper()
	state, nodes := wideTree(columns, rows)
	gap, minimum, width, height := 1.0, 1.0, 20000.0, 20000.0
	grid, err := layout.New(nil, layout.Options{Gap: &gap, MinSize: &minimum, Width: &width, Height: &height})
	if err != nil {
		t.Fatal(err)
	}
	if err := grid.Replace(state); err != nil {
		t.Fatal(err)
	}
	// id names the card at a fraction of the columns and the rows, so every size runs the operations at the same places.
	id := func(column, row float64) string {
		return fmt.Sprintf("c%d-%d", int(column*float64(columns)), int(row*float64(rows)))
	}
	var left *layout.Node
	operations := []struct {
		name string
		run  func() error
	}{
		{"replace", func() error { return grid.Replace(state) }},
		{"insert", func() error {
			_, err := grid.Insert(layout.Target{id(.35, .45)}, "right", &layout.Node{Card: "new"})
			return err
		}},
		{"withdraw", func() error {
			var err error
			left, err = grid.Withdraw(id(.15, .15))
			return err
		}},
		{"insert of a withdrawn card", func() error {
			_, err := grid.Insert(layout.Target{id(.4, .4)}, "bottom", left)
			return err
		}},
		{"split", func() error {
			if _, ok := grid.Split(id(.45, .35), "y", layout.SplitInit{}); !ok {
				return fmt.Errorf("the split of %s is refused", id(.45, .35))
			}
			return nil
		}},
		{"close", func() error {
			if !grid.Close(id(.55, .1)) {
				return fmt.Errorf("the close of %s is refused", id(.55, .1))
			}
			return nil
		}},
		{"move", func() error {
			if !grid.Move(id(.1, .1), id(.45, .35), "left") {
				return fmt.Errorf("the move of %s is refused", id(.1, .1))
			}
			return nil
		}},
		{"boundary move", func() error {
			grid.MoveBoundary("x", 5, grid.BoundaryPos("x", 5)+3, false)
			return nil
		}},
		{"heads", func() error { return grid.SetHeads(map[string]float64{}) }},
		{"even", func() error { return grid.Even() }},
	}
	counts := map[string]int{}
	for _, op := range operations {
		if err := op.run(); err != nil {
			t.Fatalf("%s: %v", op.name, err)
		}
		visits := grid.Visits()
		counts[op.name] = visits
		t.Logf("%d cards: %s visited %d nodes of %d", columns*rows, op.name, visits, nodes)
		if visits == 0 {
			t.Errorf("%s visited no node, so the count does not follow it", op.name)
		}
		if visits > visitsPerNode*nodes {
			t.Errorf("%s visited %d nodes, more than %d times the %d nodes of the tree", op.name, visits, visitsPerNode, nodes)
		}
	}
	return counts
}
