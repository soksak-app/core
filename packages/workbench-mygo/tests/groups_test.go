// The commands, statuses and queries of group cards in the mygo workbench (docs/spec/groups.md): core.group.*, core.card.move, the card
// commands on a group card, core.layout, core.grid, the window description and core.card.get.
package workbench_test

import (
	"encoding/json"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"

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
	for _, card := range f.read("core.grid")["cards"].([]any) {
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
	want := []any{map[string]any{"card": "card-2", "name": "그룹 1", "level": float64(1), "leader": "main", "members": []any{"main", "card-3"}}}
	if !reflect.DeepEqual(layout["groups"], want) {
		t.Fatalf("core.layout holds the groups %v, want %v", layout["groups"], want)
	}
	if cards := len(layout["state"].(map[string]any)["cards"].([]any)); cards != 4 {
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

func TestTheDescriptionHoldsTheGridAndTheGroupTree(t *testing.T) {
	f := groupedShell(t)
	var described map[string]any
	if err := json.Unmarshal([]byte(f.described()), &described); err != nil {
		t.Fatal(err)
	}
	root := described["root"].(map[string]any)
	children := root["children"].([]any)
	if root["direction"] != "row" || len(children) != 2 || children[0].(map[string]any)["card"] != "main" ||
		children[0].(map[string]any)["parent"] != "card-2" || children[0].(map[string]any)["leader"] != true {
		t.Fatalf("the description holds the root %v", root)
	}
	groups := described["groups"].([]any)
	group := groups[0].(map[string]any)
	if len(groups) != 1 || group["card"] != "card-2" || group["name"] != "그룹 1" || group["level"] != float64(1) || group["leading"] != true ||
		!reflect.DeepEqual(group["members"], []any{"main", "card-3"}) || group["frame"].(map[string]any)["width"].(float64) <= 0 {
		t.Fatalf("the description holds the groups %v", groups)
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
	f := layoutShell(t, gridSpace("spc-aaaaaa", []float64{0, 0.5, 1}, []float64{0, 1},
		gridCard("main", 0, 1, 0, 1, tab("t1", "notes")), gridCard("side", 1, 2, 0, 1, tab("t2", "plain"))))
	if _, err := f.apply("core.group.create", `{"card": "main", "side": "bottom", "plugin": "plain"}`); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if answer, err := f.apply("core.card.move", `{"card": "card-3", "target": "side", "side": "bottom"}`); err != nil || answer != `{"card":"card-3"}` {
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
	if _, err := f.apply("core.card.move", `{"card": "main", "target": "main", "side": "left"}`); err == nil || err.Error() != "card main cannot move into itself" {
		t.Fatalf("a move into itself fails with %v", err)
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
	f := layoutShell(t, gridSpace("spc-aaaaaa", []float64{0, 0.2, 1}, []float64{0, 1},
		map[string]any{"id": "left", "c0": 0, "c1": 1, "r0": 0, "r1": 1, "fixed": true}, gridCard("main", 1, 2, 0, 1, tab("t1", "notes"))))
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
			if each.(map[string]any)["id"] == surface {
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

// With cardSplit even a split balances the grid, so the three columns of one row take equal widths; with exact the split divides only
// the card that it splits (docs/spec/groups.md#split-setting).
func TestTheSplitSettingBalancesTheGrid(t *testing.T) {
	f := layoutShell(t, oneCard(tab("t1", "notes")))
	f.tester.SetSize(1400, 900)
	f.settle()
	for range 2 {
		if _, err := f.apply("core.card.split", `{"card": "main", "side": "right", "plugin": "plain"}`); err != nil {
			t.Fatal(err)
		}
	}
	cards := f.gridCards()
	if w := cards["card-2"]["w"].(float64); w < 1.5*cards["main"]["w"].(float64) {
		t.Fatalf("with cardSplit exact card-2 is %v wide and main %v", w, cards["main"]["w"])
	}
	f.shellFixture.run("core.settings.set", map[string]any{"patch": map[string]any{"cardSplit": "even"}})
	if _, err := f.apply("core.card.split", `{"card": "main", "side": "bottom", "plugin": "plain"}`); err != nil {
		t.Fatal(err)
	}
	cards = f.gridCards()
	width := cards["main"]["w"].(float64)
	for _, id := range []string{"card-2", "card-3"} {
		if w := cards[id]["w"].(float64); w < width-1 || w > width+1 {
			t.Fatalf("with cardSplit even card %s is %v wide and main %v", id, w, width)
		}
	}
}

// The close of a nested group card at the left of its group gives its cells to the card of the same group beside it, although the
// fill order of the layout library tries the card of another group above it first (docs/spec/groups.md#closing).
func TestTheCloseOfANestedGroupGivesItsCellsToItsGroup(t *testing.T) {
	space := gridSpace("spc-aaaaaa", []float64{0, 0.11567838541666667, 0.23510416666666664, 0.5, 1}, []float64{0, 0.33127317676143386, 0.6687268232385661, 1},
		gridCard("terminal", 0, 2, 0, 1, tab("t1", "notes")), gridCard("browser", 0, 1, 1, 2, tab("t2", "notes")),
		gridCard("card-8", 3, 4, 2, 3, tab("t3", "notes")), gridCard("card-7", 3, 4, 1, 2, tab("t4", "notes")),
		gridCard("card-3", 0, 3, 2, 3, tab("t5", "notes")), gridCard("card-5", 3, 4, 0, 1, tab("t6", "notes")),
		gridCard("card-10", 2, 3, 0, 1, tab("t7", "notes")), gridCard("card-12", 1, 2, 1, 2, tab("t8", "notes")),
		gridCard("card-13", 2, 3, 1, 2, tab("t9", "notes")))
	stored := space["layout"].(map[string]any)
	stored["groups"] = []any{
		map[string]any{"card": "card-9", "name": "그룹 1", "leader": "terminal", "members": []any{"terminal", "card-10"}},
		map[string]any{"card": "card-4", "name": "그룹 2", "leader": "card-11", "members": []any{
			map[string]any{"card": "card-11", "name": "그룹 3", "leader": "browser", "members": []any{"browser", "card-12"}},
			"card-13", "card-7", "card-3", "card-8"}},
	}
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
		Cards []map[string]json.RawMessage `json:"cards"`
	}
	if err := json.Unmarshal([]byte(f.status("core.grid")), &grid); err != nil {
		t.Fatal(err)
	}
	order := []string{}
	for _, entry := range grid.Cards {
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
	for _, request := range []string{`""`, `"` + strings.Repeat("r", 129) + `"`, `7`} {
		want := "core.group.create: request must be a string of 1 to 128 characters"
		if _, err := f.apply("core.group.create", `{"card": "main", "side": "right", "plugin": "plain", "request": `+request+`}`); err == nil ||
			err.Error() != want {
			t.Errorf("the request %s answered %v, not %q", request, err, want)
		}
	}
}

// Each press of the plugin item of the group menu groups the card, so a second press groups the card again
// (docs/spec/groups.md#idempotency).
func TestEachPressOfTheGroupMenuGroupsTheCard(t *testing.T) {
	f := layoutShell(t, oneCard(tab("t1", "notes")))
	// The window is wide, so main stays wider than high after the first group and the second press groups it toward right again.
	f.tester.SetSize(2400, 600)
	f.settle()
	for press := 1; press <= 2; press++ {
		if _, err := f.apply("core.card.menu", `{"card": "main", "menu": "group"}`); err != nil {
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
		if groups := strings.Count(f.status("core.layout"), `"name":"그룹 `); groups != press {
			t.Fatalf("after press %d the layout holds %d group cards: %s", press, groups, f.status("core.layout"))
		}
	}
}
