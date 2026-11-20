// The layout operations core.layout.open, core.layout.select and core.layout.close and the layout of the window description
// (docs/spec/cli.md#acting-on-a-layout), as packages/workbench/test states them for the page workbench. Each case applies an operation
// twice and compares the result and the layout of the description after both applications.
package workbench_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// layoutPlugins are the plugins of the layout cases: notes takes the tab params path and line and saves, and plain takes no params.
const layoutPlugins = `{"plugins": [
	{"id": "notes", "package": "@scope/plugin-notes", "version": "1.0.0", "manifest": {"id": "notes", "name": "노트", "description": "notes", "mark": "n", "icon": "<path d=\"M1 1h14\"/>",
		"surface": {"composition": {"kind": "view", "page": "ui/index.html"}, "save": "notes.save",
			"params": {"type": "object", "properties": {"path": {"type": "string"}, "line": {"type": "number"}}}},
		"exposes": {"commands": [{"name": "notes.save", "description": "saves", "params": {"type": "object", "properties": {}}, "result": {"type": "null"}}]}}},
	{"id": "plain", "package": "@scope/plugin-plain", "version": "1.0.0", "manifest": {"id": "plain", "name": "Plain", "description": "plain", "mark": "p", "icon": "<path d=\"M1 1h14\"/>",
		"surface": {"composition": {"kind": "view", "page": "ui/plain.html"}}}}
]}`

// paramTab is a stored tab of plugin with the stored params, which are absent for nil.
func paramTab(id, plugin string, params map[string]any) map[string]any {
	stored := tab(id, plugin)
	if params != nil {
		stored["params"] = params
	}
	return stored
}

// cardNode is a stored card node of the tree with tabs, the first of them active.
func cardNode(id string, tabs ...map[string]any) map[string]any {
	return map[string]any{"card": id, "data": map[string]any{"tabs": tabs, "activeId": tabs[0]["id"]}}
}

// cutNode is a cut node of the tree along axis with its kids.
func cutNode(axis string, kids ...map[string]any) map[string]any {
	return map[string]any{"cut": axis, "kids": kids}
}

// kidNode is a kid of a cut: the node with its share of the cut.
func kidNode(share float64, node map[string]any) map[string]any {
	return map[string]any{"share": share, "node": node}
}

// boxNode is the box of a group card of the tree with its name, its leader and the inner node that holds its members
// (docs/spec/groups.md#storage).
func boxNode(id, name, leader string, inner map[string]any) map[string]any {
	return map[string]any{"box": id, "data": map[string]any{"name": name, "leader": leader}, "inner": inner}
}

// treeSpace is a stored space whose tree has the root node root.
func treeSpace(id string, root map[string]any) map[string]any {
	return map[string]any{"id": id, "title": id, "layout": storedRoot(root)}
}

// storedRoot is the stored layout of the tree of root without group cards (docs/spec/groups.md#storage): its leader is its first card
// that is not a window sidebar, and lastCard the largest number of a card id card-<n>, at least 1.
func storedRoot(root map[string]any) map[string]any {
	var leader any
	last := 1
	// inside tells that the node stands in a box, whose members are no members of the root level.
	var visit func(node map[string]any, inside bool)
	visit = func(node map[string]any, inside bool) {
		if kids, ok := node["kids"].([]map[string]any); ok {
			for _, kid := range kids {
				visit(kid["node"].(map[string]any), inside)
			}
			return
		}
		id, _ := node["card"].(string)
		if box, ok := node["box"].(string); ok {
			id = box
			defer visit(node["inner"].(map[string]any), true)
		}
		if leader == nil && !inside && !layout.IsWindowSide(id) {
			leader = id
		}
		var n int
		if _, err := fmt.Sscanf(id, "card-%d", &n); err == nil {
			last = max(last, n)
		}
	}
	visit(root, false)
	return map[string]any{"state": map[string]any{"root": root}, "leader": leader, "lastCard": last}
}

// gridProject is the stored project prj-a whose first space is active.
func gridProject(spaces ...map[string]any) map[string]any {
	return map[string]any{"id": "prj-a", "named": 1, "title": "a", "root": "/a", "identity": "identity of /a", "color": "#ffb36b",
		"activeSpaceId": spaces[0]["id"], "spaces": spaces}
}

// layoutShell is a tab shell with the plugins of the layout cases that shows the project of spaces.
func layoutShell(t *testing.T, spaces ...map[string]any) *tabShell {
	t.Helper()
	f := newTabShell(t, &storedHost{installed: layoutPlugins, projects: []map[string]any{gridProject(spaces...)}})
	f.open(t)
	return f
}

// Opening a space runs the check of the stored layout that the library preview runs, so a layout that stores a member that
// docs/spec/groups.md#storage does not define, such as the format member of the earlier layout of lines, is refused with the
// prefix of the space instead of opening without it (docs/spec/cases/layout/stored.json).
func TestOpeningASpaceRefusesALayoutMemberThatTheStorageDoesNotDefine(t *testing.T) {
	space := oneCard(tab("t1", "notes"))
	space["layout"].(map[string]any)["format"] = 2
	stored := &storedHost{installed: layoutPlugins, projects: []map[string]any{gridProject(space)}}
	f := newShell(t, stored)
	f.shell.Registry().RunLater("core.project.activate", json.RawMessage(`{"id":"prj-a"}`), func(any, error) {})
	f.pending.drain(t)
	f.tester.Frame()
	want := "projects.json: project /a space spc-aaaaaa: layout stores format, which a space layout does not hold"
	// The command shows the refusal through the one error path, which writes it to the log.
	if errors := stored.written("workbench.record.error"); len(errors) != 1 || !strings.Contains(fmt.Sprint(errors[0]), want) {
		t.Fatalf("the window recorded %v; want %q", errors, want)
	}
}

// oneCard is the space spc-aaaaaa with the card main and tabs.
func oneCard(tabs ...map[string]any) map[string]any {
	return treeSpace("spc-aaaaaa", cardNode("main", tabs...))
}

// apply runs a layout operation with the JSON params and returns its result as JSON.
func (f *tabShell) apply(name, params string) (string, error) {
	f.t.Helper()
	value, err := f.shell.Registry().Run(name, json.RawMessage(params))
	f.settle()
	if err != nil {
		return "", err
	}
	text, err := json.Marshal(value)
	if err != nil {
		f.t.Fatal(err)
	}
	return string(text), nil
}

// described is the layout of the description of the window as JSON.
func (f *tabShell) described() string {
	f.t.Helper()
	description, err := f.shell.LayoutDescription()
	if err != nil {
		f.t.Fatal(err)
	}
	text, err := json.Marshal(description)
	if err != nil {
		f.t.Fatal(err)
	}
	return string(text)
}

// twice applies a layout operation two times and fails unless both answer the same and leave the same layout. It returns the
// answer and the layout.
func (f *tabShell) twice(name, params string) (map[string]any, describedLayout) {
	f.t.Helper()
	first, err := f.apply(name, params)
	if err != nil {
		f.t.Fatalf("%s %s: %v", name, params, err)
	}
	after := f.described()
	second, err := f.apply(name, params)
	if err != nil {
		f.t.Fatalf("the second %s %s: %v", name, params, err)
	}
	if again := f.described(); first != second || after != again {
		f.t.Fatalf("%s %s answered %s and then %s, with the layout\n%s\nand then\n%s", name, params, first, second, after, again)
	}
	var answer map[string]any
	if err := json.Unmarshal([]byte(first), &answer); err != nil {
		f.t.Fatal(err)
	}
	return answer, f.layout()
}

// describedLayout is the layout of the description as a test reads it.
type describedLayout struct {
	Space   string         `json:"space"`
	Focused *string        `json:"focused"`
	Root    *describedNode `json:"root"`
}

type describedNode struct {
	Direction string          `json:"direction"`
	Size      float64         `json:"size"`
	Children  []describedNode `json:"children"`
	Card      string          `json:"card"`
	Frame     *struct {
		X      float64 `json:"x"`
		Y      float64 `json:"y"`
		Width  float64 `json:"width"`
		Height float64 `json:"height"`
	} `json:"frame"`
	Tabs []struct {
		Tab    string          `json:"tab"`
		Plugin string          `json:"plugin"`
		Title  string          `json:"title"`
		Active bool            `json:"active"`
		Params json.RawMessage `json:"params"`
	} `json:"tabs"`
}

func (f *tabShell) layout() describedLayout {
	f.t.Helper()
	var out describedLayout
	if err := json.Unmarshal([]byte(f.described()), &out); err != nil {
		f.t.Fatal(err)
	}
	if out.Root == nil {
		f.t.Fatal("the description has no layout tree")
	}
	return out
}

// shape is the tree as text: a card is its id, and a split is its direction with its children and their sizes.
func (n describedNode) shape() string {
	if n.Direction == "" {
		return n.Card
	}
	parts := make([]string, len(n.Children))
	for i, child := range n.Children {
		parts[i] = fmt.Sprintf("%s %.4g", child.shape(), child.Size)
	}
	return n.Direction + "[" + strings.Join(parts, ", ") + "]"
}

// card returns the node of the card id.
func (l describedLayout) card(id string) (describedNode, bool) {
	var find func(n describedNode) (describedNode, bool)
	find = func(n describedNode) (describedNode, bool) {
		if n.Direction == "" {
			return n, n.Card == id
		}
		for _, child := range n.Children {
			if found, ok := find(child); ok {
				return found, true
			}
		}
		return describedNode{}, false
	}
	return find(*l.Root)
}

// tabs lists the tab ids of the card id in tab order, with a star after the active one.
func (l describedLayout) tabs(t *testing.T, id string) []string {
	t.Helper()
	node, ok := l.card(id)
	if !ok {
		t.Fatalf("the layout has no card %s: %s", id, l.Root.shape())
	}
	var out []string
	for _, tab := range node.Tabs {
		mark := tab.Tab
		if tab.Active {
			mark += "*"
		}
		out = append(out, mark)
	}
	return out
}

// paramsOf returns the params of the tab id of the card as JSON.
func (l describedLayout) paramsOf(t *testing.T, card, id string) string {
	t.Helper()
	node, _ := l.card(card)
	for _, tab := range node.Tabs {
		if tab.Tab == id {
			return string(tab.Params)
		}
	}
	t.Fatalf("card %s has no tab %s", card, id)
	return ""
}

// focusedCard is the focused card of the description.
func (l describedLayout) focusedCard() string {
	if l.Focused == nil {
		return ""
	}
	return *l.Focused
}

// stored is the stored state of the projects as JSON.
func (f *tabShell) stored() string {
	f.t.Helper()
	text, err := json.Marshal(f.host.projects)
	if err != nil {
		f.t.Fatal(err)
	}
	return string(text)
}

// hostCalls counts the host calls name that the window made.
func (f *tabShell) hostCalls(name string) int {
	f.host.mu.Lock()
	defer f.host.mu.Unlock()
	count := 0
	for _, call := range f.host.calls {
		if call == name {
			count++
		}
	}
	return count
}

// contract: layout.tree.splits-carry-frames
func TestEachSplitOfTheDescriptionCarriesTheFrameOfItsChildren(t *testing.T) {
	f := layoutShell(t, treeSpace("spc-aaaaaa", cutNode("x", kidNode(0.5, cardNode("a", tab("tab-aaaaaa", "notes"))), kidNode(0.5, cutNode("y", kidNode(0.5, cardNode("b", tab("tab-bbbbbb", "notes"))), kidNode(0.5, cardNode("c", tab("tab-cccccc", "notes"))))))))
	var check func(node describedNode, where string)
	check = func(node describedNode, where string) {
		if node.Direction == "" {
			return
		}
		if node.Frame == nil {
			t.Fatalf("%s: the split %s has no frame", where, node.shape())
		}
		left, top, right, bottom := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
		for _, child := range node.Children {
			left, top = min(left, child.Frame.X), min(top, child.Frame.Y)
			right, bottom = max(right, child.Frame.X+child.Frame.Width), max(bottom, child.Frame.Y+child.Frame.Height)
		}
		if got := *node.Frame; got.X != left || got.Y != top || got.Width != right-left || got.Height != bottom-top {
			t.Fatalf("%s: the split frame is %+v, not the frame %v,%v %vx%v of its children", where, got, left, top, right-left, bottom-top)
		}
		for i, child := range node.Children {
			check(child, fmt.Sprintf("%s/%d", where, i))
		}
	}
	root := *f.layout().Root
	if got := root.shape(); got != "row[a 0.5, column[b 0.5, c 0.5] 0.5]" {
		t.Fatalf("the tree is %s", got)
	}
	check(root, "root")
}

// contract: layout.open.adds-a-tab-once
func TestALayoutOpenAddsATabOnce(t *testing.T) {
	f := layoutShell(t, treeSpace("spc-aaaaaa", cutNode("x", kidNode(0.5, cardNode("main", tab("tab-aaaaaa", "notes"))), kidNode(0.5, cardNode("other", tab("tab-bbbbbb", "notes"))))))
	f.run(t, "core.card.focus", `{"card":"other"}`)
	answer, layout := f.twice("core.layout.open", `{"card":"main","plugin":"notes","params":{"path":"a.md"}}`)
	added, _ := answer["tab"].(string)
	if answer["card"] != "main" || !strings.HasPrefix(added, "tab-") {
		t.Fatalf("the open answered %v", answer)
	}
	if got := layout.tabs(t, "main"); !slices.Equal(got, []string{"tab-aaaaaa", added + "*"}) {
		t.Fatalf("main holds %v", got)
	}
	if got := layout.paramsOf(t, "main", added); got != `{"path":"a.md"}` {
		t.Fatalf("the new tab has the params %s", got)
	}
	if layout.focusedCard() != "main" || layout.Space != "spc-aaaaaa" {
		t.Fatalf("the layout is %+v", layout)
	}
	if got := layout.Root.shape(); got != "row[main 0.5, other 0.5]" {
		t.Fatalf("the tree is %s", got)
	}
	// The frame of a card is the rectangle of the card in the window.
	node, _ := layout.card("main")
	drawn := f.box("core.card", "main")
	if math.Abs(node.Frame.X-float64(drawn.X)) > 0.01 || math.Abs(node.Frame.Y-float64(drawn.Y)) > 0.01 ||
		math.Abs(node.Frame.Width-float64(drawn.W)) > 0.01 || math.Abs(node.Frame.Height-float64(drawn.H)) > 0.01 {
		t.Fatalf("the frame of main is %+v and the card is drawn at %+v", *node.Frame, drawn)
	}
}

// contract: layout.open.selects-the-first-equal-tab
func TestALayoutOpenSelectsTheFirstEqualTab(t *testing.T) {
	f := layoutShell(t, oneCard(paramTab("tab-dddddd", "plain", nil), paramTab("tab-aaaaaa", "notes", nil),
		paramTab("tab-bbbbbb", "notes", map[string]any{"line": 1, "path": "a.md"}), paramTab("tab-cccccc", "notes", map[string]any{"path": "a.md", "line": 1})))
	// Another order of the members and another form of the number name the same params.
	answer, layout := f.twice("core.layout.open", `{"card":"main","plugin":"notes","params":{"path":"a.md","line":1.0e0}}`)
	if answer["tab"] != "tab-bbbbbb" || answer["card"] != "main" {
		t.Fatalf("the open answered %v", answer)
	}
	if got := layout.tabs(t, "main"); !slices.Equal(got, []string{"tab-dddddd", "tab-aaaaaa", "tab-bbbbbb*", "tab-cccccc"}) {
		t.Fatalf("main holds %v", got)
	}
	// An omitted params is no params; a null is no object and is refused by the params schema (docs/spec/exposure.md#command-parameters).
	if _, err := f.apply("core.layout.open", `{"card":"main","plugin":"notes","params":null}`); err == nil || err.Error() != "invalid params for core.layout.open" {
		t.Fatalf("a null params answered %v", err)
	}
	for _, params := range []string{`{"card":"main","plugin":"notes"}`} {
		answer, layout = f.twice("core.layout.open", params)
		if answer["tab"] != "tab-aaaaaa" || len(layout.tabs(t, "main")) != 4 {
			t.Fatalf("%s answered %v with the tabs %v", params, answer, layout.tabs(t, "main"))
		}
	}
	// Params that differ in a value add a tab.
	answer, layout = f.twice("core.layout.open", `{"card":"main","plugin":"notes","params":{"path":"a.md","line":2}}`)
	added, _ := answer["tab"].(string)
	if got := layout.tabs(t, "main"); !slices.Equal(got, []string{"tab-dddddd", "tab-aaaaaa", "tab-bbbbbb", "tab-cccccc", added + "*"}) {
		t.Fatalf("main holds %v", got)
	}
}

// contract: layout.open.splits-once
func TestALayoutOpenSplitsOnce(t *testing.T) {
	for _, c := range []struct {
		side, want string
	}{
		{"right", "row[main 0.5, %s 0.5]"}, {"left", "row[%s 0.5, main 0.5]"},
		{"bottom", "column[main 0.5, %s 0.5]"}, {"top", "column[%s 0.5, main 0.5]"},
	} {
		t.Run(c.side, func(t *testing.T) {
			f := layoutShell(t, oneCard(tab("tab-aaaaaa", "notes")))
			answer, layout := f.twice("core.layout.open", `{"card":"main","side":"`+c.side+`","plugin":"notes","params":{"path":"s.md"}}`)
			born, _ := answer["card"].(string)
			if got := layout.Root.shape(); got != fmt.Sprintf(c.want, born) {
				t.Fatalf("the tree is %s", got)
			}
			if got := layout.tabs(t, born); !slices.Equal(got, []string{answer["tab"].(string) + "*"}) || layout.focusedCard() != born {
				t.Fatalf("the new card holds %v and the focus is %s", got, layout.focusedCard())
			}
		})
	}
	t.Run("parent of the other direction", func(t *testing.T) {
		f := layoutShell(t, treeSpace("spc-aaaaaa", cutNode("y", kidNode(0.5, cardNode("a", tab("tab-aaaaaa", "notes"))), kidNode(0.5, cardNode("b", tab("tab-bbbbbb", "notes"))))))
		answer, layout := f.twice("core.layout.open", `{"card":"a","side":"right","plugin":"notes"}`)
		if got, want := layout.Root.shape(), fmt.Sprintf("column[row[a 0.5, %s 0.5] 0.5, b 0.5]", answer["card"]); got != want {
			t.Fatalf("the tree is %s, want %s", got, want)
		}
	})
	// The split lands on the line of the other row, and the tree keeps its rows: a line that crosses the whole window by chance changes
	// no cut (packages/soksak/docs/layout.md#the-model).
	t.Run("a split onto the line of another cut keeps the tree", func(t *testing.T) {
		f := layoutShell(t, treeSpace("spc-aaaaaa", cutNode("y", kidNode(0.5, cutNode("x", kidNode(0.5, cardNode("a", tab("tab-aaaaaa", "notes"))), kidNode(0.5, cardNode("b", tab("tab-bbbbbb", "notes"))))), kidNode(0.5, cardNode("c", tab("tab-cccccc", "notes"))))))
		if got := f.layout().Root.shape(); got != "column[row[a 0.5, b 0.5] 0.5, c 0.5]" {
			t.Fatalf("the tree before the split is %s", got)
		}
		answer, layout := f.twice("core.layout.open", `{"card":"c","side":"right","plugin":"notes"}`)
		if got, want := layout.Root.shape(), fmt.Sprintf("column[row[a 0.5, b 0.5] 0.5, row[c 0.5, %s 0.5] 0.5]", answer["card"]); got != want {
			t.Fatalf("the tree is %s, want %s", got, want)
		}
	})
}

// contract: layout.open.rule-of-sizes
func TestALayoutOpenAddsACardByTheRuleOfSizes(t *testing.T) {
	row := func(a, b float64) map[string]any {
		return treeSpace("spc-aaaaaa", cutNode("x", kidNode(a, cardNode("a", tab("tab-aaaaaa", "notes"))),
			kidNode(b, cardNode("b", tab("tab-bbbbbb", "notes")))))
	}
	// Beside a card of an even split, the split holds one more equal child.
	f := layoutShell(t, row(0.5, 0.5))
	answer, layout := f.twice("core.layout.open", `{"card":"a","side":"right","plugin":"notes","params":{"path":"x.md"}}`)
	if got, want := layout.Root.shape(), fmt.Sprintf("row[a 0.3333, %s 0.3333, b 0.3333]", answer["card"]); got != want {
		t.Fatalf("the tree of the even split is %s, want %s", got, want)
	}
	// Beside a card of an uneven split, the new card and the card share the extent of the card in halves.
	f = layoutShell(t, row(0.7, 0.3))
	answer, layout = f.twice("core.layout.open", `{"card":"a","side":"right","plugin":"notes","params":{"path":"x.md"}}`)
	if got, want := layout.Root.shape(), fmt.Sprintf("row[a 0.35, %s 0.35, b 0.3]", answer["card"]); got != want {
		t.Fatalf("the tree of the uneven split is %s, want %s", got, want)
	}
}

// contract: layout.open.split-beside-another-neighbour
func TestALayoutOpenSplitsBesideAnotherNeighbour(t *testing.T) {
	pair := func() map[string]any {
		return treeSpace("spc-aaaaaa", cutNode("x", kidNode(0.5, cardNode("a", tab("tab-aaaaaa", "notes"))), kidNode(0.5, cardNode("b", paramTab("tab-bbbbbb", "notes", map[string]any{"path": "b.md"})))))
	}
	// The neighbour that holds the tab answers it.
	f := layoutShell(t, pair())
	answer, layout := f.twice("core.layout.open", `{"card":"a","side":"right","plugin":"notes","params":{"path":"b.md"}}`)
	if answer["card"] != "b" || answer["tab"] != "tab-bbbbbb" || layout.Root.shape() != "row[a 0.5, b 0.5]" {
		t.Fatalf("the open answered %v with the tree %s", answer, layout.Root.shape())
	}
	// A neighbour without the tab gets a new card between it and the card.
	f = layoutShell(t, pair())
	answer, layout = f.twice("core.layout.open", `{"card":"a","side":"right","plugin":"notes","params":{"path":"x.md"}}`)
	// The row of a and b is even, so the new card is one more equal kid (docs/spec/groups.md#commands).
	if got, want := layout.Root.shape(), fmt.Sprintf("row[a 0.3333, %s 0.3333, b 0.3333]", answer["card"]); got != want {
		t.Fatalf("the tree is %s, want %s", got, want)
	}
	if got := layout.tabs(t, "b"); !slices.Equal(got, []string{"tab-bbbbbb*"}) {
		t.Fatalf("b holds %v", got)
	}
	// A card on the side that does not span the two lines of the card is no neighbour.
	f = layoutShell(t, treeSpace("spc-aaaaaa", cutNode("x", kidNode(0.5, cardNode("a", tab("tab-aaaaaa", "notes"))), kidNode(0.5, cutNode("y", kidNode(0.5, cardNode("b", paramTab("tab-bbbbbb", "notes", map[string]any{"path": "b.md"}))), kidNode(0.5, cardNode("c", tab("tab-cccccc", "notes"))))))))
	answer, layout = f.twice("core.layout.open", `{"card":"a","side":"right","plugin":"notes","params":{"path":"b.md"}}`)
	if got, want := layout.Root.shape(), fmt.Sprintf("row[a 0.3333, %s 0.3333, column[b 0.5, c 0.5] 0.3333]", answer["card"]); got != want {
		t.Fatalf("the tree is %s, want %s", got, want)
	}
	if answer["tab"] == "tab-bbbbbb" || !slices.Equal(layout.tabs(t, "b"), []string{"tab-bbbbbb*"}) {
		t.Fatalf("the open answered %v and b holds %v", answer, layout.tabs(t, "b"))
	}
}

// contract: layout.open.path-chooses-the-plugin
func TestALayoutOpenOfAPathChoosesThePlugin(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	first, layout := f.twice("core.layout.open", `{"card":"main","path":"docs/café.md"}`)
	added, _ := first["tab"].(string)
	if first["card"] != "main" || layout.paramsOf(t, "main", added) != `{"path":"docs/café.md"}` {
		t.Fatalf("the open answered %v with the params %s", first, layout.paramsOf(t, "main", added))
	}
	node, _ := layout.card("main")
	if node.Tabs[1].Plugin != "notes" {
		t.Fatalf("the new tab is a tab of %s", node.Tabs[1].Plugin)
	}
	// A path in another form names the same file: a ./ before it, a . segment, an empty segment, and the decomposed letter.
	for _, path := range []string{"./docs/café.md", "docs/./café.md", "docs//café.md", "docs/café.md"} {
		answer, again := f.twice("core.layout.open", `{"card":"main","path":"`+path+`"}`)
		if !reflect.DeepEqual(answer, first) || len(again.tabs(t, "main")) != 2 {
			t.Fatalf("%s answered %v with the tabs %v", path, answer, again.tabs(t, "main"))
		}
	}
	before, stored := f.described(), f.stored()
	if _, err := f.apply("core.layout.open", `{"card":"main","path":"x.zzz"}`); err == nil || err.Error() != "no plugin opens x.zzz" {
		t.Fatalf("the open of x.zzz failed with %v", err)
	}
	if f.described() != before || f.stored() != stored {
		t.Fatal("the refused open changed the layout")
	}
}

// contract: layout.open.concurrent-applications-add-one-tab
func TestConcurrentLayoutOpensAddOneTab(t *testing.T) {
	var mu sync.Mutex
	var replies []string
	host := &storedHost{installed: layoutPlugins, projects: []map[string]any{gridProject(oneCard(tab("tab-aaaaaa", "notes")))},
		extra: map[string]workbench.HostCall{"exposureReply": func(_ context.Context, argument json.RawMessage) (any, error) {
			mu.Lock()
			defer mu.Unlock()
			replies = append(replies, string(argument))
			return nil, nil
		}}}
	f := newTabShell(t, host)
	f.open(t)
	params := json.RawMessage(`{"name":"core.layout.open","params":{"card":"main","plugin":"notes","params":{"path":"c.md"}}}`)
	// Both requests arrive before either is answered.
	f.shell.Event("exposure-request", []any{map[string]any{"id": 1, "method": "command.run", "params": params}})
	f.shell.Event("exposure-request", []any{map[string]any{"id": 2, "method": "command.run", "params": params}})
	f.settle()
	mu.Lock()
	defer mu.Unlock()
	if len(replies) != 2 {
		t.Fatalf("the replies are %v", replies)
	}
	results := make([]map[string]any, 2)
	for i, reply := range replies {
		var answered struct {
			ID     int            `json:"id"`
			Result map[string]any `json:"result"`
		}
		if err := json.Unmarshal([]byte(reply), &answered); err != nil || answered.Result == nil {
			t.Fatalf("the reply %s: %v", reply, err)
		}
		results[i] = answered.Result
	}
	if !reflect.DeepEqual(results[0], results[1]) {
		t.Fatalf("the two applications answered %v", results)
	}
	if got := f.layout().tabs(t, "main"); !slices.Equal(got, []string{"tab-aaaaaa", results[0]["tab"].(string) + "*"}) {
		t.Fatalf("main holds %v", got)
	}
}

// contract: layout.open.refusal-changes-nothing
func TestARefusedLayoutOpenChangesNothing(t *testing.T) {
	// The card thin is narrower than two cards of the minimum size and the gap, so it cannot split across.
	f := layoutShell(t,
		treeSpace("spc-aaaaaa", cutNode("x", kidNode(0.44, cardNode("main", tab("tab-bbbbbb", "notes"))), kidNode(0.12, cardNode("thin", tab("tab-aaaaaa", "notes"))), kidNode(0.44, cardNode("rest", tab("tab-cccccc", "notes"))))),
		treeSpace("spc-bbbbbb", cardNode("far", tab("tab-ffffff", "notes"))))
	refusals := []struct{ params, want string }{
		{`{"card":"nowhere","plugin":"notes"}`, "card nowhere is not in the layout of window main"},
		{`{"card":"far","plugin":"notes"}`, "card far is in space spc-bbbbbb, which is not active"},
		{`{"card":"main","plugin":"missing"}`, "unknown plugin missing"},
		{`{"card":"main","plugin":"notes","params":{"path":7}}`, "params do not match notes surface.params"},
		{`{"card":"main","plugin":"plain","params":{"path":"a"}}`, "plugin plain declares no tab params"},
		{`{"card":"main","plugin":"notes","path":"a.md"}`, "core.layout.open takes plugin or path, not both"},
		{`{"card":"main"}`, "core.layout.open needs plugin or path"},
		{`{"card":"main","path":"a.md","params":{"path":"a.md"}}`, "core.layout.open takes params only with plugin"},
		{`{"card":"main","side":"middle","plugin":"notes"}`, "invalid params for core.layout.open"},
	}
	check := func(params, want string) {
		t.Helper()
		before, stored := f.described(), f.stored()
		if _, err := f.apply("core.layout.open", params); err == nil || err.Error() != want {
			t.Fatalf("%s failed with %v, want %s", params, err, want)
		}
		if f.described() != before || f.stored() != stored {
			t.Fatalf("the refused %s changed the layout", params)
		}
	}
	for _, refusal := range refusals {
		check(refusal.params, refusal.want)
	}
	// The neighbour rest holds no tab with these params, so the open splits thin, which a half would draw below the minimum.
	before, stored := f.described(), f.stored()
	if _, err := f.apply("core.layout.open", `{"card":"thin","side":"right","plugin":"notes","params":{"path":"x.md"}}`); err == nil ||
		!thinRefusal.MatchString(err.Error()) {
		t.Fatalf("the open beside thin failed with %v, want %s", err, thinRefusal)
	}
	if f.described() != before || f.stored() != stored {
		t.Fatal("the refused open beside thin changed the layout")
	}
	// A card of a fullscreen arrangement does not change.
	f.run(t, "core.card.fullscreen", `{"card":"main"}`)
	check(`{"card":"main","plugin":"notes","params":{"path":"f.md"}}`,
		"card main: the layout does not change while card main is fullscreen; restore the arrangement first")
}

// contract: layout.current.resolves-at-each-application
func TestCurrentResolvesAtEachApplication(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "notes")))
	f.run(t, "core.card.focus", `{"card":"main"}`)
	first, err := f.apply("core.layout.open", `{"card":"current","side":"right","plugin":"notes"}`)
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.apply("core.layout.open", `{"card":"current","side":"right","plugin":"notes"}`)
	if err != nil {
		t.Fatal(err)
	}
	var a, b map[string]string
	if json.Unmarshal([]byte(first), &a) != nil || json.Unmarshal([]byte(second), &b) != nil || a["card"] == b["card"] {
		t.Fatalf("the two applications answered %s and %s", first, second)
	}
	layout := f.layout()
	// Each open splits a card of an even row, so the row holds three equal kids (docs/spec/groups.md#commands).
	if got, want := layout.Root.shape(), fmt.Sprintf("row[main 0.3333, %s 0.3333, %s 0.3333]", a["card"], b["card"]); got != want {
		t.Fatalf("the tree is %s, want %s", got, want)
	}
	// The current tab is the active tab of the focused card.
	answer, _ := f.twice("core.layout.select", `{"tab":"current"}`)
	if answer["card"] != b["card"] || answer["tab"] != b["tab"] {
		t.Fatalf("the select of the current tab answered %v", answer)
	}
}

// contract: layout.move.into-a-card-once
func TestALayoutMoveIntoACardMovesTheTabOnce(t *testing.T) {
	f := layoutShell(t, treeSpace("spc-aaaaaa", cutNode("x", kidNode(0.5, cardNode("a", tab("tab-aaaaaa", "notes"), paramTab("tab-bbbbbb", "notes", map[string]any{"path": "s.md"}))), kidNode(0.5, cardNode("b", tab("tab-cccccc", "notes"))))))
	answer, layout := f.twice("core.layout.move", `{"tab":"tab-bbbbbb","card":"b"}`)
	if answer["card"] != "b" || answer["tab"] != "tab-bbbbbb" {
		t.Fatalf("the move answered %v", answer)
	}
	if got := layout.tabs(t, "b"); !slices.Equal(got, []string{"tab-cccccc", "tab-bbbbbb*"}) || layout.focusedCard() != "b" {
		t.Fatalf("b holds %v and the focus is %s", got, layout.focusedCard())
	}
	if got := layout.tabs(t, "a"); !slices.Equal(got, []string{"tab-aaaaaa*"}) {
		t.Fatalf("a holds %v", got)
	}
	if got := layout.paramsOf(t, "b", "tab-bbbbbb"); got != `{"path":"s.md"}` {
		t.Fatalf("the moved tab has the params %s", got)
	}
	// A tab that its card already holds is selected and moves nowhere.
	answer, layout = f.twice("core.layout.move", `{"tab":"tab-cccccc","card":"b"}`)
	if answer["card"] != "b" || answer["tab"] != "tab-cccccc" {
		t.Fatalf("the move answered %v", answer)
	}
	if got := layout.tabs(t, "b"); !slices.Equal(got, []string{"tab-cccccc*", "tab-bbbbbb"}) {
		t.Fatalf("b holds %v", got)
	}
}

// contract: layout.move.beside-a-card-once
func TestALayoutMoveWithASideMovesTheTabOnce(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "notes"), tab("tab-bbbbbb", "plain")))
	answer, layout := f.twice("core.layout.move", `{"tab":"tab-bbbbbb","card":"main","side":"right"}`)
	born, _ := answer["card"].(string)
	if answer["tab"] != "tab-bbbbbb" || born == "main" {
		t.Fatalf("the move answered %v", answer)
	}
	if got, want := layout.Root.shape(), fmt.Sprintf("row[main 0.5, %s 0.5]", born); got != want || layout.focusedCard() != born {
		t.Fatalf("the tree is %s, want %s, and the focus is %s", got, want, layout.focusedCard())
	}
	if got := layout.tabs(t, born); !slices.Equal(got, []string{"tab-bbbbbb*"}) {
		t.Fatalf("the new card holds %v", got)
	}
	// The only tab of a card moves the card: its identifier stays, and the card stands toward the side.
	answer, layout = f.twice("core.layout.move", `{"tab":"tab-aaaaaa","card":"`+born+`","side":"bottom"}`)
	if answer["card"] != "main" || answer["tab"] != "tab-aaaaaa" {
		t.Fatalf("the move of the only tab answered %v", answer)
	}
	if got, want := layout.Root.shape(), fmt.Sprintf("column[%s 0.5, main 0.5]", born); got != want {
		t.Fatalf("the tree is %s, want %s", got, want)
	}
}

// contract: layout.move.refusal-changes-nothing
func TestARefusedLayoutMoveChangesNothing(t *testing.T) {
	f := layoutShell(t,
		treeSpace("spc-aaaaaa", cutNode("x", kidNode(0.5, cardNode("a", tab("tab-aaaaaa", "notes"))), kidNode(0.5, cardNode("b", tab("tab-bbbbbb", "notes"))))),
		treeSpace("spc-bbbbbb", cardNode("far", tab("tab-ffffff", "notes"))))
	before := f.described()
	for _, c := range []struct{ params, want string }{
		{`{"tab":"tab-zzzzzz","card":"b"}`, "tab tab-zzzzzz is not in the layout of window main"},
		{`{"tab":"tab-ffffff","card":"b"}`, "tab tab-ffffff is in space spc-bbbbbb, which is not active"},
		{`{"tab":"tab-aaaaaa","card":"nothing"}`, "card nothing is not in the layout of window main"},
	} {
		if _, err := f.apply("core.layout.move", c.params); err == nil || err.Error() != c.want {
			t.Fatalf("%s failed with %v, want %s", c.params, err, c.want)
		}
		if f.described() != before {
			t.Fatalf("the refused %s changed the layout", c.params)
		}
	}
	// The only tab of a toward a side of a names the vacated slot of a, which changes nothing (docs/spec/groups.md#vacated-slot).
	if answer, err := f.apply("core.layout.move", `{"tab":"tab-aaaaaa","card":"a","side":"right"}`); err != nil || answer != `{"card":"a","tab":"tab-aaaaaa"}` {
		t.Fatalf("the move of the only tab of a beside a answered %s, %v", answer, err)
	}
	if f.described() != before {
		t.Fatal("the move of the only tab of a beside a changed the layout")
	}
}

// contract: layout.select.twice-is-the-same
func TestALayoutSelectTwiceIsTheSame(t *testing.T) {
	f := layoutShell(t,
		treeSpace("spc-aaaaaa", cutNode("x", kidNode(0.5, cardNode("main", tab("tab-aaaaaa", "notes"), tab("tab-bbbbbb", "notes"))), kidNode(0.5, cardNode("other", tab("tab-cccccc", "notes"))))),
		treeSpace("spc-bbbbbb", cardNode("far", tab("tab-ffffff", "notes"))))
	f.run(t, "core.card.focus", `{"card":"other"}`)
	if _, err := f.apply("core.layout.select", `{"tab":"tab-bbbbbb"}`); err != nil {
		t.Fatal(err)
	}
	layout := f.layout()
	if got := layout.tabs(t, "main"); !slices.Equal(got, []string{"tab-aaaaaa", "tab-bbbbbb*"}) || layout.focusedCard() != "main" {
		t.Fatalf("main holds %v and the focus is %s", got, layout.focusedCard())
	}
	before, stored, writes := f.described(), f.stored(), f.hostCalls("workspace")
	answer, _ := f.twice("core.layout.select", `{"tab":"tab-bbbbbb"}`)
	if answer["card"] != "main" || answer["tab"] != "tab-bbbbbb" {
		t.Fatalf("the select answered %v", answer)
	}
	if f.described() != before || f.stored() != stored || f.hostCalls("workspace") != writes {
		t.Fatal("a select of the active tab of the focused card changed the window")
	}
	for params, want := range map[string]string{
		`{"tab":"tab-zzzzzz"}`: "tab tab-zzzzzz is not in the layout of window main",
		`{"tab":"tab-ffffff"}`: "tab tab-ffffff is in space spc-bbbbbb, which is not active",
	} {
		if _, err := f.apply("core.layout.select", params); err == nil || err.Error() != want {
			t.Fatalf("%s failed with %v, want %s", params, err, want)
		}
	}
}

// contract: layout.close.repeated-close-answers-closed
func TestARepeatedLayoutCloseAnswersClosed(t *testing.T) {
	f := layoutShell(t, treeSpace("spc-aaaaaa", cutNode("x", kidNode(0.5, cardNode("main", tab("tab-aaaaaa", "notes"), tab("tab-bbbbbb", "notes"))), kidNode(0.5, cardNode("other", tab("tab-cccccc", "notes"))))))
	answer, layout := f.twice("core.layout.close", `{"tab":"tab-bbbbbb"}`)
	if answer["closed"] != true || !slices.Equal(layout.tabs(t, "main"), []string{"tab-aaaaaa*"}) {
		t.Fatalf("the close answered %v and main holds %v", answer, layout.tabs(t, "main"))
	}
	// A card that loses its last tab closes.
	answer, layout = f.twice("core.layout.close", `{"tab":"tab-cccccc"}`)
	if answer["closed"] != true || layout.Root.shape() != "main" {
		t.Fatalf("the close answered %v with the tree %s", answer, layout.Root.shape())
	}
	// The random source gives the identifier of the closed tab first, and the new tab gets another.
	f.ids.queued = []byte{1, 1, 1, 1, 1, 1}
	opened, err := f.apply("core.layout.open", `{"card":"main","plugin":"notes","params":{"path":"n.md"}}`)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(opened, "tab-bbbbbb") || len(f.ids.queued) != 0 {
		t.Fatalf("the new tab is %s, and %d queued bytes were not drawn", opened, len(f.ids.queued))
	}
	if _, err := f.apply("core.layout.close", `{"tab":"tab-zzzzzz"}`); err == nil || err.Error() != "tab tab-zzzzzz is not in the layout of window main" {
		t.Fatalf("the close of a tab that was never in the window failed with %v", err)
	}
}

// contract: layout.close.keeps-other-cuts
func TestAClosedCardGivesItsShareToItsSplitAndOtherCardsKeepTheirFrames(t *testing.T) {
	f := layoutShell(t, treeSpace("spc-aaaaaa", cutNode("y",
		kidNode(0.5, cutNode("x", kidNode(0.3, cardNode("a", tab("tab-aaaaaa", "notes"))), kidNode(0.7, cardNode("b", tab("tab-bbbbbb", "notes"))))),
		kidNode(0.5, cutNode("x", kidNode(0.6, cardNode("c", tab("tab-cccccc", "notes"))), kidNode(0.4, cardNode("d", tab("tab-dddddd", "notes"))))))))
	before := f.layout()
	top := *before.Root.Children[0].Frame
	if answer, err := f.apply("core.card.close", `{"card":"a"}`); err != nil || answer != `{"closed":true}` {
		t.Fatalf("the close answered %s, %v", answer, err)
	}
	after := f.layout()
	frame := func(l describedLayout, id string) any {
		node, ok := l.card(id)
		if !ok || node.Frame == nil {
			t.Fatalf("the layout holds no frame of %s", id)
		}
		return *node.Frame
	}
	if got := frame(after, "b"); got != any(top) {
		t.Fatalf("b is %v, want the top row %v", got, top)
	}
	for _, id := range []string{"c", "d"} {
		if got, want := frame(after, id), frame(before, id); got != want {
			t.Fatalf("%s moved from %v to %v", id, want, got)
		}
	}
}

// contract: layout.close.unsaved-tab-answers-at-once
func TestALayoutCloseOfAnUnsavedTabAnswersAtOnce(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "notes"), tab("tab-bbbbbb", "notes")))
	f.modified("tab-aaaaaa")
	for range 2 {
		answer, err := f.apply("core.layout.close", `{"tab":"tab-aaaaaa"}`)
		if err != nil || answer != `{"closed":false}` {
			t.Fatalf("the close answered %s, %v", answer, err)
		}
		menu := f.menu()
		if !menu.Open || menu.Title != "● n tab-aaaaaa 탭에 저장하지 않은 변경이 있습니다" || !slices.Equal(menu.keys(), []string{"save", "discard", "keep"}) {
			t.Fatalf("the question is %+v", menu)
		}
		if got := f.layout().tabs(t, "main"); !slices.Equal(got, []string{"tab-aaaaaa*", "tab-bbbbbb"}) {
			t.Fatalf("main holds %v while the question is open", got)
		}
	}
	f.click("core.picker.item", "discard")
	if got := f.layout().tabs(t, "main"); !slices.Equal(got, []string{"tab-bbbbbb*"}) {
		t.Fatalf("main holds %v after the answer", got)
	}
	if answer, err := f.apply("core.layout.close", `{"tab":"tab-aaaaaa"}`); err != nil || answer != `{"closed":true}` {
		t.Fatalf("the close after the answer answered %s, %v", answer, err)
	}
}

// core.file.open stores and compares the path of a tab in its normal form (docs/spec/plugins.md#pluginjson).
func TestCoreFileOpenComparesThePathInItsNormalForm(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	first, err := f.apply("core.file.open", `{"path":"./docs/café.md","card":"main"}`)
	if err != nil {
		t.Fatal(err)
	}
	var opened map[string]string
	if err := json.Unmarshal([]byte(first), &opened); err != nil {
		t.Fatal(err)
	}
	tabs := f.tabsOf("main")
	if len(tabs) != 2 || !reflect.DeepEqual(tabs[1].(map[string]any)["params"], map[string]any{"path": "docs/café.md"}) {
		t.Fatalf("the stored tabs are %v", tabs)
	}
	for _, path := range []string{"docs/café.md", "docs//./café.md"} {
		again, err := f.apply("core.file.open", `{"path":"`+path+`","card":"main"}`)
		if err != nil || again != first {
			t.Fatalf("%s answered %s, %v, want %s", path, again, err, first)
		}
	}
}

// Closing a tab restores the arrangement of a fullscreen card before it closes the tab, as closeTabById and closeInLayout of
// packages/workbench/plane.js do, so the close of the last tab of a fullscreen card closes the card instead of failing.
func TestClosingATabOfAFullscreenCardRestoresTheArrangement(t *testing.T) {
	fullscreen := func(f *tabShell) string {
		t.Helper()
		value, err := f.shell.Registry().Read("core.grid")
		if err != nil {
			t.Fatal(err)
		}
		text, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		var grid struct {
			Fullscreen *string `json:"fullscreen"`
		}
		if err := json.Unmarshal(text, &grid); err != nil {
			t.Fatal(err)
		}
		if grid.Fullscreen == nil {
			return ""
		}
		return *grid.Fullscreen
	}
	for _, c := range []struct{ name, command, params, shape string }{
		{"the last tab by core.tab.close", "core.tab.close", `{"tab":"tab-aaaaaa"}`, "side"},
		{"the last tab by core.layout.close", "core.layout.close", `{"tab":"tab-aaaaaa"}`, "side"},
		{"another tab by core.tab.close", "core.tab.close", `{"tab":"tab-bbbbbb"}`, "row[main 0.5, side 0.5]"},
		{"another tab by core.layout.close", "core.layout.close", `{"tab":"tab-bbbbbb"}`, "row[main 0.5, side 0.5]"},
	} {
		t.Run(c.name, func(t *testing.T) {
			tabs := []map[string]any{tab("tab-aaaaaa", "notes")}
			if c.shape != "side" {
				tabs = append(tabs, tab("tab-bbbbbb", "notes"))
			}
			f := layoutShell(t, treeSpace("spc-aaaaaa", cutNode("x", kidNode(0.5, cardNode("main", tabs...)), kidNode(0.5, cardNode("side", tab("tab-cccccc", "notes"))))))
			f.run(t, "core.card.fullscreen", `{"card":"main"}`)
			if got := fullscreen(f); got != "main" {
				t.Fatalf("the fullscreen card is %q, want main", got)
			}
			answer, err := f.apply(c.command, c.params)
			if err != nil {
				t.Fatalf("%s %s failed: %v", c.command, c.params, err)
			}
			if answer != `{"closed":true}` {
				t.Fatalf("%s %s answered %s", c.command, c.params, answer)
			}
			if got := fullscreen(f); got != "" {
				t.Fatalf("after the close the fullscreen card is %q", got)
			}
			if got := f.layout().Root.shape(); got != c.shape {
				t.Fatalf("after the close the layout is %s, want %s", got, c.shape)
			}
		})
	}
}

// Closing the only tab of a card that cannot close opens a replacement tab with a null origin, as closeTab of
// packages/workbench/plane.js does (F238-a-9): its plugin is the plugin of the active tab of the focused card, and the first plugin
// with a tab surface when the focused card has no tab left.
func TestClosingTheOnlyTabOfAFixedCardOpensAReplacementTab(t *testing.T) {
	for _, command := range []string{"core.tab.close", "core.layout.close"} {
		t.Run(command, func(t *testing.T) {
			f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
			answer, err := f.apply(command, `{"tab":"tab-aaaaaa"}`)
			if err != nil {
				t.Fatalf("%s failed: %v", command, err)
			}
			if answer != `{"closed":true}` {
				t.Fatalf("%s answered %s", command, answer)
			}
			main, ok := f.layout().card("main")
			if !ok || len(main.Tabs) != 1 || main.Tabs[0].Tab == "tab-aaaaaa" || main.Tabs[0].Plugin != "notes" || !main.Tabs[0].Active {
				t.Fatalf("after the close the card main holds %+v, want one active tab of notes, the first plugin", main.Tabs)
			}
			if stored, want := f.stored(), `"origin":{"directory":null}`; !strings.Contains(stored, want) {
				t.Fatalf("the stored replacement tab has no null origin: %s", stored)
			}
		})
	}
}

// askSurfaceWindow runs surface.window of the shell with the JSON params and returns its answer as JSON.
func askSurfaceWindow(t *testing.T, shell *workbench.Shell, params string) (string, error) {
	t.Helper()
	var text string
	var failure error
	answered := false
	shell.Registry().Reply("surface.window", json.RawMessage(params), nil, func(value any, err error) {
		answered, failure = true, err
		if err == nil {
			encoded, encodeErr := json.Marshal(value)
			if encodeErr != nil {
				t.Fatal(encodeErr)
			}
			text = string(encoded)
		}
	})
	if !answered {
		t.Fatalf("surface.window %s has no answer", params)
	}
	return text, failure
}

// contract: layout.surface-window.answers-the-space
func TestSurfaceWindowAnswersTheSpaceOfTheTab(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaa1", "plain")),
		treeSpace("spc-bbbbbb", cardNode("other", tab("tab-ooooo1", "plain"))))
	for params, want := range map[string]string{
		`{"surface": "tab-aaaaa1"}`: `{"space":"spc-aaaaaa"}`,
		`{"surface": "tab-ooooo1"}`: `{"space":"spc-bbbbbb"}`,
		`{"surface": "tab-zzzzz9"}`: `null`,
	} {
		if got, err := askSurfaceWindow(t, f.shell, params); err != nil || got != want {
			t.Errorf("surface.window %s answered %s %v, want %s", params, got, err, want)
		}
	}
	for _, params := range []string{`{}`, `{"surface": ""}`, `{"surface": 7}`} {
		_, err := askSurfaceWindow(t, f.shell, params)
		var refusal *workbench.Refusal
		if !errors.As(err, &refusal) || refusal.Code != workbench.InvalidParams || refusal.Message != "surface must be a non-empty string" {
			t.Errorf("surface.window %s failed with %v, want the refusal -32602 surface must be a non-empty string", params, err)
		}
	}
}

// A section surface belongs to a sidebar of the window and to no layout of a space, so surface.window answers the space null for
// each section that a sidebar of the window seats.
// contract: layout.surface-window.answers-the-space
func TestSurfaceWindowAnswersTheSpaceNullForASeatedSection(t *testing.T) {
	f, stored := surfaceShellOf(t, sidebarsInstalled)
	sections := leftSections(t, stored)
	if len(sections) == 0 {
		t.Fatal("the left sidebar seats no section")
	}
	for id := range sections {
		params, err := json.Marshal(map[string]string{"surface": id})
		if err != nil {
			t.Fatal(err)
		}
		if got, err := askSurfaceWindow(t, f.shell, string(params)); err != nil || got != `{"space":null}` {
			t.Errorf("surface.window %s answered %s %v, want {\"space\":null}", params, got, err)
		}
	}
}

// A command that changes the layout writes the record workbench.layout.change with its name, its parameters, its answer and the stored
// layout after it, and a command that changes nothing writes none (docs/spec/events.json).
func TestALayoutCommandRecordsTheLayoutItLeaves(t *testing.T) {
	host := recordingCommands(&storedHost{installed: layoutPlugins, common: map[string]any{},
		projects: []map[string]any{gridProject(oneCard(tab("t1", "notes")))}})
	f := newTabShell(t, host)
	f.open(t)
	if _, err := f.apply("core.card.split", `{"card":"main","side":"right","plugin":"plain"}`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.apply("core.card.focus", `{"card":"main"}`); err != nil {
		t.Fatal(err)
	}
	f.settle()
	records := host.written("workbench.layout.change")
	if len(records) != 1 {
		t.Fatalf("the commands wrote %d records workbench.layout.change: %v", len(records), records)
	}
	fields := records[0]["fields"].(map[string]any)
	var layout struct {
		State struct {
			Root map[string]any `json:"root"`
		} `json:"state"`
	}
	if err := json.Unmarshal([]byte(fields["layout"].(string)), &layout); err != nil {
		t.Fatalf("the layout of the record is no JSON: %v", err)
	}
	cards := []struct{ ID string }{}
	for _, card := range treeCards(layout.State.Root) {
		cards = append(cards, struct{ ID string }{card["card"].(string)})
	}
	if fields["command"] != "core.card.split" || fields["params"] != `{"card":"main","side":"right","plugin":"plain"}` || fields["paramsTruncated"] != false ||
		!slices.ContainsFunc(cards, func(c struct{ ID string }) bool { return strings.Contains(fields["result"].(string), c.ID) }) ||
		fields["layoutTruncated"] != false {
		t.Fatalf("the record is %v", fields)
	}
}

// Every command that changes the layout writes one record workbench.layout.change, one that answers at once and one that answers in a
// later step, and a command that changes nothing writes none.
func TestEveryLayoutCommandRecordsTheLayout(t *testing.T) {
	host := recordingCommands(&storedHost{installed: layoutPlugins, common: map[string]any{},
		projects: []map[string]any{gridProject(oneCard(tab("t1", "notes")))}})
	f := newTabShell(t, host)
	f.open(t)
	if _, err := f.apply("core.layout.open", `{"card":"main","plugin":"plain","side":"right"}`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.apply("core.card.focus", `{"card":"main"}`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.apply("core.space.add", ``); err != nil {
		t.Fatal(err)
	}
	f.settle()
	spaces := host.projects[0]["spaces"].([]any)
	added := spaces[len(spaces)-1].(map[string]any)["id"].(string)
	closed := false
	f.shell.Registry().RunLater("core.space.close", json.RawMessage(`{"id":"`+added+`"}`), func(_ any, err error) {
		if err != nil {
			t.Fatal(err)
		}
		closed = true
	})
	f.settle()
	if !closed {
		t.Fatal("the close of the added space did not answer")
	}
	counts := map[string]int{}
	for _, record := range host.written("workbench.layout.change") {
		counts[record["fields"].(map[string]any)["command"].(string)]++
	}
	if want := map[string]int{"core.layout.open": 1, "core.space.add": 1, "core.space.close": 1}; !reflect.DeepEqual(counts, want) {
		t.Fatalf("the commands wrote the records %v, not %v", counts, want)
	}
}

// The end of a pointer drag of a divider runs core.boundary.move with the position where the drag ends, which writes its record
// workbench.layout.change as every command does: a continuous gesture has a command for its result (docs/spec/exposure.md).
func TestADividerDragEndsWithTheBoundaryCommand(t *testing.T) {
	host := recordingCommands(&storedHost{installed: layoutPlugins, common: map[string]any{},
		projects: []map[string]any{gridProject(oneCard(tab("t1", "notes")))}})
	f := newTabShell(t, host)
	f.open(t)
	answer, err := f.apply("core.card.split", `{"card":"main","side":"right","plugin":"plain"}`)
	if err != nil {
		t.Fatal(err)
	}
	var made struct{ Card string }
	if err := json.Unmarshal([]byte(answer), &made); err != nil {
		t.Fatal(err)
	}
	f.settle()
	bar, _ := f.divider("main", made.Card)
	x, y := bar.X+bar.W/2, bar.Y+bar.H/2
	f.tester.Move(x, y)
	f.tester.Press(x, y)
	f.tester.Frame()
	f.tester.Move(x-80, y)
	f.tester.Frame()
	f.tester.Release(x-80, y)
	f.settle()
	moves := []map[string]any{}
	for _, record := range host.written("workbench.layout.change") {
		if fields := record["fields"].(map[string]any); fields["command"] == "core.boundary.move" {
			moves = append(moves, fields)
		}
	}
	if len(moves) != 1 {
		t.Fatalf("the drag wrote %d records of core.boundary.move: %v", len(moves), moves)
	}
}

// An arrow key on a focused divider runs core.boundary.move with the position one step away, which writes its record
// workbench.layout.change as every command does.
func TestADividerKeyRunsTheBoundaryCommand(t *testing.T) {
	host := recordingCommands(&storedHost{installed: layoutPlugins, common: map[string]any{},
		projects: []map[string]any{gridProject(oneCard(tab("t1", "notes")))}})
	f := newTabShell(t, host)
	f.open(t)
	answer, err := f.apply("core.card.split", `{"card":"main","side":"right","plugin":"plain"}`)
	if err != nil {
		t.Fatal(err)
	}
	var made struct{ Card string }
	if err := json.Unmarshal([]byte(answer), &made); err != nil {
		t.Fatal(err)
	}
	f.settle()
	moves := func() int {
		count := 0
		for _, record := range host.written("workbench.layout.change") {
			if record["fields"].(map[string]any)["command"] == "core.boundary.move" {
				count++
			}
		}
		return count
	}
	// The divider takes the keys once the focus reaches it with Tab, as TestADividerTakesTheKeys finds it.
	for range 80 {
		if moves() > 0 {
			break
		}
		f.tester.Key(0, ui.KeyTab)
		f.settle()
		f.tester.Key(0, ui.KeyLeft)
		f.settle()
	}
	if moves := moves(); moves != 1 {
		t.Fatalf("the arrow key wrote %d records of core.boundary.move", moves)
	}
}

// A double click on a divider runs core.boundary.center, which centres its line and writes its record workbench.layout.change.
func TestADividerDoubleClickRunsTheCentreCommand(t *testing.T) {
	host := recordingCommands(&storedHost{installed: layoutPlugins, common: map[string]any{},
		projects: []map[string]any{gridProject(oneCard(tab("t1", "notes")))}})
	f := newTabShell(t, host)
	f.open(t)
	answer, err := f.apply("core.card.split", `{"card":"main","side":"right","plugin":"plain"}`)
	if err != nil {
		t.Fatal(err)
	}
	var made struct{ Card string }
	if err := json.Unmarshal([]byte(answer), &made); err != nil {
		t.Fatal(err)
	}
	if _, err := f.apply("core.boundary.move", `{"axis":"x","line":2,"position":300}`); err != nil {
		t.Fatal(err)
	}
	f.settle()
	bar, _ := f.divider("main", made.Card)
	x, y := bar.X+bar.W/2, bar.Y+bar.H/2
	f.tester.ClickAt(x, y)
	f.tester.ClickAt(x, y)
	f.settle()
	centres := 0
	for _, record := range host.written("workbench.layout.change") {
		if record["fields"].(map[string]any)["command"] == "core.boundary.center" {
			centres++
		}
	}
	if centres != 1 {
		t.Fatalf("the double click wrote %d records of core.boundary.center", centres)
	}
}

// The tabs that a shell creates are stored with the member role null, so the stored layout holds the member of every tab
// (docs/spec/agent-roles.md#tab-role-state).
func TestTheTabsOfANewSpaceAreStoredWithANullRole(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	f.shellFixture.run("core.space.add", nil)
	var stored []struct {
		Spaces []struct {
			ID     string `json:"id"`
			Layout struct {
				State struct {
					Root map[string]any `json:"root"`
				} `json:"state"`
			} `json:"layout"`
		} `json:"spaces"`
	}
	if err := json.Unmarshal([]byte(f.stored()), &stored); err != nil {
		t.Fatal(err)
	}
	tabs := 0
	for _, project := range stored {
		for _, space := range project.Spaces {
			if space.ID == "spc-aaaaaa" {
				continue
			}
			for _, card := range treeCards(space.Layout.State.Root) {
				data, _ := card["data"].(map[string]any)
				held, _ := data["tabs"].([]any)
				for _, entry := range held {
					item := entry.(map[string]any)
					tabs++
					role, has := item["role"]
					if !has {
						t.Errorf("the tab %v of the new space %s has no member role", item["id"], space.ID)
					} else if role != nil {
						t.Errorf("the tab %v of the new space %s stores the member role %v, want null", item["id"], space.ID, role)
					}
				}
			}
		}
	}
	if tabs == 0 {
		t.Fatal("the new space holds no tab to check")
	}
}

// The tabs of a new space are written with their origin, null for the first tabs of a space, which have no source tab, so every tab of
// the stored layout carries the member that the layout write that created it wrote (docs/spec/projects.md#tab-origin).
func TestTheTabsOfANewSpaceAreStoredWithANullOrigin(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	f.shellFixture.run("core.space.add", nil)
	var stored []struct {
		Spaces []struct {
			ID     string `json:"id"`
			Layout struct {
				State struct {
					Root map[string]any `json:"root"`
				} `json:"state"`
			} `json:"layout"`
		} `json:"spaces"`
	}
	if err := json.Unmarshal([]byte(f.stored()), &stored); err != nil {
		t.Fatal(err)
	}
	tabs := 0
	for _, project := range stored {
		for _, space := range project.Spaces {
			if space.ID == "spc-aaaaaa" {
				continue
			}
			for _, card := range treeCards(space.Layout.State.Root) {
				// A window sidebar has no data, so it holds no tabs.
				data, _ := card["data"].(map[string]any)
				held, _ := data["tabs"].([]any)
				for _, entry := range held {
					item := entry.(map[string]any)
					tabs++
					if origin, ok := item["origin"].(map[string]any); !ok || origin["directory"] != nil || len(origin) != 1 {
						t.Errorf("the tab %v of the new space %s is stored with the origin %v", item["id"], space.ID, item["origin"])
					}
				}
			}
		}
	}
	if tabs == 0 {
		t.Fatalf("the new space holds no tab: %s", f.stored())
	}
}
