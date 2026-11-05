package workbench_test

import (
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
)

// pickerStatus is the status core.picker as JSON.
type pickerStatus struct {
	Open  bool   `json:"open"`
	Title string `json:"title"`
	Items []struct {
		Key    string `json:"key"`
		Name   string `json:"name"`
		Active bool   `json:"active"`
	} `json:"items"`
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

// projectWithPlugins is a shown project of a window with the plugins of acmeDocument.
func projectWithPlugins(t *testing.T) *shellFixture {
	t.Helper()
	f := newShell(t, acme())
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

func TestEscapeAndAPressOutsideCloseTheMenu(t *testing.T) {
	f := projectWithPlugins(t)
	card := f.tabbedCards()[0]
	f.click("core.card.add", card)
	f.tester.Key(0, ui.KeyEscape)
	f.settle()
	if f.menu().Open {
		t.Fatal("Escape leaves the menu open")
	}
	f.click("core.card.add", card)
	f.tester.ClickAt(600, 500)
	f.settle()
	if f.menu().Open {
		t.Fatal("a press outside leaves the menu open")
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
	if value, err := f.shell.Registry().Read("core.modal"); err != nil || value != nil {
		t.Fatalf("the status core.modal is %v, %v", value, err)
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
	f := newShell(t, &storedHost{installed: `{"plugins":[{"id":"plain","package":"plain","version":"1.0.0","manifest":{"id":"plain","name":"Plain","mark":"Pl",
		"surface":{"composition":{"kind":"view","page":"a.html"}}}}]}`})
	f.run("core.library.form.open", map[string]string{"mode": "open"})
	f.run("core.library.form.set", map[string]string{"field": "parent", "value": "/work/alpha"})
	f.run("core.library.form.submit", nil)
	if _, err := f.answer("core.card.add-tab", map[string]any{"card": f.tabbedCards()[0], "plugin": "plain", "params": map[string]any{"path": "a"}}); err == nil || err.Error() != "plugin plain declares no tab params" {
		t.Fatalf("the refusal is %v", err)
	}
}
