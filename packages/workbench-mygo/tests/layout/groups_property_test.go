package layout_test

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand/v2"
	"slices"
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// groupInvariants is the first broken invariant of a space with groups (docs/spec/groups.md#model), or "": the rectangle of every group
// card holds exactly the cells of the cards inside it, two group cards are disjoint or one holds the other, no
// line is unused and no two lines of an axis stand at one coordinate, which hold in a space with groups.
func groupInvariants(tree *layout.GroupTree) string {
	grid := tree.Grid()
	grouped := slices.ContainsFunc(tree.Cards(), tree.IsGroup)
	for _, axis := range []layout.Axis{"x", "y"} {
		lines := grid.Lines(axis)
		for k := 1; k < len(lines) && grouped; k++ {
			if math.Abs(lines[k]-lines[k-1]) < 1e-9 {
				return fmt.Sprintf("%s lines %d and %d stand at %v", axis, k-1, k, lines[k])
			}
		}
	}
	cells := map[string][4]int{}
	for _, card := range grid.Cards() {
		cells[card.ID] = [4]int{card.C0, card.C1, card.R0, card.R1}
	}
	spans := map[string][4]int{}
	members := map[string][]string{}
	for _, id := range tree.Cards() {
		if !tree.IsGroup(id) {
			continue
		}
		inside := tree.ContentInside(id)
		span, area := [4]int{math.MaxInt, -1, math.MaxInt, -1}, 0
		for _, card := range inside {
			c := cells[card]
			span = [4]int{min(span[0], c[0]), max(span[1], c[1]), min(span[2], c[2]), max(span[3], c[3])}
			area += (c[1] - c[0]) * (c[3] - c[2])
		}
		if area != (span[1]-span[0])*(span[3]-span[2]) {
			return fmt.Sprintf("group %s spans %v but its cards %v cover %d cells", id, span, inside, area)
		}
		spans[id], members[id] = span, inside
	}
	for a, sa := range spans {
		for b, sb := range spans {
			if a >= b || min(sa[1], sb[1]) <= max(sa[0], sb[0]) || min(sa[3], sb[3]) <= max(sa[2], sb[2]) {
				continue
			}
			inA, inB := members[a], members[b]
			if !subset(inA, inB) && !subset(inB, inA) {
				return fmt.Sprintf("groups %s %v and %s %v overlap", a, sa, b, sb)
			}
		}
	}
	return ""
}

// describeTree is the grid and the stored group tree, as text.
func describeTree(tree *layout.GroupTree) string {
	state, leader, last := tree.Stored()
	text, err := json.Marshal(map[string]any{"state": state, "leader": leader, "lastCard": last})
	if err != nil {
		return err.Error()
	}
	return string(text)
}

func subset(a, b []string) bool {
	for _, id := range a {
		if !slices.Contains(b, id) {
			return false
		}
	}
	return true
}

// TestRandomGroupOperationsKeepTheInvariants runs seeded random sequences of the operations of a space with groups, as the commands,
// the drops and the drags of the workbench call them, and checks the invariants after every step.
func TestRandomGroupOperationsKeepTheInvariants(t *testing.T) {
	sides := []string{"left", "right", "top", "bottom"}
	// The seeds after the first thousand are those that a longer run found broken.
	seeds := []uint64{16258}
	for seed := uint64(1); seed <= 1000; seed++ {
		seeds = append(seeds, seed)
	}
	for _, seed := range seeds {
		gap, minimum, width, height := 12.0, 96.0, 1400.0, 900.0
		grid, err := layout.New(nil, layout.Options{Gap: &gap, MinSize: &minimum, Width: &width, Height: &height})
		if err != nil {
			t.Fatal(err)
		}
		state := layout.State{Root: &layout.Node{Card: "card-1"}}
		tree, err := layout.ReadTree(state, nil, json.RawMessage(`"card-1"`), json.RawMessage(`1`),
			layout.GroupOptions{Head: 32}, grid)
		if err != nil {
			t.Fatal(err)
		}
		random := rand.New(rand.NewPCG(seed, 7))
		var steps []string
		pick := func() string { cards := tree.Cards(); return cards[random.IntN(len(cards))] }
		for range 80 {
			before := describeTree(tree)
			side := sides[random.IntN(4)]
			var step string
			switch random.IntN(14) {
			case 0, 1:
				id := pick()
				_, _, err := tree.CreateGroup(id, side, nil)
				step = fmt.Sprintf("create %s %s: %v", id, side, err)
			case 2, 3:
				id := pick()
				_, err := tree.Split(id, side, nil)
				step = fmt.Sprintf("split %s %s: %v", id, side, err)
			case 4, 5:
				id := pick()
				_, err := tree.Close(id)
				step = fmt.Sprintf("close %s: %v", id, err)
			case 6, 7:
				id, target := pick(), pick()
				err := tree.Move(id, layout.Target{target}, side)
				step = fmt.Sprintf("move %s %s %s: %v", id, target, side, err)
			case 8:
				id := pick()
				step = fmt.Sprintf("dissolve %s: %v", id, tree.Dissolve(id))
			case 9:
				id := pick()
				_, err := tree.SetLeader(id)
				step = fmt.Sprintf("leader %s: %v", id, err)
			case 10:
				axis := layout.Axis([]string{"x", "y"}[random.IntN(2)])
				lines := grid.Lines(axis)
				if len(lines) > 2 {
					line := 1 + random.IntN(len(lines)-2)
					size := width
					if axis == "y" {
						size = height
					}
					px := random.Float64() * size
					if random.IntN(2) == 0 {
						// core.boundary.move toward a position, often the position of a neighbouring line.
						if random.IntN(2) == 0 {
							px = grid.BoundaryPos(axis, line+[]int{-1, 1}[random.IntN(2)])
						}
						step = fmt.Sprintf("boundary command %s %d %.1f: %.1f", axis, line, px, tree.MoveBoundaryTo(axis, line, px))
					} else {
						at := tree.MoveBoundary(axis, line, px, true)
						merged := tree.MergeCoincident(axis, line)
						step = fmt.Sprintf("boundary %s %d %.1f: %.1f merged %v", axis, line, px, at, merged)
					}
				}
			case 11:
				step = fmt.Sprintf("balance: %v", tree.Balance(false))
			case 12:
				id := pick()
				_, err := tree.AddCard(id, nil)
				step = fmt.Sprintf("add %s: %v", id, err)
			case 13:
				axis := layout.Axis([]string{"x", "y"}[random.IntN(2)])
				if lines := grid.Lines(axis); len(lines) > 2 {
					line := 1 + random.IntN(len(lines)-2)
					step = fmt.Sprintf("centre %s %d: %.1f", axis, line, tree.CenterBoundary(axis, line))
				}
			}
			if step == "" {
				continue
			}
			steps = append(steps, step)
			if broken := groupInvariants(tree); broken != "" {
				t.Fatalf("seed %d: %s after\n%s\nbefore the last step: %s\nafter it: %s", seed, broken, strings.Join(steps, "\n"), before,
					describeTree(tree))
			}
		}
	}
}
