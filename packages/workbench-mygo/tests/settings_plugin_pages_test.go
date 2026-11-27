package workbench_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// settingsControl is a control of core.settings-tab as the status reports it, with its label and command.
type settingsControl struct {
	Name    string  `json:"name"`
	Key     *string `json:"key"`
	Label   string  `json:"label"`
	Command *struct {
		Name string `json:"name"`
	} `json:"command"`
}

// controlsOf reads the controls of the shown settings tab.
func (f *shellFixture) controlsOf() []settingsControl {
	f.t.Helper()
	value, err := f.shell.Registry().Read("core.settings-tab")
	if err != nil {
		f.t.Fatal(err)
	}
	raw, err := json.Marshal(value)
	if err != nil {
		f.t.Fatal(err)
	}
	var status struct {
		Controls []settingsControl `json:"controls"`
	}
	if err := json.Unmarshal(raw, &status); err != nil {
		f.t.Fatal(err)
	}
	return status.Controls
}

// labelsOf returns the labels of the controls with the element name, in document order.
func labelsOf(controls []settingsControl, name string) []string {
	labels := []string{}
	for _, control := range controls {
		if control.Name == name {
			labels = append(labels, control.Label)
		}
	}
	return labels
}

// installedFixture is a host with two installed plugins: zzz has a newer version in the registry index and aaa has none. The name
// order is the reverse of the order the page shows them in.
func installedFixture(t *testing.T) *shellFixture {
	t.Helper()
	plugins := &pluginsHost{registry: "file:///registry/index.json", index: registryOf(map[string][]string{"zzz": {"1.0.0", "1.2.0"}, "aaa": {"1.0.0"}})}
	plugins.plugins = map[string]map[string]any{
		"zzz": {"version": "1.0.0", "enabled": true, "sidecars": map[string]string{}},
		"aaa": {"version": "1.0.0", "enabled": true, "sidecars": map[string]string{}},
	}
	f := pluginShell(t, plugins, "")
	f.run("core.settings.open", nil)
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	return f
}

// The page Installed lists the installed plugins with a problem first, then the plugins with an update, then the rest, each by name
// (docs/spec/settings.md#plugins). zzz has an update and aaa has none, so zzz comes first although its name is later.
func TestTheInstalledPageListsThePluginsWithUpdatesBeforeTheRest(t *testing.T) {
	f := installedFixture(t)
	if want := []string{"zzz", "aaa"}; !slices.Equal(f.tabStatus().Listed, want) {
		t.Fatalf("the installed page lists %v, want %v", f.tabStatus().Listed, want)
	}
}

// The filter segment of Installed shows the choices with their counts, in the order of the specification
// (docs/spec/settings.md#plugins).
func TestTheInstalledPageShowsTheFilterChipsWithTheirCounts(t *testing.T) {
	f := installedFixture(t)
	want := []string{"전체 2", "사용 중 0", "꺼짐 0", "업데이트 1", "문제 0"}
	if got := labelsOf(f.controlsOf(), "core.settings-tab.filter"); !slices.Equal(got, want) {
		t.Fatalf("the filter chips are %q, want %q", got, want)
	}
}

// A plugin row with an update shows the button Update that runs core.plugins.update for its plugin, and the button core.settings-tab.plugins.update-all (1)
// runs core.plugins.update-all (docs/spec/settings.md#plugins).
func TestAPluginRowWithAnUpdateOffersItsUpdateAndTheUpdateOfAll(t *testing.T) {
	f := installedFixture(t)
	var update, all string
	for _, control := range f.controlsOf() {
		if control.Name == "core.settings-tab.plugins.action" && control.Key != nil && *control.Key == "zzz:update" && control.Command != nil {
			update = control.Command.Name
		}
		if control.Name == "core.settings-tab.plugins.update-all" && control.Command != nil {
			all = control.Command.Name + " " + control.Label
		}
	}
	if update != "core.plugins.update" {
		t.Fatalf("the update button of zzz runs %q", update)
	}
	if all != "core.plugins.update-all 모두 업데이트 (1)" {
		t.Fatalf("the update of all is %q", all)
	}
}

// findControl returns the control with the element name and the key, and whether the page shows it.
func findControl(controls []settingsControl, name, key string) (settingsControl, bool) {
	for _, control := range controls {
		if control.Name == name && control.Key != nil && *control.Key == key {
			return control, true
		}
	}
	return settingsControl{}, false
}

// The search of Installed keeps the rows whose name, id or description match the text (docs/spec/settings.md#plugins).
func TestTheInstalledSearchKeepsTheMatchingRows(t *testing.T) {
	f := installedFixture(t)
	f.run("core.settings-tab.search", map[string]string{"query": "AAA"})
	if want := []string{"aaa"}; !slices.Equal(f.tabStatus().Listed, want) {
		t.Fatalf("the search lists %v, want %v", f.tabStatus().Listed, want)
	}
}

// The filter Update keeps only the rows with an update (docs/spec/settings.md#plugins).
func TestTheUpdatesFilterKeepsOnlyThePluginsWithAnUpdate(t *testing.T) {
	f := installedFixture(t)
	f.run("core.settings-tab.filter", map[string]string{"filter": "updates"})
	if want := []string{"zzz"}; !slices.Equal(f.tabStatus().Listed, want) {
		t.Fatalf("the updates filter lists %v, want %v", f.tabStatus().Listed, want)
	}
}

// A disabled plugin shows the badge Off and its switch core.settings-tab.plugins.switch is off and runs core.plugins.enable (docs/spec/settings.md#plugins).
func TestADisabledPluginShowsItsBadgeAndAnOffSwitchThatEnables(t *testing.T) {
	plugins := &pluginsHost{registry: "file:///registry/index.json", index: registryOf(map[string][]string{"off": {"1.0.0"}})}
	plugins.plugins = map[string]map[string]any{"off": {"version": "1.0.0", "enabled": false, "sidecars": map[string]string{}}}
	f := pluginShell(t, plugins, "")
	f.run("core.settings.open", nil)
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	controls := f.controlsOf()
	if got := labelsOf(controls, "core.settings-tab.badge"); !slices.Contains(got, "꺼짐") {
		t.Fatalf("the badges are %q, want 꺼짐", got)
	}
	var found bool
	for _, control := range controls {
		if control.Name == "core.settings-tab.plugins.switch" && control.Command != nil && control.Command.Name == "core.plugins.enable" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the switch of off does not run core.plugins.enable: %+v", controls)
	}
}

// A held operation shows the action that ends its sessions and runs its command with end true, with the count of its sessions
// (docs/spec/settings.md#plugins, docs/spec/installation.md).
func TestAHeldOperationIsListedAndItsActionRunsItWithEnd(t *testing.T) {
	plugins := &pluginsHost{registry: "file:///registry/index.json", index: registryOf(map[string][]string{"zzz": {"1.0.0", "1.2.0"}})}
	plugins.plugins = map[string]map[string]any{"zzz": {"version": "1.0.0", "enabled": true, "sidecars": map[string]string{}}}
	plugins.held = []any{map[string]any{"plugin": "zzz", "action": "update", "version": "1.2.0", "error": "sessions are open",
		"sidecars": []any{map[string]any{"sidecar": "hello", "planned": "2.0.0", "running": "1.0.0", "sessions": 2}}}}
	f := pluginShell(t, plugins, "")
	f.runExpectingErrors("core.settings.open", nil)
	f.runExpectingErrors("core.settings-tab.nav", map[string]string{"page": "installed"})
	if want := (shownRecord{where: "settings plugin zzz", text: "sessions are open"}); !slices.Contains(f.shownRecords(), want) {
		t.Fatalf("the held error is not displayed through the error display: %+v", f.shownRecords())
	}
	control, ok := findControl(f.controlsOf(), "core.settings-tab.plugins.end", "zzz")
	if !ok {
		t.Fatalf("no action that ends the sessions of zzz: %+v", f.controlsOf())
	}
	if control.Label != "세션 2개를 끝내고 업데이트" || control.Command == nil || control.Command.Name != "core.plugins.update" {
		t.Fatalf("the action is %q running %+v", control.Label, control.Command)
	}
	if _, ok := exposedNode(f.tester.ElementTree(), "core.settings-tab.plugins.end", "zzz"); !ok {
		t.Fatal("the action that ends the sessions of zzz is not in the element tree")
	}
}

// A string setting of a plugin is a text field named core.settings-tab.text, with the key as its item, in the page of the plugin
// (docs/spec/settings.md#controls).
func TestAStringSettingOfAPluginIsATextFieldInItsPage(t *testing.T) {
	document := strings.Replace(acmeDocument, `"settings":{`, `"settings":{"title":{"type":"string","label":"제목","default":"a","maxLength":40},`, 1)
	stored := acme()
	stored.installed = document
	f := startedShell(t, stored)
	f.runQuiet("core.settings.open", nil)
	f.runQuiet("core.settings-tab.plugin", map[string]any{"plugin": "acme"})
	f.settle()
	if _, ok := exposedNode(f.tester.ElementTree(), "core.settings-tab.text", "acme.title"); !ok {
		t.Fatalf("the text field of acme.title is not in the element tree: %q", f.tester.Texts())
	}
}

// An outdated sidecar shows its replacement, which runs core.plugins.replace for the sidecar and counts its sessions
// (docs/spec/settings.md#plugins).
func TestAnOutdatedSidecarOffersItsReplacement(t *testing.T) {
	plugins := &pluginsHost{registry: "file:///registry/index.json", index: registryOf(map[string][]string{})}
	plugins.plugins = map[string]map[string]any{}
	plugins.outdated = []any{map[string]any{"sidecar": "hello", "running": "1.0.0", "installed": "2.0.0", "sessions": 2}}
	f := pluginShell(t, plugins, "")
	f.run("core.settings.open", nil)
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	control, ok := findControl(f.controlsOf(), "core.settings-tab.plugins.replace", "hello")
	if !ok {
		t.Fatalf("no replacement of hello: %+v", f.controlsOf())
	}
	if control.Label != "세션 2개를 끝내고 적용" || control.Command == nil || control.Command.Name != "core.plugins.replace" {
		t.Fatalf("the replacement is %q running %+v", control.Label, control.Command)
	}
}

// The core update row shows the running and the available version, and its button Update runs core.app.update
// (docs/spec/settings.md#plugins, docs/spec/installation.md#application-update).
func TestTheInstalledPageShowsTheCoreUpdateRow(t *testing.T) {
	f, _ := updateShell(t, appRelease)
	f.run("core.settings.open", nil)
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	row, ok := findControl(f.controlsOf(), "core.settings-tab.plugins.app", "core")
	if !ok {
		t.Fatalf("no core update row: %+v", f.controlsOf())
	}
	if row.Label != "core: 1.0.0 → 2.0.0" {
		t.Fatalf("the core row says %q", row.Label)
	}
}

// The core update row holds one notice for each installed plugin that the available release does not fit, in the same row as the
// core row, and draws them all (docs/spec/settings.md#plugins).
func TestTheCoreUpdateRowHoldsAnIncompatibleNoticeForEachPlugin(t *testing.T) {
	f, _ := updateShell(t, appRelease)
	f.run("core.settings.open", nil)
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	var notices []string
	for _, control := range f.controlsOf() {
		if control.Name == "core.settings-tab.plugins.incompatible" {
			notices = append(notices, control.Label)
		}
	}
	want := []string{"alpha 1.0.0 (^1.0.0): 2.0.0에 맞는 최신 버전 1.2.0", "beta 1.0.0 (^1.0.0): 2.0.0에 맞는 버전 없음"}
	if !reflect.DeepEqual(notices, want) {
		t.Fatalf("the notices are %q, want %q", notices, want)
	}
}

// runExpectingErrors runs a command and draws the frames of its result. Unlike run, it accepts the errors that the result displays, which
// the test reads with shownRecords.
func (f *shellFixture) runExpectingErrors(name string, params any) {
	f.t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		f.t.Fatal(err)
	}
	f.shell.Registry().RunLater(name, raw, func(_ any, err error) {
		if err != nil {
			f.t.Fatal(err)
		}
	})
	f.pending.drain(f.t)
	f.tester.Frame()
	f.pending.drain(f.t)
	f.tester.Frame()
}

// browseFixture is a host whose registry lists the catalog ids, and whose installed plugins are the ids of installed.
func browseFixture(t *testing.T, catalog []string, installed ...string) *shellFixture {
	t.Helper()
	versions := map[string][]string{}
	for _, id := range catalog {
		versions[id] = []string{"1.0.0"}
	}
	plugins := &pluginsHost{registry: "file:///registry/index.json", index: registryOf(versions)}
	plugins.plugins = map[string]map[string]any{}
	for _, id := range installed {
		plugins.plugins[id] = map[string]any{"version": "1.0.0", "enabled": true, "sidecars": map[string]string{}}
	}
	f := pluginShell(t, plugins, "")
	f.run("core.settings.open", nil)
	f.run("core.settings-tab.nav", map[string]string{"page": "browse"})
	return f
}

// The page Browse lists every catalog plugin by name (docs/spec/settings.md#plugins).
func TestTheBrowsePageListsTheCatalogByName(t *testing.T) {
	f := browseFixture(t, []string{"zzz", "aaa", "mmm"}, "zzz")
	if want := []string{"aaa", "mmm", "zzz"}; !slices.Equal(f.tabStatus().Listed, want) {
		t.Fatalf("the browse page lists %v, want %v", f.tabStatus().Listed, want)
	}
}

// The switch core.settings-tab.browse-hide leaves out the installed plugins and runs core.settings-tab.browse {hideInstalled} (docs/spec/settings.md#plugins).
func TestTheHideSwitchLeavesOutTheInstalledPlugins(t *testing.T) {
	f := browseFixture(t, []string{"zzz", "aaa", "mmm"}, "zzz")
	f.run("core.settings-tab.browse", map[string]bool{"hideInstalled": true})
	if want := []string{"aaa", "mmm"}; !slices.Equal(f.tabStatus().Listed, want) || !f.tabStatus().Browse.HideInstalled {
		t.Fatalf("the hidden page lists %v with %+v, want %v", f.tabStatus().Listed, f.tabStatus().Browse, want)
	}
}

// The search core.settings-tab.browse-search keeps the catalog plugins whose name, id or description contain the text (docs/spec/settings.md#plugins).
func TestTheBrowseSearchKeepsTheMatchingPlugins(t *testing.T) {
	f := browseFixture(t, []string{"zzz", "aaa", "mmm"}, "zzz")
	f.run("core.settings-tab.browse", map[string]string{"query": "mmm"})
	if want := []string{"mmm"}; !slices.Equal(f.tabStatus().Listed, want) {
		t.Fatalf("the search lists %v, want %v", f.tabStatus().Listed, want)
	}
}

// The page shows 30 rows at once and the button of the next rows adds the rows that are left (docs/spec/settings.md#plugins).
func TestTheBrowsePageShowsThirtyRowsAndMoreOfThem(t *testing.T) {
	var catalog []string
	for i := 0; i < 35; i++ {
		catalog = append(catalog, fmt.Sprintf("p%02d", i))
	}
	f := browseFixture(t, catalog)
	if got := len(f.tabStatus().Listed); got != 30 {
		t.Fatalf("the page shows %d rows, want 30", got)
	}
	control, ok := findControl(f.controlsOf(), "core.settings-tab.browse-more", "browse-more")
	if !ok || control.Label != "5개 더 보기" {
		t.Fatalf("the more button is %+v", control)
	}
	f.run("core.settings-tab.browse", map[string]bool{"more": true})
	if got := len(f.tabStatus().Listed); got != 35 {
		t.Fatalf("after more the page shows %d rows, want 35", got)
	}
}

// An uninstalled catalog plugin offers Install, which runs core.plugins.install for it (docs/spec/settings.md#plugins).
func TestAnUninstalledCatalogPluginOffersItsInstall(t *testing.T) {
	f := browseFixture(t, []string{"aaa"})
	control, ok := findControl(f.controlsOf(), "core.settings-tab.plugins.action", "aaa:install")
	if !ok || control.Label != "설치" || control.Command == nil || control.Command.Name != "core.plugins.install" {
		t.Fatalf("the install action is %+v", control)
	}
}

// alphaPageFixture is a window that loads alpha and has it installed and enabled, with its plugin page in front after a click on Installed.
func alphaPageFixture(t *testing.T) *shellFixture {
	t.Helper()
	plugins := &pluginsHost{registry: "file:///registry/index.json", index: registryOf(map[string][]string{"alpha": {"1.0.0"}})}
	plugins.plugins = map[string]map[string]any{"alpha": {"version": "1.0.0", "enabled": true, "sidecars": map[string]string{}}}
	f := pluginShell(t, plugins, loadedAlpha)
	f.run("core.settings.open", nil)
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	f.run("core.settings-tab.plugin", map[string]string{"plugin": "alpha"})
	return f
}

// The plugin page has the back link, which names the page that opened it, and the back link returns to that page
// (docs/spec/settings.md#plugin-page).
func TestThePluginPageHasABackLinkToTheListThatOpenedIt(t *testing.T) {
	f := alphaPageFixture(t)
	status := f.tabStatus()
	if status.Page != "plugin" || status.Back != "installed" {
		t.Fatalf("the page is %q back to %q", status.Page, status.Back)
	}
	if control, ok := findControl(f.controlsOf(), "core.settings-tab.back", "plugin-back"); !ok || control.Label != "‹ 설치됨" {
		t.Fatalf("the back link is %+v", control)
	}
	f.run("core.settings-tab.back", map[string]any{})
	if f.tabStatus().Page != "installed" {
		t.Fatalf("the back link leaves the page %q", f.tabStatus().Page)
	}
}

// The info card of an installed plugin shows its switch core.settings-tab.plugins.switch and the removal, which asks before it runs (docs/spec/settings.md#plugin-page).
func TestThePluginPageRemovalAsksBeforeItRuns(t *testing.T) {
	f := alphaPageFixture(t)
	if _, ok := findControl(f.controlsOf(), "core.settings-tab.plugins.switch", "plugin:alpha"); !ok {
		t.Fatalf("the info card has no switch 사용: %+v", f.controlsOf())
	}
	f.run("core.settings-tab.confirm", map[string]string{"kind": "plugin", "id": "alpha", "answer": "ask"})
	if confirm := f.tabStatus().Confirm; confirm == nil || confirm.Kind != "plugin" || confirm.ID != "alpha" {
		t.Fatalf("the confirmation is %+v", confirm)
	}
	if _, ok := findControl(f.controlsOf(), "core.settings-tab.confirm-yes", "plugin-yes"); !ok {
		t.Fatalf("the removal has no button 제거 while it is asked")
	}
}

// A plugin without settings shows the line that says it has no settings (docs/spec/settings.md#plugin-page).
func TestAPluginWithoutSettingsSaysSo(t *testing.T) {
	f := alphaPageFixture(t)
	if !f.tester.HasText("이 플러그인에는 설정이 없다.") {
		t.Fatalf("the page shows %q", f.tester.Texts())
	}
}

// The actions of the plugin page follow the state of its plugin: the switch core.settings-tab.plugins.switch runs core.plugins.disable while the plugin is enabled and
// core.plugins.enable after it is disabled, and the update action is shown while the registry lists a newer version of the installed
// plugin (docs/spec/settings.md#plugin-page).
func TestTheActionsOfThePluginPageFollowThePlugin(t *testing.T) {
	plugins := &pluginsHost{registry: "file:///registry/index.json", index: registryOf(map[string][]string{"alpha": {"1.0.0", "1.2.0"}})}
	plugins.plugins = map[string]map[string]any{"alpha": {"version": "1.0.0", "enabled": true, "sidecars": map[string]string{}}}
	f := pluginShell(t, plugins, loadedAlpha)
	f.run("core.settings.open", nil)
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	f.run("core.settings-tab.plugin", map[string]string{"plugin": "alpha"})
	switchCommand := func() string {
		t.Helper()
		control, ok := findControl(f.controlsOf(), "core.settings-tab.plugins.switch", "plugin:alpha")
		if !ok || control.Command == nil {
			t.Fatalf("the info card has no switch 사용: %+v", f.controlsOf())
		}
		return control.Command.Name
	}
	if got := switchCommand(); got != "core.plugins.disable" {
		t.Fatalf("the switch of an enabled plugin runs %s", got)
	}
	if update, ok := findControl(f.controlsOf(), "core.settings-tab.plugins.action", "alpha:update"); !ok || update.Command == nil || update.Command.Name != "core.plugins.update" {
		t.Fatalf("the plugin of an older version has no update action: %+v", f.controlsOf())
	}
	if err := f.finish("core.plugins.update", map[string]string{"plugin": "alpha"}); err != nil {
		t.Fatal(err)
	}
	if _, ok := findControl(f.controlsOf(), "core.settings-tab.plugins.action", "alpha:update"); ok {
		t.Fatal("the update action stays after the plugin reached the latest version")
	}
	if err := f.finish("core.plugins.disable", map[string]string{"plugin": "alpha"}); err != nil {
		t.Fatal(err)
	}
	if got := switchCommand(); got != "core.plugins.enable" {
		t.Fatalf("the switch of a disabled plugin runs %s", got)
	}
}

// The group Window sidebars of a plugin page is the four-row list of the sidebar group without the switch: its order is stored under
// <plugin>.win.order, starts from left, right, top, bottom, and its buttons write the whole order (docs/spec/settings.md#plugin-page).
func TestThePluginWindowSidebarsKeepTheirOwnOrderWithoutSwitches(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]any{"page": "installed"})
	f.click("core.settings-tab.plugin", "plugin:acme")
	status := f.modal()
	down := -1
	orders := 0
	for i := range status.Controls {
		control := &status.Controls[i]
		if control.Key != nil && strings.HasPrefix(*control.Key, "order:acme.win.order:") {
			orders++
		}
		if control.Key != nil && *control.Key == "order:acme.win.order:0:down" {
			down = i
		}
	}
	if orders != 8 {
		t.Fatalf("the window sidebar order has %d buttons, want 8 (four rows, up and down)", orders)
	}
	want := map[string]any{"key": "acme.win.order", "value": []any{"right", "left", "top", "bottom"}, "scope": "common"}
	if down < 0 || status.Controls[down].Disabled || status.Controls[down].Command == nil || !reflect.DeepEqual(status.Controls[down].Command.Params, want) {
		t.Fatalf("the first row's down button is not the order swapped with %v", want)
	}
	f.run("core.settings.change", map[string]any{"key": "acme.win.order", "value": []any{"right", "left", "top", "bottom"}, "scope": "common"})
	if status := f.modal(); len(status.Controls) == 0 {
		t.Fatal("the page drew no control after the order changed")
	}
}

// Versions are compared by their numbers, and a version of another form is refused (docs/spec/installation.md#plugin-state-and-commands).
func TestVersionsCompareByNumber(t *testing.T) {
	for _, test := range []struct {
		a, b string
		want int
	}{{"1.2.0", "1.10.0", -1}, {"2.0.0", "1.9.9", 1}, {"1.0.0", "1.0.0", 0}} {
		if got, err := workbench.CompareVersions(test.a, test.b); err != nil || got != test.want {
			t.Errorf("CompareVersions(%s, %s) = %d, %v, want %d", test.a, test.b, got, err, test.want)
		}
	}
	for _, version := range []string{"1.0", "1.0.0-beta", "01.0.0", "1.0.x"} {
		if _, err := workbench.CompareVersions(version, "1.0.0"); err == nil || err.Error() != "version "+version+" must be x.y.z with numeric parts and no leading zeros" {
			t.Errorf("CompareVersions(%s, 1.0.0) fails with %v", version, err)
		}
	}
}

// The group Sections of a plugin page shows the names of its sections as read-only chips, one chip for each section
// (docs/spec/settings.md#plugin-page).
func TestThePluginPageShowsItsSectionsAsReadOnlyChips(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]any{"page": "installed"})
	f.click("core.settings-tab.plugin", "plugin:acme")
	var labels, keys []string
	for _, control := range f.modal().Controls {
		if control.Name == "core.settings-tab.chip" && control.Key != nil && strings.HasPrefix(*control.Key, "section:") {
			labels = append(labels, control.Label)
			keys = append(keys, *control.Key)
			if control.Command != nil {
				t.Fatalf("the section chip %s runs %+v, want none", *control.Key, control.Command)
			}
		}
	}
	if want := []string{"파일", "변경"}; !reflect.DeepEqual(labels, want) || !reflect.DeepEqual(keys, []string{"section:acme.files", "section:acme.git"}) {
		t.Fatalf("the section chips are %q with keys %q, want %q", labels, keys, want)
	}
}

// The meta line of an installed row starts with the categories of the plugin, then its package or key and its version
// (docs/spec/settings.md#plugins).
func TestTheInstalledRowMetaLineNamesTheCategoryOfThePlugin(t *testing.T) {
	document := strings.Replace(acmeDocument, `"sections":[`, `"categories":["terminal"],"sections":[`, 1)
	stored := acme()
	stored.installed = document
	f := newShell(t, stored)
	f.click("core.chrome.settings", "")
	f.run("core.settings-tab.nav", map[string]any{"page": "installed"})
	if !f.tester.HasText("terminal · acme") {
		t.Fatalf("the meta line of acme is missing, texts %q", f.tester.Texts())
	}
}

// A running operation of a plugin shows its action on the row of the plugin, and the line leaves when the operation ends
// (docs/spec/settings.md#plugins).
func TestARunningOperationShowsItsActionOnThePluginRow(t *testing.T) {
	release := newGate()
	stored := acme()
	stored.extra = map[string]workbench.HostCall{"pluginsRun": func(context.Context, json.RawMessage) (any, error) { release.wait(); return nil, nil }}
	f := newShell(t, stored)
	f.click("core.chrome.settings", "")
	f.run("core.settings-tab.nav", map[string]any{"page": "installed"})
	f.shell.Registry().RunLater("core.plugins.disable", json.RawMessage(`{"plugin":"acme"}`), func(any, error) {})
	f.settle()
	if !f.tester.HasText("acme disable 진행 중") {
		t.Fatalf("the running action is not shown, texts %q", f.tester.Texts())
	}
	release.open()
	f.pending.drain(t)
	f.tester.Frame()
	f.pending.drain(t)
	f.settle()
	if f.tester.HasText("acme disable 진행 중") {
		t.Fatal("the running action is still shown after the operation ended")
	}
}

// A failed operation of a plugin shows its error through the error display under the name plugin <id>, which the record keeps
// (docs/spec/settings.md#plugins).
func TestAFailedOperationOfAPluginIsShownThroughTheErrorDisplay(t *testing.T) {
	stored := acme()
	stored.extra = map[string]workbench.HostCall{"pluginsRun": func(context.Context, json.RawMessage) (any, error) { return nil, errors.New("disable refused") }}
	f := newShell(t, stored)
	f.click("core.chrome.settings", "")
	f.run("core.settings-tab.nav", map[string]any{"page": "installed"})
	var failure error
	f.shell.Registry().RunLater("core.plugins.disable", json.RawMessage(`{"plugin":"acme"}`), func(_ any, err error) { failure = err })
	f.pending.drain(t)
	f.tester.Frame()
	if failure == nil {
		t.Fatal("the host failure does not reach the command")
	}
	if records := f.shownRecords(); !slices.Contains(records, shownRecord{"plugin acme", "disable refused"}) {
		t.Fatalf("the failed operation of acme is shown as %+v", records)
	}
}

// The status errors lists the error lines of the settings tab, here the failed operation of a plugin, as the display shows them.
func TestTheStatusListsTheErrorLinesOfTheSettingsTab(t *testing.T) {
	stored := acme()
	stored.extra = map[string]workbench.HostCall{"pluginsRun": func(context.Context, json.RawMessage) (any, error) { return nil, errors.New("disable refused") }}
	f := newShell(t, stored)
	f.click("core.chrome.settings", "")
	f.run("core.settings-tab.nav", map[string]any{"page": "installed"})
	if status := f.modal(); len(status.Errors) != 0 {
		t.Fatalf("the status lists errors before any: %+v", status.Errors)
	}
	var failure error
	f.shell.Registry().RunLater("core.plugins.disable", json.RawMessage(`{"plugin":"acme"}`), func(_ any, err error) { failure = err })
	f.pending.drain(t)
	f.tester.Frame()
	if failure == nil {
		t.Fatal("the host failure does not reach the command")
	}
	status := f.modal()
	if len(status.Errors) != 1 || status.Errors[0].Key != "plugin acme" || status.Errors[0].Text != "disable refused" {
		t.Fatalf("the status lists %+v, want the failed operation of acme", status.Errors)
	}
	f.shownRecords()
}

// The core update row names its release link core.settings-tab.plugins.app-release and its button core.settings-tab.plugins.app-update
// (docs/spec/settings.md#plugins).
func TestTheCoreUpdateRowNamesItsReleaseLinkAndItsUpdateButton(t *testing.T) {
	f, _ := updateShell(t, appRelease)
	f.run("core.settings.open", nil)
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	release, ok := findControl(f.controlsOf(), "core.settings-tab.plugins.app-release", "core:release")
	if !ok || release.Label != "릴리스 페이지" || release.Command == nil || release.Command.Name != "core.app.release" {
		t.Fatalf("the release link is %+v", release)
	}
	update, ok := findControl(f.controlsOf(), "core.settings-tab.plugins.app-update", "core:update")
	if !ok || update.Label != "업데이트" || update.Command == nil || update.Command.Name != "core.app.update" {
		t.Fatalf("the update button is %+v", update)
	}
}

// A plugin page of a plugin that the window does not load shows no sidebar group, because its sidebar choices come from the loaded
// manifest (docs/spec/settings.md#plugin-page).
func TestAPluginPageOfAPluginThatIsNotLoadedShowsNoSidebarGroup(t *testing.T) {
	stored := acme()
	stored.plugins = &pluginsHost{core: "1.0.0", plugins: map[string]map[string]any{"ghost": {"version": "1.0.0", "enabled": true, "sidecars": map[string]string{}}}}
	f := newShell(t, stored)
	f.click("core.chrome.settings", "")
	f.run("core.settings-tab.nav", map[string]any{"page": "installed"})
	f.click("core.settings-tab.plugin", "plugin:ghost")
	if f.tester.HasText("창 사이드바") || f.tester.HasText("카드 사이드바") {
		t.Fatalf("the page of a plugin that is not loaded shows a sidebar group, texts %q", f.tester.Texts())
	}
}

// The info card of a plugin shows one line for each of its contributions, with the point, the entry number and the state
// (docs/spec/settings.md#plugin-page).
func TestThePluginPageShowsOneLineForEachContribution(t *testing.T) {
	stored := acme()
	stored.installed = `{"plugins":[
		{"id":"probe","package":"@scope/plugin-probe","version":"1.0.0","folder":"/installed/probe","manifest":{"id":"probe","name":"프로브","description":"p",
			"sections":[{"id":"probe.list","name":"목록","composition":{"kind":"view","page":"l.html"},"height":"fill"}],
			"extends":{"list":{"version":"1.0.0","schema":{"type":"object","properties":{"label":{"type":"string"}}}}}}},
		{"id":"tidy","package":"@scope/plugin-tidy","version":"0.0.1","folder":"/installed/tidy","manifest":{"id":"tidy","name":"티디","description":"t",
			"contributes":{"probe.list":[{"range":"^1.0.0","module":"ui/a.js","label":"first"},{"range":"^2.0.0","module":"ui/b.js","label":"second"}]}}}]}`
	f := newShell(t, stored)
	f.click("core.chrome.settings", "")
	f.run("core.settings-tab.nav", map[string]any{"page": "installed"})
	f.click("core.settings-tab.plugin", "plugin:tidy")
	var lines []string
	for _, control := range f.modal().Controls {
		if control.Name == "core.settings-tab.plugins.contribution" {
			lines = append(lines, control.Label)
		}
	}
	if want := []string{"probe.list 기여 1: 연결됨", "probe.list 기여 2: version 불일치"}; !slices.Equal(lines, want) {
		t.Fatalf("the contribution lines are %q, want %q", lines, want)
	}
}

// In the project scope the sidebar lists of a plugin mark their overrides with the badge of the project, and their reset buttons
// remove the project value of the links and of the order (docs/spec/settings.md#plugin-page).
func TestTheProjectScopeMarksThePluginSidebarListsAndResetsTheirOverrides(t *testing.T) {
	f := newShell(t, acme())
	f.run("core.home.form.open", map[string]string{"mode": "open"})
	f.run("core.home.form.set", map[string]string{"field": "parent", "value": "/work/alpha"})
	f.run("core.home.form.submit", nil)
	f.click("core.chrome.settings", "")
	f.run("core.settings-tab.scope", map[string]any{"scope": "project"})
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"acme.win.order": []any{"top", "left", "right", "bottom"}}, "scope": "project"})
	f.run("core.settings.link", map[string]any{"place": "window-left", "plugin": "acme", "set": "set-1", "scope": "project"})
	f.run("core.settings-tab.nav", map[string]any{"page": "installed"})
	f.click("core.settings-tab.plugin", "plugin:acme")
	marks := 0
	for _, control := range f.modal().Controls {
		if control.Name == "core.settings-tab.override" && control.Label == "alpha 값" {
			marks++
		}
	}
	if marks != 4 {
		t.Fatalf("the window sidebar rows show %d project badges, want 4", marks)
	}
	resets := f.modal().keys("core.settings-tab.reset")
	if !slices.Contains(resets, "reset:acme.win.order") || !slices.Contains(resets, "reset:links") {
		t.Fatalf("the reset buttons are %q", resets)
	}
}

// A stored plugin value that names no loaded plugin of its category is a load error of its key alone: the other settings load and
// apply, the key has no value and is listed in missing, its plugin page shows the badge <value> required, and the error shows once
// (docs/spec/plugins.md#settings-declarations, docs/spec/settings.md#plugins).
func TestAStoredPluginValueThatNamesNoLoadedPluginIsALoadErrorOfItsKeyAlone(t *testing.T) {
	document := strings.Replace(acmeDocument, `"settings":{`, `"settings":{"pick":{"type":"plugin","category":"terminal","label":"대상","description":"d"},`, 1)
	stored := acme()
	stored.installed = document
	stored.common["acme.pick"] = "ghost"
	stored.common["dim"] = true
	f := startedShell(t, stored)
	count := 0
	for _, record := range f.shownRecords() {
		if record == (shownRecord{"workbench", "acme.pick: plugin ghost is not a terminal plugin"}) {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("the error of acme.pick shows %d times, want once", count)
	}
	f.settle()
	if status := f.settingsStatus(); status.Values["dim"] != true {
		t.Fatalf("the other settings did not load: dim is %v", status.Values["dim"])
	}
	f.click("core.chrome.settings", "")
	f.run("core.settings-tab.nav", map[string]any{"page": "installed"})
	f.click("core.settings-tab.plugin", "plugin:acme")
	if status := f.modal(); !slices.Equal(status.Missing, []string{"acme.pick"}) {
		t.Fatalf("the missing settings are %q, want acme.pick", status.Missing)
	}
	if !f.tester.HasText("ghost 필요") {
		t.Fatalf("the plugin page shows no badge of ghost, texts %q", f.tester.Texts())
	}
}
