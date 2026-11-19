package layout

import (
	"bytes"
	"encoding/json"
	"fmt"
	"maps"
	"math"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// The groups of a space (docs/spec/groups.md#model): one grid, unchanged, and the tree of group cards stored beside it. Each group card
// covers one rectangle of the grid, the cells of the content cards inside it; the tree checks after each operation that every group
// card still covers one rectangle and that no content card it changed is drawn below minSize (docs/spec/groups.md#minimum-size).

// GroupOptions are the sizes that the tree draws with: the head height of a group card.
type GroupOptions struct {
	Head float64
}

// GroupTree is the grid of one space with its group tree.
type GroupTree struct {
	grid  *Grid
	head  float64
	roots []*node
	// leader is the leader of the root level, or "" while the root level holds only window sidebars.
	leader string
	// last is the largest card number that the space issued (lastCard).
	last int
}

// node is a member of a level: a group card with its name, its leader and its members, or a content card, which has no members.
type node struct {
	card    string
	group   bool
	name    string
	leader  string
	members []*node
}

// Group is the record of a group card: its name, its level, the leader of its members and its members in reading order.
type Group struct {
	Name    string   `json:"name"`
	Level   int      `json:"level"`
	Leader  string   `json:"leader"`
	Members []string `json:"members"`
}

// NewGroupTree makes the tree of a grid that holds no group card, with the leader of the root level and the largest issued card number.
func NewGroupTree(grid *Grid, options GroupOptions, leader string, last int) *GroupTree {
	return &GroupTree{grid: grid, head: options.Head, leader: leader, last: last}
}

// Grid is the grid of the space.
func (t *GroupTree) Grid() *Grid { return t.grid }

// Head is the head height of a group card.
func (t *GroupTree) Head() float64 { return t.head }

// SetHead changes the head height of a group card. It changes no arrangement.
func (t *GroupTree) SetHead(head float64) { t.head = head }

// LastCard is the largest card number that the space issued.
func (t *GroupTree) LastCard() int { return t.last }

// find walks the tree from the root level (docs/spec/groups.md#status-and-queries) and returns the group cards that hold id, outermost
// first, and the node of id. A content card of the grid that the walk does not meet is a member of the root level with a nil node.
func (t *GroupTree) find(id string) ([]*node, *node, bool) {
	var walk func(level []*node, path []*node) ([]*node, *node)
	walk = func(level []*node, path []*node) ([]*node, *node) {
		for _, n := range level {
			if n.card == id {
				return path, n
			}
			if n.group {
				if found, at := walk(n.members, append(slices.Clone(path), n)); at != nil {
					return found, at
				}
			}
		}
		return nil, nil
	}
	if path, n := walk(t.roots, nil); n != nil {
		return path, n, true
	}
	_, ok := t.grid.Card(id)
	return nil, nil, ok
}

// groupNode is the node of the group card id, or nil.
func (t *GroupTree) groupNode(id string) *node {
	_, n, _ := t.find(id) // silent: an id that is no card has no node.
	if n == nil || !n.group {
		return nil
	}
	return n
}

// IsGroup tells whether id is a group card.
func (t *GroupTree) IsGroup(id string) bool { return t.groupNode(id) != nil }

// Groups is the path of group cards that hold the card id, from the outermost to the innermost.
func (t *GroupTree) Groups(id string) []string {
	path, _, _ := t.find(id) // silent: an id that is no card has no path.
	out := []string{}
	for _, n := range path {
		out = append(out, n.card)
	}
	return out
}

// Parent is the group card that holds the card id, or "" for a member of the root level.
func (t *GroupTree) Parent(id string) string {
	path := t.Groups(id)
	if len(path) == 0 {
		return ""
	}
	return path[len(path)-1]
}

// Level is the level of the card id: 0 for a member of the root level.
func (t *GroupTree) Level(id string) int { return len(t.Groups(id)) }

// GroupName is the name of the group card id.
func (t *GroupTree) GroupName(id string) string {
	if n := t.groupNode(id); n != nil {
		return n.name
	}
	return ""
}

// Group is the record of the group card id.
func (t *GroupTree) Group(id string) (Group, bool) {
	n := t.groupNode(id)
	if n == nil {
		return Group{}, false
	}
	return Group{Name: n.name, Level: t.Level(id) + 1, Leader: n.leader, Members: t.Members(id)}, true
}

// level is the members of the level key: "" for the root level, whose members are its group cards and the cards of the grid that no
// group card holds, or the id of a group card.
func (t *GroupTree) level(key string) []*node {
	if key != "" {
		if n := t.groupNode(key); n != nil {
			return n.members
		}
		return nil
	}
	held := map[string]bool{}
	for _, n := range t.roots {
		for _, id := range t.inside(n) {
			held[id] = true
		}
	}
	out := slices.Clone(t.roots)
	for _, card := range t.grid.Cards() {
		if !held[card.ID] {
			out = append(out, &node{card: card.ID})
		}
	}
	return out
}

// Members is the members of the level key in reading order.
func (t *GroupTree) Members(key string) []string {
	out := []string{}
	for _, n := range t.ordered(t.level(key)) {
		out = append(out, n.card)
	}
	return out
}

// Leader is the leader of the level key, and false for a level without a leader.
func (t *GroupTree) Leader(key string) (string, bool) {
	if key == "" {
		return t.leader, t.leader != ""
	}
	if n := t.groupNode(key); n != nil {
		return n.leader, true
	}
	return "", false
}

// setLeader sets the leader of the level key.
func (t *GroupTree) setLeader(key, id string) {
	if key == "" {
		t.leader = id
	} else if n := t.groupNode(key); n != nil {
		n.leader = id
	}
}

// LeadCount is the number of members of the level key that can lead it: its members that are not window sidebars. A level of two or
// more shows the leader button in each of their headers.
func (t *GroupTree) LeadCount(key string) int {
	count := 0
	for _, n := range t.level(key) {
		if !IsWindowSide(n.card) {
			count++
		}
	}
	return count
}

// inside is the content cards that the node is or holds.
func (t *GroupTree) inside(n *node) []string {
	if !n.group {
		return []string{n.card}
	}
	out := []string{}
	for _, m := range n.members {
		out = append(out, t.inside(m)...)
	}
	return out
}

// ContentInside is the content cards that the card id is or holds, in workbench order.
func (t *GroupTree) ContentInside(id string) []string {
	_, n, ok := t.find(id)
	if !ok {
		return nil
	}
	if n == nil {
		return []string{id}
	}
	held := map[string]bool{}
	for _, card := range t.inside(n) {
		held[card] = true
	}
	out := []string{}
	for _, card := range t.Cards() {
		if held[card] && !t.IsGroup(card) {
			out = append(out, card)
		}
	}
	return out
}

// span is the line index span of the node: the span of a content card, or the smallest first and largest last lines of the content
// cards inside a group card.
func (t *GroupTree) span(n *node) (c0, c1, r0, r1 int) {
	c0, r0 = math.MaxInt, math.MaxInt
	for _, id := range t.inside(n) {
		// A card that an operation in progress took out of the grid takes no part in the span.
		if card, ok := t.grid.Card(id); ok {
			c0, c1, r0, r1 = min(c0, card.C0), max(c1, card.C1), min(r0, card.R0), max(r1, card.R1)
		}
	}
	return c0, c1, r0, r1
}

// ordered is the nodes in reading order: by the first row line, then by the first column line.
func (t *GroupTree) ordered(nodes []*node) []*node {
	out := slices.Clone(nodes)
	sort.SliceStable(out, func(i, j int) bool {
		ac0, _, ar0, _ := t.span(out[i])
		bc0, _, br0, _ := t.span(out[j])
		if ar0 != br0 {
			return ar0 < br0
		}
		return ac0 < bc0
	})
	return out
}

// Cards is every card of the space in workbench order: the members of the root level in reading order, each group card followed by
// its members in reading order.
func (t *GroupTree) Cards() []string {
	out := []string{}
	var walk func(level []*node)
	walk = func(level []*node) {
		for _, n := range t.ordered(level) {
			out = append(out, n.card)
			if n.group {
				walk(n.members)
			}
		}
	}
	walk(t.level(""))
	return out
}

// Card is the card id of the grid, or for a group card a card with its id and its span.
func (t *GroupTree) Card(id string) (Card, bool) {
	if card, ok := t.grid.Card(id); ok {
		return card, true
	}
	n := t.groupNode(id)
	if n == nil {
		return Card{}, false
	}
	c0, c1, r0, r1 := t.span(n)
	return Card{ID: id, C0: c0, C1: c1, R0: r0, R1: r1}, true
}

// SetData sets the data of the content card id.
func (t *GroupTree) SetData(id string, data json.RawMessage) bool { return t.grid.SetData(id, data) }

// heads is the number of group cards of path that start on the row line r0.
func (t *GroupTree) heads(path []*node, r0 int) int {
	k := 0
	for _, n := range path {
		if _, _, start, _ := t.span(n); start == r0 {
			k++
		}
	}
	return k
}

// Rect is the drawn rectangle of the card id (docs/spec/groups.md#drawn-rectangles): its rectangle in the grid, for a group card the
// union of the rectangles of the content cards inside it, moved down and shortened by the headers of the group cards that hold it and
// start on its first row line.
func (t *GroupTree) Rect(id string) (Rect, bool) {
	path, n, ok := t.find(id)
	if !ok {
		return Rect{}, false
	}
	if n == nil || !n.group {
		rect, ok := t.grid.Rect(id)
		card, _ := t.grid.Card(id) // silent: the grid holds the card.
		k := float64(t.heads(path, card.R0))
		rect.Y += k * t.headStep()
		rect.H -= k * t.headStep()
		return rect, ok
	}
	// A group card is drawn below the headers of the group cards that hold it and start on its first row line, as a content card is.
	rect := t.union(n)
	_, _, r0, _ := t.span(n)
	k := float64(t.heads(path, r0))
	rect.Y += k * t.headStep()
	rect.H -= k * t.headStep()
	return rect, true
}

// headStep is how far one header moves the boxes below it down: the header and the corridor that separates it from them, as between
// two cards (docs/spec/groups.md#drawn-rectangles).
func (t *GroupTree) headStep() float64 { return t.head + t.grid.Gap() }

// union is the union of the rectangles in the grid of the content cards inside the node.
func (t *GroupTree) union(n *node) Rect {
	x0, y0, x1, y1 := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
	for _, id := range t.inside(n) {
		r, _ := t.grid.Rect(id) // silent: the tree holds cards of the grid.
		x0, y0, x1, y1 = math.Min(x0, r.X), math.Min(y0, r.Y), math.Max(x1, r.X+r.W), math.Max(y1, r.Y+r.H)
	}
	return Rect{X: x0, Y: y0, W: x1 - x0, H: y1 - y0}
}

// HeadRect is the header of the group card id: a row of the head height at the top of its rectangle, below the headers of the group
// cards that hold it and start on the same row line.
func (t *GroupTree) HeadRect(id string) (Rect, bool) {
	_, n, _ := t.find(id) // silent: an id that is no card has no node.
	if n == nil || !n.group {
		return Rect{}, false
	}
	rect, _ := t.Rect(id) // silent: find found the group card.
	return Rect{X: rect.X, Y: rect.Y, W: rect.W, H: t.head}, true
}

// drawn is the drawn rectangle of each content card.
func (t *GroupTree) drawn() map[string]Rect {
	out := map[string]Rect{}
	for _, card := range t.grid.Cards() {
		if rect, ok := t.Rect(card.ID); ok && !IsWindowSide(card.ID) {
			out[card.ID] = rect
		}
	}
	return out
}

// below is the first content card in workbench order that the change from before draws differently and below minSize, or "". A grid
// without its size draws nothing yet, as the layout library checks no size before the plane has one.
func (t *GroupTree) below(before map[string]Rect) (string, Rect) {
	if t.grid.Width() == 0 || t.grid.Height() == 0 {
		return "", Rect{}
	}
	after := t.drawn()
	least := t.grid.MinSize() - 1e-6
	for _, id := range t.Cards() {
		rect, content := after[id]
		if !content {
			continue
		}
		if was, had := before[id]; had && was == rect {
			continue
		}
		if rect.W < least || rect.H < least {
			return id, rect
		}
	}
	return "", Rect{}
}

// covers tells whether the group node covers one rectangle: the cells of the content cards inside it fill their span. A card that an
// operation in progress took out of the grid, or merged into the card of its group, counts no cell, and a group without a card in the
// grid covers its rectangle, the card that replaced it.
func (t *GroupTree) covers(n *node) bool {
	c0, c1, r0, r1 := t.span(n)
	cells, present := 0, false
	for _, id := range t.inside(n) {
		if card, ok := t.grid.Card(id); ok {
			cells, present = cells+(card.C1-card.C0)*(card.R1-card.R0), true
		}
	}
	return !present || cells == (c1-c0)*(r1-r0)
}

// broken is the first group card in workbench order that does not cover one rectangle, or "".
func (t *GroupTree) broken() string {
	for _, id := range t.Cards() {
		if n := t.groupNode(id); n != nil && !t.covers(n) {
			return id
		}
	}
	return ""
}

type snapshot struct {
	state  State
	roots  []*node
	leader string
	last   int
}

func copyNodes(nodes []*node) []*node {
	out := make([]*node, len(nodes))
	for i, n := range nodes {
		kept := *n
		kept.members = copyNodes(n.members)
		out[i] = &kept
	}
	return out
}

func (t *GroupTree) snapshot() snapshot {
	return snapshot{state: t.grid.ToJSON(), roots: copyNodes(t.roots), leader: t.leader, last: t.last}
}

func (t *GroupTree) restore(s snapshot) {
	t.grid.reload(s.state)
	t.roots, t.leader, t.last = copyNodes(s.roots), s.leader, s.last
}

// Probe runs change on the tree and puts the tree back, and returns what change returned: the drop preview asks what a drop would
// make without making it.
func (t *GroupTree) Probe(change func() error) error {
	kept := t.snapshot()
	defer t.restore(kept)
	return change()
}

// try runs change, the operation op of the card id, and keeps its result only when every group card still covers one rectangle and
// no content card that it changed is drawn below minSize; otherwise the tree is put back and the refusal is returned
// (docs/spec/groups.md#commands).
func (t *GroupTree) try(id, op string, change func() error) error {
	before := t.drawn()
	kept := t.snapshot()
	if err := change(); err != nil {
		t.restore(kept)
		return err
	}
	t.keepLines()
	if group := t.broken(); group != "" {
		t.restore(kept)
		return fmt.Errorf("card %s cannot %s: group %s would not cover one rectangle", id, op, group)
	}
	if card, rect := t.below(before); card != "" {
		t.restore(kept)
		minimum := t.grid.MinSize()
		return fmt.Errorf("card %s cannot %s: card %s would be %s, below its minimum %s", id, op, card, sizeText(rect.W, rect.H),
			sizeText(minimum, minimum))
	}
	return nil
}

// keepLines removes the paidBy records and the lines that no card uses while the space holds a group card, so a later close gives the
// cells of a card to its neighbours without moving the lines of other groups, and a later split does not land on a seam of another
// group (docs/spec/groups.md#model).
func (t *GroupTree) keepLines() {
	if len(t.roots) == 0 {
		return
	}
	clear(t.grid.paidBy)
	t.grid.Tidy()
}

// issue returns the next card id of the space.
func (t *GroupTree) issue() string {
	t.last++
	return "card-" + strconv.Itoa(t.last)
}

// sizeText is a drawn size in whole points.
func sizeText(w, h float64) string {
	return strconv.Itoa(int(math.Round(w))) + "x" + strconv.Itoa(int(math.Round(h)))
}

// cellBox is a card of the grid with the coordinates of its lines.
type cellBox struct {
	card           Card
	x0, x1, y0, y1 float64
}

// boxes is the cards of the grid with their coordinates.
func (t *GroupTree) boxes() ([]cellBox, map[string]Paid) {
	state := t.grid.ToJSON()
	out := []cellBox{}
	for _, card := range state.Cards {
		out = append(out, cellBox{card: card, x0: state.Xs[card.C0], x1: state.Xs[card.C1], y0: state.Ys[card.R0], y1: state.Ys[card.R1]})
	}
	return out, state.PaidBy
}

// install makes the grid of the boxes: the lines are the coordinates that the boxes use, so a line that no card uses is removed (tidy),
// and the paidBy records of the cards in laid are dropped, because their lines moved. Replace checks the result.
func (t *GroupTree) install(boxes []cellBox, paid map[string]Paid, laid map[string]bool) error {
	lines := func(of func(b cellBox) [2]float64) ([]float64, map[float64]int) {
		set := map[float64]bool{}
		for _, b := range boxes {
			ends := of(b)
			set[ends[0]], set[ends[1]] = true, true
		}
		out := []float64{}
		for v := range set {
			out = append(out, v)
		}
		sort.Float64s(out)
		index := map[float64]int{}
		for i, v := range out {
			index[v] = i
		}
		return out, index
	}
	xs, xi := lines(func(b cellBox) [2]float64 { return [2]float64{b.x0, b.x1} })
	ys, yi := lines(func(b cellBox) [2]float64 { return [2]float64{b.y0, b.y1} })
	state := State{Xs: xs, Ys: ys, PaidBy: map[string]Paid{}}
	for _, b := range boxes {
		card := b.card
		card.C0, card.C1, card.R0, card.R1 = xi[b.x0], xi[b.x1], yi[b.y0], yi[b.y1]
		state.Cards = append(state.Cards, card)
	}
	for id, record := range paid {
		if !laid[id] && !laid[record.To] {
			state.PaidBy[id] = record
		}
	}
	return t.grid.Replace(state)
}

// mapped is the coordinate v of the span [a0, b0] used in the span [a, b] (docs/spec/groups.md#the-rectangle-of-a-group-card). The ends of
// the span are the ends of the new span exactly.
func mapped(v, a0, b0, a, b float64) float64 {
	switch v {
	case a0:
		return a
	case b0:
		return b
	}
	return a + (b-a)*(v-a0)/(b0-a0)
}

// bounds is the coordinates of the rectangle of the cards in ids among boxes.
func bounds(boxes []cellBox, ids map[string]bool) (x0, x1, y0, y1 float64) {
	x0, y0, x1, y1 = math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
	for _, b := range boxes {
		if ids[b.card.ID] {
			x0, x1, y0, y1 = math.Min(x0, b.x0), math.Max(x1, b.x1), math.Min(y0, b.y0), math.Max(y1, b.y1)
		}
	}
	return x0, x1, y0, y1
}

func idSet(ids []string) map[string]bool {
	out := map[string]bool{}
	for _, id := range ids {
		out[id] = true
	}
	return out
}

// splitRect splits the rectangle of the group node toward side: the new card id with data takes the half toward side, and the members
// of the node are laid into the other half.
func (t *GroupTree) splitRect(n *node, side Side, id string, data json.RawMessage) error {
	boxes, paid := t.boxes()
	ids := idSet(t.inside(n))
	x0, x1, y0, y1 := bounds(boxes, ids)
	born := cellBox{card: Card{ID: id, Data: data}, x0: x0, x1: x1, y0: y0, y1: y1}
	tx0, tx1, ty0, ty1 := x0, x1, y0, y1
	switch side {
	case "right":
		mid := (x0 + x1) / 2
		born.x0, tx1 = mid, mid
	case "left":
		mid := (x0 + x1) / 2
		born.x1, tx0 = mid, mid
	case "bottom":
		mid := (y0 + y1) / 2
		born.y0, ty1 = mid, mid
	default:
		mid := (y0 + y1) / 2
		born.y1, ty0 = mid, mid
	}
	for i, b := range boxes {
		if ids[b.card.ID] {
			boxes[i].x0, boxes[i].x1 = mapped(b.x0, x0, x1, tx0, tx1), mapped(b.x1, x0, x1, tx0, tx1)
			boxes[i].y0, boxes[i].y1 = mapped(b.y0, y0, y1, ty0, ty1), mapped(b.y1, y0, y1, ty0, ty1)
		}
	}
	ids[id] = true
	return t.install(append(boxes, born), paid, ids)
}

// merged is the cards inside a group card that merge replaced with one card, with the rectangle they had.
type merged struct {
	boxes          []cellBox
	x0, x1, y0, y1 float64
}

// merge replaces the content cards inside the group node with one card of the id of the node that covers its rectangle.
func (t *GroupTree) merge(n *node) (merged, error) {
	boxes, paid := t.boxes()
	ids := idSet(t.inside(n))
	saved := merged{}
	saved.x0, saved.x1, saved.y0, saved.y1 = bounds(boxes, ids)
	kept := []cellBox{}
	for _, b := range boxes {
		if ids[b.card.ID] {
			saved.boxes = append(saved.boxes, b)
		} else {
			kept = append(kept, b)
		}
	}
	kept = append(kept, cellBox{card: Card{ID: n.card}, x0: saved.x0, x1: saved.x1, y0: saved.y0, y1: saved.y1})
	ids[n.card] = true
	return saved, t.install(kept, paid, ids)
}

// unmerge lays the cards that merge saved into the rectangle of the card id, which replaced them.
func (t *GroupTree) unmerge(id string, saved merged) error {
	boxes, paid := t.boxes()
	kept := []cellBox{}
	var at cellBox
	for _, b := range boxes {
		if b.card.ID == id {
			at = b
		} else {
			kept = append(kept, b)
		}
	}
	ids := map[string]bool{id: true}
	for _, b := range saved.boxes {
		ids[b.card.ID] = true
		kept = append(kept, cellBox{card: b.card,
			x0: mapped(b.x0, saved.x0, saved.x1, at.x0, at.x1), x1: mapped(b.x1, saved.x0, saved.x1, at.x0, at.x1),
			y0: mapped(b.y0, saved.y0, saved.y1, at.y0, at.y1), y1: mapped(b.y1, saved.y0, saved.y1, at.y0, at.y1)})
	}
	return t.install(kept, paid, ids)
}

// container is the members of the level that holds the card id, as a pointer that a change of the level writes through.
func (t *GroupTree) container(id string) (*[]*node, string) {
	path, _, _ := t.find(id) // silent: an id that is no card is held by the root level.
	if len(path) == 0 {
		return &t.roots, ""
	}
	parent := path[len(path)-1]
	return &parent.members, parent.card
}

// detach takes the card id out of the tree's record of its level, keeps the leader rule of the level it leaves and returns the key of
// that level. A content card of the root level has no record.
func (t *GroupTree) detach(id string) string {
	members, key := t.container(id)
	*members = slices.DeleteFunc(*members, func(n *node) bool { return n.card == id })
	if lead, _ := t.Leader(key); lead == id {
		t.setLeader(key, "")
		for _, n := range t.ordered(t.level(key)) {
			if n.card != id && !IsWindowSide(n.card) {
				t.setLeader(key, n.card)
				break
			}
		}
	}
	return key
}

// attach puts the node into the level key and gives a level without a leader that card.
func (t *GroupTree) attach(key string, n *node) {
	if key == "" {
		if n.group {
			t.roots = append(t.roots, n)
		}
	} else if parent := t.groupNode(key); parent != nil {
		parent.members = append(parent.members, n)
	}
	if lead, _ := t.Leader(key); lead == "" && !IsWindowSide(n.card) {
		t.setLeader(key, n.card)
	}
}

// collapse replaces the group card key, when it holds one member, with that member, which takes its slot and its leader mark
// (docs/spec/groups.md#closing). It returns the member, or key.
func (t *GroupTree) collapse(key string) string {
	n := t.groupNode(key)
	if n == nil || len(n.members) != 1 {
		return key
	}
	sole := n.members[0]
	members, outer := t.container(key)
	at := slices.Index(*members, n)
	if sole.group || outer != "" {
		(*members)[at] = sole
	} else {
		*members = slices.Delete(*members, at, at+1)
	}
	if lead, _ := t.Leader(outer); lead == key {
		t.setLeader(outer, sole.card)
	}
	return sole.card
}

// nodeOf is the node of the card id: its group node, or a node of a content card.
func (t *GroupTree) nodeOf(id string) *node {
	if n := t.groupNode(id); n != nil {
		return n
	}
	return &node{card: id}
}

// groupName is the name 그룹 <n> with the smallest positive n that no group of the space has.
func (t *GroupTree) groupName() string {
	taken := map[string]bool{}
	for _, id := range t.Cards() {
		if n := t.groupNode(id); n != nil {
			taken[n.name] = true
		}
	}
	for n := 1; ; n++ {
		name := "그룹 " + strconv.Itoa(n)
		if !taken[name] {
			return name
		}
	}
}

// requireCard refuses an id that is no card of the space.
func (t *GroupTree) requireCard(id string) error {
	if _, _, ok := t.find(id); !ok {
		return fmt.Errorf("no card %s", id)
	}
	return nil
}

// splitCard puts the new card id with data beside the card target toward side: the split of the layout for a content card, or the
// split of its rectangle for a group card. A split toward top or bottom whose upper card is drawn below headers, which a group always
// is, cuts at a new line (docs/spec/groups.md#split-setting). It is false when the layout refuses.
func (t *GroupTree) splitCard(target string, side Side, id string, data json.RawMessage, grouping bool) (bool, error) {
	if n := t.groupNode(target); n != nil {
		return true, t.splitRect(n, side, id, data)
	}
	fresh := false
	if axisOf(side) == "y" {
		drawn, _ := t.Rect(target) // silent: requireCard found the card.
		grid, _ := t.grid.Rect(target)
		fresh = grouping || drawn.Y > grid.Y
	}
	_, ok := t.grid.splitToward(target, side, SplitInit{ID: &id, Data: data}, fresh)
	return ok, nil
}

// level moves the line between the card target and the new card id of a split toward top or bottom, so that both are drawn at one
// height below the headers that the upper one stands under (docs/spec/groups.md#split-setting). A split across does not change it.
func (t *GroupTree) levelSplit(target string, side Side, id string) {
	if axisOf(side) != "y" {
		return
	}
	upper, lower := target, id
	if side == "top" {
		upper, lower = id, target
	}
	up, _ := t.Rect(upper) // silent: both cards are in the tree after the split.
	down, _ := t.Rect(lower)
	_, n, _ := t.find(lower)
	if n == nil {
		n = &node{card: lower}
	}
	_, _, line, _ := t.span(n)
	if delta := (down.H - up.H) / 2; math.Abs(delta) > eps {
		t.grid.MoveBoundary("y", line, t.grid.BoundaryPos("y", line)+delta, false)
	}
}

// balanced runs the balance of cardSplit even after the split of the card id toward side (docs/spec/groups.md#split-setting) and keeps
// it only when no content card that it changed is drawn below minSize.
func (t *GroupTree) balanced(id string, side Side) error {
	before := t.drawn()
	kept := t.snapshot()
	if _, err := t.grid.Balance(); err != nil {
		t.restore(kept)
		return fmt.Errorf("card %s cannot split toward %s: cardSplit even cannot balance the grid: %w", id, side, err)
	}
	if card, rect := t.below(before); card != "" {
		t.restore(kept)
		minimum := t.grid.MinSize()
		return fmt.Errorf("card %s cannot split toward %s: cardSplit even would draw card %s at %s, below its minimum %s", id, side, card,
			sizeText(rect.W, rect.H), sizeText(minimum, minimum))
	}
	return nil
}

// CheckGroup is the refusal of a group of the card id toward side before the layout is asked, or nil.
func (t *GroupTree) CheckGroup(id string, side Side) error {
	if IsWindowSide(id) {
		return fmt.Errorf("card %s is a window sidebar; a group holds content cards and group cards", id)
	}
	if !isSide(side) {
		return fmt.Errorf("unknown side %s; use left, right, top or bottom", side)
	}
	return t.requireCard(id)
}

// CreateGroup groups the card id with a new content card with data toward side, and returns the group card and the new card. even
// balances the grid after the split (cardSplit even).
func (t *GroupTree) CreateGroup(id string, side Side, data json.RawMessage, even bool) (string, string, error) {
	if err := t.CheckGroup(id, side); err != nil {
		return "", "", err
	}
	kept := t.snapshot()
	var group, born string
	err := t.try(id, "hold a group toward "+side, func() error {
		name := t.groupName()
		group, born = t.issue(), t.issue()
		if ok, err := t.splitCard(id, side, born, data, true); err != nil || !ok {
			if err == nil {
				err = fmt.Errorf("card %s cannot hold a group toward %s", id, side)
			}
			return err
		}
		members, key := t.container(id)
		n := &node{card: group, group: true, name: name, leader: id, members: []*node{t.nodeOf(id), {card: born}}}
		if at := slices.IndexFunc(*members, func(m *node) bool { return m.card == id }); at >= 0 {
			(*members)[at] = n
		} else {
			*members = append(*members, n)
		}
		if lead, _ := t.Leader(key); lead == id {
			t.setLeader(key, group)
		}
		t.levelSplit(id, side, born)
		return nil
	})
	if err == nil && even {
		if err = t.balanced(id, side); err != nil {
			t.restore(kept)
		}
	}
	if err != nil {
		return "", "", err
	}
	return group, born, nil
}

// requireGroup refuses an id that is no group card.
func (t *GroupTree) requireGroup(id string) (*node, error) {
	n := t.groupNode(id)
	if n == nil {
		return nil, fmt.Errorf("card %s is not a group", id)
	}
	return n, nil
}

// Dissolve replaces the group card id with its members in the level that holds it. The grid does not change.
func (t *GroupTree) Dissolve(id string) error {
	n, err := t.requireGroup(id)
	if err != nil {
		return err
	}
	members, key := t.container(id)
	at := slices.Index(*members, n)
	inner := []*node{}
	for _, m := range n.members {
		if key != "" || m.group {
			inner = append(inner, m)
		}
	}
	*members = slices.Concat((*members)[:at], inner, (*members)[at+1:])
	if lead, _ := t.Leader(key); lead == id {
		t.setLeader(key, n.leader)
	}
	return nil
}

// Rename sets the name of the group card id to name with the white space at both ends removed, and returns the name.
func (t *GroupTree) Rename(id, name string) (string, error) {
	n, err := t.requireGroup(id)
	if err != nil {
		return "", err
	}
	trimmed := strings.TrimSpace(name)
	if count := utf8.RuneCountInString(trimmed); count < 1 || count > 40 {
		return "", fmt.Errorf("group name must be 1 to 40 characters: %s", trimmed)
	}
	n.name = trimmed
	return trimmed, nil
}

// SetLeader makes the card id the leader of its level and returns the group card that holds it, or "" for the root level.
func (t *GroupTree) SetLeader(id string) (string, error) {
	if IsWindowSide(id) {
		return "", fmt.Errorf("card %s is a window sidebar and cannot lead a level", id)
	}
	if err := t.requireCard(id); err != nil {
		return "", err
	}
	key := t.Parent(id)
	t.setLeader(key, id)
	return key, nil
}

// Split puts a new content card with data beside the card id toward side and returns its id: the new card of a content card joins the
// group that holds the card, and the new card of a group card joins the level that holds the group card. even balances the grid after
// the split (cardSplit even).
func (t *GroupTree) Split(id string, side Side, data json.RawMessage, even bool) (string, error) {
	if !isSide(side) {
		return "", fmt.Errorf("unknown side %s; use left, right, top or bottom", side)
	}
	if err := t.requireCard(id); err != nil {
		return "", err
	}
	kept := t.snapshot()
	var born string
	err := t.try(id, "split toward "+side, func() error {
		born = t.issue()
		if ok, err := t.splitCard(id, side, born, data, false); err != nil || !ok {
			if err == nil {
				err = fmt.Errorf("card %s cannot split toward %s", id, side)
			}
			return err
		}
		t.attach(t.Parent(id), &node{card: born})
		t.levelSplit(id, side, born)
		return nil
	})
	if err == nil && even {
		if err = t.balanced(id, side); err != nil {
			t.restore(kept)
		}
	}
	if err != nil {
		return "", err
	}
	return born, nil
}

// CanSplit tells whether Split of the card id toward side would succeed.
func (t *GroupTree) CanSplit(id string, side Side) bool {
	return t.Probe(func() error {
		_, err := t.Split(id, side, nil, false)
		return err
	}) == nil
}

// AddCard puts a new content card with data into the group card id at the right edge of its rectangle and returns its id.
func (t *GroupTree) AddCard(id string, data json.RawMessage) (string, error) {
	n, err := t.requireGroup(id)
	if err != nil {
		return "", err
	}
	var born string
	err = t.try(id, "split toward right", func() error {
		born = t.issue()
		if err := t.splitRect(n, "right", born, data); err != nil {
			return err
		}
		t.attach(id, &node{card: born})
		return nil
	})
	return born, err
}

// Close closes the card id with every card inside it and returns the content cards that it closed. A group card left with one member
// is replaced by that member (docs/spec/groups.md#closing).
func (t *GroupTree) Close(id string) ([]string, error) {
	if err := t.requireCard(id); err != nil {
		return nil, err
	}
	closed := t.ContentInside(id)
	err := t.try(id, "close", func() error {
		if n := t.groupNode(id); n != nil {
			if _, err := t.merge(n); err != nil {
				return err
			}
		}
		if err := t.closeCell(id, "close"); err != nil {
			return err
		}
		t.collapse(t.detach(id))
		return nil
	})
	if err != nil {
		return nil, err
	}
	return closed, nil
}

// closeCell closes the card id of the grid for the operation op. A row of neighbours takes its cells: the sides are tried in the fill
// order of the layout library, the sides whose row lies in the level of the card first, and the first result that keeps every group card
// one rectangle is kept; without such a row the slots of the card are removed, as the library removes them (R7). The refusal names the
// cause (docs/spec/groups.md#closing).
func (t *GroupTree) closeCell(id, op string) error {
	refused := func(why string) error { return fmt.Errorf("card %s cannot %s: %s", id, op, why) }
	if t.grid.removable(id) == nil {
		return refused("it is the last card of the layout")
	}
	level := map[string]bool{}
	for _, n := range t.level(t.Parent(id)) {
		for _, inner := range t.inside(n) {
			level[inner] = true
		}
	}
	inLevel := func(side string) bool {
		found := t.grid.fillAlong(id, []string{side})
		if found == nil {
			return false
		}
		for _, c := range found.cards {
			if !level[c.ID] {
				return false
			}
		}
		return true
	}
	sides := slices.Clone(fillOrders[t.grid.order])
	slices.SortStableFunc(sides, func(a, b string) int {
		ia, ib := inLevel(a), inLevel(b)
		switch {
		case ia && !ib:
			return -1
		case ib && !ia:
			return 1
		}
		return 0
	})
	broken := ""
	for _, side := range sides {
		if t.grid.fillAlong(id, []string{side}) == nil {
			continue
		}
		kept := t.snapshot()
		if t.grid.closeAlong(id, []string{side}) {
			group := t.broken()
			if group == "" {
				return nil
			}
			if broken == "" {
				broken = group
			}
		}
		t.restore(kept)
	}
	if broken != "" {
		return refused("group " + broken + " would not cover one rectangle")
	}
	if t.grid.closeAlong(id, nil) {
		return nil
	}
	return refused("no row of cards that can grow covers a side of it, and its slots hold other cards")
}

// CanClose tells whether Close of the card id would succeed.
func (t *GroupTree) CanClose(id string) bool {
	return t.Probe(func() error {
		_, err := t.Close(id)
		return err
	}) == nil
}

// CheckMove is the refusal of a move of the card id to side of target before the layout is asked, or nil
// (docs/spec/groups.md#commands).
func (t *GroupTree) CheckMove(id, target, side string) error {
	if IsWindowSide(id) {
		return fmt.Errorf("card %s is a window sidebar and does not move", id)
	}
	if IsWindowSide(target) {
		return fmt.Errorf("card %s is a window sidebar; a card does not move beside it", target)
	}
	if err := t.requireCard(id); err != nil {
		return err
	}
	if err := t.requireCard(target); err != nil {
		return err
	}
	if target == id || slices.Contains(t.Groups(target), id) {
		return fmt.Errorf("card %s cannot move into itself", id)
	}
	if side == "centre" && !t.IsGroup(target) {
		return fmt.Errorf("card %s is not a group; a card moves beside it", target)
	}
	if side != "centre" && !isSide(side) {
		return fmt.Errorf("unknown side %s; use left, right, top, bottom or centre", side)
	}
	return nil
}

// Moved tells whether the card id already stands where a move to side of target puts it.
func (t *GroupTree) Moved(id, target, side string) bool {
	if side == "centre" {
		if t.Parent(id) != target {
			return false
		}
		card, _ := t.Card(id)      // silent: the parent holds the card.
		group, _ := t.Card(target) // silent: target is a group card.
		return card.C1 == group.C1 && card.R0 == group.R0 && card.R1 == group.R1
	}
	return t.Parent(id) == t.Parent(target) && t.Neighbour(target, side) == id
}

// Neighbour is the member of the level of card whose edge lies on the line of the edge of card toward side and which spans the same two
// lines across that side, or "".
func (t *GroupTree) Neighbour(card, side string) string {
	if err := t.requireCard(card); err != nil {
		return ""
	}
	from, _ := t.Card(card) // silent: card is a card of the space.
	for _, id := range t.Members(t.Parent(card)) {
		if id == card || IsWindowSide(id) {
			continue
		}
		other, _ := t.Card(id) // silent: a member is a card of the space.
		rows := other.R0 == from.R0 && other.R1 == from.R1
		columns := other.C0 == from.C0 && other.C1 == from.C1
		if side == "right" && rows && other.C0 == from.C1 || side == "left" && rows && other.C1 == from.C0 ||
			side == "bottom" && columns && other.R0 == from.R1 || side == "top" && columns && other.R1 == from.R0 {
			return id
		}
	}
	return ""
}

// Move moves the card id beside target on side into the level of target, or with side centre into the group card target at the right
// edge of its rectangle (docs/spec/groups.md#commands).
func (t *GroupTree) Move(id, target, side string) error {
	if err := t.CheckMove(id, target, side); err != nil {
		return err
	}
	if t.Moved(id, target, side) {
		return nil
	}
	op := "move to " + side + " of " + target
	refused := fmt.Errorf("card %s cannot %s", id, op)
	return t.try(id, op, func() error {
		moving := t.nodeOf(id)
		if !moving.group && !t.IsGroup(target) && side != "centre" {
			into := t.Parent(target)
			var closing error
			if !t.grid.moveWith(id, target, side, func() bool {
				closing = t.closeCell(id, op)
				return closing == nil
			}) {
				if closing != nil {
					return closing
				}
				return refused
			}
			from := t.detach(id)
			t.attach(into, moving)
			t.collapse(from)
			return nil
		}
		var saved merged
		var data json.RawMessage
		if moving.group {
			var err error
			if saved, err = t.merge(moving); err != nil {
				return err
			}
		} else {
			card, _ := t.grid.Card(id) // silent: CheckMove found the card.
			data = card.Data
		}
		if err := t.closeCell(id, op); err != nil {
			return err
		}
		// The target is decided before a group that the card leaves is replaced by its one member: a move beside that group lands
		// beside the member, and a move into it keeps the group until the card is back.
		from := t.detach(id)
		if side != "centre" || from != target {
			if member := t.collapse(from); from == target {
				target = member
			}
		}
		into := t.Parent(target)
		if side == "centre" {
			into = target
			if err := t.splitRect(t.groupNode(target), "right", id, data); err != nil {
				return err
			}
		} else if ok, err := t.splitCard(target, side, id, data, false); err != nil || !ok {
			if err == nil {
				err = refused
			}
			return err
		}
		if moving.group {
			if err := t.unmerge(id, saved); err != nil {
				return err
			}
		}
		t.attach(into, moving)
		t.collapse(from)
		return nil
	})
}

// Balance balances the grid; it keeps the arrangement, so every group card keeps its rectangle.
func (t *GroupTree) Balance() error {
	before := t.drawn()
	kept := t.snapshot()
	if _, err := t.grid.Balance(); err != nil {
		return err
	}
	if card, rect := t.below(before); card != "" {
		t.restore(kept)
		minimum := t.grid.MinSize()
		return fmt.Errorf("the layout cannot balance: card %s would be %s, below its minimum %s", card, sizeText(rect.W, rect.H),
			sizeText(minimum, minimum))
	}
	return nil
}

// MoveBoundary moves the boundary line of axis toward px, as Grid.MoveBoundary does across every group, and stops at the last position
// at which every content card beside the line is drawn at least minSize (docs/spec/groups.md#minimum-size). It returns where the
// boundary stands.
func (t *GroupTree) MoveBoundary(axis Axis, line int, px float64, allowSnap bool) float64 {
	from := t.grid.BoundaryPos(axis, line)
	before := t.drawn()
	kept := t.snapshot()
	moved := t.grid.MoveBoundary(axis, line, px, allowSnap)
	if card, _ := t.below(before); card == "" {
		return moved
	}
	// The drawn sizes change monotonically along the move, so the last position that keeps them is found by halving the distance
	// between the start, which keeps them, and the refused position.
	good, bad := from, moved
	for range 40 {
		middle := (good + bad) / 2
		t.restore(kept)
		t.grid.MoveBoundary(axis, line, middle, false)
		if card, _ := t.below(before); card == "" {
			good = middle
		} else {
			bad = middle
		}
	}
	t.restore(kept)
	return t.grid.MoveBoundary(axis, line, good, false)
}

// Focusable is the content card that a focus of the card id gives: the card itself, or for a group card the first content card
// inside it in workbench order.
func (t *GroupTree) Focusable(id string) string {
	if inside := t.ContentInside(id); len(inside) > 0 {
		return inside[0]
	}
	return id
}

// GroupSide is the side of the group button of the card id: right when it is drawn wider than high, otherwise bottom.
func (t *GroupTree) GroupSide(id string) Side {
	if rect, ok := t.Rect(id); ok && rect.W > rect.H {
		return "right"
	}
	return "bottom"
}

// CanGroup tells whether the group button of the card id is shown: a group of the card and a new card toward its longer axis would
// succeed (docs/spec/groups.md#headers).
func (t *GroupTree) CanGroup(id string) bool {
	return t.Probe(func() error {
		_, _, err := t.CreateGroup(id, t.GroupSide(id), nil, false)
		return err
	}) == nil
}

// DropAt resolves a drop at x, y from the root level inward (docs/spec/groups.md#moving-and-dropping): a point on the header of a group
// card is its centre, a point in the outer edge fraction of its rectangle is that side, and every other point of it goes on to its
// members; a point of no group card is the zone of the grid. A drop on the card without, or inside it, is no zone.
func (t *GroupTree) DropAt(x, y float64, options ZoneOptions, without string) *ZoneHit {
	edge := 0.25
	if options.Edge != nil && *options.Edge >= 0 && *options.Edge <= 0.5 {
		edge = *options.Edge
	}
	excluded := func(id string) bool {
		return without != "" && (id == without || slices.Contains(t.Groups(id), without))
	}
	level := t.roots
	for {
		var hit *node
		for _, n := range level {
			if !n.group {
				continue
			}
			r := t.union(n)
			if x >= r.X && x <= r.X+r.W && y >= r.Y && y <= r.Y+r.H {
				hit = n
				break
			}
		}
		if hit == nil {
			zone := t.grid.ZoneAt(x, y, options)
			if zone == nil || excluded(zone.ID) {
				return nil
			}
			return zone
		}
		if excluded(hit.card) {
			return nil
		}
		head, _ := t.HeadRect(hit.card) // silent: hit is a group card.
		if y <= head.Y+head.H {
			return &ZoneHit{ID: hit.card, Zone: "centre"}
		}
		r := t.union(hit)
		px, py := (x-r.X)/r.W, (y-r.Y)/r.H
		if !(px > edge && px < 1-edge && py > edge && py < 1-edge) {
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
			return &ZoneHit{ID: hit.card, Zone: zone}
		}
		level = hit.members
	}
}

// Fullscreen is the rectangle of each card inside the group card id while it is shown across rect: the rectangle of the group card is
// stretched onto rect on each axis (docs/spec/groups.md#card-commands-on-a-group-card).
func (t *GroupTree) Fullscreen(id string, rect Rect) map[string]Rect {
	n := t.groupNode(id)
	if n == nil {
		return nil
	}
	from := t.union(n)
	fit := func(r Rect) Rect {
		x0 := rect.X + (r.X-from.X)*rect.W/from.W
		x1 := rect.X + (r.X+r.W-from.X)*rect.W/from.W
		y0 := rect.Y + (r.Y-from.Y)*rect.H/from.H
		y1 := rect.Y + (r.Y+r.H-from.Y)*rect.H/from.H
		return Rect{X: x0, Y: y0, W: x1 - x0, H: y1 - y0}
	}
	out := map[string]Rect{}
	for _, card := range t.Cards() {
		if card != id && !slices.Contains(t.Groups(card), id) {
			continue
		}
		r, _ := t.Rect(card) // silent: card is a card of the space.
		if t.IsGroup(card) {
			out[card] = fit(r)
			continue
		}
		// A content card keeps the headers of the group cards above it at their height.
		lib, _ := t.grid.Rect(card) // silent: card is a card of the grid.
		fitted := fit(lib)
		k := r.Y - lib.Y
		fitted.Y += k
		fitted.H -= k
		out[card] = fitted
	}
	return out
}

// storedNode is the stored form of a group card (docs/spec/groups.md#storage).
type storedNode struct {
	Card    string `json:"card"`
	Name    string `json:"name"`
	Level   *int   `json:"level,omitempty"`
	Leader  string `json:"leader"`
	Members []any  `json:"members"`
}

// nodes is the stored form of the group cards of a level, each member in reading order; level adds the level of each node.
func (t *GroupTree) nodes(level []*node, depth int, withLevel bool) []any {
	out := []any{}
	for _, n := range t.ordered(level) {
		if !n.group {
			out = append(out, n.card)
			continue
		}
		stored := storedNode{Card: n.card, Name: n.name, Leader: n.leader, Members: t.nodes(n.members, depth+1, withLevel)}
		if withLevel {
			d := depth + 1
			stored.Level = &d
		}
		out = append(out, stored)
	}
	return out
}

// Stored is the stored form of the group tree: the group cards of the root level, the leader of the root level, or nil, and lastCard.
func (t *GroupTree) Stored() ([]any, *string, int) {
	var leader *string
	if t.leader != "" {
		lead := t.leader
		leader = &lead
	}
	return t.nodes(t.roots, 0, false), leader, t.last
}

// Reported is the group tree that core.layout reports: the stored form with the level of each node.
func (t *GroupTree) Reported() []any { return t.nodes(t.roots, 0, true) }

// ReportedMembers is the members of the group card id in the form of Reported.
func (t *GroupTree) ReportedMembers(id string) []any {
	path, n, _ := t.find(id) // silent: an id that is no card has no members.
	if n == nil || !n.group {
		return nil
	}
	return t.nodes(n.members, len(path)+1, true)
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

// compact is the text of a JSON value without white space, and undefined for an absent value.
func compact(raw json.RawMessage) string {
	if raw == nil {
		return "undefined"
	}
	var out bytes.Buffer
	if json.Compact(&out, raw) != nil {
		return string(raw)
	}
	return out.String()
}

// ReadTree reads the stored layout of a space: the grid state, the group tree, the leader of the root level and lastCard as stored,
// each refused with the text of docs/spec/groups.md#storage. A member that is absent is nil.
func ReadTree(state State, groups, leader, lastCard json.RawMessage, options GroupOptions, grid *Grid) (*GroupTree, error) {
	if err := grid.Replace(state); err != nil {
		return nil, err
	}
	t := &GroupTree{grid: grid, head: options.Head}
	items, ok := list(groups)
	if !ok {
		return nil, fmt.Errorf("layout stores groups %s, which is not a list of groups", compact(groups))
	}
	seen := map[string]bool{}
	content := map[string]bool{}
	for _, card := range state.Cards {
		seen[card.ID] = true
		content[card.ID] = !card.Fixed
	}
	held := map[string]bool{}
	for _, raw := range items {
		n, err := t.readNode(raw, seen, content, held)
		if err != nil {
			return nil, err
		}
		t.roots = append(t.roots, n)
	}
	if err := t.readLeader(leader); err != nil {
		return nil, err
	}
	for _, id := range t.Cards() {
		if n := t.groupNode(id); n != nil && !t.covers(n) {
			return nil, fmt.Errorf("group %s does not cover one rectangle of the grid", id)
		}
	}
	if len(t.roots) > 0 {
		if err := t.readLines(state); err != nil {
			return nil, err
		}
	}
	if err := t.readLast(lastCard, seen); err != nil {
		return nil, err
	}
	return t, nil
}

// readLines refuses a paidBy record and a line that no card uses in a layout with groups.
func (t *GroupTree) readLines(state State) error {
	if len(state.PaidBy) > 0 {
		ids := slices.Sorted(maps.Keys(state.PaidBy))
		return fmt.Errorf("layout with groups stores the paidBy record of card %s; a layout with groups keeps none", ids[0])
	}
	for _, axis := range axes {
		for k := 1; k < len(t.grid.arr(axis))-1; k++ {
			if t.grid.IsVirtual(axis, k) {
				return fmt.Errorf("layout with groups stores the %s line %d, which no card uses; a layout with groups keeps none", axis, k)
			}
		}
	}
	return nil
}

// readNode reads one stored group card.
func (t *GroupTree) readNode(raw json.RawMessage, seen, content, held map[string]bool) (*node, error) {
	refused := fmt.Errorf("layout stores the group %s, which is not {card, name, leader, members}", compact(raw))
	fields, keys, ok := object(raw)
	if !ok || len(keys) != 4 {
		return nil, refused
	}
	var id string
	members, listed := list(fields["members"])
	_, hasLeader := fields["leader"]
	_, hasName := fields["name"]
	if jsonKind(fields["card"]) != '"' || json.Unmarshal(fields["card"], &id) != nil || !listed || !hasLeader || !hasName {
		return nil, refused
	}
	var name string
	if jsonKind(fields["name"]) != '"' || json.Unmarshal(fields["name"], &name) != nil || utf8.RuneCountInString(name) < 1 ||
		utf8.RuneCountInString(name) > 40 || strings.TrimSpace(name) != name {
		return nil, fmt.Errorf("group %s stores the name %s, which is not 1 to 40 characters", id, compact(fields["name"]))
	}
	if seen[id] {
		return nil, fmt.Errorf("card %s is stored twice", id)
	}
	seen[id] = true
	if len(members) < 2 {
		return nil, fmt.Errorf("group %s holds fewer than two cards", id)
	}
	n := &node{card: id, group: true, name: name}
	for _, member := range members {
		if jsonKind(member) != '"' {
			inner, err := t.readNode(member, seen, content, held)
			if err != nil {
				return nil, err
			}
			n.members = append(n.members, inner)
			continue
		}
		var card string
		if err := json.Unmarshal(member, &card); err != nil {
			return nil, refused
		}
		if IsWindowSide(card) {
			return nil, fmt.Errorf("group %s holds the window sidebar %s", id, card)
		}
		if !content[card] {
			return nil, fmt.Errorf("group %s holds %s, which is not a content card of the layout", id, compact(member))
		}
		if held[card] {
			return nil, fmt.Errorf("card %s is stored twice", card)
		}
		held[card] = true
		n.members = append(n.members, &node{card: card})
	}
	lead, err := readLeader("group "+id, fields["leader"], n.members)
	if err != nil {
		return nil, err
	}
	n.leader = lead
	return n, nil
}

// readLeader reads the stored leader of the level label among its members.
func readLeader(label string, raw json.RawMessage, members []*node) (string, error) {
	lead := slices.ContainsFunc(members, func(n *node) bool { return !IsWindowSide(n.card) })
	if raw == nil || jsonKind(raw) == 'n' {
		if lead || raw == nil {
			return "", fmt.Errorf("level %s has no leader", label)
		}
		return "", nil
	}
	var leader string
	if jsonKind(raw) != '"' || json.Unmarshal(raw, &leader) != nil ||
		!slices.ContainsFunc(members, func(n *node) bool { return n.card == leader }) {
		return "", fmt.Errorf("level %s names the leader %s, which is not a member of that level", label, strings.Trim(compact(raw), `"`))
	}
	if IsWindowSide(leader) {
		return "", fmt.Errorf("level %s names the window sidebar %s as its leader", label, leader)
	}
	return leader, nil
}

// readLeader reads the stored leader of the root level.
func (t *GroupTree) readLeader(raw json.RawMessage) error {
	lead, err := readLeader("root", raw, t.level(""))
	t.leader = lead
	return err
}

// readLast reads lastCard: a positive integer at least the number of every card id of the layout.
func (t *GroupTree) readLast(raw json.RawMessage, seen map[string]bool) error {
	refused := fmt.Errorf("layout stores lastCard %s, which is not the largest issued card number", compact(raw))
	var last float64
	if raw == nil || jsonKind(raw) != '0' || json.Unmarshal(raw, &last) != nil || last < 1 || last != math.Trunc(last) || last > math.MaxInt32 {
		return refused
	}
	for id := range seen {
		if n, ok := CardNumber(id); ok && n > int(last) {
			return refused
		}
	}
	t.last = int(last)
	return nil
}
