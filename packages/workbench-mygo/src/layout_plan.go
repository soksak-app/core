package workbench

import (
	"bytes"
	"encoding/json"
	"fmt"
	"maps"
	"math"
	"reflect"
	"regexp"
	"slices"
	"sort"
	"strconv"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The plan of an arrangement (docs/spec/cli.md#planning-an-arrangement): the request tree, its reading order, the resolution of its
// entries against the tabs of the plane, the most even grid of a count, and the judgement of the frames that the operations of the size
// rule of the layout library build. It answers as packages/workbench/layout-plan.js answers for the page.

// planNode is a node of a request tree: a split {direction, children}, or a card {tabs, active}.
type planNode struct {
	Direction string
	Children  []*planNode
	Tabs      []planEntry
	Active    int
}

// planEntry is an entry of a card: an existing tab {tab}, or a tab {plugin, params} of the plugin with the params, nil for null.
type planEntry struct {
	Tab    string
	Plugin string
	Params json.RawMessage
}

// MarshalJSON writes a split as {direction, children} and a card as {tabs, active}.
func (n *planNode) MarshalJSON() ([]byte, error) {
	if n.Direction != "" {
		return json.Marshal(struct {
			Direction string      `json:"direction"`
			Children  []*planNode `json:"children"`
		}{n.Direction, n.Children})
	}
	return json.Marshal(struct {
		Tabs   []planEntry `json:"tabs"`
		Active int         `json:"active"`
	}{n.Tabs, n.Active})
}

// MarshalJSON writes an existing tab as {tab} and a new tab as {plugin, params}.
func (e planEntry) MarshalJSON() ([]byte, error) {
	if e.Tab != "" {
		return json.Marshal(map[string]string{"tab": e.Tab})
	}
	return json.Marshal(struct {
		Plugin string          `json:"plugin"`
		Params json.RawMessage `json:"params"`
	}{e.Plugin, nullJSON(e.Params)})
}

// nullJSON is text, or null for no text.
func nullJSON(text json.RawMessage) json.RawMessage {
	if len(text) == 0 {
		return json.RawMessage("null")
	}
	return text
}

// unknownMember is the first member of value in code point order that known does not name, or "".
func unknownMember(value map[string]any, known ...string) string {
	var extra []string
	for key := range value {
		if !slices.Contains(known, key) {
			extra = append(extra, key)
		}
	}
	sort.Strings(extra)
	if len(extra) == 0 {
		return ""
	}
	return extra[0]
}

// readPlanTree reads a request tree, or fails with the reason in the form `tree<path>: <reason>`.
func readPlanTree(value any, path string) (*planNode, error) {
	object, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("tree%s must be an object", path)
	}
	if _, split := object["direction"]; split {
		if extra := unknownMember(object, "direction", "children"); extra != "" {
			return nil, fmt.Errorf("tree%s has the unknown member %s", path, extra)
		}
		direction, _ := object["direction"].(string) // silent: a direction that is no string is none of the two, refused below.
		if direction != "row" && direction != "column" {
			return nil, fmt.Errorf("tree%s.direction must be row or column", path)
		}
		children, ok := object["children"].([]any)
		if !ok || len(children) < 2 {
			return nil, fmt.Errorf("tree%s.children must hold at least two nodes", path)
		}
		node := &planNode{Direction: direction}
		for index, child := range children {
			inner, err := readPlanTree(child, fmt.Sprintf("%s.children[%d]", path, index))
			if err != nil {
				return nil, err
			}
			if inner.Direction == direction {
				return nil, fmt.Errorf("tree%s.children[%d] is a %s inside a %s", path, index, direction, direction)
			}
			node.Children = append(node.Children, inner)
		}
		return node, nil
	}
	if extra := unknownMember(object, "tabs", "active"); extra != "" {
		return nil, fmt.Errorf("tree%s has the unknown member %s", path, extra)
	}
	tabs, ok := object["tabs"].([]any)
	if !ok || len(tabs) == 0 {
		return nil, fmt.Errorf("tree%s.tabs must be a non-empty list", path)
	}
	active := 0
	if raw, present := object["active"]; present {
		number, ok := raw.(json.Number)
		value, err := number.Float64()
		if !ok || err != nil || value != math.Trunc(value) || value < 0 || value >= float64(len(tabs)) {
			return nil, fmt.Errorf("tree%s.active must be an index of tabs", path)
		}
		active = int(value)
	}
	node := &planNode{Active: active}
	for index, entry := range tabs {
		read, err := readPlanEntry(entry, fmt.Sprintf("%s.tabs[%d]", path, index))
		if err != nil {
			return nil, err
		}
		node.Tabs = append(node.Tabs, read)
	}
	return node, nil
}

// readPlanEntry reads an entry {tab} or {plugin, params?}; an omitted params is null.
func readPlanEntry(value any, path string) (planEntry, error) {
	object, ok := value.(map[string]any)
	if !ok {
		return planEntry{}, fmt.Errorf("tree%s must be an object", path)
	}
	if raw, named := object["tab"]; named {
		tab, ok := raw.(string)
		if len(object) != 1 || !ok || tab == "" {
			return planEntry{}, fmt.Errorf("tree%s must be {tab} with a tab identifier", path)
		}
		return planEntry{Tab: tab}, nil
	}
	if extra := unknownMember(object, "plugin", "params"); extra != "" {
		return planEntry{}, fmt.Errorf("tree%s has the unknown member %s", path, extra)
	}
	plugin, ok := object["plugin"].(string)
	if !ok || plugin == "" {
		return planEntry{}, fmt.Errorf("tree%s must be {tab} or {plugin, params?}", path)
	}
	entry := planEntry{Plugin: plugin}
	if params := object["params"]; params != nil {
		if _, ok := params.(map[string]any); !ok {
			return planEntry{}, fmt.Errorf("tree%s.params must be an object", path)
		}
		text, err := json.Marshal(params)
		if err != nil {
			return planEntry{}, err
		}
		entry.Params = text
	}
	return entry, nil
}

// planLeaves is the cards of a tree in tree order.
func planLeaves(tree *planNode) []*planNode {
	if tree.Direction == "" {
		return []*planNode{tree}
	}
	var out []*planNode
	for _, child := range tree.Children {
		out = append(out, planLeaves(child)...)
	}
	return out
}

// planReadingOrder is the indices of the cards of a tree in reading order: by the top and then the left edge of their planned frames. A
// child of an equal share starts at k (size + corridor) / n of its split, so the order of the edges does not depend on the corridors,
// and the tree gives it in a plane of one by one without corridors; edges within a millionth are one edge.
func planReadingOrder(tree *planNode) []int {
	type corner struct{ x, y float64 }
	var corners []corner
	var walk func(node *planNode, x, y, width, height float64)
	walk = func(node *planNode, x, y, width, height float64) {
		if node.Direction == "" {
			corners = append(corners, corner{x, y})
			return
		}
		n := float64(len(node.Children))
		for k, child := range node.Children {
			if node.Direction == "row" {
				walk(child, x+float64(k)*width/n, y, width/n, height)
			} else {
				walk(child, x, y+float64(k)*height/n, width, height/n)
			}
		}
	}
	walk(tree, 0, 0, 1, 1)
	order := make([]int, len(corners))
	for index := range order {
		order[index] = index
	}
	sort.SliceStable(order, func(i, j int) bool {
		a, b := corners[order[i]], corners[order[j]]
		if math.Abs(a.y-b.y) > 1e-6 {
			return a.y < b.y
		}
		return a.x < b.x
	})
	return order
}

// planGrid is the tree of count cards in rows rows: each row holds count / rows cards rounded down or up, the larger rows first.
func planGrid(count, rows int, entry planEntry) *planNode {
	card := func() *planNode { return &planNode{Tabs: []planEntry{entry}} }
	row := func(size int) *planNode {
		if size == 1 {
			return card()
		}
		node := &planNode{Direction: "row"}
		for range size {
			node.Children = append(node.Children, card())
		}
		return node
	}
	if rows == 1 {
		return row(count)
	}
	node := &planNode{Direction: "column"}
	for k := range rows {
		size := count / rows
		if k < count%rows {
			size++
		}
		node.Children = append(node.Children, row(size))
	}
	return node
}

// planFrame is a planned frame in window points.
type planFrame = LayoutFrame

// planSize is a size {width, height} in points.
type planSize struct {
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// planSizeRefusal is the size refusal of the layout library (packages/soksak/docs/layout.md), the only error that a measure takes for a
// tree that does not fit.
var planSizeRefusal = regexp.MustCompile(`^card \S+ would be \S+x\S+, below its minimum \S+x\S+$`)

// planSizing measures a tree, answering nil for a tree that does not fit the plane and every other error of the layout library, and
// tells whether frames meet the minimum and whether a card is lower than the minimum.
type planSizing struct {
	measure func(tree *planNode) ([]planFrame, error)
	fits    func(frames []planFrame) bool
	low     func(frames []planFrame) bool
}

// evenPlanGrid is the most even grid of count cards with entry: of the grids of 1 to count rows whose cards fit the minimum, the one
// whose cards are nearest to a square, the smallest mean |ln(width / height)|, and of equal ones the grid with fewer rows; when none
// fits, the grid nearest to a square of those that measure builds, which is not feasible, and the grid of one row when it builds none.
// A grid whose cards are lower than the minimum ends the search, because more rows only make them lower.
func evenPlanGrid(count int, entry planEntry, sizing planSizing) (plannedGrid, error) {
	var best, nearest *plannedGrid
	for rows := 1; rows <= count; rows++ {
		tree := planGrid(count, rows, entry)
		frames, err := sizing.measure(tree)
		if err != nil {
			return plannedGrid{}, err
		}
		if frames == nil {
			continue
		}
		skew := 0.0
		for _, frame := range frames {
			skew += math.Abs(math.Log(frame.Width / frame.Height))
		}
		skew /= float64(count)
		feasible := sizing.fits(frames)
		if feasible && (best == nil || skew < best.skew) {
			best = &plannedGrid{tree, frames, feasible, skew}
		}
		if nearest == nil || skew < nearest.skew {
			nearest = &plannedGrid{tree, frames, feasible, skew}
		}
		if sizing.low(frames) {
			break
		}
	}
	if best == nil {
		best = nearest
	}
	if best == nil {
		return plannedGrid{tree: planGrid(count, 1, entry)}, nil
	}
	return *best, nil
}

// plannedGrid is a grid of evenPlanGrid: its tree, the frames of its cards or nil, whether they fit, and the mean skew of its cards.
type plannedGrid struct {
	tree     *planNode
	frames   []planFrame
	feasible bool
	skew     float64
}

// planTab is a tab of the plane {tab, card, plugin, params}, or a tab of a planned card, whose Tab is "" for a new tab.
type planTab struct {
	Tab    string
	Card   string
	Plugin string
	Params json.RawMessage
}

// MarshalJSON writes a tab of a planned card as {tab, plugin, params}, tab null for a new tab.
func (t planTab) MarshalJSON() ([]byte, error) {
	var tab *string
	if t.Tab != "" {
		tab = &t.Tab
	}
	return json.Marshal(struct {
		Tab    *string         `json:"tab"`
		Plugin string          `json:"plugin"`
		Params json.RawMessage `json:"params"`
	}{tab, t.Plugin, nullJSON(t.Params)})
}

// resolvedCard is a card of the tree resolved against the plane: the card of the plane that it keeps, "" for a new card, and its tabs.
type resolvedCard struct {
	card   string
	tabs   []planTab
	active int
}

// sameParams tells whether two params are equal as JSON values, no text being null.
func sameParams(a, b json.RawMessage) (bool, error) {
	left, err := jsonValue(a)
	if err != nil {
		return false, err
	}
	right, err := jsonValue(b)
	if err != nil {
		return false, err
	}
	return reflect.DeepEqual(left, right), nil
}

// resolvePlanCards resolves the cards of a tree, in reading order, against the tabs of the plane in reading order
// (docs/spec/cli.md#planning-an-arrangement). It answers each card with its kept card and its tabs, and the tabs that no entry names
// or takes, kept at the end of the first card or closed with close. It fails for an entry {tab} that names no tab of the plane or a tab
// that an earlier entry names.
func resolvePlanCards(cards []*planNode, plane []planTab, close bool) ([]*resolvedCard, []string, []string, error) {
	byID := map[string]planTab{}
	for _, tab := range plane {
		byID[tab.Tab] = tab
	}
	named := map[string]bool{}
	for _, card := range cards {
		for _, entry := range card.Tabs {
			if entry.Tab == "" {
				continue
			}
			if _, ok := byID[entry.Tab]; !ok {
				return nil, nil, nil, fmt.Errorf("tab %s is not a tab of the active space", entry.Tab)
			}
			if named[entry.Tab] {
				return nil, nil, nil, fmt.Errorf("tab %s stands twice in the tree", entry.Tab)
			}
			named[entry.Tab] = true
		}
	}
	taken := maps.Clone(named)
	resolved := make([]*resolvedCard, len(cards))
	for k, card := range cards {
		out := &resolvedCard{active: card.Active}
		for _, entry := range card.Tabs {
			if entry.Tab != "" {
				tab := byID[entry.Tab]
				out.tabs = append(out.tabs, planTab{Tab: tab.Tab, Plugin: tab.Plugin, Params: tab.Params})
				continue
			}
			found := planTab{Plugin: entry.Plugin, Params: entry.Params}
			for _, tab := range plane {
				if taken[tab.Tab] || tab.Plugin != entry.Plugin {
					continue
				}
				same, err := sameParams(tab.Params, entry.Params)
				if err != nil {
					return nil, nil, nil, fmt.Errorf("the params of tab %s: %w", tab.Tab, err)
				}
				if same {
					taken[tab.Tab] = true
					found.Tab = tab.Tab
					break
				}
			}
			out.tabs = append(out.tabs, found)
		}
		resolved[k] = out
	}
	keptCards := map[string]bool{}
	for _, card := range resolved {
		for _, tab := range card.tabs {
			if tab.Tab == "" {
				continue
			}
			if holder := byID[tab.Tab].Card; !keptCards[holder] {
				card.card = holder
				keptCards[holder] = true
			}
			break
		}
	}
	for _, card := range resolved {
		if card.card != "" || slices.ContainsFunc(card.tabs, func(tab planTab) bool { return tab.Tab != "" }) {
			continue
		}
		for _, tab := range plane {
			if !keptCards[tab.Card] {
				card.card = tab.Card
				keptCards[tab.Card] = true
				break
			}
		}
		break
	}
	rest := []string{}
	for _, tab := range plane {
		if !taken[tab.Tab] {
			rest = append(rest, tab.Tab)
			if !close {
				resolved[0].tabs = append(resolved[0].tabs, planTab{Tab: tab.Tab, Plugin: tab.Plugin, Params: tab.Params})
			}
		}
	}
	if close {
		return resolved, []string{}, rest, nil
	}
	return resolved, rest, []string{}, nil
}

// planOperations are the operations of the size rule of the layout library on the content cards of the space, as buildPlanTree uses
// them: the content card ids, withdraw, insert, even and the frame of a card.
type planOperations struct {
	cards    func() []string
	withdraw func(id string) (*layout.Node, error)
	insert   func(target, side string, node *layout.Node) error
	even     func() error
	frame    func(id string) planFrame
}

// buildPlanTree builds tree through ops. ids[k] is the card of the k-th card of the tree in tree order: an id of the plane that the
// card keeps, or a new id. One card of the plane stays and every other card is withdrawn; the first card of the tree takes its place,
// the first card of each split stands where the split stands and the other children are inserted beside it toward right or bottom from
// the root inward, and every cut is made even. A withdrawn card that the tree keeps arrives with its data. It returns the frames of the
// cards of the tree in tree order.
func buildPlanTree(ops planOperations, tree *planNode, ids []string) ([]planFrame, error) {
	leaves := planLeaves(tree)
	if len(ids) != len(leaves) {
		return nil, fmt.Errorf("the tree holds %d cards and %d identifiers were given", len(leaves), len(ids))
	}
	plane := ops.cards()
	stay := plane[0]
	if index := slices.IndexFunc(ids, func(id string) bool { return slices.Contains(plane, id) }); index >= 0 {
		stay = ids[index]
	}
	left := map[string]*layout.Node{}
	for _, id := range plane {
		if id == stay {
			continue
		}
		piece, err := ops.withdraw(id)
		if err != nil {
			return nil, err
		}
		left[id] = piece
	}
	arriving := func(id string) *layout.Node {
		if piece, ok := left[id]; ok {
			return piece
		}
		return &layout.Node{Card: id}
	}
	if ids[0] != stay {
		if err := ops.insert(stay, "left", arriving(ids[0])); err != nil {
			return nil, err
		}
		piece, err := ops.withdraw(stay)
		if err != nil {
			return nil, err
		}
		left[stay] = piece
	}
	idOf := map[*planNode]string{}
	for index, leaf := range leaves {
		idOf[leaf] = ids[index]
	}
	var first func(node *planNode) *planNode
	first = func(node *planNode) *planNode {
		if node.Direction == "" {
			return node
		}
		return first(node.Children[0])
	}
	var place func(node *planNode) error
	place = func(node *planNode) error {
		if node.Direction == "" {
			return nil
		}
		side := "bottom"
		if node.Direction == "row" {
			side = "right"
		}
		target := idOf[first(node.Children[0])]
		for _, child := range node.Children[1:] {
			id := idOf[first(child)]
			if err := ops.insert(target, side, arriving(id)); err != nil {
				return err
			}
			target = id
		}
		for _, child := range node.Children {
			if err := place(child); err != nil {
				return err
			}
		}
		return nil
	}
	if err := place(tree); err != nil {
		return nil, err
	}
	if err := ops.even(); err != nil {
		return nil, err
	}
	frames := make([]planFrame, len(ids))
	for k, id := range ids {
		frames[k] = ops.frame(id)
	}
	return frames, nil
}

// planShares is the number of cards of an equal share along each axis for every card of a tree in tree order: a split multiplies the
// count of its children along its own axis by the number of its children.
func planShares(tree *planNode, width, height int) [][2]int {
	if tree.Direction == "" {
		return [][2]int{{width, height}}
	}
	n := len(tree.Children)
	if tree.Direction == "row" {
		width *= n
	} else {
		height *= n
	}
	var out [][2]int
	for _, child := range tree.Children {
		out = append(out, planShares(child, width, height)...)
	}
	return out
}

// withPlanCards is the tree with the card at each place of tree order replaced by cards[k].
func withPlanCards(tree *planNode, cards []*planNode) *planNode {
	k := 0
	var walk func(node *planNode) *planNode
	walk = func(node *planNode) *planNode {
		if node.Direction == "" {
			card := cards[k]
			k++
			return card
		}
		out := &planNode{Direction: node.Direction}
		for _, child := range node.Children {
			out.Children = append(out.Children, walk(child))
		}
		return out
	}
	return walk(tree)
}

// requestEntry is an entry in the form of a request: {tab} for an existing tab, else {plugin, params}.
func requestEntry(tab planTab) planEntry {
	if tab.Tab != "" {
		return planEntry{Tab: tab.Tab}
	}
	return planEntry{Plugin: tab.Plugin, Params: tab.Params}
}

// plannedCard is a card of a planned arrangement {card, frame, tabs, active}, card null for a new card.
type plannedCard struct {
	Card   *string   `json:"card"`
	Frame  planFrame `json:"frame"`
	Tabs   []planTab `json:"tabs"`
	Active int       `json:"active"`
}

// planProposal is the nearest arrangement that can be built.
type planProposal struct {
	Tree  *planNode     `json:"tree"`
	Cards []plannedCard `json:"cards"`
}

// planAnswer is the result of core.layout.plan, and ids is the kept card of each card of the tree in tree order or "", which an apply
// builds.
type planAnswer struct {
	Feasible bool          `json:"feasible"`
	Tree     *planNode     `json:"tree"`
	Cards    []plannedCard `json:"cards"`
	Plane    *planSize     `json:"plane"`
	Minimum  *planSize     `json:"minimum"`
	Kept     []string      `json:"kept"`
	Closed   []string      `json:"closed"`
	Reason   *string       `json:"reason"`
	Needed   *planSize     `json:"needed"`
	Proposal *planProposal `json:"proposal"`
	ids      []string
}

// planSpace is the active space as planArrangement reads it: refusal, the text of a cause that refuses every arrangement, or ""; the
// tabs of the plane in reading order; the plane and the minimum; entry, which answers the params of a new tab or the refusal of the
// plugin or its params; unsaved; and measure, the frames in window points of the cards of a tree in tree order, which the operations of
// the size rule build on a copy of the plane without the minimum, or the refusal of the layout library.
type planSpace struct {
	refusal string
	tabs    []planTab
	plane   *planSize
	minimum *planSize
	entry   func(plugin string, params json.RawMessage) (json.RawMessage, error)
	unsaved func(tab string) bool
	measure func(tree *planNode) ([]planFrame, error)
}

// planRequest is the parameters of core.layout.plan.
type planRequest struct {
	Tree   json.RawMessage `json:"tree,omitempty"`
	Count  *float64        `json:"count,omitempty"`
	Plugin *string         `json:"plugin,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Close  bool            `json:"close,omitempty"`
}

// refusedPlan is a plan that is not feasible for reason, without a tree.
func refusedPlan(space planSpace, reason string) planAnswer {
	return planAnswer{Cards: []plannedCard{}, Plane: space.plane, Minimum: space.minimum, Kept: []string{}, Closed: []string{}, Reason: &reason}
}

// planArrangement is the plan of an arrangement (docs/spec/cli.md#planning-an-arrangement), as planArrangement of
// packages/workbench/layout-plan.js answers it.
func planArrangement(request planRequest, space planSpace) (planAnswer, error) {
	if request.Tree != nil && (request.Count != nil || request.Plugin != nil || request.Params != nil) {
		return planAnswer{}, fmt.Errorf("core.layout.plan takes tree or count with plugin, not both")
	}
	if request.Tree == nil && (request.Count == nil || request.Plugin == nil) {
		return planAnswer{}, fmt.Errorf("core.layout.plan needs tree, or count with plugin")
	}
	if request.Count != nil && (*request.Count != math.Trunc(*request.Count) || *request.Count < 1) {
		return planAnswer{}, fmt.Errorf("count must be a whole number of at least 1")
	}
	if space.refusal != "" {
		return refusedPlan(space, space.refusal), nil
	}
	sizing := space.sizing()
	var tree *planNode
	var frames []planFrame
	if request.Tree != nil {
		decoder := json.NewDecoder(bytes.NewReader(request.Tree))
		decoder.UseNumber()
		var value any
		if err := decoder.Decode(&value); err != nil {
			return planAnswer{}, fmt.Errorf("tree: %w", err)
		}
		read, err := readPlanTree(value, "")
		if err != nil {
			return refusedPlan(space, err.Error()), nil
		}
		measured, err := sizing.measure(read)
		if err != nil {
			return refusedPlan(space, err.Error()), nil
		}
		tree, frames = read, measured
	} else {
		params := request.Params
		if string(bytes.TrimSpace(params)) == "null" {
			params = nil
		}
		// A grid that does not fit is the plan of the grid nearest to a square, which the judgement of its frames refuses.
		grid, err := evenPlanGrid(int(*request.Count), planEntry{Plugin: *request.Plugin, Params: params}, sizing)
		if err != nil {
			return refusedPlan(space, err.Error()), nil
		}
		tree, frames = grid.tree, grid.frames
	}
	for _, leaf := range planLeaves(tree) {
		for k, entry := range leaf.Tabs {
			if entry.Tab != "" {
				continue
			}
			checked, err := space.entry(entry.Plugin, entry.Params)
			if err != nil {
				return refusedPlan(space, err.Error()), nil
			}
			leaf.Tabs[k].Params = checked
		}
	}
	return judgedPlan(tree, frames, request.Close, space, sizing)
}

// sizing is the measure of the space that answers nil for a tree whose cards have no extent, the test of the minimum, and the test of
// low cards.
func (space planSpace) sizing() planSizing {
	return planSizing{
		// A tree that does not fit the plane is refused by the layout library with its size refusal, `card <id> would be <w>x<h>, below
		// its minimum <w>x<h>` (packages/soksak/docs/layout.md), which a card of a window sidebar meets before the content cards have
		// no extent, or is drawn with an empty card; the plan states the plane for both. Every other error of the measure is returned, so
		// a fault of the operations is not taken for a plane that is too small.
		measure: func(tree *planNode) ([]planFrame, error) {
			frames, err := space.measure(tree)
			if err != nil {
				if planSizeRefusal.MatchString(err.Error()) {
					return nil, nil
				}
				return nil, err
			}
			for _, frame := range frames {
				if frame.Width <= 0 || frame.Height <= 0 {
					return nil, nil
				}
			}
			return frames, nil
		},
		fits: func(frames []planFrame) bool {
			for _, frame := range frames {
				if frame.Width < space.minimum.Width || frame.Height < space.minimum.Height {
					return false
				}
			}
			return true
		},
		low: func(frames []planFrame) bool {
			return slices.ContainsFunc(frames, func(frame planFrame) bool { return frame.Height < space.minimum.Height })
		},
	}
}

// roundText is a size in whole points.
func roundText(value float64) string { return strconv.Itoa(int(math.Round(value))) }

// judgedPlan is the plan of a tree that reads and checks: its resolution against the plane and the judgement of its frames by the
// minimum.
func judgedPlan(tree *planNode, frames []planFrame, close bool, space planSpace, sizing planSizing) (planAnswer, error) {
	order := planReadingOrder(tree)
	leaves := planLeaves(tree)
	reading := make([]*planNode, len(order))
	for n, index := range order {
		reading[n] = leaves[index]
	}
	resolved, kept, closed, err := resolvePlanCards(reading, space.tabs, close)
	if err != nil {
		return refusedPlan(space, err.Error()), nil
	}
	// resolved[n] is the card of the tree at the place order[n] of tree order.
	inTreeOrder := make([]*resolvedCard, len(order))
	for n, index := range order {
		inTreeOrder[index] = resolved[n]
	}
	requestCards := make([]*planNode, len(inTreeOrder))
	ids := make([]string, len(inTreeOrder))
	for k, card := range inTreeOrder {
		node := &planNode{Active: card.active}
		for _, tab := range card.tabs {
			node.Tabs = append(node.Tabs, requestEntry(tab))
		}
		requestCards[k] = node
		ids[k] = card.card
	}
	cards := []plannedCard{}
	if frames != nil {
		for n, index := range order {
			card := plannedCard{Frame: frames[index], Tabs: resolved[n].tabs, Active: resolved[n].active}
			if resolved[n].card != "" {
				id := resolved[n].card
				card.Card = &id
			}
			cards = append(cards, card)
		}
	}
	answer := planAnswer{Feasible: true, Tree: withPlanCards(tree, requestCards), Cards: cards, Plane: space.plane, Minimum: space.minimum,
		Kept: kept, Closed: closed, ids: ids}
	for _, tab := range closed {
		if space.unsaved(tab) {
			reason := fmt.Sprintf("tab %s has unsaved changes; core.layout.close asks the person", tab)
			answer.Feasible, answer.Reason = false, &reason
			return answer, nil
		}
	}
	sources := make([]*planNode, len(order))
	for n := range order {
		node := &planNode{Active: resolved[n].active}
		for _, tab := range resolved[n].tabs {
			node.Tabs = append(node.Tabs, requestEntry(tab))
		}
		sources[n] = node
	}
	planeText := roundText(space.plane.Width) + " × " + roundText(space.plane.Height) + " points"
	if frames == nil {
		reason := "the cards of the tree have no extent in the plane of " + planeText
		proposal, err := proposePlan(sources, close, space, sizing)
		if err != nil {
			return planAnswer{}, err
		}
		answer.Feasible, answer.Reason, answer.Proposal = false, &reason, proposal
		return answer, nil
	}
	small := slices.IndexFunc(cards, func(card plannedCard) bool { return !sizing.fits([]planFrame{card.Frame}) })
	if small < 0 {
		return answer, nil
	}
	// A card of an equal share is drawn at (plane - corridors) / count on each axis, so the plane at which it meets the minimum is the
	// plane less count times what it lacks.
	counts := planShares(tree, 1, 1)
	need := func(axis int) float64 {
		most := math.Inf(-1)
		for k, frame := range frames {
			size, plane, minimum := frame.Width, space.plane.Width, space.minimum.Width
			if axis == 1 {
				size, plane, minimum = frame.Height, space.plane.Height, space.minimum.Height
			}
			most = max(most, plane-float64(counts[k][axis])*(size-minimum))
		}
		// The need is rounded up to a whole point after a rounding to a millionth, so a sum of equal shares stays its whole number.
		return math.Ceil(math.Round(most*1e6) / 1e6)
	}
	frame := cards[small].Frame
	needed := planSize{Width: need(0), Height: need(1)}
	reason := fmt.Sprintf("card %d of the tree would be %s × %s points, below the minimum %s × %s points; the tree needs a plane of %s × %s "+
		"points and the plane is %s", small+1, roundText(frame.Width), roundText(frame.Height), roundText(space.minimum.Width),
		roundText(space.minimum.Height), roundText(needed.Width), roundText(needed.Height), planeText)
	proposal, err := proposePlan(sources, close, space, sizing)
	if err != nil {
		return planAnswer{}, err
	}
	answer.Feasible, answer.Reason, answer.Needed, answer.Proposal = false, &reason, &needed, proposal
	return answer, nil
}

// proposePlan is the nearest arrangement that can be built: the most even grid of the number of cards of the tree, each card taking the
// entries of one card of the tree in reading order, or the most even grid of the largest number of cards that fits, whose last card
// also takes the entries of the cards that do not fit; nil when no grid of one card fits. A grid of one card fewer in the same rows has
// cards at least as large, so a bisection over the counts gives the largest count that fits.
func proposePlan(sources []*planNode, close bool, space planSpace, sizing planSizing) (*planProposal, error) {
	placeholder := planEntry{}
	best, err := evenPlanGrid(len(sources), placeholder, sizing)
	if err != nil {
		return nil, err
	}
	if !best.feasible {
		best = plannedGrid{}
		lo, hi := 0, len(sources)
		for hi-lo > 1 {
			mid := (lo + hi) / 2
			found, err := evenPlanGrid(mid, placeholder, sizing)
			if err != nil {
				return nil, err
			}
			if found.feasible {
				lo, best = mid, found
			} else {
				hi = mid
			}
		}
		if best.tree == nil {
			return nil, nil
		}
	}
	tree, frames := best.tree, best.frames
	count := len(planLeaves(tree))
	merged := slices.Clone(sources[:count-1])
	last := &planNode{Active: sources[count-1].Active}
	for _, source := range sources[count-1:] {
		last.Tabs = append(last.Tabs, source.Tabs...)
	}
	merged = append(merged, last)
	placed := make([]*planNode, count)
	for n, index := range planReadingOrder(tree) {
		placed[index] = merged[n]
	}
	planned, err := judgedPlan(withPlanCards(tree, placed), frames, close, space, sizing)
	if err != nil {
		return nil, err
	}
	return &planProposal{Tree: planned.Tree, Cards: planned.Cards}, nil
}
