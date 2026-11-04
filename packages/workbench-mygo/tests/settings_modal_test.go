package workbench_test

import (
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// modalStatus is the value of core.settings-modal.
type modalStatus struct {
	Open    bool     `json:"open"`
	Section string   `json:"section"`
	Scope   string   `json:"scope"`
	Query   string   `json:"query"`
	Listed  []string `json:"listed"`
	Plugin  *string  `json:"plugin"`
	Editing *string  `json:"editing"`
	Rows    []struct {
		Key         string  `json:"key"`
		Name        string  `json:"name"`
		Description *string `json:"description"`
	} `json:"rows"`
	Card struct {
		X, Y, W, H float64
	} `json:"card"`
	Controls []struct {
		Name    string   `json:"name"`
		Index   int      `json:"index"`
		Key     *string  `json:"key"`
		Label   string   `json:"label"`
		On      *bool    `json:"on"`
		Value   *string  `json:"value"`
		Options []string `json:"options"`
		Groups  []struct {
			Label  string   `json:"label"`
			Values []string `json:"values"`
		} `json:"groups"`
		Command *struct {
			Name   string         `json:"name"`
			Params map[string]any `json:"params"`
		} `json:"command"`
	} `json:"controls"`
}

func (f *shellFixture) modal() modalStatus {
	f.t.Helper()
	value, err := f.shell.Registry().Read("core.settings-modal")
	if err != nil {
		f.t.Fatal(err)
	}
	text, err := json.Marshal(value)
	if err != nil {
		f.t.Fatal(err)
	}
	var status modalStatus
	if err := json.Unmarshal(text, &status); err != nil {
		f.t.Fatal(err)
	}
	return status
}

func (s modalStatus) keys(name string) []string {
	var keys []string
	for _, control := range s.Controls {
		if control.Name == name && control.Key != nil {
			keys = append(keys, *control.Key)
		}
	}
	return keys
}

func (s modalStatus) labels(name string) []string {
	var labels []string
	for _, control := range s.Controls {
		if control.Name == name {
			labels = append(labels, control.Label)
		}
	}
	return labels
}

// acmeDocument is the document of two installed plugins: one with a surface, sections and settings, and one without them.
const acmeDocument = `{"plugins":[
	{"id":"plain","package":"plain","version":"1.0.0","manifest":{"id":"plain","name":"Plain","description":"nothing"}},
	{"id":"acme","package":"acme","version":"1.0.0","manifest":{"id":"acme","name":"Acme","description":"the files",
		"mark":"Ac","icon":"<path d=\"M1 1h14\"/>",
		"surface":{"composition":{"kind":"view","page":"a.html"},"menu":[{"command":"acme.copy","title":"복사"}]},
		"sections":[{"id":"acme.files","name":"파일","composition":{"kind":"view","page":"f.html"},"height":"fill"},
			{"id":"acme.git","name":"변경","composition":{"kind":"view","page":"g.html"},"height":120}],
		"settings":{"level":{"type":"integer","label":"수준","description":"높을수록 많다","minimum":1,"maximum":5,"default":2},
			"mode":{"type":"enum","label":"방식","values":["a","b"],"default":"a"}}}}]}`

func acme() *storedHost {
	return &storedHost{
		common:    map[string]any{"sets": []any{map[string]any{"id": "set-1", "title": "하나", "sections": []any{"acme.files"}, "layout": "list"}}},
		installed: acmeDocument,
	}
}

func opened(t *testing.T) *shellFixture {
	t.Helper()
	f := newShell(t, acme())
	f.click("core.chrome.settings", "")
	return f
}

func TestTheSettingsButtonOpensTheCardWithItsThreeSections(t *testing.T) {
	f := newShell(t, acme())
	if f.modal().Open || f.has("core.settings-modal.card", "") {
		t.Fatal("the settings are open before the button")
	}
	f.click("core.chrome.settings", "")
	status := f.modal()
	if !status.Open || status.Section != "general" || status.Scope != "common" {
		t.Fatalf("status %+v", status)
	}
	for _, name := range []string{"core.settings-modal.card", "core.settings-modal.scrim", "core.settings-modal.grip", "core.settings-modal.close"} {
		if !f.has(name, "") {
			t.Fatalf("no element %s", name)
		}
	}
	if got := status.keys("core.settings-modal.nav"); !slices.Equal(got, []string{"nav:general", "nav:plugins", "nav:sidebars"}) {
		t.Fatalf("nav %q", got)
	}
	if got := status.labels("core.settings-modal.nav"); !slices.Equal(got, []string{"일반", "플러그인", "사이드바"}) {
		t.Fatalf("nav labels %q", got)
	}
	if status.Card.W != 560 || status.Card.X != (1200-560)/2 || status.Card.Y != 72 {
		t.Fatalf("card %+v", status.Card)
	}
}

func TestOnlyTheCloseButtonClosesTheCardAndTheScrimBlocksWhatIsBelow(t *testing.T) {
	f := openedShell(t)
	projects, ok := exposedNode(f.tester.ElementTree(), "core.chrome.projects", "")
	if !ok {
		t.Fatal("no projects button")
	}
	f.click("core.chrome.settings", "")
	card, _ := exposedNode(f.tester.ElementTree(), "core.settings-modal.card", "")
	f.tester.ClickAt(projects.Bounds.X+projects.Bounds.W/2, projects.Bounds.Y+projects.Bounds.H/2)
	f.tester.ClickAt(card.Bounds.X-40, card.Bounds.Y+40)
	f.tester.Key(0, ui.KeyEscape)
	f.settle()
	if !f.modal().Open {
		t.Fatal("a press outside or Escape closed the card")
	}
	f.audit()
	f.click("core.settings-modal.close", "")
	if f.modal().Open || f.has("core.settings-modal.scrim", "") {
		t.Fatal("the close button leaves the card")
	}
	if !f.has("core.chrome.projects", "") {
		t.Fatal("a press reached below the scrim")
	}
}

func TestTheSectionPluginSearchAndEditedSetLastUntilTheCardOpensAgain(t *testing.T) {
	f := opened(t)
	f.run("core.settings-modal.nav", map[string]any{"section": "plugins"})
	f.run("core.settings-modal.search", map[string]any{"query": "acm"})
	f.click("core.settings-modal.close", "")
	f.click("core.chrome.settings", "")
	if status := f.modal(); status.Section != "plugins" || status.Query != "acm" || !slices.Equal(status.Listed, []string{"acme"}) {
		t.Fatalf("after opening again %+v", status)
	}
}

func TestTheProjectScopeExistsOnlyWhileAProjectIsSelected(t *testing.T) {
	f := newShell(t, &storedHost{})
	f.click("core.chrome.settings", "")
	if got := f.modal().keys("core.settings-modal.scope"); !slices.Equal(got, []string{"pick:scope:common"}) {
		t.Fatalf("scopes %q", got)
	}
	_, err := f.shell.Registry().Run("core.settings-modal.scope", json.RawMessage(`{"scope":"project"}`))
	if err == nil || err.Error() != "scope project is not available" {
		t.Fatalf("project without a project: %v", err)
	}
}

func TestTheGeneralSectionDrawsEachFormWithItsOneControl(t *testing.T) {
	f := opened(t)
	status := f.modal()
	if got := status.keys("core.settings-modal.set"); !slices.Contains(got, "projectOpening") || !slices.Contains(got, "mode") ||
		!slices.Contains(got, "gap") || !slices.Contains(got, "left") || !slices.Contains(got, "link:left:") ||
		!slices.Contains(got, "sidebarWidth") || !slices.Contains(got, "memorySaverDelay") {
		t.Fatalf("settings %q", got)
	}
	if got := len(status.keys("core.settings-modal.theme")); got != 10 {
		t.Fatalf("%d theme swatches", got)
	}
	if got := status.labels("core.settings-modal.debug"); len(got) != 1 {
		t.Fatalf("debug %q", got)
	}
	for _, control := range status.Controls {
		if control.Name == "core.settings-modal.set" && control.Key != nil && *control.Key == "mode" {
			if !slices.Equal(control.Options, []string{"dark", "light"}) || *control.Value != "dark" || control.Command.Name != "core.settings.change" {
				t.Fatalf("mode %+v", control)
			}
		}
		if control.Name == "core.settings-modal.set" && control.Key != nil && *control.Key == "link:left:" {
			if !slices.Equal(control.Options, []string{"off", "set-1"}) || control.Command.Name != "core.settings.link" {
				t.Fatalf("link %+v", control)
			}
		}
	}
}

func TestASwitchAndASwatchRunTheirCommandAndTheChangeIsWritten(t *testing.T) {
	f := opened(t)
	f.click("core.settings-modal.theme", "theme:paper")
	values := f.settingValues()
	if values["theme"] != "paper" {
		t.Fatalf("theme %v", values["theme"])
	}
	f.tester.SetSize(1200, 2400)
	f.settle()
	f.click("core.settings-modal.set", "dim")
	if f.settingValues()["dim"] != true {
		t.Fatalf("dim %v", f.settingValues()["dim"])
	}
	if len(f.host.settings) != 2 || f.host.settings[1]["patch"].(map[string]any)["dim"] != true {
		t.Fatalf("writes %+v", f.host.settings)
	}
}

func TestASelectBoxASliderAndADebugSwitchChangeTheirSettings(t *testing.T) {
	f := opened(t)
	f.tester.SetSize(1200, 2400)
	f.settle()
	f.click("core.settings-modal.set", "mode")
	if err := f.tester.Click("밝음"); err != nil {
		t.Fatalf("%v; the texts are %q", err, f.tester.Texts())
	}
	f.settle()
	if f.settingValues()["mode"] != "light" {
		t.Fatalf("mode %v", f.settingValues()["mode"])
	}
	slider, ok := exposedNode(f.tester.ElementTree(), "core.settings-modal.set", "gap")
	if !ok {
		t.Fatal("no slider of the gap")
	}
	f.tester.ClickAt(slider.Bounds.X+slider.Bounds.W/2, slider.Bounds.Y+slider.Bounds.H/2)
	f.settle()
	if got := f.settingValues()["gap"].(float64); got == 6 || got != float64(int(got)) {
		t.Fatalf("gap %v", got)
	}
	f.click("core.settings-modal.debug", "")
	if value := f.settingValues()["diagnostics.performance"]; value != true {
		t.Fatalf("the debug switch %v", value)
	}
}

func TestTheKeysOfAnOpenSelectBoxChooseItsItem(t *testing.T) {
	f := opened(t)
	f.click("core.settings-modal.set", "mode")
	f.tester.Key(0, ui.KeyDown)
	f.tester.Key(0, ui.KeyEnter)
	f.settle()
	if f.settingValues()["mode"] != "light" {
		t.Fatalf("mode %v", f.settingValues()["mode"])
	}
	if _, ok := exposedNode(f.tester.ElementTree(), "core.settings-modal.close", ""); !ok {
		t.Fatal("the keys closed the settings window")
	}
}

func TestATitleIsSavedWhenTheFieldSubmits(t *testing.T) {
	f := opened(t)
	f.run("core.settings-modal.nav", map[string]any{"section": "sidebars"})
	f.run("core.settings-modal.edit", map[string]any{"set": "set-1"})
	f.click("core.settings-modal.set", "title:set-1")
	f.tester.Key(ui.Super, ui.KeyA)
	f.tester.Type("둘")
	f.settle()
	if strings.Contains(strings.Join(f.modal().labels("core.settings-modal.set-caption"), ""), "둘") {
		t.Fatal("a key saved the title")
	}
	f.tester.Key(0, ui.KeyEnter)
	f.settle()
	if got := f.modal().labels("core.settings-modal.set-caption"); !slices.Equal(got, []string{"둘 · 목록 · 파일"}) {
		t.Fatalf("captions %q", got)
	}
}

func TestThePositionOfTheContentHoldsUntilAnotherContentShows(t *testing.T) {
	f := opened(t)
	card, _ := exposedNode(f.tester.ElementTree(), "core.settings-modal.card", "")
	f.tester.Scroll(card.Bounds.X+300, card.Bounds.Y+300, 0, 200)
	f.settle()
	moved := 0.0
	read := func() float64 {
		value, err := f.shell.Registry().Read("core.settings-modal")
		if err != nil {
			t.Fatal(err)
		}
		text, _ := json.Marshal(value)
		var status struct{ Scroll float64 }
		if err := json.Unmarshal(text, &status); err != nil {
			t.Fatal(err)
		}
		return status.Scroll
	}
	if moved = read(); moved <= 0 {
		t.Fatalf("scroll %v", moved)
	}
	f.run("core.settings.change", map[string]any{"key": "dim", "value": "true"})
	if got := read(); got != moved {
		t.Fatalf("a change moved the content from %v to %v", moved, got)
	}
	f.run("core.settings-modal.nav", map[string]any{"section": "plugins"})
	if got := read(); got != 0 {
		t.Fatalf("another section starts at %v", got)
	}
}

func TestTheProjectScopeShowsTheFolderAndResetsAnOverride(t *testing.T) {
	f := openedShell(t)
	f.click("core.chrome.settings", "")
	f.run("core.settings-modal.scope", map[string]any{"scope": "project"})
	f.run("core.settings.change", map[string]any{"key": "gap", "value": 2.0, "scope": "project"})
	status := f.modal()
	if got := status.keys("core.settings-modal.reset"); !slices.Equal(got, []string{"reset:gap"}) {
		t.Fatalf("resets %q", got)
	}
	if slices.Contains(status.keys("core.settings-modal.set"), "projectOpening") {
		t.Fatal("the project scope has a common-only setting")
	}
	last := f.host.settings[len(f.host.settings)-1]
	if last["id"] == "" || last["patch"].(map[string]any)["gap"] != 2.0 {
		t.Fatalf("write %+v", last)
	}
	f.tester.SetSize(1200, 2400)
	f.settle()
	f.click("core.settings-modal.reset", "reset:gap")
	if len(f.modal().keys("core.settings-modal.reset")) != 0 {
		t.Fatal("the reset leaves the override")
	}
}

func (f *shellFixture) settingValues() map[string]any {
	f.t.Helper()
	value, err := f.shell.Registry().Read("core.settings")
	if err != nil {
		f.t.Fatal(err)
	}
	return value.(workbench.SettingsStatus).Values
}

func TestAModeOfTheThemeRepaintsTheWorkbench(t *testing.T) {
	f := opened(t)
	dark := f.tester.Image().RGBAAt(2, 2)
	f.run("core.settings.theme", map[string]any{"name": "paper", "mode": "light"})
	f.run("core.settings.close", map[string]any{})
	if light := f.tester.Image().RGBAAt(2, 2); light == dark {
		t.Fatalf("the background stays %v", dark)
	}
}

func TestThePluginListFiltersByNameIdAndDescription(t *testing.T) {
	f := opened(t)
	f.run("core.settings-modal.nav", map[string]any{"section": "plugins"})
	if status := f.modal(); !slices.Equal(status.Listed, []string{"acme", "plain"}) {
		t.Fatalf("listed %q", status.Listed)
	}
	f.run("core.settings-modal.search", map[string]any{"query": "NOTHING"})
	if status := f.modal(); !slices.Equal(status.Listed, []string{"plain"}) {
		t.Fatalf("listed %q", status.Listed)
	}
	f.run("core.settings-modal.search", map[string]any{"query": "zzz"})
	if !f.tester.HasText("찾는 플러그인이 없습니다.") {
		t.Fatalf("texts %q", f.tester.Texts())
	}
}

func TestAPluginPageShowsItsSettingsSectionsAndSidebarChoices(t *testing.T) {
	f := opened(t)
	f.run("core.settings-modal.nav", map[string]any{"section": "plugins"})
	f.click("core.settings-modal.plugin", "plugin:acme")
	status := f.modal()
	if status.Plugin == nil || *status.Plugin != "acme" || len(status.Rows) != 2 || status.Rows[0].Name != "수준" || *status.Rows[0].Description != "높을수록 많다" {
		t.Fatalf("status %+v", status)
	}
	keys := status.keys("core.settings-modal.set")
	for _, want := range []string{"acme.level", "acme.mode", "link:window-left:acme", "link:window-right:acme", "link:card-left:acme", "link:card-bottom:acme"} {
		if !slices.Contains(keys, want) {
			t.Fatalf("no control %s in %q", want, keys)
		}
	}
	if !f.tester.HasText("파일, 변경") {
		t.Fatalf("texts %q", f.tester.Texts())
	}
	f.click("core.settings-modal.back", "")
	if f.modal().Plugin != nil {
		t.Fatal("목록 leaves the page")
	}
	_, err := f.shell.Registry().Run("core.settings-modal.plugin", json.RawMessage(`{"plugin":"gone"}`))
	if err == nil || err.Error() != "unknown plugin gone" {
		t.Fatalf("unknown plugin: %v", err)
	}
}

func TestAPluginWithoutASurfaceHasNoCardChoices(t *testing.T) {
	f := opened(t)
	f.run("core.settings-modal.nav", map[string]any{"section": "plugins"})
	f.click("core.settings-modal.plugin", "plugin:plain")
	keys := f.modal().keys("core.settings-modal.set")
	if slices.ContainsFunc(keys, func(key string) bool { return strings.HasPrefix(key, "link:card-") }) {
		t.Fatalf("keys %q", keys)
	}
}

func TestTheSidebarsSectionCreatesEditsAndDeletesSets(t *testing.T) {
	f := opened(t)
	f.run("core.settings-modal.nav", map[string]any{"section": "sidebars"})
	if got := f.modal().labels("core.settings-modal.set-caption"); !slices.Equal(got, []string{"하나 · 목록 · 파일"}) {
		t.Fatalf("captions %q", got)
	}
	f.click("core.settings-modal.create", "")
	status := f.modal()
	if status.Editing == nil || *status.Editing != "set-2" {
		t.Fatalf("the new set is not edited: %+v", status)
	}
	f.click("core.settings-modal.add", "add:set-2")
	f.click("core.settings-modal.add", "add:set-2")
	status = f.modal()
	if got := status.labels("core.settings-modal.row-act"); !slices.Equal(got, []string{"▼", "−", "▲", "−"}) {
		t.Fatalf("row acts %q", got)
	}
	var groups []string
	for _, control := range status.Controls {
		if control.Name == "core.settings-modal.row" {
			groups = append(groups, control.Groups[0].Label)
			if !slices.Equal(control.Groups[0].Values, []string{"acme.files", "acme.git"}) {
				t.Fatalf("row %+v", control)
			}
		}
	}
	if !slices.Equal(groups, []string{"Acme", "Acme"}) {
		t.Fatalf("groups %q", groups)
	}
	f.click("core.settings-modal.row-act", "remove:set-2:0")
	f.click("core.settings-modal.edit", "edit:")
	if f.modal().Editing != nil {
		t.Fatal("완료 leaves the editor")
	}
	f.click("core.settings-modal.delete", "delete:set-2")
	if got := f.modal().labels("core.settings-modal.set-caption"); len(got) != 1 {
		t.Fatalf("captions %q", got)
	}
}

func TestDraggingTheHeaderMovesTheCardInsideTheWindow(t *testing.T) {
	f := opened(t)
	start := f.modal().Card
	f.run("core.settings-modal.move", map[string]any{"dx": -40.0, "dy": 30.0})
	if card := f.modal().Card; card.X != start.X-40 || card.Y != start.Y+30 {
		t.Fatalf("moved to %+v from %+v", card, start)
	}
	f.run("core.settings-modal.move", map[string]any{"dx": -4000.0, "dy": -4000.0})
	if card := f.modal().Card; card.X != 8 || card.Y != 8 {
		t.Fatalf("moved to %+v", card)
	}
	grip, _ := exposedNode(f.tester.ElementTree(), "core.settings-modal.grip", "")
	x, y := grip.Bounds.X+40, grip.Bounds.Y+10
	f.tester.Press(x, y)
	f.tester.Move(x+50, y+20)
	f.tester.Release(x+50, y+20)
	f.settle()
	if card := f.modal().Card; card.X != 58 || card.Y != 28 {
		t.Fatalf("dragged to %+v", card)
	}
}

func TestTheEnvironmentValueReplacesTheDefaultOfThePlugin(t *testing.T) {
	f := newShell(t, &storedHost{installed: `{"plugins":[{"id":"terminal","package":"terminal","version":"1.0.0","manifest":{"id":"terminal",
		"name":"Terminal","description":"the terminal","settings":{"cursor.shape":{"type":"enum","label":"모양","values":["bar","block"],"default":"bar"}}}}]}`})
	f.click("core.chrome.settings", "")
	if got := f.settingValues()["terminal.cursor.shape"]; got != "block" {
		t.Fatalf("the setting is %v", got)
	}
}

func TestManagingPluginsClosesTheCardAndShowsThePluginPage(t *testing.T) {
	f := opened(t)
	f.run("core.settings-modal.nav", map[string]any{"section": "plugins"})
	f.click("core.settings-modal.manage", "")
	if f.modal().Open {
		t.Fatal("the card stays open")
	}
	if !f.has("core.library.page", "plugins") {
		t.Fatal("no plugin page of the library")
	}
}

func TestThePagesReceiveTheThemeAndTheMenuItsLanguage(t *testing.T) {
	f := opened(t)
	f.run("core.settings.theme", map[string]any{"name": "paper", "mode": "light"})
	var theme struct {
		Scheme string            `json:"scheme"`
		Tokens map[string]string `json:"tokens"`
	}
	if err := json.Unmarshal(f.host.theme, &theme); err != nil {
		t.Fatal(err)
	}
	if theme.Scheme != "light" || theme.Tokens["--bg"] == "" || theme.Tokens["--font"] == "" || !strings.HasSuffix(theme.Tokens["--r"], "px") {
		t.Fatalf("theme %+v", theme)
	}
	f.run("core.settings.change", map[string]any{"key": "language", "value": "ko"})
	if string(f.host.language) != `"ko"` {
		t.Fatalf("language %s", f.host.language)
	}
}

func TestEveryControlOfTheCardHasItsNameAndCommand(t *testing.T) {
	f := opened(t)
	for _, section := range []string{"general", "plugins", "sidebars"} {
		f.run("core.settings-modal.nav", map[string]any{"section": section})
		var inCard []ui.ElementNode
		var walk func(nodes []ui.ElementNode)
		walk = func(nodes []ui.ElementNode) {
			for _, node := range nodes {
				if exposed, ok := node.Key.(workbench.Exposed); ok && exposed.Name == "core.settings-modal.card" {
					inCard = node.Children
				}
				walk(node.Children)
			}
		}
		walk(f.tester.ElementTree())
		if unbound := workbench.Audit(inCard); len(unbound) != 0 {
			t.Fatalf("%s: unbound %+v", section, unbound)
		}
	}
}

func TestOpeningTheCardTwiceKeepsOneCard(t *testing.T) {
	f := opened(t)
	f.run("core.settings.open", map[string]any{})
	if !reflect.DeepEqual(f.modal().keys("core.settings-modal.nav"), []string{"nav:general", "nav:plugins", "nav:sidebars"}) {
		t.Fatalf("nav %q", f.modal().keys("core.settings-modal.nav"))
	}
}
