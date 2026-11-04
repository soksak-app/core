package layout

import (
	"encoding/json"
	"errors"
	"math"
	"slices"
)

// The grid over shared lines. xs and ys hold every coordinate; a card is a span of indices into them, so two cards that meet
// reference the same index and their shared boundary is one value. Splitting replaces one card with two, so the arrangement stays a
// slicing floorplan and every card can be closed.

const eps = 1e-9

// Paid is where a card's slot came from: the side and the card its width came from, the side its span came from ("lo", "hi" or
// "all"), and which of the payer's slots gave the width, counted from its first. Span and At are absent when they were not recorded.
type Paid struct {
	Side string `json:"side"`
	To   string `json:"to"`
	Span string `json:"span,omitempty"`
	At   *int   `json:"at,omitempty"`
}

// State is the stored arrangement: the lines, the cards and which side each card took its slot from.
type State struct {
	Xs     []float64       `json:"xs"`
	Ys     []float64       `json:"ys"`
	Cards  []Card          `json:"cards"`
	PaidBy map[string]Paid `json:"paidBy"`
}

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
type SplitInit struct {
	ID   *string         `json:"id"`
	Data json.RawMessage `json:"data"`
}

// InsertInit is a SplitInit with the px size of the inserted slot, which is required.
type InsertInit struct {
	ID   *string         `json:"id"`
	Data json.RawMessage `json:"data"`
	Size *float64        `json:"size"`
}

// Grid holds the state and the operations of the layout.
type Grid struct {
	xs, ys    []float64
	list      []*Card
	w, h      float64
	seq       int
	sliceMemo map[string]bool
	splitMemo map[string]bool
	paidBy    map[string]Paid
	probing   bool
	gap       float64
	min       float64
	order     string
	grab      float64
	snapAt    float64
	snapMode  string
}

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

// CheckState rejects a state that cannot describe a plane and reports which field is wrong.
func CheckState(state State) error {
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

// New makes a grid from a state, or, with no state, one card filling the plane.
func New(state *State, options Options) (*Grid, error) {
	g := &Grid{sliceMemo: map[string]bool{}, splitMemo: map[string]bool{}, paidBy: map[string]Paid{}, gap: 24}
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
		g.xs = []float64{0, 1}
		g.ys = []float64{0, 1}
		g.list = []*Card{{ID: "card", C0: 0, C1: 1, R0: 0, R1: 1}}
	}
	g.agreeSizes()
	return g, nil
}

// load takes the lines, the cards and the payers of a state as copies.
func (g *Grid) load(state State) {
	g.xs = slices.Clone(state.Xs)
	g.ys = slices.Clone(state.Ys)
	g.list = make([]*Card, len(state.Cards))
	for i := range state.Cards {
		c := copyCard(&state.Cards[i])
		g.list[i] = &c
	}
	g.paidBy = make(map[string]Paid, len(state.PaidBy))
	for id, paid := range state.PaidBy {
		g.paidBy[id] = paid
	}
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
	clear(g.sliceMemo)
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
	if !finite(width) || !finite(height) || width < 0 || height < 0 {
		return
	}
	g.w = width
	g.h = height
	clear(g.splitMemo)
}

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
	return true
}

// SetFixed sets whether the layout may split, close or move a card.
func (g *Grid) SetFixed(id string, fixed bool) bool {
	card := g.find(id)
	if card == nil {
		return false
	}
	card.Fixed = fixed
	clear(g.splitMemo)
	clear(g.sliceMemo)
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

func (g *Grid) find(id string) *Card {
	for _, c := range g.list {
		if c.ID == id {
			return c
		}
	}
	return nil
}

// Lines is a copy of the line coordinates of an axis, normalised 0..1.
func (g *Grid) Lines(axis Axis) []float64 {
	if noAxis(axis) {
		return []float64{}
	}
	return slices.Clone(g.arr(axis))
}

// ToJSON is the state of the grid, as copies.
func (g *Grid) ToJSON() State {
	cards := make([]Card, len(g.list))
	for i, c := range g.list {
		cards[i] = copyCard(c)
	}
	paid := make(map[string]Paid, len(g.paidBy))
	for id, p := range g.paidBy {
		paid[id] = p
	}
	return State{Xs: slices.Clone(g.xs), Ys: slices.Clone(g.ys), Cards: cards, PaidBy: paid}
}

// Replace replaces the arrangement while keeping the plane and the options.
func (g *Grid) Replace(state State) error {
	if err := CheckState(state); err != nil {
		return err
	}
	g.load(state)
	clear(g.sliceMemo)
	clear(g.splitMemo)
	g.agreeSizes()
	return nil
}

func (g *Grid) plane() *plane {
	return &plane{xs: g.xs, ys: g.ys, cards: g.list, width: g.w, height: g.h, gap: g.gap, minSize: g.min}
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

// insertLine is Array.prototype.splice(at, 0, value) on the lines of an axis.
func (g *Grid) insertLine(axis Axis, at int, value float64) {
	g.setArr(axis, slices.Insert(slices.Clone(g.arr(axis)), at, value))
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

// IsVirtual is true when no card reads this line.
func (g *Grid) IsVirtual(axis Axis, line int) bool {
	if noAxis(axis) {
		return false
	}
	p := g.plane()
	return isVirtual(linesRead(p, axis), line)
}

// VirtualCount is the number of interior lines no card reads.
func (g *Grid) VirtualCount() int {
	n := 0
	for _, axis := range axes {
		for _, k := range interiorLines(g.plane(), axis) {
			if g.IsVirtual(axis, k) {
				n++
			}
		}
	}
	return n
}

// IsSlicing is whether the arrangement is a slicing floorplan.
func (g *Grid) IsSlicing() bool { return isSlicing(spansOf(g.list), g.sliceMemo) }

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

// realNeighbour is the nearest line on that side that at least one card references.
func (g *Grid) realNeighbour(axis Axis, line, step int) int {
	last := len(g.arr(axis)) - 1
	at := line + step
	for at > 0 && at < last && g.IsVirtual(axis, at) {
		at += step
	}
	return at
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
	first := along[g.realNeighbour(axis, line, -1)]
	last := along[g.realNeighbour(axis, line, 1)]
	low, high := first, last
	p := g.plane()
	read := linesRead(p, axis)
	for _, card := range g.list {
		near := inset(p, axis, card.get(lo), "lo", read)
		far := inset(p, axis, card.get(hi), "hi", read)
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
	line = g.forgetLinesPassed(axis, line, target)
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
	g.changed()
	return g.BoundaryPos(axis, line)
}

// forgetLinesPassed removes the unreferenced lines the move passes and returns the new index of the moved line.
func (g *Grid) forgetLinesPassed(axis Axis, line int, target float64) int {
	at := func(k int) float64 { return linePositions(g.plane(), axis)[k] }
	for line-1 >= 1 && g.IsVirtual(axis, line-1) && target < at(line-1) {
		g.removeLine(axis, line-1, "lo")
		line--
	}
	for line+1 <= len(g.arr(axis))-2 && g.IsVirtual(axis, line+1) && target > at(line+1) {
		g.removeLine(axis, line+1, "lo")
	}
	return line
}

// CenterBoundary moves a boundary so the two cards beside it are drawn at the same size, and returns the position it reaches.
func (g *Grid) CenterBoundary(axis Axis, line int) float64 {
	if noAxis(axis) {
		return 0
	}
	if !g.HasBoundary(axis, line) {
		return g.BoundaryPos(axis, line)
	}
	r := g.BoundaryRange(axis, line)
	at := g.BoundaryPos(axis, line)
	for pass := 0; pass < 8; pass++ {
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

// Balance gives every card a fair share of the plane and keeps the arrangement. It is false when the arrangement is not slicing,
// which leaves it unchanged, and an error when the balanced state cannot describe a plane.
func (g *Grid) Balance() (bool, error) {
	tree := sliceTree(g.list)
	if tree == nil {
		return false, nil
	}
	rects := g.Rects()
	drawn := func(card *Card, axis Axis) float64 {
		r := rects[card.ID]
		if axis == "x" {
			return r.W
		}
		return r.H
	}
	regions := map[string]region{}
	balanceRegions(tree, region{x0: 0, x1: g.w, y0: 0, y1: g.h, left: true, right: true, top: true, bottom: true}, g.gap, drawn, regions)
	linesOf := func(axis Axis, size float64) []float64 {
		var at []float64
		for _, r := range regions {
			from, to := r.ends(axis)
			at = append(at, *from, *to)
		}
		slices.Sort(at)
		out := []float64{}
		for _, v := range at {
			if len(out) == 0 || v-out[len(out)-1] > 0.01 {
				out = append(out, v)
			}
		}
		out[0] = 0
		out[len(out)-1] = size
		return out
	}
	xs := linesOf("x", g.w)
	ys := linesOf("y", g.h)
	index := func(lines []float64, value float64) int {
		best := 0
		for i := 1; i < len(lines); i++ {
			if math.Abs(lines[i]-value) < math.Abs(lines[best]-value) {
				best = i
			}
		}
		return best
	}
	cards := make([]Card, len(g.list))
	for i, card := range g.list {
		r := regions[card.ID]
		c := copyCard(card)
		c.C0, c.C1, c.R0, c.R1 = index(xs, r.x0), index(xs, r.x1), index(ys, r.y0), index(ys, r.y1)
		cards[i] = c
	}
	normal := func(lines []float64, size float64) []float64 {
		out := make([]float64, len(lines))
		for i, v := range lines {
			out[i] = v / size
		}
		return out
	}
	if err := g.Replace(State{Xs: normal(xs, g.w), Ys: normal(ys, g.h), Cards: cards, PaidBy: g.ToJSON().PaidBy}); err != nil {
		return false, err
	}
	for pass := 0; pass < 8; pass++ {
		moved := false
		for _, axis := range axes {
			lines := xs
			if axis == "y" {
				lines = ys
			}
			for line := 1; line < len(lines)-1; line++ {
				if !g.HasBoundary(axis, line) {
					continue
				}
				if math.Abs(g.BoundaryPos(axis, line)-lines[line]) < 0.01 {
					continue
				}
				r := g.BoundaryRange(axis, line)
				target := clamp(lines[line], r[0], r[1])
				if math.Abs(g.BoundaryPos(axis, line)-target) < 0.01 {
					continue
				}
				g.MoveBoundary(axis, line, target, false)
				moved = true
			}
		}
		if !moved {
			break
		}
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
			insStart = inset(near, axis, card.get(lo), "lo", seen)
		}
		if card.get(lo) == line && along[card.get(hi)] < end {
			end = along[card.get(hi)]
			insEnd = inset(near, axis, card.get(hi), "hi", seen)
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

// MergeCoincident merges a line onto a neighbour at the same coordinate. It is false when a card spans both lines, which would leave
// it zero size.
func (g *Grid) MergeCoincident(axis Axis, line int) bool {
	if noAxis(axis) || g.snapMode == "off" {
		return false
	}
	a := g.arr(axis)
	lo, hi := span(axis)
	if line < 0 || line >= len(a) {
		// a[line] is undefined in the model, so no neighbour stands at its coordinate.
		return false
	}
	found := -1
	for _, i := range []int{line - 1, line + 1} {
		if i >= 0 && i < len(a) && math.Abs(a[i]-a[line]) < eps {
			found = i
			break
		}
	}
	if found < 0 {
		return false
	}
	border := func(i int) bool { return i == 0 || i == len(a)-1 }
	keep, drop := found, line
	if border(line) {
		keep, drop = line, found
	}
	at := func(card *Card, k spanKey) int {
		if card.get(k) == drop {
			return keep
		}
		return card.get(k)
	}
	for _, c := range g.list {
		if at(c, lo) == at(c, hi) {
			return false
		}
	}
	for _, card := range g.list {
		card.set(lo, at(card, lo))
		card.set(hi, at(card, hi))
	}
	g.removeLine(axis, drop, "lo")
	g.changed()
	return true
}

// Tidy removes the lines no card references and returns how many were removed.
func (g *Grid) Tidy() int {
	dropped := 0
	for _, axis := range axes {
		for k := len(g.arr(axis)) - 2; k >= 1; k-- {
			if !g.IsVirtual(axis, k) {
				continue
			}
			g.removeLine(axis, k, "lo")
			dropped++
		}
	}
	if dropped > 0 {
		g.changed()
	}
	return dropped
}

// cutAt is the position to cut a card at: the unreferenced line nearest the card's centre that leaves both halves their minimum, or a
// new line at the centre (line -1), clamped to the range where both halves fit. It is false when the card cannot be cut.
func (g *Grid) cutAt(card *Card, axis Axis) (int, float64, bool) {
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
	lowest := a[card.get(lo)] + (g.min+inset(p, axis, card.get(lo), "lo", read)+half)/per
	highest := a[card.get(hi)] - (g.min+half+inset(p, axis, card.get(hi), "hi", read))/per
	if lowest > highest {
		return 0, 0, false
	}
	mid := (a[card.get(lo)] + a[card.get(hi)]) / 2
	line := -1
	for i := card.get(lo) + 1; i < card.get(hi); i++ {
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
	return -1, clamp(mid, lowest, highest), true
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
		if _, _, cuts := g.cutAt(card, axis); cuts {
			before := g.ToJSON()
			seq := g.seq
			g.probing = true
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
func (g *Grid) Split(id string, axis Axis, init SplitInit) (string, bool) {
	if noAxis(axis) {
		return "", false
	}
	if init.ID != nil && g.find(*init.ID) != nil {
		return "", false
	}
	card := g.find(id)
	if card == nil {
		return "", false
	}
	cutLine, cutValue, cuts := g.cutAt(card, axis)
	if !cuts {
		return "", false
	}
	was := g.extents(axis)
	empty := g.flat()
	undo := g.ToJSON()
	lo, hi := span(axis)
	whole := fixedSize(card, axis)
	from := g.arr(axis)[card.get(lo)]
	to := g.arr(axis)[card.get(hi)]
	line := cutLine
	if line < 0 {
		a := g.arr(axis)
		line = card.get(lo) + 1
		for line < card.get(hi) && a[line] <= cutValue+eps {
			line++
		}
		value := math.Min(math.Max(cutValue, a[line-1]), a[line])
		g.insertLine(axis, line, value)
		for _, o := range g.list {
			if o.get(lo) >= line {
				o.set(lo, o.get(lo)+1)
			}
			if o.get(hi) >= line {
				o.set(hi, o.get(hi)+1)
			}
		}
	}
	freshID := ""
	if init.ID != nil {
		freshID = *init.ID
	} else {
		freshID = g.nextID()
	}
	fresh := &Card{ID: freshID, C0: card.C0, C1: card.C1, R0: card.R0, R1: card.R1, Data: init.Data}
	across := other(axis)
	if alongside := fixedSize(card, across); alongside != nil {
		setSizeOn(fresh, across, *alongside)
	}
	if whole != nil {
		f := 0.5
		if to-from > eps {
			f = (g.arr(axis)[line] - from) / (to - from)
		}
		setSizeOn(card, axis, *whole*f)
		setSizeOn(fresh, axis, *whole*(1-f))
	}
	fresh.set(lo, line)
	card.set(hi, line)
	g.list = append(g.list, fresh)
	at := line - card.get(lo) - 1
	g.paidBy[fresh.ID] = Paid{Side: "lo", To: card.ID, At: &at}
	g.changed()
	if !g.stillFits(axis, was, empty) {
		g.restore(undo)
		return "", false
	}
	return fresh.ID, true
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
	if !isSide(side) {
		return "", false
	}
	if init.ID != nil && g.find(*init.ID) != nil {
		return "", false
	}
	axis := axisOf(side)
	card := g.find(id)
	if card == nil {
		return "", false
	}
	if !isAhead(side) {
		return g.Split(id, axis, init)
	}
	born, ok := g.Split(id, axis, init)
	if !ok {
		return "", false
	}
	// The split keeps the cards it does not refuse, so card is still the stored card.
	fresh := g.find(born)
	lo, hi := span(axis)
	near := [2]int{card.get(lo), card.get(hi)}
	card.set(lo, fresh.get(lo))
	card.set(hi, fresh.get(hi))
	fresh.set(lo, near[0])
	fresh.set(hi, near[1])
	g.paidBy[fresh.ID] = Paid{Side: "hi", To: card.ID}
	g.changed()
	return born, true
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

// Fill is the neighbours that would expand over a card if it closed, as copies, or nil.
func (g *Grid) Fill(id string) *Fill {
	found := g.fillOf(id)
	if found == nil {
		return nil
	}
	cards := make([]Card, len(found.cards))
	for i, c := range found.cards {
		cards[i] = copyCard(c)
	}
	return &Fill{Side: found.side, Grow: spanNames[found.grow], Cards: cards}
}

func (g *Grid) fillOf(id string) *fill {
	card := g.find(id)
	if card == nil {
		return nil
	}
	return fillFor(g.list, card, g.order, g.sliceMemo)
}

// soleSlots is the axis whose slots hold no other card, or false.
func (g *Grid) soleSlots(card *Card) (Axis, bool) {
	for _, axis := range axes {
		lo, hi := span(axis)
		trapped := false
		for _, o := range g.list {
			if o != card && o.get(lo) >= card.get(lo) && o.get(hi) <= card.get(hi) {
				trapped = true
				break
			}
		}
		if !trapped {
			return axis, true
		}
	}
	return "", false
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
	card := g.removable(id)
	if card == nil {
		return false
	}
	if g.fillOf(id) != nil {
		return true
	}
	_, ok := g.soleSlots(card)
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

func (g *Grid) removeCard(card *Card) {
	g.list = slices.DeleteFunc(slices.Clone(g.list), func(c *Card) bool { return c == card })
}

// Close removes a card. A row of neighbours expands over the space when one matches the side; otherwise the card's slots are removed.
// It is false when neither applies, when the card is fixed, or when it is the last card.
func (g *Grid) Close(id string) bool {
	card := g.removable(id)
	if card == nil {
		return false
	}
	paid, hasPaid := g.paidBy[id]
	if hasPaid {
		for _, axis := range axes {
			lo, hi := span(axis)
			if card.get(hi)-card.get(lo) != 1 {
				continue
			}
			alone := true
			for _, c := range g.list {
				if !(c == card || c.get(hi) <= card.get(lo) || c.get(lo) >= card.get(hi)) {
					alone = false
					break
				}
			}
			if !alone {
				continue
			}
			last := len(g.arr(axis)) - 1
			from := paid.Side
			switch {
			case paid.Span == "lo" || paid.Span == "hi":
				from = paid.Span
			case card.get(lo) == 0:
				from = "hi"
			case card.get(hi) == last:
				from = "lo"
			}
			gone := card.get(hi)
			if from == "lo" {
				gone = card.get(lo)
			}
			if gone <= 0 || gone >= last {
				continue
			}
			held := slotWidths(g.plane(), axis)
			mine := card.get(lo)
			took := g.arr(axis)[card.get(hi)] - g.arr(axis)[card.get(lo)]
			g.removeCard(card)
			g.removeLine(axis, gone, from)
			delete(g.paidBy, id)
			merged := mine
			if from == "lo" {
				merged = mine - 1
			}
			if paid.Span == "all" && took < 1-eps {
				b := g.arr(axis)
				spans := make([]float64, len(b)-1)
				for i := range spans {
					spans[i] = b[i+1] - b[i]
				}
				spans[merged] = math.Max(0, spans[merged]-took)
				at := b[0]
				for i := range spans {
					at += spans[i] / (1 - took)
					b[i+1] = at
				}
				b[len(b)-1] = 1
			}
			back := g.find(paid.To)
			want := []opt{}
			for i, w := range held {
				if i != mine {
					want = append(want, some(w))
				}
			}
			first := merged
			if back != nil {
				paidAt := back.get(lo)
				if paid.At != nil {
					paidAt += *paid.At
				}
				if paidAt >= back.get(lo) && paidAt < back.get(hi) {
					first = paidAt
				}
			}
			order := []int{}
			if paid.To != "" {
				order = slotOrder(first, len(want), first-1)
			}
			g.settleOn(axis, want, order)
			g.changed()
			return true
		}
	}

	if filling := g.fillOf(id); filling != nil {
		axis := "y"
		if filling.grow == keyC0 || filling.grow == keyC1 {
			axis = "x"
		}
		stood := make([]float64, len(g.arr(axis)))
		for k := range stood {
			stood[k] = g.BoundaryPos(axis, k)
		}
		lo, hi := span(axis)
		from, to := card.get(lo), card.get(hi)
		widths := slotWidths(g.plane(), axis)
		want := make([]opt, len(widths))
		for i, w := range widths {
			want[i] = some(w)
		}
		var back *Card
		if hasPaid {
			back = g.find(paid.To)
		}
		paidAt := -1
		if back != nil {
			paidAt = back.get(lo)
			if paid.At != nil {
				paidAt += *paid.At
			}
		}
		gives := back != nil && !slices.Contains(filling.cards, back) && paidAt >= back.get(lo) && paidAt < back.get(hi) &&
			(paidAt < from || paidAt >= to)
		if gives {
			for i := from; i < to; i++ {
				want[i] = some(0)
			}
		}
		for _, neighbour := range filling.cards {
			neighbour.set(filling.grow, card.get(filling.grow))
		}
		g.removeCard(card)
		order := slotOrder(from, len(want), to-1)
		if gives {
			order = slotOrder(paidAt, len(want), paidAt-1)
		}
		g.settleOn(axis, want, order)
		g.standAgain(axis, stood)
		g.changed()
		return true
	}

	axis, ok := g.soleSlots(card)
	if !ok {
		return false
	}
	lo, hi := span(axis)
	from := card.get(lo)
	count := card.get(hi) - from
	held := slotWidths(g.plane(), axis)
	g.removeCard(card)
	for i := 0; i < count; i++ {
		g.dropSlot(axis, from)
	}
	kept := []opt{}
	for i, w := range held {
		if i < from || i >= from+count {
			kept = append(kept, some(w))
		}
	}
	g.settleOn(axis, kept, slotOrder(min(from, len(kept)-1), len(kept), min(from, len(kept)-1)-1))
	g.changed()
	return true
}

// standAgain restores unreferenced lines to their previous px positions, by iteration.
func (g *Grid) standAgain(axis Axis, stood []float64) {
	a := g.arr(axis)
	for k := 1; k < len(a)-1; k++ {
		if k >= len(stood) || !g.IsVirtual(axis, k) {
			continue
		}
		want := stood[k]
		for pass := 0; pass < 8; pass++ {
			at := g.BoundaryPos(axis, k)
			off := want - at
			if math.Abs(off) < 1e-9 {
				break
			}
			spanned := a[k+1] - a[k-1]
			room := g.BoundaryPos(axis, k+1) - g.BoundaryPos(axis, k-1)
			if spanned < eps || room < eps {
				break
			}
			next := a[k] + (off*spanned)/room
			if !(next > a[k-1] && next < a[k+1]) {
				break
			}
			a[k] = next
		}
	}
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

// InsertAt inserts a card at a boundary, spanning the whole plane on the other axis, and returns its id. It is false when a card
// spans the boundary, the size is not smaller than the plane, or the result would leave a card with no area.
func (g *Grid) InsertAt(axis Axis, line int, init InsertInit) (string, bool) {
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
	was := g.extents(axis)
	empty := g.flat()
	undo := g.ToJSON()
	lo, hi := span(axis)
	across := other(axis)
	alo, ahi := span(across)
	held := slotWidths(g.plane(), axis)
	gave := g.openSlot(axis, line, *init.Size/extent)
	freshID := ""
	if init.ID != nil {
		freshID = *init.ID
	} else {
		freshID = g.nextID()
	}
	fresh := &Card{ID: freshID, C0: 0, C1: 1, R0: 0, R1: 1, Data: init.Data}
	fresh.set(lo, line)
	fresh.set(hi, line+1)
	fresh.set(alo, 0)
	fresh.set(ahi, len(g.arr(across))-1)
	setSizeOn(fresh, axis, *init.Size)
	g.list = append(g.list, fresh)
	want := make([]opt, len(g.arr(axis))-1)
	for i := range want {
		want[i] = some(0)
	}
	for i, w := range held {
		if i >= line {
			want[i+1] = some(w)
		} else {
			want[i] = some(w)
		}
	}
	want[line] = some(*init.Size)
	pays := g.settleOn(axis, want, slotOrder(line+1, len(want), line-1))
	var payer *Card
	if pays >= 0 {
		for _, c := range g.list {
			if c.get(lo) <= pays && c.get(hi) > pays && c != fresh {
				payer = c
				break
			}
		}
	}
	if payer != nil || pays < 0 {
		side := "lo"
		if pays > line {
			side = "hi"
		}
		record := Paid{Side: side, Span: gave}
		if payer != nil {
			record.To = payer.ID
			at := pays - payer.get(lo)
			record.At = &at
		}
		g.paidBy[fresh.ID] = record
	}
	g.changed()
	if !g.stillFits(axis, was, empty) {
		g.restore(undo)
		return "", false
	}
	return fresh.ID, true
}

// spansPlane is whether a card occupies one slot on one axis and spans the whole other axis.
func (g *Grid) spansPlane(card *Card, axis Axis) bool {
	lo, hi := span(axis)
	alo, ahi := span(other(axis))
	return card.get(hi)-card.get(lo) == 1 && card.get(alo) == 0 && card.get(ahi) == len(g.arr(other(axis)))-1
}

// openSlot inserts a slot at a boundary with the given span and returns the side the span came from, or "all" when every slot gave a
// share of it.
func (g *Grid) openSlot(axis Axis, line int, spanned float64) string {
	a := g.arr(axis)
	after, before := 0.0, 0.0
	if line < len(a)-1 {
		after = a[line+1] - a[line]
	}
	if line > 0 {
		before = a[line] - a[line-1]
	}
	var gave string
	switch {
	case after >= spanned:
		g.insertLine(axis, line+1, a[line]+spanned)
		gave = "hi"
	case before >= spanned:
		at := a[line]
		a[line] = at - spanned
		g.insertLine(axis, line+1, at)
		gave = "lo"
	default:
		keep := 1 - spanned
		// float64 rounds each product before it is added, as JavaScript does; without it Go may fuse them (number.go).
		at := float64(a[line]*keep) + spanned
		for k := range a {
			if k <= line {
				a[k] = a[k] * keep
			} else {
				// float64 rounds each product before it is added, as JavaScript does; without it Go may fuse them (number.go).
				a[k] = float64(a[k]*keep) + spanned
			}
		}
		g.insertLine(axis, line+1, at)
		b := g.arr(axis)
		b[len(b)-1] = 1
		gave = "all"
	}
	g.openIndex(axis, line)
	return gave
}

// openIndex shifts the spans that referenced a boundary past a new slot there.
func (g *Grid) openIndex(axis Axis, line int) {
	lo, hi := span(axis)
	for _, card := range g.list {
		if card.get(lo) >= line {
			card.set(lo, card.get(lo)+1)
		}
		if card.get(hi) > line {
			card.set(hi, card.get(hi)+1)
		}
	}
}

// removeLine removes one line and shifts the spans that referenced it. into selects which neighbouring slot absorbs the removed one.
func (g *Grid) removeLine(axis Axis, gone int, into string) {
	g.setArr(axis, slices.Delete(slices.Clone(g.arr(axis)), gone, gone+1))
	lo, hi := span(axis)
	for _, card := range g.list {
		if card.get(lo) >= gone {
			card.set(lo, card.get(lo)-1)
		}
		if (into == "lo" && card.get(hi) > gone) || (into != "lo" && card.get(hi) >= gone) {
			card.set(hi, card.get(hi)-1)
		}
	}
}

// dropSlot removes one slot by removing the interior line beside it.
func (g *Grid) dropSlot(axis Axis, slot int) {
	last := slot+1 >= len(g.arr(axis))-1
	if last {
		g.removeLine(axis, slot, "lo")
	} else {
		g.removeLine(axis, slot+1, "hi")
	}
}

// MoveTo moves a plane-spanning card to another boundary. The card's slot is removed and a slot of the same span is inserted at the
// target.
func (g *Grid) MoveTo(id string, axis Axis, line int) bool {
	if noAxis(axis) {
		return false
	}
	card := g.find(id)
	if card == nil || !g.spansPlane(card, axis) {
		return false
	}
	lo, hi := span(axis)
	from := card.get(lo)
	if line == from || line == card.get(hi) {
		return true
	}
	before := g.ToJSON()
	empty := g.flat()
	was := slices.Clone(g.arr(axis))
	spanned := was[from+1] - was[from]
	g.removeCard(card)
	g.removeLine(axis, from+1, "hi")
	target := line
	if line > from+1 {
		target = line - 1
	}
	if !g.CanInsertAt(axis, target, "") {
		g.restore(before)
		return false
	}
	g.insertLine(axis, target, 0)
	g.openIndex(axis, target)
	a := g.arr(axis)
	if target <= from {
		for k := 0; k <= target; k++ {
			a[k] = was[k]
		}
		for k := target + 1; k <= from+1; k++ {
			a[k] = was[k-1] + spanned
		}
		for k := from + 2; k < len(a); k++ {
			a[k] = was[k]
		}
	} else {
		for k := 0; k <= from; k++ {
			a[k] = was[k]
		}
		for k := from + 1; k < target; k++ {
			a[k] = was[k+1] - spanned
		}
		a[target] = was[line] - spanned
		for k := target + 1; k < len(a); k++ {
			a[k] = was[k]
		}
	}
	alo, ahi := span(other(axis))
	card.set(lo, target)
	card.set(hi, target+1)
	card.set(alo, 0)
	card.set(ahi, len(g.arr(other(axis)))-1)
	g.list = append(g.list, card)
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

// Move moves a card to one side of another, keeping its id and its payload.
func (g *Grid) Move(id, targetID string, side Side) bool {
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
	if !g.Close(id) {
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
	ok := g.Move(id, targetID, side)
	g.restore(before)
	g.probing = probing
	g.seq = seq
	g.splitMemo[key] = ok
	return ok
}

// changed runs after every operation that changes the arrangement.
func (g *Grid) changed() {
	if !g.probing {
		clear(g.splitMemo)
	}
	g.agreeSizes()
	clear(g.sliceMemo)
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
	g.agreeSizes()
	clear(g.sliceMemo)
	if !g.probing {
		clear(g.splitMemo)
	}
}
