// I3, I4, I5, I6 and I9 of docs/spec/groups.md#invariants on the mygo workbench, over layouts that a seeded generator makes from three
// cards in a row, the first two in a group card, as the page check packages/workbench/test/group-drop-invariants.test.mjs makes them.
package workbench_test

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// dropSteps the number of steps that build each, and dropPointStep the step in points of
// the grid of points over the window at which each drop is resolved.
const (
	dropSteps     = 6
	dropPointStep = 50
	dropWidth     = 1000
	dropHeight    = 640
)

// mulberry32 is the seeded generator of the page check and of the invariant checks of the layout library. The Go standard library
// has seeded generators, but none that repeats the sequence of the page check, so the test carries this one function to make the
// layouts of the page from their seeds.
func mulberry32(seed uint32) func() float64 {
	state := seed
	return func() float64 {
		state += 0x6d2b79f5
		t := (state ^ (state >> 15)) * (1 | state)
		t = (t + (t^(t>>7))*(61|t)) ^ t
		return float64(t^(t>>14)) / 4294967296
	}
}

// dropLayout is a generated layout: its stored layout, the steps that it refused, and the sources of its drops.
type dropLayout struct {
	stored  map[string]any
	refused int
	sources []dropSource
}

// dropSource is a tab, with the card that holds it, or a group card, whose drag is judged; alone tells that it moves its card whole.
type dropSource struct {
	id, card     string
	group, alone bool
}

// dropStart is the space of the generation: card-1 and card-2 in the group card card-4 beside card-3.
func dropStart() map[string]any {
	return map[string]any{"id": "spc-aaaaaa", "title": "spc-aaaaaa", "layout": map[string]any{"leader": "card-4", "lastCard": 4,
		"state": map[string]any{"root": cutNode("x",
			kidNode(0.75, boxNode("card-4", "그룹 1", "card-1", cutNode("x",
				kidNode(0.5, cardNode("card-1", tab("tab-aaaaa1", "plain"))),
				kidNode(0.5, cardNode("card-2", tab("tab-aaaaa2", "plain")))))),
			kidNode(0.25, cardNode("card-3", tab("tab-aaaaa3", "plain"))))}}}
}

// dropShell is a layout shell that shows the stored layout at the size of the check.
func dropShell(t *testing.T, stored map[string]any) *tabShell {
	t.Helper()
	f := layoutShell(t, map[string]any{"id": "spc-aaaaaa", "title": "spc-aaaaaa", "layout": stored})
	f.tester.SetSize(dropWidth, dropHeight)
	f.settle()
	return f
}

// storedLayout is the stored layout of core.layout: its tree, its leader and lastCard.
func (f *tabShell) storedLayout() map[string]any {
	f.t.Helper()
	read := f.read("core.layout")
	return map[string]any{"state": read["state"], "leader": read["leader"], "lastCard": read["lastCard"]}
}

// generatedLayout builds the layout of seed: each step splits a content card, groups it, or adds a tab to it, chosen by the generator;
// a step that the layout refuses is counted and leaves the layout as it was.
func generatedLayout(t *testing.T, seed uint32) dropLayout {
	t.Helper()
	f := layoutShell(t, dropStart())
	f.tester.SetSize(dropWidth, dropHeight)
	f.settle()
	next := mulberry32(seed)
	pick := func(list []string) string { return list[int(next()*float64(len(list)))] }
	sides := []string{"left", "right", "top", "bottom"}
	refused := 0
	for range dropSteps {
		card := pick(f.contentCards())
		kind := next()
		var name string
		var params map[string]string
		switch {
		case kind < 0.45:
			name, params = "core.card.split", map[string]string{"card": card, "side": pick(sides), "plugin": "plain"}
		case kind < 0.7:
			name, params = "core.group.create", map[string]string{"card": card, "side": pick(sides), "plugin": "plain"}
		default:
			name, params = "core.card.add-tab", map[string]string{"card": card, "plugin": "plain"}
		}
		text, err := json.Marshal(params)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.apply(name, string(text)); err != nil {
			refused++ // a refused step is a layout that the rule does not allow; the count is reported with the failures.
		}
	}
	made := dropLayout{stored: f.storedLayout(), refused: refused}
	held := cardTabs(made.stored)
	for _, card := range f.contentCards() {
		for _, id := range held[card] {
			made.sources = append(made.sources, dropSource{id: id, card: card, alone: len(held[card]) == 1})
		}
	}
	for _, group := range f.groupCards() {
		made.sources = append(made.sources, dropSource{id: group, card: group, group: true, alone: true})
	}
	return made
}

// contentCards are the content cards of core.grid in its order.
func (f *tabShell) contentCards() []string {
	f.t.Helper()
	cards := []string{}
	for _, card := range f.read("core.grid")["cards"].([]any) {
		cards = append(cards, card.(map[string]any)["id"].(string))
	}
	return cards
}

// groupCards are the group cards of core.grid in its order.
func (f *tabShell) groupCards() []string {
	f.t.Helper()
	groups := []string{}
	listed, _ := f.read("core.grid")["groups"].([]any) // a grid without group cards lists none.
	for _, group := range listed {
		groups = append(groups, group.(map[string]any)["id"].(string))
	}
	return groups
}

// press presses the tab or the header of the group card of source.
func (f *tabShell) press(source dropSource) {
	f.t.Helper()
	var x, y float32
	if source.group {
		box := f.box("core.group.header", source.id)
		x, y = box.X+30, box.Y+box.H/2
	} else {
		box := f.box("core.card.tab", source.id)
		x, y = box.X+box.W/2, box.Y+box.H/2
	}
	f.tester.Move(x, y)
	f.tester.Frame()
	f.tester.Press(x, y)
	f.tester.Frame()
}

// dropHit is a distinct target of a drag with the first point that selects it.
type dropHit struct {
	key  string
	x, y float32
}

// gridPoints are the points of the grid over the window at the step of the check.
func gridPoints() [][2]float32 {
	points := [][2]float32{}
	for y := float32(dropPointStep / 2); y < dropHeight; y += dropPointStep {
		for x := float32(dropPointStep / 2); x < dropWidth; x += dropPointStep {
			points = append(points, [2]float32{x, y})
		}
	}
	return points
}

// distinctHits are the distinct targets of the drag of source over the points, each with the first point that selects it.
func (f *tabShell) distinctHits(t *testing.T, source dropSource, points [][2]float32) []dropHit {
	f.t.Helper()
	f.press(source)
	hits := []dropHit{}
	seen := map[string]bool{}
	for _, point := range points {
		f.tester.Move(point[0], point[1])
		f.tester.Frame()
		drag := status[*dragRead](t, f.shellFixture, "core.drag")
		if drag == nil || drag.Target == nil {
			continue
		}
		if key := targetKey(drag); !seen[key] {
			seen[key] = true
			hits = append(hits, dropHit{key: key, x: point[0], y: point[1]})
		}
		// The pointer leaves the window between two points, so the target of each point is the target of a drag that enters the window
		// there, with no anchor of an earlier point (docs/spec/groups.md#target-search), as the drop of dropAt reaches it.
		f.tester.Move(-100, -100)
		f.tester.Frame()
	}
	f.tester.Move(-100, -100)
	f.tester.Frame()
	f.tester.Release(-100, -100)
	f.settle()
	return hits
}

// targetKey is the target of a drag as text.
func targetKey(drag *dragRead) string {
	text, _ := json.Marshal(drag.Target) // silent: a target of strings and a number has a JSON form.
	return string(text)
}

// groupCardsOf are the group cards of the stored layout.
func (f *tabShell) groupCardsOf(stored map[string]any) []string {
	out := []string{}
	var visit func(n map[string]any)
	visit = func(n map[string]any) {
		if kids, ok := n["kids"].([]any); ok {
			for _, kid := range kids {
				visit(kid.(map[string]any)["node"].(map[string]any))
			}
		}
		if inner, ok := n["inner"].(map[string]any); ok {
			out = append(out, n["box"].(string))
			visit(inner)
		}
	}
	visit(stored["state"].(map[string]any)["root"].(map[string]any))
	return out
}

// cardTabs are the ids of the tabs of each content card of the stored layout, in their order.
func cardTabs(stored map[string]any) map[string][]string {
	out := map[string][]string{}
	var visit func(n map[string]any)
	visit = func(n map[string]any) {
		if kids, ok := n["kids"].([]any); ok {
			for _, kid := range kids {
				visit(kid.(map[string]any)["node"].(map[string]any))
			}
			return
		}
		if inner, ok := n["inner"].(map[string]any); ok {
			visit(inner)
			return
		}
		ids := []string{}
		data, _ := n["data"].(map[string]any) // an empty card stores no data and holds no tab.
		tabs, _ := data["tabs"].([]any)
		for _, held := range tabs {
			ids = append(ids, held.(map[string]any)["id"].(string))
		}
		out[n["card"].(string)] = ids
	}
	visit(stored["state"].(map[string]any)["root"].(map[string]any))
	return out
}

// storedTabs are the tabs of the stored tree: the id of each tab with its plugin and its params, in no order.
func storedTabs(node map[string]any) map[string]string {
	out := map[string]string{}
	var visit func(n map[string]any)
	visit = func(n map[string]any) {
		if kids, ok := n["kids"].([]any); ok {
			for _, kid := range kids {
				visit(kid.(map[string]any)["node"].(map[string]any))
			}
			return
		}
		if inner, ok := n["inner"].(map[string]any); ok {
			visit(inner)
			return
		}
		data, _ := n["data"].(map[string]any) // an empty card stores no data and holds no tab.
		tabs, _ := data["tabs"].([]any)
		for _, held := range tabs {
			entry := held.(map[string]any)
			text, _ := json.Marshal([]any{entry["plugin"], entry["params"]}) // silent: stored values have a JSON form.
			out[entry["id"].(string)] = string(text)
		}
	}
	visit(node)
	return out
}

// vacates tells whether the target and the zone of a drag name the vacated slot of the card, read from the stored layout
// (docs/spec/groups.md#vacated-slot).
func vacates(t *testing.T, stored map[string]any, card string, target layout.Target, zone string) bool {
	t.Helper()
	text, err := json.Marshal(stored["state"])
	if err != nil {
		t.Fatal(err)
	}
	var state layout.State
	if err := json.Unmarshal(text, &state); err != nil {
		t.Fatal(err)
	}
	leader, _ := json.Marshal(stored["leader"])
	last, _ := json.Marshal(stored["lastCard"])
	grid, err := layout.New(nil, layout.Options{})
	if err != nil {
		t.Fatal(err)
	}
	tree, err := layout.ReadTree(state, nil, leader, last, layout.GroupOptions{}, grid)
	if err != nil {
		t.Fatal(err)
	}
	return tree.Grid().Vacates(card, target, zone)
}

// dropTarget is a target of a drop in the form of the target of core.drag.
type dropTarget struct {
	Card  layout.Target `json:"card"`
	Zone  string        `json:"zone"`
	Index *int          `json:"index"`
}

// key is the target as text, in the form of targetKey.
func (target dropTarget) key() string {
	text, _ := json.Marshal(target) // silent: a target of strings and a number has a JSON form.
	return string(text)
}

// moveCommand is the command that the release of the drag of source on target runs, with its params as JSON.
func moveCommand(t *testing.T, source dropSource, target dropTarget) (string, string) {
	t.Helper()
	name, params := "core.tab.move", map[string]any{"tab": source.id, "card": target.Card, "zone": target.Zone}
	if target.Index != nil {
		params["index"] = *target.Index
	}
	if source.group {
		name, params = "core.card.move", map[string]any{"card": source.id, "target": target.Card, "side": target.Zone}
	}
	text, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	return name, string(text)
}

// dropAt drops source at x, y through the pointer and judges the drop: the preview of core.drag is the drawn rectangle of the card that
// holds the tab, or of the group card, after the release (I3); the drop keeps every tab with its plugin and params (I5); a drop on the
// vacated slot of a card that moves whole changes nothing (I6); and the command of the release, run again with the same identifiers,
// changes nothing (I9). It returns the failures.
func (f *tabShell) dropAt(t *testing.T, source dropSource, hit dropHit) []string {
	f.t.Helper()
	before := f.storedLayout()
	f.press(source)
	f.tester.Move(hit.x, hit.y)
	f.tester.Frame()
	drag := status[*dragRead](t, f.shellFixture, "core.drag")
	where := fmt.Sprintf("%s %s at %v, %v", source.id, hit.key, hit.x, hit.y)
	if drag == nil || drag.Target == nil || targetKey(drag) != hit.key {
		f.tester.Release(-100, -100)
		f.settle()
		return []string{fmt.Sprintf("I3 %s: the drag shows %+v", where, drag)}
	}
	vacated := source.alone && vacates(t, before, source.card, drag.Target.Card, drag.Target.Zone)
	// The pointer leaves the window, so the release runs nothing, and the command that the release runs is run with the target of the
	// drag, so that its reply is read.
	f.tester.Move(-100, -100)
	f.tester.Frame()
	f.tester.Release(-100, -100)
	f.settle()
	name, text := moveCommand(t, source, dropTarget{Card: drag.Target.Card, Zone: drag.Target.Zone, Index: drag.Target.Index})
	reply, err := f.apply(name, text)
	if err != nil {
		f.t.Fatalf("%s: %s %s failed with %v", where, name, text, err)
	}
	after := f.storedLayout()
	failures := []string{}
	holder := source.id
	if !source.group {
		for card, tabs := range cardTabs(after) {
			if slices.Contains(tabs, source.id) {
				holder = card
			}
		}
	}
	rect := f.gridCards()[holder]
	if drag.Preview == nil || rect == nil {
		failures = append(failures, fmt.Sprintf("I3 %s: preview %+v, result %v", where, drag.Preview, rect))
	} else {
		got := [4]float64{drag.Preview.X, drag.Preview.Y, drag.Preview.W, drag.Preview.H}
		want := [4]float64{rect["x"].(float64), rect["y"].(float64), rect["w"].(float64), rect["h"].(float64)}
		for i := range got {
			if math.Abs(got[i]-want[i]) > 1e-6 {
				failures = append(failures, fmt.Sprintf("I3 %s: preview %v, result %v", where, got, want))
				break
			}
		}
	}
	root := func(stored map[string]any) map[string]any {
		return stored["state"].(map[string]any)["root"].(map[string]any)
	}
	if kept, now := storedTabs(root(before)), storedTabs(root(after)); !reflect.DeepEqual(kept, now) {
		failures = append(failures, fmt.Sprintf("I5 %s: the tabs %v became %v", where, kept, now))
	}
	if vacated && !reflect.DeepEqual(after, before) {
		failures = append(failures, fmt.Sprintf("I6 %s: the drop on the vacated slot changed the layout", where))
	}
	// A move to the centre of a content card is an exchange, a toggle that no repeat can find, so I9 does not judge it; every other
	// command is repeated with the identifiers of its reply (docs/spec/groups.md#idempotency).
	exchange := source.group && drag.Target.Zone == "centre" && !slices.Contains(f.groupCardsOf(before), drag.Target.Card[0])
	if !exchange {
		if again, err := f.apply(name, reply); err != nil {
			failures = append(failures, fmt.Sprintf("I9 %s: the repeat of %s with its reply %s failed with %v", where, name, reply, err))
		} else if again != reply || !reflect.DeepEqual(f.storedLayout(), after) {
			failures = append(failures, fmt.Sprintf("I9 %s: the repeat of %s with its reply %s answered %s and changed the layout: %v",
				where, name, reply, again, !reflect.DeepEqual(f.storedLayout(), after)))
		}
	}
	return failures
}

// checkDrops judges the drops over the generated layout of seed: for every tab that its card draws and every group card, and every
// distinct target of the points of the window, the preview of the drop is its result (I3), the drop keeps every tab (I5), a drop on
// the vacated slot changes nothing (I6) and the command of the release is idempotent (I9) (docs/spec/groups.md#invariants). The grid
// of points is read once, by the drag of the first tab and of the first group card; each source reads its distinct targets at the
// points that select a target for either of them, and each drop starts from a new shell of the layout.
func checkDrops(t *testing.T, seed uint32) {
	made := generatedLayout(t, seed)
	f := dropShell(t, made.stored)
	drawn := []dropSource{}
	for _, source := range made.sources {
		if source.group {
			drawn = append(drawn, source)
		} else if box := f.box("core.card.tab", source.id); box.W > 0 {
			drawn = append(drawn, source) // a tab of a strip too narrow for its tabs is not drawn and is no source of a pointer drag.
		}
	}
	points := [][2]float32{}
	for _, first := range []func(dropSource) bool{
		func(source dropSource) bool { return !source.group },
		func(source dropSource) bool { return source.group },
	} {
		if at := slices.IndexFunc(drawn, first); at >= 0 {
			for _, hit := range dropShell(t, made.stored).distinctHits(t, drawn[at], gridPoints()) {
				points = append(points, [2]float32{hit.x, hit.y})
			}
		}
	}
	failures, drops := []string{}, 0
	for _, source := range drawn {
		hits := dropShell(t, made.stored).distinctHits(t, source, points)
		drops += len(hits)
		for _, hit := range hits {
			failures = append(failures, dropShell(t, made.stored).dropAt(t, source, hit)...)
		}
	}
	if drops == 0 {
		t.Fatal("no drop was judged")
	}
	if len(failures) > 0 {
		t.Fatalf("%d failures over %d drops of %d sources (%d generated steps refused):\n%s", len(failures), drops, len(drawn),
			made.refused, strings.Join(failures, "\n"))
	}
}

func TestDropsOverTheGeneratedLayoutOfSeed1HoldTheirInvariants(t *testing.T) { checkDrops(t, 1) }

func TestDropsOverTheGeneratedLayoutOfSeed2HoldTheirInvariants(t *testing.T) { checkDrops(t, 2) }

func TestDropsOverTheGeneratedLayoutOfSeed3HoldTheirInvariants(t *testing.T) { checkDrops(t, 3) }

// requiredTargets are the targets that I4 requires of the drag of source over the stored layout (docs/spec/groups.md#invariants):
// every side of every node of the tree, a card by its id, a group card by the id of its box and a cut by its members, its window
// sidebars left out, except a side along the axis of a cut (docs/spec/groups.md#target-search); the centre of every content card; and, for a tab, every index of the tab
// strip of every content card, the moving tab left out. Each vacated slot is among them as a side of the moving node.
func requiredTargets(stored map[string]any, source dropSource) []dropTarget {
	targets := []dropTarget{}
	seen := map[string]bool{}
	add := func(target dropTarget) {
		if key := target.key(); !seen[key] {
			seen[key] = true
			targets = append(targets, target)
		}
	}
	var members func(n map[string]any) layout.Target
	members = func(n map[string]any) layout.Target {
		switch {
		case n["card"] != nil:
			if fixed, _ := n["fixed"].(bool); fixed {
				return nil
			}
			return layout.Target{n["card"].(string)}
		case n["box"] != nil:
			return layout.Target{n["box"].(string)}
		}
		out := layout.Target{}
		for _, kid := range n["kids"].([]any) {
			out = append(out, members(kid.(map[string]any)["node"].(map[string]any))...)
		}
		return out
	}
	held := cardTabs(stored)
	var visit func(n map[string]any)
	visit = func(n map[string]any) {
		if named := members(n); len(named) > 0 {
			for _, side := range []string{"left", "right", "top", "bottom"} {
				// A cut along the axis of side is the target of its kid toward side (packages/soksak/docs/layout.md), and the
				// members of such a cut name the run of all its kids, which no line of a drag holds; its kids are visited.
				along := n["cut"] == "x" && (side == "left" || side == "right") || n["cut"] == "y" && (side == "top" || side == "bottom")
				if !along {
					add(dropTarget{Card: named, Zone: side})
				}
			}
		}
		switch {
		case n["card"] != nil:
			if fixed, _ := n["fixed"].(bool); fixed {
				return
			}
			card := n["card"].(string)
			add(dropTarget{Card: layout.Target{card}, Zone: "centre"})
			if !source.group {
				count := len(held[card])
				if slices.Contains(held[card], source.id) {
					count--
				}
				for index := range count + 1 {
					add(dropTarget{Card: layout.Target{card}, Zone: "strip", Index: &index})
				}
			}
		case n["box"] != nil:
			visit(n["inner"].(map[string]any))
		default:
			for _, kid := range n["kids"].([]any) {
				visit(kid.(map[string]any)["node"].(map[string]any))
			}
		}
	}
	visit(stored["state"].(map[string]any)["root"].(map[string]any))
	return targets
}

// probe is the drag of a source over the window: the targets that it selected by their keys.
type probe struct {
	t       *testing.T
	f       *tabShell
	reached map[string]dropTarget
}

// at moves the drag to x, y, from outside the window when fresh so that no anchor of an earlier point stays, and returns the target
// that the drag shows there.
func (p *probe) at(x, y float32, fresh bool) *dropTarget {
	if x < 0 || y < 0 || x >= dropWidth || y >= dropHeight {
		return nil
	}
	if fresh {
		p.f.tester.Move(-100, -100)
	}
	p.f.tester.Move(x, y)
	drag := status[*dragRead](p.t, p.f.shellFixture, "core.drag")
	if drag == nil || drag.Target == nil {
		return nil
	}
	target := dropTarget{Card: drag.Target.Card, Zone: drag.Target.Zone, Index: drag.Target.Index}
	p.reached[target.key()] = target
	return &target
}

// slide moves the drag from x, y along the line of its band to both ends of the window, with the direction ux, uy along the line, so
// the anchor of the band where it entered selects the runs of its cut; it enters x, y again at the end.
func (p *probe) slide(x, y, ux, uy float32) {
	for _, way := range []float32{-1, 1} {
		p.at(x, y, true)
		for step := float32(dropPointStep); ; step += dropPointStep {
			ax, ay := x+way*step*ux, y+way*step*uy
			if ax < 0 || ay < 0 || ax >= dropWidth || ay >= dropHeight {
				break
			}
			p.at(ax, ay, false)
		}
	}
	p.at(x, y, true)
}

// reachedTargets are the targets that the drag of source selects over the drawn layout (docs/spec/groups.md#target-search). From the
// middle of each side of each content card and group card, the drag moves inward a point at a time from 16 points outside the line,
// so it enters every band of the side stack and of the boxes around the card, until it reaches the centre of the card or stays on one
// target or on none for 12 points inside the line. From each band that it enters first, the drag moves along that line to both ends of
// the window, which keeps the anchor of the band, so the anchor selects the runs of its cut. The drag enters the centre of each content
// card, and the drag of a tab moves along the tab strip of each content card 4 points at a time.
func (f *tabShell) reachedTargets(t *testing.T, source dropSource) map[string]dropTarget {
	t.Helper()
	p := &probe{t: t, f: f, reached: map[string]dropTarget{}}
	strip := float32(-1)
	for card, tabs := range cardTabs(f.storedLayout()) {
		for _, id := range tabs {
			if box := f.box("core.card.tab", id); box.W > 0 {
				strip = box.Y + box.H/2 - f.box("core.card", card).Y
			}
		}
	}
	// The drawn rectangle of a group card is that of core.grid moved by the offset of the plane, which the rectangle of a content
	// card in the window and in core.grid tells.
	cards, rects := f.gridCards(), map[string]ui.Rect{}
	for _, id := range f.contentCards() {
		rects[id] = f.box("core.card", id)
	}
	first := f.contentCards()[0]
	dx, dy := rects[first].X-float32(cards[first]["x"].(float64)), rects[first].Y-float32(cards[first]["y"].(float64))
	for _, id := range f.groupCards() {
		rects[id] = ui.Rect{X: float32(cards[id]["x"].(float64)) + dx, Y: float32(cards[id]["y"].(float64)) + dy,
			W: float32(cards[id]["w"].(float64)), H: float32(cards[id]["h"].(float64))}
	}
	f.press(source)
	slid := map[string]bool{}
	for _, id := range append(f.contentCards(), f.groupCards()...) {
		rect := rects[id]
		// Each side: the middle of its line, the inward direction and the distance from the line to the centre.
		for _, side := range []struct{ x, y, dx, dy, length float32 }{
			{rect.X + rect.W/2, rect.Y, 0, 1, rect.H / 2},
			{rect.X + rect.W/2, rect.Y + rect.H, 0, -1, rect.H / 2},
			{rect.X, rect.Y + rect.H/2, 1, 0, rect.W / 2},
			{rect.X + rect.W, rect.Y + rect.H/2, -1, 0, rect.W / 2},
		} {
			// The drag moves inward from a gap outside the line, so it enters each band of the side stack in turn, until it
			// reaches the centre of the card or, inside the line, stays for 12 points on one target of that side or on no
			// target, the edge share of the card or a node that the drag cannot enter. A tab strip or a group header between
			// the line and the bands is passed.
			name := [...]string{"top", "bottom", "left", "right"}[slices.Index([]float32{side.dy, -side.dy, side.dx, -side.dx}, 1)]
			same, last := 0, "passed"
		scan:
			for d := float32(-16); d < side.length && same < 12; d++ {
				x, y := side.x+side.dx*(d+0.5), side.y+side.dy*(d+0.5)
				target := p.at(x, y, d == -16)
				key := "" // no target: a point in no card, or a target that the drag cannot enter.
				switch {
				case target == nil:
				case target.Zone == "centre":
					break scan
				case target.Zone != name:
					key = "passed"
				default:
					key = target.key()
					if !slid[key] {
						slid[key] = true
						p.slide(x, y, side.dy*side.dy, side.dx*side.dx)
					}
				}
				if d >= 0 && key != "passed" && key == last {
					same++
				} else {
					same, last = 0, key
				}
			}
		}
		if slices.Contains(f.groupCards(), id) {
			continue
		}
		p.at(rect.X+rect.W/2, rect.Y+rect.H/2, true)
		if !source.group && strip >= 0 {
			p.at(rect.X+1, rect.Y+strip, true)
			for x := rect.X + 1; x < rect.X+rect.W; x += 4 {
				p.at(x, rect.Y+strip, false)
			}
		}
	}
	f.tester.Move(-100, -100)
	f.tester.Release(-100, -100)
	f.settle()
	return p.reached
}

// checkReach judges I4 over the generated layout of seed (docs/spec/groups.md#invariants) for the source of kind: the source
// of "group" is the first group card, of "alone" the first drawn tab that is the only tab of its card, and of "shared" the first drawn tab
// that shares its card. Each required target is selected by the drag, or its result equals the result of a target that the drag
// selects, the results compared as the stored layouts after the command of the release; a target whose command is refused has no
// result and is not required.
func checkReach(t *testing.T, seed uint32, kind string) {
	made := generatedLayout(t, seed)
	f := dropShell(t, made.stored)
	failures, required := []string{}, 0
	text, err := json.Marshal(made.stored)
	if err != nil {
		t.Fatal(err)
	}
	current := string(text)
	sources := []dropSource{}
	for _, source := range made.sources {
		switch {
		case !source.group && f.box("core.card.tab", source.id).W == 0:
			// a tab of a strip too narrow for its tabs is not drawn and is no source of a pointer drag.
		case kind == "group" && source.group && len(sources) == 0,
			kind == "alone" && !source.group && source.alone && len(sources) == 0,
			kind == "shared" && !source.group && !source.alone && len(sources) == 0:
			sources = append(sources, source)
		}
	}
	if len(sources) == 0 {
		t.Fatalf("the generated layout of seed %d has no %s source", seed, kind)
	}
	for _, source := range sources {
		reached := dropShell(t, made.stored).reachedTargets(t, source)
		results := map[string]string{}
		result := func(target dropTarget) string {
			key := target.key()
			if got, ok := results[key]; ok {
				return got
			}
			name, text := moveCommand(t, source, target)
			shell := dropShell(t, made.stored)
			if _, err := shell.apply(name, text); err != nil {
				results[key] = ""
				return ""
			}
			stored, err := json.Marshal(shell.storedLayout())
			if err != nil {
				t.Fatal(err)
			}
			results[key] = string(stored)
			return results[key]
		}
		keys := slices.Sorted(func(yield func(string) bool) {
			for key := range reached {
				if !yield(key) {
					return
				}
			}
		})
		for _, target := range requiredTargets(made.stored, source) {
			if _, ok := reached[target.key()]; ok {
				required++
				continue
			}
			want := result(target)
			if want == "" {
				continue
			}
			required++
			// The reached targets of the same zone are compared first, because a merged band is mostly a node of the same side.
			order := slices.Clone(keys)
			slices.SortStableFunc(order, func(a, b string) int {
				return boolRank(reached[a].Zone != target.Zone) - boolRank(reached[b].Zone != target.Zone)
			})
			if !slices.ContainsFunc(order, func(key string) bool { return result(reached[key]) == want }) {
				failures = append(failures, fmt.Sprintf("I4 %s: no anchor and point select %s or a target of its result %s; the layout is %s, which differs at %s",
					source.id, target.key(), outline(want), outline(current), difference(want, current)))
			}
		}
	}
	if required == 0 {
		t.Fatal("no target was required")
	}
	if len(failures) > 0 {
		t.Fatalf("%d failures over %d required targets (%d generated steps refused):\n%s", len(failures), required, made.refused,
			strings.Join(failures, "\n"))
	}
}

// outline is the tree of a stored layout as JSON in short form: a card by its id, a box by its id and inner node, and a cut by its axis
// and its kids with their shares to two places.
func outline(stored string) string {
	if stored == "" {
		return "refused"
	}
	var read map[string]any
	if err := json.Unmarshal([]byte(stored), &read); err != nil {
		return err.Error()
	}
	var short func(n map[string]any) string
	short = func(n map[string]any) string {
		switch {
		case n["card"] != nil:
			return n["card"].(string)
		case n["box"] != nil:
			return n["box"].(string) + "{" + short(n["inner"].(map[string]any)) + "}"
		}
		kids := []string{}
		for _, kid := range n["kids"].([]any) {
			entry := kid.(map[string]any)
			kids = append(kids, fmt.Sprintf("%.2f %s", entry["share"], short(entry["node"].(map[string]any))))
		}
		return n["cut"].(string) + "(" + strings.Join(kids, ", ") + ")"
	}
	return short(read["state"].(map[string]any)["root"].(map[string]any))
}

// difference is the first path at which two stored layouts as JSON differ, with the two values there.
func difference(a, b string) string {
	var left, right any
	if json.Unmarshal([]byte(a), &left) != nil || json.Unmarshal([]byte(b), &right) != nil {
		return "a value that is no JSON"
	}
	var walk func(path string, x, y any) string
	walk = func(path string, x, y any) string {
		switch xv := x.(type) {
		case map[string]any:
			yv, ok := y.(map[string]any)
			if !ok {
				break
			}
			keys := slices.Sorted(func(yield func(string) bool) {
				for key := range xv {
					if !yield(key) {
						return
					}
				}
				for key := range yv {
					if _, ok := xv[key]; !ok && !yield(key) {
						return
					}
				}
			})
			for _, key := range keys {
				if found := walk(path+"."+key, xv[key], yv[key]); found != "" {
					return found
				}
			}
			return ""
		case []any:
			yv, ok := y.([]any)
			if !ok || len(xv) != len(yv) {
				break
			}
			for i := range xv {
				if found := walk(fmt.Sprintf("%s[%d]", path, i), xv[i], yv[i]); found != "" {
					return found
				}
			}
			return ""
		}
		if reflect.DeepEqual(x, y) {
			return ""
		}
		return fmt.Sprintf("%s: %v and %v", path, x, y)
	}
	return walk("", left, right)
}

// boolRank is 1 for true and 0 for false.
func boolRank(value bool) int {
	if value {
		return 1
	}
	return 0
}

func TestDropTargetsOfAGroupCardOverTheGeneratedLayoutOfSeed1AreReachable(t *testing.T) {
	checkReach(t, 1, "group")
}

func TestDropTargetsOfAGroupCardOverTheGeneratedLayoutOfSeed2AreReachable(t *testing.T) {
	checkReach(t, 2, "group")
}

func TestDropTargetsOfAGroupCardOverTheGeneratedLayoutOfSeed3AreReachable(t *testing.T) {
	checkReach(t, 3, "group")
}

func TestDropTargetsOfTheOnlyTabOverTheGeneratedLayoutOfSeed1AreReachable(t *testing.T) {
	checkReach(t, 1, "alone")
}

func TestDropTargetsOfTheOnlyTabOverTheGeneratedLayoutOfSeed2AreReachable(t *testing.T) {
	checkReach(t, 2, "alone")
}

func TestDropTargetsOfTheOnlyTabOverTheGeneratedLayoutOfSeed3AreReachable(t *testing.T) {
	checkReach(t, 3, "alone")
}

func TestDropTargetsOfASharedTabOverTheGeneratedLayoutOfSeed1AreReachable(t *testing.T) {
	checkReach(t, 1, "shared")
}

func TestDropTargetsOfASharedTabOverTheGeneratedLayoutOfSeed2AreReachable(t *testing.T) {
	checkReach(t, 2, "shared")
}

func TestDropTargetsOfASharedTabOverTheGeneratedLayoutOfSeed3AreReachable(t *testing.T) {
	checkReach(t, 3, "shared")
}
