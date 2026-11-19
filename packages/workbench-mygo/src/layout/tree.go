package layout

import "fmt"

// TreeNode is a node of the tree of the content cards of a layout (docs/spec/exposure.md#window-snapshot): a split with its Direction,
// row or column, and its Children, or a card with its Card id. Size is the share of the node in the extent of its parent split along
// the direction of that split, and 1 for the root.
type TreeNode struct {
	Direction string
	Size      float64
	Children  []TreeNode
	Card      string
}

// Tree is the tree of the content cards of the stored tree of state: a cut along x is a row and a cut along y a column, a box is the
// node inside it, and a window side card is a place card and is outside the tree, so a cut that holds one gives its share to its other
// kids in proportion. A state without content cards has no tree.
func Tree(state State) (*TreeNode, error) {
	if err := CheckState(state); err != nil {
		return nil, err
	}
	return treeOfNode(state.Root, false), nil
}

// LevelTree is the tree of the members of the level key of the grid, the root level for "" and else the members of the box key: its
// content cards and its boxes, each box a leaf by its id, as Tree reads the root. A level without a content card or a box has no tree.
func (g *Grid) LevelTree(key string) (*TreeNode, error) {
	at := g.root
	if key != "" {
		box := g.boxNode(key)
		if box == nil {
			return nil, fmt.Errorf("card %s is no box of the tree", key)
		}
		at = box.Inner
	}
	return treeOfNode(at, true), nil
}

// treeOfNode is the tree of the node n with the size 1, each box a leaf by its id when boxed and else the node inside it.
func treeOfNode(n *Node, boxed bool) *TreeNode {
	var of func(n *Node) *TreeNode
	of = func(n *Node) *TreeNode {
		switch {
		case n.isBox() && boxed:
			return &TreeNode{Card: n.Box}
		case n.isBox():
			return of(n.Inner)
		case !n.isCut():
			if IsWindowSide(n.Card) {
				return nil
			}
			return &TreeNode{Card: n.Card}
		}
		kids, total := []TreeNode{}, 0.0
		shares := []float64{}
		for _, kid := range n.Kids {
			if node := of(kid.Node); node != nil {
				kids, shares, total = append(kids, *node), append(shares, kid.Share), total+kid.Share
			}
		}
		switch len(kids) {
		case 0:
			return nil
		case 1:
			return &kids[0]
		}
		for i := range kids {
			kids[i].Size = shares[i] / total
		}
		direction := "row"
		if n.Cut == "y" {
			direction = "column"
		}
		return &TreeNode{Direction: direction, Children: kids}
	}
	root := of(n)
	if root != nil {
		root.Size = 1
	}
	return root
}
