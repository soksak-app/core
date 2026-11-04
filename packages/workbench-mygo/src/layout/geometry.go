package layout

import (
	"math"
	"sort"
	"strconv"
)

// The coordinates of the plane. xs and ys hold every position, normalised 0..1 over the slots that share the remaining space; a slot
// with a px size is drawn at that size whatever its span. A card is a span of indices into them. Every function here is pure and
// takes the plane as an argument.

// plane is everything a coordinate depends on. The line slices share their elements with the grid.
type plane struct {
	xs, ys  []float64
	cards   []*Card
	width   float64
	height  float64
	gap     float64
	minSize float64
}

// opt is a number or none, the number | null of the model.
type opt struct {
	v  float64
	ok bool
}

func some(v float64) opt { return opt{v: v, ok: true} }

var none = opt{}

// lineSet is the set of line indices that at least one card references.
type lineSet map[int]struct{}

func (s lineSet) has(i int) bool {
	_, ok := s[i]
	return ok
}

func (p *plane) lines(axis Axis) []float64 {
	if axis == "x" {
		return p.xs
	}
	return p.ys
}

func (p *plane) extent(axis Axis) float64 {
	if axis == "x" {
		return p.width
	}
	return p.height
}

// corridorOf is the gap a slot holds: half a gap for every card edge that insets into it. A run of lines at one position takes the
// largest value rather than the sum.
func corridorOf(p *plane, axis Axis, slot int, read lineSet) float64 {
	a := p.lines(axis)
	if blank(p, axis, slot) {
		return 0
	}
	lo := inset(p, axis, slot, "lo", read)
	for k := slot - 1; k >= 0 && blank(p, axis, k); k-- {
		lo = math.Max(lo, inset(p, axis, k, "lo", read))
	}
	hi := inset(p, axis, slot+1, "hi", read)
	for k := slot + 2; k < len(a) && blank(p, axis, k-1); k++ {
		hi = math.Max(hi, inset(p, axis, k, "hi", read))
	}
	return lo + hi
}

// corridorWhenWide is the corridor a slot holds once it has a width.
func corridorWhenWide(p *plane, axis Axis, slot int, read lineSet) float64 {
	if !blank(p, axis, slot) {
		return corridorOf(p, axis, slot, read)
	}
	a := p.lines(axis)
	half := halfCorridor(p, axis, read)
	edge := func(k int, border bool) float64 {
		if border || !read.has(k) {
			return 0
		}
		return half
	}
	lo := edge(slot, slot == 0)
	hi := edge(slot+1, slot+1 == len(a)-1)
	for k := slot - 1; k >= 0 && blank(p, axis, k); k-- {
		lo = math.Max(lo, edge(k, k == 0))
	}
	for k := slot + 2; k < len(a) && blank(p, axis, k-1); k++ {
		hi = math.Max(hi, edge(k, k == len(a)-1))
	}
	return lo + hi
}

// blank is true when a slot draws at zero width: no span to take a share with and no px size.
func blank(p *plane, axis Axis, slot int) bool {
	a := p.lines(axis)
	if a[slot+1]-a[slot] >= 1e-9 {
		return false
	}
	lo := low(axis)
	for _, card := range p.cards {
		if card.get(lo) == slot && fixedSize(card, axis) != nil {
			return false
		}
	}
	return true
}

// heldSizes is the px size each slot declares: the largest value any card in it sets.
func heldSizes(p *plane, axis Axis) []opt {
	lo := low(axis)
	held := make([]opt, len(p.lines(axis))-1)
	for _, card := range p.cards {
		size := fixedSize(card, axis)
		if size == nil {
			continue
		}
		at := card.get(lo)
		was := 0.0
		if held[at].ok {
			was = held[at].v
		}
		held[at] = some(math.Max(was, *size))
	}
	return held
}

// slotWidths is the drawn width of every slot, gap removed.
func slotWidths(p *plane, axis Axis) []float64 {
	read := linesRead(p, axis)
	sizes := slotSizes(p, axis)
	out := make([]float64, len(sizes))
	for i, size := range sizes {
		out[i] = size - corridorOf(p, axis, i, read)
	}
	return out
}

// demand is what the slots on an axis ask of the plane.
func demand(p *plane, axis Axis) (asked, taken, sharedSpan, floor float64) {
	a := p.lines(axis)
	count := len(a) - 1
	read := linesRead(p, axis)
	held := heldSizes(p, axis)
	for i := 0; i < count; i++ {
		if held[i].ok {
			asked += held[i].v
			taken += corridorOf(p, axis, i, read)
		} else {
			sharedSpan += a[i+1] - a[i]
			floor += corridorOf(p, axis, i, read)
		}
	}
	if sharedSpan > 1e-9 {
		floor += p.minSize
	}
	return
}

// holdsSizes is whether the plane holds what the slots on this axis declare.
func holdsSizes(p *plane, axis Axis) bool {
	asked, taken, sharedSpan, floor := demand(p, axis)
	return sharedSpan > 1e-9 && p.extent(axis)-asked-taken >= floor
}

// declaredFor is the px size a slot has to declare to be drawn `drawn` px wide.
func declaredFor(p *plane, axis Axis, slot int, drawn float64) float64 {
	now := heldSizes(p, axis)[slot].v
	if math.Abs(slotWidths(p, axis)[slot]-drawn) <= 1e-9 {
		return now
	}
	asked, taken, sharedSpan, floor := demand(p, axis)
	room := p.extent(axis)
	if sharedSpan > 1e-9 && room-(asked-now+drawn)-taken >= floor-1e-9 {
		return drawn
	}
	other := asked - now
	keep := math.Min(floor, math.Max(0, room-taken))
	left := math.Max(0, room-keep-taken)
	if other <= 1e-9 || drawn >= left-1e-9 {
		return now
	}
	return math.Max(drawn, (drawn*other)/(left-drawn))
}

// slotSizes is the width in px of every slot on an axis.
func slotSizes(p *plane, axis Axis) []float64 {
	// silent: a caller of this function reads the sizes and not the worth of a unit of shared span.
	size, _ := divide(p, axis)
	return size
}

// sharePerSpan is the px a sharing slot is drawn at per unit of its span.
func sharePerSpan(p *plane, axis Axis) float64 {
	_, each := divide(p, axis)
	return each
}

// divide is the size of every slot on an axis, and what one unit of shared span is worth.
func divide(p *plane, axis Axis) ([]float64, float64) {
	a := p.lines(axis)
	count := len(a) - 1
	read := linesRead(p, axis)
	corridor := make([]float64, count)
	for i := 0; i < count; i++ {
		corridor[i] = corridorOf(p, axis, i, read)
	}
	held := heldSizes(p, axis)
	var asked, taken, sharedSpan, floor float64
	for i := 0; i < count; i++ {
		if held[i].ok {
			asked += held[i].v
			taken += corridor[i]
		} else {
			sharedSpan += a[i+1] - a[i]
			floor += corridor[i]
		}
	}
	if sharedSpan > 1e-9 {
		floor += p.minSize
	}
	usable := p.extent(axis) - asked - taken
	if sharedSpan > 1e-9 && usable >= floor {
		size := make([]float64, count)
		for i := range held {
			if held[i].ok {
				size[i] = held[i].v + corridor[i]
			}
		}
		lo, hi := span(axis)
		stopped := make([]bool, count)
		runFrom := make([]int, count)
		runTo := make([]int, count)
		for i := 0; i < count; {
			end := i + 1
			for end < count && !read.has(end) {
				end++
			}
			for k := i; k < end; k++ {
				runFrom[k] = i
				runTo[k] = end
			}
			i = end
		}
		room := usable
		pool := sharedSpan
		for {
			each := room / pool
			starved := -1
			for _, card := range p.cards {
				fixed, spanned, need, first := 0.0, 0.0, 0.0, -1
				for i := card.get(lo); i < card.get(hi); i++ {
					need += corridor[i]
					if held[i].ok || stopped[i] {
						fixed += size[i]
						continue
					}
					spanned += a[i+1] - a[i]
					if first < 0 {
						first = i
					}
				}
				// float64 rounds each product before it is added, as JavaScript does; without it Go may fuse them (number.go).
				if first >= 0 && fixed+float64(spanned*each) < need-1e-9 {
					starved = first
					break
				}
			}
			if starved < 0 {
				for i := 0; i < count; i++ {
					if held[i].ok || stopped[i] {
						continue
					}
					size[i] = (a[i+1] - a[i]) * each
				}
				return size, each
			}
			for i := runFrom[starved]; i < runTo[starved]; i++ {
				stopped[i] = true
				size[i] = corridor[i]
				room -= corridor[i]
				pool -= a[i+1] - a[i]
			}
		}
	}

	// The requested sizes do not fit, or no slot shares: the sharing slots keep their floor and the px sizes scale by one factor.
	keep := math.Min(floor, math.Max(0, p.extent(axis)-taken))
	left := math.Max(0, p.extent(axis)-keep-taken)
	scale := 0.0
	if asked > 1e-9 {
		scale = left / asked
	}
	floors := 0.0
	for i := 0; i < count; i++ {
		if !held[i].ok {
			floors += corridor[i]
		}
	}
	spare := math.Max(0, keep-floors)
	each := 0.0
	if sharedSpan > 1e-9 {
		each = spare / sharedSpan
	}
	size := make([]float64, count)
	if asked <= 1e-9 {
		heldSpan, heldSlots := 0.0, 0
		for i := 0; i < count; i++ {
			if !held[i].ok {
				continue
			}
			heldSpan += a[i+1] - a[i]
			heldSlots++
		}
		for i := range held {
			if held[i].ok {
				if heldSpan > 1e-9 {
					size[i] = corridor[i] + (left*(a[i+1]-a[i]))/heldSpan
				} else {
					size[i] = corridor[i] + left/float64(heldSlots)
				}
			} else {
				// float64 rounds each product before it is added, as JavaScript does; without it Go may fuse them (number.go).
				size[i] = corridor[i] + float64((a[i+1]-a[i])*each)
			}
		}
		return size, each
	}
	for i := range held {
		if held[i].ok {
			// float64 rounds each product before it is added, as JavaScript does; without it Go may fuse them (number.go).
			size[i] = float64(held[i].v*scale) + corridor[i]
		} else {
			// float64 rounds each product before it is added, as JavaScript does; without it Go may fuse them (number.go).
			size[i] = corridor[i] + float64((a[i+1]-a[i])*each)
		}
	}
	return size, each
}

// linePositions is every line position in px, index for index with the line array.
func linePositions(p *plane, axis Axis) []float64 {
	sizes := slotSizes(p, axis)
	out := make([]float64, 1, len(sizes)+1)
	for _, size := range sizes {
		out = append(out, out[len(out)-1]+size)
	}
	return out
}

// corridor is the gap width for this axis, capped at what the plane can hold.
func corridor(p *plane, axis Axis, read lineSet) float64 {
	a := p.lines(axis)
	real := len(read)
	if read.has(0) {
		real--
	}
	if read.has(len(a) - 1) {
		real--
	}
	if real <= 0 {
		return p.gap
	}
	return math.Min(p.gap, math.Max(0, p.extent(axis))/float64(real))
}

// linesRead is the set of line indices that at least one card references.
func linesRead(p *plane, axis Axis) lineSet {
	lo, hi := span(axis)
	read := lineSet{}
	for _, card := range p.cards {
		read[card.get(lo)] = struct{}{}
		read[card.get(hi)] = struct{}{}
	}
	return read
}

// inset is how far a card's edge insets from the line it references.
func inset(p *plane, axis Axis, index int, side string, read lineSet) float64 {
	a := p.lines(axis)
	flush := index == len(a)-1
	if side == "lo" {
		flush = index == 0
	}
	if flush {
		return 0
	}
	if !read.has(index) {
		return 0
	}
	step, slot := -1, index-1
	if side == "lo" {
		step, slot = 1, index
	}
	for slot >= 0 && slot <= len(a)-2 && blank(p, axis, slot) {
		slot += step
	}
	if slot < 0 || slot > len(a)-2 {
		return 0
	}
	return corridor(p, axis, read) / 2
}

// halfCorridor is half the gap a referenced line takes, capped at what the plane can hold.
func halfCorridor(p *plane, axis Axis, read lineSet) float64 {
	return corridor(p, axis, read) / 2
}

// axle is the line positions and edge insets of one axis.
type axle struct {
	at, lo, hi []float64
}

// frame is the axles of both axes.
type frame struct {
	x, y axle
}

func (f *frame) of(axis Axis) *axle {
	if axis == "x" {
		return &f.x
	}
	return &f.y
}

func frameOf(p *plane) frame {
	axleOf := func(axis Axis) axle {
		a := p.lines(axis)
		read := linesRead(p, axis)
		sizes := slotSizes(p, axis)
		at := make([]float64, 1, len(sizes)+1)
		for _, size := range sizes {
			at = append(at, at[len(at)-1]+size)
		}
		lo := make([]float64, len(a))
		hi := make([]float64, len(a))
		for i := range a {
			lo[i] = inset(p, axis, i, "lo", read)
			hi[i] = inset(p, axis, i, "hi", read)
		}
		return axle{at: at, lo: lo, hi: hi}
	}
	return frame{x: axleOf("x"), y: axleOf("y")}
}

func rectIn(f frame, card *Card) Rect {
	x, w := spanIn(&f.x, card.C0, card.C1)
	y, h := spanIn(&f.y, card.R0, card.R1)
	return Rect{X: x, Y: y, W: w, H: h}
}

// spanIn is one axis of a rect: the card's start position and size. A card whose two lines are at one position is drawn at zero
// width in the middle of the slots it spans.
func spanIn(a *axle, lo, hi int) (float64, float64) {
	near := a.at[lo] + a.lo[lo]
	far := a.at[hi] - a.hi[hi]
	if far >= near-1e-6 {
		return near, math.Max(0, far-near)
	}
	return (a.at[lo] + a.at[hi]) / 2, 0
}

func rectOf(p *plane, card *Card) Rect {
	return rectIn(frameOf(p), card)
}

// crossing is the cards that span across a line.
func crossing(p *plane, axis Axis, line int) []*Card {
	lo, hi := span(axis)
	out := []*Card{}
	for _, c := range p.cards {
		if c.get(lo) < line && c.get(hi) > line {
			out = append(out, c)
		}
	}
	return out
}

// touchingCards is the cards indexed by the line they end at and the line they start at.
type touchingCards struct {
	ends, starts map[int][]*Card
}

func touching(p *plane, axis Axis) touchingCards {
	lo, hi := span(axis)
	t := touchingCards{ends: map[int][]*Card{}, starts: map[int][]*Card{}}
	for _, card := range p.cards {
		t.ends[card.get(hi)] = append(t.ends[card.get(hi)], card)
		t.starts[card.get(lo)] = append(t.starts[card.get(lo)], card)
	}
	return t
}

// boundarySpans is the index stretches where cards actually break on a line.
func boundarySpans(p *plane, axis Axis, line int, meet touchingCards) [][2]int {
	o0, o1 := span(other(axis))
	before := cover(meet.ends[line], o0, o1)
	after := cover(meet.starts[line], o0, o1)
	out := [][2]int{}
	i, j := 0, 0
	for i < len(before) && j < len(after) {
		start := max(before[i][0], after[j][0])
		end := min(before[i][1], after[j][1])
		if end > start {
			out = append(out, [2]int{start, end})
		}
		if before[i][1] < after[j][1] {
			i++
		} else {
			j++
		}
	}
	return out
}

// cover is the spans a set of cards covers on the other axis, sorted and merged.
func cover(cards []*Card, o0, o1 spanKey) [][2]int {
	if len(cards) == 0 {
		return nil
	}
	spans := make([][2]int, len(cards))
	for i, c := range cards {
		spans[i] = [2]int{c.get(o0), c.get(o1)}
	}
	sort.SliceStable(spans, func(a, b int) bool { return spans[a][0] < spans[b][0] })
	out := [][2]int{spans[0]}
	for _, s := range spans {
		last := &out[len(out)-1]
		if s[0] <= last[1] {
			last[1] = max(last[1], s[1])
		} else {
			out = append(out, s)
		}
	}
	return out
}

func isVirtual(read lineSet, line int) bool { return !read.has(line) }

// interiorLines is the interior line indices. The two borders are excluded.
func interiorLines(p *plane, axis Axis) []int {
	a := p.lines(axis)
	out := []int{}
	for k := 1; k < len(a)-1; k++ {
		out = append(out, k)
	}
	return out
}

// Rule is a boundary to draw: one virtual rule per line, plus its solid stretches.
type Rule struct {
	Key     string  `json:"key"`
	Axis    Axis    `json:"axis"`
	Line    int     `json:"line"`
	Virtual bool    `json:"virtual"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	W       float64 `json:"w"`
	H       float64 `json:"h"`
}

// Divider is the hit area for dragging a boundary.
type Divider struct {
	Key  string  `json:"key"`
	Axis Axis    `json:"axis"`
	Line int     `json:"line"`
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	W    float64 `json:"w"`
	H    float64 `json:"h"`
}

func rules(p *plane) []Rule {
	out := []Rule{}
	f := frameOf(p)
	for _, axis := range axes {
		along := f.of(axis).at
		across := p.width
		if axis == "x" {
			across = p.height
		}
		down := other(axis)
		half := halfCorridor(p, down, linesRead(p, down))
		meet := touching(p, axis)
		read := linesRead(p, axis)
		hold := func(v float64) float64 { return math.Min(math.Max(v, 0), across) }
		for _, line := range interiorLines(p, axis) {
			if isVirtual(read, line) {
				continue
			}
			at := along[line] - 0.5
			name := strconv.Itoa(line)
			if axis == "x" {
				out = append(out, Rule{Key: "vx:" + name, Axis: axis, Line: line, Virtual: true, X: at, Y: 0, W: 1, H: across})
			} else {
				out = append(out, Rule{Key: "vy:" + name, Axis: axis, Line: line, Virtual: true, X: 0, Y: at, W: across, H: 1})
			}
			d := f.of(down)
			for _, s := range boundarySpans(p, axis, line, meet) {
				from, to := s[0], s[1]
				start := hold(d.at[from] + d.lo[from] - half)
				end := hold(d.at[to] - d.hi[to] + half)
				key := ":" + name + ":" + strconv.Itoa(from)
				if axis == "x" {
					out = append(out, Rule{Key: "sx" + key, Axis: axis, Line: line, X: at, Y: start, W: 1, H: end - start})
				} else {
					out = append(out, Rule{Key: "sy" + key, Axis: axis, Line: line, X: start, Y: at, W: end - start, H: 1})
				}
			}
		}
	}
	return out
}

func dividers(p *plane, grabSize float64) []Divider {
	out := []Divider{}
	hit := math.Max(p.gap, grabSize)
	f := frameOf(p)
	for _, axis := range axes {
		along := f.of(axis).at
		down := other(axis)
		meet := touching(p, axis)
		for _, line := range interiorLines(p, axis) {
			d := f.of(down)
			for _, s := range boundarySpans(p, axis, line, meet) {
				from, to := s[0], s[1]
				start := d.at[from] + d.lo[from]
				end := d.at[to] - d.hi[to]
				run := math.Max(0, end-start)
				key := axis + ":" + strconv.Itoa(line) + ":" + strconv.Itoa(from)
				if axis == "x" {
					out = append(out, Divider{Key: key, Axis: axis, Line: line, X: along[line] - hit/2, Y: start, W: hit, H: run})
				} else {
					out = append(out, Divider{Key: key, Axis: axis, Line: line, X: start, Y: along[line] - hit/2, W: run, H: hit})
				}
			}
		}
	}
	return out
}

// ZoneHit is where a drop lands: which card, and which part of it ("centre" or a side).
type ZoneHit struct {
	ID   string `json:"id"`
	Zone string `json:"zone"`
}

// ZoneOptions are the chrome heights of a card, excluded from the drop sides, the fraction of the body each edge claims (default
// 0.25), and a card that always returns centre. A field that is nil is not given.
type ZoneOptions struct {
	HeaderPx   *float64 `json:"headerPx"`
	FooterPx   *float64 `json:"footerPx"`
	Edge       *float64 `json:"edge"`
	CentreOnly *string  `json:"centreOnly"`
}

// measured is a px measurement from the host, or 0 when it is not one.
func measured(px *float64) float64 {
	if px != nil && !math.IsNaN(*px) && !math.IsInf(*px, 0) && *px >= 0 {
		return *px
	}
	return 0
}

func zoneAt(p *plane, x, y float64, options ZoneOptions) *ZoneHit {
	if math.IsNaN(x) || math.IsInf(x, 0) || math.IsNaN(y) || math.IsInf(y, 0) {
		return nil
	}
	f := frameOf(p)
	header := measured(options.HeaderPx)
	footer := measured(options.FooterPx)
	asked := 0.25
	if options.Edge != nil {
		asked = *options.Edge
	}
	edge := 0.25
	if !math.IsNaN(asked) && !math.IsInf(asked, 0) && asked >= 0 && asked <= 0.5 {
		edge = asked
	}
	for _, card := range p.cards {
		r := rectIn(f, card)
		if x < r.X || x > r.X+r.W || y < r.Y || y > r.Y+r.H {
			continue
		}
		centre := &ZoneHit{ID: card.ID, Zone: "centre"}
		if options.CentreOnly != nil && card.ID == *options.CentreOnly {
			return centre
		}
		top := r.Y + header
		bottom := r.Y + r.H - footer
		if bottom <= top || y < top || y > bottom {
			return centre
		}
		if !(r.W > 0) {
			return centre
		}
		px := (x - r.X) / r.W
		py := (y - top) / (bottom - top)
		if px > edge && px < 1-edge && py > edge && py < 1-edge {
			return centre
		}
		nearest := math.Min(math.Min(px, 1-px), math.Min(py, 1-py))
		zone := "bottom"
		switch nearest {
		case px:
			zone = "left"
		case 1 - px:
			zone = "right"
		case py:
			zone = "top"
		}
		return &ZoneHit{ID: card.ID, Zone: zone}
	}
	return nil
}
