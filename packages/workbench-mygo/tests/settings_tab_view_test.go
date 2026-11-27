package workbench_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// modalStatus is the value of core.settings-tab.
type modalStatus struct {
	Open    bool     `json:"-"`
	Page    string   `json:"page"`
	Scope   string   `json:"scope"`
	Query   string   `json:"query"`
	Listed  []string `json:"listed"`
	Plugin  *string  `json:"plugin"`
	Editing *string  `json:"editing"`
	Scroll  float64  `json:"scroll"`
	Errors  []struct {
		Key  string `json:"key"`
		Text string `json:"text"`
	} `json:"errors"`
	Missing []string `json:"missing"`
	Results *struct {
		Settings []string `json:"settings"`
		Plugins  []string `json:"plugins"`
		Catalog  int      `json:"catalog"`
	} `json:"results"`
	Rows []struct {
		Key         string  `json:"key"`
		Name        string  `json:"name"`
		Description *string `json:"description"`
	} `json:"rows"`
	Card struct {
		X, Y, W, H float64
	} `json:"card"`
	Pane struct {
		X, Y, W, H float64
	} `json:"pane"`
	Controls []struct {
		Name     string   `json:"name"`
		Index    int      `json:"index"`
		Key      *string  `json:"key"`
		Label    string   `json:"label"`
		On       *bool    `json:"on"`
		Value    *string  `json:"value"`
		Options  []string `json:"options"`
		Disabled bool     `json:"disabled"`
		Primary  bool     `json:"primary"`
		Groups   []struct {
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
	value, err := f.shell.Registry().Read("core.settings-tab")
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
	status.Open = value != nil
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

// labelsWithKeyPrefix is the labels of the controls of one name whose keys start with prefix, so the chips of one set are counted
// on their own: a set that is edited draws its chips in its row and in its editor (docs/spec/settings.md#pages).
func (s modalStatus) labelsWithKeyPrefix(name, prefix string) []string {
	var labels []string
	for _, control := range s.Controls {
		if control.Name == name && control.Key != nil && strings.HasPrefix(*control.Key, prefix) {
			labels = append(labels, control.Label)
		}
	}
	return labels
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
	{"id":"plain","package":"plain","version":"1.0.0","folder": "/installed/plugin", "manifest":{"id":"plain","name":"Plain","description":"nothing","contributes":{}}},
	{"id":"acme","package":"acme","version":"1.0.0","folder": "/installed/plugin", "manifest":{"id":"acme","name":"Acme","description":"the files",
		"mark":"Ac","icon":"<path d=\"M1 1h14\"/>","exposes":{"commands":[{"name":"acme.copy","description":"copies","params":{"type":"object","properties":{}},"result":{"type":"null"}}]},
		"surface":{"composition":{"kind":"view","page":"a.html"},"menu":[{"command":"acme.copy","title":"복사"}],
			"params":{"type":"object","properties":{"path":{"type":"string"}}}},
		"sections":[{"id":"acme.files","name":"파일","composition":{"kind":"view","page":"f.html"},"height":"fill"},
			{"id":"acme.git","name":"변경","composition":{"kind":"view","page":"g.html"},"height":120}],
		"settings":{"level":{"type":"integer","label":"수준","description":"높을수록 많다","minimum":1,"maximum":5,"default":2},
			"mode":{"type":"enum","label":"방식","values":["a","b"],"default":"a"}}}}]}`

func acme() *storedHost {
	return &storedHost{
		common:    map[string]any{"sets": []any{map[string]any{"id": "set-1", "title": "하나", "sections": []any{"acme.files"}, "layout": "list"}}, "links": []any{}},
		installed: acmeDocument,
	}
}

func opened(t *testing.T) *shellFixture {
	t.Helper()
	f := newShell(t, acme())
	f.click("core.chrome.settings", "")
	return f
}

// A refused change of the settings is an invalid argument of the command, as the page answers it (docs/spec/settings.md).
func TestARefusedSettingsChangeIsInvalidParams(t *testing.T) {
	f := openedShell(t)
	for name, params := range map[string]map[string]any{
		"core.settings.set":         {"patch": map[string]any{"projectOpening": "tabs"}, "scope": "project"},
		"core.settings.change":      {"key": "unknown", "value": 1, "scope": "common"},
		"core.settings.link":        {"place": "left", "set": "no-such-set"},
		"core.settings.sets.update": {"id": "no-such-set", "title": "x"},
		"core.settings.sets.row":    {"id": "no-such-set", "action": "add"},
	} {
		var refused *workbench.Refusal
		if err := f.finish(name, params); !errors.As(err, &refused) || refused.Code != workbench.InvalidParams {
			t.Errorf("%s answered %#v, want %d", name, err, workbench.InvalidParams)
		}
	}
}

func TestTheSearchOfThePluginsPersistsWhileTheTabIsReopened(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]any{"page": "installed"})
	f.run("core.settings-tab.search", map[string]any{"query": "acm"})
	f.run("core.settings.close", nil)
	f.click("core.chrome.settings", "")
	if status := f.modal(); status.Page != "installed" || status.Query != "acm" || !slices.Equal(status.Listed, []string{"acme"}) {
		t.Fatalf("after opening again %+v", status)
	}
}

func TestTheProjectScopeExistsOnlyWhileAProjectIsSelected(t *testing.T) {
	f := newShell(t, &storedHost{})
	f.click("core.chrome.settings", "")
	if got := f.modal().keys("core.settings-tab.scope"); !slices.Equal(got, []string{"pick:scope:common"}) {
		t.Fatalf("scopes %q", got)
	}
	_, err := f.shell.Registry().Run("core.settings-tab.scope", json.RawMessage(`{"scope":"project"}`))
	if err == nil || err.Error() != "scope project is not available" {
		t.Fatalf("project without a project: %v", err)
	}
}

func TestASwitchAndASwatchRunTheirCommandAndTheChangeIsWritten(t *testing.T) {
	f := opened(t)
	f.click("core.settings-tab.theme", "theme:paper")
	values := f.settingValues()
	if values["theme"] != "paper" {
		t.Fatalf("theme %v", values["theme"])
	}
	f.tester.SetSize(1200, 2400)
	f.settle()
	f.click("core.settings-tab.set", "dim")
	if f.settingValues()["dim"] != true {
		t.Fatalf("dim %v", f.settingValues()["dim"])
	}
	if len(f.host.settings) != 2 || f.host.settings[1]["patch"].(map[string]any)["dim"] != true {
		t.Fatalf("writes %+v", f.host.settings)
	}
}

func TestASelectBoxASliderAndADebugSwitchChangeTheirSettings(t *testing.T) {
	f := opened(t)
	// The window is tall enough to show the whole general section, whose sidebar group holds the four sides and their order.
	f.tester.SetSize(1200, 3200)
	f.settle()
	// A choice of two or three values is a segment, and a choice of more is a select box (docs/spec/settings.md#controls).
	f.click("core.settings-tab.choice", "mode:light")
	f.settle()
	if f.settingValues()["mode"] != "light" {
		t.Fatalf("mode %v", f.settingValues()["mode"])
	}
	f.click("core.settings-tab.choice", "font")
	if err := f.tester.Click("JetBrains Mono"); err != nil {
		t.Fatalf("%v; the texts are %q", err, f.tester.Texts())
	}
	f.settle()
	if f.settingValues()["font"] != "mono-jet" {
		t.Fatalf("font %v", f.settingValues()["font"])
	}
	slider, ok := exposedNode(f.tester.ElementTree(), "core.settings-tab.step", "gap")
	if !ok {
		t.Fatal("no slider of the gap")
	}
	f.tester.ClickAt(slider.Bounds.X+slider.Bounds.W/2, slider.Bounds.Y+slider.Bounds.H/2)
	f.settle()
	if got := f.settingValues()["gap"].(float64); got == 12 || got != float64(int(got)) {
		t.Fatalf("gap %v", got)
	}
	f.run("core.settings-tab.nav", map[string]any{"page": "diag"})
	f.settle()
	f.click("core.settings-tab.debug", "")
	if value := f.settingValues()["diagnostics.performance"]; value != true {
		t.Fatalf("the debug switch %v", value)
	}
}

func TestTheKeysOfAnOpenSelectBoxChooseItsItem(t *testing.T) {
	f := opened(t)
	f.click("core.settings-tab.choice", "font")
	f.tester.Key(0, ui.KeyDown)
	f.tester.Key(0, ui.KeyEnter)
	f.settle()
	if f.settingValues()["font"] != "mono-sf" {
		t.Fatalf("font %v", f.settingValues()["font"])
	}
	if !f.modal().Open {
		t.Fatal("the keys closed the settings tab")
	}
}

func TestATitleIsSavedWhenTheFieldSubmits(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]any{"page": "sets"})
	f.run("core.settings-tab.edit", map[string]any{"set": "set-1"})
	// The saved title is the label of the row control set-title:set-1, which changes only when the field submits.
	savedTitle := func() string {
		for _, control := range f.modal().Controls {
			if control.Name == "core.settings-tab.set-title" && control.Key != nil && *control.Key == "set-title:set-1" {
				return control.Label
			}
		}
		return ""
	}
	f.click("core.settings-tab.set-title", "title:set-1")
	f.tester.Key(ui.Super, ui.KeyA)
	f.tester.Type("둘")
	f.settle()
	if savedTitle() == "둘" {
		t.Fatal("a key saved the title")
	}
	f.tester.Key(0, ui.KeyEnter)
	f.settle()
	if got := savedTitle(); got != "둘" {
		t.Fatalf("the saved title is %q", got)
	}
}

func TestThePositionOfThePaneHoldsUntilAnotherPageShows(t *testing.T) {
	f := opened(t)
	f.tester.SetSize(1200, 360)
	f.settle()
	pane, _ := exposedNode(f.tester.ElementTree(), "core.settings-tab.pane", "")
	// The pointer stays inside the pane, which spans y 84 to 360 of the 360 pt window; a point below the window reaches no element.
	f.tester.Scroll(pane.Bounds.X+300, pane.Bounds.Y+pane.Bounds.H/2, 0, 200)
	f.settle()
	moved := 0.0
	read := func() float64 {
		value, err := f.shell.Registry().Read("core.settings-tab")
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
	f.run("core.settings-tab.nav", map[string]any{"page": "installed"})
	if got := read(); got != 0 {
		t.Fatalf("another section starts at %v", got)
	}
}

func TestTheProjectScopeShowsTheFolderAndResetsAnOverride(t *testing.T) {
	f := openedShell(t)
	f.click("core.chrome.settings", "")
	f.run("core.settings-tab.scope", map[string]any{"scope": "project"})
	f.run("core.settings.change", map[string]any{"key": "gap", "value": 2.0, "scope": "project"})
	status := f.modal()
	if got := status.keys("core.settings-tab.reset"); !slices.Equal(got, []string{"reset:gap"}) {
		t.Fatalf("resets %q", got)
	}
	if slices.Contains(status.keys("core.settings-tab.set"), "projectOpening") {
		t.Fatal("the project scope has a common-only setting")
	}
	last := f.host.settings[len(f.host.settings)-1]
	if last["id"] == "" || last["patch"].(map[string]any)["gap"] != 2.0 {
		t.Fatalf("write %+v", last)
	}
	f.tester.SetSize(1200, 2400)
	f.settle()
	f.click("core.settings-tab.reset", "reset:gap")
	if len(f.modal().keys("core.settings-tab.reset")) != 0 {
		t.Fatal("the reset leaves the override")
	}
}

// The ↑ and ↓ buttons of the sidebar list are titled Up and Down, and the title shows as a tip while the pointer rests on the button
// (docs/spec/settings.md#pages).
func TestTheSidebarOrderButtonsShowTheirTitlesAsTips(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]any{"page": "workspace"})
	f.tester.SetSize(1200, 3200)
	f.settle()
	tipCount := func(text string) int {
		count := 0
		for _, got := range f.tester.Texts() {
			if got == text {
				count++
			}
		}
		return count
	}
	for _, button := range []struct{ key, title string }{{"order:sidebarOrder:1:up", "위로"}, {"order:sidebarOrder:0:down", "아래로"}} {
		node, ok := exposedNode(f.tester.ElementTree(), "core.settings-tab.order", button.key)
		if !ok {
			t.Fatalf("no order button %s", button.key)
		}
		before := tipCount(button.title)
		f.tester.Move(node.Bounds.X+node.Bounds.W/2, node.Bounds.Y+node.Bounds.H/2)
		f.tester.Advance(700 * time.Millisecond)
		if got := tipCount(button.title); got != before+1 {
			t.Errorf("the tip %s of %s does not show: %d, then %d", button.title, button.key, before, got)
		}
	}
}

// The project scope marks for reset each overridden side switch, the side links and sidebarOrder, and a reset removes only its key
// (docs/spec/settings.md#pages).
func TestTheProjectScopeResetsEachOverriddenSideSetting(t *testing.T) {
	f := openedShell(t)
	f.click("core.chrome.settings", "")
	f.run("core.settings-tab.scope", map[string]any{"scope": "project"})
	f.run("core.settings-tab.nav", map[string]any{"page": "workspace"})
	f.run("core.settings.change", map[string]any{"key": "top", "value": false, "scope": "project"})
	f.run("core.settings.change", map[string]any{"key": "sidebarOrder", "value": []string{"top", "left", "right", "bottom"}, "scope": "project"})
	// The project sets and its left link are written together, because a link names a set of the same write.
	sets := []any{map[string]any{"id": "set-p", "title": "프로젝트", "sections": []any{"acme.files"}, "layout": "list"}}
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"sets": sets, "links": []any{map[string]any{"place": "left", "plugin": nil, "set": "set-p"}}}, "scope": "project"})
	f.tester.SetSize(1200, 3200)
	f.settle()
	if got := f.modal().keys("core.settings-tab.reset"); !slices.Equal(got, []string{"reset:top", "reset:links", "reset:sidebarOrder"}) {
		t.Fatalf("the reset marks are %q", got)
	}
	// Every reset mark stands inside the window, which is 1200 pt wide, so each one takes a press.
	for _, key := range []string{"reset:top", "reset:links", "reset:sidebarOrder"} {
		if node, _ := exposedNode(f.tester.ElementTree(), "core.settings-tab.reset", key); node.Bounds.X+node.Bounds.W > 1200 {
			t.Fatalf("the reset mark %s stands at %+v, past the window", key, node.Bounds)
		}
	}
	f.click("core.settings-tab.reset", "reset:sidebarOrder")
	if got := f.modal().keys("core.settings-tab.reset"); !slices.Equal(got, []string{"reset:top", "reset:links"}) {
		t.Fatalf("after the reset of sidebarOrder the marks are %q", got)
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

// A view without a background of its own shows the window through the hole of its element, so the window takes the color of the cards.
func TestTheWindowBehindTheSurfacesTakesTheCardColorOfTheTheme(t *testing.T) {
	f := opened(t)
	if got := f.host.backdrops; len(got) == 0 || got[len(got)-1] != "#191b24" {
		t.Fatalf("the backdrops are %q", got)
	}
	f.run("core.settings.theme", map[string]any{"name": "paper", "mode": "light"})
	f.run("core.settings.close", map[string]any{})
	if got := f.host.backdrops; got[len(got)-1] != "#fbfbfb" {
		t.Fatalf("the backdrops are %q", got)
	}
}

func TestThePluginListFiltersByNameIdAndDescription(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]any{"page": "installed"})
	if status := f.modal(); !slices.Equal(status.Listed, []string{"acme", "plain"}) {
		t.Fatalf("listed %q", status.Listed)
	}
	f.run("core.settings-tab.search", map[string]any{"query": "NOTHING"})
	if status := f.modal(); !slices.Equal(status.Listed, []string{"plain"}) {
		t.Fatalf("listed %q", status.Listed)
	}
	f.run("core.settings-tab.search", map[string]any{"query": "zzz"})
	if !f.tester.HasText("맞는 플러그인이 없다.") {
		t.Fatalf("texts %q", f.tester.Texts())
	}
}

func TestAPluginPageShowsItsSettingsSectionsAndSidebarChoices(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]any{"page": "installed"})
	f.click("core.settings-tab.plugin", "plugin:acme")
	status := f.modal()
	if status.Plugin == nil || *status.Plugin != "acme" || len(status.Rows) != 2 || status.Rows[0].Name != "수준" || *status.Rows[0].Description != "높을수록 많다" {
		t.Fatalf("status %+v", status)
	}
	// A setting control keeps the element name of its form, so the keys are read from every control.
	var keys []string
	for _, control := range status.Controls {
		if control.Key != nil {
			keys = append(keys, *control.Key)
		}
	}
	for _, want := range []string{"acme.level", "acme.mode", "link:window-left:acme", "link:window-right:acme", "link:window-top:acme", "link:window-bottom:acme", "link:card-left:acme", "link:card-bottom:acme"} {
		if !slices.Contains(keys, want) {
			t.Fatalf("no control %s in %q", want, keys)
		}
	}
	if !f.tester.HasText("파일") || !f.tester.HasText("변경") {
		t.Fatalf("texts %q", f.tester.Texts())
	}
	f.click("core.settings-tab.back", "")
	if f.modal().Plugin != nil {
		t.Fatal("목록 leaves the page")
	}
	_, err := f.shell.Registry().Run("core.settings-tab.plugin", json.RawMessage(`{"plugin":"gone"}`))
	if err == nil || err.Error() != "unknown plugin gone" {
		t.Fatalf("unknown plugin: %v", err)
	}
}

func TestAPluginWithoutASurfaceHasNoCardChoices(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]any{"page": "installed"})
	f.click("core.settings-tab.plugin", "plugin:plain")
	keys := f.modal().keys("core.settings-tab.set")
	if slices.ContainsFunc(keys, func(key string) bool { return strings.HasPrefix(key, "link:card-") }) {
		t.Fatalf("keys %q", keys)
	}
}

func TestTheSidebarsSectionCreatesEditsAndDeletesSets(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]any{"page": "sets"})
	if f.tester.HasText("· 쓰는 곳:") {
		t.Fatalf("a set without a link shows the usage line; the texts are %q", f.tester.Texts())
	}
	f.click("core.settings-tab.create", "")
	status := f.modal()
	if status.Editing == nil || *status.Editing != "set-2" {
		t.Fatalf("the new set is not edited: %+v", status)
	}
	// The add action appends the section that the select Add section… names (docs/spec/settings.md#pages).
	// The edited set draws its chips in its row and in its editor, so each count is 2 per chip.
	before := len(status.labelsWithKeyPrefix("core.settings-tab.row-act", "remove:set-2:"))
	f.run("core.settings.sets.row", map[string]any{"id": "set-2", "action": "add", "section": "acme.files"})
	f.run("core.settings.sets.row", map[string]any{"id": "set-2", "action": "add", "section": "acme.git"})
	status = f.modal()
	if got := status.labelsWithKeyPrefix("core.settings-tab.row-act", "remove:set-2:"); len(got) != before+4 {
		t.Fatalf("after two adds the chips of the set show the removal acts %q, before %d", got, before)
	}
	f.run("core.settings.sets.row", map[string]any{"id": "set-2", "action": "remove", "index": 0})
	if got := f.modal().labelsWithKeyPrefix("core.settings-tab.row-act", "remove:set-2:"); len(got) != before+2 {
		t.Fatalf("after a removal the chips of the set show %q, before %d", got, before)
	}
	f.click("core.settings-tab.edit", "done:set-2")
	if f.modal().Editing != nil {
		t.Fatal("완료 leaves the editor")
	}
	f.click("core.settings-tab.delete", "delete:set-2")
	f.run("core.settings-tab.confirm", map[string]any{"kind": "set", "id": "set-2", "answer": "yes"})
	f.settle()
	if got := f.modal().labels("core.settings-tab.set-title"); len(got) != 1 {
		t.Fatalf("the sets after the deletion are %q", got)
	}
}

// The select Add section… adds the section it names, and a section that the set already holds is refused (docs/spec/settings.md#pages).
func TestTheSectionAddAddsTheNamedSectionAndRefusesARepeat(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]any{"page": "sets"})
	f.click("core.settings-tab.create", "")
	f.run("core.settings.sets.row", map[string]any{"id": "set-2", "action": "add", "section": "acme.git"})
	// The chip of the row and the chip of the editor (docs/spec/settings.md#pages).
	if got := f.modal().labelsWithKeyPrefix("core.settings-tab.chip", "chip:set-2:"); !slices.Equal(got, []string{"변경", "변경"}) {
		t.Fatalf("the chips of the set after adding 변경 are %q", got)
	}
	var refused *workbench.Refusal
	if err := f.finish("core.settings.sets.row", map[string]any{"id": "set-2", "action": "add", "section": "acme.git"}); !errors.As(err, &refused) || refused.Code != workbench.InvalidParams {
		t.Fatalf("a repeated section answered %#v, want %d", err, workbench.InvalidParams)
	}
}

func TestTheEnvironmentValueReplacesTheDefaultOfThePlugin(t *testing.T) {
	f := newShell(t, &storedHost{installed: `{"plugins":[{"id":"textprobe","package":"textprobe","version":"1.0.0","folder": "/installed/plugin", "manifest":{"id":"textprobe",
		"name":"Terminal","description":"the textprobe","contributes":{},"settings":{"cursor.shape":{"type":"enum","label":"모양","values":["bar","block"],"default":"bar"}}}}]}`})
	f.click("core.chrome.settings", "")
	if got := f.settingValues()["textprobe.cursor.shape"]; got != "block" {
		t.Fatalf("the setting is %v", got)
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
	for _, section := range []string{"look", "installed", "sets"} {
		f.run("core.settings-tab.nav", map[string]any{"page": section})
		var inCard []ui.ElementNode
		var walk func(nodes []ui.ElementNode)
		walk = func(nodes []ui.ElementNode) {
			for _, node := range nodes {
				if exposed, ok := node.Key.(workbench.Exposed); ok && exposed.Name == "core.settings-tab.pane" {
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

func TestACommonSettingOutlivesTheOpenOfAProject(t *testing.T) {
	f := newShell(t, acme())
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"memorySaverDelay": 7}, "scope": "common"})
	f.run("core.home.form.open", map[string]string{"mode": "open"})
	f.run("core.home.form.set", map[string]string{"field": "parent", "value": "/work/alpha"})
	f.run("core.home.form.submit", nil)
	f.settle()
	value, err := f.shell.Registry().Read("core.settings")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var status struct {
		Values map[string]any `json:"values"`
	}
	if err := json.Unmarshal(encoded, &status); err != nil {
		t.Fatal(err)
	}
	if status.Values["memorySaverDelay"] != float64(7) {
		t.Fatalf("the setting is %v", status.Values["memorySaverDelay"])
	}
}

// The first focus of the settings tab is its card, so a key closes nothing that the user did not reach.
func TestEnterInAnOpenedSettingsTabClosesNothing(t *testing.T) {
	f := opened(t)
	f.tester.Key(0, ui.KeyEnter)
	f.settle()
	if !f.modal().Open {
		t.Fatal("Enter closed the settings tab")
	}
}

// A dialog draws over a blurred workbench and tells the host, which blurs the documents. The debug view is such a dialog; the settings
// tab is a tab of the window and sets no background (docs/spec/settings.md).
func TestTheDebugViewSetsTheBackgroundOfTheWorkbench(t *testing.T) {
	f := newShell(t, acme())
	background := func() any { return status[map[string]any](t, f, "core.window.workbench")["background"] }
	if background() != false || len(f.host.backgrounds) != 0 {
		t.Fatalf("the background is %v and the host received %v before a dialog", background(), f.host.backgrounds)
	}
	f.click("core.chrome.settings", "")
	if background() != false || len(f.host.backgrounds) != 0 {
		t.Fatalf("the background is %v and the host received %v with the settings tab open", background(), f.host.backgrounds)
	}
	f.run("core.debug.open", nil)
	if background() != true || !slices.Equal(f.host.backgrounds, []bool{true}) {
		t.Fatalf("the background is %v and the host received %v with the debug view open", background(), f.host.backgrounds)
	}
	f.run("core.debug.close", nil)
	if background() != false || !slices.Equal(f.host.backgrounds, []bool{true, false}) {
		t.Fatalf("the background is %v and the host received %v after the debug view", background(), f.host.backgrounds)
	}
}

// The scope tabs and the group names of the settings tab are those of the page: an underlined tab marked in the rail color, and a
// group name in that color.
func TestTheScopeTabsAndGroupsOfTheSettingsTabAreThoseOfThePage(t *testing.T) {
	f := opened(t)
	f.run("core.settings.theme", map[string]any{"name": "midnight", "mode": "dark"})
	f.settle()
	rail, card := themeToken(t, "midnight", "dark", "rail"), themeToken(t, "midnight", "dark", "card")
	tab := f.box("core.settings-tab.scope", "pick:scope:common")
	middle := tab.X + tab.W/2
	if got := f.pixelOf(middle, tab.Y+tab.H-1); got != rail {
		t.Fatalf("the mark of the shown scope is %v, want %v", got, rail)
	}
	if got := f.pixelOf(tab.X+2, tab.Y+2); got != card {
		t.Fatalf("the shown scope has the fill %v, want the card %v", got, card)
	}
	near := func(a, b uint8) bool { return int(a)-int(b) < 8 && int(b)-int(a) < 8 }
	for y := tab.Y + tab.H + 2; y < tab.Y+tab.H+40; y++ {
		for x := tab.X; x < tab.X+60; x++ {
			if got := f.pixelOf(x, y); near(got.R, rail.R) && near(got.G, rail.G) && near(got.B, rail.B) {
				return
			}
		}
	}
	t.Fatalf("no group name in the rail color %v below the scopes", rail)
}

// lastLineInk returns the width of the ink on the last line of the element of a text of two lines.
func lastLineInk(f *shellFixture, node ui.ElementNode) float32 {
	f.t.Helper()
	background := f.pixelOf(node.Bounds.X+node.Bounds.W-1, node.Bounds.Y+1)
	right := node.Bounds.X
	for x := node.Bounds.X; x < node.Bounds.X+node.Bounds.W; x++ {
		for y := node.Bounds.Y + node.Bounds.H/2; y < node.Bounds.Y+node.Bounds.H; y++ {
			if f.pixelOf(x, y) != background {
				right = x
			}
		}
	}
	return right - node.Bounds.X
}

// Korean breaks at the spaces, as body of the page does with word-break: keep-all: the sentence does not end in a line of one syllable, in
// the workbench and in what stands over it.
func TestKoreanTextBreaksAtTheSpaces(t *testing.T) {
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	size, _ := declared.Metric("text-small-at-base")
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]any{"page": "workspace"})
	// A narrow window gives the caption a pane that it fills in more than one line.
	f.tester.SetSize(520, 800)
	f.settle()
	const caption = "프로젝트를 여는 방식. 모든 프로젝트에 적용되며, 이미 열린 창은 그대로 둔다."
	node, ok := nodeLabeled(f.tester.ElementTree(), caption)
	if !ok {
		t.Fatalf("no caption in %q", f.tester.Texts())
	}
	if node.Bounds.H < 2*float32(size) {
		t.Fatalf("the caption is one line of %v", node.Bounds.H)
	}
	// The last word is five characters, and a break inside it leaves at most two.
	if ink := lastLineInk(f, node); ink < 3*float32(size) {
		t.Fatalf("the last line of the caption is %v wide: it broke inside a word", ink)
	}
}

// The browser rings a focused slider around its track and its thumb, in the focus color of the system.
func TestAFocusedSliderTakesTheRingOfTheSystem(t *testing.T) {
	f := opened(t)
	ring := ui.Color{R: 200, G: 30, B: 90, A: 255}
	want := color.RGBA{ring.R, ring.G, ring.B, 255}
	f.tester.SetPreferences(ui.Preferences{DarkFocusRing: ring})
	f.tester.Key(0, ui.KeyTab)
	f.settle()
	f.run("core.focus.set", map[string]any{"name": "core.settings-tab.step", "index": sliderIndex(t, f)})
	f.settle()
	// The focus scrolled the slider into the pane.
	slider, ok := exposedNode(f.tester.ElementTree(), "core.settings-tab.step", "gap")
	if !ok {
		t.Fatal("no slider of the gap")
	}
	// The element is the track, and the ring goes around the thumb that stands out of it by reach above and below.
	track, width := slider.Bounds, plainLength(t, "ring-w")
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	thumb, _ := declared.Metric("slide-thumb")
	trackH, _ := declared.Metric("slide-track-h")
	reach := float32(thumb-trackH) / 2
	box := ui.Rect{X: track.X, Y: track.Y - reach, W: track.W, H: track.H + 2*reach}
	x := box.X + box.W/2
	if got := f.pixelOf(x, box.Y-width/2); got != want {
		t.Fatalf("the ring is %v, not %v, around %+v", got, want, box)
	}
	if got := f.pixelOf(box.X-width/2, box.Y+box.H/2); got != want {
		t.Fatalf("the ring beside the track is %v, not %v, around %+v", got, want, box)
	}
	if got := f.pixelOf(x, box.Y-width-.5); got == want {
		t.Fatalf("the ring goes past its width, around %+v", box)
	}
	if got := f.pixelOf(box.X+box.W/4, box.Y+.5); got == want {
		t.Fatalf("the ring goes inside the box %+v", box)
	}
}

// sliderIndex is the position of the slider of the gap among the elements of its name, in the order of the window.
func sliderIndex(t *testing.T, f *shellFixture) int {
	t.Helper()
	for index := 0; ; index++ {
		if node := positional(t, f.tester, "core.settings-tab.step", index); node.Role == ui.RoleSlider && node.Label == "gap" {
			return index
		}
	}
}

// The figures of the value of a slider take six widths of a figure of the font, as 6ch of the page does (--slide-value-w).
func TestTheValueOfASliderIsSixFiguresWide(t *testing.T) {
	f := opened(t)
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	size, _ := declared.Metric("text-small-at-base")
	catalog, err := workbench.ReadSettingsCatalog()
	if err != nil {
		t.Fatal(err)
	}
	stack := catalog.Stack(status[map[string]any](t, f, "core.settings")["values"].(map[string]any)["font"].(string))
	const figures = "000000"
	plain := ui.NewTester(func(c *ui.Context) {
		ui.Row(c).Children(func() { ui.Text(c, figures).FontSize(float32(size)).Font(stack) })
	}, 1000, 100)
	want, ok := nodeLabeled(plain.ElementTree(), figures)
	if !ok {
		t.Fatalf("no plain element of %q", figures)
	}
	node, ok := nodeLabeled(f.tester.ElementTree(), "12px")
	if !ok {
		t.Fatalf("no value of the passage in %q", f.tester.Texts())
	}
	if diff := node.Bounds.W - want.Bounds.W; diff < -.01 || diff > .01 {
		t.Fatalf("the value is %v wide, six figures of its font are %v", node.Bounds.W, want.Bounds.W)
	}
}

// switches lists the elements of the switches of a tree.
func switches(nodes []ui.ElementNode) []ui.ElementNode {
	var found []ui.ElementNode
	for _, node := range nodes {
		if node.Role == ui.RoleSwitch {
			found = append(found, node)
		}
		found = append(found, switches(node.Children)...)
	}
	return found
}

// A switch that the keyboard reached has the outline of the page around it (.set-switch:focus-visible).
func TestAFocusedSwitchHasTheOutlineOfThePage(t *testing.T) {
	f := opened(t)
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	width, _ := declared.Metric("focus-outline")
	offset, _ := declared.Metric("switch-focus-offset")
	f.tester.SetSize(1200, 2400)
	f.settle()
	values := status[map[string]any](t, f, "core.settings")["values"].(map[string]any)
	catalog, err := workbench.ReadSettingsCatalog()
	if err != nil {
		t.Fatal(err)
	}
	theme, err := catalog.Theme(values["theme"].(string))
	if err != nil {
		t.Fatal(err)
	}
	colors := theme.Dark
	if values["mode"] == "light" {
		colors = theme.Light
	}
	want := ui.Hex(colors["focus"])
	focus := color.RGBA{want.R, want.G, want.B, 255}
	reach := float32(offset) + float32(width)/2
	var seen []color.RGBA
	for range 60 {
		f.tester.Key(0, ui.KeyTab)
		f.settle()
		for _, node := range switches(f.tester.ElementTree()) {
			y := node.Bounds.Y + node.Bounds.H/2
			left := f.pixelOf(node.Bounds.X-reach, y)
			if left == focus && f.pixelOf(node.Bounds.X+node.Bounds.W+reach-1, y) == focus {
				return
			}
			seen = append(seen, left)
		}
	}
	t.Fatalf("Tab reached no switch with the outline %v: %v", focus, seen[:min(len(seen), 8)])
}

// A select box that the keyboard reached has the focus color on its border and no outline (.select-field select:focus-visible).
func TestAFocusedSelectBoxHasTheBorderOfThePage(t *testing.T) {
	f := opened(t)
	values := status[map[string]any](t, f, "core.settings")["values"].(map[string]any)
	catalog, err := workbench.ReadSettingsCatalog()
	if err != nil {
		t.Fatal(err)
	}
	theme, err := catalog.Theme(values["theme"].(string))
	if err != nil {
		t.Fatal(err)
	}
	colors := theme.Dark
	if values["mode"] == "light" {
		colors = theme.Light
	}
	want := ui.Hex(colors["focus"])
	focus := color.RGBA{want.R, want.G, want.B, 255}
	surface := ui.Hex(colors["bg"])
	inside := color.RGBA{surface.R, surface.G, surface.B, 255}
	f.tester.Key(0, ui.KeyTab)
	f.settle()
	var seen []string
	for index := range 12 {
		f.run("core.focus.set", map[string]any{"name": "core.settings-tab.choice", "index": index})
		f.settle()
		for _, node := range selectBoxes(f.tester.ElementTree()) {
			y := node.Bounds.Y + node.Bounds.H/2
			edge, within := f.pixelOf(node.Bounds.X+.5, y), f.pixelOf(node.Bounds.X+1.5, y)
			if edge == focus && within == inside {
				return
			}
			seen = append(seen, fmt.Sprint(edge, within))
		}
	}
	t.Fatalf("no select box has the border %v around the field %v: %v", focus, inside, seen[:min(len(seen), 6)])
}

// selectBoxes lists the elements of the select boxes of a tree.
func selectBoxes(nodes []ui.ElementNode) []ui.ElementNode {
	var found []ui.ElementNode
	for _, node := range nodes {
		if node.Role == ui.RolePopUpButton {
			found = append(found, node)
		}
		found = append(found, selectBoxes(node.Children)...)
	}
	return found
}

// The rows of Installed stand one under another, and the info button of each row stands in its row
// (docs/spec/settings.md#plugins).
func TestThePluginRowsStandOneUnderAnother(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	f.settle()
	first := element(t, f.tester, "core.settings-tab.plugin", "plugin:acme")
	second := element(t, f.tester, "core.settings-tab.plugin", "plugin:plain")
	if second.Bounds.Y < first.Bounds.Y+first.Bounds.H {
		t.Fatalf("the rows stand at %+v and %+v", first.Bounds, second.Bounds)
	}
}

// The search of the settings tab is an input of the page without a look of its own: the control background of its color scheme.
func TestTheSearchOfTheSettingsHasTheBackgroundOfThePage(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	f.settle()
	node, ok := exposedNode(f.tester.ElementTree(), "core.settings-tab.search", "")
	if !ok {
		t.Fatalf("no search in %q", f.tester.Texts())
	}
	want := controlBackground(t)
	if got := f.pixelOf(node.Bounds.X+node.Bounds.W-6, node.Bounds.Y+node.Bounds.H/2); got != want {
		t.Fatalf("the search has the background %v, not %v", got, want)
	}
}

// plainColor is the opaque declared color of a control without a look of its own (docs/spec/settings.md#layout-values).
func plainColor(t *testing.T, name string) color.RGBA {
	t.Helper()
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	value := ui.Hex(declared.PlainControl(name))
	return color.RGBA{value.R, value.G, value.B, 255}
}

// plainLength is a declared length of a control without a look of its own.
func plainLength(t *testing.T, name string) float32 {
	t.Helper()
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	value, err := strconv.ParseFloat(strings.TrimSuffix(declared.PlainControl(name), "px"), 32)
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return float32(value)
}

// The search of the settings is the input of type search of the page: a pill with a magnifier in front of the text.
func TestTheSearchOfTheSettingsIsThePillOfThePage(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	f.settle()
	node, ok := exposedNode(f.tester.ElementTree(), "core.settings-tab.search", "")
	if !ok {
		t.Fatalf("no search in %q", f.tester.Texts())
	}
	if want := inputHeight(t); node.Bounds.H != want {
		t.Fatalf("the search is %v high, not %v", node.Bounds.H, want)
	}
	// The pill lies inside the field by the inset.
	inset := plainLength(t, "search-inset")
	box := ui.Rect{X: node.Bounds.X + inset, Y: node.Bounds.Y + inset, W: node.Bounds.W - 2*inset, H: node.Bounds.H - 2*inset}
	fill := controlBackground(t)
	if got := f.pixelOf(box.X+2, box.Y+2); got == fill {
		t.Fatal("the corner of the search is square")
	}
	x, size, text := plainLength(t, "search-icon-x"), plainLength(t, "search-icon-size"), plainLength(t, "search-text-x")
	painted := func(from, to float32) bool {
		for at := box.X + from; at < box.X+to; at += .5 {
			if f.pixelOf(at, box.Y+box.H/2) != fill {
				return true
			}
		}
		return false
	}
	if !painted(x, x+size) {
		t.Fatal("the search has no magnifier")
	}
	if painted(x+size, text) {
		t.Fatal("the text of the search begins before its place")
	}
	if !painted(text, text+size) {
		t.Fatal("the search has no placeholder at its place")
	}
}

// inputHeight is the height of an input of the page: a line of its text inside the padding and the edge of the browser.
func inputHeight(t *testing.T) float32 {
	t.Helper()
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	line, ok := declared.Metric("line-height")
	if !ok {
		t.Fatal("no line height is declared")
	}
	return float32(line)*13 + 2*(plainLength(t, "pad-y")+plainLength(t, "edge-w"))
}

// The browser rings a focused input outside its box, in the focus color of the system, which follows the accent color.
func TestAFocusedSearchTakesTheRingOfTheSystem(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	f.settle()
	node, ok := exposedNode(f.tester.ElementTree(), "core.settings-tab.search", "")
	if !ok {
		t.Fatalf("no search in %q", f.tester.Texts())
	}
	width, inset := plainLength(t, "ring-w"), plainLength(t, "search-inset")
	// The top edge of the pill, which is straight: the left of a pill is a curve. The pill lies inside the field by the inset.
	x, y := node.Bounds.X+node.Bounds.W/2, node.Bounds.Y+inset
	beside, around := f.pixelOf(x, y-inset/2), f.pixelOf(x, y-inset-width-.5)
	f.tester.Key(0, ui.KeyTab)
	f.settle()
	f.run("core.focus.set", map[string]any{"name": "core.settings-tab.search", "index": 0})
	f.settle()
	for _, ring := range []ui.Color{{R: 200, G: 30, B: 90, A: 255}, {R: 40, G: 210, B: 70, A: 255}} {
		f.tester.SetPreferences(ui.Preferences{DarkFocusRing: ring})
		f.settle()
		if got, want := f.pixelOf(x, y-inset-width/2), (color.RGBA{ring.R, ring.G, ring.B, 255}); got != want {
			t.Fatalf("the ring is %v, not %v", got, want)
		}
	}
	if got := f.pixelOf(x, y-inset/2); got != beside {
		t.Fatalf("the gap inside the ring is %v, not %v", got, beside)
	}
	if got := f.pixelOf(x, y-inset-width-.5); got != around {
		t.Fatalf("outside the ring lies %v, not %v", got, around)
	}
}

// A desktop without a ring of its own leaves a focused input the focus color of the theme.
func TestAFocusedSearchWithoutARingOfTheSystemTakesTheFocusColor(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	f.settle()
	node, ok := exposedNode(f.tester.ElementTree(), "core.settings-tab.search", "")
	if !ok {
		t.Fatalf("no search in %q", f.tester.Texts())
	}
	f.tester.Key(0, ui.KeyTab)
	f.settle()
	f.run("core.focus.set", map[string]any{"name": "core.settings-tab.search", "index": 0})
	f.settle()
	focus := f.palette().Focus
	width, inset := plainLength(t, "ring-w"), plainLength(t, "search-inset")
	if got, want := f.pixelOf(node.Bounds.X+node.Bounds.W/2, node.Bounds.Y-inset-width/2), (color.RGBA{focus.R, focus.G, focus.B, 255}); got != want {
		t.Fatalf("the ring is %v, not %v", got, want)
	}
}

// A search with a text has the cancel of the browser, which empties it and leaves it the focus.
func TestTheCancelOfTheSearchEmptiesIt(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	f.settle()
	node, ok := exposedNode(f.tester.ElementTree(), "core.settings-tab.search", "")
	if !ok {
		t.Fatalf("no search in %q", f.tester.Texts())
	}
	box := node.Bounds
	end, size := plainLength(t, "search-cancel-end"), plainLength(t, "search-cancel-size")
	x, y := box.X+box.W-end-size/2, box.Y+box.H/2
	// The cancel is drawn in its own declared color, whatever the color of the text is.
	want := plainColor(t, "search-cancel")
	// The left of the circle, beside the cross.
	if got := f.pixelOf(x-size/2+1.5, y); got == want {
		t.Fatal("an empty search has a cancel")
	}
	f.run("core.settings-tab.search", map[string]string{"query": "term"})
	f.settle()
	// The field moves with the layout of the page, so the cancel is found again after the query.
	node, ok = exposedNode(f.tester.ElementTree(), "core.settings-tab.search", "")
	if !ok {
		t.Fatalf("no search after the query in %q", f.tester.Texts())
	}
	box = node.Bounds
	x, y = box.X+box.W-end-size/2, box.Y+box.H/2
	if got := f.pixelOf(x-size/2+1.5, y); got != want {
		t.Fatalf("the cancel is %v, not %v", got, want)
	}
	f.tester.ClickAt(box.X+box.W/2, y)
	f.settle()
	f.tester.ClickAt(x, y)
	f.settle()
	if got := f.pixelOf(x-size/2+1.5, y); got == want {
		t.Fatal("the cancel stays after its press")
	}
	if !f.tester.Focused(node.Label) {
		t.Fatal("the search lost the focus to its cancel")
	}
}

// The search is a control of its row, so it is as wide as the control area of 260 points, whatever the border of the theme is
// (docs/spec/settings.md#rows).
func TestTheSearchOfTheSettingsIsTheControlAreaOfItsRow(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	f.settle()
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	metric := func(name string) float32 {
		value, _ := declared.Metric(name)
		return float32(value)
	}
	check := func(border float32) {
		t.Helper()
		node, ok := exposedNode(f.tester.ElementTree(), "core.settings-tab.search", "")
		if !ok {
			t.Fatalf("no search in %q", f.tester.Texts())
		}
		want := metric("set-control-w")
		if got := node.Bounds.W; got != want {
			t.Fatalf("with a border of %v the box of the search is %v wide, not %v", border, got, want)
		}
	}
	check(1)
	f.run("core.settings-tab.nav", map[string]string{"page": "look"})
	f.settle()
	f.click("core.settings-tab.theme", "theme:solar")
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	f.settle()
	check(2)
}

// The browser empties a search on Escape and keeps it focused, as its input event tells the page. Escape closes no dialog.
func TestEscapeEmptiesTheSearchOfTheSettings(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	f.run("core.settings-tab.search", map[string]string{"query": "term"})
	f.run("core.focus.set", map[string]any{"name": "core.settings-tab.search", "index": 0})
	f.settle()
	node, ok := exposedNode(f.tester.ElementTree(), "core.settings-tab.search", "")
	if !ok {
		t.Fatalf("no search in %q", f.tester.Texts())
	}
	f.tester.Key(0, ui.KeyEscape)
	f.settle()
	if got := f.modal().Query; got != "" {
		t.Fatalf("after Escape the query is %q", got)
	}
	if !f.tester.Focused(node.Label) {
		t.Fatal("Escape took the focus from the search")
	}
	f.tester.Key(0, ui.KeyEscape)
	f.settle()
	if !f.modal().Open {
		t.Fatal("Escape closed the settings")
	}
}

// The browser selects the text of a field that a script focuses for the first time, so the next key replaces it.
func TestTheFocusCommandSelectsTheTextOfAFieldNotYetFocused(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	f.run("core.settings-tab.search", map[string]string{"query": "term"})
	f.settle()
	f.run("core.focus.set", map[string]any{"name": "core.settings-tab.search", "index": 0})
	f.settle()
	f.tester.Type("x")
	f.settle()
	if got := f.modal().Query; got != "x" {
		t.Fatalf("the key after the focus made the query %q", got)
	}
}

// The browser gives a field that had the focus its own selection back when a script focuses it again.
func TestTheFocusCommandKeepsTheSelectionOfAFieldThatHadTheFocus(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	f.run("core.settings-tab.search", map[string]string{"query": "term"})
	f.settle()
	f.run("core.focus.set", map[string]any{"name": "core.settings-tab.search", "index": 0})
	f.settle()
	f.tester.Key(0, ui.KeyEnd)
	f.settle()
	f.run("core.focus.set", map[string]any{"name": "core.settings-tab.filter", "index": 0})
	f.settle()
	f.run("core.focus.set", map[string]any{"name": "core.settings-tab.search", "index": 0})
	f.settle()
	f.tester.Type("x")
	f.settle()
	if got := f.modal().Query; got != "termx" {
		t.Fatalf("the key after the second focus made the query %q", got)
	}
}

// Tab selects the text of the field it reaches, whatever selection that field had.
func TestTabSelectsTheTextOfTheSearchItReaches(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	f.run("core.settings-tab.search", map[string]string{"query": "term"})
	f.settle()
	f.run("core.focus.set", map[string]any{"name": "core.settings-tab.search", "index": 0})
	f.settle()
	f.tester.Key(0, ui.KeyEnd)
	f.settle()
	f.run("core.focus.set", map[string]any{"name": "core.settings-tab.scope", "index": 0})
	f.settle()
	f.tester.Key(0, ui.KeyTab)
	f.settle()
	f.tester.Type("x")
	f.settle()
	if got := f.modal().Query; got != "x" {
		t.Fatalf("the key after Tab made the query %q", got)
	}
}

// The browser draws the magnifier and the cancel of a search from the symbols of the system, in the sizes of the page and the colors
// that it gives them.
func TestTheSearchDrawsTheSymbolsOfTheSystem(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	f.run("core.settings-tab.search", map[string]string{"query": "term"})
	f.settle()
	asked := map[string]float64{}
	f.tester.SetSystemSymbols(func(name string, pointSize, scale float64) (image.Image, bool) {
		asked[name] = pointSize
		return squareSymbols(name, pointSize, scale)
	})
	f.settle()
	if want := float64(plainLength(t, "search-icon-pt")); asked["magnifyingglass"] != want {
		t.Fatalf("asked for %v, not the magnifier at %v", asked, want)
	}
	if want := float64(plainLength(t, "search-cancel-pt")); asked["xmark.circle.fill"] != want {
		t.Fatalf("asked for %v, not the cancel at %v", asked, want)
	}
	node, ok := exposedNode(f.tester.ElementTree(), "core.settings-tab.search", "")
	if !ok {
		t.Fatalf("no search in %q", f.tester.Texts())
	}
	box := node.Bounds
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	opaque := func(name string) color.RGBA {
		value := ui.Hex(declared.PlainControl(name))
		return color.RGBA{value.R, value.G, value.B, 255}
	}
	size := plainLength(t, "search-icon-size")
	corner := size/2 - 1
	x, y := box.X+plainLength(t, "search-icon-x")+size/2, box.Y+box.H/2
	// The square of the fixture reaches the middle and the corners of the box.
	for _, at := range [][2]float32{{x, y}, {x - corner, y - corner}} {
		if got, want := f.pixelOf(at[0], at[1]), opaque("search-icon"); got != want {
			t.Fatalf("the magnifier at %v is %v, not %v", at, got, want)
		}
	}
	end, cancelSize := plainLength(t, "search-cancel-end"), plainLength(t, "search-cancel-size")
	cx := box.X + box.W - end - cancelSize/2
	for _, at := range [][2]float32{{cx, y}, {cx - corner, y - corner}} {
		// The cancel is drawn in the muted color of the theme.
		if got, want := f.pixelOf(at[0], at[1]), plainColor(t, "search-cancel"); got != want {
			t.Fatalf("the cancel at %v is %v, not %v", at, got, want)
		}
	}
	// The cancel still answers its press.
	f.tester.ClickAt(cx, y)
	f.settle()
	if got := f.modal().Query; got != "" {
		t.Fatalf("after the cancel the query is %q", got)
	}
}

// Every system of the host has the symbols of a search, so one without them is an error and no other drawing stands in.
func TestASearchWithoutItsSymbolsIsAnError(t *testing.T) {
	f := opened(t)
	// The defer is set before the provider is installed: installing it draws the settings menu, whose search field asks for the symbol.
	defer func() {
		if got := fmt.Sprint(recover()); !strings.Contains(got, "no symbol magnifyingglass") {
			t.Fatalf("a search without its symbol ended with %q", got)
		}
	}()
	f.tester.SetSystemSymbols(func(string, float64, float64) (image.Image, bool) { return nil, false })
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	f.settle()
}

// controlBackground is the declared background of a control without a look of its own.
func controlBackground(t *testing.T) color.RGBA {
	t.Helper()
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	value := ui.Hex(declared.PlainControl("bg"))
	return color.RGBA{value.R, value.G, value.B, 255}
}

// The name of a group of settings is a heading of the page, so it is bold.
func TestTheNameOfASettingsGroupIsBold(t *testing.T) {
	f := opened(t)
	f.run("core.settings.theme", map[string]any{"name": "midnight", "mode": "dark"})
	f.settle()
	catalog, err := workbench.ReadSettingsCatalog()
	if err != nil {
		t.Fatal(err)
	}
	stack := catalog.Stack(status[map[string]any](t, f, "core.settings")["values"].(map[string]any)["font"].(string))
	declared, err := workbench.ReadDeclarations()
	if err != nil {
		t.Fatal(err)
	}
	size, _ := declared.Metric("text-caption-at-base")
	tracking, _ := declared.Metric("section-tracking")
	rail, card := themeToken(t, "midnight", "dark", "rail"), themeToken(t, "midnight", "dark", "card")
	ink := func(drawn *image.RGBA) int {
		count := 0
		bounds := drawn.Bounds()
		for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
			for x := bounds.Min.X; x < bounds.Max.X; x++ {
				at := drawn.RGBAAt(x, y)
				if int(at.B)-int(card.B) > int(rail.B-card.B)/2 {
					count++
				}
			}
		}
		return count
	}
	var line ui.Rect
	written := func(bold bool) int {
		tester := ui.NewTester(func(c *ui.Context) {
			ui.Box(c).Fill().Background(ui.Color{R: card.R, G: card.G, B: card.B, A: 255}).Children(func() {
				name := ui.Text(c, "테마").Font(stack).FontSize(float32(size)).LetterSpacing(float32(size * tracking)).
					TextColor(ui.Color{R: rail.R, G: rail.G, B: rail.B, A: 255})
				if bold {
					name.Bold()
				}
			})
		}, 200, 100)
		tester.Frame()
		line, _ = tester.Find("테마")
		return ink(tester.Image())
	}
	regular, bold := written(false), written(true)
	// The group holds the name as its label, so its rect starts with the line of the name.
	box, ok := f.tester.Find("테마")
	if !ok {
		t.Fatalf("the texts are %q", f.tester.Texts())
	}
	whole := f.tester.Image()
	scale := float32(whole.Bounds().Dx()) / 1200
	drawn := whole.SubImage(image.Rect(int(box.X*scale), int(box.Y*scale), int((box.X+line.W)*scale)+1, int((box.Y+line.H)*scale)+1)).(*image.RGBA)
	if regular >= bold {
		t.Fatalf("the reference has %d points of a regular name and %d of a bold one", regular, bold)
	}
	if got := ink(drawn); got < (regular+bold)/2 {
		t.Fatalf("the name has %d points of ink, a regular name %d and a bold one %d", got, regular, bold)
	}
}

// A select fills the control column of its row whatever its value, as `.select-field select` of the page has the width of its column
// and no minimum: the label of a long choice does not widen it.
func TestASelectWithALongChoiceKeepsTheWidthOfItsColumn(t *testing.T) {
	f := opened(t)
	f.run("core.settings.sets.update", map[string]any{"id": "set-1", "title": strings.Repeat("세트이름", 10)})
	f.run("core.settings.link", map[string]any{"place": "left", "plugin": nil, "set": "set-1", "scope": "common"})
	f.run("core.settings-tab.nav", map[string]string{"page": "workspace"})
	f.settle()
	long, ok := exposedNode(f.tester.ElementTree(), "core.settings-tab.link", "link:left:")
	short, found := exposedNode(f.tester.ElementTree(), "core.settings-tab.link", "link:right:")
	if !ok || !found {
		t.Fatalf("the selects are not drawn in %q", f.tester.Texts())
	}
	if long.Bounds.X != short.Bounds.X || long.Bounds.W != short.Bounds.W {
		t.Fatalf("the select of a long choice stands at %+v, the select of a short one at %+v", long.Bounds, short.Bounds)
	}
	// The text field of the long title (.text-field, width:100% and min-width:0) fills the control column. The layout of the edited set is
	// a segment for its two values (docs/spec/settings.md#controls), so it is not measured against the column.
	f.run("core.settings-tab.nav", map[string]string{"page": "sets"})
	f.run("core.settings-tab.edit", map[string]any{"set": "set-1"})
	f.settle()
	title, ok := exposedNode(f.tester.ElementTree(), "core.settings-tab.set-title", "title:set-1")
	_, found = exposedNode(f.tester.ElementTree(), "core.settings-tab.layout", "layout:set-1:list")
	if !ok || !found {
		t.Fatalf("the set editor is not drawn in %q", f.tester.Texts())
	}
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	areaW, _ := declared.Metric("set-control-w")
	// The set title is a setting row, so it stands in the control column of 260 points (docs/spec/settings.md#rows). The select of a
	// side row is sized to its options as the web grid .set-side does, so the control of a standard row on the workspace page is measured.
	f.run("core.settings-tab.nav", map[string]string{"page": "workspace"})
	f.settle()
	choice, found := exposedNode(f.tester.ElementTree(), "core.settings-tab.choice", "projectTabs")
	if !found {
		t.Fatalf("the project tab choice is not drawn in %q", f.tester.Texts())
	}
	if title.Bounds.X != choice.Bounds.X || title.Bounds.W != float32(areaW) || choice.Bounds.W != float32(areaW) {
		t.Fatalf("the title stands at %+v and the choice of a standard row at %+v, the control column of width %v", title.Bounds, choice.Bounds, areaW)
	}
}

// The sidebar list is one group of four rows, one per side in the order of sidebarOrder, each with its number, its name, its set select,
// its switch and its ↑ and ↓ (docs/spec/settings.md#pages). The first row has no enabled ↑ and the last row no enabled ↓, and the
// caption of the shortcuts stands below the list in a fixed order.
func TestTheSidebarListIsOneGroupOfFourRowsInTheOrderOfSidebarOrder(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]any{"page": "workspace"})
	f.tester.SetSize(1200, 3200)
	f.settle()
	shown := f.modal()
	if got := shown.keys("core.settings-tab.side"); !slices.Equal(got, []string{"left", "right", "top", "bottom"}) {
		t.Fatalf("the switches of the sides are %q", got)
	}
	if got := shown.keys("core.settings-tab.link"); !slices.Equal(got, []string{"link:left:", "link:right:", "link:top:", "link:bottom:"}) {
		t.Fatalf("the set selects are %q", got)
	}
	disabled := func(name, key string) bool {
		t.Helper()
		for _, control := range shown.Controls {
			if control.Name == name && control.Key != nil && *control.Key == key {
				return control.Disabled
			}
		}
		t.Fatalf("no control %s %s", name, key)
		return false
	}
	if !disabled("core.settings-tab.order", "order:sidebarOrder:0:up") || disabled("core.settings-tab.order", "order:sidebarOrder:0:down") {
		t.Error("the first row has an enabled ↑ or a disabled ↓")
	}
	if disabled("core.settings-tab.order", "order:sidebarOrder:3:up") || !disabled("core.settings-tab.order", "order:sidebarOrder:3:down") {
		t.Error("the last row has a disabled ↑ or an enabled ↓")
	}
	// The rows of the list show their number and name in turn; the choices Left and Top of the project tab position stand in another group.
	rowsShown := func(want []string) {
		t.Helper()
		texts := f.tester.Texts()
		start := slices.Index(texts, "사이드바")
		end := slices.Index(texts, "사이드바 크기")
		if start < 0 || end < start {
			t.Fatalf("no group 사이드바 before 사이드바 크기 in %q", texts)
		}
		var rows []string
		for _, text := range texts[start:end] {
			if slices.Contains([]string{"1", "2", "3", "4", "왼쪽", "오른쪽", "위", "아래"}, text) {
				rows = append(rows, text)
			}
		}
		if !slices.Equal(rows, want) {
			t.Fatalf("the rows show %q, want %q", rows, want)
		}
		if index := slices.Index(texts, sideShortcutCaption); index < 0 {
			t.Fatalf("the caption of the shortcuts is not drawn in %q", texts)
		}
	}
	rowsShown([]string{"1", "왼쪽", "2", "오른쪽", "3", "위", "4", "아래"})
	// A new sidebarOrder moves the rows, their switches and their order buttons with it.
	f.run("core.settings.change", map[string]any{"key": "sidebarOrder", "value": []string{"top", "left", "bottom", "right"}, "scope": "common"})
	f.tester.SetSize(1200, 3200)
	f.settle()
	rowsShown([]string{"1", "위", "2", "왼쪽", "3", "아래", "4", "오른쪽"})
	if got := f.modal().keys("core.settings-tab.side"); !slices.Equal(got, []string{"top", "left", "bottom", "right"}) {
		t.Fatalf("after the new order the switches of the sides are %q", got)
	}
	if !disabled("core.settings-tab.order", "order:sidebarOrder:0:up") || disabled("core.settings-tab.order", "order:sidebarOrder:0:down") {
		t.Error("after the new order the first row has an enabled ↑ or a disabled ↓")
	}
}

// sideShortcutCaption is the caption of the shortcuts under the sidebar list (docs/spec/settings.md#pages).
const sideShortcutCaption = "⌘B 왼쪽 · ⌥⌘B 오른쪽 · ⇧⌘J 위 · ⌘J 아래"

// Each setting form has exactly one control of the form (docs/spec/settings.md#controls): a switch, a segment for two or three listed
// values, a select for more, a slider for a continuous integer and a stepper for a small one. A segment shows one button per value
// and a stepper the buttons up and down, under the setting key; a switch, a select and a slider show no such buttons.
func TestTheLookAndBehaviorPagesDrawEachFormWithItsOneControl(t *testing.T) {
	f := opened(t)
	pages := []struct {
		page  string
		forms []struct{ key, name, kind string }
	}{
		{"look", []struct{ key, name, kind string }{
			{"mode", "core.settings-tab.choice", "segment"}, {"gap", "core.settings-tab.step", "slider"}, {"radius", "core.settings-tab.step", "slider"},
			{"font", "core.settings-tab.choice", "select"}, {"size", "core.settings-tab.step", "stepper"}, {"textSize", "core.settings-tab.choice", "select"},
			{"focusInd", "core.settings-tab.choice", "segment"}, {"fullRule", "core.settings-tab.choice", "segment"}, {"dim", "core.settings-tab.set", "switch"}}},
		{"behavior", []struct{ key, name, kind string }{
			{"language", "core.settings-tab.choice", "segment"}, {"cardArrange", "core.settings-tab.choice", "segment"},
			{"viewProcess", "core.settings-tab.choice", "segment"}, {"memorySaver", "core.settings-tab.set", "switch"},
			{"memorySaverDelay", "core.settings-tab.step", "slider"}, {"autoDismissProblemToasts", "core.settings-tab.set", "switch"},
			{"problemToastDismissSeconds", "core.settings-tab.step", "stepper"}}},
	}
	// The first value of a segment, which its button names.
	first := map[string]string{"mode": "dark", "focusInd": "border", "fullRule": "under", "language": "auto", "cardArrange": "resize", "viewProcess": "plugin"}
	for _, page := range pages {
		f.run("core.settings-tab.nav", map[string]any{"page": page.page})
		for _, form := range page.forms {
			var found []string
			for _, control := range f.modal().Controls {
				if control.Key != nil && *control.Key == form.key {
					found = append(found, control.Name)
				}
			}
			if len(found) != 1 || found[0] != form.name {
				t.Errorf("%s: %s has the controls %q, want one %s", page.page, form.key, found, form.name)
			}
			switch form.kind {
			case "segment":
				if !f.has(form.name, form.key+":"+first[form.key]) {
					t.Errorf("%s is not drawn as a segment: no button %s:%s", form.key, form.key, first[form.key])
				}
			case "stepper":
				if !f.has(form.name, form.key+":up") || !f.has(form.name, form.key+":down") {
					t.Errorf("%s is not drawn as a stepper: no buttons up and down", form.key)
				}
			case "slider", "switch", "select":
				if f.has(form.name, form.key+":up") || f.has(form.name, form.key+":down") {
					t.Errorf("%s is drawn with stepper buttons, want a %s", form.key, form.kind)
				}
			}
		}
	}
}

// The card arrangement is a segment of two values, and a press on one value runs core.settings.change with that value (docs/spec/settings.md#controls).
func TestCardArrangeIsDrawnAsItsSegment(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]any{"page": "behavior"})
	f.click("core.settings-tab.choice", "cardArrange:even")
	if got := f.settingValues()["cardArrange"]; got != "even" {
		t.Fatalf("the segment changed cardArrange to %v", got)
	}
	for _, control := range f.modal().Controls {
		if control.Key != nil && *control.Key == "cardArrange" && (control.Command == nil || control.Command.Name != "core.settings.change" || control.Command.Params["scope"] != "common") {
			t.Fatalf("the segment of cardArrange runs %+v", control.Command)
		}
	}
}

// Scrolling the tab redraws the tab content and nothing else: every frame of the scroll changes no more pixels than the content area of
// the tab, and the shadow of the card no longer reaches past it (docs/spec/settings.md#rows, docs/spec/settings.md#status).
// The wheel over the content changes only pixels of the tab content. The pixels of each scroll step are compared with the pixels before
// the step. The renderer draws the whole window when the damage of a frame covers half of it or more (internal/raster Renderer.whole),
// so the recorded damage of a scroll step is the whole window, and the pixels outside the content are drawn again with the same values.
func TestScrollingTheSettingsTabRedrawsOnlyTheTabContent(t *testing.T) {
	const width, height = 1200, 500
	f := openedShell(t)
	f.click("core.chrome.settings", "")
	f.run("core.settings-tab.nav", map[string]any{"page": "look"})
	// A short window makes the content of the look page overflow the content area.
	f.tester.SetSize(width, height)
	f.settle()
	pane, ok := exposedNode(f.tester.ElementTree(), "core.settings-tab.pane", "")
	if !ok {
		t.Fatalf("no content pane in %q", f.tester.Texts())
	}
	scale := float32(f.tester.Image().Bounds().Dx()) / width
	inside := func(px, py int) bool {
		x, y := float32(px)/scale, float32(py)/scale
		return x >= pane.Bounds.X && x < pane.Bounds.X+pane.Bounds.W && y >= pane.Bounds.Y && y < pane.Bounds.Y+pane.Bounds.H
	}
	// changed counts the pixels that differ between two images, inside and outside the content area.
	changed := func(before, after *image.RGBA) (int, int) {
		inner, outer := 0, 0
		bounds := after.Bounds()
		for py := bounds.Min.Y; py < bounds.Max.Y; py++ {
			for px := bounds.Min.X; px < bounds.Max.X; px++ {
				if before.RGBAAt(px, py) == after.RGBAAt(px, py) {
					continue
				}
				if inside(px, py) {
					inner++
				} else {
					outer++
				}
			}
		}
		return inner, outer
	}
	x, y := float32(pane.Bounds.X+pane.Bounds.W/2), float32(pane.Bounds.Y+pane.Bounds.H/2)
	f.tester.Move(x, y)
	before := cloneImage(f.tester.Image())
	inner, outer := 0, 0
	for range 6 {
		f.tester.Wheel(x, y, 0, 48)
		f.tester.Advance(20 * time.Millisecond)
		after := cloneImage(f.tester.Image())
		i, o := changed(before, after)
		inner, outer = inner+i, outer+o
		before = after
	}
	f.settle()
	i, o := changed(before, f.tester.Image())
	inner, outer = inner+i, outer+o
	if f.modal().Scroll <= 0 {
		t.Fatalf("the wheel did not scroll the content: %+v", pane.Bounds)
	}
	if inner == 0 {
		t.Fatal("the scroll changed no pixel of the content")
	}
	if outer != 0 {
		t.Errorf("the scroll changed %d pixels outside the content area %+v", outer, pane.Bounds)
	}
}

// cloneImage copies the pixels of an image, so that a later frame does not change the copy.
func cloneImage(src *image.RGBA) *image.RGBA {
	return &image.RGBA{Pix: slices.Clone(src.Pix), Stride: src.Stride, Rect: src.Rect}
}

// Each row has its control area of 260 points at the right of the pane, which starts at the same x in every row: the control of a row
// starts in that area and ends inside it (docs/spec/settings.md#rows).
func TestEveryRowsControlStandsInTheControlArea(t *testing.T) {
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	padX, _ := declared.Metric("set-pane-pad-x")
	areaW, _ := declared.Metric("set-control-w")
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]string{"page": "behavior"})
	f.tester.SetSize(1200, 3200)
	f.settle()
	pane, ok := exposedNode(f.tester.ElementTree(), "core.settings-tab.pane", "")
	if !ok {
		t.Fatalf("no pane in %q", f.tester.Texts())
	}
	// The area is computed from the pane width, so every control of every row starts at the same x.
	start := pane.Bounds.X + pane.Bounds.W - float32(padX) - float32(areaW)
	checked := 0
	for _, probe := range []struct{ name, item string }{
		{"core.settings-tab.set", "autoDismissProblemToasts"},
		{"core.settings-tab.set", "memorySaver"},
		{"core.settings-tab.choice", "language:auto"},
		{"core.settings-tab.choice", "viewProcess:plugin"},
	} {
		node, ok := exposedNode(f.tester.ElementTree(), probe.name, probe.item)
		if !ok {
			t.Fatalf("no control %s %s in %q", probe.name, probe.item, f.tester.Texts())
		}
		checked++
		if node.Bounds.X < start-0.5 || node.Bounds.X+node.Bounds.W > start+float32(areaW)+0.5 {
			t.Errorf("the control %s %s spans %v to %v, outside the control area %v to %v", probe.name, probe.item,
				node.Bounds.X, node.Bounds.X+node.Bounds.W, start, start+float32(areaW))
		}
	}
	if checked == 0 {
		t.Fatal("no control was checked")
	}
}

// A setting that depends on a parent is indented under it, and is disabled while the parent is off: memorySaverDelay depends on
// memorySaver, and problemToastDismissSeconds on autoDismissProblemToasts (docs/spec/settings.md#dependency-and-validation-rules). A
// disabled control takes no press and no step, so its element reports no action.
func TestTheDependentRowsAreIndentedAndDisabledWhileTheirParentIsOff(t *testing.T) {
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	indent, ok := declared.Metric("space-3")
	if !ok {
		t.Fatal("no metric space-3")
	}
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]any{"page": "behavior"})
	f.tester.SetSize(1200, 3200)
	f.settle()
	actions := func(name, item string) ui.Actions {
		t.Helper()
		node, ok := exposedNode(f.tester.ElementTree(), name, item)
		if !ok {
			t.Fatalf("no element %s %s in %q", name, item, f.tester.Texts())
		}
		return node.Actions
	}
	labelX := func(text string) float32 {
		t.Helper()
		rect, ok := f.tester.Find(text)
		if !ok {
			t.Fatalf("no label %s in %q", text, f.tester.Texts())
		}
		return rect.X
	}
	for _, pair := range [][2]string{{"메모리 절약", "숨긴 뒤 내리기까지"}, {"오류·경고 자동 닫힘", "닫힐 때까지"}} {
		if got := labelX(pair[1]) - labelX(pair[0]); got < float32(indent)-0.5 {
			t.Errorf("the row %s is %v points right of its parent %s, not indented by %v", pair[1], got, pair[0], indent)
		}
	}
	// The defaults: memorySaver is on and autoDismissProblemToasts is off.
	if actions("core.settings-tab.step", "memorySaverDelay")&ui.ActionIncrement == 0 {
		t.Error("the delay of the memory saver is disabled while memorySaver is on")
	}
	if actions("core.settings-tab.step", "problemToastDismissSeconds:up")&ui.ActionPress != 0 {
		t.Error("the dismissal stepper takes a press while autoDismissProblemToasts is off")
	}
	f.click("core.settings-tab.set", "memorySaver")
	if actions("core.settings-tab.step", "memorySaverDelay")&(ui.ActionIncrement|ui.ActionDecrement) != 0 {
		t.Error("the delay of the memory saver still takes steps while memorySaver is off")
	}
	if actions("core.settings-tab.set", "memorySaver")&ui.ActionPress == 0 {
		t.Error("the parent switch memorySaver is disabled")
	}
	f.click("core.settings-tab.set", "autoDismissProblemToasts")
	if actions("core.settings-tab.step", "problemToastDismissSeconds:up")&ui.ActionPress == 0 {
		t.Error("the dismissal stepper is disabled while autoDismissProblemToasts is on")
	}
	f.click("core.settings-tab.set", "autoDismissProblemToasts")
	if actions("core.settings-tab.step", "problemToastDismissSeconds:up")&ui.ActionPress != 0 {
		t.Error("the dismissal stepper takes a press after autoDismissProblemToasts is switched off")
	}
}

// The buttons of the sidebar order stand in the control area of 260 points like the controls of every row, which starts at the same x
// in each row of the pane (docs/spec/settings.md#pages and #performance). The value name of a row stands in that area too.
func TestTheSidebarOrderButtonsStandInTheControlArea(t *testing.T) {
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	padX, _ := declared.Metric("set-pane-pad-x")
	areaW, _ := declared.Metric("set-control-w")
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]any{"page": "workspace"})
	f.tester.SetSize(1200, 3200)
	f.settle()
	pane, ok := exposedNode(f.tester.ElementTree(), "core.settings-tab.pane", "")
	if !ok {
		t.Fatalf("no pane in %q", f.tester.Texts())
	}
	start := pane.Bounds.X + pane.Bounds.W - float32(padX) - float32(areaW)
	for _, item := range []string{"order:sidebarOrder:0:down", "order:sidebarOrder:1:up", "order:sidebarOrder:1:down",
		"order:sidebarOrder:2:up", "order:sidebarOrder:2:down", "order:sidebarOrder:3:up"} {
		node := element(t, f.tester, "core.settings-tab.order", item)
		if node.Bounds.X < start-0.5 || node.Bounds.X+node.Bounds.W > start+float32(areaW)+0.5 {
			t.Errorf("the order button %s spans %v to %v, outside the control area %v to %v", item,
				node.Bounds.X, node.Bounds.X+node.Bounds.W, start, start+float32(areaW))
		}
	}
}

// The balance button draws the icon of the arrangement that its command runs: layout-grid for even, columns-3 for resize
// (docs/spec/settings.md#controls).
func TestTheBalanceButtonDrawsTheIconOfItsArrangement(t *testing.T) {
	if got := workbench.BalanceIcon("even"); got != "layout-grid" {
		t.Fatalf("even draws %q", got)
	}
	if got := workbench.BalanceIcon("resize"); got != "columns-3" {
		t.Fatalf("resize draws %q", got)
	}
}

func TestNotificationSettingsEditAndPersistToastDismissal(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]any{"page": "behavior"})
	f.tester.SetSize(1200, 3200)
	f.settle()

	const dismiss, seconds = "autoDismissProblemToasts", "problemToastDismissSeconds"
	if !f.tester.HasText("오류·경고 자동 닫힘") || !f.tester.HasText("닫힐 때까지") || !f.tester.HasText("초") {
		t.Error("the notifications group has no automatic-dismissal label") // The label is the one of docs/spec/notifications.md#settings.
	}
	controls := map[string]string{}
	for _, control := range f.modal().Controls {
		if control.Key == nil || (*control.Key != dismiss && *control.Key != seconds) {
			continue
		}
		if control.Command == nil || control.Command.Name != "core.settings.change" || control.Command.Params["scope"] != "common" {
			t.Errorf("the control %s does not declare a common settings change: %+v", *control.Key, control.Command)
		}
		if *control.Key == dismiss && (control.On == nil || *control.On) {
			t.Errorf("the default switch state is %v", control.On)
		}
		if control.Value != nil {
			controls[*control.Key] = *control.Value
		}
		if control.Name == "core.settings-tab.set" && *control.Key == dismiss && control.On != nil {
			controls[dismiss] = strconv.FormatBool(*control.On)
		}
	}
	if controls[dismiss] != "false" || controls[seconds] != "5" {
		t.Fatalf("the default toast controls are %+v", controls)
	}

	writes := len(f.host.settings)
	// The stepper is disabled while autoDismissProblemToasts is off (docs/spec/settings.md#dependency-and-validation-rules), so the switch
	// turns on first.
	f.click("core.settings-tab.set", dismiss)
	if value := f.settingValues()[dismiss]; value != true {
		t.Fatalf("the enable switch changed its setting to %v", value)
	}
	// The stepper runs core.settings.change with the value one second higher (docs/spec/settings.md#controls).
	f.click("core.settings-tab.step", seconds+":up")
	if value := f.settingValues()[seconds]; value != 6.0 {
		t.Fatalf("the stepper changed its setting to %v", value)
	}
	if patches := f.host.settings[writes:]; len(patches) != 2 ||
		patches[0]["patch"].(map[string]any)[dismiss] != true || patches[1]["patch"].(map[string]any)[seconds] != 6.0 {
		t.Fatalf("the native toast controls wrote %+v", patches)
	}
}

// The settings model is built when an input changes and not per frame: a frame that follows no change builds nothing, and a change
// of the shown page builds the model once for the change (docs/spec/settings.md#performance).
func TestTheSettingsModelIsBuiltOnlyWhenAnInputChanges(t *testing.T) {
	f := newShell(t, acme())
	f.click("core.chrome.settings", "")
	f.settle()
	before := f.shell.SettingsModelBuilds()
	for range 10 {
		f.settle()
	}
	if built := f.shell.SettingsModelBuilds() - before; built != 0 {
		t.Fatalf("ten frames without a change built the settings model %d times", built)
	}
	f.click("core.settings-tab.nav", "nav:behavior")
	f.settle()
	changed := f.shell.SettingsModelBuilds() - before
	if changed != 1 {
		t.Fatalf("a change of the shown page built the settings model %d times, not once", changed)
	}
	for range 10 {
		f.settle()
	}
	if built := f.shell.SettingsModelBuilds() - before - changed; built != 0 {
		t.Fatalf("ten frames after the change built the settings model %d times", built)
	}
}

// A setting change builds the settings model once: the change of the value and the answer of its write are one change for the model.
func TestASettingChangeBuildsTheSettingsModelOnce(t *testing.T) {
	f := newShell(t, acme())
	f.click("core.chrome.settings", "")
	f.settle()
	f.click("core.settings-tab.nav", "nav:behavior")
	f.settle()
	before := f.shell.SettingsModelBuilds()
	f.click("core.settings-tab.set", "memorySaver")
	f.settle()
	if built := f.shell.SettingsModelBuilds() - before; built != 1 {
		t.Fatalf("a setting change built the settings model %d times, not once", built)
	}
	before = f.shell.SettingsModelBuilds()
	for range 10 {
		f.settle()
	}
	if built := f.shell.SettingsModelBuilds() - before; built != 0 {
		t.Fatalf("ten frames after the setting change built the settings model %d times", built)
	}
}

// Frames without a change build nothing on any page, also while an application update is available.
func TestTheIdleSettingsFramesBuildNothingOnEveryPage(t *testing.T) {
	stored := acme()
	stored.appUpdate = map[string]any{"version": "1.0.0", "available": map[string]any{"version": "2.0.0",
		"release": map[string]string{"url": "https://h/o/r/releases/download/v2/x.zip", "sha256": strings.Repeat("0", 64)}}}
	f := newShell(t, stored)
	f.click("core.chrome.settings", "")
	f.settle()
	for _, page := range []string{"look", "workspace", "sets", "behavior", "agents", "diag", "installed", "browse"} {
		f.click("core.settings-tab.nav", "nav:"+page)
		f.settle()
		before := f.shell.SettingsModelBuilds()
		for range 10 {
			f.settle()
		}
		if built := f.shell.SettingsModelBuilds() - before; built != 0 {
			t.Fatalf("page %s: ten frames without a change built the settings model %d times", page, built)
		}
	}
}

// An application update state change builds the settings model once, and the frames after it build nothing.
func TestAnUpdateStateChangeBuildsTheSettingsModelOnce(t *testing.T) {
	f, stored := updateShell(t, "")
	f.click("core.chrome.settings", "")
	f.settle()
	f.click("core.settings-tab.nav", "nav:installed")
	f.settle()
	stored.appUpdate = map[string]any{"version": "1.0.0", "available": map[string]any{"version": "2.0.0",
		"release": map[string]string{"url": appRelease, "sha256": strings.Repeat("0", 64)}}}
	before := f.shell.SettingsModelBuilds()
	answered := false
	f.shell.Registry().RunLater("core.plugins.registry", json.RawMessage(`{"index":"file:///index.json"}`), func(_ any, err error) {
		if err != nil {
			t.Errorf("core.plugins.registry failed: %v", err)
		}
		answered = true
	})
	f.settle()
	if !answered {
		t.Fatal("core.plugins.registry did not answer")
	}
	if built := f.shell.SettingsModelBuilds() - before; built != 1 {
		t.Fatalf("an application update state change built the settings model %d times, not once", built)
	}
	before = f.shell.SettingsModelBuilds()
	for range 10 {
		f.settle()
	}
	if built := f.shell.SettingsModelBuilds() - before; built != 0 {
		t.Fatalf("ten frames after the update state change built the settings model %d times", built)
	}
}

// A setting write that the host refuses builds the settings model twice: once for the changed value, and once for the stored value that
// the refusal restores, because those are the two states that the control shows.
func TestAFailedSettingWriteBuildsTheSettingsModelForTheChangeAndItsRestore(t *testing.T) {
	stored := acme()
	f := newShell(t, stored)
	f.click("core.chrome.settings", "")
	f.settle()
	f.click("core.settings-tab.nav", "nav:behavior")
	f.settle()
	stored.failing = map[string]error{"workspace": errors.New("the configuration directory is read-only")}
	before := f.shell.SettingsModelBuilds()
	f.clickQuiet("core.settings-tab.set", "memorySaver")
	f.pending.drain(f.t)
	f.tester.Frame()
	f.pending.drain(f.t)
	f.tester.Frame()
	if built := f.shell.SettingsModelBuilds() - before; built != 2 {
		t.Fatalf("a failed setting write built the settings model %d times, not twice (the change and its restore)", built)
	}
	before = f.shell.SettingsModelBuilds()
	for range 10 {
		f.tester.Frame()
	}
	if built := f.shell.SettingsModelBuilds() - before; built != 0 {
		t.Fatalf("ten frames after the failed write built the settings model %d times", built)
	}
}

// A setting write that the host refuses restores the stored value in the store and the control, and shows its error once.
func TestAFailedSettingWriteRestoresTheValueAndShowsItsErrorOnce(t *testing.T) {
	stored := acme()
	f := newShell(t, stored)
	f.click("core.chrome.settings", "")
	f.settle()
	f.click("core.settings-tab.nav", "nav:behavior")
	f.settle()
	if value := f.settingValues()["memorySaver"]; value != true {
		t.Fatalf("the stored value is %v before the write, not true", value)
	}
	stored.failing = map[string]error{"workspace": errors.New("the configuration directory is read-only")}
	f.clickQuiet("core.settings-tab.set", "memorySaver")
	f.pending.drain(f.t)
	f.tester.Frame()
	f.pending.drain(f.t)
	f.tester.Frame()
	if value := f.settingValues()["memorySaver"]; value != true {
		t.Fatalf("the control shows %v after the host refused the write, not the stored true", value)
	}
	if shown := f.shownErrors(); len(shown) != 1 || !strings.Contains(shown[0], "the configuration directory is read-only") {
		t.Fatalf("the shell showed %q, not one error with the host text", shown)
	}
}

// The layout segments of a set are the controls core.settings-tab.layout of the set, and each runs core.settings.sets.update
// (docs/spec/settings.md#pages).
func TestTheSetLayoutSegmentsAreNamedLayoutControls(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]any{"page": "sets"})
	f.run("core.settings-tab.edit", map[string]any{"set": "set-1"})
	found := 0
	for _, control := range f.modal().Controls {
		if control.Name == "core.settings-tab.layout" && control.Key != nil && *control.Key == "layout:set-1" {
			found++
			if control.Command == nil || control.Command.Name != "core.settings.sets.update" {
				t.Fatalf("the layout segment runs %+v", control.Command)
			}
		}
	}
	if found != 1 {
		t.Fatalf("found %d layout controls of set-1, want one control with the two segments", found)
	}
}

// A stored first width outside the range from the minimum to the maximum shows its line and the Fit to range button, which runs
// core.settings.change with the width cut to the range (docs/spec/settings.md#pages).
func TestAFirstWidthOutsideTheRangeShowsItsLineAndTheFixButton(t *testing.T) {
	h := acme()
	h.common["sidebarMinWidth"], h.common["sidebarMaxWidth"], h.common["sidebarWidth"] = 300.0, 500.0, 200.0
	f := newShell(t, h)
	f.run("core.settings.open", nil)
	// The line is an error of the tab, so the press and the draw that show it are quiet: the error display records it.
	f.runQuiet("core.settings-tab.nav", map[string]any{"page": "workspace"})
	if !f.has("core.settings-tab.fix", "") || !f.tester.HasText("처음 폭 200pt가 범위 300–500pt 밖이다.") {
		t.Fatalf("the line and the fix button are not drawn: %q", f.tester.Texts())
	}
	f.clickQuiet("core.settings-tab.fix", "")
	values := status[struct {
		Values map[string]any `json:"values"`
	}](t, f, "core.settings")
	if values.Values["sidebarWidth"] != float64(300) {
		t.Fatalf("the fix leaves sidebarWidth at %v, want 300", values.Values["sidebarWidth"])
	}
}
