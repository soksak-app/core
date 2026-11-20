package layout

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
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

// GroupOptions are the sizes that the tree draws with: the head height of a group card, and whether the cards share one line at the
// seam, where a frame and a header take no gap (docs/spec/groups.md#drawn-rectangles).
type GroupOptions struct {
	Head float64
	Seam bool
}

// GroupTree is the grid of one space with its group tree.
type GroupTree struct {
	grid  *Grid
	head  float64
	seam  bool
	roots []*node
	// leader is the leader of the root level, or "" while the root level holds only window sidebars.
	leader string
	// last is the largest card number that the space issued (lastCard).
	last int
	// probes is the number of trial operations that Probe ran.
	probes int
	// answers holds the answers of CanSplit, CanGroup and CanClose for the layout that answersToken describes, so the headers of a
	// draw without a layout change run no trial operation.
	answers      map[string]bool
	answersToken string
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
	return &GroupTree{grid: grid, head: options.Head, seam: options.Seam, leader: leader, last: last}
}

// Grid is the grid of the space.
func (t *GroupTree) Grid() *Grid { return t.grid }

// Head is the head height of a group card.
func (t *GroupTree) Head() float64 { return t.head }

// SetHead changes the head height of a group card. It changes no arrangement.
func (t *GroupTree) SetHead(head float64) { t.head = head }

// SetSeam changes whether the cards share one line, and gives the grid the frames of that drawing. It changes no arrangement.
func (t *GroupTree) SetSeam(seam bool) {
	t.seam = seam
	t.reframe()
}

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
		// The leader of a group card is in the data of its box.
		t.grid.SetData(key, boxData(n.name, n.leader))
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

// SetData sets the data of the content card id; the data of the box of a group card is its name and its leader, which no caller sets.
func (t *GroupTree) SetData(id string, data json.RawMessage) bool {
	return !t.IsGroup(id) && t.grid.SetData(id, data)
}

// Rect is the drawn rectangle of the card id (docs/spec/groups.md#drawn-rectangles): for a content card its rectangle in the grid, for
// a group card its frame, the rectangle of its box, each moved down and shortened by the headers of the group cards that hold it and
// start on its first row line.
func (t *GroupTree) Rect(id string) (Rect, bool) {
	if _, _, ok := t.find(id); !ok {
		return Rect{}, false
	}
	rect, ok := t.grid.Rect(id)
	k := t.grid.HeadsAbove(id)
	rect.Y += k
	rect.H -= k
	return rect, ok
}

// headStep is how far one header moves the boxes below it down: the header and the corridor that separates it from them, as between
// two cards, and the header alone at the seam, where its bottom line is the line between them (docs/spec/groups.md#drawn-rectangles).
func (t *GroupTree) headStep() float64 {
	if t.seam {
		return t.head
	}
	return t.head + t.grid.Gap()
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
	if err := t.grid.Replace(s.state); err != nil {
		panic("soksak: a snapshot of the grid was refused: " + err.Error())
	}
	t.roots, t.leader, t.last = copyNodes(s.roots), s.leader, s.last
	t.reframe()
}

// reframe gives the grid the head of every group card (docs/spec/groups.md#drawn-rectangles): the header of a group card and the
// corridor below it, which the library lays inside the top of its box. The library derives the frames from the boxes of the tree: one
// corridor on each side but the top, and none at the seam (frames none), where the corridor is the one border line that two boxes share.
func (t *GroupTree) reframe() {
	heads := map[string]float64{}
	var walk func(n *Node)
	walk = func(n *Node) {
		if n.Box != "" {
			heads[n.Box] = t.headStep()
			walk(n.Inner)
		}
		for _, kid := range n.Kids {
			walk(kid.Node)
		}
	}
	if root := t.grid.ToJSON().Root; root != nil {
		walk(root)
	}
	mode := "corridor"
	if t.seam {
		mode = "none"
	}
	if err := t.grid.SetFrames(mode); err != nil {
		panic("soksak: " + err.Error())
	}
	if err := t.grid.SetHeads(heads); err != nil {
		panic("soksak: the heads of the boxes of the grid were refused: " + err.Error())
	}
}

// Probes is the number of trial operations that Probe ran: an answer of CanSplit, CanGroup or CanClose that the tree kept runs none.
func (t *GroupTree) Probes() int { return t.probes }

// Probe runs change on the tree and puts the tree back, and returns what change returned: the drop preview asks what a drop would
// make without making it.
func (t *GroupTree) Probe(change func() error) error {
	t.probes++
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

// keepLines gives the grid the heads of the group cards after an operation (docs/spec/groups.md#model).
func (t *GroupTree) keepLines() {
	t.reframe()
}

// boxData is the data {name, leader} of the box of a group card.
func boxData(name, leader string) json.RawMessage {
	return json.RawMessage(`{"name":` + strconv.Quote(name) + `,"leader":` + strconv.Quote(leader) + `}`)
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

func idSet(ids []string) map[string]bool {
	out := map[string]bool{}
	for _, id := range ids {
		out[id] = true
	}
	return out
}

// splitRect splits the rectangle of the group node toward side: the new card id with data stands beside its box toward side, added to the
// cut that holds the box as insert of the layout library adds a card (docs/spec/groups.md#commands), so the tree inside the box stays.
func (t *GroupTree) splitRect(n *node, side Side, id string, data json.RawMessage, op string) error {
	return t.insert(n.card, op, Target{n.card}, side, &Node{Card: id, Data: data})
}

// addInto puts the new card id with data into the group node at the right edge of its rectangle: beside the members of its box toward
// right, added to the inner node of the box as insert adds a card, so the tree of the members stays.
func (t *GroupTree) addInto(n *node, id string, data json.RawMessage) error {
	members := Target{}
	for _, m := range n.members {
		members = append(members, m.card)
	}
	return t.insert(n.card, "split toward right", members, "right", &Node{Card: id, Data: data})
}

// insert is Insert of the grid inside the operation op of the card id: its refusal, which names the deepest node that the insert would
// draw below its minimum, is the refusal of the operation (docs/spec/groups.md#commands).
func (t *GroupTree) insert(id, op string, target Target, side Side, node *Node) error {
	if _, err := t.grid.Insert(target, side, node); err != nil {
		return fmt.Errorf("card %s cannot %s: %w", id, op, err)
	}
	return nil
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
// (docs/spec/groups.md#closing), and its box gives its place to the member. It returns the member, or key.
func (t *GroupTree) collapse(key string) (string, error) {
	n := t.groupNode(key)
	if n == nil || len(n.members) != 1 {
		return key, nil
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
	if err := t.grid.Unwrap(key); err != nil {
		return "", err
	}
	return sole.card, nil
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
// split of its rectangle for a group card. A split toward top or bottom whose upper card is drawn below headers cuts at a new line
// (docs/spec/groups.md#splitting). The refusal of the layout, which names the deepest node that the split would draw below its minimum,
// is the refusal of the operation.
func (t *GroupTree) splitCard(target string, side Side, id string, data json.RawMessage) error {
	if n := t.groupNode(target); n != nil {
		return t.splitRect(n, side, id, data, "split toward "+side)
	}
	fresh := false
	if axisOf(side) == "y" {
		drawn, _ := t.Rect(target) // silent: requireCard found the card.
		grid, _ := t.grid.Rect(target)
		fresh = drawn.Y > grid.Y
	}
	if _, err := t.grid.SplitToward(target, side, SplitInit{ID: &id, Data: data, NewLine: fresh}); err != nil {
		return fmt.Errorf("card %s cannot split toward %s: %w", target, side, err)
	}
	return nil
}

// level moves the line between the card target and the new card id of a split toward top or bottom, so that both are drawn at one
// height below the headers that the upper one stands under (docs/spec/groups.md#splitting). A split across does not change it.
func (t *GroupTree) levelSplit(target string, side Side, id string) {
	if axisOf(side) != "y" {
		return
	}
	// The new card takes the frames of its level first, so both drawn heights are the heights that the check of the split reads.
	t.reframe()
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
	// A line that other cards stand on stays, so that a split moves no line of another card.
	pieces := idSet(append(t.inside(t.nodeOf(upper)), t.inside(n)...))
	for _, card := range t.grid.Cards() {
		if (card.R0 == line || card.R1 == line) && !pieces[card.ID] {
			return
		}
	}
	if delta := (down.H - up.H) / 2; math.Abs(delta) > eps {
		t.grid.MoveBoundary("y", line, t.grid.BoundaryPos("y", line)+delta, false)
	}
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

// CreateGroup groups the card id with a new content card with data toward side, and returns the group card and the new card.
func (t *GroupTree) CreateGroup(id string, side Side, data json.RawMessage) (string, string, error) {
	if err := t.CheckGroup(id, side); err != nil {
		return "", "", err
	}
	var group, born string
	err := t.try(id, "hold a group toward "+side, func() error {
		name := t.groupName()
		group, born = t.issue(), t.issue()
		// The group split is one operation of the layout, judged on the box with its head (docs/spec/groups.md#commands).
		box := GroupInit{Box: group, Data: boxData(name, id), Head: t.headStep()}
		if err := t.grid.Group(id, side, &Node{Card: born, Data: data}, box); err != nil {
			return fmt.Errorf("card %s cannot hold a group toward %s: %w", id, side, err)
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
		return nil
	})
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
	if err := t.grid.Unwrap(id); err != nil {
		return err
	}
	t.reframe()
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
	t.grid.SetData(id, boxData(n.name, n.leader))
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
// group that holds the card, and the new card of a group card joins the level that holds the group card.
func (t *GroupTree) Split(id string, side Side, data json.RawMessage) (string, error) {
	if !isSide(side) {
		return "", fmt.Errorf("unknown side %s; use left, right, top or bottom", side)
	}
	if err := t.requireCard(id); err != nil {
		return "", err
	}
	var born string
	err := t.try(id, "split toward "+side, func() error {
		born = t.issue()
		if err := t.splitCard(id, side, born, data); err != nil {
			return err
		}
		t.attach(t.Parent(id), &node{card: born})
		t.levelSplit(id, side, born)
		return nil
	})
	if err != nil {
		return "", err
	}
	return born, nil
}

// SplitBeside puts a new content card with data beside target toward side and returns its id: the split of one card, or the insert of
// the layout library beside the cut or the run of neighbouring kids that the ids name, whose new card joins the level of those kids
// (docs/spec/groups.md#moving-and-dropping).
func (t *GroupTree) SplitBeside(target Target, side Side, data json.RawMessage) (string, error) {
	if len(target) == 1 {
		return t.Split(target[0], side, data)
	}
	if !isSide(side) {
		return "", fmt.Errorf("unknown side %s; use left, right, top or bottom", side)
	}
	if len(target) == 0 {
		return "", errors.New("a split names no card")
	}
	for _, id := range target {
		if err := t.requireCard(id); err != nil {
			return "", err
		}
	}
	names := strings.Join(target, ", ")
	var born string
	err := t.try(target[0], "split toward "+side, func() error {
		born = t.issue()
		if _, err := t.grid.Insert(target, side, &Node{Card: born, Data: data}); err != nil {
			return fmt.Errorf("cards %s cannot split toward %s: %w", names, side, err)
		}
		t.attach(t.Parent(target[0]), &node{card: born})
		return nil
	})
	if err != nil {
		return "", err
	}
	return born, nil
}

// CanSplit tells whether Split of the card id toward side would succeed.
func (t *GroupTree) CanSplit(id string, side Side) bool {
	return t.answer("split:"+id+":"+string(side), func() error {
		_, err := t.Split(id, side, nil)
		return err
	})
}

// answer is the kept answer of key for the current layout, or whether the trial operation change succeeds, which it keeps.
func (t *GroupTree) answer(key string, change func() error) bool {
	token := t.layoutToken()
	if token != t.answersToken || t.answers == nil {
		t.answers, t.answersToken = map[string]bool{}, token
	}
	if known, ok := t.answers[key]; ok {
		return known
	}
	ok := t.Probe(change) == nil
	// An answer asked inside the trial operation describes the layout of that trial and replaced the kept answers.
	if t.answersToken != token {
		t.answers, t.answersToken = map[string]bool{}, token
	}
	t.answers[key] = ok
	return ok
}

// layoutToken describes everything that an answer of CanSplit, CanGroup or CanClose reads: the lines, the cards with their spans and
// sizes, the size, gap, minimum size, head and seam of the plane, and the group cards with their members.
func (t *GroupTree) layoutToken() string {
	g := t.grid
	var b strings.Builder
	fmt.Fprintf(&b, "%v|%v|%v|%v|%v|%v|%v|%v|", g.xs, g.ys, g.w, g.h, g.gap, g.min, t.head, t.seam)
	size := func(px *float64) string {
		if px == nil {
			return "-"
		}
		return strconv.FormatFloat(*px, 'g', -1, 64)
	}
	for _, c := range g.list {
		fmt.Fprintf(&b, "%s:%d,%d,%d,%d,%s,%s,%t;", c.ID, c.C0, c.C1, c.R0, c.R1, size(c.Width), size(c.Height), c.Fixed)
	}
	var nodes func([]*node)
	nodes = func(level []*node) {
		for _, n := range level {
			b.WriteString(n.card)
			if n.group {
				b.WriteByte('(')
				nodes(n.members)
				b.WriteByte(')')
			}
			b.WriteByte(',')
		}
	}
	nodes(t.roots)
	return b.String()
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
		if err := t.addInto(n, born, data); err != nil {
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
		if t.groupNode(id) != nil {
			// A group card leaves as its box with every card inside it, so the tree around it stays as it is.
			if !t.grid.Close(id) {
				return fmt.Errorf("card %s cannot close: no kid of its cut can grow", id)
			}
		} else if err := t.closeCell(id, "close"); err != nil {
			return err
		}
		_, err := t.collapse(t.detach(id))
		return err
	})
	if err != nil {
		return nil, err
	}
	return closed, nil
}

// closeCell closes the card id of the grid for the operation op: its node, the card or the box around it that holds nothing else, leaves
// its cut, and the other kids of the cut that are no fixed card take its share by one factor (R7). The refusal names the cause
// (docs/spec/groups.md#closing).
func (t *GroupTree) closeCell(id, op string) error {
	refused := func(why string) error { return fmt.Errorf("card %s cannot %s: %s", id, op, why) }
	free := 0
	for _, card := range t.grid.Cards() {
		if !card.Fixed {
			free++
		}
	}
	if card, _ := t.grid.Card(id); card.Fixed || free <= 1 { // silent: requireCard found the card.
		return refused("it is the last card of the layout")
	}
	if t.grid.Close(id) {
		return nil
	}
	return refused("no kid of its cut can grow")
}

// CanClose tells whether Close of the card id would succeed.
func (t *GroupTree) CanClose(id string) bool {
	return t.answer("close:"+id, func() error {
		_, err := t.Close(id)
		return err
	})
}

// CheckMove is the refusal of a move of the card id to side of target before the layout is asked, or nil
// (docs/spec/groups.md#commands).
func (t *GroupTree) CheckMove(id string, target Target, side string) error {
	if IsWindowSide(id) {
		return fmt.Errorf("card %s is a window sidebar and does not move", id)
	}
	if err := t.requireCard(id); err != nil {
		return err
	}
	if len(target) == 0 {
		return fmt.Errorf("card %s cannot move beside no card", id)
	}
	for _, card := range target {
		if IsWindowSide(card) {
			return fmt.Errorf("card %s is a window sidebar; a card does not move beside it", card)
		}
		if err := t.requireCard(card); err != nil {
			return err
		}
	}
	if !slices.ContainsFunc(target, func(card string) bool { return card != id && !slices.Contains(t.Groups(card), id) }) {
		return fmt.Errorf("card %s cannot move into itself", id)
	}
	if side == "centre" && (len(target) > 1 || !t.IsGroup(target[0])) {
		return fmt.Errorf("card %s is not a group; a card moves beside it", strings.Join(target, ", "))
	}
	if side != "centre" && !isSide(side) {
		return fmt.Errorf("unknown side %s; use left, right, top, bottom or centre", side)
	}
	return nil
}

// Moved tells whether the card id already stands where a move to side of target puts it.
func (t *GroupTree) Moved(id string, at Target, side string) bool {
	if len(at) != 1 {
		return false
	}
	target := at[0]
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
func (t *GroupTree) Move(id string, target Target, side string) error {
	if err := t.CheckMove(id, target, side); err != nil {
		return err
	}
	if t.Moved(id, target, side) {
		return nil
	}
	op := "move to " + side + " of " + strings.Join(target, ", ")
	// The target is the node after the withdraw of the moving card (docs/spec/groups.md#target-search): a cut or a run that holds the
	// moving card names the kids that remain.
	target = slices.DeleteFunc(slices.Clone(target), func(card string) bool { return card == id || slices.Contains(t.Groups(card), id) })
	return t.try(id, op, func() error {
		moving := t.nodeOf(id)
		// A move is a withdraw and an insert: the card or the box of the group card leaves its cut, whose other kids take its space in
		// proportion, and lands beside the target, or with centre at the right edge of the tree of the group card target
		// (docs/spec/groups.md#closing).
		left, err := t.grid.Withdraw(id)
		if err != nil {
			return fmt.Errorf("card %s cannot %s: %w", id, op, err)
		}
		// The card leaves the group tree before the insert, so the insert measures every card with the heads that it is drawn with.
		into, at, toward := t.Parent(target[0]), target, Side(side)
		from := t.detach(id)
		t.reframe()
		if side == "centre" {
			into, at, toward = target[0], Target{}, "right"
			for _, member := range t.Members(target[0]) {
				if member != id {
					at = append(at, member)
				}
			}
		}
		if _, err := t.grid.Insert(at, toward, left); err != nil {
			return fmt.Errorf("card %s cannot %s: %w", id, op, err)
		}
		// The group that the card leaves is replaced by its one member after the insert, so a move beside that group lands beside it
		// and the member takes its place.
		t.attach(into, moving)
		_, err = t.collapse(from)
		return err
	})
}

// balance gives every child of every cut an equal share, with each group card as a box of the layout library (Grid.Even); in a space
// without groups, arrange runs the even arrangement of the library instead
// (cardArrange even), which refuses when no equal grid keeps every card at its minimum size and raises lastCard to the empty card that it
// adds (docs/spec/groups.md#card-commands-on-a-group-card).
func (t *GroupTree) balance(arrange bool) error {
	if len(t.roots) == 0 && arrange {
		arranged, err := t.grid.Arrange("even")
		if err != nil {
			return err
		}
		if !arranged {
			return errors.New("the layout cannot balance: no equal grid keeps every card at its minimum size")
		}
		for _, card := range t.grid.Cards() {
			if n, ok := CardNumber(card.ID); ok {
				t.last = max(t.last, n)
			}
		}
		return nil
	}
	// The frames follow the tree first, so the drawn rectangles that the balance measures are the ones that the space draws after it.
	t.reframe()
	heads := map[string]float64{}
	for _, id := range t.Cards() {
		if t.IsGroup(id) {
			heads[id] = t.headStep()
		}
	}
	if err := t.grid.SetHeads(heads); err != nil {
		return err
	}
	if err := t.grid.Even(); err != nil {
		return fmt.Errorf("the layout cannot balance: %w", err)
	}
	return nil
}

// Balance balances the grid (docs/spec/groups.md#card-commands-on-a-group-card) and keeps the result only when no content card that it
// changed is drawn below minSize; arrange is as for balance.
func (t *GroupTree) Balance(arrange bool) error {
	before := t.drawn()
	kept := t.snapshot()
	if err := t.balance(arrange); err != nil {
		t.restore(kept)
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

// CenterBoundary centres the boundary line of axis between its neighbours, as Grid.CenterBoundary does, and merges it onto a line
// that it reaches, so that no two lines stand at one coordinate. It keeps the line where it stands when a content card beside it would
// be drawn below minSize. It returns where the boundary stands.
func (t *GroupTree) CenterBoundary(axis Axis, line int) float64 {
	before := t.drawn()
	kept := t.snapshot()
	at := t.grid.CenterBoundary(axis, line)
	t.keepLines()
	if card, _ := t.below(before); card != "" {
		t.restore(kept)
		return t.grid.BoundaryPos(axis, line)
	}
	return at
}

// MoveBoundaryTo moves the boundary line of axis toward px as a drag that ends there does: it moves the line as MoveBoundary does and
// then merges it onto a line that it reached, so that core.boundary.move and the pointer drag give one result. It returns where the
// boundary stands.
func (t *GroupTree) MoveBoundaryTo(axis Axis, line int, px float64) float64 {
	at := t.MoveBoundary(axis, line, px, false)
	t.MergeCoincident(axis, line)
	return at
}

// MergeCoincident ends a drag of the boundary line of axis and keeps no line that no card uses while the space holds a group card. It
// reports false: the grid holds a line at a coordinate once, so a boundary that reached a neighbour is already one line with it.
func (t *GroupTree) MergeCoincident(axis Axis, line int) bool {
	t.keepLines()
	return false
}

// Focusable is the content card that a focus of the card id gives: the card itself, or for a group card the first content card
// inside it in workbench order.
func (t *GroupTree) Focusable(id string) string {
	if inside := t.ContentInside(id); len(inside) > 0 {
		return inside[0]
	}
	return id
}

// CanGroup tells whether the group split button of the card id toward side is enabled: a group of the card and a new card toward side
// would succeed (docs/spec/groups.md#headers).
func (t *GroupTree) CanGroup(id string, side Side) bool {
	return t.answer("group:"+id+":"+string(side), func() error {
		_, _, err := t.CreateGroup(id, side, nil)
		return err
	})
}

// Fullscreen is the rectangle of each card inside the group card id while it is shown across rect, laid out as if the group card were
// the whole space (docs/spec/groups.md#card-commands-on-a-group-card): its frame is rect, the lines inside it are stretched onto rect
// while every corridor and frame keeps the gap, and each card inside it stands below the headers of the group cards between it and id
// that start on its first row line.
func (t *GroupTree) Fullscreen(id string, rect Rect) map[string]Rect {
	box := t.boxOf(t.grid.ToJSON().Root, id)
	if box == nil {
		return nil
	}
	// The box is laid as the root of a plane of the size of rect with the options, the frames and the heads of the grid.
	gap, minimum, w, h := t.grid.Gap(), t.grid.MinSize(), rect.W, rect.H
	plane, err := New(&State{Root: box}, Options{Gap: &gap, MinSize: &minimum, Width: &w, Height: &h})
	if err != nil {
		panic("soksak: the box of group " + id + " was refused as a state: " + err.Error())
	}
	if err := plane.SetFrames(t.grid.Frames()); err != nil {
		panic("soksak: " + err.Error())
	}
	heads := map[string]float64{}
	for _, card := range t.Cards() {
		if t.IsGroup(card) && t.boxOf(box, card) != nil {
			heads[card] = t.headStep()
		}
	}
	if err := plane.SetHeads(heads); err != nil {
		panic("soksak: " + err.Error())
	}
	out := map[string]Rect{id: rect}
	for card := range heads {
		if card != id {
			r, _ := plane.Rect(card) // silent: the plane holds the box.
			out[card] = t.onto(rect, r, plane.HeadsAbove(card))
		}
	}
	for _, card := range plane.Cards() {
		r, _ := plane.Rect(card.ID) // silent: the plane holds the card.
		out[card.ID] = t.onto(rect, r, plane.HeadsAbove(card.ID))
	}
	return out
}

// onto is the rectangle r of a plane laid at the origin, moved onto rect and below the heads drawn inside its top.
func (t *GroupTree) onto(rect, r Rect, heads float64) Rect {
	return Rect{X: rect.X + r.X, Y: rect.Y + r.Y + heads, W: r.W, H: r.H - heads}
}

// boxOf is the box id inside the node n, or nil.
func (t *GroupTree) boxOf(n *Node, id string) *Node {
	if n == nil {
		return nil
	}
	if n.Box == id {
		return n
	}
	if n.Box != "" {
		return t.boxOf(n.Inner, id)
	}
	for _, kid := range n.Kids {
		if found := t.boxOf(kid.Node, id); found != nil {
			return found
		}
	}
	return nil
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

// Stored is the stored form of the layout (docs/spec/groups.md#storage): the tree of the grid with the group cards as boxes, the leader of
// the root level, or nil, and lastCard.
func (t *GroupTree) Stored() (State, *string, int) {
	var leader *string
	if t.leader != "" {
		lead := t.leader
		leader = &lead
	}
	return t.grid.ToJSON(), leader, t.last
}

// ReportedMembers is the members of the group card id as core.card.get reports them: each content card by its id, and each group card
// as {card, name, level, leader, members}.
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

// ReadTree reads the stored layout of a space: the tree of the grid with its group cards as boxes, the leader of the root level and
// lastCard as stored, each refused with the text of docs/spec/groups.md#storage; groups is the group list of the earlier form, which is
// refused. A member that is absent is nil.
func ReadTree(stored State, groups, leader, lastCard json.RawMessage, options GroupOptions, grid *Grid) (*GroupTree, error) {
	if err := CheckState(stored); err != nil {
		return nil, err
	}
	if groups != nil {
		return nil, errors.New("layout stores groups, the group list of the earlier form; the group cards are boxes of state")
	}
	if err := grid.Replace(stored); err != nil {
		return nil, err
	}
	t := &GroupTree{grid: grid, head: options.Head, seam: options.Seam}
	seen := map[string]bool{}
	level, err := t.readLevel(grid.root, seen)
	if err != nil {
		return nil, err
	}
	for _, n := range level {
		if n.group {
			t.roots = append(t.roots, n)
		}
	}
	if err := t.readLeader(leader); err != nil {
		return nil, err
	}
	if err := t.readLast(lastCard, seen); err != nil {
		return nil, err
	}
	t.reframe()
	return t, nil
}

// readLevel reads the members of a level from its node: the cards and the boxes that no box inside it holds, each box a group card
// with the members of its inner node. Every id goes into seen.
func (t *GroupTree) readLevel(n *Node, seen map[string]bool) ([]*node, error) {
	switch {
	case n.isCut():
		out := []*node{}
		for _, kid := range n.Kids {
			members, err := t.readLevel(kid.Node, seen)
			if err != nil {
				return nil, err
			}
			out = append(out, members...)
		}
		return out, nil
	case !n.isBox():
		seen[n.Card] = true
		return []*node{{card: n.Card}}, nil
	}
	id := n.Box
	seen[id] = true
	fields, keys, ok := object(n.Data)
	if !ok || len(keys) != 2 || fields["name"] == nil || fields["leader"] == nil {
		return nil, fmt.Errorf("layout stores the group %s with the data %s, which is not {name, leader}", id, compact(n.Data))
	}
	var name string
	if jsonKind(fields["name"]) != '"' || json.Unmarshal(fields["name"], &name) != nil || utf8.RuneCountInString(name) < 1 ||
		utf8.RuneCountInString(name) > 40 || strings.TrimSpace(name) != name {
		return nil, fmt.Errorf("group %s stores the name %s, which is not 1 to 40 characters", id, compact(fields["name"]))
	}
	members, err := t.readLevel(n.Inner, seen)
	if err != nil {
		return nil, err
	}
	for _, m := range members {
		if IsWindowSide(m.card) {
			return nil, fmt.Errorf("group %s holds the window sidebar %s", id, m.card)
		}
	}
	if !n.Inner.isCut() {
		return nil, fmt.Errorf("group %s holds fewer than two cards", id)
	}
	group := &node{card: id, group: true, name: name, members: members}
	if group.leader, err = readLeader("group "+id, fields["leader"], members); err != nil {
		return nil, err
	}
	return []*node{group}, nil
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
