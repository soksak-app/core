package layout

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"sort"
	"strings"
)

// The two primitives of the rule of sizes over the slicing tree, and even shares (packages/soksak/docs/layout.md#cuts), the port of
// cuts.ts of the layout library.
//
// A cut divides a rectangle along one axis into children: cards, boxes of the host and cuts along the other axis. REMOVE (Withdraw) takes
// a member out of its cut, and the other children take its space in proportion to their sizes. ADD (Insert) puts a card beside a
// target: along the cut of the target, an even cut gives the card 1/(k+1) and keeps every ratio, and a cut that is not even takes half of
// the target for the card and keeps every other size; across it, the target is wrapped in a new cut of two halves. Even gives every child
// of every cut an equal share.
//
// A size is a drawn size, the extent of the drawn rectangles of a child less on the y axis the heads above it, and the grid draws a slot
// at its span of the whole plane less its corridor, so a size is not a span. An operation makes a plan: layout lays the changed cuts by
// their weights, the grid draws the result, and correct moves each laid span by the difference between the size drawn and the size the
// weights ask for. Only the children of a cut that an operation changes are laid again; every other card keeps its coordinates, and
// coordinates within a billionth are one line (R1). minimum judges the result: a node whose rectangle changed is refused below its
// minimum, computed recursively with heads and corridors as fixed costs.

// Box is a rectangle of the host that the tree keeps as one child, with the px of its head above its members.
type Box struct {
	ID      string   `json:"id"`
	Head    float64  `json:"head"`
	Members []Member `json:"members"`
}

// Member is a member of the plane or of a box: a card id, or a box.
type Member struct {
	Card string
	Box  *Box
}

// UnmarshalJSON reads a card id or a box.
func (m *Member) UnmarshalJSON(raw []byte) error {
	if bytes.HasPrefix(bytes.TrimSpace(raw), []byte(`"`)) {
		return json.Unmarshal(raw, &m.Card)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	m.Box = &Box{}
	return decoder.Decode(m.Box)
}

// MarshalJSON writes a card id or a box.
func (m Member) MarshalJSON() ([]byte, error) {
	if m.Box != nil {
		return json.Marshal(m.Box)
	}
	return json.Marshal(m.Card)
}

// Target is the target of an insert: one member id, or the ids that neighbouring children of one cut hold.
type Target []string

// UnmarshalJSON reads one id or a list of ids.
func (t *Target) UnmarshalJSON(raw []byte) error {
	if bytes.HasPrefix(bytes.TrimSpace(raw), []byte(`"`)) {
		var id string
		if err := json.Unmarshal(raw, &id); err != nil {
			return err
		}
		*t = Target{id}
		return nil
	}
	return json.Unmarshal(raw, (*[]string)(t))
}

// BareCard is a card without its spans.
type BareCard struct {
	ID     string          `json:"id"`
	Width  *float64        `json:"width,omitempty"`
	Height *float64        `json:"height,omitempty"`
	Fixed  bool            `json:"fixed"`
	Data   json.RawMessage `json:"data,omitempty"`
}

// LeftCard is a card that left with Withdraw, at the coordinates it had and with the rectangle it was drawn at.
type LeftCard struct {
	Card BareCard `json:"card"`
	X0   float64  `json:"x0"`
	X1   float64  `json:"x1"`
	Y0   float64  `json:"y0"`
	Y1   float64  `json:"y1"`
	Rect Rect     `json:"rect"`
}

// Piece is a card that Insert adds: a new card {id, data?} without cards, or what Withdraw returned: a card or a box with the cards
// inside it and the px of the heads that stood above it.
type Piece struct {
	ID    string          `json:"id"`
	Data  json.RawMessage `json:"data,omitempty"`
	Box   *Box            `json:"box"`
	Above float64         `json:"above"`
	Cards []LeftCard      `json:"cards"`
}

type extent struct{ x0, x1, y0, y1 float64 }

func (e extent) get(k string) float64 {
	switch k {
	case "x0":
		return e.x0
	case "x1":
		return e.x1
	case "y0":
		return e.y0
	}
	return e.y1
}

func (e *extent) set(k string, v float64) {
	switch k {
	case "x0":
		e.x0 = v
	case "x1":
		e.x1 = v
	case "y0":
		e.y0 = v
	default:
		e.y1 = v
	}
}

func ends(axis Axis) (string, string) {
	if axis == "x" {
		return "x0", "x1"
	}
	return "y0", "y1"
}

// cutNode is a node of the tree: a leaf, a card or a box with the tree of its members, or a cut along axis into kids.
type cutNode struct {
	leaf bool
	id   string
	card *BareCard
	box  *Box
	// inner is the tree of the members of a box.
	inner *cutNode
	// held tells whether a leaf keeps its span on an axis: a fixed card, or a card with a px size there.
	held map[Axis]bool
	axis Axis
	kids []*cutNode
	// dirty tells whether the operation changed the kids, so they are laid again; laid whether the last layout laid them.
	dirty, laid bool
	adjust      []float64
	old, rect   extent
	// drawn is the px rectangle of the node where it stood, and size its extent per axis.
	drawn extent
	size  map[Axis]float64
	// above is the px of the heads above the node where it stood, placedAbove where it is laid.
	above, placedAbove float64
	// weight is the weight among the kids of its cut, when an operation set one; otherwise its size.
	weight *float64
	// stored is the box node of the stored tree that a box leaf stands for, or nil for a box of the host that the tree does not store.
	stored *Node
}

func unionOf(es []extent) extent {
	out := extent{math.Inf(1), math.Inf(-1), math.Inf(1), math.Inf(-1)}
	for _, e := range es {
		out.x0, out.x1, out.y0, out.y1 = math.Min(out.x0, e.x0), math.Max(out.x1, e.x1), math.Min(out.y0, e.y0), math.Max(out.y1, e.y1)
	}
	return out
}

func sizeOfRects(rects []Rect) map[Axis]float64 {
	e := extentOfRects(rects)
	return map[Axis]float64{"x": e.x1 - e.x0, "y": e.y1 - e.y0}
}

func extentOfRects(rects []Rect) extent {
	x0, x1, y0, y1 := math.Inf(1), math.Inf(-1), math.Inf(1), math.Inf(-1)
	for _, r := range rects {
		x0, x1, y0, y1 = math.Min(x0, r.X), math.Max(x1, r.X+r.W), math.Min(y0, r.Y), math.Max(y1, r.Y+r.H)
	}
	return extent{x0, x1, y0, y1}
}

func bareOf(c Card) BareCard {
	return BareCard{ID: c.ID, Width: c.Width, Height: c.Height, Fixed: c.Fixed, Data: c.Data}
}

func holdsSpan(c BareCard, spans map[Axis]int, axis Axis) bool {
	if c.Fixed {
		return true
	}
	size := c.Width
	if axis == "y" {
		size = c.Height
	}
	return size != nil && spans[axis] == 1
}

// newCut is the cut of kids along axis. Its size is the extent of the drawn rectangles of its kids, so on its axis it holds the corridors
// between them, as the size that correctCuts reads of a kid that is a cut.
func newCut(axis Axis, kids []*cutNode, dirty bool) *cutNode {
	olds := make([]extent, len(kids))
	drawn := make([]extent, len(kids))
	for i, k := range kids {
		olds[i] = k.old
		drawn[i] = k.drawn
	}
	old, at := unionOf(olds), unionOf(drawn)
	return &cutNode{axis: axis, kids: kids, old: old, rect: old, drawn: at, size: map[Axis]float64{"x": at.x1 - at.x0, "y": at.y1 - at.y0},
		above: kids[0].above, dirty: dirty, adjust: make([]float64, len(kids))}
}

var errNotSlicing = errors.New("the grid is not a slicing arrangement")

// buildCuts is the tree of a set of children, the cut of prefer[0] taken first where the lines allow both.
func buildCuts(nodes []*cutNode, prefer []Axis) (*cutNode, error) {
	if len(nodes) == 1 {
		return nodes[0], nil
	}
	for _, axis := range prefer {
		lo, hi := ends(axis)
		end := math.Inf(-1)
		start := math.Inf(1)
		for _, n := range nodes {
			end = math.Max(end, n.old.get(hi))
			start = math.Min(start, n.old.get(lo))
		}
		seen := map[float64]bool{}
		at := []float64{}
		for _, n := range nodes {
			v := n.old.get(hi)
			if seen[v] || v >= end {
				continue
			}
			seen[v] = true
			clear := true
			for _, m := range nodes {
				if !(m.old.get(hi) <= v || m.old.get(lo) >= v) {
					clear = false
					break
				}
			}
			if clear {
				at = append(at, v)
			}
		}
		if len(at) == 0 {
			continue
		}
		sort.Float64s(at)
		bounds := append(append([]float64{start}, at...), end)
		kids := []*cutNode{}
		for i := 0; i+1 < len(bounds); i++ {
			part := []*cutNode{}
			for _, n := range nodes {
				if n.old.get(lo) >= bounds[i] && n.old.get(hi) <= bounds[i+1] {
					part = append(part, n)
				}
			}
			kid, err := buildCuts(part, prefer)
			if err != nil {
				return nil, err
			}
			kids = append(kids, kid)
		}
		return newCut(axis, kids, false), nil
	}
	return nil, errNotSlicing
}

// assignAbove sets the px of the heads above each node where it stands: the kids of a cut along x share it, a cut along y gives it to
// its first kid.
func assignAbove(n *cutNode, above float64) {
	n.above = above
	if n.leaf {
		if n.inner != nil {
			assignAbove(n.inner, above+n.box.Head)
		}
		return
	}
	for i, kid := range n.kids {
		if n.axis == "x" || i == 0 {
			assignAbove(kid, above)
		} else {
			assignAbove(kid, 0)
		}
	}
}

func cardLeaf(c BareCard, old extent, spans map[Axis]int, rect Rect) *cutNode {
	card := c
	return &cutNode{leaf: true, id: c.ID, card: &card, held: map[Axis]bool{"x": holdsSpan(c, spans, "x"), "y": holdsSpan(c, spans, "y")},
		old: old, rect: old, drawn: extentOfRects([]Rect{rect}), size: sizeOfRects([]Rect{rect})}
}

func boxLeaf(b *Box, inner *cutNode, old extent, rects []Rect) *cutNode {
	return &cutNode{leaf: true, id: b.ID, box: b, inner: inner, held: map[Axis]bool{}, old: old, rect: old, drawn: extentOfRects(rects),
		size: sizeOfRects(rects)}
}

// contentsOf is the card ids inside a box, through the boxes that it holds.
func contentsOf(b *Box) []string {
	out := []string{}
	for _, m := range b.Members {
		if m.Box != nil {
			out = append(out, contentsOf(m.Box)...)
		} else {
			out = append(out, m.Card)
		}
	}
	return out
}

func extentOf(s Cells, c Card) extent {
	return extent{s.Xs[c.C0], s.Xs[c.C1], s.Ys[c.R0], s.Ys[c.R1]}
}

func notMember(id string) error { return fmt.Errorf("card %s is not a member of the layout", id) }

// leavesOf is the leaves of the members of one box or of the plane, read from the state and its drawn rectangles.
func leavesOf(members []Member, s Cells, byID map[string]Card, drawn map[string]Rect, prefer []Axis) ([]*cutNode, error) {
	out := []*cutNode{}
	for _, m := range members {
		if m.Box == nil {
			c, ok := byID[m.Card]
			if !ok {
				return nil, notMember(m.Card)
			}
			out = append(out, cardLeaf(bareOf(c), extentOf(s, c), map[Axis]int{"x": c.C1 - c.C0, "y": c.R1 - c.R0}, drawn[m.Card]))
			continue
		}
		ids := contentsOf(m.Box)
		if len(ids) == 0 {
			return nil, notMember(m.Box.ID)
		}
		olds, rects := []extent{}, []Rect{}
		for _, id := range ids {
			c, ok := byID[id]
			if !ok {
				return nil, notMember(m.Box.ID)
			}
			olds, rects = append(olds, extentOf(s, c)), append(rects, drawn[id])
		}
		kids, err := leavesOf(m.Box.Members, s, byID, drawn, prefer)
		if err != nil {
			return nil, err
		}
		inner, err := buildCuts(kids, prefer)
		if err != nil {
			return nil, err
		}
		out = append(out, boxLeaf(m.Box, inner, unionOf(olds), rects))
	}
	return out, nil
}

// planeTree is the tree of the plane: the cards that no box holds and the boxes, each box with the tree of its members.
func planeTree(s Cells, boxes []Member, drawn map[string]Rect, prefer []Axis) (*cutNode, error) {
	byID := map[string]Card{}
	for _, c := range s.Cards {
		byID[c.ID] = c
	}
	boxed := map[string]bool{}
	for _, m := range boxes {
		if m.Box == nil {
			return nil, fmt.Errorf("the boxes hold the card %s, which is no box", m.Card)
		}
		for _, id := range contentsOf(m.Box) {
			boxed[id] = true
		}
	}
	members := []Member{}
	for _, c := range s.Cards {
		if !boxed[c.ID] {
			members = append(members, Member{Card: c.ID})
		}
	}
	members = append(members, boxes...)
	kids, err := leavesOf(members, s, byID, drawn, prefer)
	if err != nil {
		return nil, err
	}
	root, err := buildCuts(kids, prefer)
	if err != nil {
		return nil, err
	}
	assignAbove(root, 0)
	return root, nil
}

// found is the node of a member, the cut that holds it, and the box leaf whose tree holds it (nil for the plane).
type found struct {
	node, cut, owner *cutNode
}

// memberIDs is the ids of the leaves of a node in its own tree, without the members inside its boxes.
func memberIDs(n *cutNode) []string {
	if n.leaf {
		return []string{n.id}
	}
	out := []string{}
	for _, kid := range n.kids {
		out = append(out, memberIDs(kid)...)
	}
	return out
}

func sizeAlong(n *cutNode, axis Axis) float64 {
	if axis == "y" {
		return n.size[axis] - n.above
	}
	return n.size[axis]
}

func isHeldOn(n *cutNode, axis Axis) bool { return n.leaf && n.held[axis] }

func weightOf(n *cutNode, axis Axis) float64 {
	if n.weight != nil {
		return *n.weight
	}
	return sizeAlong(n, axis)
}

func weighed(v float64) *float64 { return &v }

// placeCuts lays a node into its rectangle, and the kids of a cut that changed or whose rectangle moved on its axis by their weights.
func placeCuts(n *cutNode, rect extent, above float64) {
	n.rect = rect
	n.placedAbove = above
	if n.leaf {
		if n.inner != nil {
			placeCuts(n.inner, rect, above+n.box.Head)
		}
		return
	}
	lo, hi := ends(n.axis)
	kept := !n.dirty && rect.get(lo) == n.old.get(lo) && rect.get(hi) == n.old.get(hi) && above == n.above
	n.laid = !kept
	spans := make([]float64, len(n.kids))
	for i, kid := range n.kids {
		spans[i] = kid.old.get(hi) - kid.old.get(lo)
	}
	if !kept {
		free := rect.get(hi) - rect.get(lo)
		total, sharing := 0.0, 0
		for i, kid := range n.kids {
			if isHeldOn(kid, n.axis) {
				free -= spans[i]
				continue
			}
			total += weightOf(kid, n.axis)
			sharing++
		}
		for i, kid := range n.kids {
			if isHeldOn(kid, n.axis) {
				continue
			}
			share := 1 / float64(sharing)
			if total > 0 {
				share = weightOf(kid, n.axis) / total
			}
			spans[i] = math.Max(0, math.Max(0, free)*share+n.adjust[i])
		}
	}
	at := rect.get(lo)
	for i, kid := range n.kids {
		from, end := at, at+spans[i]
		if kept {
			from, end = kid.old.get(lo), kid.old.get(hi)
		} else if i == len(n.kids)-1 {
			end = rect.get(hi)
		}
		part := rect
		part.set(lo, from)
		part.set(hi, end)
		kidAbove := 0.0
		if n.axis == "x" || i == 0 {
			kidAbove = above
		}
		placeCuts(kid, part, kidAbove)
		at = end
	}
}

type laidCard struct {
	card BareCard
	at   extent
}

// cardsOfNode is the cards of a node with the coordinates that placeCuts gave them, or that they had.
func cardsOfNode(n *cutNode, laid bool) []laidCard {
	if !n.leaf {
		out := []laidCard{}
		for _, kid := range n.kids {
			out = append(out, cardsOfNode(kid, laid)...)
		}
		return out
	}
	if n.inner != nil {
		return cardsOfNode(n.inner, laid)
	}
	if laid {
		return []laidCard{{*n.card, n.rect}}
	}
	return []laidCard{{*n.card, n.old}}
}

// linesOf is the lines of coordinates: coordinates within eps of the line before are that line, because two cuts laid alike, such as two
// rows of equal shares, reach one coordinate through different sums.
func linesOf(values []float64) []float64 {
	sorted := slices.Clone(values)
	sort.Float64s(sorted)
	out := []float64{}
	for _, v := range sorted {
		if len(out) == 0 || v-out[len(out)-1] >= eps {
			out = append(out, v)
		}
	}
	return out
}

// lineOf is the index of the line of v in the ascending lines: the last line at or below v within eps, or -1.
func lineOf(lines []float64, v float64) int {
	return sort.Search(len(lines), func(i int) bool { return lines[i] > v+eps }) - 1
}

// nodeOfCut is the node of the stored tree of a laid node: a cut takes the shares of the rectangles its kids were laid at, a kid cut along
// the axis of its cut gives that cut its kids and a cut of one kid is that kid, so the tree stays canonical, and a box of the host that the
// tree does not store is its inner node.
func nodeOfCut(n *cutNode) *Node {
	if n.leaf {
		if n.inner != nil {
			inner := nodeOfCut(n.inner)
			if n.stored != nil {
				return &Node{Box: n.id, Data: n.stored.Data, Inner: inner}
			}
			return inner
		}
		c := n.card
		return cardNode(Card{ID: c.ID, Width: c.Width, Height: c.Height, Fixed: c.Fixed, Data: c.Data})
	}
	lo, hi := ends(n.axis)
	total := n.rect.get(hi) - n.rect.get(lo)
	out := &Node{Cut: n.axis}
	for _, kid := range n.kids {
		share := (kid.rect.get(hi) - kid.rect.get(lo)) / total
		node := nodeOfCut(kid)
		if node.isCut() && node.Cut == n.axis {
			for _, k := range node.Kids {
				out.Kids = append(out.Kids, Kid{Share: share * k.Share, Node: k.Node})
			}
			continue
		}
		out.Kids = append(out.Kids, Kid{Share: share, Node: node})
	}
	if len(out.Kids) == 1 {
		return out.Kids[0].Node
	}
	return out
}

// cutTree is the tree of the operations of the cuts read from the stored tree, with the drawn rectangles and the heads, and with each box
// of the host around the node of its members: one node, or the neighbouring kids of one cut, which become a cut of their own inside it.
func (g *Grid) cutTree(boxes []Member, drawn map[string]Rect) (*cutTree, error) {
	var convert func(n *Node) *cutNode
	convert = func(n *Node) *cutNode {
		l := g.at[n]
		old := extent{g.xs[l[0]], g.xs[l[1]], g.ys[l[2]], g.ys[l[3]]}
		switch {
		case n.isCut():
			kids := make([]*cutNode, len(n.Kids))
			for i, kid := range n.Kids {
				kids[i] = convert(kid.Node)
			}
			return newCut(n.Cut, kids, false)
		case n.isBox():
			rects := []Rect{}
			for _, c := range cardsOf(n) {
				rects = append(rects, drawn[c.Card])
			}
			leaf := boxLeaf(&Box{ID: n.Box, Head: g.heads[n.Box], Members: []Member{}}, convert(n.Inner), old, rects)
			leaf.stored = n
			return leaf
		}
		c := g.find(n.Card)
		return cardLeaf(bareOf(*c), old, map[Axis]int{"x": c.C1 - c.C0, "y": c.R1 - c.R0}, drawn[n.Card])
	}
	tree := newCutTree(convert(g.root))
	var overlay func(b *Box) error
	overlay = func(b *Box) error {
		ids := []string{}
		for _, m := range b.Members {
			if m.Box != nil {
				if err := overlay(m.Box); err != nil {
					return err
				}
				ids = append(ids, m.Box.ID)
			} else {
				ids = append(ids, m.Card)
			}
		}
		if len(ids) == 0 {
			return notMember(b.ID)
		}
		f, err := tree.targetNode(ids)
		if err != nil {
			return err
		}
		rects := []Rect{}
		for _, c := range cardsOfNode(f.node, false) {
			rects = append(rects, drawn[c.card.ID])
		}
		tree.replaceNode(f, boxLeaf(b, f.node, f.node.old, rects))
		return nil
	}
	for _, m := range boxes {
		if m.Box == nil {
			return nil, fmt.Errorf("the boxes hold the card %s, which is no box", m.Card)
		}
		if err := overlay(m.Box); err != nil {
			return nil, err
		}
	}
	assignAbove(tree.root, 0)
	return tree, nil
}

// correctCuts moves each span that the last layout laid by the difference between its drawn size and the size its weight asks for,
// and returns the largest difference in px.
func correctCuts(root *cutNode, at drawnAt, rate func(Axis) float64) float64 {
	worst := 0.0
	var visit func(n *cutNode)
	visit = func(n *cutNode) {
		if n.leaf {
			if n.inner != nil {
				visit(n.inner)
			}
			return
		}
		for _, kid := range n.kids {
			visit(kid)
		}
		if !n.laid {
			return
		}
		each := rate(n.axis)
		if !(each > 0) {
			return
		}
		sizes := make([]float64, len(n.kids))
		total, room := 0.0, 0.0
		sharing := []int{}
		for i, kid := range n.kids {
			sizes[i] = at.size(kid, n.axis)
			if n.axis == "y" {
				sizes[i] -= kid.placedAbove
			}
			if !isHeldOn(kid, n.axis) {
				sharing = append(sharing, i)
				total += weightOf(kid, n.axis)
				room += sizes[i]
			}
		}
		for _, i := range sharing {
			want := room / float64(len(sharing))
			if total > 0 {
				want = room * weightOf(n.kids[i], n.axis) / total
			}
			e := sizes[i] - want
			worst = math.Max(worst, math.Abs(e))
			n.adjust[i] -= e / each
		}
	}
	visit(root)
	return worst
}

// arrivingNode is the node of what arrives: a new card, or a card or a box that left, with the tree of its members at the place it
// left.
func arrivingNode(p Piece) (*cutNode, error) {
	if p.Cards == nil {
		return cardLeaf(BareCard{ID: p.ID, Data: p.Data}, extent{}, map[Axis]int{"x": 1, "y": 1}, Rect{}), nil
	}
	if p.Box == nil {
		only := p.Cards[0]
		leaf := cardLeaf(only.Card, extent{only.X0, only.X1, only.Y0, only.Y1}, map[Axis]int{"x": 1, "y": 1}, only.Rect)
		leaf.above = p.Above
		return leaf, nil
	}
	axisLines := func(get func(LeftCard) [2]float64) []float64 {
		seen := map[float64]bool{}
		out := []float64{}
		for _, c := range p.Cards {
			for _, v := range get(c) {
				if !seen[v] {
					seen[v] = true
					out = append(out, v)
				}
			}
		}
		sort.Float64s(out)
		return out
	}
	xs := axisLines(func(c LeftCard) [2]float64 { return [2]float64{c.X0, c.X1} })
	ys := axisLines(func(c LeftCard) [2]float64 { return [2]float64{c.Y0, c.Y1} })
	s := Cells{Xs: xs, Ys: ys}
	byID := map[string]Card{}
	drawn := map[string]Rect{}
	olds, rects := []extent{}, []Rect{}
	for _, c := range p.Cards {
		card := Card{ID: c.Card.ID, Width: c.Card.Width, Height: c.Card.Height, Fixed: c.Card.Fixed, Data: c.Card.Data,
			C0: slices.Index(xs, c.X0), C1: slices.Index(xs, c.X1), R0: slices.Index(ys, c.Y0), R1: slices.Index(ys, c.Y1)}
		s.Cards = append(s.Cards, card)
		byID[card.ID] = card
		drawn[card.ID] = c.Rect
		olds, rects = append(olds, extent{c.X0, c.X1, c.Y0, c.Y1}), append(rects, c.Rect)
	}
	prefer := []Axis{"x", "y"}
	kids, err := leavesOf(p.Box.Members, s, byID, drawn, prefer)
	if err != nil {
		return nil, err
	}
	inner, err := buildCuts(kids, prefer)
	if err != nil {
		return nil, err
	}
	leaf := boxLeaf(p.Box, inner, unionOf(olds), rects)
	assignAbove(leaf, p.Above)
	// The members of the box are laid again in its new rectangle by the sizes they had.
	var mark func(n *cutNode)
	mark = func(n *cutNode) {
		if n.leaf {
			return
		}
		n.dirty = true
		for _, kid := range n.kids {
			mark(kid)
		}
	}
	mark(inner)
	return leaf, nil
}

// takenIDs is the ids that the grid and the boxes hold: every card and every box.
func (g *Grid) takenIDs(boxes []Member) map[string]bool {
	out := map[string]bool{}
	var stored func(n *Node)
	stored = func(n *Node) {
		out[n.id()] = true
		if n.isBox() {
			stored(n.Inner)
		}
		for _, kid := range n.Kids {
			stored(kid.Node)
		}
	}
	stored(g.root)
	var walk func(b *Box)
	walk = func(b *Box) {
		out[b.ID] = true
		for _, m := range b.Members {
			if m.Box != nil {
				walk(m.Box)
			}
		}
	}
	for _, m := range boxes {
		if m.Box != nil {
			walk(m.Box)
		}
	}
	delete(out, "")
	return out
}

// cutTree is a tree of the operations of the cuts with an index of its nodes: the node of each id, and the cut or the box leaf that holds
// each node, so a lookup reads the index and does not walk the tree.
type cutTree struct {
	root   *cutNode
	byID   map[string]*cutNode
	parent map[*cutNode]*cutNode
	owner  map[*cutNode]*cutNode
}

// newCutTree is the tree of root with its index.
func newCutTree(root *cutNode) *cutTree {
	t := &cutTree{root: root, byID: map[string]*cutNode{}, parent: map[*cutNode]*cutNode{}, owner: map[*cutNode]*cutNode{}}
	t.enter(root, nil, nil)
	return t
}

// enter adds n and the nodes below it to the index, held by the cut parent inside the box leaf owner.
func (t *cutTree) enter(n, parent, owner *cutNode) {
	if parent != nil {
		t.parent[n] = parent
	} else {
		delete(t.parent, n)
	}
	if owner != nil {
		t.owner[n] = owner
	} else {
		delete(t.owner, n)
	}
	if n.leaf {
		t.byID[n.id] = n
		if n.inner != nil {
			t.enter(n.inner, nil, n)
		}
		return
	}
	for _, kid := range n.kids {
		t.enter(kid, n, owner)
	}
}

// find is the found node of id, or nil.
func (t *cutTree) find(id string) *found {
	n, ok := t.byID[id]
	if !ok {
		return nil
	}
	return &found{n, t.parent[n], t.owner[n]}
}

// replaceNode puts next where the found node stood: in its cut, or as the root of the tree of a box or of the plane.
func (t *cutTree) replaceNode(f *found, next *cutNode) {
	t.enter(next, f.cut, f.owner)
	switch {
	case f.cut != nil:
		f.cut.kids[slices.Index(f.cut.kids, f.node)] = next
	case f.owner != nil:
		f.owner.inner = next
	default:
		t.root = next
	}
}

// targetNode is the target of an insert: the node of one member, or the neighbouring kids of one cut that hold exactly the members of
// the list, which become a cut of their own inside it.
func (t *cutTree) targetNode(list []string) (*found, error) {
	hits := []*found{}
	for _, id := range list {
		hit := t.find(id)
		if hit == nil {
			return nil, notMember(id)
		}
		hits = append(hits, hit)
	}
	if len(list) == 1 {
		return hits[0], nil
	}
	refused := fmt.Errorf("cards %s are not neighbours of one cut", strings.Join(list, ", "))
	owner := hits[0].owner
	// The holder is the lowest cut above every member: the cuts above the first member, and the first of them that each other member
	// reaches as it climbs. The climb stays inside the tree of the box that holds the first member.
	above := map[*cutNode]int{}
	depth := 0
	for at := t.parent[hits[0].node]; at != nil; at = t.parent[at] {
		above[at] = depth
		depth++
	}
	var holder *cutNode
	low := -1
	for _, hit := range hits[1:] {
		if hit.owner != owner {
			return nil, refused
		}
		at := t.parent[hit.node]
		for at != nil {
			if _, ok := above[at]; ok {
				break
			}
			at = t.parent[at]
		}
		if at == nil {
			return nil, refused
		}
		if above[at] > low {
			holder, low = at, above[at]
		}
	}
	if holder == nil {
		return nil, refused
	}
	// touched is the indices of the kids of the holder that hold a member, each read by the climb of the member to the holder.
	index := make(map[*cutNode]int, len(holder.kids))
	for i, kid := range holder.kids {
		index[kid] = i
	}
	seen := map[int]bool{}
	touched := []int{}
	for _, hit := range hits {
		at := hit.node
		for t.parent[at] != holder {
			at = t.parent[at]
		}
		if i := index[at]; !seen[i] {
			seen[i] = true
			touched = append(touched, i)
		}
	}
	slices.Sort(touched)
	first, last := touched[0], touched[len(touched)-1]
	span := slices.Clone(holder.kids[first : last+1])
	listed := make(map[string]bool, len(list))
	for _, id := range list {
		listed[id] = true
	}
	held := []string{}
	for _, kid := range span {
		held = append(held, memberIDs(kid)...)
	}
	if len(held) != len(listed) {
		return nil, refused
	}
	for _, id := range held {
		if !listed[id] {
			return nil, refused
		}
	}
	if first == 0 && last == len(holder.kids)-1 {
		return &found{holder, t.parent[holder], owner}, nil
	}
	sub := newCut(holder.axis, span, false)
	w := 0.0
	for _, kid := range span {
		w += weightOf(kid, holder.axis)
	}
	sub.weight = weighed(w)
	holder.kids = slices.Concat(holder.kids[:first], []*cutNode{sub}, holder.kids[last+1:])
	t.enter(sub, holder, owner)
	holder.adjust = make([]float64, len(holder.kids))
	return &found{sub, holder, owner}, nil
}

// evenWithin is the difference in px under which the sizes of the children of a cut are equal, so the cut is even.
const evenWithin = 0.5

// isEvenCut tells whether the children of a cut that keep no span on its axis have one size.
func isEvenCut(into *cutNode) bool {
	first := math.NaN()
	for _, kid := range into.kids {
		if isHeldOn(kid, into.axis) {
			continue
		}
		w := weightOf(kid, into.axis)
		if math.IsNaN(first) {
			first = w
		} else if math.Abs(w-first) >= evenWithin {
			return false
		}
	}
	return true
}

// addBeside adds the node arriving beside the found node toward side. Along the cut of the target, an even cut gives it 1/(k+1) and keeps
// every ratio; a cut that is not even takes half of the target less the new corridor, gap, the child toward side when the target is the
// cut itself, and keeps every other size. Across the cut, the target is wrapped in a new cut of two halves.
func (t *cutTree) addBeside(f *found, side Side, arriving *cutNode, gap float64) {
	axis := axisOf(side)
	after := side == "right" || side == "bottom"
	insertInto := func(into *cutNode, at int, payer *cutNode) {
		even := isEvenCut(into)
		total, sharing := 0.0, 0
		for _, kid := range into.kids {
			if isHeldOn(kid, axis) {
				continue
			}
			kid.weight = weighed(weightOf(kid, axis))
			total += *kid.weight
			sharing++
		}
		switch {
		case !even && !isHeldOn(payer, axis):
			// The new corridor comes out of the target too, so every other child keeps its drawn size.
			payer.weight = weighed(math.Max(0, *payer.weight-gap) / 2)
			arriving.weight = weighed(*payer.weight)
		case sharing > 0:
			arriving.weight = weighed(total / float64(sharing))
		default:
			arriving.weight = weighed(1)
		}
		into.kids = slices.Insert(into.kids, at, arriving)
		into.adjust = make([]float64, len(into.kids))
		into.dirty = true
	}
	if !f.node.leaf && f.node.axis == axis {
		if after {
			insertInto(f.node, len(f.node.kids), f.node.kids[len(f.node.kids)-1])
		} else {
			insertInto(f.node, 0, f.node.kids[0])
		}
		return
	}
	if f.cut != nil && f.cut.axis == axis {
		at := slices.Index(f.cut.kids, f.node)
		if after {
			at++
		}
		insertInto(f.cut, at, f.node)
		return
	}
	var weight *float64
	if f.cut != nil {
		weight = weighed(weightOf(f.node, f.cut.axis))
	}
	f.node.weight = weighed(1)
	arriving.weight = weighed(1)
	kids := []*cutNode{arriving, f.node}
	if after {
		kids = []*cutNode{f.node, arriving}
	}
	next := newCut(axis, kids, true)
	next.old, next.rect, next.drawn, next.size, next.above, next.weight = f.node.old, f.node.old, f.node.drawn, f.node.size, f.node.above, weight
	t.replaceNode(f, next)
}

// drawnAt is the px rectangle in which each node of a tree is drawn: the extent of the drawn rectangles of its cards.
type drawnAt map[*cutNode]extent

func (at drawnAt) size(n *cutNode, axis Axis) float64 {
	e := at[n]
	lo, hi := ends(axis)
	return e.get(hi) - e.get(lo)
}

// drawnExtents reads the drawn rectangle of every node of the tree of root in one walk, each node from its kids.
func drawnExtents(root *cutNode, drawn map[string]Rect) drawnAt {
	at := drawnAt{}
	var walk func(n *cutNode) extent
	walk = func(n *cutNode) extent {
		var e extent
		switch {
		case n.leaf && n.inner != nil:
			e = walk(n.inner)
		case n.leaf:
			e = extentOfRects([]Rect{drawn[n.card.ID]})
		default:
			parts := make([]extent, len(n.kids))
			for i, kid := range n.kids {
				parts[i] = walk(kid)
			}
			e = unionOf(parts)
		}
		at[n] = e
		return e
	}
	walk(root)
	return at
}

// need is the size that a node needs on an axis, in the px of the grid rectangles: a card its minimum and on y the heads drawn inside its
// rectangle; a box the need of its members; a cut along the axis the needs of its children and the corridors between them; a cut across
// it the largest need of its children. A child that keeps its span needs the size it is drawn at.
func need(n *cutNode, axis Axis, at drawnAt, min float64) float64 {
	extent := func(m *cutNode) float64 { return at.size(m, axis) }
	if n.leaf {
		switch {
		case n.inner != nil:
			return need(n.inner, axis, at, min)
		case n.held[axis]:
			return extent(n)
		case axis == "y":
			return min + n.placedAbove
		}
		return min
	}
	if n.axis != axis {
		most := 0.0
		for _, kid := range n.kids {
			most = math.Max(most, need(kid, axis, at, min))
		}
		return most
	}
	sum, kids := 0.0, 0.0
	for _, kid := range n.kids {
		sum += need(kid, axis, at, min)
		kids += extent(kid)
	}
	return sum + extent(n) - kids
}

// belowMinimum is the text of the outermost node whose rectangle the plan changed and that is drawn below its minimum, or "".
func belowMinimum(n *cutNode, at drawnAt, min float64) string {
	moved := math.Abs(n.rect.x0-n.old.x0) > eps || math.Abs(n.rect.x1-n.old.x1) > eps || math.Abs(n.rect.y0-n.old.y0) > eps ||
		math.Abs(n.rect.y1-n.old.y1) > eps
	if n.leaf && (moved || n.laid) {
		has := map[Axis]float64{"x": at.size(n, "x"), "y": at.size(n, "y")}
		nx, ny := need(n, "x", at, min), need(n, "y", at, min)
		if has["x"] < nx-evenWithin || has["y"] < ny-evenWithin {
			return fmt.Sprintf("card %s would be %s, below its minimum %s", n.id, sizeText(has["x"], has["y"]), sizeText(nx, ny))
		}
	}
	if n.leaf {
		if n.inner != nil {
			return belowMinimum(n.inner, at, min)
		}
		return ""
	}
	for _, kid := range n.kids {
		if text := belowMinimum(kid, at, min); text != "" {
			return text
		}
	}
	return ""
}

// cutPlan is an operation laid out: install lays its tree and puts it into the grid, correct reads its drawing and returns the largest
// error in px, and minimum judges the result.
type cutPlan struct {
	tree *cutTree
}

func (p cutPlan) install(g *Grid) error {
	placeCuts(p.tree.root, p.tree.root.old, 0)
	state := State{Root: nodeOfCut(p.tree.root), PaidBy: g.paidBy}
	if err := CheckState(state); err != nil {
		return err
	}
	g.root = state.Root
	g.derive()
	g.agreeSizes()
	g.commit()
	return nil
}

func (p cutPlan) correct(drawn map[string]Rect, rate func(Axis) float64) float64 {
	return correctCuts(p.tree.root, drawnExtents(p.tree.root, drawn), rate)
}

func (p cutPlan) minimum(drawn map[string]Rect, min float64) string {
	return belowMinimum(p.tree.root, drawnExtents(p.tree.root, drawn), min)
}

// byCuts installs the plan that make makes of the stored tree and its drawn rectangles. The plan lays its cuts, the grid draws them, and
// the plan corrects its spans by what was drawn until the largest error is below a thousandth of a px. With judged, a result that draws a
// changed node below its minimum is refused with its text. An error puts the arrangement back.
func (g *Grid) byCuts(make func(drawn map[string]Rect) (cutPlan, error), judged bool) error {
	kept := g.ToJSON()
	plan, err := make(g.Rects())
	if err != nil {
		return err
	}
	rate := func(axis Axis) float64 { return sharePerSpan(g.plane(), axis) }
	for pass := 0; ; pass++ {
		if err := plan.install(g); err != nil {
			// kept is the state that the grid held, which its checks accepted, so restore loads it without a check.
			g.restore(kept)
			return err
		}
		if plan.correct(g.Rects(), rate) < 1e-3 || pass == 7 {
			break
		}
	}
	if judged {
		if text := plan.minimum(g.Rects(), g.min); text != "" {
			g.restore(kept)
			return errors.New(text)
		}
	}
	clear(g.splitMemo)
	return nil
}

// Insert adds piece, a new card or what Withdraw returned, beside target toward side by ADD and returns its id
// (packages/soksak/docs/layout.md#cuts). An error, a result below a minimum included, changes nothing.
func (g *Grid) Insert(boxes []Member, target Target, side Side, piece Piece) (string, error) {
	if !slices.Contains([]string{"left", "right", "top", "bottom"}, side) {
		return "", fmt.Errorf("unknown side %s; use left, right, top or bottom", side)
	}
	err := g.byCuts(func(drawn map[string]Rect) (cutPlan, error) {
		taken := g.takenIDs(boxes)
		arriving := []string{piece.ID}
		for _, c := range piece.Cards {
			arriving = append(arriving, c.Card.ID)
		}
		for _, id := range arriving {
			if taken[id] {
				return cutPlan{}, fmt.Errorf("card %s is a member of the layout", id)
			}
		}
		tree, err := g.cutTree(boxes, drawn)
		if err != nil {
			return cutPlan{}, err
		}
		f, err := tree.targetNode(target)
		if err != nil {
			return cutPlan{}, err
		}
		node, err := arrivingNode(piece)
		if err != nil {
			return cutPlan{}, err
		}
		tree.addBeside(f, side, node, g.gap)
		return cutPlan{tree}, nil
	}, true)
	if err != nil {
		return "", err
	}
	return piece.ID, nil
}

// Withdraw takes the member id, a card or a box, out of its cut by P1: the other kids take its space in proportion to their sizes. It
// returns what left, which Insert takes (packages/soksak/docs/layout.md#cuts). An error changes nothing.
func (g *Grid) Withdraw(boxes []Member, id string) (Piece, error) {
	var left Piece
	err := g.byCuts(func(drawn map[string]Rect) (cutPlan, error) {
		tree, err := g.cutTree(boxes, drawn)
		if err != nil {
			return cutPlan{}, err
		}
		f := tree.find(id)
		if f == nil {
			return cutPlan{}, notMember(id)
		}
		if f.node.leaf && f.node.card != nil && f.node.card.Fixed {
			return cutPlan{}, fmt.Errorf("card %s is fixed and does not leave", id)
		}
		standing := cardsOfNode(f.node, false)
		gone := map[string]bool{}
		for _, c := range standing {
			gone[c.card.ID] = true
		}
		last := true
		for _, c := range g.list {
			if !c.Fixed && !gone[c.ID] {
				last = false
			}
		}
		if f.cut == nil || last {
			return cutPlan{}, fmt.Errorf("card %s is the last card of the layout", id)
		}
		axis := f.cut.axis
		rest := []*cutNode{}
		takes := false
		for _, kid := range f.cut.kids {
			if kid != f.node {
				rest = append(rest, kid)
				takes = takes || !isHeldOn(kid, axis)
			}
		}
		if !takes {
			return cutPlan{}, fmt.Errorf("card %s leaves no card of its cut that takes its space", id)
		}
		left = Piece{ID: id, Above: f.node.above, Cards: []LeftCard{}}
		if f.node.leaf {
			left.Box = f.node.box
		}
		for _, c := range standing {
			left.Cards = append(left.Cards, LeftCard{Card: c.card, X0: c.at.x0, X1: c.at.x1, Y0: c.at.y0, Y1: c.at.y1, Rect: drawn[c.card.ID]})
		}
		for _, kid := range rest {
			if !isHeldOn(kid, axis) {
				kid.weight = weighed(weightOf(kid, axis))
			}
		}
		// A cut left with one kid lays it across its whole rectangle.
		f.cut.kids = rest
		f.cut.adjust = make([]float64, len(rest))
		f.cut.dirty = true
		return cutPlan{tree}, nil
	}, true)
	return left, err
}

// Even gives every kid of every cut an equal share (packages/soksak/docs/layout.md#cuts). An error changes nothing.
func (g *Grid) Even(boxes []Member) error {
	return g.byCuts(func(drawn map[string]Rect) (cutPlan, error) {
		tree, err := g.cutTree(boxes, drawn)
		if err != nil {
			return cutPlan{}, err
		}
		root := tree.root
		var mark func(n *cutNode)
		mark = func(n *cutNode) {
			if n.leaf {
				if n.inner != nil {
					mark(n.inner)
				}
				return
			}
			n.dirty = true
			for _, kid := range n.kids {
				kid.weight = weighed(1)
				mark(kid)
			}
		}
		mark(root)
		return cutPlan{tree}, nil
	}, true)
}
