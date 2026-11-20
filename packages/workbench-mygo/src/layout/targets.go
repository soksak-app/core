package layout

import (
	"math"
	"slices"
	"strings"
)

// DropTarget is where a drop lands by the target search of the rule of sizes (docs/spec/groups.md#target-search): Kind "add" is the
// ADD of the moving card beside Target toward Side, a card, a box, or the ids of the kids of a cut; "strip" and "centre" are the tab
// strip and the centre of the content card Card. Band is the index of the band of the add from the outermost, and Of the number of
// bands on its line.
type DropTarget struct {
	Kind   string `json:"kind"`
	Target Target `json:"target,omitempty"`
	Side   Side   `json:"side,omitempty"`
	Card   string `json:"card,omitempty"`
	Band   int    `json:"band"`
	Of     int    `json:"of"`
}

// TargetOptions are the measures of the target search: the height of the tab strip of a content card, the edge share of the body of a
// card, the standard width of a band and the margin that the bands of a side keep before the centre of the card. Group is set for a
// dragged group card, which holds cards and no tabs, so a tab strip is no target of it and is part of the body of its card.
type TargetOptions struct {
	HeaderPx   float64
	Edge       float64
	Band       float64
	BandMargin float64
	Group      bool
}

// The measures of the target search (docs/spec/groups.md#target-search): the width of a band and the margin before the centre of a
// card in points, and the edge share of the body of a card whose outer quarter is a side.
const (
	DropBand       = 5
	DropBandMargin = 3
	DropEdge       = 0.25
)

// link is a node of the chain of a point: the node, the cut that holds it with its index there, and its drawn rectangle.
type link struct {
	node   *Node
	holder *Node
	at     int
	rect   Rect
}

// drawnRect is the drawn rectangle of a node: of a card or a box its drawn rectangle, of a cut the smallest rectangle that holds the
// drawn rectangles of its kids.
func (t *GroupTree) drawnRect(n *Node) Rect {
	if !n.isCut() {
		r, _ := t.Rect(n.id()) // silent: every card and box of the tree has a drawn rectangle.
		return r
	}
	out := t.drawnRect(n.Kids[0].Node)
	for _, kid := range n.Kids[1:] {
		r := t.drawnRect(kid.Node)
		x0, y0 := math.Min(out.X, r.X), math.Min(out.Y, r.Y)
		x1, y1 := math.Max(out.X+out.W, r.X+r.W), math.Max(out.Y+out.H, r.Y+r.H)
		out = Rect{X: x0, Y: y0, W: x1 - x0, H: y1 - y0}
	}
	return out
}

// chain is the nodes of the stored tree that hold the point, from the root to the innermost card, through the inner node of each box.
// The kids of a cut divide its extent at the middle of each corridor between their drawn rectangles, so every point of the plane lies
// in one kid.
func (t *GroupTree) chain(root *Node, x, y float64) []link {
	out := []link{{node: root, rect: t.drawnRect(root)}}
	for cur := root; ; {
		switch {
		case cur.isBox():
			out = append(out, link{node: cur.Inner, holder: cur, at: -1, rect: t.drawnRect(cur.Inner)})
			cur = cur.Inner
		case cur.isCut():
			p := x
			if cur.Cut == "y" {
				p = y
			}
			rects := make([]Rect, len(cur.Kids))
			for i, kid := range cur.Kids {
				rects[i] = t.drawnRect(kid.Node)
			}
			at := len(cur.Kids) - 1
			for i := 0; i < len(cur.Kids)-1; i++ {
				if p < (edgeOf(rects[i], far(cur.Cut))+edgeOf(rects[i+1], near(cur.Cut)))/2 {
					at = i
					break
				}
			}
			out = append(out, link{node: cur.Kids[at].Node, holder: cur, at: at, rect: rects[at]})
			cur = cur.Kids[at].Node
		default:
			return out
		}
	}
}

// sideStack is the innermost link of the chain and each link above it that ends on the same screen line toward side, from the outermost
// in: the box of a node, a cut whose kid toward side is the node below it, and a cut across the axis of side.
func sideStack(chain []link, side Side) []link {
	axis, after := axisOf(side), side == "right" || side == "bottom"
	stack := []link{chain[len(chain)-1]}
	for j := len(chain) - 1; j > 0; j-- {
		c, holder := chain[j], chain[j-1]
		shares := c.at < 0 || holder.node.Cut != axis || (after && c.at == len(holder.node.Kids)-1) || (!after && c.at == 0)
		if !shares {
			break
		}
		stack = append([]link{holder}, stack...)
	}
	return stack
}

// holdsSidebar is whether a node holds a window sidebar outside the boxes inside it.
func holdsSidebar(n *Node) bool {
	return slices.ContainsFunc(members(n), IsWindowSide)
}

// stackTarget is the target of a link of a side stack, or nil: a card that is no window sidebar, a box, a cut across the axis of side
// that holds no window sidebar, and the root cut that holds one as the content of the plane. A cut along the axis of side is the target
// of its kid toward side, whose result it has, so it gives no band of its own.
func stackTarget(l link, side Side) Target {
	n := l.node
	switch {
	case n.isCard():
		if n.Fixed || IsWindowSide(n.Card) {
			return nil
		}
		return Target{n.Card}
	case n.isBox():
		return Target{n.Box}
	case n.Cut == axisOf(side):
		return nil
	case holdsSidebar(n):
		if l.holder != nil {
			return nil
		}
		content := Target{}
		for _, id := range members(n) {
			if !IsWindowSide(id) {
				content = append(content, id)
			}
		}
		return content
	}
	return members(n)
}

// Anchor is the band where a drag entered a line (docs/spec/groups.md#target-search): its side, its line, its index from the outermost,
// and the cut across the axis of the side that holds its node, by the members of that cut, with the index of the kid there, or no cut.
type Anchor struct {
	side Side
	line float64
	band int
	cut  string
	kid  int
}

// kidOf is the kid of the cut across the axis of side that holds the node of the band at the link at of the stack, through the cuts along
// the axis of side, which give no band: the members of that cut and the index of the kid, or "" when a box or the root comes first.
func kidOf(stack []link, at int, side Side) (string, int) {
	for j := at; j > 0 && stack[j].at >= 0; j-- {
		if holder := stack[j-1].node; holder.Cut != axisOf(side) {
			return strings.Join(members(holder), " "), stack[j].at
		}
	}
	return "", 0
}

// near and far are the sides at the start and at the end of an axis.
func near(axis Axis) Side {
	if axis == "y" {
		return "top"
	}
	return "left"
}

func far(axis Axis) Side {
	if axis == "y" {
		return "bottom"
	}
	return "right"
}

// edgeOf is the coordinate of the side of a rectangle.
func edgeOf(r Rect, side Side) float64 {
	switch side {
	case "left":
		return r.X
	case "right":
		return r.X + r.W
	case "top":
		return r.Y
	}
	return r.Y + r.H
}

// within is the distance of a point inside the line toward side; from a top line it leaves out the tab strips and the group headers
// between the line and the point, which are targets of their own.
func (t *GroupTree) within(side Side, line, x, y, strip float64) float64 {
	dist := y - line
	switch side {
	case "left":
		dist = x - line
	case "right":
		dist = line - x
	case "bottom":
		dist = line - y
	}
	if side == "top" {
		for _, id := range t.Cards() {
			r, _ := t.Rect(id) // silent: id is a card of the tree.
			if IsWindowSide(id) || x < r.X || x > r.X+r.W {
				continue
			}
			high := strip
			if t.IsGroup(id) {
				high = t.head
			}
			if a, b := math.Max(line, r.Y), math.Min(y, r.Y+high); b > a {
				dist -= b - a
			}
		}
	}
	return math.Max(0, dist)
}

// TargetAt resolves a drop at x, y by the target search of the rule of sizes (docs/spec/groups.md#target-search), or nil for a point on
// a window sidebar or in no card or box, as a drag that enters at that point.
func (t *GroupTree) TargetAt(x, y float64, options TargetOptions) *DropTarget {
	hit, _ := t.DragAt(nil, x, y, options)
	return hit
}

// DragAt resolves the drop of a drag at x, y whose anchor is anchor, nil before the drag enters a line, and returns the anchor of the
// next point: the anchor while the point stays on its band of its line, the band of the point when it enters another, and nil off the
// bands. A band whose node is another kid of the cut of the anchor across the axis of the side is the run of the kids between the two.
func (t *GroupTree) DragAt(anchor *Anchor, x, y float64, options TargetOptions) (*DropTarget, *Anchor) {
	if math.IsNaN(x) || math.IsInf(x, 0) || math.IsNaN(y) || math.IsInf(y, 0) {
		return nil, nil
	}
	// A group card holds cards and no tabs, so a tab strip is no target of it and is part of the body of its card
	// (docs/spec/groups.md#target-search).
	if options.Group {
		options.HeaderPx = 0
	}
	holds := func(r Rect) bool { return x >= r.X && x <= r.X+r.W && y >= r.Y && y <= r.Y+r.H }
	content, group := "", ""
	var frame Rect
	for _, id := range t.Cards() {
		r, _ := t.Rect(id) // silent: id is a card of the tree.
		if !holds(r) {
			continue
		}
		if !t.IsGroup(id) {
			content = id
		} else if group == "" || r.W*r.H < frame.W*frame.H {
			group, frame = id, r
		}
	}
	root := t.grid.ToJSON().Root
	whole := t.drawnRect(root)
	if content == "" && group == "" && !holds(whole) {
		return nil, nil
	}
	body, _ := t.Rect(content) // silent: content is a card of the tree, or "" whose rectangle no condition below reads.
	inStrip := content != "" && !IsWindowSide(content) && y < body.Y+options.HeaderPx
	inHead := false
	if content == "" && group != "" {
		head, _ := t.HeadRect(group) // silent: group is a group card.
		inHead = y <= head.Y+head.H
	}
	if !inStrip {
		head := ""
		if inHead {
			head = group
		}
		if hit, next := t.bandAt(root, x, y, options, head, content == "" && !inHead, anchor); hit != nil {
			return hit, next
		}
	}
	return t.bodyAt(root, x, y, options, content, group, body, inStrip, inHead), nil
}

// bodyAt is the target of a point in no band: the tab strip, the centre or the outer quarter of a content card, or the header of a group
// card.
func (t *GroupTree) bodyAt(root *Node, x, y float64, options TargetOptions, content, group string, body Rect, inStrip, inHead bool) *DropTarget {
	switch {
	case inStrip:
		return &DropTarget{Kind: "strip", Card: content}
	case content != "" && IsWindowSide(content):
		return nil
	case content != "":
		top, bottom := body.Y+options.HeaderPx, body.Y+body.H
		if bottom <= top || !(body.W > 0) {
			return &DropTarget{Kind: "centre", Card: content}
		}
		px, py := (x-body.X)/body.W, (y-top)/(bottom-top)
		edge := options.Edge
		if px > edge && px < 1-edge && py > edge && py < 1-edge {
			return &DropTarget{Kind: "centre", Card: content}
		}
		nearest := math.Min(math.Min(px, 1-px), math.Min(py, 1-py))
		side := "bottom"
		switch nearest {
		case px:
			side = "left"
		case 1 - px:
			side = "right"
		case py:
			side = "top"
		}
		return &DropTarget{Kind: "add", Target: Target{content}, Side: side}
	case inHead:
		inner := t.boxOf(root, group).Inner
		return &DropTarget{Kind: "add", Target: members(inner), Side: "right"}
	}
	return nil
}

// bandAt is the band of the side of the point whose distance divided by the distance that side has is the smallest, when the point lies
// in it, or always when anywhere is set. On the header of the group card head the chain ends at its box, so the bands are those of its
// left and its right side (docs/spec/groups.md#target-search).
func (t *GroupTree) bandAt(root *Node, x, y float64, options TargetOptions, head string, anywhere bool, anchor *Anchor) (*DropTarget, *Anchor) {
	chain := t.chain(root, x, y)
	inHead := head != ""
	if inHead {
		at := slices.IndexFunc(chain, func(l link) bool { return l.node.isBox() && l.node.Box == head })
		chain = chain[:at+1]
	}
	leaf := chain[len(chain)-1]
	r := leaf.rect
	top := 0.0
	if leaf.node.isCard() && !IsWindowSide(leaf.node.Card) {
		top = options.HeaderPx
	}
	cx, cy := r.X+r.W/2, r.Y+top+(r.H-top)/2
	sides := []Side{"left", "right", "top", "bottom"}
	if inHead {
		sides = []Side{"left", "right"}
	}
	type choice struct {
		side        Side
		dist, width float64
		score       float64
		line        float64
		bands       []Target
		stack       []link
		links       []int
	}
	var best *choice
	for _, side := range sides {
		stack := sideStack(chain, side)
		line := edgeOf(stack[0].rect, side)
		bands, links := []Target{}, []int{}
		for j, l := range stack {
			if target := stackTarget(l, side); target != nil {
				bands, links = append(bands, target), append(links, j)
			}
		}
		if len(bands) == 0 {
			continue
		}
		dist := t.within(side, line, x, y, options.HeaderPx)
		have := math.Max(1, t.within(side, line, cx, cy, options.HeaderPx)-options.BandMargin)
		width := math.Min(options.Band, have/float64(len(bands)))
		if c := (choice{side: side, dist: dist, width: width, score: dist / have, line: line, bands: bands, stack: stack, links: links}); best == nil || c.score < best.score {
			best = &c
		}
	}
	if best == nil || !(best.dist < float64(len(best.bands))*best.width || anywhere) {
		return nil, nil
	}
	at := min(len(best.bands)-1, int(math.Floor(best.dist/best.width)))
	hit := &DropTarget{Kind: "add", Target: best.bands[at], Side: best.side, Band: at, Of: len(best.bands)}
	cut, kid := kidOf(best.stack, best.links[at], best.side)
	if anchor == nil || anchor.side != best.side || anchor.line != best.line || anchor.band != at {
		return hit, &Anchor{side: best.side, line: best.line, band: at, cut: cut, kid: kid}
	}
	if cut != "" && cut == anchor.cut && kid != anchor.kid {
		holder := best.stack[best.links[at]]
		for j := best.links[at]; j > 0; j-- {
			if strings.Join(members(best.stack[j-1].node), " ") == cut {
				holder = best.stack[j-1]
				break
			}
		}
		run := Target{}
		for _, k := range holder.node.Kids[min(kid, anchor.kid) : max(kid, anchor.kid)+1] {
			run = append(run, members(k.Node)...)
		}
		hit.Target = run
	}
	return hit, anchor
}
