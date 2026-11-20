package layout

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
)

// The grid over shared lines. xs and ys hold every coordinate; a card is a span of indices into them, so two cards that meet
// reference the same index and their shared boundary is one value. Splitting replaces one card with two, so the arrangement stays a
// slicing floorplan and every card can be closed.

const eps = 1e-9

// Options are the layout options. A field that is nil takes its default: gap 24, minSize 96, grabSize 11, snapDistance 7, snap
// "merge", width and height 0.
type Options struct {
	Gap          *float64 `json:"gap"`
	MinSize      *float64 `json:"minSize"`
	GrabSize     *float64 `json:"grabSize"`
	SnapDistance *float64 `json:"snapDistance"`
	Snap         *string  `json:"snap"`
	// Frames is what the frame of a box takes on its left, right and bottom side; the default is corridor (see frameMode).
	Frames *string  `json:"frames"`
	Width  *float64 `json:"width"`
	Height *float64 `json:"height"`
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

// Grid holds the state and the operations of the layout. root is the state; xs, ys, list, at, leaves and the px layout are derived from
// root after every change (lay.go).
type Grid struct {
	root   *Node
	xs, ys []float64
	list   []*Card
	at     map[*Node]nodeLines
	leaves map[string]*Node
	// byID is the card of each id, and up the node that holds each node with its index, as derive built them.
	byID map[string]*Card
	up   map[*Node]holding
	// boxByID is the box node of each box id; spots is the slot of each node in the coordinates of the lines, and insets the px that its
	// corridors and frames take inside that slot on each side.
	boxByID       map[string]*Node
	spots, insets map[*Node]extent
	// unit is the corridor of each axis that the tree was laid with, and linesAt the px position of each line, nil before the plane has a
	// size; moved tells that an operation moved the lines since, so their px positions are their fractions of the extent until commit.
	unit    perAxis
	linesAt map[Axis][]float64
	moved   bool
	// above is the px of the heads of the boxes that start on the top line of each card and box, drawn inside its top.
	above map[string]float64
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
	grab          float64
	snapAt        float64
	snapMode      string
	frameAt       string
	frames        frameRead
	// cardFrames is the frames of each card by id, which lay reads from the boxes of the tree.
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
	g := &Grid{splitMemo: map[string]bool{}, gap: 24}
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
	g.frameAt = "corridor"
	if options.Frames != nil {
		if err := frameMode(*options.Frames); err != nil {
			return nil, err
		}
		g.frameAt = *options.Frames
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
	g.commit()
	return g, nil
}

// load takes the tree of a state as a copy and derives the lines and the cells.
func (g *Grid) load(state State) {
	g.root = cloneNode(state.Root)
	g.moved = false
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
	// The fractions stay, and the tree is laid with the new corridor.
	if len(g.list) > 0 {
		g.derive()
	}
}

// frameMode refuses a value that is no frame mode, naming it. corridor: the frame of a box takes one corridor on its left, right and
// bottom side, so a box stands one corridor around its inner node; none: it takes nothing, so a box is drawn at the rectangle of its
// inner node and the corridor between two boxes is one corridor, as at a seam where the corridor is the one border line that two boxes
// share.
func frameMode(mode string) error {
	if mode == "corridor" || mode == "none" {
		return nil
	}
	var text bytes.Buffer
	encoder := json.NewEncoder(&text)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(mode); err != nil {
		return err
	}
	return fmt.Errorf("soksak: frames is %s; use \"corridor\" or \"none\"", strings.TrimSuffix(text.String(), "\n"))
}

// Frames is what the frame of a box takes on its left, right and bottom side (R5).
func (g *Grid) Frames() string { return g.frameAt }

// SetFrames sets what the frame of a box takes. It keeps every fraction and lays the tree with the new frames; a value that is no frame
// mode is an error and changes nothing.
func (g *Grid) SetFrames(mode string) error {
	if err := frameMode(mode); err != nil {
		return err
	}
	g.frameAt = mode
	clear(g.splitMemo)
	if len(g.list) > 0 {
		g.derive()
	}
	return nil
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
	// The fractions stay, and the tree is laid into the new extent.
	if len(g.list) > 0 {
		g.derive()
	}
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
	if px != nil && (!finite(*px) || *px < 0) {
		return false
	}
	if px == nil {
		clearSizeOn(card, axis)
	} else {
		setSizeOn(card, axis, *px)
	}
	g.changed()
	return true
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
	return State{Root: cloneNode(g.root)}
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
	g.commit()
}

func (g *Grid) plane() *plane {
	p := &plane{xs: g.xs, ys: g.ys, cards: g.list, width: g.w, height: g.h, gap: g.gap, minSize: g.min, frames: g.cardFrames,
		read: &g.frames}
	if g.w > 0 && g.h > 0 {
		unit := g.unit
		p.unit = &unit
	}
	if !g.moved && g.linesAt != nil {
		p.linesAt = g.linesAt
	}
	return p
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

// Rect is the drawn rectangle of the card or the box id: a box is drawn between its lines, each inset by its corridor and by the frames of
// the boxes around it, so its frame and its head stand inside it (R5); the heads of the boxes around it that start on its top line are
// drawn inside its top, as inside the top of a card.
func (g *Grid) Rect(id string) (Rect, bool) {
	if card := g.find(id); card != nil {
		return rectOf(g.plane(), card), true
	}
	box := g.boxByID[id]
	if box == nil {
		return Rect{}, false
	}
	l := g.at[box]
	inset := g.insets[box]
	x := g.BoundaryPos("x", l[0]) + inset.x0
	y := g.BoundaryPos("y", l[2]) + inset.y0 - g.above[id]
	return Rect{X: x, Y: y, W: math.Max(0, g.BoundaryPos("x", l[1])-inset.x1-x), H: math.Max(0, g.BoundaryPos("y", l[3])-inset.y1-y)}, true
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

// resizeCard draws the card holder, which declares a px size on axis, delta px larger by moving the boundary line at one of its edges.
// A px size belongs to its card of the tree, whatever cells the lines of other cuts draw across the card. The drag moves every seam that
// stands on the line, so every card that declares a px size and has its edge on that side of the line takes the same difference. When
// cards on the other side declare px sizes as well, they give the difference and every declaration on the two sides changes by it at
// the scale it is drawn at: a plane that draws its declared sizes scaled keeps its scale, and no third card is redrawn. The line moves by
// the difference, so the commit reads the fractions of a kid that pays from it.
func (g *Grid) resizeCard(axis Axis, holder *Card, line int, delta float64) {
	lo, hi := span(axis)
	ends := holder.get(hi) == line
	declared := func(near bool) []*Card {
		out := []*Card{}
		for _, c := range g.list {
			edge := c.get(lo) == line
			if near == ends {
				edge = c.get(hi) == line
			}
			if edge && fixedSize(c, axis) != nil {
				out = append(out, c)
			}
		}
		return out
	}
	near, far := declared(true), declared(false)
	type size struct{ own, now float64 }
	sizes := map[*Card]size{}
	frame := frameOf(g.plane())
	for _, c := range append(slices.Clone(near), far...) {
		r := rectIn(frame, c)
		now := r.H
		if axis == "x" {
			now = r.W
		}
		sizes[c] = size{*fixedSize(c, axis), now}
	}
	change := func(c *Card, by float64) {
		s := sizes[c]
		next := s.now + by
		if len(far) > 0 {
			rate := 1.0
			if s.now > eps {
				rate = s.own / s.now
			}
			next = s.own + float64(by*rate)
		}
		setSizeOn(c, axis, math.Max(0, next))
	}
	for _, c := range near {
		change(c, delta)
	}
	for _, c := range far {
		change(c, -delta)
	}
	a := g.arr(axis)
	step := delta
	if !ends {
		step = -delta
	}
	g.moved = true
	a[line] = clamp(a[line]+step/g.size(axis), a[line-1], a[line+1])
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
	// A move to where the boundary stands changes nothing, a declared size that the plane draws scaled included.
	if math.Abs(target-g.BoundaryPos(axis, line)) < 1e-9 {
		return g.BoundaryPos(axis, line)
	}
	if holder := g.holderAt(axis, line); holder != nil {
		// The card is drawn larger by what its far edge moves toward the target, or smaller by what its near edge does.
		_, hi := span(axis)
		off := target - g.BoundaryPos(axis, line)
		if holder.get(hi) != line {
			off = -off
		}
		g.resizeCard(axis, holder, line, off)
	} else {
		// Once a line moves, every line stands at its coordinate over the extent of the plane, and the commit reads the fractions of
		// the kids beside it from there, so the coordinate of the target is where the line stands. The neighbouring lines bound it, so
		// the line array stays in order.
		a := g.arr(axis)
		g.moved = true
		a[line] = clamp(target/g.size(axis), a[line-1], a[line+1])
	}
	// The position is read before the tree takes the lines, because a boundary that reached a neighbouring line joins it there and the
	// index line then names the next line.
	at := g.BoundaryPos(axis, line)
	g.moved = true
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
	// A move lands where it is asked inside the range of the boundary, and the outer edges of the two cards beside the line stay, so one
	// move reaches the middle.
	return g.MoveBoundary(axis, line, g.middleOf(axis, line), false)
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
	// The drawn size of a card along an axis with count cells: the corridors between the cells are costs of the cut, and each cell takes
	// one equal fraction of the rest.
	cellSize := func(count int, size float64) float64 {
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
	// Every cell has one fraction, so every cell is drawn at one size.
	cut := func(axis Axis, kids []*Node) *Node {
		if len(kids) == 1 {
			return kids[0]
		}
		out := &Node{Cut: axis}
		for _, kid := range kids {
			out.Kids = append(out.Kids, Kid{Share: 1 / float64(len(kids)), Node: kid})
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
		columnNodes = append(columnNodes, cut("y", column))
	}
	g.reload(State{Root: cut("x", columnNodes)})
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
// new line at the centre (line -1), clamped to the range where both halves fit. Where the halves cannot both have their minimum, it is
// the centre, and the check of the split names the node that the cut draws below its minimum. It is false when the card is fixed or is
// drawn no wider than the corridor that the cut adds, so that a half would have no extent.
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
	p := g.plane()
	read := linesRead(p, axis)
	half := halfCorridor(p, axis, read)
	mid := (a[card.get(lo)] + a[card.get(hi)]) / 2
	lowest := a[card.get(lo)] + (g.min+cardInset(p, axis, card, "lo", read)+half)/per
	highest := a[card.get(hi)] - (g.min+half+cardInset(p, axis, card, "hi", read))/per
	if lowest > highest {
		if a[card.get(lo)]+(cardInset(p, axis, card, "lo", read)+half)/per >= mid ||
			a[card.get(hi)]-(half+cardInset(p, axis, card, "hi", read))/per <= mid {
			return 0, 0, false
		}
		lowest, highest = mid, mid
	}
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

// CanSplit is true when Split of the card id along axis would succeed.
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
			_, err := g.Split(id, axis, SplitInit{})
			ok = err == nil
			g.restore(before)
			g.probing = false
			g.seq = seq
		}
	}
	g.splitMemo[key] = ok
	return ok
}

// Split cuts one card in two and returns the new card's id. The original keeps its id and the near half; the new card takes the far
// half. Its refusal names the deepest node that the cut would draw below its minimum, and changes nothing.
// With init.NewLine the cut takes a new position at the centre instead of a line that the card spans across.
func (g *Grid) Split(id string, axis Axis, init SplitInit) (string, error) {
	defer g.begin()()
	if noAxis(axis) {
		return "", fmt.Errorf("unknown axis %s; use x or y", axis)
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

// SplitToward cuts a card and puts the new one on a named side. The ids are not swapped. Its refusal is the refusal of Split.
func (g *Grid) SplitToward(id string, side Side, init SplitInit) (string, error) {
	defer g.begin()()
	if !isSide(side) {
		return "", fmt.Errorf("unknown side %s; use left, right, top or bottom", side)
	}
	return g.splitAt(id, axisOf(side), init, isAhead(side))
}

// splitAt cuts the card id along axis at the position of cutAt: the card keeps its part of the extent before the cut and the new card
// takes the part after it, or with first the new card takes the part before it. A px size of the card on the axis is divided between
// the two parts in the proportion of the cut, and one across it is given to the new card as well. A cut at the middle of a card without
// a px size on the axis is the ADD of the new card beside the card (packages/soksak/docs/layout.md#add-and-remove).
func (g *Grid) splitAt(id string, axis Axis, init SplitInit, first bool) (string, error) {
	if init.ID != nil && g.taken(*init.ID) {
		return "", fmt.Errorf("card %s is a member of the layout", *init.ID)
	}
	card := g.find(id)
	if card == nil {
		return "", notMember(id)
	}
	if card.Fixed {
		return "", fmt.Errorf("card %s is fixed and does not split", id)
	}
	cutLine, _, cuts := g.cutAt(card, axis, init.NewLine)
	if !cuts {
		// The card is drawn no wider than the corridor of the cut, so a half would have no extent on the axis.
		r, _ := g.Rect(id) // silent: find found the card.
		w, h := r.W, r.H-g.above[id]
		if axis == "x" {
			w = 0
		} else {
			h = 0
		}
		m := jsString(jsRound(g.min))
		return "", fmt.Errorf("card %s would be %sx%s, below its minimum %sx%s", id, jsString(jsRound(w)), jsString(jsRound(h)), m, m)
	}
	undo := g.ToJSON()
	leaf := g.leaves[id]
	drawnBefore := g.Rects()
	// A cut at the middle gives the halves one fraction each, so they are drawn at one size. A cut at a line of the plane gives each half
	// the fraction of the size that it is drawn at between the edge of the card and that line.
	f := 0.5
	if cutLine >= 0 {
		lo, hi := ends(axis)
		slot, inset := g.spots[leaf], g.insets[leaf]
		size := g.size(axis)
		u := g.unit.of(axis)
		line := g.arr(axis)[cutLine] * size
		near := line - u/2 - (float64(slot.get(lo)*size) + inset.get(lo))
		far := float64(slot.get(hi)*size) - inset.get(hi) - line - u/2
		if near > 0 && far > 0 {
			f = near / (near + far)
		}
	}
	freshID := ""
	if init.ID != nil {
		freshID = *init.ID
	} else {
		freshID = g.nextID()
	}
	fresh := &Node{Card: freshID, Data: init.Data}
	freshCard := &Card{}
	if alongside := fixedSize(card, other(axis)); alongside != nil {
		setSizeOn(freshCard, other(axis), *alongside)
	}
	whole := fixedSize(card, axis)
	if whole != nil {
		mine, theirs := *whole*f, *whole*(1-f)
		if first {
			mine, theirs = *whole*(1-f), *whole*f
		}
		leafCard := &Card{Width: leaf.Width, Height: leaf.Height}
		setSizeOn(leafCard, axis, mine)
		leaf.Width, leaf.Height = leafCard.Width, leafCard.Height
		setSizeOn(card, axis, mine)
		setSizeOn(freshCard, axis, theirs)
	}
	fresh.Width, fresh.Height = freshCard.Width, freshCard.Height
	if whole == nil && cutLine < 0 {
		// Along the cut that holds it, an even cut gives the new card 1/(k+1) and an uneven one half of the card; across, two halves.
		side := Side("right")
		switch {
		case axis == "x" && first:
			side = "left"
		case axis == "y" && first:
			side = "top"
		case axis == "y":
			side = "bottom"
		}
		root, err := g.insertBeside(leaf, side, fresh)
		if err != nil {
			g.restore(undo)
			return "", err
		}
		g.root = root
	} else {
		kids := []Kid{{Share: f, Node: leaf}, {Share: 1 - f, Node: fresh}}
		if first {
			kids = []Kid{{Share: f, Node: fresh}, {Share: 1 - f, Node: leaf}}
		}
		g.put(leaf, &Node{Cut: axis, Kids: kids})
	}
	g.derive()
	g.changed()
	g.keepFixed(drawnBefore)
	if below := g.belowMinimum(drawnBefore); below != "" {
		g.restore(undo)
		return "", errors.New(below)
	}
	return freshID, nil
}

func (g *Grid) nextID() string {
	for {
		g.seq++
		id := "card-" + itoa(g.seq)
		if !g.taken(id) {
			return id
		}
	}
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
	return g.closing(id)
}

// closing is whether the card id can close: it is not fixed and not the last card, and its cut holds another kid that is no fixed card.
func (g *Grid) closing(id string) bool {
	if g.removable(id) == nil {
		return false
	}
	return g.leaving(g.leaves[id])
}

// leaving tells whether the node that leaves with the node n, n or the box around it that holds nothing else, stands in a cut with
// another kid that is no fixed card, which takes its share.
func (g *Grid) leaving(n *Node) bool {
	h, i := g.holder(g.departing(n))
	if h == nil || i < 0 {
		return false
	}
	return slices.ContainsFunc(h.Kids, func(k Kid) bool { return k.Node != h.Kids[i].Node && !(k.Node.isCard() && k.Node.Fixed) })
}

// Close removes a card (packages/soksak/docs/layout.md#boundaries): the node that leaves with it goes out of its cut, and the fractions
// of the other kids of the cut that are no fixed card scale by one factor, so their ratios hold; a fixed card keeps the size it is drawn
// at. It is false when the card is fixed, when it is the last card, or when every other kid of its cut is a fixed card.
func (g *Grid) Close(id string) bool {
	defer g.begin()()
	return g.closeAlong(id)
}

// closeAlong is Close inside another operation.
func (g *Grid) closeAlong(id string) bool {
	if !g.closing(id) {
		return false
	}
	g.withdrawAlong(g.leaves[id])
	return true
}

// withdrawAlong takes the node that leaves with the node n out of its cut, as a close does, after leaving allowed it.
func (g *Grid) withdrawAlong(n *Node) {
	drawnBefore := g.Rects()
	root, _, err := g.withdrawNode(g.departing(n).id())
	if err != nil {
		panic("soksak: a close that closing allowed was refused: " + err.Error())
	}
	g.root = root
	g.derive()
	g.changed()
	g.keepFixed(drawnBefore)
}

// closeBox closes the box id with every card inside it as one node of the tree: the node leaves its cut and the other kids of the cut
// that are no fixed card take its share by one factor (R7). It is false, and changes nothing, when the box is no box, when it holds
// every card that is not fixed, or when no other kid of its cut takes the share.
func (g *Grid) closeBox(id string) bool {
	box := g.boxByID[id]
	if box == nil {
		return false
	}
	inside := map[string]bool{}
	for _, leaf := range cardsOf(box) {
		inside[leaf.Card] = true
	}
	if !slices.ContainsFunc(g.list, func(c *Card) bool { return !c.Fixed && !inside[c.ID] }) || !g.leaving(box) {
		return false
	}
	g.withdrawAlong(box)
	return true
}

// CanInsertAt is whether a card spanning the whole plane can be placed on this boundary: the line is an edge of the plane or a seam
// of the root cut along axis.
func (g *Grid) CanInsertAt(axis Axis, line int) bool {
	if noAxis(axis) {
		return false
	}
	if line < 0 || line > len(g.arr(axis))-1 {
		return false
	}
	_, ok := g.standing(axis, line)
	return ok
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

// InsertAt inserts a card at a boundary, spanning the whole plane on the other axis, as a kid of the root cut along axis, and returns its
// id. A boundary between kids i and i + 1 of the root is the add of the card beside kid i toward kid i + 1
// (packages/soksak/docs/layout.md#boundaries), and an edge of the plane is the add beside the root as a whole. It is false when a card
// spans the boundary, the line is no seam of the root, the size is not smaller than the plane, or the result would leave a card with no
// area or below the size it had and minSize.
func (g *Grid) InsertAt(axis Axis, line int, init InsertInit) (string, bool) {
	defer g.begin()()
	if noAxis(axis) {
		return "", false
	}
	if init.ID != nil && g.taken(*init.ID) {
		return "", false
	}
	extent := g.size(axis)
	if init.Size == nil || !finite(*init.Size) || *init.Size < 0 || *init.Size >= extent {
		return "", false
	}
	if !g.CanInsertAt(axis, line) {
		return "", false
	}
	at, ok := g.standing(axis, line)
	if !ok {
		return "", false
	}
	was := g.extents(axis)
	empty := g.flat()
	undo := g.ToJSON()
	freshID := ""
	if init.ID != nil {
		freshID = *init.ID
	} else {
		freshID = g.nextID()
	}
	fresh := &Node{Card: freshID, Data: init.Data}
	size := *init.Size
	if axis == "x" {
		fresh.Width = &size
	} else {
		fresh.Height = &size
	}
	before, after := Side("left"), Side("right")
	if axis == "y" {
		before, after = "top", "bottom"
	}
	side := after
	if line == 0 {
		side = before
	}
	target := g.root
	if line != 0 && line != len(g.arr(axis))-1 {
		target = g.root.Kids[at-1].Node
	}
	drawnBefore := g.Rects()
	root, err := g.insertBeside(target, side, fresh)
	if err != nil {
		g.restore(undo)
		return "", false
	}
	g.root = root
	g.derive()
	g.changed()
	g.keepFixed(drawnBefore)
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
	if !g.CanInsertAt(axis, line) {
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

// Standings is every boundary a plane-spanning card could stand on: the edges of the plane and the seams of the root cut along axis.
func (g *Grid) Standings(axis Axis) []int {
	out := []int{}
	for k := 0; k < len(g.arr(axis)); k++ {
		if g.CanInsertAt(axis, k) {
			out = append(out, k)
		}
	}
	return out
}

// Move moves a card to one side of another, keeping its id, its payload and its px sizes. A move is a REMOVE and an ADD
// (packages/soksak/docs/layout.md#add-and-remove): the card node leaves its cut and is added beside the target.
func (g *Grid) Move(id, targetID string, side Side) bool {
	defer g.begin()()
	if !isSide(side) {
		return false
	}
	card := g.find(id)
	target := g.find(targetID)
	if card == nil || target == nil || card == target || card.Fixed {
		return false
	}
	node := cloneNode(g.leaves[id])
	before := g.ToJSON()
	if !g.closeAlong(id) {
		return false
	}
	if err := g.byCuts(func() (*Node, error) { return g.insertNode(Target{targetID}, side, node) }); err != nil {
		g.restore(before)
		return false
	}
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

// changed runs after every operation that changes the arrangement: the sizes agree and the tree takes the lines and the attributes.
func (g *Grid) changed() {
	if !g.probing {
		clear(g.splitMemo)
	}
	g.commit()
}

// restore restores the arrangement to a state returned earlier by ToJSON.
func (g *Grid) restore(state State) {
	g.load(state)
	if !g.probing {
		clear(g.splitMemo)
	}
}
