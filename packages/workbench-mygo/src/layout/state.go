package layout

import (
	"bytes"
	"encoding/json"
	"errors"
	"maps"
	"math"
	"slices"
	"sort"
	"strconv"
)

// The stored form of the layout is its canonical slicing tree (packages/soksak/docs/layout.md#the-model): cards, boxes of the host and
// cuts along an axis into kids with shares. The lines and the cells are derived from the tree after every change and never read back,
// so two cuts whose lines meet by chance stay two cuts.

// Node is a node of the slicing tree: a card (Card), a box of the host around its Inner node (Box), or a cut along the axis Cut into its
// Kids. Data is the payload of the host, which the layout does not read; Fixed, Width and Height belong to a card.
type Node struct {
	Card   string
	Box    string
	Cut    Axis
	Data   json.RawMessage
	Fixed  bool
	Width  *float64
	Height *float64
	Inner  *Node
	Kids   []Kid
}

// Kid is a kid of a cut: its node and the share of the extent of the cut that it takes.
type Kid struct {
	Share float64 `json:"share"`
	Node  *Node   `json:"node"`
}

func (n *Node) isCut() bool { return n.Cut != "" }
func (n *Node) isBox() bool { return n.Cut == "" && n.Inner != nil }

// id is the id of a card or a box, and "" for a cut.
func (n *Node) id() string {
	if n.isBox() {
		return n.Box
	}
	return n.Card
}

// MarshalJSON writes {card, fixed, data?, width?, height?}, {box, data?, inner} or {cut, kids}.
func (n Node) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	field := func(name string, value any) error {
		if b.Len() > 1 {
			b.WriteByte(',')
		}
		text, err := json.Marshal(value)
		if err != nil {
			return err
		}
		b.WriteString(strconv.Quote(name) + ":")
		b.Write(text)
		return nil
	}
	b.WriteByte('{')
	var err error
	switch {
	case n.isCut():
		err = errors.Join(field("cut", n.Cut), field("kids", n.Kids))
	case n.isBox():
		err = field("box", n.Box)
		if n.Data != nil {
			err = errors.Join(err, field("data", n.Data))
		}
		err = errors.Join(err, field("inner", n.Inner))
	default:
		err = errors.Join(field("card", n.Card), field("fixed", n.Fixed))
		if n.Data != nil {
			err = errors.Join(err, field("data", n.Data))
		}
		if n.Width != nil {
			err = errors.Join(err, field("width", *n.Width))
		}
		if n.Height != nil {
			err = errors.Join(err, field("height", *n.Height))
		}
	}
	b.WriteByte('}')
	return b.Bytes(), err
}

// UnmarshalJSON reads a node and refuses one of another form.
func (n *Node) UnmarshalJSON(text []byte) error {
	read, err := readNode(text)
	if err != nil {
		return err
	}
	*n = *read
	return nil
}

// notANode is the refusal of a node of another form, with its text.
func notANode(raw json.RawMessage) error {
	var compact bytes.Buffer
	if json.Compact(&compact, raw) != nil {
		compact.Reset()
		compact.Write(raw)
	}
	return errors.New("soksak: the node " + compact.String() + " is not a card, a box or a cut")
}

// readNode reads one node: an object with exactly the members of a card, a box or a cut.
func readNode(raw json.RawMessage) (*Node, error) {
	var members map[string]json.RawMessage
	if err := json.Unmarshal(raw, &members); err != nil || members == nil {
		return nil, notANode(raw)
	}
	only := func(allowed ...string) bool {
		for k := range members {
			if !slices.Contains(allowed, k) {
				return false
			}
		}
		return true
	}
	text := func(key string) (string, bool) {
		var s string
		value, ok := members[key]
		return s, ok && json.Unmarshal(value, &s) == nil
	}
	number := func(key string) (*float64, bool) {
		value, ok := members[key]
		if !ok {
			return nil, true
		}
		var v float64
		if json.Unmarshal(value, &v) != nil {
			return nil, false
		}
		return &v, true
	}
	n := &Node{}
	if data, ok := members["data"]; ok {
		n.Data = slices.Clone(data)
	}
	if id, ok := text("card"); ok && only("card", "data", "fixed", "width", "height") {
		n.Card = id
		if fixed, has := members["fixed"]; has && json.Unmarshal(fixed, &n.Fixed) != nil {
			return nil, notANode(raw)
		}
		var wOK, hOK bool
		n.Width, wOK = number("width")
		n.Height, hOK = number("height")
		if !wOK || !hOK {
			return nil, notANode(raw)
		}
		return n, nil
	}
	if id, ok := text("box"); ok && only("box", "data", "inner") {
		inner, has := members["inner"]
		if !has {
			return nil, notANode(raw)
		}
		node, err := readNode(inner)
		if err != nil {
			return nil, err
		}
		n.Box, n.Inner = id, node
		return n, nil
	}
	if axis, ok := text("cut"); ok && (axis == "x" || axis == "y") && only("cut", "kids") {
		var kids []map[string]json.RawMessage
		if json.Unmarshal(members["kids"], &kids) != nil {
			return nil, notANode(raw)
		}
		n.Cut = axis
		for _, kid := range kids {
			var share float64
			value, has := kid["node"]
			if len(kid) != 2 || !has || json.Unmarshal(kid["share"], &share) != nil {
				return nil, notANode(raw)
			}
			node, err := readNode(value)
			if err != nil {
				return nil, err
			}
			n.Kids = append(n.Kids, Kid{Share: share, Node: node})
		}
		return n, nil
	}
	return nil, notANode(raw)
}

// State is the stored arrangement: the slicing tree of the plane and, for each card, the card it took its space from.
type State struct {
	Root   *Node             `json:"root"`
	PaidBy map[string]string `json:"paidBy"`
	// earlier and broken are what UnmarshalJSON read that is no state, the members of the earlier form or a node of another form, which
	// CheckState reports.
	earlier bool
	broken  error
}

// UnmarshalJSON reads a state and keeps what it cannot read for CheckState, which the constructor runs.
func (s *State) UnmarshalJSON(text []byte) error {
	var members map[string]json.RawMessage
	if err := json.Unmarshal(text, &members); err != nil {
		return err
	}
	*s = State{}
	for _, key := range []string{"xs", "ys", "cards"} {
		if _, ok := members[key]; ok {
			s.earlier = true
		}
	}
	if raw, ok := members["root"]; ok {
		root, err := readNode(raw)
		if err != nil {
			s.broken = err
		}
		s.Root = root
	}
	if raw, ok := members["paidBy"]; ok && string(raw) != "null" {
		if err := json.Unmarshal(raw, &s.PaidBy); err != nil {
			return err
		}
	}
	return nil
}

// CheckState rejects a state that is not a canonical slicing tree and names what is wrong. Nothing is converted.
func CheckState(state State) error {
	if state.earlier {
		return errors.New("soksak: the state holds xs, ys and cards, which is the earlier form; the state is {root, paidBy}")
	}
	if state.broken != nil {
		return state.broken
	}
	if state.Root == nil {
		return errors.New("soksak: the node null is not a card, a box or a cut")
	}
	seen := map[string]bool{}
	var check func(n *Node, path string) error
	check = func(n *Node, path string) error {
		switch {
		case n.isCut():
			bad := func(why string) error { return errors.New("soksak: the cut " + path + " is not canonical: " + why) }
			if len(n.Kids) < 2 {
				return bad("it has fewer than two kids")
			}
			sum := 0.0
			for i, kid := range n.Kids {
				if kid.Node == nil {
					return errors.New("soksak: the node null is not a card, a box or a cut")
				}
				if !finite(kid.Share) || kid.Share <= 0 {
					return bad("the share of kid " + itoa(i) + " is " + jsString(kid.Share))
				}
				sum += kid.Share
			}
			if math.Abs(sum-1) > eps {
				return bad("its shares sum to " + jsString(sum))
			}
			for i, kid := range n.Kids {
				at := path + "." + itoa(i)
				if kid.Node.Cut == n.Cut {
					return errors.New("soksak: the cut " + at + " is not canonical: it is a cut along the axis of its cut")
				}
				if err := check(kid.Node, at); err != nil {
					return err
				}
			}
			return nil
		case n.isBox():
			if seen[n.Box] {
				return errors.New("soksak: card " + n.Box + " is stored twice")
			}
			seen[n.Box] = true
			return check(n.Inner, path+".inner")
		}
		if n.Card == "" {
			return errors.New("soksak: a card has no id")
		}
		if seen[n.Card] {
			return errors.New("soksak: card " + n.Card + " is stored twice")
		}
		seen[n.Card] = true
		return nil
	}
	return check(state.Root, "root")
}

// cloneNode is a deep copy of a node.
func cloneNode(n *Node) *Node {
	if n == nil {
		return nil
	}
	out := *n
	if n.Width != nil {
		w := *n.Width
		out.Width = &w
	}
	if n.Height != nil {
		h := *n.Height
		out.Height = &h
	}
	if n.Data != nil {
		out.Data = slices.Clone(n.Data)
	}
	out.Inner = cloneNode(n.Inner)
	if n.Kids != nil {
		out.Kids = make([]Kid, len(n.Kids))
		for i, kid := range n.Kids {
			out.Kids[i] = Kid{Share: kid.Share, Node: cloneNode(kid.Node)}
		}
	}
	return &out
}

// cardNode is the leaf of a card.
func cardNode(c Card) *Node {
	n := &Node{Card: c.ID, Data: c.Data, Fixed: c.Fixed}
	if c.Width != nil {
		w := *c.Width
		n.Width = &w
	}
	if c.Height != nil {
		h := *c.Height
		n.Height = &h
	}
	return n
}

// nodeLines is the lines at which the rectangle of a node starts and ends: c0, c1, r0 and r1.
type nodeLines [4]int

func (l nodeLines) on(axis Axis) (int, int) {
	if axis == "x" {
		return l[0], l[1]
	}
	return l[2], l[3]
}

// derive lays the tree into the unit plane and derives the lines and the cells from it: coordinates within eps are one line (R1), and
// the cards are listed in the order of the tree.
func (g *Grid) derive() {
	extents := map[*Node]extent{}
	up := map[*Node]holding{}
	var place func(n *Node, e extent)
	place = func(n *Node, e extent) {
		extents[n] = e
		switch {
		case n.isCut():
			lo, hi := ends(n.Cut)
			at, total := e.get(lo), e.get(hi)-e.get(lo)
			for i, kid := range n.Kids {
				up[kid.Node] = holding{n, i}
				end := at + kid.Share*total
				if i == len(n.Kids)-1 {
					end = e.get(hi)
				}
				part := e
				part.set(lo, at)
				part.set(hi, end)
				place(kid.Node, part)
				at = end
			}
		case n.isBox():
			up[n.Inner] = holding{n, -1}
			place(n.Inner, e)
		}
	}
	place(g.root, extent{0, 1, 0, 1})
	leaves := []*Node{}
	var walk func(n *Node)
	walk = func(n *Node) {
		switch {
		case n.isCut():
			for _, kid := range n.Kids {
				walk(kid.Node)
			}
		case n.isBox():
			walk(n.Inner)
		default:
			leaves = append(leaves, n)
		}
	}
	walk(g.root)
	xv, yv := []float64{}, []float64{}
	for _, leaf := range leaves {
		e := extents[leaf]
		xv, yv = append(xv, e.x0, e.x1), append(yv, e.y0, e.y1)
	}
	g.xs, g.ys = linesOf(xv), linesOf(yv)
	g.at = make(map[*Node]nodeLines, len(extents))
	g.up = up
	for n, e := range extents {
		g.at[n] = nodeLines{lineOf(g.xs, e.x0), lineOf(g.xs, e.x1), lineOf(g.ys, e.y0), lineOf(g.ys, e.y1)}
	}
	g.leaves = make(map[string]*Node, len(leaves))
	g.byID = make(map[string]*Card, len(leaves))
	g.list = make([]*Card, len(leaves))
	for i, leaf := range leaves {
		l := g.at[leaf]
		c := &Card{ID: leaf.Card, C0: l[0], C1: l[1], R0: l[2], R1: l[3], Fixed: leaf.Fixed, Data: leaf.Data}
		if leaf.Width != nil {
			w := *leaf.Width
			c.Width = &w
		}
		if leaf.Height != nil {
			h := *leaf.Height
			c.Height = &h
		}
		g.list[i] = c
		g.byID[c.ID] = c
		g.leaves[leaf.Card] = leaf
	}
}

// commit writes what the operations of the lines changed back into the tree: the attributes of every card, and the share of every kid
// of a cut from the coordinates of the lines its rectangle starts and ends at. The structure of the tree stays; then the lines are
// derived again.
func (g *Grid) commit() {
	for _, c := range g.list {
		leaf := g.leaves[c.ID]
		if leaf == nil {
			continue
		}
		leaf.Fixed, leaf.Data = c.Fixed, c.Data
		leaf.Width, leaf.Height = nil, nil
		if c.Width != nil {
			w := *c.Width
			leaf.Width = &w
		}
		if c.Height != nil {
			h := *c.Height
			leaf.Height = &h
		}
	}
	var push func(n *Node)
	push = func(n *Node) {
		switch {
		case n.isCut():
			a := g.arr(n.Cut)
			lo, hi := g.at[n].on(n.Cut)
			total := a[hi] - a[lo]
			if total > 0 {
				for i, kid := range n.Kids {
					from, to := g.at[kid.Node].on(n.Cut)
					n.Kids[i].Share = (a[to] - a[from]) / total
				}
			}
			for _, kid := range n.Kids {
				push(kid.Node)
			}
		case n.isBox():
			push(n.Inner)
		}
	}
	push(g.root)
	g.derive()
}

// holding is the node that holds a node: a cut with the index of the node among its kids, or a box with index -1.
type holding struct {
	node *Node
	at   int
}

// holder is the node that holds n: a cut with the index of n among its kids, a box with index -1, or nil for the root. It reads the
// holders that derive recorded, so it holds for the tree of the last derive and for the nodes that an operation has not moved since.
func (g *Grid) holder(n *Node) (*Node, int) {
	h, ok := g.up[n]
	if !ok {
		return nil, 0
	}
	return h.node, h.at
}

// put puts next where n stands: in its cut, inside its box, or as the root. A cut along the axis of the cut that holds it gives that cut
// its kids, so the tree stays canonical.
func (g *Grid) put(n, next *Node) {
	h, i := g.holder(n)
	switch {
	case h == nil:
		g.root = next
	case i < 0:
		h.Inner = next
	case next.isCut() && next.Cut == h.Cut:
		share := h.Kids[i].Share
		kids := make([]Kid, len(next.Kids))
		for k, kid := range next.Kids {
			kids[k] = Kid{Share: share * kid.Share, Node: kid.Node}
		}
		h.Kids = slices.Concat(h.Kids[:i], kids, h.Kids[i+1:])
	default:
		h.Kids[i].Node = next
	}
}

// drop takes the kid i out of its cut h and gives its share to the kid to, or to every other kid in proportion to its share when to is
// -1. A cut left with one kid is replaced by that kid.
func (g *Grid) drop(h *Node, i, to int) {
	gone := h.Kids[i].Share
	if to >= 0 {
		h.Kids[to].Share += gone
	} else {
		for k := range h.Kids {
			if k != i {
				h.Kids[k].Share /= 1 - gone
			}
		}
	}
	h.Kids = slices.Delete(slices.Clone(h.Kids), i, i+1)
	if len(h.Kids) == 1 {
		g.put(h, h.Kids[0].Node)
	}
}

// cardsOf is the cards of a node in the order of the tree.
func cardsOf(n *Node) []*Node {
	switch {
	case n.isCut():
		out := []*Node{}
		for _, kid := range n.Kids {
			out = append(out, cardsOf(kid.Node)...)
		}
		return out
	case n.isBox():
		return cardsOf(n.Inner)
	}
	return []*Node{n}
}

// Cells is the earlier stored form of a layout, the lines and the cells: the reader of the layouts that the workbench stores until it
// stores the tree (F966-2-4 and F966-2-5 remove it).
type Cells struct {
	Xs     []float64       `json:"xs"`
	Ys     []float64       `json:"ys"`
	Cards  []Card          `json:"cards"`
	PaidBy map[string]Paid `json:"paidBy"`
}

// Paid is where a card of the earlier form took its space: the card To.
type Paid struct {
	Side string `json:"side"`
	To   string `json:"to"`
	Span string `json:"span,omitempty"`
	At   *int   `json:"at,omitempty"`
}

// CheckCells rejects lines and cells that cannot describe a plane and reports which field is wrong.
func CheckCells(state Cells) error {
	bad := func(why string) error { return errors.New("soksak: " + why) }
	for _, axis := range []struct {
		name  string
		lines []float64
	}{{"xs", state.Xs}, {"ys", state.Ys}} {
		if len(axis.lines) < 2 {
			return bad(axis.name + " needs at least two lines")
		}
		for i, v := range axis.lines {
			if !finite(v) {
				return bad(axis.name + "[" + itoa(i) + "] is " + jsString(v))
			}
			if i > 0 && v < axis.lines[i-1] {
				return bad(axis.name + "[" + itoa(i) + "] is before " + axis.name + "[" + itoa(i-1) + "]")
			}
		}
	}
	if len(state.Cards) == 0 {
		return bad("cards is empty")
	}
	seen := map[string]bool{}
	for _, c := range state.Cards {
		if c.ID == "" {
			return bad("a card has no id")
		}
		if seen[c.ID] {
			return bad("two cards are called " + c.ID)
		}
		seen[c.ID] = true
		for _, s := range []struct {
			lo, hi, axis string
			from, to     int
			lines        []float64
		}{{"c0", "c1", "xs", c.C0, c.C1, state.Xs}, {"r0", "r1", "ys", c.R0, c.R1, state.Ys}} {
			if s.from < 0 || s.to > len(s.lines)-1 {
				return bad(c.ID + "." + s.lo + "/" + s.hi + " is outside " + s.axis)
			}
			if s.to <= s.from {
				return bad(c.ID + "." + s.hi + " is not past " + c.ID + "." + s.lo)
			}
		}
	}
	return nil
}

// treeOfCells reads lines and cells as their slicing tree, the cut along x outside where the lines allow both, with the boxes of the
// host as boxes of the tree, so a host that still holds the earlier form installs it (F966-2-4 removes it).
func treeOfCells(cells Cells, boxes []Member) (State, error) {
	if err := CheckCells(cells); err != nil {
		return State{}, err
	}
	drawn := map[string]Rect{}
	root, err := planeTree(cells, boxes, drawn, []Axis{"x", "y"})
	if err != nil {
		return State{}, err
	}
	var convert func(n *cutNode) *Node
	convert = func(n *cutNode) *Node {
		if n.leaf {
			if n.inner != nil {
				return &Node{Box: n.id, Inner: convert(n.inner)}
			}
			return &Node{Card: n.card.ID, Data: n.card.Data, Fixed: n.card.Fixed, Width: n.card.Width, Height: n.card.Height}
		}
		lo, hi := ends(n.axis)
		total := n.old.get(hi) - n.old.get(lo)
		out := &Node{Cut: n.axis}
		for _, kid := range n.kids {
			out.Kids = append(out.Kids, Kid{Share: (kid.old.get(hi) - kid.old.get(lo)) / total, Node: convert(kid)})
		}
		return out
	}
	paid := map[string]string{}
	for id, p := range cells.PaidBy {
		paid[id] = p.To
	}
	return State{Root: convert(root), PaidBy: paid}, nil
}

// NewFromCells makes a grid from lines and cells of the earlier form, for the workbench until it stores the tree (F966-2-4).
func NewFromCells(cells Cells, options Options) (*Grid, error) {
	state, err := treeOfCells(cells, nil)
	if err != nil {
		return nil, err
	}
	return New(&state, options)
}

// Cells is the lines and the cells derived from the tree.
func (g *Grid) Cells() Cells {
	cards := make([]Card, len(g.list))
	for i, c := range g.list {
		cards[i] = copyCard(c)
	}
	paid := map[string]Paid{}
	for id, to := range g.paidBy {
		paid[id] = Paid{To: to}
	}
	return Cells{Xs: slices.Clone(g.xs), Ys: slices.Clone(g.ys), Cards: cards, PaidBy: paid}
}

// replaceCells installs lines and cells of the earlier form with the boxes of the host, for the group tree of the workbench until it
// keeps its group cards as boxes of the tree (F966-2-4).
func (g *Grid) replaceCells(cells Cells, boxes []Member) error {
	state, err := treeOfCells(cells, boxes)
	if err != nil {
		return err
	}
	return g.Replace(state)
}

// SetHeads sets the px that the host draws inside the top of each box of the tree by id, above its inner node, which the drawn sizes and
// the minimum of the cut operations count. The heads, like the frames, are no part of the state. It rejects an id that is no box of the
// tree and a head that is not a finite number from zero.
func (g *Grid) SetHeads(heads map[string]float64) error {
	for id, px := range heads {
		if !slices.ContainsFunc(g.boxes(), func(n *Node) bool { return n.Box == id }) {
			return errors.New("soksak: heads name " + strconv.Quote(id) + ", which is no box")
		}
		if !finite(px) || px < 0 {
			return errors.New("soksak: the head of " + strconv.Quote(id) + " is " + jsString(px))
		}
	}
	g.heads = maps.Clone(heads)
	return nil
}

// boxes is the boxes of the tree.
func (g *Grid) boxes() []*Node {
	out := []*Node{}
	var walk func(n *Node)
	walk = func(n *Node) {
		if n.isBox() {
			out = append(out, n)
			walk(n.Inner)
		}
		for _, kid := range n.Kids {
			walk(kid.Node)
		}
	}
	walk(g.root)
	return out
}

// sortedIDs is the ids of a set in order.
func sortedIDs(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for id := range set {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}
