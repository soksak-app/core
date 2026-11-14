package layout

import (
	"fmt"
	"slices"
)

// TreeNode is a node of the tree of the content cards of a layout (docs/spec/exposure.md#window-snapshot): a split with its Direction,
// row or column, and its Children, or a card with its Card id. Size is the share of the node in the extent of its parent split along
// the direction of that split, and 1 for the root.
type TreeNode struct {
	Direction string
	Size      float64
	Children  []TreeNode
	Card      string
}

// Tree derives the tree of the content cards of state from its lines and cards; a window side card is a place card and is outside the
// tree. A region is a row when a vertical line crosses it from edge to edge, else a column, and the children of a split are its parts
// between the lines that cross it from edge to edge, so one arrangement has one tree. A state without content cards has no tree, and
// cards that no line divides are refused, because the tree describes a slicing arrangement.
func Tree(state State) (*TreeNode, error) {
	var cards []Card
	for _, card := range state.Cards {
		if !IsWindowSide(card.ID) {
			cards = append(cards, card)
		}
	}
	if len(cards) == 0 {
		return nil, nil
	}
	region := [4]int{cards[0].C0, cards[0].C1, cards[0].R0, cards[0].R1}
	for _, card := range cards[1:] {
		region = [4]int{min(region[0], card.C0), max(region[1], card.C1), min(region[2], card.R0), max(region[3], card.R1)}
	}
	node, err := treeOf(state, cards, region)
	if err != nil {
		return nil, err
	}
	node.Size = 1
	return &node, nil
}

// treeOf is the node of the cards that fill region, the lines c0, c1, r0 and r1, with no size.
func treeOf(state State, cards []Card, region [4]int) (TreeNode, error) {
	if len(cards) == 1 {
		return TreeNode{Card: cards[0].ID}, nil
	}
	for _, split := range []struct {
		direction string
		lines     []float64
		lo, hi    func(Card) int
		low, high int
	}{
		{"row", state.Xs, func(c Card) int { return c.C0 }, func(c Card) int { return c.C1 }, 0, 1},
		{"column", state.Ys, func(c Card) int { return c.R0 }, func(c Card) int { return c.R1 }, 2, 3},
	} {
		// The lines inside the region at which every card ends or begins cross the region from edge to edge.
		var cuts []int
		for _, card := range cards {
			for _, line := range []int{split.lo(card), split.hi(card)} {
				if line > region[split.low] && line < region[split.high] && !slices.Contains(cuts, line) &&
					!slices.ContainsFunc(cards, func(other Card) bool { return split.lo(other) < line && split.hi(other) > line }) {
					cuts = append(cuts, line)
				}
			}
		}
		if len(cuts) == 0 {
			continue
		}
		slices.Sort(cuts)
		bounds := append(append([]int{region[split.low]}, cuts...), region[split.high])
		extent := split.lines[region[split.high]] - split.lines[region[split.low]]
		node := TreeNode{Direction: split.direction}
		for i := range len(bounds) - 1 {
			part := region
			part[split.low], part[split.high] = bounds[i], bounds[i+1]
			var inside []Card
			for _, card := range cards {
				if split.lo(card) >= part[split.low] && split.hi(card) <= part[split.high] {
					inside = append(inside, card)
				}
			}
			if len(inside) == 0 {
				return TreeNode{}, fmt.Errorf("no card fills the lines %d to %d of the %s", bounds[i], bounds[i+1], split.direction)
			}
			child, err := treeOf(state, inside, part)
			if err != nil {
				return TreeNode{}, err
			}
			child.Size = (split.lines[bounds[i+1]] - split.lines[bounds[i]]) / extent
			node.Children = append(node.Children, child)
		}
		return node, nil
	}
	ids := make([]string, len(cards))
	for i, card := range cards {
		ids[i] = card.ID
	}
	return TreeNode{}, fmt.Errorf("no line divides the cards %v from edge to edge", ids)
}
