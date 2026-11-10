package workbench_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"math"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

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
	Scroll  float64  `json:"scroll"`
	Rows    []struct {
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
	{"id":"plain","package":"plain","version":"1.0.0","manifest":{"id":"plain","name":"Plain","description":"nothing","contributes":{}}},
	{"id":"acme","package":"acme","version":"1.0.0","manifest":{"id":"acme","name":"Acme","description":"the files",
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
	for _, want := range []string{"top", "bottom", "link:right:", "link:top:", "link:bottom:"} {
		if !slices.Contains(status.keys("core.settings-modal.set"), want) {
			t.Fatalf("no control %s", want)
		}
	}
	// The order of the window sidebars: one row per side with ▲ (not on the first row) and ▼ (not on the last row), each running
	// core.settings.change with the whole new order (docs/spec/settings.md#controls).
	if got := status.keys("core.settings-modal.order"); !slices.Equal(got, []string{"order:sidebarOrder:0:down", "order:sidebarOrder:1:up",
		"order:sidebarOrder:1:down", "order:sidebarOrder:2:up", "order:sidebarOrder:2:down", "order:sidebarOrder:3:up"}) {
		t.Fatalf("order %q", got)
	}
	for _, control := range status.Controls {
		if control.Name == "core.settings-modal.order" && *control.Key == "order:sidebarOrder:0:down" {
			if got, _ := json.Marshal(control.Command); string(got) != `{"name":"core.settings.change","params":{"key":"sidebarOrder","scope":"common","value":["right","left","top","bottom"]}}` {
				t.Fatalf("the first ▼ runs %s", got)
			}
		}
	}
	if !f.tester.HasText("한 변에는 고정 사이드바가 하나 있고, 포커스된 플러그인의 창 세트는 같은 자리의 내용을 바꾼다. 순서가 앞선 변의 사이드바가 먼저 공간을 차지한다.") {
		t.Fatalf("the sidebar group does not state one fixed sidebar per side")
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
	// The window is tall enough to show the whole general section, whose sidebar group holds the four sides and their order.
	f.tester.SetSize(1200, 3200)
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
	for _, want := range []string{"acme.level", "acme.mode", "link:window-left:acme", "link:window-right:acme", "link:window-top:acme", "link:window-bottom:acme", "link:card-left:acme", "link:card-bottom:acme"} {
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
	f := newShell(t, &storedHost{installed: `{"plugins":[{"id":"textprobe","package":"textprobe","version":"1.0.0","manifest":{"id":"textprobe",
		"name":"Terminal","description":"the textprobe","contributes":{},"settings":{"cursor.shape":{"type":"enum","label":"모양","values":["bar","block"],"default":"bar"}}}}]}`})
	f.click("core.chrome.settings", "")
	if got := f.settingValues()["textprobe.cursor.shape"]; got != "block" {
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

func TestACommonSettingOutlivesTheOpenOfAProject(t *testing.T) {
	f := newShell(t, acme())
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"memorySaverDelay": 7}, "scope": "common"})
	f.run("core.library.form.open", map[string]string{"mode": "open"})
	f.run("core.library.form.set", map[string]string{"field": "parent", "value": "/work/alpha"})
	f.run("core.library.form.submit", nil)
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

// The first focus of the settings window is its card, so a key closes nothing that the user did not reach.
func TestEnterInAnOpenedSettingsWindowClosesNothing(t *testing.T) {
	f := opened(t)
	f.tester.Key(0, ui.KeyEnter)
	f.settle()
	if !f.modal().Open {
		t.Fatal("Enter closed the settings window")
	}
}

// A dialog draws over a blurred workbench and tells the host, which blurs the documents. A menu has no background.
func TestADialogSetsTheBackgroundOfTheWorkbench(t *testing.T) {
	f := newShell(t, acme())
	background := func() any { return status[map[string]any](t, f, "core.window.workbench")["background"] }
	if background() != false || len(f.host.backgrounds) != 0 {
		t.Fatalf("the background is %v and the host received %v before a dialog", background(), f.host.backgrounds)
	}
	f.click("core.chrome.settings", "")
	if background() != true || !slices.Equal(f.host.backgrounds, []bool{true}) {
		t.Fatalf("the background is %v and the host received %v with the settings open", background(), f.host.backgrounds)
	}
	f.click("core.settings-modal.close", "")
	if background() != false || !slices.Equal(f.host.backgrounds, []bool{true, false}) {
		t.Fatalf("the background is %v and the host received %v after the settings", background(), f.host.backgrounds)
	}
}

// The head and the sections of the settings window are those of the page: the .act of the close button and the left marked .set-nav.
func TestTheHeadAndTheSectionsOfTheSettingsWindowAreThoseOfThePage(t *testing.T) {
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
	f := opened(t)
	f.run("core.settings.theme", map[string]any{"name": "midnight", "mode": "dark"})
	f.settle()
	card, closing := f.box("core.settings-modal.card", ""), f.box("core.settings-modal.close", "close")
	if closing.W != metric("act-w") || closing.H != metric("act-h") {
		t.Fatalf("the close button is %v, the size of an icon switch is %v by %v", closing, metric("act-w"), metric("act-h"))
	}
	if end := card.X + card.W - closing.X - closing.W; end < metric("set-card-head-pad-end") || end > metric("set-card-head-pad-end")+1 {
		t.Fatalf("the close button stands %v from the end of the card", end)
	}
	item := f.box("core.settings-modal.nav", "nav:general")
	if want := metric("set-nav-w") - 2*metric("set-nav-pad-x") - 1; item.W != want {
		t.Fatalf("the section is %v wide, want %v", item.W, want)
	}
	image := f.tester.Image()
	scale := float32(image.Bounds().Dx()) / 1200
	at := func(x, y float32) color.RGBA { return image.RGBAAt(int(x*scale), int(y*scale)) }
	middle := item.Y + item.H/2
	if got, want := at(item.X+metric("set-nav-mark-w")/2, middle), themeToken(t, "midnight", "dark", "rail"); got != want {
		t.Fatalf("the mark of the shown section is %v, want %v", got, want)
	}
	fill := at(item.X+item.W-2, middle)
	first := float32(-1)
	for x := item.X + metric("set-nav-mark-w") + 1; x < item.X+item.W && first < 0; x += 0.5 {
		for y := item.Y + 2; y < item.Y+item.H-2; y += 0.5 {
			if at(x, y) != fill {
				first = x - item.X
				break
			}
		}
	}
	if pad := metric("set-nav-item-pad-x"); first < pad-1 || first > pad+2 {
		t.Fatalf("the name of the section starts %v into it, want %v", first, pad)
	}
}

// The scope tabs and the group names of the settings window are those of the page: an underlined tab marked in the rail color, and a
// group name in that color.
func TestTheScopeTabsAndGroupsOfTheSettingsWindowAreThoseOfThePage(t *testing.T) {
	f := opened(t)
	f.run("core.settings.theme", map[string]any{"name": "midnight", "mode": "dark"})
	f.settle()
	rail, card := themeToken(t, "midnight", "dark", "rail"), themeToken(t, "midnight", "dark", "card")
	tab := f.box("core.settings-modal.scope", "pick:scope:common")
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

// The controls of the settings window are those of the page: the themes stand in a grid of named tiles, a select fills the cell of its
// row, and each line of text takes the line height of the page.
func TestTheControlsOfTheSettingsWindowAreThoseOfThePage(t *testing.T) {
	f := opened(t)
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
	if !f.tester.HasText("midnight") {
		t.Fatalf("no name of a theme in %q", f.tester.Texts())
	}
	first, second := f.box("core.settings-modal.theme", "theme:midnight"), f.box("core.settings-modal.theme", "theme:nord")
	if first.W < metric("theme-swatch-min-w") || second.X-first.X != first.W+metric("theme-grid-gap") {
		t.Fatalf("the tiles are %+v and %+v", first, second)
	}
	card := f.box("core.settings-modal.card", "")
	selector := f.box("core.settings-modal.set", "projectOpening")
	if right := card.X + card.W - 1 - metric("set-pane-pad-x"); selector.X+selector.W < right-1 {
		t.Fatalf("the select ends at %v, want the end of the pane at %v", selector.X+selector.W, right)
	}
	want := metric("field-pad-y")*2 + 2 + metric("text-control-at-base")*metric("line-height")
	if selector.H < want-1 || selector.H > want+1 {
		t.Fatalf("the select is %v high, want %v", selector.H, want)
	}
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
	const caption = "프로젝트를 여는 방식은 모든 프로젝트에 적용됩니다. 이미 열린 창은 유지됩니다."
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

// A focus of a page brings its element into view, as the focus command does with an element past the end of a pane.
func TestTheFocusCommandBringsItsElementIntoThePane(t *testing.T) {
	f := opened(t)
	card := f.palette().Card
	want := color.RGBA{card.R, card.G, card.B, 255}
	beside := func() color.RGBA {
		t.Helper()
		slider, ok := exposedNode(f.tester.ElementTree(), "core.settings-modal.set", "gap")
		if !ok {
			t.Fatal("no slider of the gap")
		}
		return f.pixelOf(slider.Bounds.X-6, slider.Bounds.Y+slider.Bounds.H/2)
	}
	if got := beside(); got == want {
		t.Fatal("the slider already lies inside the pane")
	}
	f.run("core.focus.set", map[string]any{"name": "core.settings-modal.set", "index": sliderIndex(t, f)})
	f.settle()
	if got := beside(); got != want {
		t.Fatalf("beside the focused slider lies %v, not the pane %v", got, want)
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
	f.run("core.focus.set", map[string]any{"name": "core.settings-modal.set", "index": sliderIndex(t, f)})
	f.settle()
	// The focus scrolled the slider into the pane.
	slider, ok := exposedNode(f.tester.ElementTree(), "core.settings-modal.set", "gap")
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
		if node := positional(t, f.tester, "core.settings-modal.set", index); node.Role == ui.RoleSlider && node.Label == "gap" {
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
	node, ok := nodeLabeled(f.tester.ElementTree(), "6px")
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
		f.run("core.focus.set", map[string]any{"name": "core.settings-modal.set", "index": index})
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

// The card of the page draws no outline when it has the focus (.card): its border says which card it is.
func TestAFocusedCardHasNoOutline(t *testing.T) {
	f, _ := surfaceShell(t)
	card := f.tabbedCards()[0]
	node, ok := exposedNode(f.tester.ElementTree(), "core.card", card)
	if !ok {
		t.Fatalf("no card %s", card)
	}
	x, y := node.Bounds.X+1.5, node.Bounds.Y+node.Bounds.H/2
	f.tester.Key(0, ui.KeyTab)
	f.settle()
	before := f.pixelOf(x, y)
	f.run("core.focus.set", map[string]any{"name": "core.card", "index": 0})
	f.settle()
	if !f.tester.Focused(card) {
		t.Fatalf("the keyboard did not reach the card %s", card)
	}
	if got := f.pixelOf(x, y); got != before {
		t.Fatalf("the focused card has %v at its edge, %v before", got, before)
	}
}

// The plugins of the settings window are buttons in the flow of a line (.set-list), one after the other.
func TestThePluginsOfTheSettingsStandOnOneLine(t *testing.T) {
	f := opened(t)
	f.run("core.settings-modal.nav", map[string]string{"section": "plugins"})
	f.settle()
	first, ok := pressLabeled(f.tester.ElementTree(), "Acme")
	second, found := pressLabeled(f.tester.ElementTree(), "Plain")
	if !ok || !found {
		t.Fatalf("the plugins are not listed in %q", f.tester.Texts())
	}
	if first.Bounds.Y != second.Bounds.Y || first.Bounds.X+first.Bounds.W != second.Bounds.X {
		t.Fatalf("the plugins stand at %+v and %+v", first.Bounds, second.Bounds)
	}
}

// The search of the settings window is an input of the page without a look of its own: the control background of its color scheme.
func TestTheSearchOfTheSettingsHasTheBackgroundOfThePage(t *testing.T) {
	f := opened(t)
	f.run("core.settings-modal.nav", map[string]string{"section": "plugins"})
	f.settle()
	node, ok := exposedNode(f.tester.ElementTree(), "core.settings-modal.search", "")
	if !ok {
		t.Fatalf("no search in %q", f.tester.Texts())
	}
	want := controlBackground(t)
	if got := f.pixelOf(node.Bounds.X+node.Bounds.W-6, node.Bounds.Y+node.Bounds.H/2); got != want {
		t.Fatalf("the search has the background %v, not %v", got, want)
	}
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
	f.run("core.settings-modal.nav", map[string]string{"section": "plugins"})
	f.settle()
	node, ok := exposedNode(f.tester.ElementTree(), "core.settings-modal.search", "")
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
	f.run("core.settings-modal.nav", map[string]string{"section": "plugins"})
	f.settle()
	node, ok := exposedNode(f.tester.ElementTree(), "core.settings-modal.search", "")
	if !ok {
		t.Fatalf("no search in %q", f.tester.Texts())
	}
	width, inset := plainLength(t, "ring-w"), plainLength(t, "search-inset")
	// The top edge of the pill, which is straight: the left of a pill is a curve. The pill lies inside the field by the inset.
	x, y := node.Bounds.X+node.Bounds.W/2, node.Bounds.Y+inset
	beside, around := f.pixelOf(x, y-inset/2), f.pixelOf(x, y-inset-width-.5)
	f.tester.Key(0, ui.KeyTab)
	f.settle()
	f.run("core.focus.set", map[string]any{"name": "core.settings-modal.search", "index": 0})
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
	f.run("core.settings-modal.nav", map[string]string{"section": "plugins"})
	f.settle()
	node, ok := exposedNode(f.tester.ElementTree(), "core.settings-modal.search", "")
	if !ok {
		t.Fatalf("no search in %q", f.tester.Texts())
	}
	f.tester.Key(0, ui.KeyTab)
	f.settle()
	f.run("core.focus.set", map[string]any{"name": "core.settings-modal.search", "index": 0})
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
	f.run("core.settings-modal.nav", map[string]string{"section": "plugins"})
	f.settle()
	node, ok := exposedNode(f.tester.ElementTree(), "core.settings-modal.search", "")
	if !ok {
		t.Fatalf("no search in %q", f.tester.Texts())
	}
	box := node.Bounds
	end, size := plainLength(t, "search-cancel-end"), plainLength(t, "search-cancel-size")
	x, y := box.X+box.W-end-size/2, box.Y+box.H/2
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	cancel := ui.Hex(declared.PlainControl("search-cancel"))
	want := color.RGBA{cancel.R, cancel.G, cancel.B, 255}
	// The left of the circle, beside the cross.
	if got := f.pixelOf(x-size/2+1.5, y); got == want {
		t.Fatal("an empty search has a cancel")
	}
	f.run("core.settings-modal.search", map[string]string{"query": "term"})
	f.settle()
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

// The column of a row is the free width of the pane, which the border of a theme narrows. The search, the whole field with its border,
// is that column.
func TestTheSearchOfTheSettingsFillsTheColumnOfItsRow(t *testing.T) {
	f := opened(t)
	f.run("core.settings-modal.nav", map[string]string{"section": "plugins"})
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
		node, ok := exposedNode(f.tester.ElementTree(), "core.settings-modal.search", "")
		if !ok {
			t.Fatalf("no search in %q", f.tester.Texts())
		}
		want := metric("set-card-w") - 2*border - metric("set-nav-w") - 2*metric("set-pane-pad-x") - metric("set-row-name-w") - metric("set-row-gap")
		if got := node.Bounds.W; got != want {
			t.Fatalf("with a border of %v the box of the search is %v wide, not %v", border, got, want)
		}
	}
	check(1)
	f.run("core.settings-modal.nav", map[string]string{"section": "general"})
	f.settle()
	f.click("core.settings-modal.theme", "theme:solar")
	f.run("core.settings-modal.nav", map[string]string{"section": "plugins"})
	f.settle()
	check(2)
}

// The browser empties a search on Escape and keeps it focused, as its input event tells the page. Escape closes no dialog.
func TestEscapeEmptiesTheSearchOfTheSettings(t *testing.T) {
	f := opened(t)
	f.run("core.settings-modal.nav", map[string]string{"section": "plugins"})
	f.run("core.settings-modal.search", map[string]string{"query": "term"})
	f.run("core.focus.set", map[string]any{"name": "core.settings-modal.search", "index": 0})
	f.settle()
	node, ok := exposedNode(f.tester.ElementTree(), "core.settings-modal.search", "")
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
	f.run("core.settings-modal.nav", map[string]string{"section": "plugins"})
	f.run("core.settings-modal.search", map[string]string{"query": "term"})
	f.settle()
	f.run("core.focus.set", map[string]any{"name": "core.settings-modal.search", "index": 0})
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
	f.run("core.settings-modal.nav", map[string]string{"section": "plugins"})
	f.run("core.settings-modal.search", map[string]string{"query": "term"})
	f.settle()
	f.run("core.focus.set", map[string]any{"name": "core.settings-modal.search", "index": 0})
	f.settle()
	f.tester.Key(0, ui.KeyEnd)
	f.settle()
	f.run("core.focus.set", map[string]any{"name": "core.settings-modal.manage", "index": 0})
	f.settle()
	f.run("core.focus.set", map[string]any{"name": "core.settings-modal.search", "index": 0})
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
	f.run("core.settings-modal.nav", map[string]string{"section": "plugins"})
	f.run("core.settings-modal.search", map[string]string{"query": "term"})
	f.settle()
	f.run("core.focus.set", map[string]any{"name": "core.settings-modal.search", "index": 0})
	f.settle()
	f.tester.Key(0, ui.KeyEnd)
	f.settle()
	f.run("core.focus.set", map[string]any{"name": "core.settings-modal.manage", "index": 0})
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
	f.run("core.settings-modal.nav", map[string]string{"section": "plugins"})
	f.run("core.settings-modal.search", map[string]string{"query": "term"})
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
	node, ok := exposedNode(f.tester.ElementTree(), "core.settings-modal.search", "")
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
		if got, want := f.pixelOf(at[0], at[1]), opaque("search-cancel"); got != want {
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
	f.tester.SetSystemSymbols(func(string, float64, float64) (image.Image, bool) { return nil, false })
	defer func() {
		if got := fmt.Sprint(recover()); !strings.Contains(got, "no symbol magnifyingglass") {
			t.Fatalf("a search without its symbol ended with %q", got)
		}
	}()
	f.run("core.settings-modal.nav", map[string]string{"section": "plugins"})
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

// TestScrollingTheSettingsCardRedrawsTheCardAlone checks that the wheel over the open card changes the pixels of the card,
// not those of the blurred workbench below it, which nothing changed.
// The status reports the pane that scrolls: the box under the fixed head of the card and beside its section nav, the only box a
// control of the shown content is reachable in, because the head covers the content that the scroll clips (docs/spec/settings.md).
func TestTheSettingsStatusReportsThePaneOfTheCard(t *testing.T) {
	f := openedShell(t)
	f.click("core.chrome.settings", "")
	status := f.modal()
	card, pane := status.Card, status.Pane
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	headH, ok := declared.Metric("set-card-head-h")
	if !ok {
		t.Fatal("no metric set-card-head-h")
	}
	navW, ok := declared.Metric("set-nav-w")
	if !ok {
		t.Fatal("no metric set-nav-w")
	}
	palette, err := declared.DefaultPalette()
	if err != nil {
		t.Fatal(err)
	}
	border := float64(2 * palette.BorderWidth)
	near := func(have, want float64) bool { return math.Abs(have-want) <= 0.01 }
	for _, check := range []struct {
		name string
		have float64
		want float64
	}{
		{"the pane does not start at the nav", pane.X, card.X + float64(palette.BorderWidth) + navW},
		{"the pane does not start under the head", pane.Y, card.Y + float64(palette.BorderWidth) + headH},
		{"the pane is not as wide as the card beside the nav", pane.W, card.W - border - navW},
		{"the pane is not as tall as the card under the head", pane.H, card.H - border - headH},
	} {
		if !near(check.have, check.want) {
			t.Errorf("%s: pane %+v of card %+v is %.2f, want %.2f", check.name, pane, card, check.have, check.want)
		}
	}
	if pane.X < card.X || pane.Y < card.Y || pane.X+pane.W > card.X+card.W || pane.Y+pane.H > card.Y+card.H {
		t.Errorf("the pane %+v does not lie inside the card %+v", pane, card)
	}
}

func TestScrollingTheSettingsCardRedrawsTheCardAlone(t *testing.T) {
	f := openedShell(t)
	f.click("core.chrome.settings", "")
	card := f.modal().Card
	// What the shadow of the card reaches around it.
	const reach = 40
	bound := int((card.W + 2*reach) * (card.H + 2*reach))
	// A frame in memory changing more than half the window draws it whole, so a bound past half tells nothing.
	if bound*2 >= 1200*800 {
		t.Fatalf("the card %+v with its shadow is half the window or more", card)
	}
	var records []ui.FrameRecord
	var clock uint64
	f.tester.RecordFrames(&ui.FrameRecorder{
		Clock: func() uint64 { clock++; return clock },
		Frame: func(r *ui.FrameRecord) { records = append(records, *r) },
	})
	x, y := float32(card.X+card.W*0.7), float32(card.Y+card.H*0.6)
	f.tester.Move(x, y)
	for range 6 {
		f.tester.Wheel(x, y, 0, 48)
		f.tester.Advance(20 * time.Millisecond)
	}
	f.settle()
	if f.modal().Scroll <= 0 {
		t.Fatalf("the wheel did not scroll the card: %+v", f.modal().Card)
	}
	drew := 0
	for i, r := range records {
		if r.Damage == 0 {
			continue
		}
		drew++
		if r.Damage > bound {
			t.Errorf("frame %d of the scroll changed %d pixels, more than the %d of the card %+v", i, r.Damage, bound, card)
		}
	}
	if drew == 0 {
		t.Fatal("the scroll drew no frame")
	}
}

// A select fills the control column of its row whatever its value, as `.select-field select` of the page has the width of its column
// and no minimum: the label of a long choice does not widen it.
func TestASelectWithALongChoiceKeepsTheWidthOfItsColumn(t *testing.T) {
	f := opened(t)
	f.run("core.settings.sets.update", map[string]any{"id": "set-1", "title": strings.Repeat("세트이름", 10)})
	f.run("core.settings.link", map[string]any{"place": "left", "plugin": nil, "set": "set-1", "scope": "common"})
	f.run("core.settings-modal.nav", map[string]string{"section": "general"})
	f.settle()
	long, ok := exposedNode(f.tester.ElementTree(), "core.settings-modal.set", "link:left:")
	short, found := exposedNode(f.tester.ElementTree(), "core.settings-modal.set", "mode")
	if !ok || !found {
		t.Fatalf("the selects are not drawn in %q", f.tester.Texts())
	}
	if long.Bounds.X != short.Bounds.X || long.Bounds.W != short.Bounds.W {
		t.Fatalf("the select of a long choice stands at %+v, the select of a short one at %+v", long.Bounds, short.Bounds)
	}
	// The text field of the long title (.text-field, width:100% and min-width:0) and the select of the layout of the edited set fill
	// the same column.
	f.run("core.settings-modal.nav", map[string]string{"section": "sidebars"})
	f.run("core.settings-modal.edit", map[string]any{"set": "set-1"})
	f.settle()
	title, ok := exposedNode(f.tester.ElementTree(), "core.settings-modal.set", "title:set-1")
	layout, found := exposedNode(f.tester.ElementTree(), "core.settings-modal.set", "layout:set-1")
	if !ok || !found {
		t.Fatalf("the set editor is not drawn in %q", f.tester.Texts())
	}
	if title.Bounds.X != layout.Bounds.X || title.Bounds.W != layout.Bounds.W || layout.Bounds.W != short.Bounds.W {
		t.Fatalf("the title stands at %+v and the layout at %+v, a select of the column at %+v", title.Bounds, layout.Bounds, short.Bounds)
	}
}
