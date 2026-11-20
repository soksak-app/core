// I3, I5, I6 and I9 of docs/spec/groups.md#invariants on the mygo workbench, over layouts that a seeded generator makes from three
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
	name, params := "core.tab.move", map[string]any{"tab": source.id, "card": drag.Target.Card, "zone": drag.Target.Zone}
	if drag.Target.Index != nil {
		params["index"] = *drag.Target.Index
	}
	if source.group {
		name, params = "core.card.move", map[string]any{"card": source.id, "target": drag.Target.Card, "side": drag.Target.Zone}
	}
	text, err := json.Marshal(params)
	if err != nil {
		f.t.Fatal(err)
	}
	reply, err := f.apply(name, string(text))
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
