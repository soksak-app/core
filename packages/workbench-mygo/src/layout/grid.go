package layout

import (
	"encoding/json"
	"errors"
	"maps"
	"math"
	"slices"
	"strconv"
)

// The grid over shared lines. xs and ys hold every coordinate; a card is a span of indices into them, so two cards that meet
// reference the same index and their shared boundary is one value. Splitting replaces one card with two, so the arrangement stays a
// slicing floorplan and every card can be closed.

const eps = 1e-9

// Options are the layout options. A field that is nil takes its default: gap 24, minSize 96, grabSize 11, snapDistance 7, snap
// "merge", fillOrder "v", width and height 0.
type Options struct {
	Gap          *float64 `json:"gap"`
	MinSize      *float64 `json:"minSize"`
	GrabSize     *float64 `json:"grabSize"`
	SnapDistance *float64 `json:"snapDistance"`
	Snap         *string  `json:"snap"`
	FillOrder    *string  `json:"fillOrder"`
	Width        *float64 `json:"width"`
	Height       *float64 `json:"height"`
}

// DefaultOptions is the options with no field given, so every option takes its default.
func DefaultOptions() Options { return Options{} }

// SplitInit names the new card of a split and its payload. A nil ID lets the grid issue one.
// NewLine cuts at a new line at the centre even where a line that the card spans across lies inside it.
type SplitInit struct {
	ID      *string         `json:"id"`
	Data    json.RawMessage `json:"data"`
	NewLine bool            `json:"newLine"`
}

// InsertInit is a SplitInit with the px size of the inserted slot, which is required.
type InsertInit struct {
	ID   *string         `json:"id"`
	Data json.RawMessage `json:"data"`
	Size *float64        `json:"size"`
}

// Grid holds the state and the operations of the layout. root and paidBy are the state; xs, ys, list, at and leaves are derived from
// root after every change (state.go).
type Grid struct {
	root   *Node
	paidBy map[string]string
	xs, ys []float64
	list   []*Card
	at     map[*Node]nodeLines
	leaves map[string]*Node
	// byID is the card of each id, and up the node that holds each node with its index, as derive built them.
	byID map[string]*Card
	up   map[*Node]holding
	// visits is the number of nodes that the last operation visited (Visits), and depth the number of operations that run, so the count
	// starts with the outermost.
	visits, depth int
	w, h          float64
	seq           int
	splitMemo     map[string]bool
	probes        int
	probing       bool
	gap           float64
	min           float64
	order         string
	grab          float64
	snapAt        float64
	snapMode      string
	frames        frameRead
	// cardFrames is the frames of each card by id that SetFrames set.
	cardFrames map[string]Frames
	// heads is the px that the host draws inside the top of each box by id, which SetHeads set.
	heads map[string]float64
	// dockToken is the plane state that the last dock of the window sidebars saw, and dockRefused is the arrangement of a dock it
	// could not place (sidebars.go): a settle whose plane state differs docks again, so a sidebar reduced for lack of room takes its
	// saved size when the room returns and a refused arrangement is not attempted again while the plane stands still.
	dockToken   string
	dockRefused []string
}

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

// New makes a grid from a state, or, with no state, one card filling the plane.
func New(state *State, options Options) (*Grid, error) {
	g := &Grid{splitMemo: map[string]bool{}, paidBy: map[string]string{}, gap: 24}
	if options.Gap != nil {
		g.SetGap(*options.Gap)
	}
	g.min = 96
	if options.MinSize != nil && finite(*options.MinSize) && *options.MinSize >= 0 {
		g.min = *options.MinSize
	}
	g.grab = 11
	if options.GrabSize != nil {
		g.SetGrabSize(*options.GrabSize)
	}
	g.snapAt = 7
	if options.SnapDistance != nil {
		g.SetSnapDistance(*options.SnapDistance)
	}
	g.snapMode = "merge"
	if options.Snap != nil {
		g.SetSnap(*options.Snap)
	}
	g.order = "v"
	if options.FillOrder != nil {
		g.order = *options.FillOrder
	}
	width, height := 0.0, 0.0
	if options.Width != nil {
		width = *options.Width
	}
	if options.Height != nil {
		height = *options.Height
	}
	g.Resize(width, height)
	if state != nil {
		if err := CheckState(*state); err != nil {
			return nil, err
		}
		g.load(*state)
	} else {
		g.root = &Node{Card: "card"}
		g.derive()
	}
	g.agreeSizes()
	g.commit()
	return g, nil
}

// load takes the tree and the payers of a state as copies and derives the lines and the cells.
func (g *Grid) load(state State) {
	g.root = cloneNode(state.Root)
	g.paidBy = make(map[string]string, len(state.PaidBy))
	for id, paid := range state.PaidBy {
		g.paidBy[id] = paid
	}
	g.derive()
}

// Gap is the gap between two cards, in px.
func (g *Grid) Gap() float64 { return g.gap }

// SetGap sets the gap. A value that is not a finite non-negative number is ignored.
func (g *Grid) SetGap(px float64) {
	if !finite(px) || px < 0 {
		return
	}
	g.gap = px
	clear(g.splitMemo)
}

// MinSize is the minimum drawn size of a card on either axis.
func (g *Grid) MinSize() float64 { return g.min }

// SetMinSize sets the minimum size. A value that is not a finite non-negative number is ignored.
func (g *Grid) SetMinSize(px float64) {
	if !finite(px) || px < 0 {
		return
	}
	g.min = px
	clear(g.splitMemo)
}

// FillOrder is the axis a close tries first: "v" or "h".
func (g *Grid) FillOrder() string { return g.order }

// SetFillOrder sets the fill order. A value other than "v" and "h" is ignored.
func (g *Grid) SetFillOrder(value string) {
	if value != "v" && value != "h" {
		return
	}
	g.order = value
	clear(g.splitMemo)
}

// GrabSize is the smallest grab area of a boundary, in px.
func (g *Grid) GrabSize() float64 { return g.grab }

// SetGrabSize sets the grab size. A value that is not a finite non-negative number is ignored.
func (g *Grid) SetGrabSize(px float64) {
	if !finite(px) || px < 0 {
		return
	}
	g.grab = px
}

// SnapDistance is how near a dragged boundary must come to a neighbour to land on it, in px.
func (g *Grid) SnapDistance() float64 { return g.snapAt }

// SetSnapDistance sets the snap distance. A value that is not a finite non-negative number is ignored.
func (g *Grid) SetSnapDistance(px float64) {
	if !finite(px) || px < 0 {
		return
	}
	g.snapAt = px
}

// Snap is whether a dragged boundary lands on a neighbour it nearly meets: "merge" or "off".
func (g *Grid) Snap() string { return g.snapMode }

// SetSnap sets the snap mode. A value other than "merge" and "off" is ignored.
func (g *Grid) SetSnap(mode string) {
	if mode != "merge" && mode != "off" {
		return
	}
	g.snapMode = mode
}

// Resize sets the plane size. A size that is not a finite non-negative number is ignored.
func (g *Grid) Resize(width, height float64) {
	defer g.begin()()
	if !finite(width) || !finite(height) || width < 0 || height < 0 {
		return
	}
	// The workbench sizes the plane in each frame; a size that does not change keeps the answers of CanSplit.
	if width == g.w && height == g.h {
		return
	}
	g.w = width
	g.h = height
	clear(g.splitMemo)
}

// Probes is the number of trial splits that CanSplit ran to answer: an answer that it kept runs none.
func (g *Grid) Probes() int { return g.probes }

// Width is the plane width in px.
func (g *Grid) Width() float64 { return g.w }

// Height is the plane height in px.
func (g *Grid) Height() float64 { return g.h }

// Cards is every card, as copies.
func (g *Grid) Cards() []Card {
	out := make([]Card, len(g.list))
	for i, c := range g.list {
		out[i] = copyCard(c)
	}
	return out
}

// Card is a copy of one card.
func (g *Grid) Card(id string) (Card, bool) {
	found := g.find(id)
	if found == nil {
		return Card{}, false
	}
	return copyCard(found), true
}

// SetData replaces a card's payload, which the grid does not read.
func (g *Grid) SetData(id string, data json.RawMessage) bool {
	card := g.find(id)
	if card == nil {
		return false
	}
	card.Data = data
	g.leaves[id].Data = data
	return true
}

// SetFixed sets whether the layout may split, close or move a card.
func (g *Grid) SetFixed(id string, fixed bool) bool {
	card := g.find(id)
	if card == nil {
		return false
	}
	card.Fixed = fixed
	g.leaves[id].Fixed = fixed
	clear(g.splitMemo)
	return true
}

// SetSize sets a card's px width or height, or removes it with nil, on every card in that slot. It is false for an unknown axis, a
// size that is not a finite non-negative number, or a card spanning more than one slot on that axis.
func (g *Grid) SetSize(id string, axis Axis, px *float64) bool {
	if noAxis(axis) {
		return false
	}
	card := g.find(id)
	if card == nil {
		return false
	}
	if px != nil && (!finite(*px) || *px < 0 || spanOf(card, axis) != 1) {
		return false
	}
	lo, hi := span(axis)
	for _, c := range g.list {
		if c.get(lo) != card.get(lo) || c.get(hi) != card.get(hi) {
			continue
		}
		if px == nil {
			clearSizeOn(c, axis)
		} else {
			setSizeOn(c, axis, *px)
		}
	}
	g.changed()
	return true
}

// SetFrames sets the frames of each card by id (R5): a card without an entry has none. It rejects an id that is no card of the grid
// and a count below zero.
func (g *Grid) SetFrames(frames map[string]Frames) error {
	for id, f := range frames {
		if g.find(id) == nil {
			return errors.New("soksak: frames name " + strconv.Quote(id) + ", which is no card")
		}
		for _, count := range []float64{f.Left, f.Right, f.Top, f.Bottom} {
			if count < 0 {
				return errors.New("soksak: the frames of " + strconv.Quote(id) + " count below zero")
			}
			if !finite(count) || count != math.Trunc(count) {
				return errors.New("soksak: the frames of " + strconv.Quote(id) + " count no whole number")
			}
		}
	}
	g.cardFrames = maps.Clone(frames)
	g.changed()
	return nil
}

func (g *Grid) find(id string) *Card {
	g.visit()
	return g.byID[id]
}

// Visits is the number of nodes that the last operation visited (packages/soksak/docs/layout.md#cuts): each operation is linear in the
// nodes that it touches, which a test bounds on a large tree instead of a time.
func (g *Grid) Visits() int { return g.visits }

// begin starts the count of the visits of an operation and returns its end: an operation that another one runs counts in that one.
func (g *Grid) begin() func() {
	if g.depth == 0 {
		g.visits = 0
	}
	g.depth++
	return func() { g.depth-- }
}

// visit counts one visited node.
func (g *Grid) visit() { g.visits++ }

// Lines is a copy of the line coordinates of an axis, normalised 0..1.
func (g *Grid) Lines(axis Axis) []float64 {
	if noAxis(axis) {
		return []float64{}
	}
	return slices.Clone(g.arr(axis))
}

// ToJSON is the state of the grid, as copies.
func (g *Grid) ToJSON() State {
	paid := make(map[string]string, len(g.paidBy))
	for id, p := range g.paidBy {
		paid[id] = p
	}
	return State{Root: cloneNode(g.root), PaidBy: paid}
}

// Replace replaces the arrangement while keeping the plane and the options.
func (g *Grid) Replace(state State) error {
	defer g.begin()()
	if err := CheckState(state); err != nil {
		return err
	}
	g.reload(state)
	return nil
}

// reload puts state into the grid without checking it, for a state that ToJSON of a grid returned and that CheckState accepted when
// that grid took it.
func (g *Grid) reload(state State) {
	g.load(state)
	clear(g.splitMemo)
	g.agreeSizes()
	g.commit()
}

func (g *Grid) plane() *plane {
	return &plane{xs: g.xs, ys: g.ys, cards: g.list, width: g.w, height: g.h, gap: g.gap, minSize: g.min, frames: g.cardFrames,
		read: &g.frames}
}

func (g *Grid) arr(axis Axis) []float64 {
	if axis == "x" {
		return g.xs
	}
	return g.ys
}

func (g *Grid) setArr(axis Axis, a []float64) {
	if axis == "x" {
		g.xs = a
	} else {
		g.ys = a
	}
}

func noAxis(axis Axis) bool { return axis != "x" && axis != "y" }

func (g *Grid) size(axis Axis) float64 {
	if axis == "x" {
		return g.w
	}
	return g.h
}

// Rect is the rect of one card.
func (g *Grid) Rect(id string) (Rect, bool) {
	card := g.find(id)
	if card == nil {
		return Rect{}, false
	}
	return rectOf(g.plane(), card), true
}

// Rects is the rect of every card, by id.
func (g *Grid) Rects() map[string]Rect {
	f := frameOf(g.plane())
	out := make(map[string]Rect, len(g.list))
	for _, c := range g.list {
		out[c.ID] = rectIn(f, c)
	}
	return out
}

// ZoneAt is where a drop lands, in the plane's own coordinates, or nil.
func (g *Grid) ZoneAt(x, y float64, options ZoneOptions) *ZoneHit {
	return zoneAt(g.plane(), x, y, options)
}

// CardsCrossing is the cards that span across a line, as copies.
func (g *Grid) CardsCrossing(axis Axis, line int) []Card {
	out := []Card{}
	if noAxis(axis) {
		return out
	}
	for _, c := range crossing(g.plane(), axis, line) {
		out = append(out, copyCard(c))
	}
	return out
}

// declare sets the px size every card in a slot declares.
func (g *Grid) declare(axis Axis, slot int, size float64) {
	lo := low(axis)
	for _, c := range g.list {
		if c.get(lo) != slot || fixedSize(c, axis) == nil {
			continue
		}
		setSizeOn(c, axis, size)
	}
}

// fits is whether every card the settle can reach meets its minimum.
func (g *Grid) fits(axis Axis) bool {
	held := heldSizes(g.plane(), axis)
	lo, hi := span(axis)
	drawn := g.extents(axis)
	for _, card := range g.list {
		shares := false
		for i := card.get(lo); i < card.get(hi); i++ {
			if !held[i].ok {
				shares = true
				break
			}
		}
		if !shares {
			continue
		}
		if drawn[card.ID] < g.min-eps {
			return false
		}
	}
	return true
}

// setSlotWidths writes the widths in want to the sharing slots by moving the lines between them. An entry of none leaves that slot
// to share the remainder in proportion to its span.
func (g *Grid) setSlotWidths(axis Axis, want []opt) {
	a := g.arr(axis)
	count := len(a) - 1
	if len(want) != count || g.size(axis) <= 0 {
		return
	}
	p := g.plane()
	read := linesRead(p, axis)
	held := heldSizes(p, axis)
	sizes := slotSizes(p, axis)
	room, spanned := 0.0, 0.0
	for i := 0; i < count; i++ {
		if held[i].ok {
			continue
		}
		room += sizes[i]
		spanned += a[i+1] - a[i]
	}
	if spanned < eps || room < eps {
		return
	}
	size := make([]float64, count)
	named, open, nulls := 0.0, 0.0, 0
	for i := 0; i < count; i++ {
		if held[i].ok {
			continue
		}
		if !want[i].ok {
			open += a[i+1] - a[i]
			nulls++
		} else {
			asked := want[i].v
			corridorFor := corridorOf
			if asked > eps {
				corridorFor = corridorWhenWide
			}
			size[i] = math.Max(0, asked+corridorFor(p, axis, i, read))
			named += size[i]
		}
	}
	left := math.Max(0, room-named)
	for i := 0; i < count; i++ {
		if held[i].ok || want[i].ok {
			continue
		}
		if open > eps {
			size[i] = (left * (a[i+1] - a[i])) / open
		} else {
			size[i] = left / float64(nulls)
		}
	}
	holds := holdsSizes(p, axis)
	share := func(i int) float64 {
		if holds {
			return size[i]
		}
		return math.Max(0, size[i]-corridorOf(p, axis, i, read))
	}
	pool := 0.0
	for i := 0; i < count; i++ {
		if !held[i].ok {
			pool += share(i)
		}
	}
	total := named + left
	if pool > eps {
		total = pool
	}
	part := func(i int) float64 {
		if pool > eps {
			return share(i)
		}
		return size[i]
	}
	was := slices.Clone(a)
	at := a[0]
	for i := 0; i < count; i++ {
		if held[i].ok {
			at += was[i+1] - was[i]
		} else {
			at += (spanned * part(i)) / total
		}
		a[i+1] = at
	}
	a[count] = was[count]
	for i := count - 1; i > 0; i-- {
		if a[i] > a[i+1] {
			a[i] = a[i+1]
		}
	}
}

// settleOn applies want, letting one sharing slot of order absorb the difference, and returns it, or -1 when every sharing slot
// shares it.
func (g *Grid) settleOn(axis Axis, want []opt, order []int) int {
	held := heldSizes(g.plane(), axis)
	undo := g.ToJSON()
	for _, slot := range order {
		if held[slot].ok {
			continue
		}
		had := want[slot]
		want[slot] = none
		g.setSlotWidths(axis, want)
		if g.fits(axis) && g.namedKept(axis, want) {
			return slot
		}
		g.restore(undo)
		want[slot] = had
	}
	for i := range want {
		if !held[i].ok {
			want[i] = none
		}
	}
	g.setSlotWidths(axis, want)
	return -1
}

// namedKept is whether every sharing slot want named is drawn at the width it named.
func (g *Grid) namedKept(axis Axis, want []opt) bool {
	held := heldSizes(g.plane(), axis)
	width := slotWidths(g.plane(), axis)
	for i := range want {
		if !want[i].ok || held[i].ok {
			continue
		}
		if math.Abs(width[i]-want[i].v) > 0.01 {
			return false
		}
	}
	return true
}

// resizeSlot draws one slot at drawn px and takes the difference from pays, the slot on the other side of the boundary.
func (g *Grid) resizeSlot(axis Axis, slot int, drawn float64, pays int) {
	width := slotWidths(g.plane(), axis)
	delta := drawn - width[slot]
	held := heldSizes(g.plane(), axis)
	want := make([]opt, len(width))
	for i, w := range width {
		want[i] = some(w)
	}
	want[slot] = some(drawn)
	if held[pays].ok {
		paid := math.Max(0, width[pays]-delta)
		total := held[slot].v + held[pays].v
		asked := drawn + paid
		if !holdsSizes(g.plane(), axis) && asked > eps {
			g.declare(axis, slot, (total*drawn)/asked)
			g.declare(axis, pays, (total*paid)/asked)
		} else {
			g.declare(axis, slot, drawn)
			g.declare(axis, pays, paid)
		}
		g.setSlotWidths(axis, want)
		return
	}
	g.declare(axis, slot, declaredFor(g.plane(), axis, slot, drawn))
	want[pays] = none
	g.setSlotWidths(axis, want)
}

// holderAt is the card whose px size a drag at this boundary changes, or nil.
func (g *Grid) holderAt(axis Axis, line int) *Card {
	lo, hi := span(axis)
	for _, c := range g.list {
		if c.get(hi) == line && fixedSize(c, axis) != nil {
			return c
		}
	}
	for _, c := range g.list {
		if c.get(lo) == line && fixedSize(c, axis) != nil {
			return c
		}
	}
	return nil
}

// Rules is everything to draw for the boundaries.
func (g *Grid) Rules() []Rule { return rules(g.plane()) }

// Dividers is the hit areas for dragging the boundaries.
func (g *Grid) Dividers() []Divider { return dividers(g.plane(), g.grab) }

// BoundaryPos is where a boundary is now, in px along its axis.
func (g *Grid) BoundaryPos(axis Axis, line int) float64 {
	if noAxis(axis) {
		return 0
	}
	along := linePositions(g.plane(), axis)
	if line >= 0 && line < len(along) {
		return along[line]
	}
	return 0
}

// HasBoundary is whether line is an interior line index.
func (g *Grid) HasBoundary(axis Axis, line int) bool {
	if noAxis(axis) {
		return false
	}
	return line >= 1 && line <= len(g.arr(axis))-2
}

func clamp(v, lo, hi float64) float64 { return math.Min(hi, math.Max(lo, v)) }

// BoundaryRange is the px range a boundary may move within while every card keeps its minimum size. It always contains the position
// the boundary stands at.
func (g *Grid) BoundaryRange(axis Axis, line int) [2]float64 {
	if noAxis(axis) || !g.HasBoundary(axis, line) {
		return [2]float64{0, 0}
	}
	if !holdsSizes(g.plane(), axis) {
		declared := heldSizes(g.plane(), axis)
		if declared[line-1].ok != declared[line].ok {
			at := g.BoundaryPos(axis, line)
			return [2]float64{at, at}
		}
	}
	along := linePositions(g.plane(), axis)
	lo, hi := span(axis)
	first := along[line-1]
	last := along[line+1]
	low, high := first, last
	p := g.plane()
	read := linesRead(p, axis)
	for _, card := range g.list {
		near := cardInset(p, axis, card, "lo", read)
		far := cardInset(p, axis, card, "hi", read)
		if card.get(hi) == line {
			low = math.Max(low, along[card.get(lo)]+g.min+near+far)
		}
		if card.get(lo) == line {
			high = math.Min(high, along[card.get(hi)]-g.min-near-far)
		}
	}
	at := along[line]
	if low > high {
		mid := clamp((low+high)/2, first, last)
		return [2]float64{math.Min(mid, at), math.Max(mid, at)}
	}
	return [2]float64{math.Min(low, at), math.Max(high, at)}
}

// MoveBoundary moves a boundary to a position in px and returns the position it reaches. When either adjacent slot has a px size,
// that size changes; otherwise the line itself moves.
func (g *Grid) MoveBoundary(axis Axis, line int, px float64, allowSnap bool) float64 {
	defer g.begin()()
	if noAxis(axis) {
		return 0
	}
	if !g.HasBoundary(axis, line) || !finite(px) {
		return g.BoundaryPos(axis, line)
	}
	r := g.BoundaryRange(axis, line)
	low, high := r[0], r[1]
	target := clamp(px, low, high)
	if allowSnap && g.snapMode != "off" {
		along := linePositions(g.plane(), axis)
		for _, edge := range []float64{along[line-1], along[line+1]} {
			if edge >= low-eps && edge <= high+eps && math.Abs(target-edge) < g.snapAt {
				target = edge
			}
		}
	}
	if holder := g.holderAt(axis, line); holder != nil {
		lo, hi := span(axis)
		along := linePositions(g.plane(), axis)
		slot := along[holder.get(hi)] - target
		if holder.get(hi) == line {
			slot = target - along[holder.get(lo)]
		}
		size := math.Max(0, slot-corridorOf(g.plane(), axis, holder.get(lo), linesRead(g.plane(), axis)))
		pays := line - 1
		if holder.get(hi) == line {
			pays = line
		}
		g.resizeSlot(axis, holder.get(lo), size, pays)
	} else {
		a := g.arr(axis)
		for pass := 0; pass < 8; pass++ {
			usable := sharePerSpan(g.plane(), axis)
			if usable <= eps {
				break
			}
			off := target - g.BoundaryPos(axis, line)
			if math.Abs(off) < 0.01 {
				break
			}
			next := clamp(a[line]+off/usable, a[line-1], a[line+1])
			if next == a[line] {
				break
			}
			was := a[line]
			a[line] = next
			if math.Abs(target-g.BoundaryPos(axis, line)) > math.Abs(off) {
				a[line] = was
				break
			}
		}
	}
	// The position is read before the tree takes the lines, because a boundary that reached a neighbouring line joins it there and the
	// index line then names the next line.
	at := g.BoundaryPos(axis, line)
	g.changed()
	return at
}

// CenterBoundary moves a boundary so the two cards beside it are drawn at the same size, and returns the position it reaches.
func (g *Grid) CenterBoundary(axis Axis, line int) float64 {
	defer g.begin()()
	if noAxis(axis) {
		return 0
	}
	if !g.HasBoundary(axis, line) {
		return g.BoundaryPos(axis, line)
	}
	r := g.BoundaryRange(axis, line)
	at := g.BoundaryPos(axis, line)
	// A move onto another line joins the two lines, as the derived lines of the tree hold one coordinate once, so the boundary can end.
	for pass := 0; pass < 8 && g.HasBoundary(axis, line); pass++ {
		middle := clamp(g.middleOf(axis, line), r[0], r[1])
		if math.Abs(middle-at) < 0.01 {
			break
		}
		at = g.MoveBoundary(axis, line, middle, false)
		for line > 1 && g.BoundaryPos(axis, line) != at {
			line--
		}
	}
	return at
}

// Arrange replaces the arrangement with an equal grid of the cards in their current order and removes every split and merge
// (packages/soksak/docs/layout.md#even-arrangement). The grid has rows times columns equal to the card count n or n + 1, with one
// empty card added for n + 1. Among the grids whose cells are at least minSize on both axes it takes the one whose cell is closest to
// square, and a tie goes to the grid without an empty card. It is false, and changes nothing, when no grid keeps every cell at least
// minSize, and an error for a mode other than even.
func (g *Grid) Arrange(mode string) (bool, error) {
	defer g.begin()()
	if mode != "even" {
		return false, errors.New("unknown arrangement " + strconv.Quote(mode))
	}
	n := len(g.list)
	if n == 0 {
		return false, nil
	}
	// The drawn size of a card along an axis with count cells: a card at the border insets by half a gap on one side only, so the line
	// spacing carries that inset.
	cellSize := func(count int, size float64) float64 {
		if count == 1 {
			return size - g.gap
		}
		return (size - float64(count-1)*g.gap) / float64(count)
	}
	rows, columns, empty, skew := 0, 0, 0, 0.0
	for r := 1; r <= n+1; r++ {
		c := (n + r - 1) / r
		e := r*c - n
		if e > 1 {
			continue
		}
		cellW, cellH := cellSize(c, g.w), cellSize(r, g.h)
		if cellW < g.min || cellH < g.min {
			continue
		}
		k := math.Abs(math.Log(cellW / cellH))
		if rows == 0 || k < skew-1e-9 || (math.Abs(k-skew) <= 1e-9 && e < empty) {
			rows, columns, empty, skew = r, c, e, k
		}
	}
	if rows == 0 {
		return false, nil
	}
	// Lines of one axis: the border lines are at the plane edges, and every inner line is at the next cell start plus the gap that the
	// border insets take.
	lines := func(count int, size float64) []float64 {
		if count == 1 {
			return []float64{0, 1}
		}
		d := cellSize(count, size)
		out := []float64{0, d + g.gap/2}
		for i := 2; i < count; i++ {
			out = append(out, out[i-1]+d+g.gap)
		}
		out = append(out, size)
		for i := range out {
			out[i] /= size
		}
		return out
	}
	xs, ys := lines(columns, g.w), lines(rows, g.h)
	cut := func(axis Axis, lines []float64, kids []*Node) *Node {
		if len(kids) == 1 {
			return kids[0]
		}
		out := &Node{Cut: axis}
		for i, kid := range kids {
			out.Kids = append(out.Kids, Kid{Share: lines[i+1] - lines[i], Node: kid})
		}
		return out
	}
	// The cards fill the grid in reading order: by the line their rectangle starts at, the top first, then the left.
	reading := slices.Clone(g.list)
	slices.SortStableFunc(reading, func(p, q *Card) int {
		if p.R0 != q.R0 {
			return p.R0 - q.R0
		}
		return p.C0 - q.C0
	})
	cards := []*Node{}
	for _, c := range reading {
		leaf := cloneNode(g.leaves[c.ID])
		leaf.Width, leaf.Height = nil, nil
		cards = append(cards, leaf)
	}
	for range empty {
		cards = append(cards, &Node{Card: g.nextID()})
	}
	// Every line crosses the plane, and the tree takes the cut along x outside, as every arrangement whose lines allow both.
	columnNodes := []*Node{}
	for c := range columns {
		column := []*Node{}
		for r := range rows {
			column = append(column, cards[r*columns+c])
		}
		columnNodes = append(columnNodes, cut("y", ys, column))
	}
	state := g.ToJSON()
	state.Root = cut("x", xs, columnNodes)
	if err := g.Replace(state); err != nil {
		return false, err
	}
	return true, nil
}

// middleOf is where the two cards meeting at a boundary come out the same size.
func (g *Grid) middleOf(axis Axis, line int) float64 {
	along := linePositions(g.plane(), axis)
	lo, hi := span(axis)
	near := g.plane()
	seen := linesRead(near, axis)
	start, end := math.Inf(-1), math.Inf(1)
	insStart, insEnd := 0.0, 0.0
	for _, card := range g.list {
		if card.get(hi) == line && along[card.get(lo)] > start {
			start = along[card.get(lo)]
			insStart = cardInset(near, axis, card, "lo", seen)
		}
		if card.get(lo) == line && along[card.get(hi)] < end {
			end = along[card.get(hi)]
			insEnd = cardInset(near, axis, card, "hi", seen)
		}
	}
	if math.IsInf(start, -1) {
		start = along[line-1]
		insStart = inset(near, axis, line-1, "lo", seen)
	}
	if math.IsInf(end, 1) {
		end = along[line+1]
		insEnd = inset(near, axis, line+1, "hi", seen)
	}
	return (start+end)/2 + (insStart-insEnd)/2
}

// cutAt is the position to cut a card at: the unreferenced line nearest the card's centre that leaves both halves their minimum, or a
// new line at the centre (line -1), clamped to the range where both halves fit. It is false when the card cannot be cut.
// A fresh cut takes no existing line: it cuts at the middle of the card.
func (g *Grid) cutAt(card *Card, axis Axis, fresh bool) (int, float64, bool) {
	if card.Fixed {
		return 0, 0, false
	}
	a := g.arr(axis)
	lo, hi := span(axis)
	var per float64
	if own := fixedSize(card, axis); own != nil {
		units := a[card.get(hi)] - a[card.get(lo)]
		if units == 0 || math.IsNaN(units) {
			units = 1
		}
		per = *own / units
	} else {
		per = sharePerSpan(g.plane(), axis)
	}
	if per <= eps {
		return 0, 0, false
	}
	p := g.plane()
	read := linesRead(p, axis)
	half := halfCorridor(p, axis, read)
	lowest := a[card.get(lo)] + (g.min+cardInset(p, axis, card, "lo", read)+half)/per
	highest := a[card.get(hi)] - (g.min+half+cardInset(p, axis, card, "hi", read))/per
	if lowest > highest {
		return 0, 0, false
	}
	mid := (a[card.get(lo)] + a[card.get(hi)]) / 2
	line := -1
	for i := card.get(lo) + 1; i < card.get(hi) && !fresh; i++ {
		if a[i] < lowest || a[i] > highest {
			continue
		}
		if line < 0 || math.Abs(a[i]-mid) < math.Abs(a[line]-mid) {
			line = i
		}
	}
	if line >= 0 {
		return line, a[line], true
	}
	value := clamp(mid, lowest, highest)
	// A fresh cut at the coordinate of a line takes that line, so that no two lines stand at one coordinate.
	for i := card.get(lo) + 1; i < card.get(hi); i++ {
		if math.Abs(a[i]-value) < eps {
			return i, a[i], true
		}
	}
	return -1, value, true
}

// extents is the drawn size of every card on an axis, by id.
func (g *Grid) extents(axis Axis) map[string]float64 {
	out := map[string]float64{}
	for id, r := range g.Rects() {
		if axis == "x" {
			out[id] = r.W
		} else {
			out[id] = r.H
		}
	}
	return out
}

// flat is the cards drawn with no width or no height, by id.
func (g *Grid) flat() map[string]bool {
	f := frameOf(g.plane())
	out := map[string]bool{}
	for _, c := range g.list {
		r := rectIn(f, c)
		if !(r.W > 0) || !(r.H > 0) {
			out[c.ID] = true
		}
	}
	return out
}

// hasArea is whether every card that had an area before the change is drawn with a non-zero width and height.
func (g *Grid) hasArea(flat map[string]bool) bool {
	f := frameOf(g.plane())
	for _, c := range g.list {
		if flat[c.ID] {
			continue
		}
		r := rectIn(f, c)
		if !(r.W > 0 && r.H > 0) {
			return false
		}
	}
	return true
}

// stillFits is whether every card still has the smaller of the size it had and the minimum size.
func (g *Grid) stillFits(axis Axis, before map[string]float64, flat map[string]bool) bool {
	if !g.hasArea(flat) {
		return false
	}
	for id, now := range g.extents(axis) {
		was, ok := before[id]
		if !ok {
			continue
		}
		if now < math.Min(g.min, was)-0.01 {
			return false
		}
	}
	return true
}

// CanSplit is true when the cut leaves every card the smaller of its current size and the minimum size.
func (g *Grid) CanSplit(id string, axis Axis) bool {
	if noAxis(axis) {
		return false
	}
	key := "split:" + id + ":" + axis
	if known, ok := g.splitMemo[key]; ok {
		return known
	}
	card := g.find(id)
	ok := false
	if card != nil {
		if _, _, cuts := g.cutAt(card, axis, false); cuts {
			before := g.ToJSON()
			seq := g.seq
			g.probing = true
			g.probes++
			_, ok = g.Split(id, axis, SplitInit{})
			g.restore(before)
			g.probing = false
			g.seq = seq
		}
	}
	g.splitMemo[key] = ok
	return ok
}

// Split cuts one card in two and returns the new card's id. The original keeps its id and the near half; the new card takes the far
// half. It is false when the halves do not fit.
// With init.NewLine the cut takes a new position at the centre instead of a line that the card spans across.
func (g *Grid) Split(id string, axis Axis, init SplitInit) (string, bool) {
	defer g.begin()()
	if noAxis(axis) {
		return "", false
	}
	return g.splitAt(id, axis, init, false)
}

func isSide(side Side) bool {
	for _, s := range sides {
		if s == side {
			return true
		}
	}
	return false
}

// SplitToward cuts a card and puts the new one on a named side. The ids are not swapped.
func (g *Grid) SplitToward(id string, side Side, init SplitInit) (string, bool) {
	defer g.begin()()
	if !isSide(side) {
		return "", false
	}
	return g.splitAt(id, axisOf(side), init, isAhead(side))
}

// splitAt cuts the card id along axis at the position of cutAt: the card keeps its part of the extent before the cut and the new card
// takes the part after it, or with first the new card takes the part before it. A px size of the card on the axis is divided between
// the two parts, and one across it is given to the new card as well. The new card is recorded as paid by the card.
func (g *Grid) splitAt(id string, axis Axis, init SplitInit, first bool) (string, bool) {
	if init.ID != nil && g.find(*init.ID) != nil {
		return "", false
	}
	card := g.find(id)
	if card == nil {
		return "", false
	}
	cutLine, cutValue, cuts := g.cutAt(card, axis, init.NewLine)
	if !cuts {
		return "", false
	}
	was := g.extents(axis)
	empty := g.flat()
	undo := g.ToJSON()
	lo, hi := span(axis)
	a := g.arr(axis)
	from, to := a[card.get(lo)], a[card.get(hi)]
	at := cutValue
	if cutLine >= 0 {
		at = a[cutLine]
	}
	f := 0.5
	if to-from > eps {
		f = (at - from) / (to - from)
	}
	freshID := ""
	if init.ID != nil {
		freshID = *init.ID
	} else {
		freshID = g.nextID()
	}
	leaf := g.leaves[id]
	fresh := &Node{Card: freshID, Data: init.Data}
	freshCard := &Card{}
	if alongside := fixedSize(card, other(axis)); alongside != nil {
		setSizeOn(freshCard, other(axis), *alongside)
	}
	near, far := f, 1-f
	if whole := fixedSize(card, axis); whole != nil {
		mine, theirs := *whole*(1-f), *whole*f
		if !first {
			mine, theirs = *whole*f, *whole*(1-f)
		}
		leafCard := &Card{Width: leaf.Width, Height: leaf.Height}
		setSizeOn(leafCard, axis, mine)
		leaf.Width, leaf.Height = leafCard.Width, leafCard.Height
		setSizeOn(freshCard, axis, theirs)
	}
	fresh.Width, fresh.Height = freshCard.Width, freshCard.Height
	kids := []Kid{{Share: near, Node: leaf}, {Share: far, Node: fresh}}
	if first {
		kids = []Kid{{Share: near, Node: fresh}, {Share: far, Node: leaf}}
	}
	g.put(leaf, &Node{Cut: axis, Kids: kids})
	g.paidBy[freshID] = id
	g.derive()
	g.changed()
	if !g.stillFits(axis, was, empty) {
		g.restore(undo)
		return "", false
	}
	return freshID, true
}

func (g *Grid) nextID() string {
	for {
		g.seq++
		id := "card-" + itoa(g.seq)
		if g.find(id) == nil {
			return id
		}
	}
}

// FillSides is the sides that a close tries, in the order of fillOrder.
func (g *Grid) FillSides() []string { return slices.Clone(fillOrders[g.order]) }

// checkFillSides refuses a side that is no fill side.
func checkFillSides(sides []string) error {
	for _, side := range sides {
		if !slices.Contains(fillOrders["v"], side) {
			return errors.New("unknown fill side " + side)
		}
	}
	return nil
}

// Fill is the neighbours that would expand over a card if it closed, as copies, or nil. sides names the sides to try in their order,
// FillSides for the order of fillOrder.
func (g *Grid) Fill(id string, sides []string) (*Fill, error) {
	if err := checkFillSides(sides); err != nil {
		return nil, err
	}
	found := g.fillAlong(id, sides)
	if found == nil {
		return nil, nil
	}
	cards := make([]Card, len(found.cards))
	for i, c := range found.cards {
		cards[i] = copyCard(c)
	}
	return &Fill{Side: found.side, Grow: spanNames[found.grow], Cards: cards}, nil
}

// departing is the node that leaves with the card of leaf: the card, or the box around it that holds nothing else.
func (g *Grid) departing(leaf *Node) *Node {
	node := leaf
	for {
		h, i := g.holder(node)
		if h == nil || i >= 0 {
			return node
		}
		node = h
	}
}

// holdsFixed is whether a fixed card stands inside a node.
func holdsFixed(n *Node) bool {
	return slices.ContainsFunc(cardsOf(n), func(c *Node) bool { return c.Fixed })
}

// fillAlong is the neighbour that takes the space of the card id when it closes, by the first of sides that names a kid of the cut of the
// card beside it with no fixed card, or nil. A close gives the space to a kid of the card's own cut, so it never crosses the structure of
// another cut.
func (g *Grid) fillAlong(id string, sides []string) *fill {
	card := g.removable(id)
	if card == nil {
		return nil
	}
	node := g.departing(g.leaves[id])
	h, i := g.holder(node)
	if h == nil || i < 0 {
		return nil
	}
	for _, side := range sides {
		dir := directions[side]
		axis, step := "y", 1
		switch side {
		case "above":
			step = -1
		case "right":
			axis = "x"
		case "left":
			axis, step = "x", -1
		}
		j := i + step
		if h.Cut != axis || j < 0 || j >= len(h.Kids) || holdsFixed(h.Kids[j].Node) {
			continue
		}
		row := []*Card{}
		for _, leaf := range cardsOf(h.Kids[j].Node) {
			if c := g.find(leaf.Card); c != nil && dir.touches(c, card) {
				row = append(row, c)
			}
		}
		return &fill{side: side, grow: dir.grow, cards: row, cut: h, at: i, to: j}
	}
	return nil
}

func (g *Grid) removable(id string) *Card {
	card := g.find(id)
	if card == nil || card.Fixed {
		return nil
	}
	free := 0
	for _, c := range g.list {
		if !c.Fixed {
			free++
		}
	}
	if free <= 1 {
		return nil
	}
	return card
}

// CanClose is whether Close would remove the card.
func (g *Grid) CanClose(id string) bool {
	_, _, _, ok := g.closing(id, fillOrders[g.order])
	return ok
}

// slotOrder is the slots to try when settling a change, nearest the boundary first: from, then back, then outward from each.
func slotOrder(from, count, back int) []int {
	out := []int{}
	for step := 0; step < count; step++ {
		for _, i := range []int{from + step, back - step} {
			if i >= 0 && i < count {
				out = append(out, i)
			}
		}
	}
	return out
}

// closing is the cut that holds the node leaving with the card id, the kid that takes its space, -1 for every other kid in proportion to
// its share, and whether that kid grows over the space as a neighbour. A card that spans the plane across the root cut and took its space
// from a card gives it back: to every kid in proportion when it took a share of every kid (paidBy ""), else to the kid after it, or
// before it at the end of the plane. Otherwise the card it took its space from takes it when it stands beside it, else the neighbour of
// the first of sides that fills it, else every other kid in proportion. It is false when the card cannot close: it is fixed or the last
// card, or no kid of its cut without a fixed card can take the space.
func (g *Grid) closing(id string, sides []string) (*Node, int, bool, bool) {
	if g.removable(id) == nil {
		return nil, 0, false, false
	}
	node := g.departing(g.leaves[id])
	h, i := g.holder(node)
	if h == nil || i < 0 {
		return nil, 0, false, false
	}
	paid, hasPaid := g.paidBy[id]
	if hasPaid && h == g.root {
		switch {
		case paid == "":
			return h, -1, false, true
		case i+1 < len(h.Kids):
			return h, i + 1, false, true
		}
		return h, i - 1, false, true
	}
	if hasPaid {
		for _, j := range []int{i - 1, i + 1} {
			if j >= 0 && j < len(h.Kids) && !h.Kids[j].Node.isCut() && !h.Kids[j].Node.isBox() && h.Kids[j].Node.Card == paid &&
				!h.Kids[j].Node.Fixed {
				return h, j, true, true
			}
		}
	}
	if f := g.fillAlong(id, sides); f != nil {
		return h, f.to, true, true
	}
	for k, kid := range h.Kids {
		if k != i && !holdsFixed(kid.Node) {
			return h, -1, false, true
		}
	}
	return nil, 0, false, false
}

// Close removes a card. Its space goes to a kid of its own cut: the card it took its space from when that card stands beside it, else the
// neighbour that the first of sides names, else every other kid in proportion to its share. It is false when the card is fixed, when it is
// the last card, or when no kid of its cut without a fixed card can take the space. sides names the sides whose neighbour may expand, tried
// in their order, FillSides for the order of fillOrder, and an empty list gives the space to every kid in proportion.
func (g *Grid) Close(id string, sides []string) (bool, error) {
	defer g.begin()()
	if err := checkFillSides(sides); err != nil {
		return false, err
	}
	return g.closeAlong(id, sides), nil
}

// closeAlong is Close whose neighbour is the first that one of sides names, in that order. The group tree of the workbench passes one
// side at a time.
func (g *Grid) closeAlong(id string, sides []string) bool {
	h, to, grows, ok := g.closing(id, sides)
	if !ok {
		return false
	}
	node := g.departing(g.leaves[id])
	_, i := g.holder(node)
	axis := h.Cut
	before := g.slotsOf(axis)
	payer := g.paidBy[id]
	if to >= 0 {
		// A neighbour that grows over the space takes no px size on the axis, as a card spanning more than one slot carries none (R5).
		if kid := h.Kids[to].Node; grows && !kid.isCut() && !kid.isBox() {
			if axis == "x" {
				kid.Width = nil
			} else {
				kid.Height = nil
			}
		}
		if payer == "" {
			for _, c := range cardsOf(h.Kids[to].Node) {
				payer = c.Card
				break
			}
		}
	}
	g.drop(h, i, to)
	delete(g.paidBy, id)
	g.derive()
	g.settle(axis, before, payer)
	g.changed()
	return true
}

// slots is the lines of an axis and the drawn width of each of its slots.
type slots struct {
	lines, widths []float64
}

func (g *Grid) slotsOf(axis Axis) slots {
	return slots{slices.Clone(g.arr(axis)), slotWidths(g.plane(), axis)}
}

// settle draws again every slot of axis that stood between the same two lines before a change at the width it had, where the axis has a
// card with a px size: the slots that the change made share what is left, the slots of the card payer first absorbing the difference. On
// an axis without a px size the coordinates are already the drawn sizes and nothing moves.
func (g *Grid) settle(axis Axis, before slots, payer string) {
	held := heldSizes(g.plane(), axis)
	if !slices.ContainsFunc(held, func(o opt) bool { return o.ok }) {
		return
	}
	a := g.arr(axis)
	want := make([]opt, len(a)-1)
	for i := range want {
		for k := 0; k+1 < len(before.lines); k++ {
			if math.Abs(before.lines[k]-a[i]) < eps && math.Abs(before.lines[k+1]-a[i+1]) < eps {
				want[i] = some(before.widths[k])
			}
		}
	}
	order := []int{}
	if c := g.find(payer); c != nil {
		lo, hi := span(axis)
		order = slotOrder(c.get(lo), len(want), c.get(hi)-1)
	}
	for i := range want {
		if !want[i].ok && !slices.Contains(order, i) {
			order = append(order, i)
		}
	}
	g.settleOn(axis, want, order)
}

// CanInsertAt is whether a card spanning the whole plane can be placed on this boundary: no card spans across the line, apart from
// the card named without ("" names none).
func (g *Grid) CanInsertAt(axis Axis, line int, without string) bool {
	if noAxis(axis) {
		return false
	}
	if line < 0 || line > len(g.arr(axis))-1 {
		return false
	}
	for _, c := range g.CardsCrossing(axis, line) {
		if without == "" || c.ID != without {
			return false
		}
	}
	return true
}

// standing is where a card spanning the whole plane on the other axis goes in at line: the index among the kids of the root, which is a
// cut along axis or becomes one, or false when line is no edge of the plane and no seam of the root. A line that no card crosses but
// that two cuts of the root share by chance is no seam of the root, so nothing goes in there.
func (g *Grid) standing(axis Axis, line int) (int, bool) {
	last := len(g.arr(axis)) - 1
	if !g.root.isCut() || g.root.Cut != axis {
		switch line {
		case 0:
			return 0, true
		case last:
			return 1, true
		}
		return 0, false
	}
	for j, kid := range g.root.Kids {
		if lo, _ := g.at[kid.Node].on(axis); lo == line {
			return j, true
		}
	}
	if line == last {
		return len(g.root.Kids), true
	}
	return 0, false
}

// InsertAt inserts a card at a boundary, spanning the whole plane on the other axis, and returns its id. It is false when a card
// spans the boundary, the line is no seam of the root, the size is not smaller than the plane, or the result would leave a card with no
// area.
func (g *Grid) InsertAt(axis Axis, line int, init InsertInit) (string, bool) {
	defer g.begin()()
	if noAxis(axis) {
		return "", false
	}
	if init.ID != nil && g.find(*init.ID) != nil {
		return "", false
	}
	extent := g.size(axis)
	if init.Size == nil || !finite(*init.Size) || *init.Size < 0 || *init.Size >= extent {
		return "", false
	}
	if !g.CanInsertAt(axis, line, "") {
		return "", false
	}
	at, ok := g.standing(axis, line)
	if !ok {
		return "", false
	}
	was := g.extents(axis)
	empty := g.flat()
	undo := g.ToJSON()
	lo, hi := span(axis)
	held := slotWidths(g.plane(), axis)
	freshID := ""
	if init.ID != nil {
		freshID = *init.ID
	} else {
		freshID = g.nextID()
	}
	fresh := &Node{Card: freshID, Data: init.Data}
	sized := &Card{}
	setSizeOn(sized, axis, *init.Size)
	fresh.Width, fresh.Height = sized.Width, sized.Height
	if !g.root.isCut() || g.root.Cut != axis {
		g.root = &Node{Cut: axis, Kids: []Kid{{Share: 1, Node: g.root}}}
	}
	// The new kid takes its span from the kid after it, else from the kid before it, else from every kid in proportion; the settle
	// below draws every slot at the width it had.
	spanned := *init.Size / extent
	kids := g.root.Kids
	switch {
	case at < len(kids) && kids[at].Share > spanned:
		kids[at].Share -= spanned
	case at > 0 && kids[at-1].Share > spanned:
		kids[at-1].Share -= spanned
	default:
		for k := range kids {
			kids[k].Share *= 1 - spanned
		}
	}
	g.root.Kids = slices.Insert(kids, at, Kid{Share: spanned, Node: fresh})
	g.derive()
	want := make([]opt, len(g.arr(axis))-1)
	for i := range want {
		want[i] = some(0)
	}
	for i, w := range held {
		if i >= line {
			if i+1 < len(want) {
				want[i+1] = some(w)
			}
		} else {
			want[i] = some(w)
		}
	}
	want[line] = some(*init.Size)
	pays := g.settleOn(axis, want, slotOrder(line+1, len(want), line-1))
	if pays >= 0 {
		for _, c := range g.list {
			if c.get(lo) <= pays && c.get(hi) > pays && c.ID != freshID {
				g.paidBy[freshID] = c.ID
				break
			}
		}
	} else {
		g.paidBy[freshID] = ""
	}
	g.changed()
	if !g.stillFits(axis, was, empty) {
		g.restore(undo)
		return "", false
	}
	return freshID, true
}

// MoveTo moves a card that spans the whole plane, a kid of the root cut along axis, to another boundary of the root: its kid moves to that
// place with its share, the kids it passes shift by its span and every other line keeps its coordinate.
func (g *Grid) MoveTo(id string, axis Axis, line int) bool {
	defer g.begin()()
	if noAxis(axis) {
		return false
	}
	card := g.find(id)
	if card == nil || !g.root.isCut() || g.root.Cut != axis {
		return false
	}
	from := slices.IndexFunc(g.root.Kids, func(k Kid) bool { return k.Node == g.leaves[id] })
	if from < 0 {
		return false
	}
	lo, hi := span(axis)
	if line == card.get(lo) || line == card.get(hi) {
		return true
	}
	if !g.CanInsertAt(axis, line, id) {
		return false
	}
	at, ok := g.standing(axis, line)
	if !ok {
		return false
	}
	before := g.ToJSON()
	empty := g.flat()
	kid := g.root.Kids[from]
	kids := slices.Delete(slices.Clone(g.root.Kids), from, from+1)
	if at > from {
		at--
	}
	g.root.Kids = slices.Insert(kids, at, kid)
	g.derive()
	g.changed()
	if !g.hasArea(empty) {
		g.restore(before)
		return false
	}
	return true
}

// Standings is every boundary a plane-spanning card could stand on, apart from the card named without ("" names none).
func (g *Grid) Standings(axis Axis, without string) []int {
	out := []int{}
	for k := 0; k < len(g.arr(axis)); k++ {
		if g.CanInsertAt(axis, k, without) {
			out = append(out, k)
		}
	}
	return out
}

// Move moves a card to one side of another, keeping its id and its payload. sides is the sides of its close, as Close takes them.
func (g *Grid) Move(id, targetID string, side Side, sides []string) (bool, error) {
	defer g.begin()()
	if err := checkFillSides(sides); err != nil {
		return false, err
	}
	return g.moveWith(id, targetID, side, func() bool { return g.closeAlong(id, sides) }), nil
}

// moveWith is Move whose close of the card is close: the group tree closes it with a row of neighbours that keeps every group card
// one rectangle.
func (g *Grid) moveWith(id, targetID string, side Side, close func() bool) bool {
	card := g.find(id)
	target := g.find(targetID)
	if card == nil || target == nil || card == target || card.Fixed {
		return false
	}
	// The payload and the px sizes are carried as values: the close removes the card they belong to.
	data := card.Data
	var width, height *float64
	if card.Width != nil {
		w := *card.Width
		width = &w
	}
	if card.Height != nil {
		h := *card.Height
		height = &h
	}
	before := g.ToJSON()
	if !close() {
		return false
	}
	landed, ok := g.SplitToward(targetID, side, SplitInit{ID: &id, Data: data})
	if !ok {
		g.restore(before)
		return false
	}
	moved := g.find(landed)
	if axisOf(side) == "x" {
		if width != nil {
			moved.Width = width
		}
		if height != nil && spanOf(moved, "y") == 1 {
			moved.Height = height
		}
	} else {
		if height != nil {
			moved.Height = height
		}
		if width != nil && spanOf(moved, "x") == 1 {
			moved.Width = width
		}
	}
	g.changed()
	return true
}

// CanMove is whether Move would succeed, without performing it.
func (g *Grid) CanMove(id, targetID string, side Side) bool {
	key := "move:" + id + ":" + targetID + ":" + side
	if known, ok := g.splitMemo[key]; ok {
		return known
	}
	before := g.ToJSON()
	seq := g.seq
	probing := g.probing
	g.probing = true
	ok := g.moveWith(id, targetID, side, func() bool { return g.closeAlong(id, fillOrders[g.order]) })
	g.restore(before)
	g.probing = probing
	g.seq = seq
	g.splitMemo[key] = ok
	return ok
}

// changed runs after every operation that changes the arrangement: the sizes agree and the tree takes the lines and the attributes.
func (g *Grid) changed() {
	if !g.probing {
		clear(g.splitMemo)
	}
	g.agreeSizes()
	g.commit()
}

// agreeSizes writes the largest declared px size to every card in a slot, and removes the size from a card that no longer spans one
// slot.
func (g *Grid) agreeSizes() {
	if len(g.paidBy) > 0 {
		live := map[string]bool{}
		for _, c := range g.list {
			live[c.ID] = true
		}
		for id := range g.paidBy {
			if !live[id] {
				delete(g.paidBy, id)
			}
		}
	}
	for _, card := range g.list {
		if card.Width != nil && card.C1-card.C0 != 1 {
			card.Width = nil
		}
		if card.Height != nil && card.R1-card.R0 != 1 {
			card.Height = nil
		}
	}
	for _, axis := range axes {
		lo := low(axis)
		agreed := heldSizes(g.plane(), axis)
		for _, card := range g.list {
			if fixedSize(card, axis) == nil {
				continue
			}
			setSizeOn(card, axis, agreed[card.get(lo)].v)
		}
	}
}

// restore restores the arrangement to a state returned earlier by ToJSON.
func (g *Grid) restore(state State) {
	g.load(state)
	if !g.probing {
		clear(g.splitMemo)
	}
}
