// The commands, statuses and queries of group cards in the mygo workbench (docs/spec/groups.md): core.group.*, core.card.move, the card
// commands on a group card, core.layout, core.grid, the window description and core.card.get.
package workbench_test

import (
	"encoding/json"
	"math"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// groupedShell is a layout shell whose card main is wrapped into the group card-2 with the new card card-3 on its right.
func groupedShell(t *testing.T) *tabShell {
	t.Helper()
	f := layoutShell(t, oneCard(tab("t1", "notes")))
	if _, err := f.apply("core.group.create", `{"card": "main", "side": "right", "plugin": "plain"}`); err != nil {
		t.Fatal(err)
	}
	return f
}

// jsonOf is value as a reader of its JSON receives it.
func jsonOf(t testing.TB, value any) any {
	t.Helper()
	text, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var read any
	if err := json.Unmarshal(text, &read); err != nil {
		t.Fatal(err)
	}
	return read
}

// read is the value of the status name as JSON.
func (f *tabShell) read(name string) map[string]any {
	f.t.Helper()
	value, err := f.shell.Registry().Read(name)
	if err != nil {
		f.t.Fatal(err)
	}
	return jsonOf(f.t, value).(map[string]any)
}

// cardGet runs core.card.get on card and returns its state, or its error.
func (f *tabShell) cardGet(card string) (map[string]any, error) {
	f.t.Helper()
	var (
		value    any
		failure  error
		answered bool
	)
	params, err := json.Marshal(map[string]string{"card": card})
	if err != nil {
		f.t.Fatal(err)
	}
	f.shell.Registry().RunLater("core.card.get", params, func(result any, err error) { value, failure, answered = result, err, true })
	f.until(func() bool { return answered })
	if failure != nil {
		return nil, failure
	}
	return jsonOf(f.t, value).(map[string]any), nil
}

// gridCards are the cards of core.grid by id.
func (f *tabShell) gridCards() map[string]map[string]any {
	f.t.Helper()
	cards := map[string]map[string]any{}
	grid := f.read("core.grid")
	groups, _ := grid["groups"].([]any) // the cards of the grid and its group cards, by id.
	for _, card := range append(grid["cards"].([]any), groups...) {
		entry := card.(map[string]any)
		cards[entry["id"].(string)] = entry
	}
	return cards
}

func TestAGroupCreateWrapsTheCardAndFocusesTheNewCard(t *testing.T) {
	f := layoutShell(t, oneCard(tab("t1", "notes")))
	first, err := f.apply("core.group.create", `{"card": "main", "side": "right", "plugin": "plain"}`)
	if err != nil {
		t.Fatal(err)
	}
	var answer map[string]string
	if err := json.Unmarshal([]byte(first), &answer); err != nil {
		t.Fatal(err)
	}
	if answer["group"] != "card-2" || answer["card"] != "card-3" || answer["tab"] == "" {
		t.Fatalf("core.group.create answered %s", first)
	}
	if focused := f.layout().focusedCard(); focused != "card-3" {
		t.Fatalf("the focus is on %q, not on the new card card-3", focused)
	}
	again, err := f.apply("core.group.create", `{"card": "main", "side": "right", "plugin": "plain"}`)
	if err != nil || again != first {
		t.Fatalf("the repeated core.group.create answered %s, %v, not %s", again, err, first)
	}
	layout := f.read("core.layout")
	if layout["leader"] != "card-2" || layout["lastCard"] != float64(3) {
		t.Fatalf("core.layout holds the leader %v and lastCard %v", layout["leader"], layout["lastCard"])
	}
	// core.layout reports the stored tree, whose box holds the group card with its name and leader.
	if _, has := layout["groups"]; has {
		t.Fatalf("core.layout reports groups beside its tree: %v", layout["groups"])
	}
	box := treeBox(layout["state"].(map[string]any)["root"].(map[string]any), "card-2")
	if box == nil || !reflect.DeepEqual(box["data"], map[string]any{"name": "그룹 1", "leader": "main"}) {
		t.Fatalf("core.layout holds the box %v of card-2", box)
	}
	members := []string{}
	for _, card := range treeCards(box["inner"].(map[string]any)) {
		members = append(members, card["card"].(string))
	}
	if !slices.Equal(members, []string{"main", "card-3"}) {
		t.Fatalf("the box of card-2 holds %v", members)
	}
	if cards := len(treeCards(layout["state"].(map[string]any)["root"].(map[string]any))); cards != 4 {
		t.Fatalf("the grid holds %d cards, not main, card-3 and the two window sidebars", cards)
	}
}

func TestTheGridListsTheCardsWithTheGroupThatHoldsThemAndTheLeaders(t *testing.T) {
	f := groupedShell(t)
	cards := f.gridCards()
	group, main, born := cards["card-2"], cards["main"], cards["card-3"]
	if group == nil || main == nil || born == nil {
		t.Fatalf("core.grid lists the cards %v", cards)
	}
	want := map[string]any{"name": "그룹 1", "level": float64(1), "leader": "main"}
	if !reflect.DeepEqual(group["group"], want) || group["leader"] != true {
		t.Fatalf("core.grid lists the group card %v", group)
	}
	if main["parent"] != "card-2" || main["leader"] != true || born["parent"] != "card-2" || born["leader"] != false {
		t.Fatalf("core.grid lists main %v and card-3 %v", main, born)
	}
	// The header of the group takes the top of its frame, and main stands one gap inside the frame, the gap between main and card-3.
	gap := born["x"].(float64) - main["x"].(float64) - main["w"].(float64)
	if main["x"].(float64)-group["x"].(float64) != gap || main["y"].(float64) <= group["y"].(float64) {
		t.Fatalf("main at %v,%v does not stand one gap %v inside the frame and under the header of its group at %v,%v", main["x"], main["y"],
			gap, group["x"], group["y"])
	}
}

// core.grid lists the content cards with their tabs in cards and the group cards in groups, so a reader of cards sees one shape
// (docs/spec/groups.md#status-and-queries).
func TestTheCardsOfTheGridHoldContentCardsAndTheGroupsTheGroupCards(t *testing.T) {
	f := groupedShell(t)
	grid := f.read("core.grid")
	for _, entry := range grid["cards"].([]any) {
		card := entry.(map[string]any)
		if _, ok := card["tabs"].([]any); !ok {
			t.Fatalf("the card %v of core.grid has no tabs: %v", card["id"], card)
		}
	}
	groups, _ := grid["groups"].([]any)
	if len(groups) != 1 || groups[0].(map[string]any)["id"] != "card-2" {
		t.Fatalf("core.grid lists the group cards %v, not card-2", grid["groups"])
	}
}

// The tabs of core.grid hold the members of the tabs of the layout of the window description, tab, plugin, title, active and params, beside
// the presentation members (docs/spec/groups.md#status-and-queries).
func TestTheTabsOfTheGridHoldTheMembersOfTheLayoutTabs(t *testing.T) {
	f := layoutShell(t, oneCard(
		map[string]any{"id": "t1", "plugin": "notes", "title": "t1", "role": nil, "params": map[string]any{"path": "a.md"}},
		tab("t2", "notes")))
	var main map[string]any
	cards, _ := f.read("core.grid")["cards"].([]any)
	for _, entry := range cards {
		if card, _ := entry.(map[string]any); card["id"] == "main" {
			main = card
		}
	}
	if main == nil {
		t.Fatalf("core.grid lists no card main: %v", cards)
	}
	tabs, _ := main["tabs"].([]any)
	if len(tabs) != 2 {
		t.Fatalf("core.grid lists the tabs %v, not t1 and t2", tabs)
	}
	want := []map[string]any{
		{"tab": "t1", "plugin": "notes", "title": "t1", "active": true, "params": map[string]any{"path": "a.md"}},
		{"tab": "t2", "plugin": "notes", "title": "t2", "active": false, "params": nil},
	}
	for k, expected := range want {
		entry, _ := tabs[k].(map[string]any)
		for key, value := range expected {
			if !reflect.DeepEqual(entry[key], value) {
				t.Fatalf("the tab %d of core.grid has %s = %v, want %v", k, key, entry[key], value)
			}
		}
		if _, kept := entry["id"]; kept {
			t.Fatalf("the tab %d of core.grid keeps the member id: %v", k, entry)
		}
	}
}

// The layout of the description is the tree of the members of the root level with each group card as a node of its group and the tree
// of its members, and groups lists every group card once with its members by identifier (docs/spec/groups.md#status-and-queries).
func TestTheDescriptionHoldsTheGroupCardsInItsTree(t *testing.T) {
	f := groupedShell(t)
	f.tester.SetSize(1600, 900)
	f.settle()
	if _, err := f.apply("core.group.create", `{"card": "card-3", "side": "bottom", "plugin": "plain"}`); err != nil {
		t.Fatal(err)
	}
	var described map[string]any
	if err := json.Unmarshal([]byte(f.described()), &described); err != nil {
		t.Fatal(err)
	}
	root := described["root"].(map[string]any)
	outer, _ := root["group"].(map[string]any)
	if root["card"] != "card-2" || outer == nil || outer["name"] != "그룹 1" || outer["level"] != float64(1) || outer["leader"] != "main" {
		t.Fatalf("the root of the description is not the group card card-2 with its group: %v", root)
	}
	row := outer["root"].(map[string]any)
	children, _ := row["children"].([]any)
	if row["direction"] != "row" || len(children) != 2 || children[0].(map[string]any)["card"] != "main" ||
		children[0].(map[string]any)["parent"] != "card-2" || children[0].(map[string]any)["leader"] != true {
		t.Fatalf("the group card-2 holds the tree %v", row)
	}
	inner := children[1].(map[string]any)
	nested, _ := inner["group"].(map[string]any)
	if inner["card"] != "card-4" || nested == nil || nested["name"] != "그룹 2" || nested["level"] != float64(2) ||
		nested["root"].(map[string]any)["direction"] != "column" {
		t.Fatalf("the group card-2 holds the node %v, not the group card card-4 with a column", inner)
	}
	groups := described["groups"].([]any)
	var listed []string
	for _, entry := range groups {
		group := entry.(map[string]any)
		listed = append(listed, group["card"].(string))
		for _, member := range group["members"].([]any) {
			if _, ok := member.(string); !ok {
				t.Fatalf("the group %v lists the member %v, which is no identifier", group["card"], member)
			}
		}
	}
	if !slices.Equal(listed, []string{"card-2", "card-4"}) {
		t.Fatalf("the description lists the groups %v, not card-2 and card-4 once each", listed)
	}
}

// A group card node of the description always carries leader and carries no parent, and an entry of groups always carries leading,
// so a reader of a group card sees one shape (docs/spec/exposure.md#window-snapshot).
func TestAGroupNodeOfTheDescriptionCarriesItsLeaderAndNoParent(t *testing.T) {
	f := groupedShell(t)
	f.tester.SetSize(1600, 900)
	f.settle()
	if _, err := f.apply("core.group.create", `{"card": "card-3", "side": "bottom", "plugin": "plain"}`); err != nil {
		t.Fatal(err)
	}
	var described map[string]any
	if err := json.Unmarshal([]byte(f.described()), &described); err != nil {
		t.Fatal(err)
	}
	outer := described["root"].(map[string]any)
	inner := outer["group"].(map[string]any)["root"].(map[string]any)["children"].([]any)[1].(map[string]any)
	if inner["card"] != "card-4" {
		t.Fatalf("the second member of card-2 is %v, not the group card card-4", inner)
	}
	for _, node := range []map[string]any{outer, inner} {
		if leader, ok := node["leader"]; !ok || leader != (node["card"] == "card-2") {
			t.Errorf("the group node %v carries the leader %v, %v", node["card"], leader, ok)
		}
		if parent, ok := node["parent"]; ok {
			t.Errorf("the group node %v carries the parent %v", node["card"], parent)
		}
	}
	for _, entry := range described["groups"].([]any) {
		group := entry.(map[string]any)
		if leading, ok := group["leading"]; !ok || leading != (group["card"] == "card-2") {
			t.Errorf("the entry of %v in groups carries leading %v, %v", group["card"], leading, ok)
		}
	}
}

func TestADissolveAnswersDissolvedAgainAndKeepsTheCards(t *testing.T) {
	f := groupedShell(t)
	for range 2 {
		if answer, err := f.apply("core.group.dissolve", `{"group": "card-2"}`); err != nil || answer != `{"dissolved":true}` {
			t.Fatalf("core.group.dissolve answered %s, %v", answer, err)
		}
	}
	cards := f.gridCards()
	if cards["card-2"] != nil || cards["main"] == nil || cards["card-3"] == nil || cards["main"]["parent"] != nil {
		t.Fatalf("core.grid lists %v after the dissolve", cards)
	}
	if _, err := f.apply("core.group.dissolve", `{"group": "main"}`); err == nil || err.Error() != "card main is not a group" {
		t.Fatalf("a dissolve of a content card fails with %v", err)
	}
}

func TestARenameAndALeaderAnswerTheSameAgain(t *testing.T) {
	f := groupedShell(t)
	for range 2 {
		if answer, err := f.apply("core.group.rename", `{"group": "card-2", "name": "  작업  "}`); err != nil || answer != `{"group":"card-2","name":"작업"}` {
			t.Fatalf("core.group.rename answered %s, %v", answer, err)
		}
		if answer, err := f.apply("core.group.leader", `{"card": "card-3"}`); err != nil || answer != `{"card":"card-3","group":"card-2"}` {
			t.Fatalf("core.group.leader answered %s, %v", answer, err)
		}
	}
	if answer, err := f.apply("core.group.leader", `{"card": "card-2"}`); err != nil || answer != `{"card":"card-2","group":null}` {
		t.Fatalf("core.group.leader of the root level answered %s, %v", answer, err)
	}
	group := f.gridCards()["card-2"]["group"].(map[string]any)
	if group["name"] != "작업" || group["leader"] != "card-3" {
		t.Fatalf("core.grid holds the group record %v", group)
	}
	if _, err := f.apply("core.group.rename", `{"group": "card-2", "name": " "}`); err == nil || err.Error() != "group name must be 1 to 40 characters: " {
		t.Fatalf("an empty name fails with %v", err)
	}
}

func TestACardMoveOutOfAGroupReplacesTheGroupOfOneCard(t *testing.T) {
	f := layoutShell(t, treeSpace("spc-aaaaaa", cutNode("x", kidNode(0.5, cardNode("main", tab("t1", "notes"))), kidNode(0.5, cardNode("side", tab("t2", "plain"))))))
	if _, err := f.apply("core.group.create", `{"card": "main", "side": "bottom", "plugin": "plain"}`); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		// The reply names the target as resolved after the commit, the vacated slot of card-3 (docs/spec/groups.md#idempotency).
		if answer, err := f.apply("core.card.move", `{"card": "card-3", "target": "side", "side": "bottom"}`); err != nil || answer != `{"card":"card-3","side":"bottom","target":"side"}` {
			t.Fatalf("core.card.move answered %s, %v", answer, err)
		}
	}
	cards := f.gridCards()
	if cards["card-2"] != nil || cards["main"]["parent"] != nil || cards["card-3"]["parent"] != nil {
		t.Fatalf("core.grid lists %v after the move", cards)
	}
	if f.layout().focusedCard() != "card-3" {
		t.Fatalf("the focus is on %s after the move", f.layout().focusedCard())
	}
	// A target that is the card itself names its vacated slot, so the move is no change (docs/spec/groups.md#vacated-slot).
	before := f.gridCards()
	answer, err := f.apply("core.card.move", `{"card": "main", "target": "main", "side": "left"}`)
	if err != nil || !strings.HasPrefix(answer, `{"card":"main","side":`) {
		t.Fatalf("a move beside itself answers %s, %v", answer, err)
	}
	// The reply names the vacated slot of main, so the move with the reply is no change either.
	if again, err := f.apply("core.card.move", answer); err != nil || again != answer {
		t.Fatalf("the move with the reply %s answers %s, %v", answer, again, err)
	}
	if after := f.gridCards(); !reflect.DeepEqual(after, before) {
		t.Fatalf("a move beside itself changed core.grid from %v to %v", before, after)
	}
}

func TestTheCardCommandsOfAGroupCardActOnItsRectangle(t *testing.T) {
	f := groupedShell(t)
	if _, err := f.apply("core.card.focus", `{"card": "card-2"}`); err != nil {
		t.Fatal(err)
	}
	if focused := f.layout().focusedCard(); focused != "main" {
		t.Fatalf("a focus of the group card focuses %s, not main", focused)
	}
	if _, err := f.apply("core.card.add-tab", `{"card": "card-2", "plugin": "plain"}`); err != nil {
		t.Fatal(err)
	}
	cards := f.gridCards()
	added := cards["card-4"]
	if added == nil || added["parent"] != "card-2" || added["x"].(float64) <= cards["card-3"]["x"].(float64) {
		t.Fatalf("core.card.add-tab on the group card made %v", added)
	}
	if answer, err := f.apply("core.card.split", `{"card": "card-2", "side": "bottom", "plugin": "plain"}`); err != nil || !strings.Contains(answer, `"card":"card-5"`) {
		t.Fatalf("core.card.split of the group card answered %s, %v", answer, err)
	}
	if f.gridCards()["card-5"]["parent"] != nil {
		t.Fatal("the split of the group card put the new card into the group")
	}
	if answer, err := f.apply("core.card.close", `{"card": "card-2"}`); err != nil || answer != `{"closed":true}` {
		t.Fatalf("core.card.close of the group card answered %s, %v", answer, err)
	}
	cards = f.gridCards()
	delete(cards, "left")
	delete(cards, "right")
	if len(cards) != 1 || cards["card-5"] == nil {
		t.Fatalf("core.grid lists %v after the close of the group card", cards)
	}
}

func TestACardGetReadsAContentCardWithItsGroupPathAndAGroupCardWithItsMembers(t *testing.T) {
	f := groupedShell(t)
	if _, err := f.apply("core.group.rename", `{"group": "card-2", "name": "작업"}`); err != nil {
		t.Fatal(err)
	}
	state, err := f.cardGet("main")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"card": "main", "activeTab": "t1", "tabs": []any{map[string]any{"tab": "t1", "plugin": "notes", "status": map[string]any{}}},
		"groups": []any{map[string]any{"card": "card-2", "name": "작업"}}}
	if !reflect.DeepEqual(state, want) {
		t.Fatalf("core.card.get main answered %v, want %v", state, want)
	}
	group, err := f.cardGet("card-2")
	if err != nil {
		t.Fatal(err)
	}
	record := group["group"].(map[string]any)
	if group["card"] != "card-2" || !reflect.DeepEqual(group["groups"], []any{}) || record["name"] != "작업" || record["level"] != float64(1) ||
		record["leader"] != "main" || !reflect.DeepEqual(record["members"], []any{"main", "card-3"}) || group["tabs"] != nil {
		t.Fatalf("core.card.get card-2 answered %v", group)
	}
	if _, err := f.cardGet("card-9"); err == nil || err.Error() != "card card-9 is not in the layout of window main" {
		t.Fatalf("core.card.get of no card fails with %v", err)
	}
}

func TestACardGetOfAWindowSidebarIsRefused(t *testing.T) {
	f := layoutShell(t, treeSpace("spc-aaaaaa", cutNode("x", kidNode(0.2, map[string]any{"card": "left", "fixed": true}), kidNode(0.8, cardNode("main", tab("t1", "notes"))))))
	if _, err := f.cardGet("left"); err == nil || err.Error() != "card left is a window sidebar" {
		t.Fatalf("core.card.get of a window sidebar fails with %v", err)
	}
}

// A tab of a plugin that declares a status with summary true carries the value of that status in the state of its card, as the surface
// answers it in the window snapshot (docs/spec/exposure.md#entry-fields).
func TestACardGetCarriesTheSummaryStatusesOfEachTab(t *testing.T) {
	declared := strings.Replace(installedDocument, `{"name": "textprobe.screen", "description": "the screen",`,
		`{"name": "textprobe.screen", "description": "the screen", "summary": true,`, 1)
	if declared == installedDocument {
		t.Fatal("the test document declares no textprobe.screen")
	}
	r := newViewRelayOn(t, &surfaceHost{storedHost: storedHost{installed: declared}})
	surface := r.surface()
	r.call(surface, "runtime.native.on", map[string]any{"name": "exposure-request"})
	r.call(surface, "runtime.native.call", map[string]any{"name": "registered", "payload": map[string]any{"kind": "status", "name": "textprobe.screen"}})
	var card string
	grid, err := r.f.shell.Registry().Read("core.grid")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range asJSON(t, grid).(map[string]any)["cards"].([]any) {
		for _, each := range entry.(map[string]any)["tabs"].([]any) {
			if each.(map[string]any)["tab"] == surface {
				card = entry.(map[string]any)["id"].(string)
			}
		}
	}
	var (
		value    any
		failure  error
		answered bool
	)
	r.f.shell.Registry().RunLater("core.card.get", json.RawMessage(`{"card": "`+card+`"}`), func(result any, err error) {
		value, failure, answered = result, err, true
	})
	var pushed map[string]any
	r.f.until(func() bool {
		r.mu.Lock()
		defer r.mu.Unlock()
		for _, each := range r.pushed {
			if data, ok := each["data"].(map[string]any); ok && data["method"] == "exposure.snapshot" {
				pushed = data
			}
		}
		return pushed != nil || answered
	})
	if answered {
		t.Fatalf("core.card.get answered %v, %v before the window snapshot reached the surface", value, failure)
	}
	r.call(surface, "runtime.native.call", map[string]any{"name": "exposureReply", "payload": map[string]any{"id": pushed["id"], "result": map[string]any{
		"status": []any{map[string]any{"name": "textprobe.screen", "description": "the screen", "schema": map[string]any{"type": "object", "properties": map[string]any{}},
			"summary": true, "value": map[string]any{"rows": 3}}},
		"commands": []any{}, "element": []any{}}}})
	r.f.until(func() bool { return answered })
	if failure != nil {
		t.Fatal(failure)
	}
	var status any
	for _, each := range asJSON(t, value).(map[string]any)["tabs"].([]any) {
		if each.(map[string]any)["tab"] == surface {
			status = each.(map[string]any)["status"]
		}
	}
	if want := map[string]any{"textprobe.screen": map[string]any{"rows": float64(3)}}; !reflect.DeepEqual(status, want) {
		t.Fatalf("the tab %s of card %s carries the status %v, want %v", surface, card, status, want)
	}
}

// A split of a card of an even row adds the new card as one more equal kid, so each of the k + 1 kids takes 1/(k + 1) and the three
// columns of one row take equal widths; no setting chooses another division (docs/spec/groups.md#commands).
func TestASplitOfAnEvenRowGivesEveryCardAnEqualShare(t *testing.T) {
	f := layoutShell(t, oneCard(tab("t1", "notes")))
	f.tester.SetSize(1400, 900)
	f.settle()
	for range 2 {
		if _, err := f.apply("core.card.split", `{"card": "main", "side": "right", "plugin": "plain"}`); err != nil {
			t.Fatal(err)
		}
	}
	cards := f.gridCards()
	width := cards["main"]["w"].(float64)
	for _, id := range []string{"card-2", "card-3"} {
		if w := cards[id]["w"].(float64); math.Abs(w-width) > 1e-6 {
			t.Fatalf("card %s is %v wide and main %v", id, w, width)
		}
	}
}

// The close of a nested group card at the left of its group gives its cells to the card of the same group beside it, although the
// fill order of the layout library tries the card of another group above it first (docs/spec/groups.md#closing).
func TestTheCloseOfANestedGroupGivesItsCellsToItsGroup(t *testing.T) {
	// The stored tree holds the two window sidebars beside the content, as the workbench stores it, so the shell docks none.
	space := treeSpace("spc-aaaaaa", cutNode("x", kidNode(1./3, map[string]any{"card": "left", "width": 190, "fixed": true}), kidNode(1./3, cutNode("y",
		kidNode(0.33127317676143386, cutNode("x",
			kidNode(0.5, boxNode("card-9", "그룹 1", "terminal", cutNode("x", kidNode(0.4702083333333333, cardNode("terminal", tab("t1", "notes"))), kidNode(0.5297916666666667, cardNode("card-10", tab("t7", "notes")))))),
			kidNode(0.5, cardNode("card-5", tab("t6", "notes"))))),
		kidNode(0.6687268232385661, boxNode("card-4", "그룹 2", "card-11", cutNode("x",
			kidNode(0.5, cutNode("y",
				kidNode(0.5046210720887246, cutNode("x",
					kidNode(0.4702083333333333, boxNode("card-11", "그룹 3", "browser", cutNode("x", kidNode(0.49203035002215334, cardNode("browser", tab("t2", "notes"))), kidNode(0.5079696499778467, cardNode("card-12", tab("t8", "notes")))))),
					kidNode(0.5297916666666667, cardNode("card-13", tab("t9", "notes"))))),
				kidNode(0.4953789279112754, cardNode("card-3", tab("t5", "notes"))))),
			kidNode(0.5, cutNode("y", kidNode(0.5046210720887246, cardNode("card-7", tab("t4", "notes"))), kidNode(0.4953789279112754, cardNode("card-8", tab("t3", "notes")))))))))),
		kidNode(1./3, map[string]any{"card": "right", "width": 210, "fixed": true})))
	stored := space["layout"].(map[string]any)
	stored["leader"], stored["lastCard"] = "card-9", 13
	f := layoutShell(t, space)
	f.tester.SetSize(1908, 900)
	f.settle()
	if _, err := f.apply("core.card.close", `{"card": "card-11"}`); err != nil {
		t.Fatal(err)
	}
	cards := f.gridCards()
	// The window sidebars stand in the first and the last column, so card-13 reaches the column of card-3 below it.
	if card := cards["card-13"]; card == nil || card["c0"] != cards["card-3"]["c0"] || card["c1"] != cards["card-3"]["c1"] || card["parent"] != "card-4" {
		t.Fatalf("after the close card-13 is %v", card)
	}
	if card := cards["terminal"]; card["parent"] != "card-9" || card["r1"] != float64(1) {
		t.Fatalf("after the close terminal is %v", card)
	}
}

// core.grid lists the cards of the grid in workbench order and then the group cards, every entry with parent, null in the root level,
// and leader as a boolean, and a group card only as {id, x, y, w, h, parent, leader, group} (docs/spec/groups.md#status-and-queries).
func TestTheGridReportsEveryCardInTheGroupForm(t *testing.T) {
	f := groupedShell(t)
	var grid struct {
		Cards  []map[string]json.RawMessage `json:"cards"`
		Groups []map[string]json.RawMessage `json:"groups"`
	}
	if err := json.Unmarshal([]byte(f.status("core.grid")), &grid); err != nil {
		t.Fatal(err)
	}
	order := []string{}
	for _, entry := range append(grid.Cards, grid.Groups...) {
		var id string
		if err := json.Unmarshal(entry["id"], &id); err != nil {
			t.Fatal(err)
		}
		order = append(order, id)
		parent, hasParent := entry["parent"]
		leader, hasLeader := entry["leader"]
		if !hasParent || !hasLeader || (string(leader) != "true" && string(leader) != "false") {
			t.Errorf("%s carries parent %s (present %v) and leader %s (present %v)", id, parent, hasParent, leader, hasLeader)
		}
		if root := id == "card-2" || layout.IsWindowSide(id); root && (!hasParent || string(parent) != "null") {
			t.Errorf("%s of the root level carries parent %s (present %v), not null", id, parent, hasParent)
		}
		if _, isGroup := entry["group"]; isGroup {
			keys := []string{}
			for key := range entry {
				keys = append(keys, key)
			}
			slices.Sort(keys)
			if want := []string{"group", "h", "id", "leader", "parent", "w", "x", "y"}; !slices.Equal(keys, want) {
				t.Errorf("the group card %s carries the members %v, not %v", id, keys, want)
			}
		}
	}
	// The root level in reading order holds the left sidebar, the group card and the right sidebar, and the group card holds main and
	// card-3; the group card follows the cards of the grid.
	if want := []string{"left", "main", "card-3", "right", "card-2"}; !slices.Equal(order, want) {
		t.Errorf("core.grid lists %v, not %v", order, want)
	}
}

// With request, core.group.create is idempotent by the request: a repeat answers the first answer and changes nothing, and a request
// that the space has not answered groups again, also where the group of the same command stands (docs/spec/groups.md#idempotency).
func TestARequestMakesAGroupCreateIdempotentByThatRequest(t *testing.T) {
	f := layoutShell(t, oneCard(tab("t1", "notes")))
	// The request is refused after the layout and the drawn minimum, so the check runs while the layout takes a group of main
	// (docs/spec/groups.md#commands). A request that is no string is refused by the params schema, as every registry refuses it
	// (docs/spec/exposure.md#command-parameters).
	if _, err := f.apply("core.group.create", `{"card": "main", "side": "right", "plugin": "plain", "request": 7}`); err == nil ||
		err.Error() != "invalid params for core.group.create" {
		t.Errorf("the request 7 answered %v, not %q", err, "invalid params for core.group.create")
	}
	for _, request := range []string{`""`, `"` + strings.Repeat("r", 129) + `"`} {
		want := "core.group.create: request must be a string of 1 to 128 characters"
		if _, err := f.apply("core.group.create", `{"card": "main", "side": "right", "plugin": "plain", "request": `+request+`}`); err == nil ||
			err.Error() != want {
			t.Errorf("the request %s answered %v, not %q", request, err, want)
		}
	}
	first, err := f.apply("core.group.create", `{"card": "main", "side": "right", "plugin": "plain", "request": "r1"}`)
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.apply("core.group.create", `{"card": "main", "side": "right", "plugin": "plain", "request": "r2"}`)
	if err != nil || second == first {
		t.Fatalf("a new request answered %s, %v; the first answered %s", second, err, first)
	}
	before := f.status("core.layout")
	if again, err := f.apply("core.group.create", `{"card": "main", "side": "right", "plugin": "plain", "request": "r1"}`); err != nil ||
		again != first || f.status("core.layout") != before {
		t.Fatalf("the repeat of r1 answered %s, %v, not %s, and changed the layout: %v", again, err, first, f.status("core.layout") != before)
	}
}

// Each press of the plugin item of the group menu groups the card, so a second press groups the card again
// (docs/spec/groups.md#idempotency).
func TestEachPressOfTheGroupMenuGroupsTheCard(t *testing.T) {
	f := layoutShell(t, oneCard(tab("t1", "notes")))
	f.tester.SetSize(2400, 600)
	f.settle()
	for press := 1; press <= 2; press++ {
		if _, err := f.apply("core.card.menu", `{"card": "main", "menu": "group-x"}`); err != nil {
			t.Fatal(err)
		}
		index := -1
		for k, item := range f.read("core.picker")["items"].([]any) {
			if item.(map[string]any)["key"] == "plain" {
				index = k
			}
		}
		if _, err := f.apply("core.picker.pick", `{"index": `+strconv.Itoa(index)+`}`); err != nil {
			t.Fatal(err)
		}
		if groups := strings.Count(f.status("core.layout"), `"box":`); groups != press {
			t.Fatalf("after press %d the layout holds %d group cards: %s", press, groups, f.status("core.layout"))
		}
	}
}

// core.layout.open with side on the last card of a group finds its neighbour only among the members of the group: a card outside the
// group whose edge lies on the same line is no neighbour, so a row of a group grows inside the group
// (docs/spec/groups.md#card-commands-on-a-group-card).
func TestOpenTowardASideFromAGroupMemberStaysInsideTheGroup(t *testing.T) {
	f := layoutShell(t, oneCard(tab("t1", "notes")))
	f.tester.SetSize(2400, 600)
	f.settle()
	outside, err := f.apply("core.layout.open", `{"card": "main", "side": "right", "plugin": "plain"}`)
	if err != nil {
		t.Fatal(err)
	}
	var created struct{ Group, Card string }
	answer, err := f.apply("core.group.create", `{"card": "main", "side": "right", "plugin": "plain"}`)
	if err != nil || json.Unmarshal([]byte(answer), &created) != nil {
		t.Fatalf("core.group.create answered %s, %v", answer, err)
	}
	opened, err := f.apply("core.layout.open", `{"card": "`+created.Card+`", "side": "right", "plugin": "plain"}`)
	if err != nil {
		t.Fatal(err)
	}
	var result struct{ Card string }
	if err := json.Unmarshal([]byte(opened), &result); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(outside, `"`+result.Card+`"`) {
		t.Fatalf("core.layout.open from %s answered %s, the card outside the group %s", created.Card, opened, outside)
	}
	box := treeBox(f.read("core.layout")["state"].(map[string]any)["root"].(map[string]any), created.Group)
	if box == nil || !slices.ContainsFunc(treeCards(box["inner"].(map[string]any)), func(card map[string]any) bool { return card["card"] == result.Card }) {
		t.Fatalf("the new card %s is not a member of %s: %v", result.Card, created.Group, box)
	}
}

// contract: layout.move.focuses-the-moved-card
func TestACardMoveFocusesTheMovedCardAndAMoveThatChangesNothingKeepsTheFocus(t *testing.T) {
	f := layoutShell(t, treeSpace("spc-aaaaaa", cutNode("x", kidNode(0.5, cardNode("main", tab("t1", "notes"))), kidNode(0.5, cardNode("side", tab("t2", "plain"))))))
	if _, err := f.apply("core.group.create", `{"card": "main", "side": "bottom", "plugin": "plain"}`); err != nil {
		t.Fatal(err)
	}
	focus := func(card string) {
		t.Helper()
		if _, err := f.apply("core.card.focus", `{"card": "`+card+`"}`); err != nil {
			t.Fatal(err)
		}
	}
	// The reply of a move, its card and its resolved target, is judged by the move reply cases (docs/spec/groups.md#idempotency).
	move := func(params, want string) {
		t.Helper()
		answer, err := f.apply("core.card.move", params)
		var reply struct {
			Card string `json:"card"`
		}
		if err == nil {
			err = json.Unmarshal([]byte(answer), &reply)
		}
		if err != nil || reply.Card != want {
			t.Fatalf("core.card.move %s answered %s, %v", params, answer, err)
		}
	}
	focus("side")
	move(`{"card": "card-3", "target": "side", "side": "bottom"}`, "card-3")
	if got := f.layout().focusedCard(); got != "card-3" {
		t.Fatalf("the focus is on %s after the move of card-3", got)
	}
	focus("main")
	move(`{"card": "card-3", "target": "side", "side": "bottom"}`, "card-3")
	if got := f.layout().focusedCard(); got != "main" {
		t.Fatalf("a move that changes nothing moved the focus to %s", got)
	}
	if _, err := f.apply("core.group.create", `{"card": "side", "side": "bottom", "plugin": "plain"}`); err != nil {
		t.Fatal(err)
	}
	focus("main")
	move(`{"card": "card-4", "target": "main", "side": "bottom"}`, "card-4")
	if got := f.layout().focusedCard(); got != "side" {
		t.Fatalf("the move of the group card card-4 focused %s, not the first card inside it", got)
	}
}

// A split button of a group header is disabled while the split of its group card toward its side is refused, and core.card.menu of a
// disabled button is refused with the text of the page instead of opening a menu whose pick fails (docs/spec/groups.md#headers).
func TestTheMenuOfADisabledGroupSplitButtonIsRefused(t *testing.T) {
	f := groupedShell(t)
	f.tester.SetSize(1200, 330)
	f.settle()
	if _, err := f.apply("core.card.split", `{"card": "card-2", "side": "bottom", "plugin": "plain"}`); err == nil {
		t.Fatal("the split of the group card card-2 toward bottom succeeded in a window of 330 points")
	}
	if _, err := f.apply("core.card.menu", `{"card": "card-2", "menu": "split-y"}`); err == nil || err.Error() != "card card-2 cannot split-y" {
		t.Fatalf("core.card.menu of the disabled split button of card-2 answered %v", err)
	}
	if picker := f.status("core.picker"); !strings.HasPrefix(picker, `{"open":false`) {
		t.Fatalf("core.card.menu of a disabled button opened the menu %s", picker)
	}
}

// core.group.create checks its refusals in the order of the specification: the layout and the drawn minimum before the request and the
// plugin, so a request that is no string of 1 to 128 characters and an unknown plugin on a card whose group is refused answer the
// refusal of the layout, and the request is refused only where the layout takes the group (docs/spec/groups.md#commands).
// contract: group.create.request-after-the-layout
func TestAGroupCreateRefusesTheDrawnMinimumBeforeTheRequestAndThePlugin(t *testing.T) {
	f := layoutShell(t, treeSpace("spc-aaaaaa", cutNode("y", kidNode(0.9, cardNode("card-1", tab("t1", "notes"))), kidNode(0.1, cardNode("card-2", tab("t2", "notes"))))))
	f.tester.SetSize(1400, 1300)
	f.settle()
	_, refused := f.apply("core.group.create", `{"card": "card-2", "side": "bottom", "plugin": "plain"}`)
	if refused == nil || !strings.HasPrefix(refused.Error(), "card card-2 cannot hold a group toward bottom: card ") {
		t.Fatalf("the group of card-2 toward bottom is not refused by the drawn minimum: %v", refused)
	}
	for _, params := range []string{`{"card": "card-2", "side": "bottom", "plugin": "plain", "request": ""}`,
		`{"card": "card-2", "side": "bottom", "plugin": "nope", "request": "r-1"}`} {
		if _, err := f.apply("core.group.create", params); err == nil || err.Error() != refused.Error() {
			t.Errorf("core.group.create %s answered %v, not %v", params, err, refused)
		}
	}
	const text = "core.group.create: request must be a string of 1 to 128 characters"
	if _, err := f.apply("core.group.create", `{"card": "card-1", "side": "right", "plugin": "plain", "request": ""}`); err == nil || err.Error() != text {
		t.Errorf("an empty request on card-1 answered %v", err)
	}
}

// A pointer press that lands on no content card clears the focus, as a web page blurs its active element: a press on the header of a
// group card outside its buttons, on its frame and on the gap between its cards runs core.card.focus {"card": null}, so no card holds
// the ring, core.grid, core.layout and the window description report no focused card, and an operation on current fails with the error
// that names the window; a press on a head button changes the focus only as its command does, and core.card.focus on a group card focuses its first card
// (docs/spec/groups.md#focus).
func TestAPressOutsideEveryContentCardClearsTheFocus(t *testing.T) {
	f := groupedShell(t)
	f.settle()
	tree := f.tester.ElementTree()
	cards, frames := exposedAll(tree, "core.card"), exposedAll(tree, "core.group")
	// The window sidebars left and right are cards of the plane; a press on them keeps the focus.
	delete(cards, "left")
	delete(cards, "right")
	if len(cards) != 2 || len(frames) != 1 {
		t.Fatalf("the fixture shows the cards %v and the group cards %v", cards, frames)
	}
	var group, first, second string
	for id := range frames {
		group = id
	}
	for id, rect := range cards {
		if first == "" || rect.X < cards[first].X {
			first, second = id, first
		} else {
			second = id
		}
	}
	frame, header := frames[group], f.box("core.group.header", group)
	focused := func() string {
		value, _ := f.read("core.layout")["focusedId"].(string) // silent: null reads as no card.
		return value
	}
	cleared := func(where string) {
		t.Helper()
		if got := f.read("core.layout")["focusedId"]; got != nil {
			t.Errorf("after a press on %s core.layout stores the focused card %v", where, got)
		}
		for _, card := range f.read("core.grid")["cards"].([]any) {
			if entry := card.(map[string]any); entry["focused"] == true {
				t.Errorf("after a press on %s core.grid reports %v focused", where, entry["id"])
			}
		}
		if described := f.layout(); described.Focused != nil {
			t.Errorf("after a press on %s the window description names the focused card %s", where, *described.Focused)
		}
	}
	gap := (cards[first].X + cards[first].W + cards[second].X) / 2
	for _, press := range []struct {
		where string
		x, y  float32
	}{
		{"the header of the group card", header.X + header.W/2, header.Y + header.H/2},
		{"the frame of the group card", frame.X + frame.W/2, frame.Y + frame.H - 2},
		{"the gap between the cards of the group card", gap, cards[first].Y + cards[first].H/4},
	} {
		f.run(t, "core.card.focus", `{"card": "`+second+`"}`)
		f.tester.ClickAt(press.x, press.y)
		f.settle()
		if got := focused(); got != "" {
			t.Errorf("a press on %s left the focus on %s", press.where, got)
			continue
		}
		cleared(press.where)
	}
	f.run(t, "core.card.focus", `{"card": null}`)
	if _, err := f.apply("core.layout.open", `{"card": "current", "plugin": "plain"}`); err == nil ||
		!strings.HasPrefix(err.Error(), "card current names no card: window ") || !strings.HasSuffix(err.Error(), " has no focused card") {
		t.Errorf("core.layout.open on current without a focused card answered %v", err)
	}
	cleared("core.card.focus with null")
	// The fullscreen button of the group card runs core.card.fullscreen, which focuses the first card of the group card.
	f.run(t, "core.card.focus", `{"card": "`+second+`"}`)
	button := f.box("core.group.fullscreen", group)
	f.tester.ClickAt(button.X+button.W/2, button.Y+button.H/2)
	f.settle()
	if got := focused(); got != first {
		t.Errorf("a press on the fullscreen button of the group card focused %q, not %s that its command focuses", got, first)
	}
	f.run(t, "core.card.fullscreen", `{"card": "`+group+`"}`)
	f.run(t, "core.card.focus", `{"card": "`+group+`"}`)
	if got := focused(); got != first {
		t.Errorf("core.card.focus on the group card focused %q, not its first card %s", got, first)
	}
}

// The plane of the shown space is the element core.plane of the element tree, and a left press on it that lands on no card, such as on
// the gap between two cards, runs core.card.focus {"card": null}, so the plane stores no focused card; a press on the margin of the
// stage around the plane keeps the focus (docs/spec/groups.md#focus).
func TestAPressOnThePlaneOutsideEveryCardClearsTheFocus(t *testing.T) {
	f := groupedShell(t)
	f.settle()
	plane := f.box("core.plane", "")
	all := exposedAll(f.tester.ElementTree(), "core.card")
	var first, second string
	for id, rect := range all {
		if id == "left" || id == "right" {
			continue
		}
		if first == "" || rect.X < all[first].X {
			first, second = id, first
		} else {
			second = id
		}
	}
	if first == "" || second == "" {
		t.Fatalf("the fixture shows the cards %v", all)
	}
	x, y := (all[first].X+all[first].W+all[second].X)/2, all[first].Y+all[first].H/4
	inside := func(r ui.Rect) bool { return x >= r.X && x < r.X+r.W && y >= r.Y && y < r.Y+r.H }
	if !inside(plane) {
		t.Fatalf("the point %v, %v between %s and %s lies outside the plane %v", x, y, first, second, plane)
	}
	for id, rect := range all {
		if inside(rect) {
			t.Fatalf("the point %v, %v lies on the card %s", x, y, id)
		}
	}
	f.run(t, "core.card.focus", `{"card": "`+second+`"}`)
	f.tester.ClickAt(x, y)
	f.settle()
	if got := f.read("core.layout")["focusedId"]; got != nil {
		t.Errorf("a press on the plane between %s and %s left the focus on %v", first, second, got)
	}
	// The margin of the stage around the plane is no part of the plane, as on the page, so a press on it keeps the focus.
	f.run(t, "core.card.focus", `{"card": "`+second+`"}`)
	f.tester.ClickAt(plane.X-1, plane.Y+plane.H/2)
	f.settle()
	if got := f.read("core.layout")["focusedId"]; got != second {
		t.Errorf("a press on the margin left of the plane moved the focus from %s to %v", second, got)
	}
}

// A space that stores the focus null opens with no focused card, and a space that stores no focus focuses its first card
// (docs/spec/groups.md#focus, docs/spec/projects.md#persistence).
func TestASpaceThatStoresNoFocusedCardOpensWithoutTheRing(t *testing.T) {
	space := oneCard(tab("t1", "notes"))
	space["layout"].(map[string]any)["focusedId"] = nil
	f := layoutShell(t, space)
	f.settle()
	if got := f.read("core.layout")["focusedId"]; got != nil {
		t.Errorf("the space that stores the focus null opens with the focus on %v", got)
	}
	if described := f.layout(); described.Focused != nil {
		t.Errorf("the window description names the focused card %s", *described.Focused)
	}
	plain := layoutShell(t, oneCard(tab("t1", "notes")))
	plain.settle()
	if got := plain.read("core.layout")["focusedId"]; got != "main" {
		t.Errorf("the space that stores no focus opens with the focus %v, not on its first card main", got)
	}
}
