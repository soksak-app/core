package layout

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"math"
	"slices"
	"strconv"
	"strings"
)

// The two primitives of the rule of sizes over the slicing tree, and even shares (packages/soksak/docs/layout.md#cuts), the port of
// cuts.ts of the layout library.
//
// A cut divides a rectangle along one axis into children: cards, boxes of the host and cuts along the other axis. Every rule works on
// the fractions of the stored tree; the grid draws a kid at its fraction of what its cut has left once the corridors, the px sizes, the
// frames and the heads are laid, so equal fractions draw equal sizes (lay.go). REMOVE (Withdraw) takes a member out of its cut, and the
// other kids that are no fixed card take its fraction by one factor. ADD (Insert) puts a node beside a target: along the cut of the
// target, an even cut gives the node 1/(k+1) and keeps every ratio, and a cut that is not even gives the node half of the fraction of the
// target; across it, the target is wrapped in a new cut of two halves. Even gives the kids of every cut equal fractions. An operation
// changes the stored tree; the grid lays it and refuses a result that draws a changed node below its minimum.

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

// MarshalJSON writes one id as that id and more ids as a list, the forms that UnmarshalJSON reads.
func (t Target) MarshalJSON() ([]byte, error) {
	if len(t) == 1 {
		return json.Marshal(t[0])
	}
	return json.Marshal([]string(t))
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

func notMember(id string) error { return fmt.Errorf("card %s is not a member of the layout", id) }

// evenWithin is the difference of fractions under which two kids are of one size, so their cut is even.
const evenWithin = 1e-9

// index is the cut of each node of the tree and the node of each id, over the stored tree of the grid, which an operation changes.
type index struct {
	g      *Grid
	root   *Node
	parent map[*Node]*Node
	byID   map[string]*Node
}

func newIndex(g *Grid) *index {
	x := &index{g: g, root: g.root, parent: map[*Node]*Node{}, byID: map[string]*Node{}}
	x.enter(g.root, nil)
	return x
}

func (x *index) enter(n, parent *Node) {
	x.g.visit()
	if parent != nil {
		x.parent[n] = parent
	}
	switch {
	case n.isBox():
		x.byID[n.Box] = n
		x.enter(n.Inner, nil)
	case n.isCut():
		for _, kid := range n.Kids {
			x.enter(kid.Node, n)
		}
	default:
		x.byID[n.Card] = n
	}
}

// keepDrawn writes each card of n that keeps a px size on axis, through nodes that keep one, and is no fixed card at the px size it is
// drawn at.
func (x *index) keepDrawn(n *Node, axis Axis) {
	if !x.g.keeps(n, axis) {
		return
	}
	switch {
	case n.isCard():
		px := n.Width
		if axis == "y" {
			px = n.Height
		}
		if n.Fixed || px == nil {
			return
		}
		if drawn := x.g.content(n, axis); drawn > 0 {
			if axis == "x" {
				n.Width = &drawn
			} else {
				n.Height = &drawn
			}
		}
	case n.isBox():
		x.keepDrawn(n.Inner, axis)
	default:
		for _, kid := range n.Kids {
			x.keepDrawn(kid.Node, axis)
		}
	}
}

// replace puts next where n stands: in its cut, inside its box, or as the root. A cut along the axis of its cut gives that cut its kids,
// so the tree stays canonical; the kids of the cut that joins are drawn at the sizes they had, and so is every other kid: the corridors
// between them are costs of the one cut now, so each kid takes its drawn size over theirs.
func (x *index) replace(n, next *Node) {
	if holder := x.parent[n]; holder != nil {
		at := slices.IndexFunc(holder.Kids, func(k Kid) bool { return k.Node == n })
		if next.isCut() && next.Cut == holder.Cut {
			axis := holder.Cut
			// A node that keeps a px size is drawn at its px size whatever its fraction, and a cut whose kids all keep one divides its room
			// in their proportion, so a px size can be drawn larger than it declares. Each card of the cut that is no fixed card and keeps a
			// px size is written at the size it is drawn at, so the kids of the cut keep their drawn sizes when the join brings kids that
			// take a fraction (packages/soksak/docs/layout.md#add-and-remove). A fixed card is a cost of the cut and keeps its px size.
			for _, kid := range holder.Kids {
				if kid.Node != n {
					x.keepDrawn(kid.Node, axis)
				}
			}
			share := holder.Kids[at].Share
			kids := make([]Kid, len(next.Kids))
			for k, kid := range next.Kids {
				kids[k] = Kid{Share: share * kid.Share, Node: kid.Node}
			}
			holder.Kids = slices.Concat(holder.Kids[:at], kids, holder.Kids[at+1:])
			for _, kid := range next.Kids {
				x.enter(kid.Node, holder)
			}
			drawn := make([]float64, len(holder.Kids))
			total, shared, positive := 0.0, 0.0, true
			for i, kid := range holder.Kids {
				drawn[i] = x.g.content(kid.Node, axis)
				total += drawn[i]
				shared += kid.Share
				positive = positive && drawn[i] > 0
			}
			if total > 0 && positive {
				for i := range holder.Kids {
					holder.Kids[i].Share = (drawn[i] / total) * shared
				}
			}
			return
		}
		holder.Kids[at].Node = next
		x.enter(next, holder)
		return
	}
	for _, box := range x.byID {
		if box.isBox() && box.Inner == n {
			box.Inner = next
			x.enter(next, nil)
			return
		}
	}
	x.root = next
	x.enter(next, nil)
}

// members is the ids of the cards and boxes of a node in its own tree, without the members inside its boxes.
func members(n *Node) []string {
	switch {
	case n.isCard():
		return []string{n.Card}
	case n.isBox():
		return []string{n.Box}
	}
	out := []string{}
	for _, kid := range n.Kids {
		out = append(out, members(kid.Node)...)
	}
	return out
}

// run is the neighbouring kids first to last of the cut holder: the target of an insert along that cut.
type run struct {
	holder      *Node
	first, last int
}

// targetOf is the target of an insert toward an axis: the node of one member, or the neighbouring kids of one cut that hold exactly the
// members. A run of kids is the target itself when the insert goes along its cut, so the node joins that cut; across it, the run becomes
// a cut of its own that the insert wraps.
func targetOf(x *index, target Target, axis Axis) (*Node, *run, error) {
	if len(target) == 0 {
		return nil, nil, errors.New("soksak: an insert names no target")
	}
	hits := make([]*Node, len(target))
	for i, id := range target {
		hit := x.byID[id]
		if hit == nil {
			return nil, nil, notMember(id)
		}
		hits[i] = hit
	}
	if len(target) == 1 {
		return hits[0], nil, nil
	}
	refused := fmt.Errorf("cards %s are not neighbours of one cut", strings.Join(target, ", "))
	wanted := map[string]bool{}
	for _, id := range target {
		wanted[id] = true
	}
	count := func(n *Node) int {
		c := 0
		for _, id := range members(n) {
			if wanted[id] {
				c++
			}
		}
		return c
	}
	// The cut that holds every listed node is the lowest cut above the first whose members count all of them.
	var level *Node
	for at := x.parent[hits[0]]; at != nil; at = x.parent[at] {
		if count(at) == len(wanted) {
			level = at
			break
		}
	}
	if level == nil {
		return nil, nil, refused
	}
	touched := []int{}
	for i, kid := range level.Kids {
		if count(kid.Node) > 0 {
			touched = append(touched, i)
		}
	}
	first, last := touched[0], touched[len(touched)-1]
	held := []string{}
	for _, kid := range level.Kids[first : last+1] {
		held = append(held, members(kid.Node)...)
	}
	if len(held) != len(wanted) || slices.ContainsFunc(held, func(id string) bool { return !wanted[id] }) {
		return nil, nil, refused
	}
	if first == 0 && last == len(level.Kids)-1 {
		return level, nil, nil
	}
	if level.Cut == axis {
		return nil, &run{level, first, last}, nil
	}
	total := 0.0
	for _, kid := range level.Kids[first : last+1] {
		total += kid.Share
	}
	sub := &Node{Cut: level.Cut}
	for _, kid := range level.Kids[first : last+1] {
		sub.Kids = append(sub.Kids, Kid{Share: kid.Share / total, Node: kid.Node})
	}
	level.Kids = slices.Concat(level.Kids[:first], []Kid{{Share: total, Node: sub}}, level.Kids[last+1:])
	x.enter(sub, level)
	return sub, nil, nil
}

// sharing is the indices of the kids of a cut that take a fraction: the kids that keep no size of their own on its axis.
func (g *Grid) sharing(cut *Node) []int {
	out := []int{}
	for i, kid := range cut.Kids {
		if !g.keeps(kid.Node, cut.Cut) {
			out = append(out, i)
		}
	}
	return out
}

// normalize makes the fractions of a cut sum to 1, by one factor, so every ratio holds.
func normalize(cut *Node) {
	total := 0.0
	for _, kid := range cut.Kids {
		total += kid.Share
	}
	for i := range cut.Kids {
		cut.Kids[i].Share /= total
	}
}

// insertInto adds the node coming into the cut into at at, paid by the kids first to last. An even cut gives it 1/(k+1) and keeps every
// ratio; a cut that is not even gives it half of the fraction of the payers, which keep their ratios, and every other kid keeps its
// fraction. A node that keeps a px size on the axis takes no fraction: an even cut keeps every ratio, and a cut that is not even takes
// its px and its corridor from the payers alone, so every other kid keeps its drawn size.
func (g *Grid) insertInto(into *Node, at, first, last int, coming *Node) error {
	axis := into.Cut
	shares := g.sharing(into)
	paying := []int{}
	for i := first; i <= last; i++ {
		if !g.keeps(into.Kids[i].Node, axis) {
			paying = append(paying, i)
		}
	}
	even := len(paying) == 0
	if !even {
		even = true
		for _, i := range shares {
			if math.Abs(into.Kids[i].Share-into.Kids[shares[0]].Share) > evenWithin {
				even = false
			}
		}
	}
	sum := 0.0
	for _, i := range shares {
		sum += into.Kids[i].Share
	}
	fresh := Kid{Node: coming}
	switch {
	case g.keeps(coming, axis):
		if sum > 0 && len(shares) > 0 {
			fresh.Share = sum / float64(len(shares)+1)
		} else {
			fresh.Share = 1 / float64(len(into.Kids)+1)
		}
		if !even {
			// The drawn size of every kid that takes a fraction: the payers give the px of the node and the new corridor between them.
			drawn := make([]float64, len(into.Kids))
			paid := 0.0
			for _, i := range shares {
				drawn[i] = g.content(into.Kids[i].Node, axis)
			}
			for _, i := range paying {
				paid += g.content(into.Kids[i].Node, axis)
			}
			owed := g.content(coming, axis) + g.unit.of(axis)
			if paid <= owed {
				return fmt.Errorf("the kids beside the node cannot give %s px", jsString(jsRound(owed)))
			}
			total := 0.0
			for _, i := range shares {
				share := drawn[i]
				if slices.Contains(paying, i) {
					share = drawn[i] * (1 - owed/paid)
				}
				into.Kids[i].Share = share
				total += share
			}
			for _, i := range shares {
				into.Kids[i].Share *= sum / total
			}
		}
	case even:
		k := float64(len(shares))
		for _, i := range shares {
			into.Kids[i].Share *= k / (k + 1)
		}
		if len(shares) > 0 {
			fresh.Share = sum / (k + 1)
		} else {
			fresh.Share = 1 / float64(len(into.Kids)+1)
		}
	default:
		paid := 0.0
		for _, i := range paying {
			paid += into.Kids[i].Share
			into.Kids[i].Share /= 2
		}
		fresh.Share = paid / 2
	}
	into.Kids = slices.Insert(into.Kids, at, fresh)
	normalize(into)
	return nil
}

// addBeside adds coming beside the target toward side. Along the cut of the target, insertInto gives it its fraction; when the target
// is a cut along the axis of the side, the target is the whole level and every kid pays. Across the cut, the target is wrapped in a new
// cut of two halves.
func (g *Grid) addBeside(x *index, target *Node, along *run, side Side, coming *Node) error {
	axis := axisOf(side)
	after := side == "right" || side == "bottom"
	if along != nil {
		at := along.first
		if after {
			at = along.last + 1
		}
		if err := g.insertInto(along.holder, at, along.first, along.last, coming); err != nil {
			return err
		}
		x.enter(coming, along.holder)
		return nil
	}
	if target.isCut() && target.Cut == axis {
		at := 0
		if after {
			at = len(target.Kids)
		}
		if err := g.insertInto(target, at, 0, len(target.Kids)-1, coming); err != nil {
			return err
		}
		x.enter(coming, target)
		return nil
	}
	if holder := x.parent[target]; holder != nil && holder.Cut == axis {
		at := slices.IndexFunc(holder.Kids, func(k Kid) bool { return k.Node == target })
		place := at
		if after {
			place++
		}
		if err := g.insertInto(holder, place, at, at, coming); err != nil {
			return err
		}
		x.enter(coming, holder)
		return nil
	}
	pair := []*Node{coming, target}
	if after {
		pair = []*Node{target, coming}
	}
	x.replace(target, &Node{Cut: axis, Kids: []Kid{{Share: 0.5, Node: pair[0]}, {Share: 0.5, Node: pair[1]}}})
	return nil
}

// alone takes the px size on axis from a card that fills a cut alone, which has no size of its own there.
func alone(n *Node, axis Axis) *Node {
	if n.isCard() {
		if axis == "x" {
			n.Width = nil
		} else {
			n.Height = nil
		}
	}
	return n
}

// insertNode is ADD: the stored tree with node, a new card or what Withdraw returned, beside target toward side.
func (g *Grid) insertNode(target Target, side Side, node *Node) (*Node, error) {
	if !isSide(side) {
		return nil, fmt.Errorf("unknown side %s; use left, right, top or bottom", side)
	}
	ids := []string{}
	if !node.isCut() {
		ids = append(ids, node.id())
	}
	for _, leaf := range cardsOf(node) {
		ids = append(ids, leaf.Card)
	}
	for _, id := range ids {
		if g.taken(id) {
			return nil, fmt.Errorf("card %s is a member of the layout", id)
		}
	}
	x := newIndex(g)
	at, along, err := targetOf(x, target, axisOf(side))
	if err != nil {
		return nil, err
	}
	if err := g.addBeside(x, at, along, side, cloneNode(node)); err != nil {
		return nil, err
	}
	return x.root, nil
}

// insertBeside is ADD beside a node of the stored tree: the stored tree with node beside target toward side.
func (g *Grid) insertBeside(target *Node, side Side, node *Node) (*Node, error) {
	x := newIndex(g)
	if err := g.addBeside(x, target, nil, side, cloneNode(node)); err != nil {
		return nil, err
	}
	return x.root, nil
}

// withdrawNode is REMOVE: the stored tree without the card or the box id, and the stored node that left.
func (g *Grid) withdrawNode(id string) (*Node, *Node, error) {
	x := newIndex(g)
	n := x.byID[id]
	if n == nil {
		return nil, nil, notMember(id)
	}
	if n.isCard() && n.Fixed {
		return nil, nil, fmt.Errorf("card %s is fixed and does not leave", id)
	}
	holder := x.parent[n]
	gone := map[string]bool{id: true}
	if n.isBox() {
		gone = map[string]bool{}
		for _, leaf := range cardsOf(n) {
			gone[leaf.Card] = true
		}
	}
	if holder == nil || !slices.ContainsFunc(g.list, func(c *Card) bool { return !c.Fixed && !gone[c.ID] }) {
		return nil, nil, fmt.Errorf("card %s is the last card of the layout", id)
	}
	axis := holder.Cut
	i := slices.IndexFunc(holder.Kids, func(k Kid) bool { return k.Node == n })
	share := holder.Kids[i].Share
	holder.Kids = slices.Delete(holder.Kids, i, i+1)
	// A fixed card keeps its size; every other kid takes a part of the fraction, which a kid with a px size draws at its size.
	free := 0.0
	taking := 0
	for _, kid := range holder.Kids {
		if !(kid.Node.isCard() && kid.Node.Fixed) {
			free += kid.Share
			taking++
		}
	}
	if taking == 0 {
		return nil, nil, fmt.Errorf("card %s leaves no card of its cut that takes its space", id)
	}
	for k, kid := range holder.Kids {
		if !(kid.Node.isCard() && kid.Node.Fixed) {
			holder.Kids[k].Share *= (free + share) / free
		}
	}
	if len(holder.Kids) == 1 {
		x.replace(holder, alone(holder.Kids[0].Node, axis))
	}
	return x.root, n, nil
}

// evenCuts is Even: the stored tree with equal fractions for the kids of every cut that take one.
func (g *Grid) evenCuts() *Node {
	var visit func(n *Node)
	visit = func(n *Node) {
		g.visit()
		switch {
		case n.isBox():
			visit(n.Inner)
		case n.isCut():
			shares := g.sharing(n)
			sum := 0.0
			for _, i := range shares {
				sum += n.Kids[i].Share
			}
			for _, i := range shares {
				n.Kids[i].Share = sum / float64(len(shares))
			}
			for _, kid := range n.Kids {
				visit(kid.Node)
			}
		}
	}
	visit(g.root)
	return g.root
}

// Insert is ADD (packages/soksak/docs/layout.md#add-and-remove): it adds node, a new card or what Withdraw returned, beside target
// toward side and returns its id. target is an id or the ids that neighbouring kids of one cut hold. It returns its refusal, a result
// below a minimum included, and changes nothing then.
func (g *Grid) Insert(target Target, side Side, node *Node) (string, error) {
	defer g.begin()()
	if node == nil || node.isCut() || node.id() == "" {
		return "", errors.New("soksak: insert takes a card or a box node")
	}
	if err := g.byCuts(func() (*Node, error) { return g.insertNode(target, side, node) }); err != nil {
		return "", err
	}
	return node.id(), nil
}

// GroupInit names the box of a group: its id, the data of the host and the px of its head, which the host draws inside its top.
type GroupInit struct {
	Box  string          `json:"box"`
	Data json.RawMessage `json:"data,omitempty"`
	Head float64         `json:"head"`
}

// Group is the group split of the card or box target (packages/soksak/docs/layout.md#add-and-remove): the box of init takes the place
// of target in its cut, and its inner node is ADD of node beside target toward side, two halves. The result is judged once, with the
// head and the frames of the new box, and a refusal names the deepest node that it would draw below its minimum and changes nothing.
func (g *Grid) Group(target string, side Side, node *Node, init GroupInit) error {
	defer g.begin()()
	if node == nil || node.isCut() || node.id() == "" {
		return errors.New("soksak: a group takes a card or a box node")
	}
	if init.Box == "" {
		return errors.New("soksak: a group names no box")
	}
	if !finite(init.Head) || init.Head < 0 {
		return errors.New("soksak: the head of " + strconv.Quote(init.Box) + " is " + jsString(init.Head))
	}
	heads := g.heads
	err := g.byCuts(func() (*Node, error) {
		root, err := g.groupNode(target, side, node, init)
		if err == nil {
			g.heads = maps.Clone(heads)
			if g.heads == nil {
				g.heads = map[string]float64{}
			}
			g.heads[init.Box] = init.Head
		}
		return root, err
	})
	if err != nil {
		g.heads = heads
		g.derive()
	}
	return err
}

// groupNode is the stored tree with a box around target and node beside it toward side.
func (g *Grid) groupNode(target string, side Side, node *Node, init GroupInit) (*Node, error) {
	if !isSide(side) {
		return nil, fmt.Errorf("unknown side %s; use left, right, top or bottom", side)
	}
	ids := []string{init.Box}
	if !node.isCut() {
		ids = append(ids, node.id())
	}
	for _, leaf := range cardsOf(node) {
		ids = append(ids, leaf.Card)
	}
	for _, id := range ids {
		if g.taken(id) {
			return nil, fmt.Errorf("card %s is a member of the layout", id)
		}
	}
	x := newIndex(g)
	at := x.byID[target]
	if at == nil {
		return nil, notMember(target)
	}
	pair := []*Node{at, cloneNode(node)}
	if !(side == "right" || side == "bottom") {
		pair = []*Node{pair[1], at}
	}
	inner := &Node{Cut: axisOf(side), Kids: []Kid{{Share: 0.5, Node: pair[0]}, {Share: 0.5, Node: pair[1]}}}
	x.replace(at, &Node{Box: init.Box, Data: slices.Clone(init.Data), Inner: inner})
	return x.root, nil
}

// Unwrap takes the box id out of the tree: its inner node takes its place in its cut, and a cut along the axis of that cut joins it with
// every kid drawn at the size it had (packages/soksak/docs/layout.md#add-and-remove). The head of the box leaves with it. A refusal
// changes nothing.
func (g *Grid) Unwrap(id string) error {
	defer g.begin()()
	if g.boxByID[id] == nil {
		if g.byID[id] != nil {
			return fmt.Errorf("card %s is no box", id)
		}
		return notMember(id)
	}
	heads := g.heads
	err := g.byCuts(func() (*Node, error) {
		x := newIndex(g)
		box := x.byID[id]
		x.replace(box, box.Inner)
		g.heads = maps.Clone(heads)
		delete(g.heads, id)
		return x.root, nil
	})
	if err != nil {
		g.heads = heads
		g.derive()
	}
	return err
}

// Withdraw is REMOVE (packages/soksak/docs/layout.md#add-and-remove): it takes the node id, a card or a box, out of its cut; the other
// kids that are no fixed card take its fraction by one factor. It returns the node that left, which Insert takes, or its refusal, and
// changes nothing then.
func (g *Grid) Withdraw(id string) (*Node, error) {
	defer g.begin()()
	var left *Node
	err := g.byCuts(func() (*Node, error) {
		root, n, err := g.withdrawNode(id)
		left = n
		return root, err
	})
	if err != nil {
		return nil, err
	}
	return cloneNode(left), nil
}

// Exchange puts the node a, a card or a box, where the node b stands and b where a stood (packages/soksak/docs/layout.md#add-and-remove):
// each place keeps its fraction and the px size that a card there declares, and every other node keeps its rectangle. Two nodes of which
// one holds the other and a fixed card are refused, the result is judged as an insert is, and an error changes nothing.
func (g *Grid) Exchange(a, b string) error {
	defer g.begin()()
	return g.byCuts(func() (*Node, error) { return g.exchangeNodes(a, b) })
}

// exchangeNodes is the stored tree with the nodes a and b in each other's place.
func (g *Grid) exchangeNodes(a, b string) (*Node, error) {
	x := newIndex(g)
	na, nb := x.byID[a], x.byID[b]
	for id, n := range map[string]*Node{a: na, b: nb} {
		if n == nil {
			return nil, notMember(id)
		}
		if n.isCard() && n.Fixed {
			return nil, fmt.Errorf("card %s is fixed and does not leave", id)
		}
	}
	if slices.Contains(cardsOf(na), nb) || slices.Contains(cardsOf(nb), na) || holdsBox(na, b) || holdsBox(nb, a) {
		return nil, fmt.Errorf("card %s and card %s hold one another and do not exchange", a, b)
	}
	// The size belongs to the place: each kid of the cuts of the two places keeps the size it is drawn at with its frames, and a node that
	// enters a place takes the content of that size less its own frames, so a box, whose frame and head are a cost of its place, enters
	// at the size of the place and not at the fraction of the card that stood there.
	holders := []*Node{}
	for _, n := range []*Node{na, nb} {
		if holder := x.parent[n]; holder != nil && !slices.Contains(holders, holder) {
			holders = append(holders, holder)
		}
	}
	sizes := make([][]float64, len(holders))
	for h, holder := range holders {
		sizes[h] = x.placeSizes(holder)
	}
	putA, putB := x.place(na), x.place(nb)
	putA(nb)
	putB(na)
	for h, holder := range holders {
		x.sharePlaces(holder, sizes[h])
	}
	// A card takes the px size of the place it enters, and the place of a box, which declares none, its fraction.
	wa, ha, wb, hb := na.Width, na.Height, nb.Width, nb.Height
	if na.isCard() {
		na.Width, na.Height = wb, hb
	}
	if nb.isCard() {
		nb.Width, nb.Height = wa, ha
	}
	return x.root, nil
}

// placeSizes is the size of the place of each kid of the cut holder along its axis: the content that the kid is drawn at with its frames.
func (x *index) placeSizes(holder *Node) []float64 {
	out := make([]float64, len(holder.Kids))
	for i, kid := range holder.Kids {
		out[i] = x.g.content(kid.Node, holder.Cut)
		if !x.g.keeps(kid.Node, holder.Cut) {
			out[i] += x.g.frameOf(kid.Node, holder.Cut, x.g.unit)
		}
	}
	return out
}

// sharePlaces gives each kid of the cut holder that takes a fraction the share that draws its place at the size of sizes, its content
// that size less its own frames, out of the fractions that those kids hold together. A place too small for the frames of its node keeps
// the fractions, and the judge of the result refuses it.
func (x *index) sharePlaces(holder *Node, sizes []float64) {
	axis := holder.Cut
	want := make([]float64, len(holder.Kids))
	total, shared := 0.0, 0.0
	for i, kid := range holder.Kids {
		if x.g.keeps(kid.Node, axis) {
			continue
		}
		want[i] = sizes[i] - x.g.frameOf(kid.Node, axis, x.g.unit)
		if want[i] <= 0 {
			return
		}
		total += want[i]
		shared += kid.Share
	}
	if total <= 0 {
		return
	}
	for i, kid := range holder.Kids {
		if !x.g.keeps(kid.Node, axis) {
			holder.Kids[i].Share = want[i] / total * shared
		}
	}
}

// holdsBox is whether the box id stands inside the node n.
func holdsBox(n *Node, id string) bool {
	switch {
	case n.isBox():
		return n.Box == id || holdsBox(n.Inner, id)
	case n.isCut():
		return slices.ContainsFunc(n.Kids, func(k Kid) bool { return holdsBox(k.Node, id) })
	}
	return false
}

// place is the setter of the place where n stands: its kid in its cut, the inner node of its box, or the root.
func (x *index) place(n *Node) func(*Node) {
	if holder := x.parent[n]; holder != nil {
		at := slices.IndexFunc(holder.Kids, func(k Kid) bool { return k.Node == n })
		return func(next *Node) { holder.Kids[at].Node = next }
	}
	for _, box := range x.byID {
		if box.isBox() && box.Inner == n {
			return func(next *Node) { box.Inner = next }
		}
	}
	return func(next *Node) { x.root = next }
}

// Even gives the kids of every cut that take a fraction equal fractions (packages/soksak/docs/layout.md#cuts). An error changes nothing.
func (g *Grid) Even() error {
	defer g.begin()()
	return g.byCuts(func() (*Node, error) { return g.evenCuts(), nil })
}

// keeps is whether a node keeps its size on an axis whatever its fraction: a fixed card, or a node drawn at a px size there.
func (g *Grid) keeps(n *Node, axis Axis) bool {
	if n.isCard() && n.Fixed {
		return true
	}
	_, held := g.heldOf(n, axis, g.unit)
	return held
}

// content is the px size of a node on an axis as the grid draws it now, its corridors and frames left out; a new node has its px size.
func (g *Grid) content(n *Node, axis Axis) float64 {
	lo, hi := ends(axis)
	slot, ok := g.spots[n]
	inset, inOK := g.insets[n]
	held, isHeld := g.heldOf(n, axis, g.unit)
	if !ok || !inOK {
		return held
	}
	// A node that takes a fraction is drawn its frames and its fraction of the rest; its content is that rest.
	frames := 0.0
	if !isHeld {
		frames = g.frameOf(n, axis, g.unit)
	}
	return float64((slot.get(hi)-slot.get(lo))*g.size(axis)) - inset.get(lo) - inset.get(hi) - frames
}

// taken is whether an id names a card or a box of the tree.
func (g *Grid) taken(id string) bool {
	return g.byID[id] != nil || g.boxByID[id] != nil
}

// keepFixed draws a fixed card without a px size on the axis of its cut, a fixed cost of that cut (packages/soksak/docs/layout.md#the-model),
// at the size it had before an operation: the kids that take a fraction share the rest in the ratio of their fractions, and its fraction
// is the one that draws that size.
func (g *Grid) keepFixed(before map[string]Rect) {
	changed := false
	var visit func(n *Node)
	visit = func(n *Node) {
		if n.isBox() {
			visit(n.Inner)
			return
		}
		if !n.isCut() {
			return
		}
		axis := n.Cut
		sharing := []int{}
		for i, kid := range n.Kids {
			if _, held := g.heldOf(kid.Node, axis, g.unit); !held {
				sharing = append(sharing, i)
			}
		}
		fixed := []int{}
		for _, i := range sharing {
			kid := n.Kids[i].Node
			if _, was := before[kid.Card]; kid.isCard() && kid.Fixed && was {
				fixed = append(fixed, i)
			}
		}
		if len(fixed) > 0 && len(fixed) < len(sharing) {
			rest, kept, others := 0.0, 0.0, 0.0
			for _, i := range sharing {
				rest += g.content(n.Kids[i].Node, axis)
				if !slices.Contains(fixed, i) {
					others += n.Kids[i].Share
				}
			}
			want := make([]float64, len(fixed))
			moves := false
			for k, i := range fixed {
				was := before[n.Kids[i].Node.Card]
				want[k] = was.H
				if axis == "x" {
					want[k] = was.W
				}
				kept += want[k]
				moves = moves || math.Abs(g.content(n.Kids[i].Node, axis)-want[k]) > 1e-9
			}
			if rest > kept+eps && others > 0 && moves {
				total := (others * rest) / (rest - kept)
				for k, i := range fixed {
					n.Kids[i].Share = (total * want[k]) / rest
				}
				// The shares of a cut sum to one; one factor on all of them keeps every ratio and so every drawn size.
				normalize(n)
				changed = true
			}
		}
		for _, kid := range n.Kids {
			visit(kid.Node)
		}
	}
	visit(g.root)
	if changed {
		g.derive()
		g.changed()
	}
}

// byCuts installs the stored tree that change makes of the stored tree and lays it. A result that draws a node that it changed below its
// minimum is refused with its text. A refusal puts the arrangement back.
func (g *Grid) byCuts(change func() (*Node, error)) error {
	kept := g.ToJSON()
	before := g.Rects()
	root, err := change()
	if err == nil {
		g.root = root
		g.derive()
		g.changed()
		g.keepFixed(before)
		if below := g.belowMinimum(before); below != "" {
			err = errors.New(below)
		}
	}
	if err != nil {
		g.restore(kept)
		return err
	}
	return nil
}

// measure is the drawn extent of a node, the extent of the drawn rectangles of its cards, and its recursive minimum on an axis
// (packages/soksak/docs/layout.md#cuts), read from the rectangles now; before holds the rectangles that a fixed card had.
func (g *Grid) measure(now, before map[string]Rect) (func(n *Node) extent, func(n *Node, axis Axis) float64) {
	extentOfNode := func(n *Node) extent {
		e := extent{math.Inf(1), math.Inf(-1), math.Inf(1), math.Inf(-1)}
		for _, leaf := range cardsOf(n) {
			r := now[leaf.Card]
			e.x0, e.x1 = math.Min(e.x0, r.X), math.Max(e.x1, r.X+r.W)
			e.y0, e.y1 = math.Min(e.y0, r.Y), math.Max(e.y1, r.Y+r.H)
		}
		return e
	}
	along := func(e extent, axis Axis) float64 {
		if axis == "x" {
			return e.x1 - e.x0
		}
		return e.y1 - e.y0
	}
	var need func(n *Node, axis Axis) float64
	need = func(n *Node, axis Axis) float64 {
		g.visit()
		switch {
		case n.isBox():
			return need(n.Inner, axis)
		case n.isCard():
			heads := 0.0
			if axis == "y" {
				heads = g.above[n.Card]
			}
			px := n.Width
			if axis == "y" {
				px = n.Height
			}
			// A fixed card with a px size is drawn no smaller than its size, or than the size it had where the plane drew it smaller.
			if n.Fixed && px != nil {
				was, ok := before[n.Card]
				if !ok {
					return *px
				}
				if axis == "x" {
					return math.Min(*px, was.W)
				}
				return math.Min(*px, was.H)
			}
			if n.Fixed {
				return along(extentOfNode(n), axis)
			}
			// A card with a px size below minSize needs that size: it is drawn at it while the plane holds the sizes.
			if px != nil {
				return math.Min(*px, g.min) + heads
			}
			return g.min + heads
		}
		kids := make([]float64, len(n.Kids))
		for i, kid := range n.Kids {
			kids[i] = need(kid.Node, axis)
		}
		if n.Cut != axis {
			return slices.Max(kids)
		}
		corridors := along(extentOfNode(n), axis)
		sum := 0.0
		for i, kid := range n.Kids {
			corridors -= along(extentOfNode(kid.Node), axis)
			sum += kids[i]
		}
		return sum + corridors
	}
	return extentOfNode, need
}

// belowMinimum is the text of the deepest node that the last operation moved and that is drawn below its minimum, or "". The minimum
// of a node is recursive: a card needs minSize and on y the heads drawn inside its rectangle, a card that keeps a px size the smaller of
// that size and minSize, a fixed card with a px size the smaller of that size and the size it had, another fixed card the size it is
// drawn at, a box the minimum of its inner node, a cut along an axis the minimums of its kids and the corridors between them, and a cut
// across it the largest minimum of its kids.
func (g *Grid) belowMinimum(before map[string]Rect) string {
	now := g.Rects()
	text := func(v float64) string { return jsString(jsRound(v)) }
	extentOfNode, need := g.measure(now, before)
	moved := func(n *Node) bool {
		for _, leaf := range cardsOf(n) {
			was, ok := before[leaf.Card]
			is := now[leaf.Card]
			if !ok || math.Abs(was.X-is.X) > 1e-6 || math.Abs(was.Y-is.Y) > 1e-6 || math.Abs(was.W-is.W) > 1e-6 ||
				math.Abs(was.H-is.H) > 1e-6 {
				return true
			}
		}
		return false
	}
	// The deepest node below its minimum names the refusal, because the minimum of a box or a cut is the sum of the minimums inside it: a
	// box is below its minimum where a node inside it is, and the node inside it is the one that has no room.
	var visit func(n *Node) string
	visit = func(n *Node) string {
		switch {
		case n.isBox():
			if found := visit(n.Inner); found != "" {
				return found
			}
		case n.isCut():
			for _, kid := range n.Kids {
				if found := visit(kid.Node); found != "" {
					return found
				}
			}
			return ""
		}
		if !moved(n) {
			return ""
		}
		has := extentOfNode(n)
		w, h := has.x1-has.x0, has.y1-has.y0
		nx, ny := need(n, "x"), need(n, "y")
		if w >= nx-0.5 && h >= ny-0.5 {
			return ""
		}
		// A card is named at the size of its content, the heads drawn inside the top of its rectangle taken out of what it has and of what
		// it needs.
		if n.isCard() {
			h -= g.above[n.Card]
			ny -= g.above[n.Card]
		}
		return fmt.Sprintf("card %s would be %sx%s, below its minimum %sx%s", n.id(), text(w), text(h), text(nx), text(ny))
	}
	return visit(g.root)
}
