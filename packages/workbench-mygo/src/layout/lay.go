package layout

import (
	"math"
	"slices"
	"sort"
)

// The layout of the tree in px (packages/soksak/docs/layout.md#the-model), the port of derive, lay and commit of soksak.ts: a cut first
// takes its fixed costs from its extent, the corridors between its kids and the px sizes of the kids that keep one, and gives every
// other kid its fraction of the rest, so equal fractions draw equal sizes; a box takes its frames, one corridor on its left, right and
// bottom, and on its top the head of the host, from the extent of its inner node.

// perAxis is a value for each axis.
type perAxis struct{ x, y float64 }

func (a perAxis) of(axis Axis) float64 {
	if axis == "x" {
		return a.x
	}
	return a.y
}

// crowding tells for each axis whether a cut along it could not hold its corridors.
type crowding struct{ x, y bool }

// kept is the px size that a node keeps on an axis in two parts: px, the sizes that its cards declare, which a plane that cannot draw
// them scales, and cost, its corridors, frames and heads, which it does not.
type kept struct {
	px, cost float64
	ok       bool
}

// derive lays the tree into the plane and derives the lines and the cells from it. A line stands at the middle of each corridor, at its
// px over the extent of the plane, and coordinates within eps are one line (R1). Before the plane has a size the tree is laid by its
// fractions alone. The corridor of an axis is the gap capped at the extent over the lines and frames that hold one (R5), which the
// first lines decide; a cut that still cannot hold its corridors narrows the corridor of its axis by halves, down to none.
func (g *Grid) derive() {
	sized := g.w > 0 && g.h > 0
	unit := perAxis{}
	if sized {
		unit = perAxis{g.gap, g.gap}
	}
	for pass := 0; ; pass++ {
		crowded := g.lay(unit, sized)
		if !sized {
			break
		}
		next := unit
		if pass == 0 {
			capped := g.plane()
			capped.unit, capped.read = nil, nil
			next = perAxis{2 * halfCorridor(capped, "x", linesRead(capped, "x")), 2 * halfCorridor(capped, "y", linesRead(capped, "y"))}
		} else {
			halve := func(u float64, crowded bool) float64 {
				if !crowded {
					return u
				}
				if u < 1e-3 {
					return 0
				}
				return u / 2
			}
			next = perAxis{halve(unit.x, crowded.x), halve(unit.y, crowded.y)}
		}
		if next == unit {
			break
		}
		unit = next
	}
	g.unit = unit
}

// head is the px of the head of a box, which SetHeads set.
func (g *Grid) head(id string) float64 { return g.heads[id] }

// boxCost is the px that a box takes on an axis around its inner node: one corridor on each side of x, and on y its head above and one
// corridor below.
func (g *Grid) boxCost(n *Node, axis Axis, unit perAxis) float64 {
	frame := g.frameIn(unit)
	if axis == "x" {
		return 2 * frame.x
	}
	return frame.y + g.head(n.Box)
}

// frameIn is the px that the frame of a box takes on each axis at the corridor unit: the unit at frames corridor, nothing at none.
func (g *Grid) frameIn(unit perAxis) perAxis {
	if g.frameAt == "none" {
		return perAxis{}
	}
	return unit
}

// heldOf is the px size that a node keeps on an axis whatever its fraction, with its own costs, and whether it keeps one.
func (g *Grid) heldOf(n *Node, axis Axis, unit perAxis) (float64, bool) {
	k := g.keptOf(n, axis, unit)
	return k.px + k.cost, k.ok
}

// keptOf is the px size that a node keeps on an axis, or none for a node that takes a fraction.
func (g *Grid) keptOf(n *Node, axis Axis, unit perAxis) kept {
	switch {
	case n.isBox():
		inner := g.keptOf(n.Inner, axis, unit)
		if !inner.ok {
			return kept{}
		}
		return kept{px: inner.px, cost: inner.cost + g.boxCost(n, axis, unit), ok: true}
	case n.isCut():
		kids := make([]kept, len(n.Kids))
		for i, kid := range n.Kids {
			kids[i] = g.keptOf(kid.Node, axis, unit)
		}
		if n.Cut == axis {
			// A cut along the axis keeps a px size only when every kid keeps one: their sizes and the corridors between them.
			out := kept{cost: float64(len(n.Kids)-1) * unit.of(axis), ok: true}
			for _, kid := range kids {
				if !kid.ok {
					return kept{}
				}
				out.px += kid.px
				out.cost += kid.cost
			}
			return out
		}
		// A cut across the axis keeps the largest size of its kids.
		most := kept{}
		for _, kid := range kids {
			if kid.ok && (!most.ok || kid.px+kid.cost > most.px+most.cost) {
				most = kid
			}
		}
		return most
	}
	px := n.Width
	if axis == "y" {
		px = n.Height
	}
	if px == nil {
		return kept{}
	}
	return kept{px: *px, ok: true}
}

// kidSizes is the px size of each kid of a cut along its axis, from the room inside the cut: the corridors between the kids first, then
// the px sizes of the kids that keep one, and the rest to the other kids by their fractions. A kid gets at least the costs inside it, and
// the others share what is left. When the room does not hold the px sizes and one minSize for the kids that take a fraction, the px sizes
// are drawn scaled by one factor; when no kid takes a fraction, they divide the room in their proportion. Nil when the room does not hold
// the costs of the kids.
func (g *Grid) kidSizes(n *Node, room float64, unit perAxis) []float64 {
	axis := n.Cut
	count := len(n.Kids)
	held := make([]kept, count)
	costs := make([]float64, count)
	asked, heldCost, costSum := 0.0, 0.0, 0.0
	sharingAny := false
	for i, kid := range n.Kids {
		held[i] = g.keptOf(kid.Node, axis, unit)
		if held[i].ok {
			asked += held[i].px
			heldCost += held[i].cost
		} else {
			costs[i] = g.costOf(kid.Node, axis, unit)
			costSum += costs[i]
			sharingAny = true
		}
	}
	// The corridors between the kids and the costs inside the kids that keep a px size are drawn whatever the scale.
	free := room - float64(count-1)*unit.of(axis) - heldCost
	if free < -eps {
		return nil
	}
	floor := 0.0
	if sharingAny {
		floor = costSum + g.min
	}
	scale := 1.0
	if asked > 0 && (!sharingAny || free-asked < floor) {
		scale = math.Max(0, free-math.Min(floor, math.Max(0, free))) / asked
	}
	rest := free - float64(asked*scale)
	sizes := make([]float64, count)
	open := make([]bool, count)
	for i := range n.Kids {
		if held[i].ok {
			sizes[i] = float64(held[i].px*scale) + held[i].cost
		} else {
			open[i] = true
		}
	}
	if rest < costSum-eps {
		return nil
	}
	// The frames and heads of a kid are fixed costs of the cut: each kid that takes a fraction is drawn its frames and its fraction of
	// what the frames leave, so equal fractions draw equal sizes inside the frames. A kid whose size comes out less than the costs inside
	// it takes those costs, and the others share the rest.
	frames := make([]float64, count)
	for i, kid := range n.Kids {
		frames[i] = g.frameOf(kid.Node, axis, unit)
	}
	for {
		shared, left := 0.0, rest
		for i, kid := range n.Kids {
			if open[i] {
				shared += kid.Share
				left -= frames[i]
			}
		}
		of := func(i int) float64 {
			if shared <= 0 {
				return frames[i]
			}
			return frames[i] + float64((n.Kids[i].Share/shared)*math.Max(0, left))
		}
		clamped := false
		for i := range n.Kids {
			if open[i] && of(i) < costs[i]-eps {
				sizes[i] = costs[i]
				rest -= costs[i]
				open[i] = false
				clamped = true
			}
		}
		if clamped {
			continue
		}
		for i := range n.Kids {
			if open[i] {
				sizes[i] = of(i)
			}
		}
		// Without a corridor, a kid of no size would put two lines of the cut at one place and leave a card no cell.
		if unit.of(axis) == 0 && slices.ContainsFunc(sizes, func(size float64) bool { return size <= eps*math.Max(1, room) }) {
			return nil
		}
		return sizes
	}
}

// frameOf is the px of the frames and heads of the boxes that hold a node whole on an axis, which are costs of the cut that holds the
// node (R5).
func (g *Grid) frameOf(n *Node, axis Axis, unit perAxis) float64 {
	if !n.isBox() {
		return 0
	}
	return g.frameOf(n.Inner, axis, unit) + g.boxCost(n, axis, unit)
}

// costOf is the px that a node takes on an axis at no size of its cards: its corridors, px sizes, frames and heads.
func (g *Grid) costOf(n *Node, axis Axis, unit perAxis) float64 {
	if held, ok := g.heldOf(n, axis, unit); ok {
		return held
	}
	switch {
	case n.isBox():
		return g.costOf(n.Inner, axis, unit) + g.boxCost(n, axis, unit)
	case n.isCut():
		if n.Cut != axis {
			most := math.Inf(-1)
			for _, kid := range n.Kids {
				most = math.Max(most, g.costOf(kid.Node, axis, unit))
			}
			return most
		}
		sum := 0.0
		for _, kid := range n.Kids {
			sum += g.costOf(kid.Node, axis, unit)
		}
		return sum + float64(len(n.Kids)-1)*unit.of(axis)
	}
	return 0
}

// lay places the tree in px with the corridor unit and derives the lines, the cells, the frames and the heads above each card from it.
// It returns the axes on which a cut could not hold its corridors.
func (g *Grid) lay(unit perAxis, sized bool) crowding {
	var crowded crowding
	extentOf := perAxis{1, 1}
	if sized {
		extentOf = perAxis{g.w, g.h}
	}
	spots := map[*Node]extent{}
	insets := map[*Node]extent{}
	up := map[*Node]holding{}
	leaves := []*Node{}
	boxes := map[string]*Node{}
	boxOrder := []*Node{}
	paths := map[*Node][]*Node{}
	var place func(n *Node, slot, inset extent, path []*Node)
	place = func(n *Node, slot, inset extent, path []*Node) {
		g.visit()
		spots[n] = slot
		insets[n] = inset
		switch {
		case n.isCut():
			axis := n.Cut
			lo, hi := ends(axis)
			u := unit.of(axis)
			from := slot.get(lo) + inset.get(lo)
			room := slot.get(hi) - inset.get(hi) - from
			var sizes []float64
			if sized {
				sizes = g.kidSizes(n, room, unit)
			} else {
				sizes = make([]float64, len(n.Kids))
				for i, kid := range n.Kids {
					sizes[i] = kid.Share * room
				}
			}
			if sizes == nil {
				if axis == "x" {
					crowded.x = true
				} else {
					crowded.y = true
				}
			}
			// A cut that cannot hold its corridors at no corridor lays its kids by their fractions alone, so every kid keeps a slot and
			// is drawn at no size.
			each := sizes
			if each == nil {
				each = make([]float64, len(n.Kids))
				for i, kid := range n.Kids {
					each[i] = kid.Share * math.Max(room, slot.get(hi)-slot.get(lo))
				}
			}
			at := slot.get(lo)
			if sizes != nil {
				at = from
			}
			start := slot.get(lo)
			for i, kid := range n.Kids {
				up[kid.Node] = holding{n, i}
				size := each[i]
				last := i == len(n.Kids)-1
				end := at + size
				switch {
				case last:
					end = slot.get(hi)
				case sizes != nil:
					end = at + size + u/2
				}
				part := slot
				part.set(lo, start)
				part.set(hi, end)
				within := inset
				if i > 0 {
					within.set(lo, u/2)
				}
				if !last {
					within.set(hi, u/2)
				}
				place(kid.Node, part, within, path)
				if sizes != nil {
					at += size + u
				} else {
					at += size
				}
				start = end
			}
		case n.isBox():
			boxes[n.Box] = n
			boxOrder = append(boxOrder, n)
			paths[n] = path
			up[n.Inner] = holding{n, -1}
			head := 0.0
			if sized {
				head = g.head(n.Box)
			}
			frame := g.frameIn(unit)
			place(n.Inner, slot, extent{inset.x0 + frame.x, inset.x1 + frame.x, inset.y0 + head, inset.y1 + frame.y},
				append(slices.Clone(path), n))
		default:
			leaves = append(leaves, n)
			paths[n] = path
		}
	}
	place(g.root, extent{0, extentOf.x, 0, extentOf.y}, extent{}, nil)
	px := make(map[*Node]extent, len(spots))
	xv, yv := []float64{}, []float64{}
	for n, e := range spots {
		px[n] = e
		spots[n] = extent{e.x0 / extentOf.x, e.x1 / extentOf.x, e.y0 / extentOf.y, e.y1 / extentOf.y}
	}
	for _, leaf := range leaves {
		e := spots[leaf]
		xv, yv = append(xv, e.x0, e.x1), append(yv, e.y0, e.y1)
	}
	g.xs, g.ys = linesOf(xv), linesOf(yv)
	// The px position of each line is the px edge that the layout placed there, so a card is drawn at the px sizes that the layout gave
	// it, without the rounding of a fraction of the extent.
	at := map[Axis][]float64{"x": make([]float64, len(g.xs)), "y": make([]float64, len(g.ys))}
	for i, f := range g.xs {
		at["x"][i] = f * extentOf.x
	}
	for i, f := range g.ys {
		at["y"][i] = f * extentOf.y
	}
	for _, leaf := range leaves {
		e, u := px[leaf], spots[leaf]
		at["x"][lineOf(g.xs, u.x0)] = e.x0
		at["x"][lineOf(g.xs, u.x1)] = e.x1
		at["y"][lineOf(g.ys, u.y0)] = e.y0
		at["y"][lineOf(g.ys, u.y1)] = e.y1
	}
	g.linesAt = nil
	if sized {
		g.linesAt = at
	}
	g.at = make(map[*Node]nodeLines, len(spots))
	for n, e := range spots {
		g.at[n] = nodeLines{lineOf(g.xs, e.x0), lineOf(g.xs, e.x1), lineOf(g.ys, e.y0), lineOf(g.ys, e.y1)}
	}
	g.spots, g.insets, g.up, g.boxByID = spots, insets, up, boxes
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
	// The frames of a card: on its left, right and bottom side the boxes around it that end on the line of that side, each one corridor
	// inside the last (R5); and the heads of the boxes around it that start on its top line.
	frames := map[string]Frames{}
	above := map[string]float64{}
	for _, leaf := range leaves {
		l := g.at[leaf]
		var f Frames
		heads := 0.0
		for _, box := range paths[leaf] {
			b := g.at[box]
			if b[0] == l[0] {
				f.Left++
			}
			if b[1] == l[1] {
				f.Right++
			}
			if b[3] == l[3] {
				f.Bottom++
			}
			if b[2] == l[2] && sized {
				heads += g.head(box.Box)
			}
		}
		if g.frameAt == "corridor" && f != (Frames{}) {
			frames[leaf.Card] = f
		}
		above[leaf.Card] = heads
	}
	// The heads of the boxes around a box that start on its top line, which are drawn inside its rectangle as inside a card's.
	for _, box := range boxOrder {
		r0 := g.at[box][2]
		heads := 0.0
		for _, outer := range paths[box] {
			if g.at[outer][2] == r0 && sized {
				heads += g.head(outer.Box)
			}
		}
		above[box.Box] = heads
	}
	g.cardFrames, g.above = frames, above
	return crowded
}

// commit writes what the operations of the lines changed back into the tree: the attributes of every card, and, after a move of the
// lines, the fraction of every kid that takes one: its drawn size, its slot less its corridors, frames and heads, over the drawn size of
// the kids of its cut that take one; a kid that keeps a px size keeps its fraction. The structure of the tree stays; then the lines are
// derived again.
func (g *Grid) commit() {
	moved := g.moved
	g.moved = false
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
		g.visit()
		switch {
		case n.isCut():
			axis := n.Cut
			a := g.arr(axis)
			size := g.size(axis)
			lo, hi := ends(axis)
			sizes := make([]opt, len(n.Kids))
			drawn, shared := 0.0, 0.0
			for i, kid := range n.Kids {
				if _, held := g.heldOf(kid.Node, axis, g.unit); held {
					continue
				}
				from, to := g.at[kid.Node].on(axis)
				inset := g.insets[kid.Node]
				sizes[i] = some(float64((a[to]-a[from])*size) - inset.get(lo) - inset.get(hi) - g.frameOf(kid.Node, axis, g.unit))
				drawn += sizes[i].v
				shared += kid.Share
			}
			// A fraction is positive: a kid drawn at no size keeps the fractions of its cut as they are.
			if drawn > 0 && !slices.ContainsFunc(sizes, func(s opt) bool { return s.ok && s.v <= eps*drawn }) {
				for i := range n.Kids {
					if sizes[i].ok {
						n.Kids[i].Share = (sizes[i].v / drawn) * shared
					}
				}
			}
			for _, kid := range n.Kids {
				push(kid.Node)
			}
		case n.isBox():
			push(n.Inner)
		}
	}
	if moved && g.w > 0 && g.h > 0 {
		push(g.root)
	}
	g.derive()
}

// linesOf is the lines of coordinates: coordinates within eps of the line before are that line (R1), because two cuts laid alike reach
// one coordinate through different sums.
func linesOf(values []float64) []float64 {
	sort.Float64s(values)
	out := []float64{}
	for _, v := range values {
		if len(out) == 0 || v-out[len(out)-1] >= eps {
			out = append(out, v)
		}
	}
	return out
}

// lineOf is the index of the line of v in the ascending lines: the last line at or below v within eps.
func lineOf(lines []float64, v float64) int {
	lo, hi := 0, len(lines)
	for lo < hi {
		mid := (lo + hi) / 2
		if lines[mid] > v+eps {
			hi = mid
		} else {
			lo = mid + 1
		}
	}
	return lo - 1
}
