package layout

// Fill is the cards that take a closed card's space, the side they come from and the span key each of them expands by.
type Fill struct {
	Side  string `json:"side"`
	Grow  string `json:"grow"`
	Cards []Card `json:"cards"`
}

// fill is a Fill holding the stored cards, so a close can change them.
type fill struct {
	side  string
	grow  spanKey
	cards []*Card
	// cut is the cut of the closing card, at the index of its node and to the index of the kid that takes its space.
	cut    *Node
	at, to int
}

type direction struct {
	side    string
	grow    spanKey
	touches func(c, x *Card) bool
	lo, hi  spanKey
}

var directions = map[string]direction{
	"below": {"below", keyR0, func(c, x *Card) bool { return c.R0 == x.R1 }, keyC0, keyC1},
	"above": {"above", keyR1, func(c, x *Card) bool { return c.R1 == x.R0 }, keyC0, keyC1},
	"right": {"right", keyC0, func(c, x *Card) bool { return c.C0 == x.C1 }, keyR0, keyR1},
	"left":  {"left", keyC1, func(c, x *Card) bool { return c.C1 == x.C0 }, keyR0, keyR1},
}

var fillOrders = map[string][]string{
	"v": {"below", "above", "right", "left"},
	"h": {"right", "left", "below", "above"},
}

var spanNames = map[spanKey]string{keyC0: "c0", keyC1: "c1", keyR0: "r0", keyR1: "r1"}
