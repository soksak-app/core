package workbench_test

import (
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	sok "github.com/soksak-app/core/packages/sok/go/src"
	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// pickerStatus is the status core.picker as JSON.
type pickerStatus struct {
	Open  bool   `json:"open"`
	Title string `json:"title"`
	Items []struct {
		Key    string  `json:"key"`
		Name   string  `json:"name"`
		Active bool    `json:"active"`
		Group  *string `json:"group"`
	} `json:"items"`
	Groups []struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		Depth int    `json:"depth"`
	} `json:"groups"`
	Columns struct {
		Groups []struct {
			Icon float64 `json:"icon"`
			Name float64 `json:"name"`
		} `json:"groups"`
		Items []struct {
			Icon float64 `json:"icon"`
			Name float64 `json:"name"`
		} `json:"items"`
	} `json:"columns"`
}

func (f *shellFixture) menu() pickerStatus {
	f.t.Helper()
	value, err := f.shell.Registry().Read("core.picker")
	if err != nil {
		f.t.Fatal(err)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		f.t.Fatal(err)
	}
	var status pickerStatus
	if err := json.Unmarshal(encoded, &status); err != nil {
		f.t.Fatal(err)
	}
	return status
}

func (s pickerStatus) keys() []string {
	keys := []string{}
	for _, item := range s.Items {
		keys = append(keys, item.Key)
	}
	return keys
}

// recordingCommands makes the shell of host write the record workbench.command of each command that runs: the class call is at
// debug in the log policy of the host and in the log setting.
func recordingCommands(host *storedHost) *storedHost {
	classes := map[string]any{}
	for class, level := range sok.DefaultLogPolicy().Classes() {
		classes[class] = level
	}
	classes["call"] = "debug"
	host.classes = classes
	host.common["diagnostics.log"] = map[string]any{"call": "debug"}
	return host
}

// commandRecords is the number of records workbench.command of the command name that reached the host.
func (f *shellFixture) commandRecords(name string) int {
	f.t.Helper()
	f.settle()
	count := 0
	for _, event := range f.host.written("workbench.command") {
		if event["fields"].(map[string]any)["name"] == name {
			count++
		}
	}
	return count
}

// projectWithPlugins is a shown project of a window with the plugins of acmeDocument.
func projectWithPlugins(t *testing.T) *shellFixture {
	t.Helper()
	return projectOn(t, acme())
}

// projectOn is projectWithPlugins with the host host.
func projectOn(t *testing.T, host *storedHost) *shellFixture {
	t.Helper()
	f := newShell(t, host)
	f.run("core.library.form.open", map[string]string{"mode": "open"})
	f.run("core.library.form.set", map[string]string{"field": "parent", "value": "/work/alpha"})
	f.run("core.library.form.submit", nil)
	return f
}

func (f *shellFixture) tabsOf(card string) []any {
	f.t.Helper()
	for _, stored := range f.cardsOf() {
		if stored["id"] == card {
			return stored["data"].(map[string]any)["tabs"].([]any)
		}
	}
	f.t.Fatalf("no card %s", card)
	return nil
}

func TestTheAddToolAsksThePluginOfTheNewTab(t *testing.T) {
	f := projectWithPlugins(t)
	card := f.tabbedCards()[0]
	before := len(f.tabsOf(card))
	f.click("core.card.add", card)
	menu := f.menu()
	if !menu.Open || menu.Title != "새 탭에 무엇을 띄울까" || !slices.Equal(menu.keys(), []string{"acme"}) {
		t.Fatalf("the menu is %+v", menu)
	}
	if !f.tester.HasText("새 탭에 무엇을 띄울까") || !f.tester.HasText("Acme") || !f.has("core.picker.item-icon", "acme") || !f.has("core.picker.item-name", "acme") {
		t.Fatalf("the screen shows %q", f.tester.Texts())
	}
	f.audit()
	f.click("core.picker.item", "acme")
	if f.menu().Open {
		t.Fatal("the menu stays open after the pick")
	}
	tabs := f.tabsOf(card)
	if len(tabs) != before+1 || tabs[before].(map[string]any)["plugin"] != "acme" {
		t.Fatalf("the card holds %v", tabs)
	}
}

func TestTheSplitToolsAskThePluginOfTheNewCard(t *testing.T) {
	f := projectWithPlugins(t)
	before := f.tabbedCards()
	f.click("core.card.split-y", before[0])
	if menu := f.menu(); !menu.Open || menu.Title != "새 위치에 무엇을 띄울까" {
		t.Fatalf("the menu is %+v", menu)
	}
	if len(f.tabbedCards()) != len(before) {
		t.Fatal("the split ran before the pick")
	}
	f.click("core.picker.item", "acme")
	if len(f.tabbedCards()) != len(before)+1 {
		t.Fatalf("the split stored %v", f.tabbedCards())
	}
}

func TestTheButtonOfAMenuClosesItsMenu(t *testing.T) {
	f := projectWithPlugins(t)
	card := f.tabbedCards()[0]
	f.click("core.card.add", card)
	f.click("core.card.add", card)
	if f.menu().Open {
		t.Fatal("the second press leaves the menu open")
	}
}

// Escape and a press outside close the menu through core.picker.close, as the shortcut table and the layer of the page run it.
func TestEscapeAndAPressOutsideCloseTheMenu(t *testing.T) {
	f := projectOn(t, recordingCommands(acme()))
	card := f.tabbedCards()[0]
	f.click("core.card.add", card)
	f.tester.Key(0, ui.KeyEscape)
	f.settle()
	if f.menu().Open {
		t.Fatal("Escape leaves the menu open")
	}
	if got := f.commandRecords("core.picker.close"); got != 1 {
		t.Fatalf("Escape left %d records of core.picker.close, not 1", got)
	}
	f.click("core.card.add", card)
	f.tester.ClickAt(600, 500)
	f.settle()
	if f.menu().Open {
		t.Fatal("a press outside leaves the menu open")
	}
	if got := f.commandRecords("core.picker.close"); got != 2 {
		t.Fatalf("Escape and a press outside left %d records of core.picker.close, not 2", got)
	}
}

func TestPickAndCloseRefuseWhatIsNotThere(t *testing.T) {
	f := projectWithPlugins(t)
	if _, err := f.answer("core.picker.pick", map[string]int{"index": 0}); err == nil || !strings.Contains(err.Error(), "no menu is open") {
		t.Fatalf("the pick answered %v", err)
	}
	f.click("core.card.add", f.tabbedCards()[0])
	if _, err := f.answer("core.picker.pick", map[string]int{"index": 9}); err == nil || !strings.Contains(err.Error(), "no item 9") {
		t.Fatalf("the pick answered %v", err)
	}
	f.run("core.picker.close", nil)
	if f.menu().Open {
		t.Fatal("core.picker.close leaves the menu open")
	}
	f.click("core.card.add", f.tabbedCards()[0])
	f.run("core.modal.dismiss", nil)
	if f.menu().Open {
		t.Fatal("core.modal.dismiss leaves the menu open")
	}
}

func TestANarrowHeadHasTheToolMenuAndTheTabList(t *testing.T) {
	f := projectWithPlugins(t)
	card := f.tabbedCards()[0]
	f.run("core.card.add-tab", map[string]string{"card": card, "plugin": "acme"})
	f.tester.SetSize(150, 500)
	f.settle()
	if f.has("core.card.add", card) || !f.has("core.card.tools", card) || !f.has("core.card.tab-list", card) {
		t.Fatalf("the head has the tools %v, the menu %v and the list %v", f.has("core.card.add", card), f.has("core.card.tools", card), f.has("core.card.tab-list", card))
	}
	f.click("core.card.tools", card)
	menu := f.menu()
	if menu.Title != "카드 도구" || !slices.Equal(menu.keys()[:3], []string{"add", "y", "fullscreen"}) {
		t.Fatalf("the menu is %+v", menu)
	}
	f.click("core.picker.item", "add")
	if menu := f.menu(); !menu.Open || menu.Title != "새 탭에 무엇을 띄울까" {
		t.Fatalf("the tool add asks %+v", menu)
	}
	f.run("core.picker.close", nil)
	f.click("core.card.tab-list", card)
	menu = f.menu()
	if menu.Title != "탭 2개" || len(menu.Items) != 2 || !menu.Items[1].Active {
		t.Fatalf("the list is %+v", menu)
	}
	f.click("core.picker.item", menu.Items[0].Key)
	if data := f.tabsOf(card); len(data) != 2 {
		t.Fatalf("the card holds %v", data)
	}
	for _, stored := range f.cardsOf() {
		if stored["id"] == card && stored["data"].(map[string]any)["activeId"] != menu.Items[0].Key {
			t.Fatalf("the active tab is %v", stored["data"])
		}
	}
}

func TestCardMenuRefusesAMenuThatTheCardDoesNotHave(t *testing.T) {
	f := projectWithPlugins(t)
	card := f.tabbedCards()[0]
	if _, err := f.answer("core.card.menu", map[string]string{"card": card, "menu": "other"}); err == nil || !strings.Contains(err.Error(), "unknown menu other") {
		t.Fatalf("the menu answered %v", err)
	}
	if _, err := f.answer("core.card.menu", map[string]string{"card": "none", "menu": "add"}); err == nil {
		t.Fatal("an unknown card opened a menu")
	}
}

func TestTheSurfaceMenuOpensAtItsPoint(t *testing.T) {
	f := projectWithPlugins(t)
	card := f.tabbedCards()[0]
	tab, err := f.answer("core.card.add-tab", map[string]string{"card": card, "plugin": "acme"})
	if err != nil {
		t.Fatal(err)
	}
	f.run("core.surface.menu", map[string]any{"surface": tab["tab"], "x": 300, "y": 200})
	menu := f.menu()
	if menu.Title != "Acme" || !slices.Equal(menu.keys(), []string{"acme.copy"}) {
		t.Fatalf("the menu is %+v", menu)
	}
	box := f.box("core.picker.item", "acme.copy")
	if box.X < 300 || box.Y < 200 || box.X > 340 || box.Y > 280 {
		t.Fatalf("the item stands at %+v", box)
	}
}

func TestASurfaceWithoutAMenuIsRefused(t *testing.T) {
	f := projectWithPlugins(t)
	card := f.tabbedCards()[0]
	tabs := f.tabsOf(card)
	id := tabs[0].(map[string]any)["id"]
	if _, err := f.answer("core.surface.menu", map[string]any{"surface": id, "x": 1, "y": 1}); err == nil || !strings.Contains(err.Error(), "declares no menu") {
		t.Fatalf("the menu answered %v", err)
	}
}

func TestThePickerClosesWhenThePlaneChangesAndTheSettingsOpen(t *testing.T) {
	f := projectWithPlugins(t)
	card := f.tabbedCards()[0]
	f.click("core.card.add", card)
	f.run("core.card.add-tab", map[string]string{"card": card, "plugin": "acme"})
	if f.menu().Open {
		t.Fatal("a change of the plane leaves the menu open")
	}
	f.click("core.card.add", card)
	f.run("core.settings.open", nil)
	if f.menu().Open {
		t.Fatal("the settings leave the menu open")
	}
}

// A change of a setting settles the plane, also when it leaves the columns as they are.
func TestThePickerClosesWhenASettingChanges(t *testing.T) {
	for _, patch := range []map[string]any{{"left": false}, {"dim": false}} {
		f := projectWithPlugins(t)
		f.click("core.card.add", f.tabbedCards()[0])
		if !f.menu().Open {
			t.Fatal("the menu is not open")
		}
		f.run("core.settings.set", map[string]any{"patch": patch, "scope": "common"})
		if f.menu().Open {
			t.Fatalf("the change %v leaves the menu open", patch)
		}
	}
}

func TestScreenStatusNamesTheOpenModal(t *testing.T) {
	f := projectWithPlugins(t)
	read := func() string {
		value, err := f.shell.Registry().Read("core.screen")
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return string(encoded)
	}
	if got := read(); got != `{"screen":"workspace","modal":null}` {
		t.Fatalf("the status is %s", got)
	}
	f.click("core.card.add", f.tabbedCards()[0])
	if got := read(); got != `{"screen":"workspace","modal":"picker"}` {
		t.Fatalf("the status is %s", got)
	}
	f.run("core.settings.open", nil)
	if got := read(); got != `{"screen":"workspace","modal":"settings"}` {
		t.Fatalf("the status is %s", got)
	}
}

func TestARightClickOfATabOpensItsKeepItem(t *testing.T) {
	f := newTabShell(t, &storedHost{projects: []map[string]any{storedProject(tab("tab-aaaaaa", "notes"))}})
	f.open(t)
	node, ok := exposedNode(f.tester.ElementTree(), "core.card.tab", "tab-aaaaaa")
	if !ok {
		t.Fatal("no tab")
	}
	f.tester.RightClickAt(node.Bounds.X+4, node.Bounds.Y+4)
	f.settle()
	keep, ok := exposedNode(f.tester.ElementTree(), "core.tab.menu-keep", "keep")
	if !ok {
		t.Fatalf("no keep item; the texts are %q", f.tester.Texts())
	}
	if keep.Bounds.X < node.Bounds.X || keep.Bounds.Y < node.Bounds.Y {
		t.Fatalf("the item stands at %+v and the tab at %+v", keep.Bounds, node.Bounds)
	}
	f.tester.ClickAt(keep.Bounds.X+4, keep.Bounds.Y+4)
	f.settle()
	f.timers.tick(1000)
	f.settle()
	if len(f.keptPuts) != 1 {
		t.Fatalf("the store received %q", f.keptPuts)
	}
	f.run(t, "core.tab.menu", `{"tab":"tab-aaaaaa","x":10,"y":10}`)
	value, err := f.shell.Registry().Read("core.picker")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"key":"keep","name":"메모리에 유지","active":true`) {
		t.Fatalf("the menu is %s", encoded)
	}
}

func TestATabThatCanNeverUnloadHasNoMenu(t *testing.T) {
	f := newTabShell(t, &storedHost{projects: []map[string]any{storedProject(tab("tab-aaaaaa", "other"))}})
	f.open(t)
	_, err := f.shell.Registry().Run("core.tab.menu", json.RawMessage(`{"tab":"tab-aaaaaa","x":1,"y":1}`))
	if err == nil || !strings.Contains(err.Error(), "no menu items") {
		t.Fatalf("the menu answered %v", err)
	}
}

// A tab takes the params of core.card.add-tab, the card takes the focus, and params that the plugin does not declare are refused.
func TestAddTabStoresTheDeclaredParamsAndFocusesTheCard(t *testing.T) {
	f := projectWithPlugins(t)
	first := f.tabbedCards()[0]
	split, err := f.answer("core.card.split", map[string]string{"card": first, "side": "right", "plugin": "acme"})
	if err != nil {
		t.Fatal(err)
	}
	f.run("core.card.focus", map[string]string{"card": split["card"].(string)})

	answer, err := f.answer("core.card.add-tab", map[string]any{"card": first, "plugin": "acme", "params": map[string]any{"path": "a.txt"}})
	if err != nil {
		t.Fatal(err)
	}
	tabs := f.tabsOf(first)
	added := tabs[len(tabs)-1].(map[string]any)
	if added["id"] != answer["tab"] || !reflect.DeepEqual(added["params"], map[string]any{"path": "a.txt"}) {
		t.Fatalf("the stored tab is %v", added)
	}
	for _, card := range status[gridRead](t, f, "core.grid").Cards {
		if card.Focused != (card.ID == first) {
			t.Fatalf("the focus is %+v after a tab was added to %s", card, first)
		}
	}

	before := len(f.tabsOf(first))
	if _, err := f.answer("core.card.add-tab", map[string]any{"card": first, "plugin": "acme", "params": map[string]any{"path": 7}}); err == nil || err.Error() != "params do not match acme surface.params" {
		t.Fatalf("the refusal is %v", err)
	}
	if got := len(f.tabsOf(first)); got != before {
		t.Fatalf("a refused tab was added: %d tabs, was %d", got, before)
	}
	// A null is no params.
	if _, err := f.answer("core.card.add-tab", map[string]any{"card": first, "plugin": "acme", "params": nil}); err != nil {
		t.Fatal(err)
	}
	tabs = f.tabsOf(first)
	if _, stored := tabs[len(tabs)-1].(map[string]any)["params"]; stored {
		t.Fatalf("a null is stored: %v", tabs[len(tabs)-1])
	}
}

func TestAPluginWithoutDeclaredParamsRefusesThem(t *testing.T) {
	f := newShell(t, &storedHost{installed: `{"plugins":[{"id":"plain","package":"plain","version":"1.0.0","manifest":{"id":"plain","name":"Plain","description":"plain","mark":"Pl","icon":"<path d=\"M1 1h14\"/>",
		"surface":{"composition":{"kind":"view","page":"a.html"}}}}]}`})
	f.run("core.library.form.open", map[string]string{"mode": "open"})
	f.run("core.library.form.set", map[string]string{"field": "parent", "value": "/work/alpha"})
	f.run("core.library.form.submit", nil)
	if _, err := f.answer("core.card.add-tab", map[string]any{"card": f.tabbedCards()[0], "plugin": "plain", "params": map[string]any{"path": "a"}}); err == nil || err.Error() != "plugin plain declares no tab params" {
		t.Fatalf("the refusal is %v", err)
	}
}

// modifiedShell is a shown project with the tabs a and b of a plugin that saves. The tab a is modified.
func modifiedShell(t *testing.T) *tabShell {
	t.Helper()
	f := newTabShell(t, &storedHost{installed: `{"plugins":[{"id":"notes","package":"notes","version":"1.0.0","manifest":{"id":"notes","name":"Notes",
		"description":"notes","mark":"N","icon":"<path d=\"M1 1h14\"/>","surface":{"composition":{"kind":"view","page":"n.html"},"save":"notes.save"},
		"exposes":{"commands":[{"name":"notes.save","description":"saves","params":{"type":"object","properties":{}},"result":{"type":"null"}}]}}}]}`,
		projects: []map[string]any{storedProject(tab("tab-aaaaaa", "notes"), tab("tab-bbbbbb", "notes"))}})
	f.open(t)
	f.modified("tab-aaaaaa")
	return f
}

// viewCalled delivers a call of the view of a tab.
func (f *tabShell) viewCalled(surface, command string, params any) {
	f.t.Helper()
	f.shell.Event("view-call", []any{map[string]any{"surface": surface, "plugin": "notes", "generation": 1, "id": 5, "command": command, "params": params}})
	f.settle()
}

// modified makes the view of a tab report changes that are not saved.
func (f *tabShell) modified(surface string) {
	f.t.Helper()
	f.viewCalled(surface, "tab.modified", true)
}

func TestAKeptModifiedTabKeepsItsProject(t *testing.T) {
	f := modifiedShell(t)
	project := status[map[string]any](t, f.shellFixture, "core.project")["id"].(string)
	var value any
	var failure error
	answered := false
	f.shell.Registry().RunLater("core.project.close", json.RawMessage(`{"id":"`+project+`"}`), func(result any, err error) {
		value, failure, answered = result, err, true
	})
	f.settle()
	if answered {
		t.Fatalf("the command answered %v with %v before the question", value, failure)
	}
	f.click("core.picker.item", "keep")
	f.settle()
	if !answered || failure != nil || !reflect.DeepEqual(value, map[string]bool{"closed": false}) {
		t.Fatalf("the command answered %v, %v with %v", answered, value, failure)
	}
	if len(f.host.projects) != 1 {
		t.Fatalf("the host stores %v", f.host.projects)
	}
}

func TestAModifiedTabAsksBeforeItCloses(t *testing.T) {
	f := modifiedShell(t)
	answer := f.run(t, "core.tab.close", `{"tab":"tab-aaaaaa"}`).(map[string]bool)
	if answer["closed"] {
		t.Fatal("the tab closed")
	}
	f.settle()
	menu := f.menu()
	if menu.Title != "● tab-aaaaaa 탭에 저장하지 않은 변경이 있습니다" || !slices.Equal(menu.keys(), []string{"save", "discard", "keep"}) {
		t.Fatalf("the question is %+v", menu)
	}
	f.click("core.picker.item", "keep")
	if len(f.tabsOf("main")) != 2 {
		t.Fatal("the keep answer closed the tab")
	}
	f.run(t, "core.tab.close", `{"tab":"tab-aaaaaa"}`)
	f.settle()
	f.click("core.picker.item", "discard")
	if tabs := f.tabsOf("main"); len(tabs) != 1 || tabs[0].(map[string]any)["id"] != "tab-bbbbbb" {
		t.Fatalf("the card holds %v", tabs)
	}
}

func TestClosingACardAsksAboutEachModifiedTab(t *testing.T) {
	f := modifiedShell(t)
	if _, err := f.answer("core.card.split", map[string]string{"card": "main", "side": "right", "plugin": "notes"}); err != nil {
		t.Fatal(err)
	}
	// A hidden tab has no view until the host holds its surface, and showing the tab makes the host hold it.
	f.run(t, "core.tab.select", `{"tab":"tab-bbbbbb"}`)
	f.settle()
	f.modified("tab-bbbbbb")
	answer := f.run(t, "core.card.close", `{"card":"main"}`).(map[string]bool)
	if answer["closed"] {
		t.Fatal("the card closed")
	}
	f.settle()
	f.click("core.picker.item", "discard")
	menu := f.menu()
	if !menu.Open || !strings.HasPrefix(menu.Title, "● tab-bbbbbb ") {
		t.Fatalf("the next question is %+v", menu)
	}
	f.click("core.picker.item", "discard")
	for _, id := range f.tabbedCards() {
		if id == "main" {
			t.Fatal("the card stays")
		}
	}
}

// The question names the tab as its head does, with the title its view reported and the mark of a modified tab.
func TestTheQuestionNamesTheTabAsItsHeadDoes(t *testing.T) {
	f := modifiedShell(t)
	f.viewCalled("tab-aaaaaa", "tab.title", "readme.txt")
	f.run(t, "core.tab.close", `{"tab":"tab-aaaaaa"}`)
	f.settle()
	if menu := f.menu(); menu.Title != "● readme.txt 탭에 저장하지 않은 변경이 있습니다" {
		t.Fatalf("the question is %q", menu.Title)
	}
}

func TestASavedTabCloses(t *testing.T) {
	f := modifiedShell(t)
	f.viewCalled("tab-aaaaaa", "runtime.command.register", map[string]any{"name": "notes.save"})
	f.run(t, "core.tab.close", `{"tab":"tab-aaaaaa"}`)
	f.settle()
	item, ok := exposedNode(f.tester.ElementTree(), "core.picker.item", "save")
	if !ok {
		t.Fatal("no save item")
	}
	f.viewCalled("tab-aaaaaa", "tab.modified", false) // The view saves before it answers.
	f.tester.ClickAt(item.Bounds.X+4, item.Bounds.Y+4)
	f.settle()
	forwards := f.host.forwards
	if len(forwards) != 1 || forwards[0]["surface"] != "tab-aaaaaa" {
		t.Fatalf("the host forwarded %v", forwards)
	}
	if params, _ := forwards[0]["params"].(map[string]any); params["name"] != "notes.save" {
		t.Fatalf("the host forwarded %v", forwards)
	}
	if tabs := f.tabsOf("main"); len(tabs) != 1 {
		t.Fatalf("the tabs are %v", tabs)
	}
}

func TestAFailedSaveKeepsTheTabAndShowsTheError(t *testing.T) {
	f := modifiedShell(t)
	f.run(t, "core.tab.close", `{"tab":"tab-aaaaaa"}`)
	f.settle()
	item, ok := exposedNode(f.tester.ElementTree(), "core.picker.item", "save")
	if !ok {
		t.Fatal("no save item")
	}
	f.tester.ClickAt(item.Bounds.X+4, item.Bounds.Y+4)
	if shown := f.shownErrors(); len(shown) != 1 || !strings.Contains(shown[0], "저장하지 못했습니다 · notes.save: ") {
		t.Fatalf("the shell showed %q", shown)
	}
	f.settle()
	if len(f.tabsOf("main")) != 2 {
		t.Fatal("the tab closed")
	}
}

// A save that succeeds but leaves the tab modified keeps the tab, and its failure is the error of the tab, which core.grid reports
// and the card records, as reportError of packages/workbench/plane.js reports it (docs/spec/plugins.md#tab-reports).
func TestASaveThatLeavesTheTabModifiedIsTheErrorOfTheTab(t *testing.T) {
	f := modifiedShell(t)
	f.viewCalled("tab-aaaaaa", "runtime.command.register", map[string]any{"name": "notes.save"})
	f.run(t, "core.tab.close", `{"tab":"tab-aaaaaa"}`)
	f.settle()
	item, ok := exposedNode(f.tester.ElementTree(), "core.picker.item", "save")
	if !ok {
		t.Fatal("no save item")
	}
	f.tester.ClickAt(item.Bounds.X+4, item.Bounds.Y+4)
	// The save answers after the frame that its run asked for, and the next frame draws the error of the tab.
	f.pending.drain(t)
	f.tester.Frame()
	refusal := "저장하지 못했습니다 · notes.save left the tab modified"
	if shown := f.shownRecords(); !slices.Contains(shown, shownRecord{where: "tab error tab-aaaaaa", text: refusal}) {
		t.Fatalf("the shell recorded %q", shown)
	}
	f.settle()
	if len(f.tabsOf("main")) != 2 {
		t.Fatal("the tab closed")
	}
	var reported []string
	for _, card := range status[struct {
		Cards []struct {
			Tabs []struct {
				ID       string  `json:"id"`
				Modified bool    `json:"modified"`
				Error    *string `json:"error"`
			} `json:"tabs"`
		} `json:"cards"`
	}](t, f.shellFixture, "core.grid").Cards {
		for _, tab := range card.Tabs {
			if tab.Error != nil {
				reported = append(reported, fmt.Sprintf("%s %v %s", tab.ID, tab.Modified, *tab.Error))
			}
		}
	}
	if want := []string{"tab-aaaaaa true " + refusal}; !slices.Equal(reported, want) {
		t.Fatalf("core.grid reports the tab errors %q, want %q", reported, want)
	}
}

func TestClosingTheActiveSpaceAsksAboutItsModifiedTabs(t *testing.T) {
	f := modifiedShell(t)
	if _, err := f.shell.Registry().Run("core.space.add", nil); err != nil {
		t.Fatal(err)
	}
	f.settle()
	project := f.host.projects[0]
	spaces := project["spaces"].([]any)
	if len(spaces) != 2 {
		t.Fatalf("the project holds %v", spaces)
	}
	first := spaces[0].(map[string]any)["id"]
	f.run(t, "core.space.activate", `{"id":"`+first.(string)+`"}`)
	var value any
	answered := false
	f.shell.Registry().RunLater("core.space.close", json.RawMessage(`{"id":"`+first.(string)+`"}`), func(result any, err error) {
		if err != nil {
			t.Fatal(err)
		}
		value, answered = result, true
	})
	f.settle()
	if answered {
		t.Fatal("the close answered before the question")
	}
	f.click("core.picker.item", "keep")
	if !answered || value.(map[string]bool)["closed"] {
		t.Fatalf("the close answered %v", value)
	}
	if len(f.host.projects[0]["spaces"].([]any)) != 2 {
		t.Fatal("the space closed")
	}
}

// The head of a fullscreen card starts with the button of the space apps, which lists every tab of the space by card, and a pick moves the
// full screen to the card of the tab.
func TestTheSpaceAppsListTheTabsOfTheSpaceByCard(t *testing.T) {
	f := projectWithPlugins(t)
	first := f.tabbedCards()[0]
	f.run("core.card.split", map[string]any{"card": first, "side": "right", "plugin": "acme"})
	cards := f.tabbedCards()
	if len(cards) != 3 {
		t.Fatalf("the plane holds %v", cards)
	}
	if f.has("core.card.space-apps", first) {
		t.Fatal("a card that is not fullscreen shows the space apps button")
	}
	if _, err := f.answer("core.space.apps", map[string]any{"card": first}); err == nil || !strings.Contains(err.Error(), "is not fullscreen") {
		t.Fatalf("a card that is not fullscreen answered %v", err)
	}
	f.run("core.card.fullscreen", map[string]any{"card": first})
	if !f.has("core.card.space-apps", first) || f.has("core.card.tab-list", first) {
		t.Fatalf("the head has the apps %v and the list %v", f.has("core.card.space-apps", first), f.has("core.card.tab-list", first))
	}
	f.click("core.card.space-apps", first)
	menu := f.menu()
	total := 0
	for _, card := range cards {
		total += len(f.tabsOf(card))
	}
	if !menu.Open || menu.Title != fmt.Sprintf("스페이스 앱 %d개", total) || len(menu.Items) != total || len(menu.Groups) != 3 {
		t.Fatalf("the list is %+v", menu)
	}
	// The first row is cut in two under the cut of the plane, so its cards stand one level in.
	want := []struct {
		name  string
		depth int
	}{{"카드 1", 1}, {"카드 2", 1}, {"카드 3", 0}}
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	indent, _ := declared.Metric("picker-indent")
	for index, group := range menu.Groups {
		if group.Name != want[index].name || group.Depth != want[index].depth {
			t.Fatalf("group %d is %+v, want %+v", index, group, want[index])
		}
		if got, flat := menu.Columns.Groups[index].Icon, menu.Columns.Groups[2].Icon; got != flat+float64(group.Depth)*indent {
			t.Fatalf("the icon of group %d stands at %v over %v", index, got, flat)
		}
		if !f.has("core.picker.group-icon", group.ID) || !f.has("core.picker.group-name", group.ID) {
			t.Fatalf("group %s is not drawn", group.ID)
		}
	}
	var picked string
	for index, item := range menu.Items {
		owner, tab, _ := strings.Cut(item.Key, "/")
		if item.Group == nil || *item.Group != owner {
			t.Fatalf("item %+v stands in another group", item)
		}
		if item.Active != (owner == first && tab == f.activeOf(first)) {
			t.Fatalf("item %+v is marked wrongly", item)
		}
		if column := menu.Columns.Items[index]; column.Icon != menu.Columns.Groups[f.groupIndex(menu, owner)].Icon {
			t.Fatalf("item %d stands at %v under another heading", index, column.Icon)
		}
		if owner != first {
			picked = item.Key
		}
	}
	f.click("core.card.space-apps", first)
	if f.menu().Open {
		t.Fatal("a second press leaves the list open")
	}
	f.click("core.card.space-apps", first)
	f.click("core.picker.item", picked)
	owner, tab, _ := strings.Cut(picked, "/")
	grid := status[gridRead](t, f, "core.grid")
	if grid.Fullscreen == nil || *grid.Fullscreen != owner || f.activeOf(owner) != tab {
		t.Fatalf("the pick left the full screen on %v with the tab %s", grid.Fullscreen, f.activeOf(owner))
	}
	if !f.has("core.card.space-apps", owner) || f.has("core.card.tab-list", owner) {
		t.Fatal("the new fullscreen card has no space apps button")
	}
}

func (f *shellFixture) activeOf(card string) string {
	for _, stored := range f.cardsOf() {
		if stored["id"] == card {
			active, _ := stored["data"].(map[string]any)["activeId"].(string)
			return active
		}
	}
	return ""
}

func (f *shellFixture) groupIndex(menu pickerStatus, id string) int {
	for index, group := range menu.Groups {
		if group.ID == id {
			return index
		}
	}
	f.t.Fatalf("no group %s", id)
	return -1
}

// A layer of a picker has the middle radius of the page, --r-sm: its left border is straight from that distance above its bottom, which is
// still inside the curve of the whole radius.
func TestTheLayerOfAPickerTakesTheMiddleRadius(t *testing.T) {
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	pad, ok := declared.Metric("picker-outer-pad")
	if !ok {
		t.Fatal("no metric picker-outer-pad")
	}
	f := projectWithPlugins(t)
	f.run("core.settings.theme", map[string]any{"name": "midnight", "mode": "dark"})
	f.settle()
	f.click("core.card.add", f.tabbedCards()[0])
	keys := f.menu().keys()
	last := f.box("core.picker.item", keys[len(keys)-1])
	x, y := last.X-float32(pad)-1, last.Y+last.H+float32(pad)+1
	// The edge of the curve is antialiased, so the color only comes near that of the border.
	if got, want := f.pixelOf(x+0.5, y-8.5), themeToken(t, "midnight", "dark", "edge"); int(want.R)-int(got.R) > 3 {
		t.Fatalf("the left border of the layer is %v at 8.5 above its bottom, near %v is wanted", got, want)
	}
}

// A close request of the window, as Cmd+W sends, asks about a modified tab: discarding closes the window and keeping keeps it and tells
// the host (docs/spec/plugins.md#tab-reports).
func TestACloseRequestOfTheWindowAsksAboutAModifiedTab(t *testing.T) {
	for _, answer := range []struct {
		key  string
		call string
	}{{"keep", "windowCloseKept"}, {"discard", "windowClose"}} {
		t.Run(answer.key, func(t *testing.T) {
			f := modifiedShell(t)
			f.shell.Event("project-close-request", nil)
			f.settle()
			if f.host.called("windowClose") {
				t.Fatal("the window closed before the question")
			}
			if !f.tester.HasText("저장하지 않고 닫기") {
				t.Fatalf("no question in %q", f.tester.Texts())
			}
			item, ok := exposedNode(f.tester.ElementTree(), "core.picker.item", answer.key)
			if !ok {
				t.Fatal("no item")
			}
			f.tester.ClickAt(item.Bounds.X+4, item.Bounds.Y+4)
			f.settle()
			if !f.host.called(answer.call) {
				t.Fatalf("the answer %s called %v", answer.key, f.host.calls)
			}
			if answer.key == "keep" && f.host.called("windowClose") {
				t.Fatal("the kept tab closed the window")
			}
		})
	}
}

// nodeLabeled returns the first element with the label.
func nodeLabeled(nodes []ui.ElementNode, label string) (ui.ElementNode, bool) {
	for _, node := range nodes {
		if node.Label == label && len(node.Children) == 0 {
			return node, true
		}
		if found, ok := nodeLabeled(node.Children, label); ok {
			return found, true
		}
	}
	return ui.ElementNode{}, false
}

// The title of a layer has the tracking of a section name, as .picker__head has on the page.
func TestTheTitleOfALayerHasTheSectionTracking(t *testing.T) {
	f, _ := surfaceShell(t)
	f.click("core.card.add", f.tabbedCards()[0])
	const title = "새 탭에 무엇을 띄울까"
	node, ok := nodeLabeled(f.tester.ElementTree(), title)
	if !ok {
		t.Fatalf("no title %q in %q", title, f.tester.Texts())
	}
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	size, _ := declared.Metric("text-caption-at-base")
	catalog, err := workbench.ReadSettingsCatalog()
	if err != nil {
		t.Fatal(err)
	}
	stack := catalog.Stack(status[map[string]any](t, f, "core.settings")["values"].(map[string]any)["font"].(string))
	plain := ui.NewTester(func(c *ui.Context) {
		ui.Row(c).Children(func() { ui.Text(c, title).FontSize(float32(size)).Font(stack) })
	}, 1000, 100)
	bare, ok := nodeLabeled(plain.ElementTree(), title)
	if !ok {
		t.Fatalf("no plain element of %q", title)
	}
	// The element of the title fills the layer, so the width of the text is that of its ink.
	background := f.pixelOf(node.Bounds.X+node.Bounds.W-1, node.Bounds.Y+1)
	right := node.Bounds.X
	for x := node.Bounds.X; x < node.Bounds.X+node.Bounds.W; x++ {
		for y := node.Bounds.Y; y < node.Bounds.Y+node.Bounds.H; y++ {
			if f.pixelOf(x, y) != background {
				right = x
			}
		}
	}
	ink := right - node.Bounds.X
	if want := bare.Bounds.W + 0.04*float32(size)*float32(len([]rune(title))-1)/2; ink < want {
		t.Fatalf("the ink of the title is %v wide, want at least %v", ink, want)
	}
}

// A row of a layer has the line height of the page.
func TestARowOfALayerHasTheLineHeightOfThePage(t *testing.T) {
	f, _ := surfaceShell(t)
	f.click("core.card.add", f.tabbedCards()[0])
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	metric := func(name string) float32 {
		value, ok := declared.Metric(name)
		if !ok {
			t.Fatalf("no metric %s", name)
		}
		return float32(value)
	}
	item, ok := exposedNode(f.tester.ElementTree(), "core.picker.item", "")
	if !ok {
		t.Fatal("no item")
	}
	want := 2*metric("picker-item-pad-y") + metric("text-control-at-base")*metric("line-height")
	if item.Bounds.H < want-1 || item.Bounds.H > want+1 {
		t.Fatalf("the row is %v high, want %v", item.Bounds.H, want)
	}
}

// The question about a tab, which stands over the workbench, breaks at the spaces too.
func TestAQuestionBreaksAtTheSpaces(t *testing.T) {
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	size, _ := declared.Metric("text-caption-at-base")
	f := modifiedShell(t)
	f.run(t, "core.tab.close", `{"tab":"tab-aaaaaa"}`)
	f.settle()
	title := ""
	for _, text := range f.tester.Texts() {
		if strings.Contains(text, "탭에 저장하지 않은 변경이 있습니다") {
			title = text
		}
	}
	node, ok := nodeLabeled(f.tester.ElementTree(), title)
	if !ok || title == "" {
		t.Fatalf("no title in %q", f.tester.Texts())
	}
	if node.Bounds.H < 2*float32(size) {
		t.Fatalf("the title %q is one line of %v", title, node.Bounds.H)
	}
	if ink := lastLineInk(f.shellFixture, node); ink < 3*float32(size) {
		t.Fatalf("the last line of the title is %v wide: it broke inside a word", ink)
	}
}

// The question about a tab stands under the whole tab, its name and its close button, and ends with it (askBeforeClose of packages/workbench/plane.js).
func TestTheQuestionStandsUnderTheWholeTab(t *testing.T) {
	f := modifiedShell(t)
	f.run(t, "core.tab.close", `{"tab":"tab-aaaaaa"}`)
	f.settle()
	var find func(nodes []ui.ElementNode) (ui.ElementNode, bool)
	find = func(nodes []ui.ElementNode) (ui.ElementNode, bool) {
		for _, node := range nodes {
			if node.Label == f.menu().Title {
				return node, true
			}
			if found, ok := find(node.Children); ok {
				return found, true
			}
		}
		return ui.ElementNode{}, false
	}
	panel, ok := find(f.tester.ElementTree())
	if !ok {
		t.Fatal("no question")
	}
	whole := f.box("core.card.tab", "tab-aaaaaa")
	bottom := whole.Y + whole.H
	end := whole.X + whole.W
	if panel.Bounds.Y != bottom+5 || panel.Bounds.X+panel.Bounds.W != end {
		t.Fatalf("the question %+v stands under a tab that ends at %v, %v", panel.Bounds, end, bottom)
	}
}

// A picker takes the keyboard on its first item, and Tab goes through its items (the focus of openLayer of the page).
func TestAPickerTakesTheKeyboardOnItsFirstItem(t *testing.T) {
	type focused struct {
		Name  string `json:"name"`
		Index int    `json:"index"`
	}
	f := modifiedShell(t)
	f.run(t, "core.tab.close", `{"tab":"tab-aaaaaa"}`)
	f.settle()
	if got := status[*focused](t, f.shellFixture, "core.focus"); got == nil || got.Name != "core.picker.item" || got.Index != 0 {
		t.Fatalf("after the question opened the focus is %+v", got)
	}
	f.tester.Key(0, ui.KeyTab)
	f.settle()
	if got := status[*focused](t, f.shellFixture, "core.focus"); got == nil || got.Name != "core.picker.item" || got.Index != 1 {
		t.Fatalf("after Tab the focus is %+v", got)
	}
}

// A picker item that the keyboard reached has the look of a hovered one and no outline (.picker__item:focus-visible).
func TestAFocusedPickerItemIsDrawnAsAHoveredOne(t *testing.T) {
	f := modifiedShell(t)
	f.run(t, "core.tab.close", `{"tab":"tab-aaaaaa"}`)
	f.settle()
	const label = "저장하지 않고 닫기"
	node, ok := pressLabeled(f.tester.ElementTree(), label)
	if !ok {
		t.Fatalf("no item %q in %q", label, f.tester.Texts())
	}
	x, y := node.Bounds.X+node.Bounds.W-4, node.Bounds.Y+node.Bounds.H/2
	f.tester.Move(node.Bounds.X+node.Bounds.W/2, y)
	f.settle()
	hovered := f.pixelOf(x, y)
	f.tester.Move(1, 1)
	f.settle()
	if rest := f.pixelOf(x, y); rest == hovered {
		t.Fatalf("a hovered item has the background %v of one at rest", hovered)
	}
	f.tester.Key(0, ui.KeyTab)
	f.settle()
	if !f.tester.Focused(label) {
		t.Fatalf("Tab did not reach the item %q", label)
	}
	if got := f.pixelOf(x, y); got != hovered {
		t.Fatalf("a focused item has the background %v, a hovered one %v", got, hovered)
	}
	if got := f.pixelOf(node.Bounds.X+node.Bounds.W/2, node.Bounds.Y+1); got != hovered {
		t.Fatalf("a focused item has the outline %v at its edge, a hovered one the background %v", got, hovered)
	}
}

// pressLabeled finds the button of a label in a tree, which the name and the icon of an item share.
func pressLabeled(nodes []ui.ElementNode, label string) (ui.ElementNode, bool) {
	for _, node := range nodes {
		if node.Role == ui.RoleButton && node.Label == label {
			return node, true
		}
		if found, ok := pressLabeled(node.Children, label); ok {
			return found, true
		}
	}
	return ui.ElementNode{}, false
}
