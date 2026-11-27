package workbench_test

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// categoryPlugin is the manifest of a plugin of the test documents: a plugin with a surface, with the members that the test adds.
func categoryPlugin(id, members string) string {
	return fmt.Sprintf(`{"id":%q,"package":%q,"version":"1.0.0","folder":"/installed/plugin","manifest":{"id":%q,"name":"Name of %s","description":"d",`+
		`"mark":"m","icon":"<path d=\"M1 1h14\"/>","surface":{"composition":{"kind":"view","page":"a.html"}}%s}}`, id, id, id, id, members)
}

// boxSections are the sections of boxprobe that the sets of the test environment name.
var boxSections = func() string {
	var sections []string
	for _, id := range []string{"dom", "history", "network", "tabs"} {
		sections = append(sections, fmt.Sprintf(`{"id":"boxprobe.%s","name":%q,"composition":{"kind":"view","page":"s.html"},"height":"fill"}`, id, id))
	}
	return strings.Join(sections, ",")
}()

// categoryDocument holds the plugins that require a terminal plugin, which no plugin of the document serves, and a plugin without one.
var categoryDocument = `{"plugins":[` +
	categoryPlugin("boxprobe", `,"sections":[`+boxSections+`]`) + `,` +
	categoryPlugin("textprobe", `,"requires":["terminal"]`) + `]}`

// categoryShell starts a window of the plugins whose start records the errors that the test expects: the choice of a plugin setting
// and the requirement of a plugin category. settle would fail the test on a recorded error, so the frames of the start are drawn here.
func categoryShell(t *testing.T, plugins *pluginsHost, installed string) *shellFixture {
	t.Helper()
	plugins.core = "1.0.0"
	return startCategoryShell(t, &storedHost{installed: installed, plugins: plugins})
}

// startCategoryShell is categoryShell for a host with the stored settings that a test sets.
func startCategoryShell(t *testing.T, stored *storedHost) *shellFixture {
	t.Helper()
	f := startedShell(t, stored)
	f.pending.drain(t)
	f.tester.Frame()
	f.pending.drain(t)
	f.tester.Frame()
	noteElementNames(f.tester.ElementTree())
	return f
}

// clickQuiet presses the element as click does, and draws the frames without the check of the recorded errors that settle makes, for
// a press whose errors the test expects.
func (f *shellFixture) clickQuiet(name, item string) {
	f.t.Helper()
	node, ok := exposedNode(f.tester.ElementTree(), name, item)
	if !ok {
		f.t.Fatalf("no element %s %q; the texts are %q", name, item, f.tester.Texts())
	}
	f.tester.ClickAt(node.Bounds.X+node.Bounds.W/2, node.Bounds.Y+node.Bounds.H/2)
	f.pending.drain(f.t)
	f.tester.Frame()
	f.pending.drain(f.t)
	f.tester.Frame()
}

// runQuiet runs a command as run does, without the check of the recorded errors that settle makes.
func (f *shellFixture) runQuiet(name string, params any) error {
	f.t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		f.t.Fatal(err)
	}
	var failure error
	f.shell.Registry().RunLater(name, raw, func(_ any, err error) { failure = err })
	f.pending.drain(f.t)
	f.tester.Frame()
	f.pending.drain(f.t)
	f.tester.Frame()
	return failure
}

// enabledPlugins is the install state of the plugins of a test, each enabled.
func enabledPlugins(ids ...string) *pluginsHost {
	plugins := &pluginsHost{plugins: map[string]map[string]any{}}
	for _, id := range ids {
		plugins.plugins[id] = map[string]any{"version": "1.0.0", "enabled": true, "sidecars": map[string]string{}}
	}
	return plugins
}

// A plugin that requires a category that no loaded plugin serves is not loaded: its tab shows the placeholder with the reason
// requires, the error display names it, and the other plugins start (docs/spec/plugins.md#plugin-categories).
func TestAPluginThatRequiresAMissingCategoryIsNotLoadedAndTheOthersStart(t *testing.T) {
	f := categoryShell(t, enabledPlugins("boxprobe", "textprobe"), categoryDocument)
	f.runQuiet("core.home.form.open", map[string]string{"mode": "open"})
	f.runQuiet("core.home.form.set", map[string]string{"field": "parent", "value": "/work/alpha"})
	if err := f.runQuiet("core.home.form.submit", nil); err != nil {
		t.Fatal(err)
	}
	placeholders := map[string]string{}
	for _, row := range status[[]map[string]any](t, f, "core.surfaces") {
		if reason, ok := row["placeholder"].(string); ok {
			placeholders[row["plugin"].(string)] = reason
		}
	}
	if len(placeholders) != 1 || placeholders["textprobe"] != "requires" {
		t.Fatalf("the placeholder rows are %v, want textprobe with the reason requires", placeholders)
	}
	const text = "plugin textprobe requires a terminal plugin, and no loaded plugin is one"
	found := false
	for _, event := range f.host.written("workbench.record.error") {
		fields, _ := event["fields"].(map[string]any)
		found = found || fields["text"] == text
	}
	if !found {
		t.Fatalf("the error display did not show %q", text)
	}
	if got := f.status("core.plugin-categories"); got != `{"terminal":[]}` {
		t.Fatalf("core.plugin-categories is %s", got)
	}
}

// core.plugin-categories lists each plugin category of core with the loaded and enabled plugins that serve it, in the order of their ids.
func TestThePluginCategoriesStatusListsTheLoadedPluginsOfEachCategory(t *testing.T) {
	document := `{"plugins":[` +
		categoryPlugin("textprobe", `,"requires":["terminal"]`) + `,` +
		categoryPlugin("term-b", `,"categories":["terminal"]`) + `,` +
		categoryPlugin("term-a", `,"categories":["terminal"]`) + `]}`
	f := categoryShell(t, enabledPlugins("textprobe", "term-b", "term-a"), document)
	if got := f.status("core.plugin-categories"); got != `{"terminal":[{"id":"term-a","name":"Name of term-a"},{"id":"term-b","name":"Name of term-b"}]}` {
		t.Fatalf("core.plugin-categories is %s", got)
	}
}

// settingsWithTerminal is the document of a plugin with a setting of the category terminal and two plugins of that category.
var settingsWithTerminal = `{"plugins":[` +
	categoryPlugin("card", `,"settings":{"terminal":{"type":"plugin","category":"terminal","label":"터미널"}}`) + `,` +
	categoryPlugin("term-a", `,"categories":["terminal"]`) + `,` +
	categoryPlugin("term-b", `,"categories":["terminal"]`) + `]}`

// controlOf returns the control of the settings tab that holds the setting key.
func controlOf(f *shellFixture, key string) *categoryControl {
	f.t.Helper()
	for _, control := range f.modal().Controls {
		if (control.Name == "core.settings-tab.set" || control.Name == "core.settings-tab.choice") && control.Key != nil && *control.Key == key {
			return &categoryControl{Options: control.Options, Value: control.Value}
		}
	}
	f.t.Fatalf("no control for %s", key)
	return nil
}

// categoryControl is the part of a control of the settings tab that the category tests read.
type categoryControl struct {
	Options []string
	Value   *string
}

// A setting of a category is a select box of the loaded plugins of the category. With two plugins and no stored value it has no value
// and the error display asks for a choice; a change to a plugin of the category stores it (docs/spec/settings.md#controls).
func TestAPluginSettingChoosesFromThePluginsOfItsCategory(t *testing.T) {
	f := categoryShell(t, enabledPlugins("card", "term-a", "term-b"), settingsWithTerminal)
	f.clickQuiet("core.chrome.settings", "")
	f.runQuiet("core.settings-tab.nav", map[string]any{"page": "installed"})
	f.clickQuiet("core.settings-tab.plugin", "plugin:card")
	control := controlOf(f, "card.terminal")
	if !slices.Equal(control.Options, []string{"term-a", "term-b"}) || control.Value != nil {
		t.Fatalf("the select of card.terminal is %+v", control)
	}
	const choose = "card.terminal: choose a terminal plugin"
	if !f.tester.HasText(choose) {
		t.Fatalf("the error display does not ask for a choice: %q", f.tester.Texts())
	}
	if err := f.runQuiet("core.settings.change", map[string]any{"key": "card.terminal", "value": "term-b", "scope": "common"}); err != nil {
		t.Fatal(err)
	}
	if got := controlOf(f, "card.terminal"); got.Value == nil || *got.Value != "term-b" {
		t.Fatalf("the select of card.terminal after the change is %+v", got)
	}
	if f.tester.HasText(choose) {
		t.Fatal("the error display still asks for a choice after the person chose a plugin")
	}
	err := f.runQuiet("core.settings.change", map[string]any{"key": "card.terminal", "value": "other", "scope": "common"})
	if err == nil || err.Error() != "card.terminal: plugin other is not a terminal plugin" {
		t.Fatalf("a plugin that is not of the category answered %v", err)
	}
	err = f.runQuiet("core.settings.change", map[string]any{"key": "card.terminal", "value": "Term-B", "scope": "common"})
	if err == nil || err.Error() != "Invalid setting card.terminal: plugin value must be a plugin id" {
		t.Fatalf("a value that is not a plugin id answered %v", err)
	}
}

// A plugin category with exactly one loaded plugin gives the setting that plugin when nothing is stored.
func TestAPluginSettingOfTheOnlyPluginOfItsCategoryHasThatPlugin(t *testing.T) {
	document := `{"plugins":[` + categoryPlugin("card", `,"settings":{"terminal":{"type":"plugin","category":"terminal","label":"터미널"}}`) +
		`,` + categoryPlugin("term-a", `,"categories":["terminal"]`) + `]}`
	f := categoryShell(t, enabledPlugins("card", "term-a"), document)
	f.clickQuiet("core.chrome.settings", "")
	f.runQuiet("core.settings-tab.nav", map[string]any{"page": "installed"})
	f.clickQuiet("core.settings-tab.plugin", "plugin:card")
	if got := controlOf(f, "card.terminal"); got.Value == nil || *got.Value != "term-a" {
		t.Fatalf("the select of card.terminal is %+v", got)
	}
	if f.tester.HasText("card.terminal: choose a terminal plugin") {
		t.Fatal("the error display asks for a choice with one plugin of the category")
	}
}

// A stored value of a plugin setting is checked at the start: a plugin that is not of the category is a load error and replaces
// nothing, and a value that is not a plugin id is refused (docs/spec/plugins.md#plugin-categories).
func TestAStoredPluginSettingMustNameALoadedPluginOfItsCategory(t *testing.T) {
	plugins := enabledPlugins("card", "term-a", "term-b")
	plugins.core = "1.0.0"
	f := startCategoryShell(t, &storedHost{installed: settingsWithTerminal, plugins: plugins, common: map[string]any{"card.terminal": "gone"}})
	const text = "card.terminal: plugin gone is not a terminal plugin"
	found := false
	for _, event := range f.host.written("workbench.record.error") {
		fields, _ := event["fields"].(map[string]any)
		found = found || strings.Contains(fmt.Sprint(fields["text"]), text)
	}
	if !found {
		t.Fatalf("the load error %q was not shown; the records are %v", text, f.host.written("workbench.record.error"))
	}
	f.clickQuiet("core.chrome.settings", "")
	f.runQuiet("core.settings-tab.nav", map[string]any{"page": "installed"})
	f.clickQuiet("core.settings-tab.plugin", "plugin:card")
	if got := controlOf(f, "card.terminal"); got.Value != nil && *got.Value == "gone" {
		t.Fatalf("the stored value that names no plugin of the category is shown: %+v", got)
	}
}

// The plugin screen shows an enabled plugin that requires a category which no loaded plugin serves with the state requires, which
// asks for no reload: installing or enabling a plugin of the category and reloading loads it (docs/spec/installation.md#plugin-states).
func TestThePluginScreenShowsAPluginThatRequiresAMissingCategoryAsRequires(t *testing.T) {
	f := categoryShell(t, enabledPlugins("boxprobe", "textprobe"), categoryDocument)
	type screen struct {
		Plugins []struct {
			ID    string `json:"id"`
			State string `json:"state"`
		} `json:"plugins"`
		Reload bool `json:"reload"`
	}
	got := status[screen](t, f, "core.plugins")
	states := map[string]string{}
	for _, row := range got.Plugins {
		states[row.ID] = row.State
	}
	if states["textprobe"] != "requires" || states["boxprobe"] != "loaded" || got.Reload {
		t.Fatalf("the plugin screen states are %v with reload %v", states, got.Reload)
	}
}

// Each description line of a plugin page is the element core.settings-tab.plugins.about (docs/spec/settings.md#plugin-page).
func TestAPluginPageNamesEachDescriptionLine(t *testing.T) {
	f := categoryShell(t, enabledPlugins("card"), settingsWithTerminal)
	f.clickQuiet("core.chrome.settings", "")
	f.runQuiet("core.settings-tab.nav", map[string]any{"page": "installed"})
	f.clickQuiet("core.settings-tab.plugin", "plugin:card")
	var about []string
	var walk func(nodes []ui.ElementNode)
	walk = func(nodes []ui.ElementNode) {
		for _, n := range nodes {
			if e, ok := n.Key.(workbench.Exposed); ok && e.Name == "core.settings-tab.plugins.about" {
				about = append(about, n.Text)
			}
			walk(n.Children)
		}
	}
	walk(f.tester.ElementTree())
	if len(about) == 0 {
		t.Fatal("the plugin page of card names no description line core.settings-tab.plugins.about")
	}
	for _, line := range about {
		if line == "" {
			t.Fatalf("a description line is empty: %q", about)
		}
	}
}
