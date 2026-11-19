package layout

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"sort"
)

// Even shares over the cuts of the slicing tree (packages/soksak/docs/layout.md#cuts), the port of cuts.ts of the layout library.
//
// A cut divides a rectangle along one axis into children: cards, boxes of the host and cuts along the other axis. Even gives every child
// of every cut an equal size. A size is a drawn size, the extent of the drawn rectangles of a child less on the y axis the heads above
// it, and the grid draws a slot at its span of the whole plane less its corridor, so a size is not a span: a plan lays every cut by equal
// spans, the grid draws the result, and correct moves each span by the difference between the size drawn and the equal size. A corridor
// does not change with the span, so one correction lays the sizes exactly; a nested cut takes one more. Coordinates within a billionth
// are one line (R1).

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

type extent struct{ x0, x1, y0, y1 float64 }

func (e extent) lo(axis Axis) float64 {
	if axis == "x" {
		return e.x0
	}
	return e.y0
}

func (e extent) hi(axis Axis) float64 {
	if axis == "x" {
		return e.x1
	}
	return e.y1
}

// along is the extent with its ends on axis replaced.
func (e extent) along(axis Axis, lo, hi float64) extent {
	if axis == "x" {
		e.x0, e.x1 = lo, hi
	} else {
		e.y0, e.y1 = lo, hi
	}
	return e
}

// cutNode is a node of the tree: a leaf, a card or a box with the tree of its members, or a cut along axis into kids.
type cutNode struct {
	leaf bool
	card *Card
	box  *Box
	// inner is the tree of the members of a box.
	inner *cutNode
	// held tells whether a leaf keeps its span on an axis: a fixed card, or a card with a px size there.
	held      map[Axis]bool
	axis      Axis
	kids      []*cutNode
	old, rect extent
	// above is the px of the heads above the node where it is laid.
	above float64
	// adjust is the correction of the span of each kid that correct found, in span.
	adjust []float64
}

func unionOf(es []extent) extent {
	out := extent{math.Inf(1), math.Inf(-1), math.Inf(1), math.Inf(-1)}
	for _, e := range es {
		out.x0, out.x1, out.y0, out.y1 = math.Min(out.x0, e.x0), math.Max(out.x1, e.x1), math.Min(out.y0, e.y0), math.Max(out.y1, e.y1)
	}
	return out
}

// holdsSpan tells whether a card keeps its span on an axis: fixed, or drawn at a px size there (R2).
func holdsSpan(c Card, axis Axis) bool {
	if c.Fixed {
		return true
	}
	if axis == "x" {
		return c.Width != nil && c.C1-c.C0 == 1
	}
	return c.Height != nil && c.R1-c.R0 == 1
}

var errNotSlicing = errors.New("the grid is not a slicing arrangement")

// buildCuts is the tree of a set of children, the cut along x taken first where the lines allow both.
func buildCuts(nodes []*cutNode) (*cutNode, error) {
	if len(nodes) == 1 {
		return nodes[0], nil
	}
	for _, axis := range []Axis{"x", "y"} {
		start, end := math.Inf(1), math.Inf(-1)
		for _, n := range nodes {
			start, end = math.Min(start, n.old.lo(axis)), math.Max(end, n.old.hi(axis))
		}
		at := []float64{}
		for _, n := range nodes {
			v := n.old.hi(axis)
			if v >= end || slices.Contains(at, v) {
				continue
			}
			clear := true
			for _, m := range nodes {
				if !(m.old.hi(axis) <= v || m.old.lo(axis) >= v) {
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
		olds := []extent{}
		for i := 0; i+1 < len(bounds); i++ {
			part := []*cutNode{}
			for _, n := range nodes {
				if n.old.lo(axis) >= bounds[i] && n.old.hi(axis) <= bounds[i+1] {
					part = append(part, n)
				}
			}
			kid, err := buildCuts(part)
			if err != nil {
				return nil, err
			}
			kids, olds = append(kids, kid), append(olds, kid.old)
		}
		old := unionOf(olds)
		return &cutNode{axis: axis, kids: kids, old: old, rect: old, adjust: make([]float64, len(kids))}, nil
	}
	return nil, errNotSlicing
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

func extentOf(s State, c Card) extent {
	return extent{s.Xs[c.C0], s.Xs[c.C1], s.Ys[c.R0], s.Ys[c.R1]}
}

func notMember(id string) error { return fmt.Errorf("card %s is not a member of the layout", id) }

// leavesOf is the leaves of the members of one box or of the plane.
func leavesOf(members []Member, s State, byID map[string]Card) ([]*cutNode, error) {
	out := []*cutNode{}
	for _, m := range members {
		if m.Box == nil {
			c, ok := byID[m.Card]
			if !ok {
				return nil, notMember(m.Card)
			}
			old := extentOf(s, c)
			out = append(out, &cutNode{leaf: true, card: &c, held: map[Axis]bool{"x": holdsSpan(c, "x"), "y": holdsSpan(c, "y")}, old: old,
				rect: old})
			continue
		}
		ids := contentsOf(m.Box)
		if len(ids) == 0 {
			return nil, notMember(m.Box.ID)
		}
		olds := []extent{}
		for _, id := range ids {
			c, ok := byID[id]
			if !ok {
				return nil, notMember(m.Box.ID)
			}
			olds = append(olds, extentOf(s, c))
		}
		kids, err := leavesOf(m.Box.Members, s, byID)
		if err != nil {
			return nil, err
		}
		inner, err := buildCuts(kids)
		if err != nil {
			return nil, err
		}
		old := unionOf(olds)
		out = append(out, &cutNode{leaf: true, box: m.Box, inner: inner, held: map[Axis]bool{}, old: old, rect: old})
	}
	return out, nil
}

func isHeldOn(n *cutNode, axis Axis) bool { return n.leaf && n.held[axis] }

// placeCuts lays a node into its rectangle: every cut gives its kids that keep no span equal spans and their corrections.
func placeCuts(n *cutNode, rect extent, above float64) {
	n.rect, n.above = rect, above
	if n.leaf {
		if n.inner != nil {
			placeCuts(n.inner, rect, above+n.box.Head)
		}
		return
	}
	axis := n.axis
	spans := make([]float64, len(n.kids))
	free, sharing := rect.hi(axis)-rect.lo(axis), 0
	for i, kid := range n.kids {
		spans[i] = kid.old.hi(axis) - kid.old.lo(axis)
		if isHeldOn(kid, axis) {
			free -= spans[i]
		} else {
			sharing++
		}
	}
	for i, kid := range n.kids {
		if !isHeldOn(kid, axis) && sharing > 0 {
			spans[i] = math.Max(0, math.Max(0, free)/float64(sharing)+n.adjust[i])
		}
	}
	at := rect.lo(axis)
	for i, kid := range n.kids {
		end := at + spans[i]
		if i == len(n.kids)-1 {
			end = rect.hi(axis)
		}
		kidAbove := 0.0
		if axis == "x" || i == 0 {
			kidAbove = above
		}
		placeCuts(kid, rect.along(axis, at, end), kidAbove)
		at = end
	}
}

// cardsOfNode is the card leaves of a node.
func cardsOfNode(n *cutNode) []*cutNode {
	if !n.leaf {
		out := []*cutNode{}
		for _, kid := range n.kids {
			out = append(out, cardsOfNode(kid)...)
		}
		return out
	}
	if n.inner != nil {
		return cardsOfNode(n.inner)
	}
	return []*cutNode{n}
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

// lineOf is the index of the line of v.
func lineOf(lines []float64, v float64) int {
	at := -1
	for i, line := range lines {
		if line <= v+eps {
			at = i
		}
	}
	return at
}

// cellsOf is the lines and cards of the laid tree: coordinates within eps are one line, and the cards keep the order of order.
func cellsOf(root *cutNode, order []Card) ([]float64, []float64, []Card) {
	laid := cardsOfNode(root)
	xv, yv := []float64{}, []float64{}
	at := map[string]extent{}
	for _, c := range laid {
		xv, yv = append(xv, c.rect.x0, c.rect.x1), append(yv, c.rect.y0, c.rect.y1)
		at[c.card.ID] = c.rect
	}
	xs, ys := linesOf(xv), linesOf(yv)
	cards := make([]Card, len(order))
	for i, c := range order {
		r := at[c.ID]
		c.C0, c.C1, c.R0, c.R1 = lineOf(xs, r.x0), lineOf(xs, r.x1), lineOf(ys, r.y0), lineOf(ys, r.y1)
		cards[i] = c
	}
	return xs, ys, cards
}

// correctCuts moves each span by the difference between the drawn size of its kid and the equal size, and returns the largest difference
// in px.
func correctCuts(root *cutNode, drawn map[string]Rect, rate func(Axis) float64) float64 {
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
		axis := n.axis
		each := rate(axis)
		sizes := make([]float64, len(n.kids))
		sharing := []int{}
		room := 0.0
		for i, kid := range n.kids {
			start, end := math.Inf(1), math.Inf(-1)
			for _, c := range cardsOfNode(kid) {
				r := drawn[c.card.ID]
				if axis == "x" {
					start, end = math.Min(start, r.X), math.Max(end, r.X+r.W)
				} else {
					start, end = math.Min(start, r.Y), math.Max(end, r.Y+r.H)
				}
			}
			sizes[i] = end - start
			if axis == "y" {
				sizes[i] -= kid.above
			}
			if !isHeldOn(kid, axis) {
				sharing = append(sharing, i)
				room += sizes[i]
			}
		}
		if !(each > 0) || len(sharing) == 0 {
			return
		}
		want := room / float64(len(sharing))
		for _, i := range sharing {
			e := sizes[i] - want
			worst = math.Max(worst, math.Abs(e))
			n.adjust[i] -= e / each
		}
	}
	visit(root)
	return worst
}

// Even gives every child of every cut an equal share (packages/soksak/docs/layout.md#cuts), with the paidBy records that the grid
// holds. The cards that no box holds and the boxes are the members of the plane; the members of a box have a tree of their own inside
// its rectangle, so no cut crosses a box. The plan lays its cuts, the grid draws them, and the plan corrects its spans by what was drawn
// until the largest error is below a thousandth of a px. An error changes nothing.
func (g *Grid) Even(boxes []Member) error {
	kept := g.ToJSON()
	byID := map[string]Card{}
	for _, c := range kept.Cards {
		byID[c.ID] = c
	}
	boxed := map[string]bool{}
	for _, m := range boxes {
		if m.Box == nil {
			return fmt.Errorf("the boxes hold the card %s, which is no box", m.Card)
		}
		for _, id := range contentsOf(m.Box) {
			boxed[id] = true
		}
	}
	members := []Member{}
	for _, c := range kept.Cards {
		if !boxed[c.ID] {
			members = append(members, Member{Card: c.ID})
		}
	}
	kids, err := leavesOf(append(members, boxes...), kept, byID)
	if err != nil {
		return err
	}
	root, err := buildCuts(kids)
	if err != nil {
		return err
	}
	lay := func() error {
		placeCuts(root, root.old, 0)
		xs, ys, cards := cellsOf(root, kept.Cards)
		if err := g.Replace(State{Xs: xs, Ys: ys, Cards: cards, PaidBy: kept.PaidBy}); err != nil {
			_ = g.Replace(kept) // silent: kept is the state the grid held, which its checks accepted.
			return err
		}
		return nil
	}
	rate := func(axis Axis) float64 { return sharePerSpan(g.plane(), axis) }
	for pass := 0; pass < 8; pass++ {
		if err := lay(); err != nil {
			return err
		}
		if correctCuts(root, g.Rects(), rate) < 1e-3 {
			return nil
		}
	}
	return lay()
}
