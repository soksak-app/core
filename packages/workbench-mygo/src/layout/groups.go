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
	"unicode/utf8"
)

// The tree of planes of a space (docs/spec/groups.md#model): the root plane, the child plane of each group card, the leader of each
// plane and the card numbers that the space issued. Each plane is one Grid, unchanged; the tree places the child plane of a group card
// in the body of that card and checks that no operation takes a group card below its smallest size (docs/spec/groups.md#minimum-size).

// RootPlane is the key of the root plane. Every other plane is keyed by the id of the group card that holds it.
const RootPlane = ""

// groupMark is the data of a group card in its plane while the tree holds it: the name, the leader and the child plane are members of
// the tree, and the stored form writes them into the data (Stored).
var groupMark = json.RawMessage(`{"group":{}}`)

// PlaneOptions are the sizes that the tree places planes with: the gap of every plane, the smallest edge of a content card, and the
// head height of a group card.
type PlaneOptions struct {
	Gap     float64
	MinSize float64
	Head    float64
}

// Planes is the tree of planes of one space.
type Planes struct {
	root    *Grid
	options PlaneOptions
	groups  map[string]*groupPlane
	// leaders holds the leader of each plane by its key; a root plane that holds only window sidebars has no entry.
	leaders map[string]string
	// last is the largest card number that the space issued (lastCard).
	last int
}

// groupPlane is the child plane of a group card: its name and its grid. The plane that holds the group card is found by a walk of the
// tree (docs/spec/groups.md#status-and-queries), so the tree states the containment of a card once.
type groupPlane struct {
	name string
	grid *Grid
}

// Group is the record of a group card: its name, the level of its child plane, the leader of its child plane and the cards of its
// child plane in reading order.
type Group struct {
	Name   string   `json:"name"`
	Level  int      `json:"level"`
	Leader string   `json:"leader"`
	Cards  []string `json:"cards"`
}

// PlaneCard is a card of the tree with the key of the plane that holds it.
type PlaneCard struct {
	Card
	Plane string
}

// NewPlanes makes the tree of a root grid that holds no group card, with the leader of the root plane and the largest issued card
// number.
func NewPlanes(root *Grid, options PlaneOptions, leader string, last int) *Planes {
	p := &Planes{root: root, options: options, groups: map[string]*groupPlane{}, leaders: map[string]string{}, last: last}
	if leader != "" {
		p.leaders[RootPlane] = leader
	}
	p.fit()
	return p
}

// Root is the grid of the root plane.
func (p *Planes) Root() *Grid { return p.root }

// Options are the sizes that the tree places its planes with.
func (p *Planes) Options() PlaneOptions { return p.options }

// SetOptions changes the gap and the head height of every plane. It changes no arrangement: each plane keeps its proportions (R5).
func (p *Planes) SetOptions(options PlaneOptions) {
	p.options = options
	p.root.SetGap(options.Gap)
	for _, group := range p.groups {
		group.grid.SetGap(options.Gap)
		group.grid.SetMinSize(options.MinSize)
	}
	p.fit()
}

// LastCard is the largest card number that the space issued.
func (p *Planes) LastCard() int { return p.last }

// Resize sets the size of the root plane and places every child plane in the body of its group card.
func (p *Planes) Resize(width, height float64) {
	p.root.Resize(width, height)
	p.fit()
}

// fit sizes the child plane of every group card to the body of the card, from the root plane inward.
func (p *Planes) fit() {
	for _, key := range p.planeKeys() {
		if key == RootPlane {
			continue
		}
		group := p.groups[key]
		rect, ok := p.grid(p.parentOf(key)).Rect(key)
		if !ok {
			continue
		}
		width, height := p.childSize(rect)
		group.grid.Resize(width, height)
	}
}

// childSize is the size of the child plane of a group card drawn at rect.
func (p *Planes) childSize(rect Rect) (float64, float64) {
	return math.Max(0, rect.W-p.options.Gap), math.Max(0, rect.H-p.options.Head-p.options.Gap)
}

// planeKeys lists the root plane and then each child plane after the plane that holds its group card, in workbench order.
func (p *Planes) planeKeys() []string {
	keys := []string{}
	var walk func(key string)
	walk = func(key string) {
		keys = append(keys, key)
		for _, card := range p.planeOrder(key) {
			if p.groups[card.ID] != nil {
				walk(card.ID)
			}
		}
	}
	walk(RootPlane)
	return keys
}

// grid is the grid of the plane key, or nil.
func (p *Planes) grid(key string) *Grid {
	if key == RootPlane {
		return p.root
	}
	if group := p.groups[key]; group != nil {
		return group.grid
	}
	return nil
}

// Plane is the grid of the plane key: RootPlane or the id of a group card.
func (p *Planes) Plane(key string) (*Grid, bool) {
	grid := p.grid(key)
	return grid, grid != nil
}

// planeOrder is the cards of the plane key in the order of workbench order: the root plane in the order of its cards, a child plane in
// reading order.
func (p *Planes) planeOrder(key string) []Card {
	grid := p.grid(key)
	if key == RootPlane {
		return grid.Cards()
	}
	return readingOrder(grid.Cards())
}

// readingOrder orders cards by their first row line and then by their first column line (docs/spec/groups.md#model).
func readingOrder(cards []Card) []Card {
	slices.SortStableFunc(cards, func(a, b Card) int {
		if a.R0 != b.R0 {
			return a.R0 - b.R0
		}
		return a.C0 - b.C0
	})
	return cards
}

// Cards is every card of the tree in workbench order: the cards of the root plane in their order, each group card followed by the cards
// of its child plane in reading order.
func (p *Planes) Cards() []PlaneCard {
	out := []PlaneCard{}
	var walk func(key string)
	walk = func(key string) {
		for _, card := range p.planeOrder(key) {
			out = append(out, PlaneCard{Card: card, Plane: key})
			if p.groups[card.ID] != nil {
				walk(card.ID)
			}
		}
	}
	walk(RootPlane)
	return out
}

// find walks the tree from the root plane to the card id and returns the group cards that it passed, from the outermost to the
// innermost, and false for no card of the tree.
func (p *Planes) find(id string) ([]string, bool) {
	var walk func(key string, path []string) ([]string, bool)
	walk = func(key string, path []string) ([]string, bool) {
		for _, card := range p.grid(key).list {
			if card.ID == id {
				return path, true
			}
		}
		for _, card := range p.grid(key).list {
			if p.groups[card.ID] != nil {
				if found, ok := walk(card.ID, append(slices.Clone(path), card.ID)); ok {
					return found, true
				}
			}
		}
		return nil, false
	}
	return walk(RootPlane, []string{})
}

// PlaneOf is the key of the plane that holds the card id, and false for no card of the tree.
func (p *Planes) PlaneOf(id string) (string, bool) {
	path, ok := p.find(id)
	if !ok {
		return "", false
	}
	if len(path) == 0 {
		return RootPlane, true
	}
	return path[len(path)-1], true
}

// parentOf is the key of the plane that holds the group card key.
func (p *Planes) parentOf(key string) string {
	// silent: a key of the tree names a group card, which a plane of the tree holds.
	parent, _ := p.PlaneOf(key)
	return parent
}

// Card is the card id of any plane.
func (p *Planes) Card(id string) (Card, bool) {
	key, ok := p.PlaneOf(id)
	if !ok {
		return Card{}, false
	}
	return p.grid(key).Card(id)
}

// IsGroup tells whether id is a group card.
func (p *Planes) IsGroup(id string) bool { return p.groups[id] != nil }

// Groups is the path of group cards that hold the card id, from the outermost to the innermost.
func (p *Planes) Groups(id string) []string {
	path, _ := p.find(id) // silent: a card that is not in the tree has no group card around it.
	return path
}

// Level is the level of the plane key: 0 for the root plane, and one more than the plane that holds its group card.
func (p *Planes) Level(key string) int {
	if key == RootPlane {
		return 0
	}
	return len(p.Groups(key)) + 1
}

// GroupName is the name of the group card id.
func (p *Planes) GroupName(id string) string {
	if group := p.groups[id]; group != nil {
		return group.name
	}
	return ""
}

// Group is the record of the group card id.
func (p *Planes) Group(id string) (Group, bool) {
	group := p.groups[id]
	if group == nil {
		return Group{}, false
	}
	cards := []string{}
	for _, card := range readingOrder(group.grid.Cards()) {
		cards = append(cards, card.ID)
	}
	return Group{Name: group.name, Level: p.Level(id), Leader: p.leaders[id], Cards: cards}, true
}

// Leader is the leader of the plane key, and false for a plane without a leader.
func (p *Planes) Leader(key string) (string, bool) {
	leader, ok := p.leaders[key]
	return leader, ok
}

// Rect is the rectangle of the card id of any plane in the coordinates of the root plane.
func (p *Planes) Rect(id string) (Rect, bool) {
	key, ok := p.PlaneOf(id)
	if !ok {
		return Rect{}, false
	}
	rect, ok := p.grid(key).Rect(id)
	if !ok {
		return Rect{}, false
	}
	origin := p.Origin(key)
	return Rect{X: rect.X + origin.X, Y: rect.Y + origin.Y, W: rect.W, H: rect.H}, true
}

// Origin is the position of the plane key in the coordinates of the root plane: the body of its group card inset by half the gap.
func (p *Planes) Origin(key string) Rect {
	if key == RootPlane {
		return Rect{}
	}
	// silent: a group card is a card of the plane that holds it.
	group, _ := p.Rect(key)
	grid := p.groups[key].grid
	return Rect{X: group.X + p.options.Gap/2, Y: group.Y + p.options.Head + p.options.Gap/2, W: grid.Width(), H: grid.Height()}
}

// Smallest is the smallest size of the card id: minSize on both axes for a content card, and for a group card the smallest extent of
// its child plane plus the gap, and plus the head height on y (docs/spec/groups.md#minimum-size).
func (p *Planes) Smallest(id string) (float64, float64) {
	group := p.groups[id]
	if group == nil {
		return p.options.MinSize, p.options.MinSize
	}
	return p.extent(id, "x") + p.options.Gap, p.extent(id, "y") + p.options.Gap + p.options.Head
}

// extent is the smallest extent of the plane key on axis, computed on its slicing tree.
func (p *Planes) extent(key string, axis Axis) float64 {
	grid := p.grid(key)
	tree := sliceTree(grid.list)
	if tree == nil {
		return 0
	}
	var of func(s *slice) float64
	of = func(s *slice) float64 {
		if s.card != nil {
			w, h := p.Smallest(s.card.ID)
			if axis == "x" {
				return w
			}
			return h
		}
		total := 0.0
		for i, side := range s.sides {
			v := of(side)
			if s.axis == axis {
				total += v
				if i > 0 {
					total += p.options.Gap
				}
			} else {
				total = math.Max(total, v)
			}
		}
		return total
	}
	return of(tree)
}

// groupSizes is the drawn size of every group card.
func (p *Planes) groupSizes() map[string]Rect {
	out := map[string]Rect{}
	for id := range p.groups {
		if rect, ok := p.Rect(id); ok {
			out[id] = rect
		}
	}
	return out
}

// belowSmallest is the first group card in workbench order whose drawn size differs from before and that is below its smallest size,
// or "".
func (p *Planes) belowSmallest(before map[string]Rect) string {
	for _, card := range p.Cards() {
		if p.groups[card.ID] == nil {
			continue
		}
		// silent: card is a card of the tree.
		rect, _ := p.Rect(card.ID)
		was, had := before[card.ID]
		if had && math.Abs(was.W-rect.W) < 1e-6 && math.Abs(was.H-rect.H) < 1e-6 {
			continue
		}
		w, h := p.Smallest(card.ID)
		if rect.W < w-1e-6 || rect.H < h-1e-6 {
			return card.ID
		}
	}
	return ""
}

// snapshot is the whole tree as it stands, which restore puts back.
type snapshot struct {
	states  map[string]State
	grids   map[string]*Grid
	groups  map[string]groupPlane
	leaders map[string]string
	last    int
}

func (p *Planes) snapshot() snapshot {
	s := snapshot{states: map[string]State{RootPlane: p.root.ToJSON()}, grids: map[string]*Grid{}, groups: map[string]groupPlane{},
		leaders: map[string]string{}, last: p.last}
	for key, group := range p.groups {
		s.states[key] = group.grid.ToJSON()
		s.grids[key] = group.grid
		s.groups[key] = *group
	}
	for key, leader := range p.leaders {
		s.leaders[key] = leader
	}
	return s
}

func (p *Planes) restore(s snapshot) {
	p.root.reload(s.states[RootPlane])
	p.groups = map[string]*groupPlane{}
	for key, group := range s.groups {
		kept := group
		kept.grid = s.grids[key]
		kept.grid.reload(s.states[key])
		p.groups[key] = &kept
	}
	p.leaders = s.leaders
	p.last = s.last
	p.fit()
}

// try runs change on the tree and keeps its result only when it succeeds and leaves no group card that it resized below its smallest
// size; otherwise the tree is put back and the refusal is returned.
func (p *Planes) try(change func() error, refusal func() error) error {
	before := p.groupSizes()
	kept := p.snapshot()
	if err := change(); err != nil {
		p.restore(kept)
		return err
	}
	p.fit()
	if p.belowSmallest(before) != "" {
		p.restore(kept)
		return refusal()
	}
	return nil
}

// issue returns the next card id of the space.
func (p *Planes) issue() string {
	p.last++
	return "card-" + strconv.Itoa(p.last)
}

// newGrid is an empty child plane with the options of the tree.
func (p *Planes) newGrid(state State) (*Grid, error) {
	gap, minimum := p.options.Gap, p.options.MinSize
	return New(&state, Options{Gap: &gap, MinSize: &minimum})
}

// leaderLeft keeps the leader rule of a card that left the plane key: the first remaining card in reading order that is not a window
// sidebar leads, or the plane has no leader.
func (p *Planes) leaderLeft(key, id string) {
	if p.leaders[key] != id {
		return
	}
	delete(p.leaders, key)
	for _, card := range readingOrder(p.grid(key).Cards()) {
		if !IsWindowSide(card.ID) {
			p.leaders[key] = card.ID
			return
		}
	}
}

// leaderEntered gives a plane without a leader the card that entered it.
func (p *Planes) leaderEntered(key, id string) {
	if _, ok := p.leaders[key]; !ok && !IsWindowSide(id) {
		p.leaders[key] = id
	}
}

// renameCard gives the card from of the plane key the id to, with its slot, its px sizes and the records of its payers.
func (p *Planes) renameCard(key, from, to string, data json.RawMessage) error {
	grid := p.grid(key)
	state := grid.ToJSON()
	for i := range state.Cards {
		if state.Cards[i].ID == from {
			state.Cards[i].ID = to
			state.Cards[i].Data = data
		}
	}
	paid := map[string]Paid{}
	for id, record := range state.PaidBy {
		if record.To == from {
			record.To = to
		}
		if id == from {
			id = to
		}
		paid[id] = record
	}
	state.PaidBy = paid
	return grid.Replace(state)
}

// sizeText is a drawn size in whole points.
func sizeText(w, h float64) string {
	return strconv.Itoa(int(math.Round(w))) + "x" + strconv.Itoa(int(math.Round(h)))
}

// CheckGroup is the refusal of a group of the card id and a new card toward side, or nil (docs/spec/groups.md#commands).
func (p *Planes) CheckGroup(id string, side Side) error {
	if IsWindowSide(id) {
		return fmt.Errorf("card %s is a window sidebar; a group holds content cards and group cards", id)
	}
	if !isSide(side) {
		return fmt.Errorf("unknown side %s; use left, right, top or bottom", side)
	}
	rect, ok := p.Rect(id)
	if !ok {
		return fmt.Errorf("no card %s", id)
	}
	mw, mh := p.groupNeeds(id, side)
	if rect.W < mw-1e-6 || rect.H < mh-1e-6 {
		return fmt.Errorf("card %s cannot hold a group toward %s: it is %s and the group needs %s", id, side, sizeText(rect.W, rect.H), sizeText(mw, mh))
	}
	return nil
}

// groupNeeds is the size that a group of the card id and a new content card toward side needs.
func (p *Planes) groupNeeds(id string, side Side) (float64, float64) {
	cw, ch := p.Smallest(id)
	gap, minimum, head := p.options.Gap, p.options.MinSize, p.options.Head
	if axisOf(side) == "x" {
		return cw + minimum + 2*gap, math.Max(ch, minimum) + head + gap
	}
	return math.Max(cw, minimum) + gap, ch + minimum + head + 2*gap
}

// GroupSide is the side of the group button of the card id: right when it is drawn wider than high, otherwise bottom.
func (p *Planes) GroupSide(id string) Side {
	if rect, ok := p.Rect(id); ok && rect.W > rect.H {
		return "right"
	}
	return "bottom"
}

// groupName is the name 그룹 <n> with the smallest positive n that no group of the space has.
func (p *Planes) groupName() string {
	taken := map[string]bool{}
	for _, group := range p.groups {
		taken[group.name] = true
	}
	for n := 1; ; n++ {
		name := "그룹 " + strconv.Itoa(n)
		if !taken[name] {
			return name
		}
	}
}

// CreateGroup turns the card id into a group card of itself and a new content card with data toward side, and returns the group card
// and the new card. even balances the child plane after its split (cardSplit even).
func (p *Planes) CreateGroup(id string, side Side, data json.RawMessage, even bool) (string, string, error) {
	if err := p.CheckGroup(id, side); err != nil {
		return "", "", err
	}
	group, born := "", ""
	err := p.try(func() error {
		key, _ := p.PlaneOf(id) // silent: CheckGroup found the card.
		card, _ := p.Card(id)   // silent: CheckGroup found the card.
		group = p.issue()
		born = p.issue()
		inner, err := p.newGrid(State{Xs: []float64{0, 1}, Ys: []float64{0, 1}, Cards: []Card{{ID: id, C0: 0, C1: 1, R0: 0, R1: 1, Data: card.Data}},
			PaidBy: map[string]Paid{}})
		if err != nil {
			return err
		}
		if err := p.renameCard(key, id, group, groupMark); err != nil {
			return err
		}
		p.groups[group] = &groupPlane{name: p.groupName(), grid: inner}
		if p.leaders[key] == id {
			p.leaders[key] = group
		}
		p.leaders[group] = id
		p.fit()
		if _, ok := inner.SplitToward(id, side, SplitInit{ID: &born, Data: data}); !ok {
			return p.groupRefusal(id, side)
		}
		if even {
			return p.balanceEven(group, id, side)
		}
		return nil
	}, func() error { return p.groupRefusal(id, side) })
	if err != nil {
		return "", "", err
	}
	return group, born, nil
}

// groupRefusal is the refusal of a group of the card id toward side, with its size and the size that the group needs.
func (p *Planes) groupRefusal(id string, side Side) error {
	rect, _ := p.Rect(id) // silent: the refusal names a card of the tree.
	mw, mh := p.groupNeeds(id, side)
	return fmt.Errorf("card %s cannot hold a group toward %s: it is %s and the group needs %s", id, side, sizeText(rect.W, rect.H), sizeText(mw, mh))
}

// planeName is the plane key as a refusal names it: root or group <id>.
func planeName(key string) string {
	if key == RootPlane {
		return "root"
	}
	return "group " + key
}

// balanceEven balances the plane key after the split of the card id toward side (cardSplit even) and refuses the split when the
// balance fails or leaves a card of that plane or of a plane inside it below its smallest size (docs/spec/groups.md#minimum-size).
func (p *Planes) balanceEven(key, id string, side Side) error {
	ok, err := p.grid(key).Balance()
	if err == nil && !ok {
		err = fmt.Errorf("the plane is not a slicing plane")
	}
	if err != nil {
		return fmt.Errorf("card %s cannot split toward %s: cardSplit even cannot balance plane %s: %w", id, side, planeName(key), err)
	}
	p.fit()
	for _, card := range p.Cards() {
		// The cards of the plane key and of the planes inside it: every card for the root plane, else the cards whose group path holds key.
		if key != RootPlane && card.Plane != key && !slices.Contains(p.Groups(card.ID), key) {
			continue
		}
		rect, _ := p.Rect(card.ID) // silent: card is a card of the tree.
		w, h := p.Smallest(card.ID)
		if rect.W < w-1e-6 || rect.H < h-1e-6 {
			return fmt.Errorf("card %s cannot split toward %s: cardSplit even would draw card %s of plane %s at %s, below its minimum %s",
				id, side, card.ID, planeName(card.Plane), sizeText(rect.W, rect.H), sizeText(w, h))
		}
	}
	return nil
}

// requireGroup refuses an id that is no group card.
func (p *Planes) requireGroup(id string) (*groupPlane, error) {
	group := p.groups[id]
	if group == nil {
		return nil, fmt.Errorf("card %s is not a group", id)
	}
	return group, nil
}

// Dissolve replaces the group card id with the cards of its child plane inside its span (docs/spec/groups.md#commands).
func (p *Planes) Dissolve(id string) error {
	group, err := p.requireGroup(id)
	if err != nil {
		return err
	}
	inner := readingOrder(group.grid.Cards())
	return p.try(func() error {
		if err := p.dissolve(id); err != nil {
			return err
		}
		p.fit()
		for _, card := range inner {
			rect, _ := p.Rect(card.ID) // silent: the dissolve kept every card of the child plane.
			w, h := p.Smallest(card.ID)
			if rect.W < w-1e-6 || rect.H < h-1e-6 {
				return fmt.Errorf("group %s cannot be dissolved: card %s would be %s, below its minimum %s", id, card.ID, sizeText(rect.W, rect.H), sizeText(w, h))
			}
		}
		return nil
	}, func() error { return fmt.Errorf("group %s cannot be dissolved", id) })
}

// dissolve maps the lines of the child plane of the group card id into its span in the parent plane, as numbers and without a
// tolerance (R1), and puts the cards of the child plane there with their data and px sizes.
func (p *Planes) dissolve(id string) error {
	group := p.groups[id]
	parentKey := p.parentOf(id)
	parent := p.grid(parentKey)
	state := parent.ToJSON()
	inner := group.grid.ToJSON()
	at := slices.IndexFunc(state.Cards, func(card Card) bool { return card.ID == id })
	span := state.Cards[at]
	mapped := map[Axis][]int{}
	for _, axis := range axes {
		lines, lo, hi := &state.Xs, span.C0, span.C1
		innerLines := inner.Xs
		if axis == "y" {
			lines, lo, hi = &state.Ys, span.R0, span.R1
			innerLines = inner.Ys
		}
		a, b := (*lines)[lo], (*lines)[hi]
		indices := make([]int, len(innerLines))
		for j, t := range innerLines {
			switch {
			case j == 0:
				indices[j] = lo
				continue
			case j == len(innerLines)-1:
				indices[j] = hi
				continue
			}
			v := a + (b-a)*t
			found := -1
			for k := lo; k <= hi; k++ {
				if (*lines)[k] == v {
					found = k
					break
				}
			}
			if found < 0 {
				found = hi
				for k := lo + 1; k <= hi; k++ {
					if (*lines)[k] > v {
						found = k
						break
					}
				}
				*lines = slices.Insert(*lines, found, v)
				hi++
				for c := range state.Cards {
					card := &state.Cards[c]
					if axis == "x" {
						card.C0, card.C1 = shifted(card.C0, found), shifted(card.C1, found)
					} else {
						card.R0, card.R1 = shifted(card.R0, found), shifted(card.R1, found)
					}
				}
				for k := range indices[:j] {
					indices[k] = shifted(indices[k], found)
				}
			}
			indices[j] = found
		}
		mapped[axis] = indices
		if axis == "x" {
			span.C0, span.C1 = state.Cards[at].C0, state.Cards[at].C1
		}
	}
	state.Cards = slices.Delete(state.Cards, at, at+1)
	for _, card := range inner.Cards {
		card.C0, card.C1 = mapped["x"][card.C0], mapped["x"][card.C1]
		card.R0, card.R1 = mapped["y"][card.R0], mapped["y"][card.R1]
		state.Cards = append(state.Cards, card)
	}
	paid := map[string]Paid{}
	for card, record := range state.PaidBy {
		if card != id && record.To != id {
			paid[card] = record
		}
	}
	for card, record := range inner.PaidBy {
		paid[card] = record
	}
	state.PaidBy = paid
	if err := parent.Replace(state); err != nil {
		return err
	}
	if p.leaders[parentKey] == id {
		p.leaders[parentKey] = p.leaders[id]
	}
	delete(p.leaders, id)
	delete(p.groups, id)
	return nil
}

// shifted is the index of a line after a line was inserted at the index at.
func shifted(index, at int) int {
	if index >= at {
		return index + 1
	}
	return index
}

// Rename sets the name of the group card id to name with the white space at both ends removed, and returns the name.
func (p *Planes) Rename(id, name string) (string, error) {
	group, err := p.requireGroup(id)
	if err != nil {
		return "", err
	}
	trimmed := strings.TrimSpace(name)
	if count := utf8.RuneCountInString(trimmed); count < 1 || count > 40 {
		return "", fmt.Errorf("group name must be 1 to 40 characters: %s", name)
	}
	group.name = trimmed
	return trimmed, nil
}

// SetLeader makes the card id the leader of its plane and returns the key of that plane.
func (p *Planes) SetLeader(id string) (string, error) {
	if IsWindowSide(id) {
		return "", fmt.Errorf("card %s is a window sidebar and cannot lead a plane", id)
	}
	key, ok := p.PlaneOf(id)
	if !ok {
		return "", fmt.Errorf("no card %s", id)
	}
	p.leaders[key] = id
	return key, nil
}

// Split puts a new content card with data beside the card id toward side in the plane of the card and returns its id. even balances
// that plane after the split (cardSplit even).
func (p *Planes) Split(id string, side Side, data json.RawMessage, even bool) (string, error) {
	refusal := func() error { return fmt.Errorf("card %s cannot split toward %s", id, side) }
	key, ok := p.PlaneOf(id)
	if !ok || !isSide(side) {
		return "", refusal()
	}
	born := ""
	err := p.try(func() error {
		born = p.issue()
		if _, ok := p.grid(key).SplitToward(id, side, SplitInit{ID: &born, Data: data}); !ok {
			return refusal()
		}
		p.leaderEntered(key, born)
		if even {
			return p.balanceEven(key, id, side)
		}
		return nil
	}, refusal)
	return born, err
}

// CanSplit tells whether Split of the card id toward side would succeed.
func (p *Planes) CanSplit(id string, side Side) bool {
	kept := p.snapshot()
	_, err := p.Split(id, side, json.RawMessage(`{}`), false)
	p.restore(kept)
	return err == nil
}

// AddCard inserts a new content card with data at the right edge of the child plane of the group card id, reaching from its top to its
// bottom, and returns its id.
func (p *Planes) AddCard(id string, data json.RawMessage) (string, error) {
	group, err := p.requireGroup(id)
	if err != nil {
		return "", err
	}
	refusal := func() error { return fmt.Errorf("group %s has no room for a card at its right edge", id) }
	born := ""
	err = p.try(func() error {
		born = p.issue()
		if _, ok := p.insertRight(group.grid, born, data); !ok {
			return refusal()
		}
		p.leaderEntered(id, born)
		return nil
	}, refusal)
	return born, err
}

// insertRight inserts the card id with data at the last line on x of grid, as wide as a new card of the plane takes.
func (p *Planes) insertRight(grid *Grid, id string, data json.RawMessage) (string, bool) {
	columns := 0
	for _, card := range grid.Cards() {
		columns = max(columns, card.C1)
	}
	size := grid.Width() / float64(columns+1)
	return grid.InsertAt("x", len(grid.Lines("x"))-1, InsertInit{ID: &id, Data: data, Size: &size})
}

// Close closes the card id with everything that it holds. A child plane left with one card is replaced by that card
// (docs/spec/groups.md#closing). It returns the content cards that ended.
func (p *Planes) Close(id string) ([]string, error) {
	refusal := func() error { return fmt.Errorf("card %s cannot close", id) }
	key, ok := p.PlaneOf(id)
	if !ok {
		return nil, refusal()
	}
	ended := p.ContentInside(id)
	err := p.try(func() error {
		if !p.grid(key).Close(id) {
			return refusal()
		}
		p.forget(id)
		p.leaderLeft(key, id)
		return p.collapse(key)
	}, refusal)
	if err != nil {
		return nil, err
	}
	return ended, nil
}

// CanClose tells whether Close of the card id would succeed.
func (p *Planes) CanClose(id string) bool {
	kept := p.snapshot()
	_, err := p.Close(id)
	p.restore(kept)
	return err == nil
}

// ContentInside is the content cards that the card id is or holds, in workbench order.
func (p *Planes) ContentInside(id string) []string {
	if p.groups[id] == nil {
		return []string{id}
	}
	out := []string{}
	for _, card := range p.planeOrder(id) {
		out = append(out, p.ContentInside(card.ID)...)
	}
	return out
}

// forget removes the child planes that the closed card id held.
func (p *Planes) forget(id string) {
	group := p.groups[id]
	if group == nil {
		return
	}
	for _, card := range group.grid.Cards() {
		p.forget(card.ID)
	}
	delete(p.groups, id)
	delete(p.leaders, id)
}

// collapse replaces the group card of the child plane key with its one card when the plane holds one card: the card takes the slot,
// the px sizes and the leader mark of the group card and keeps its id.
func (p *Planes) collapse(key string) error {
	group := p.groups[key]
	if group == nil {
		return nil
	}
	cards := group.grid.Cards()
	if len(cards) != 1 {
		return nil
	}
	only := cards[0]
	parent := p.parentOf(key)
	if err := p.renameCard(parent, key, only.ID, only.Data); err != nil {
		return err
	}
	if p.leaders[parent] == key {
		p.leaders[parent] = only.ID
	}
	delete(p.leaders, key)
	delete(p.groups, key)
	return nil
}

// CheckMove is the refusal of a move of the card id to side of target, or nil (docs/spec/groups.md#commands).
func (p *Planes) CheckMove(id, target string, side string) error {
	switch {
	case IsWindowSide(id):
		return fmt.Errorf("card %s is a window sidebar and does not move", id)
	case IsWindowSide(target):
		return fmt.Errorf("card %s is a window sidebar; a card does not move beside it", target)
	case target == id || slices.Contains(p.Groups(target), id):
		return fmt.Errorf("card %s cannot move into itself", id)
	case side == "centre" && !p.IsGroup(target):
		return fmt.Errorf("card %s is not a group; a card moves beside it", target)
	}
	return nil
}

// Moved tells whether the card id already stands where a move to side of target puts it.
func (p *Planes) Moved(id, target, side string) bool {
	if side == "centre" {
		key, ok := p.PlaneOf(id)
		if !ok || key != target {
			return false
		}
		grid := p.grid(key)
		card, _ := grid.Card(id) // silent: PlaneOf found the card.
		return card.C1 == len(grid.Lines("x"))-1 && card.R0 == 0 && card.R1 == len(grid.Lines("y"))-1
	}
	return p.Neighbour(target, side) == id
}

// Neighbour is the card of the plane of card whose edge lies on the line of the edge of card toward side and which spans the same two
// lines across that side, or "".
func (p *Planes) Neighbour(card, side string) string {
	key, ok := p.PlaneOf(card)
	if !ok {
		return ""
	}
	grid := p.grid(key)
	from, _ := grid.Card(card) // silent: PlaneOf found the card.
	for _, other := range grid.Cards() {
		if other.ID == card || IsWindowSide(other.ID) {
			continue
		}
		rows := other.R0 == from.R0 && other.R1 == from.R1
		columns := other.C0 == from.C0 && other.C1 == from.C1
		if side == "right" && rows && other.C0 == from.C1 || side == "left" && rows && other.C1 == from.C0 ||
			side == "bottom" && columns && other.R0 == from.R1 || side == "top" && columns && other.R1 == from.R0 {
			return other.ID
		}
	}
	return ""
}

// Move moves the card id with its data or its child plane beside target on side, or with side centre into the right edge of the child
// plane of the group card target (docs/spec/groups.md#commands). The card keeps its id.
func (p *Planes) Move(id, target, side string) error {
	if err := p.CheckMove(id, target, side); err != nil {
		return err
	}
	refusal := func() error { return fmt.Errorf("card %s cannot move to %s of %s", id, side, target) }
	if side != "centre" && !isSide(side) {
		return refusal()
	}
	from, ok := p.PlaneOf(id)
	to, found := p.PlaneOf(target)
	if !ok || !found {
		return refusal()
	}
	if p.Moved(id, target, side) {
		return nil
	}
	if side != "centre" && from == to {
		return p.try(func() error {
			if !p.grid(from).Move(id, target, side) {
				return refusal()
			}
			return nil
		}, refusal)
	}
	return p.try(func() error {
		card, _ := p.Card(id) // silent: PlaneOf found the card.
		if side == "centre" {
			// The card enters the child plane first, so a group that the card leaves keeps two cards.
			if _, ok := p.insertRight(p.groups[target].grid, movingID, card.Data); !ok {
				return refusal()
			}
			if !p.grid(from).Close(id) {
				return refusal()
			}
			if err := p.renameCard(target, movingID, id, card.Data); err != nil {
				return err
			}
			p.leaderLeft(from, id)
			p.leaderEntered(target, id)
			return p.collapse(from)
		}
		if !p.grid(from).Close(id) {
			return refusal()
		}
		p.leaderLeft(from, id)
		// The target is resolved before the replacement, so a target group that the replacement ends is the card that replaces it.
		if group := p.groups[from]; group != nil && from == target && len(group.grid.Cards()) == 1 {
			target = group.grid.Cards()[0].ID
		}
		if err := p.collapse(from); err != nil {
			return err
		}
		into, ok := p.PlaneOf(target)
		if !ok {
			return refusal()
		}
		width, height := card.Width, card.Height
		landed, ok := p.grid(into).SplitToward(target, side, SplitInit{ID: &id, Data: card.Data})
		if !ok {
			return refusal()
		}
		grid := p.grid(into)
		if axisOf(side) == "x" && width != nil {
			grid.SetSize(landed, "x", width)
		}
		if axisOf(side) == "y" && height != nil {
			grid.SetSize(landed, "y", height)
		}
		p.leaderEntered(into, id)
		return nil
	}, refusal)
}

// movingID is the id that a card takes while it stands in two planes during a move into a child plane.
const movingID = "card-moving"

// Balance balances each plane on its own from the root plane inward; when one plane refuses, nothing changes.
func (p *Planes) Balance() error {
	refusal := errors.New("the layout cannot be balanced")
	return p.try(func() error {
		for _, key := range p.planeKeys() {
			if _, err := p.grid(key).Balance(); err != nil {
				return err
			}
			p.fit()
		}
		return nil
	}, func() error { return refusal })
}

// Focusable is the content card that a focus of the card id gives: the card itself, or for a group card the first content card in
// reading order of its child plane, descending into the first group card.
func (p *Planes) Focusable(id string) string {
	for p.groups[id] != nil {
		id = p.planeOrder(id)[0].ID
	}
	return id
}

// SetData sets the data of the content card id of any plane.
func (p *Planes) SetData(id string, data json.RawMessage) bool {
	key, ok := p.PlaneOf(id)
	if !ok || p.groups[id] != nil {
		return false
	}
	return p.grid(key).SetData(id, data)
}

// Probe runs change on the tree and puts the tree back, and returns what change returned: the drop preview asks what a drop would
// make without making it.
func (p *Planes) Probe(change func() error) error {
	kept := p.snapshot()
	defer p.restore(kept)
	return change()
}

// DropAt resolves a drop at x, y in the coordinates of the root plane from the root plane inward (docs/spec/groups.md#moving-and-dropping):
// the centre of a group card goes on in its child plane at the same point, and a point on its header or one that its child plane
// resolves to no card is the centre of the group card. A hit on the card without is no zone, so a dragged group card does not drop
// on itself or into its child plane.
func (p *Planes) DropAt(x, y float64, options ZoneOptions, without string) *ZoneHit {
	key := RootPlane
	for {
		origin := p.Origin(key)
		hit := p.grid(key).ZoneAt(x-origin.X, y-origin.Y, options)
		if hit == nil {
			if key == RootPlane {
				return nil
			}
			return &ZoneHit{ID: key, Zone: "centre"}
		}
		if hit.ID == without && without != "" {
			return nil
		}
		if p.groups[hit.ID] == nil || hit.Zone != "centre" {
			return hit
		}
		// silent: hit names a card of the tree.
		rect, _ := p.Rect(hit.ID)
		if y < rect.Y+p.options.Head {
			return hit
		}
		key = hit.ID
	}
}

// groupRecord is the stored record of a group card: {group: {name, leader, plane}}.
type groupRecord struct {
	Group struct {
		Name   string `json:"name"`
		Leader string `json:"leader"`
		Plane  State  `json:"plane"`
	} `json:"group"`
}

// Stored is the stored form of the tree (docs/spec/groups.md#storage): the root plane with the record of each group card in its data,
// the leader of the root plane, null without one, and lastCard.
func (p *Planes) Stored() (State, *string, int, error) {
	state, err := p.storedPlane(RootPlane, false)
	return state, p.leaderOf(RootPlane), p.last, err
}

// leaderOf is the leader of the plane key, or nil.
func (p *Planes) leaderOf(key string) *string {
	if leader, ok := p.leaders[key]; ok {
		return &leader
	}
	return nil
}

// storedPlane is the state of the plane key with the record of each group card in its data; level adds the level of each child plane
// for the tree that core.layout reports.
func (p *Planes) storedPlane(key string, level bool) (State, error) {
	state := p.grid(key).ToJSON()
	for i, card := range state.Cards {
		group := p.groups[card.ID]
		if group == nil {
			continue
		}
		plane, err := p.storedPlane(card.ID, level)
		if err != nil {
			return State{}, err
		}
		record := map[string]any{"name": group.name, "leader": p.leaders[card.ID], "plane": plane}
		if level {
			record["level"] = p.Level(card.ID)
		}
		if state.Cards[i].Data, err = json.Marshal(map[string]any{"group": record}); err != nil {
			return State{}, fmt.Errorf("group %s: %w", card.ID, err)
		}
	}
	return state, nil
}

// Tree is the tree that core.layout reports: the root plane with the record {name, level, leader, plane} of each group card in its
// data, nested to the innermost plane.
func (p *Planes) Tree() (State, error) { return p.storedPlane(RootPlane, true) }

// GroupTree is the child plane of the group card id in the form of Tree.
func (p *Planes) GroupTree(id string) (State, error) { return p.storedPlane(id, true) }

// MaxCardNumber is the largest number n of a card id card-<n> of state and of the planes in its group records.
func MaxCardNumber(state State) int {
	most := 0
	for _, card := range state.Cards {
		if n, ok := CardNumber(card.ID); ok {
			most = max(most, n)
		}
		var record groupRecord
		if fields, _, ok := object(card.Data); ok {
			if _, has := fields["group"]; has && json.Unmarshal(card.Data, &record) == nil {
				most = max(most, MaxCardNumber(record.Group.Plane))
			}
		}
	}
	return most
}

// CardNumber is n of a card id card-<n>.
func CardNumber(id string) (int, bool) {
	text, ok := strings.CutPrefix(id, "card-")
	if !ok {
		return 0, false
	}
	n, err := strconv.Atoi(text)
	return n, err == nil && n > 0 && strconv.Itoa(n) == text
}

// ReadPlanes reads the stored tree of a space: the root plane state, its leader and lastCard as stored, each refused with the text of
// docs/spec/groups.md#storage. A member that is absent is nil.
func ReadPlanes(state State, leader, lastCard json.RawMessage, options PlaneOptions, root *Grid) (*Planes, error) {
	p := &Planes{root: root, options: options, groups: map[string]*groupPlane{}, leaders: map[string]string{}}
	seen := map[string]bool{}
	cards := []Card{}
	for _, card := range state.Cards {
		// Two root cards of one id are refused by the check of the root plane, with the text of the layout library.
		seen[card.ID] = true
	}
	for _, card := range state.Cards {
		kept, err := p.readCard(card, seen)
		if err != nil {
			return nil, err
		}
		cards = append(cards, kept)
	}
	if err := p.readLeader(RootPlane, "root", cards, leader); err != nil {
		return nil, err
	}
	state.Cards = cards
	if err := root.Replace(state); err != nil {
		return nil, err
	}
	if err := p.readLast(lastCard, seen); err != nil {
		return nil, err
	}
	p.fit()
	return p, nil
}

// readCard reads one stored card: a group card takes its child plane into the tree and keeps groupMark as its data.
func (p *Planes) readCard(card Card, seen map[string]bool) (Card, error) {
	fields, keys, ok := object(card.Data)
	if !ok {
		return card, nil
	}
	if _, has := fields["group"]; !has {
		return card, nil
	}
	refused := fmt.Errorf("card %s stores the group %s, which is not {name, leader, plane}", card.ID, compact(card.Data))
	if len(keys) != 1 {
		return card, refused
	}
	record, recordKeys, ok := object(fields["group"])
	if !ok || len(recordKeys) != 3 {
		return card, refused
	}
	for _, key := range []string{"name", "leader", "plane"} {
		if _, has := record[key]; !has {
			return card, refused
		}
	}
	var name string
	if json.Unmarshal(record["name"], &name) != nil || jsonKind(record["name"]) != '"' || utf8.RuneCountInString(name) < 1 ||
		utf8.RuneCountInString(name) > 40 || strings.TrimSpace(name) != name {
		return card, fmt.Errorf("group %s stores the name %s, which is not 1 to 40 characters", card.ID, compact(record["name"]))
	}
	var plane State
	if err := json.Unmarshal(record["plane"], &plane); err != nil {
		return card, refused
	}
	if err := CheckState(plane); err != nil {
		return card, fmt.Errorf("group %s: %w", card.ID, err)
	}
	if len(plane.Cards) < 2 {
		return card, fmt.Errorf("group %s holds fewer than two cards", card.ID)
	}
	inner := []Card{}
	for _, child := range plane.Cards {
		if IsWindowSide(child.ID) {
			return card, fmt.Errorf("group %s holds the window sidebar %s", card.ID, child.ID)
		}
		if seen[child.ID] {
			return card, fmt.Errorf("card %s is stored twice", child.ID)
		}
		seen[child.ID] = true
		kept, err := p.readCard(child, seen)
		if err != nil {
			return card, err
		}
		inner = append(inner, kept)
	}
	if err := p.readLeader(card.ID, "group "+card.ID, inner, record["leader"]); err != nil {
		return card, err
	}
	plane.Cards = inner
	grid, err := p.newGrid(plane)
	if err != nil {
		return card, fmt.Errorf("group %s: %w", card.ID, err)
	}
	p.groups[card.ID] = &groupPlane{name: name, grid: grid}
	card.Data = groupMark
	return card, nil
}

// readLeader reads the stored leader of the plane key, named label in a refusal, among its cards.
func (p *Planes) readLeader(key, label string, cards []Card, raw json.RawMessage) error {
	lead := false
	for _, card := range cards {
		lead = lead || !IsWindowSide(card.ID)
	}
	if raw == nil || jsonKind(raw) == 'n' {
		if lead || raw == nil {
			return fmt.Errorf("plane %s has no leader", label)
		}
		return nil
	}
	var leader string
	if jsonKind(raw) != '"' || json.Unmarshal(raw, &leader) != nil ||
		!slices.ContainsFunc(cards, func(card Card) bool { return card.ID == leader }) {
		return fmt.Errorf("plane %s names the leader %s, which is not a card of that plane", label, strings.Trim(compact(raw), `"`))
	}
	if IsWindowSide(leader) {
		return fmt.Errorf("plane %s names the window sidebar %s as its leader", label, leader)
	}
	p.leaders[key] = leader
	return nil
}

// readLast reads lastCard: a positive integer at least the number of every card id of the tree.
func (p *Planes) readLast(raw json.RawMessage, seen map[string]bool) error {
	refused := fmt.Errorf("layout stores lastCard %s, which is not the largest issued card number", compact(raw))
	if raw == nil {
		return fmt.Errorf("layout stores lastCard undefined, which is not the largest issued card number")
	}
	var last float64
	if jsonKind(raw) != '0' || json.Unmarshal(raw, &last) != nil || last < 1 || last != math.Trunc(last) || last > math.MaxInt32 {
		return refused
	}
	for id := range seen {
		if n, ok := CardNumber(id); ok && n > int(last) {
			return refused
		}
	}
	p.last = int(last)
	return nil
}

// compact is the text of a JSON value without white space.
func compact(raw json.RawMessage) string {
	var out bytes.Buffer
	if json.Compact(&out, raw) != nil {
		return string(raw)
	}
	return out.String()
}

// PlaneCards is the cards of the plane key in reading order.
func (p *Planes) PlaneCards(key string) []string {
	out := []string{}
	if grid := p.grid(key); grid != nil {
		for _, card := range readingOrder(grid.Cards()) {
			out = append(out, card.ID)
		}
	}
	return out
}
