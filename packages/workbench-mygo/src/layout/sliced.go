package layout

// SlicedCard is a card in the order of reading the slicing tree of an arrangement, with the number of cuts above it.
type SlicedCard struct {
	ID   string
	Cuts int
}

// Sliced returns the cards that keep accepts in the order of reading the stored tree, each with the number of cuts above it that divide
// the accepted cards: a cut that holds the accepted cards of one kid only divides none of them.
func (g *Grid) Sliced(keep func(Card) bool) []SlicedCard {
	order := []SlicedCard{}
	var kept func(n *Node) bool
	kept = func(n *Node) bool {
		switch {
		case n.isCut():
			for _, kid := range n.Kids {
				if kept(kid.Node) {
					return true
				}
			}
			return false
		case n.isBox():
			return kept(n.Inner)
		}
		c := g.find(n.Card)
		return keep(*c)
	}
	var walk func(n *Node, cuts int)
	walk = func(n *Node, cuts int) {
		switch {
		case n.isCut():
			holding := 0
			for _, kid := range n.Kids {
				if kept(kid.Node) {
					holding++
				}
			}
			if holding > 1 {
				cuts++
			}
			for _, kid := range n.Kids {
				walk(kid.Node, cuts)
			}
		case n.isBox():
			walk(n.Inner, cuts)
		default:
			if c := g.find(n.Card); keep(*c) {
				order = append(order, SlicedCard{ID: n.Card, Cuts: cuts})
			}
		}
	}
	walk(g.root, 0)
	return order
}
