package workbench_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/egoist/mygo/ui"
	"image/color"
	"slices"
	"strings"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// pluginsHost is the plugin state of the host of a test: its installed plugins change with the operations, as the host changes them.
type pluginsHost struct {
	core     string
	registry any
	index    any
	plugins  map[string]map[string]any
	sidecars map[string]any
	firstRun bool
	starter  any
	outdated []any
	runs     []string
	used     []string
	jobs     []string
}

func (p *pluginsHost) state(json.RawMessage) (any, error) {
	return map[string]any{"core": p.core, "registry": p.registry, "index": p.index, "firstRun": p.firstRun, "starter": p.starter,
		"installed": map[string]any{"format": 1, "plugins": p.plugins, "sidecars": p.sidecars}}, nil
}

func (p *pluginsHost) run(argument json.RawMessage) (any, error) {
	var request struct{ Action, Plugin string }
	if err := json.Unmarshal(argument, &request); err != nil {
		return nil, err
	}
	p.runs = append(p.runs, request.Action+" "+request.Plugin)
	switch request.Action {
	case "install":
		p.firstRun = false
		p.plugins[request.Plugin] = map[string]any{"version": "1.0.0", "enabled": true, "sidecars": map[string]string{}}
	case "update":
		p.plugins[request.Plugin]["version"] = "1.2.0"
	case "remove":
		delete(p.plugins, request.Plugin)
	case "enable", "disable":
		p.plugins[request.Plugin]["enabled"] = request.Action == "enable"
	}
	return nil, nil
}

func registryOf(versions map[string][]string) map[string]any {
	plugins := []any{}
	for id, listed := range versions {
		items := []any{}
		for _, version := range listed {
			items = append(items, map[string]any{"version": version, "engines": map[string]string{"soksak": "^1.0.0"},
				"sidecars": map[string]string{"hello": "^2.0.0"}})
		}
		plugins = append(plugins, map[string]any{"id": id, "name": "Name of " + id, "description": "About " + id, "versions": items})
	}
	return map[string]any{"format": 1, "plugins": plugins, "sidecars": []any{}, "packs": []any{map[string]any{"name": "starter", "plugins": []string{"alpha"}}},
		"revoked": map[string]any{"plugins": []any{}, "sidecars": []any{}}}
}

func pluginShell(t *testing.T, plugins *pluginsHost, installed string) *shellFixture {
	t.Helper()
	if plugins.core == "" {
		plugins.core = "1.0.0"
	}
	if plugins.plugins == nil {
		plugins.plugins = map[string]map[string]any{}
	}
	return newShell(t, &storedHost{installed: installed, plugins: plugins})
}

// finish runs a command that answers in a later step and returns its failure.
func (f *shellFixture) finish(name string, params any) error {
	f.t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		f.t.Fatal(err)
	}
	var failure error
	answered := false
	f.shell.Registry().RunLater(name, raw, func(_ any, err error) { answered, failure = true, err })
	f.settle()
	if !answered {
		f.t.Fatalf("%s did not answer", name)
	}
	return failure
}

type pluginsStatus struct {
	Core      *string
	Registry  *string
	Error     *string
	Reload    bool
	Plugins   []workbench.PluginRow
	Operation *struct {
		Action, Plugin, State string
		Error                 *string
	}
	Updates  []workbench.PluginUpdate
	Outdated []workbench.OutdatedSidecar
}

func (f *shellFixture) pluginStatus() pluginsStatus {
	f.t.Helper()
	value, err := f.shell.Registry().Read("core.plugins")
	if err != nil {
		f.t.Fatal(err)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		f.t.Fatal(err)
	}
	var status pluginsStatus
	if err := json.Unmarshal(encoded, &status); err != nil {
		f.t.Fatal(err)
	}
	return status
}

const loadedAlpha = `{"plugins":[{"id":"alpha","package":"alpha","version":"1.0.0","manifest":{"id":"alpha","name":"Alpha","description":"Loaded alpha",
	"mark":"a","icon":"<path d=\"M1 1h14\"/>","surface":{"composition":{"kind":"view","page":"ui/index.html"}},"dependencies":{"hello":"^2.0.0"}}}]}`

func TestPluginRowsFollowTheStateOfThePage(t *testing.T) {
	version := func(v string) *string { return &v }
	loaded := []workbench.LoadedPlugin{{ID: "kept", Name: "Kept", Version: "1.0.0"}, {ID: "stale", Name: "Stale", Version: "1.0.0"}}
	state := &workbench.PluginsState{Core: "1.0.0"}
	if err := json.Unmarshal([]byte(`{"core":"1.0.0","installed":{"plugins":{
		"kept":{"version":"1.0.0","enabled":true,"sidecars":{"hello":"^2.0.0"}},
		"off":{"version":"1.0.0","enabled":false,"sidecars":{}},
		"stale":{"version":"2.0.0","enabled":true,"sidecars":{}},
		"waiting":{"version":"1.0.0","enabled":true,"sidecars":{}},
		"bad":{"version":"1.0.0","enabled":true,"sidecars":{}}
	},"sidecars":{"hello":{"version":"2.1.0"}}},
	"index":{"plugins":[
		{"id":"kept","name":"Registry kept","description":"","versions":[
			{"version":"1.0.0","engines":{"soksak":"^1.0.0"},"sidecars":{}},
			{"version":"1.2.0","engines":{"soksak":"^1.0.0"},"sidecars":{}},
			{"version":"1.3.0","engines":{"soksak":"^1.0.0"},"sidecars":{}},
			{"version":"2.0.0","engines":{"soksak":"^2.0.0"},"sidecars":{}}]},
		{"id":"new","name":"New","description":"Offered","versions":[{"version":"3.0.0","engines":{"soksak":"^1.0.0"},"sidecars":{"hello":"^2.0.0"}}]},
		{"id":"old","name":"Old","description":"","versions":[{"version":"1.0.0","engines":{"soksak":"^9.0.0"},"sidecars":{}}]},
		{"id":"gone","name":"Gone","description":"","versions":[{"version":"1.0.0","engines":{"soksak":"^1.0.0"},"sidecars":{}}]}
	],"revoked":{"plugins":[{"id":"kept","version":"1.3.0"},{"id":"gone","version":"1.0.0"}],"sidecars":[]}}}`), state); err != nil {
		t.Fatal(err)
	}
	rows, err := workbench.PluginRows(loaded, state, map[string]bool{"bad": true})
	if err != nil {
		t.Fatal(err)
	}
	ids, states := []string{}, map[string]workbench.PluginRow{}
	for _, row := range rows {
		ids = append(ids, row.ID)
		states[row.ID] = row
	}
	if want := []string{"bad", "kept", "new", "off", "old", "stale", "waiting"}; !slices.Equal(ids, want) {
		t.Fatalf("the rows are %v, not %v", ids, want)
	}
	for id, want := range map[string]string{"bad": "refused", "kept": "loaded", "new": "available", "off": "disabled", "old": "available", "stale": "reload", "waiting": "reload"} {
		if states[id].State != want {
			t.Errorf("%s has the state %s, not %s", id, states[id].State, want)
		}
	}
	kept := states["kept"]
	if kept.Latest == nil || *kept.Latest != "1.2.0" {
		t.Errorf("the latest of kept is %v: the revoked and the incompatible versions do not count", kept.Latest)
	}
	if kept.Name != "Kept" || states["new"].Name != "New" || states["off"].Name != "off" {
		t.Errorf("the names are %q %q %q", kept.Name, states["new"].Name, states["off"].Name)
	}
	if len(kept.Sidecars) != 1 || kept.Sidecars[0].Version == nil || *kept.Sidecars[0].Version != "2.1.0" {
		t.Errorf("the sidecars of kept are %+v", kept.Sidecars)
	}
	offered := states["new"].Sidecars
	if len(offered) != 1 || offered[0].Range == nil || *offered[0].Range != *version("^2.0.0") {
		t.Errorf("the sidecars of new are %+v", offered)
	}
	if old := states["old"]; !old.Incompatible || old.Latest != nil || old.Sidecars != nil {
		t.Errorf("old is %+v", old)
	}
}

func TestThePluginPageListsTheRegistry(t *testing.T) {
	plugins := &pluginsHost{registry: "file:///registry/index.json", index: registryOf(map[string][]string{"alpha": {"1.0.0", "1.2.0"}, "beta": {"1.0.0"}})}
	plugins.plugins = map[string]map[string]any{"alpha": {"version": "1.0.0", "enabled": true, "sidecars": map[string]string{"hello": "^2.0.0"}}}
	f := pluginShell(t, plugins, loadedAlpha)
	f.run("core.library.page", map[string]string{"page": "plugins"})
	for _, want := range []string{"Alpha", "Name of beta", "사용 중", "설치 안 됨", "모두 업데이트", "alpha: 1.0.0 → 1.2.0"} {
		if !slices.Contains(f.tester.Texts(), want) {
			t.Fatalf("the page has no %q: %q", want, f.tester.Texts())
		}
	}
	f.audit()
	status := f.pluginStatus()
	if status.Registry == nil || *status.Registry != "file:///registry/index.json" || status.Core == nil || status.Reload {
		t.Fatalf("core.plugins is %+v", status)
	}
	if len(status.Updates) != 1 || status.Updates[0].Latest != "1.2.0" {
		t.Fatalf("the updates are %+v", status.Updates)
	}
	if !f.has("core.chrome.updates", "") {
		t.Fatal("the window has no control of the updates")
	}
	value, err := f.shell.Registry().Read("core.library")
	if err != nil {
		t.Fatal(err)
	}
	library, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var read struct {
		Page    string
		Plugins struct {
			Shown   []string
			Actions []workbench.PluginAction
		}
	}
	if err := json.Unmarshal(library, &read); err != nil {
		t.Fatal(err)
	}
	if read.Page != "plugins" || !slices.Equal(read.Plugins.Shown, []string{"alpha", "beta"}) {
		t.Fatalf("core.library is %s", library)
	}
	if !strings.Contains(string(library), `"action":"install"`) || !strings.Contains(string(library), `"action":"disable"`) {
		t.Fatalf("core.library is %s", library)
	}
}

func TestAPluginActionRunsTheOperationOfTheHost(t *testing.T) {
	plugins := &pluginsHost{registry: "file:///registry/index.json", index: registryOf(map[string][]string{"beta": {"1.0.0"}})}
	f := pluginShell(t, plugins, `{"plugins":[]}`)
	f.run("core.library.page", map[string]string{"page": "plugins"})
	f.click("core.library.plugins.action", "beta/install")
	if !slices.Equal(plugins.runs, []string{"install beta"}) {
		t.Fatalf("the operations are %v", plugins.runs)
	}
	status := f.pluginStatus()
	if status.Operation == nil || status.Operation.State != "done" || status.Operation.Error != nil {
		t.Fatalf("the operation is %+v", status.Operation)
	}
	if len(status.Plugins) != 1 || status.Plugins[0].State != "reload" || !status.Reload {
		t.Fatalf("an installed plugin that the window did not load waits for the reload: %+v", status)
	}
	if err := f.finish("core.plugins.disable", map[string]string{"plugin": "beta"}); err != nil {
		t.Fatal(err)
	}
	if err := f.finish("core.plugins.enable", map[string]string{"plugin": "beta"}); err != nil {
		t.Fatal(err)
	}
	if err := f.finish("core.plugins.remove", map[string]string{"plugin": "beta"}); err != nil {
		t.Fatal(err)
	}
	if want := []string{"install beta", "disable beta", "enable beta", "remove beta"}; !slices.Equal(plugins.runs, want) {
		t.Fatalf("the operations are %v", plugins.runs)
	}
}

func TestAFailedPluginOperationIsTheStateOfItsCard(t *testing.T) {
	plugins := &pluginsHost{registry: "file:///registry/index.json", index: registryOf(map[string][]string{"beta": {"1.0.0"}})}
	f := pluginShell(t, plugins, `{"plugins":[]}`)
	f.host.failing = map[string]error{"pluginsRun": errors.New("the release is damaged")}
	f.run("core.library.page", map[string]string{"page": "plugins"})
	var failure error
	f.shell.Registry().RunLater("core.plugins.install", json.RawMessage(`{"plugin":"beta"}`), func(_ any, err error) { failure = err })
	f.pending.drain(t)
	f.tester.Frame()
	f.pending.drain(t)
	f.tester.Frame()
	if failure == nil || !strings.Contains(failure.Error(), "damaged") {
		t.Fatalf("the failure is %v", failure)
	}
	status := f.pluginStatus()
	if status.Operation == nil || status.Operation.State != "failed" || status.Operation.Error == nil || *status.Operation.Error != "the release is damaged" {
		t.Fatalf("the operation is %+v", status.Operation)
	}
	if !slices.Contains(f.tester.Texts(), "the release is damaged") {
		t.Fatalf("the card does not show the failure: %q", f.tester.Texts())
	}
	if errors := f.host.written("workbench.record.error"); len(errors) != 1 {
		t.Fatalf("the shown failure is recorded %d times", len(errors))
	}
}

// The update button of the chrome shows the update list at the top of a page that was scrolled away from it.
func TestShowUpdatesBringsTheUpdateListIntoView(t *testing.T) {
	versions := map[string][]string{"alpha": {"1.0.0", "1.2.0"}}
	for i := range 30 {
		versions[fmt.Sprintf("plugin-%02d", i)] = []string{"1.0.0"}
	}
	plugins := &pluginsHost{registry: "file:///registry/index.json", index: registryOf(versions), plugins: map[string]map[string]any{
		"alpha": {"version": "1.0.0", "enabled": true, "sidecars": map[string]string{}}}}
	f := pluginShell(t, plugins, `{"plugins":[]}`)
	f.run("core.library.page", map[string]string{"page": "plugins"})
	f.settle()
	top := positional(t, f.tester, "core.library.plugins.updates", 0).Bounds.Y
	f.tester.Scroll(600, 600, 0, 1500)
	f.tester.Frame()
	if scrolled := positional(t, f.tester, "core.library.plugins.updates", 0).Bounds.Y; scrolled >= 0 {
		t.Fatalf("the list stands at %v after the scroll, from %v", scrolled, top)
	}
	f.run("core.plugins.show-updates", nil)
	f.settle()
	if shown := positional(t, f.tester, "core.library.plugins.updates", 0).Bounds.Y; shown < 0 {
		t.Fatalf("the list stands at %v", shown)
	}
}

// A plugin whose manifest the window refuses is left out with its error, its row says so, and the other plugins load.
func TestAnInstalledPluginWithARefusedManifestIsRefused(t *testing.T) {
	record := func() map[string]any {
		return map[string]any{"version": "1.0.0", "enabled": true, "sidecars": map[string]string{}}
	}
	plugins := &pluginsHost{registry: "file:///registry/index.json", index: registryOf(map[string][]string{"alpha": {"1.0.0"}, "beta": {"1.0.0"}}),
		plugins: map[string]map[string]any{"alpha": record(), "beta": record()}}
	plugins.core = "1.0.0"
	stored := &storedHost{plugins: plugins, installed: `{"plugins":[
		{"id":"alpha","package":"@scope/plugin-alpha","version":"1.0.0","manifest":{"id":"alpha","name":"알파","description":"alpha","contributes":{}}},
		{"id":"beta","package":"@scope/plugin-beta","version":"1.0.0","manifest":{"id":"beta","name":"베타","description":"beta","contributes":{},"state":{}}}]}`}
	f := startedShell(t, stored)
	f.pending.drain(t)
	f.tester.Frame()
	f.pending.drain(t)
	status := f.pluginStatus()
	states := map[string]string{}
	for _, row := range status.Plugins {
		states[row.ID] = row.State
	}
	if states["alpha"] != "loaded" || states["beta"] != "refused" {
		t.Fatalf("the states are %v", states)
	}
	written := f.host.written("workbench.record.error")
	if len(written) != 1 || !strings.Contains(fmt.Sprint(written[0]), "installed plugin beta 1.0.0 (@scope/plugin-beta): ") {
		t.Fatalf("the shell recorded %v", written)
	}
}

func TestAPluginCommandRefusesAnEmptyPlugin(t *testing.T) {
	f := pluginShell(t, &pluginsHost{}, `{"plugins":[]}`)
	if err := f.finish("core.plugins.install", map[string]string{"plugin": ""}); err == nil {
		t.Fatal("an empty plugin ran")
	}
}

func TestUpdateAllStopsAtTheFirstFailure(t *testing.T) {
	plugins := &pluginsHost{registry: "file:///registry/index.json", index: registryOf(map[string][]string{"alpha": {"1.2.0"}, "beta": {"1.2.0"}})}
	plugins.plugins = map[string]map[string]any{"alpha": {"version": "1.0.0", "enabled": true, "sidecars": map[string]string{}},
		"beta": {"version": "1.0.0", "enabled": true, "sidecars": map[string]string{}}}
	f := pluginShell(t, plugins, `{"plugins":[]}`)
	f.run("core.library.page", map[string]string{"page": "plugins"})
	if err := f.finish("core.plugins.update-all", nil); err != nil {
		t.Fatal(err)
	}
	if want := []string{"update alpha", "update beta"}; !slices.Equal(plugins.runs, want) {
		t.Fatalf("the operations are %v", plugins.runs)
	}
}

func TestTheHostEventsReadThePluginStateAgain(t *testing.T) {
	plugins := &pluginsHost{}
	f := pluginShell(t, plugins, `{"plugins":[]}`)
	reads := func(name string) int {
		count := 0
		for _, call := range f.host.calls {
			if call == name {
				count++
			}
		}
		return count
	}
	state, outdated := reads("pluginsState"), reads("sidecarsOutdated")
	plugins.registry, plugins.index = "file:///registry/index.json", registryOf(map[string][]string{"beta": {"1.0.0"}})
	f.shell.Event("window-active", nil)
	f.settle()
	if reads("pluginsState") != state+1 || len(f.pluginStatus().Plugins) != 1 {
		t.Fatalf("window-active did not read the state; the calls are %v", f.host.calls)
	}
	plugins.outdated = []any{map[string]any{"sidecar": "hello", "running": "1.0.0", "installed": "2.0.0", "sessions": 2}}
	f.shell.Event("sidecars-changed", nil)
	f.settle()
	if reads("sidecarsOutdated") != outdated+1 || len(f.pluginStatus().Outdated) != 1 {
		t.Fatalf("sidecars-changed did not read the outdated sidecars; the calls are %v", f.host.calls)
	}
}

func TestTheFirstRunInstallsTheStarterPack(t *testing.T) {
	plugins := &pluginsHost{firstRun: true, index: registryOf(map[string][]string{"alpha": {"1.0.0"}})}
	f := pluginShell(t, plugins, `{"plugins":[]}`)
	if want := []string{"https://soksak-app.github.io/registry/index.json"}; !slices.Equal(plugins.used, want) {
		t.Fatalf("the registry is %v", plugins.used)
	}
	if want := []string{"pending starter", "complete starter"}; !slices.Equal(plugins.jobs, want) {
		t.Fatalf("the jobs are %v", plugins.jobs)
	}
	if !slices.Equal(plugins.runs, []string{"install alpha"}) {
		t.Fatalf("the operations are %v", plugins.runs)
	}
	if f.host.reloads != 1 {
		t.Fatalf("the starter pack reloaded %d times", f.host.reloads)
	}
}

func TestACompleteStarterJobIsNotRepeated(t *testing.T) {
	plugins := &pluginsHost{firstRun: true, starter: map[string]any{"format": 1, "state": "complete", "pack": "starter", "registry": "r", "plugins": []string{"alpha"}}}
	f := pluginShell(t, plugins, `{"plugins":[]}`)
	if len(plugins.runs)+len(plugins.jobs) != 0 || f.host.reloads != 0 {
		t.Fatalf("the operations are %v and the jobs %v", plugins.runs, plugins.jobs)
	}
}

// The action of a tab is a .ui-button of the page: the page background, and only its edge changes under the pointer.
func TestTheInstallOfATabHasTheLookOfAButtonOfThePage(t *testing.T) {
	plugins := &pluginsHost{registry: "file:///registry/index.json", index: registryOf(map[string][]string{"terminal": {"1.0.0"}})}
	stored := &storedHost{plugins: plugins}
	plugins.core, plugins.plugins = "1.0.0", map[string]map[string]any{}
	f := newShell(t, stored)
	f.run("core.library.form.open", map[string]string{"mode": "open"})
	f.run("core.library.form.set", map[string]string{"field": "parent", "value": "/work/alpha"})
	f.run("core.library.form.submit", nil)
	node, ok := exposedNode(f.tester.ElementTree(), "core.card.placeholder-action", "")
	if !ok {
		t.Fatalf("the tab offers no install: %q", f.tester.Texts())
	}
	palette := f.palette()
	opaque := func(value ui.Color) color.RGBA { return color.RGBA{value.R, value.G, value.B, 255} }
	x, y := node.Bounds.X, node.Bounds.Y+node.Bounds.H/2
	check := func(state string, edge ui.Color) {
		t.Helper()
		if got := f.pixelOf(x+.5, y); got != opaque(edge) {
			t.Fatalf("the edge %s is %v, not %v", state, got, opaque(edge))
		}
		if got := f.pixelOf(x+3, y); got != opaque(palette.Bg) {
			t.Fatalf("the background %s is %v, not %v", state, got, opaque(palette.Bg))
		}
	}
	check("at rest", palette.Edge)
	f.tester.Move(x+3, y)
	f.settle()
	check("under the pointer", palette.Rail)
}

func TestATabOfAPluginThatIsNotLoadedOffersItsInstall(t *testing.T) {
	plugins := &pluginsHost{registry: "file:///registry/index.json", index: registryOf(map[string][]string{"terminal": {"1.0.0"}})}
	stored := &storedHost{plugins: plugins}
	plugins.core, plugins.plugins = "1.0.0", map[string]map[string]any{}
	f := newShell(t, stored)
	f.run("core.library.form.open", map[string]string{"mode": "open"})
	f.run("core.library.form.set", map[string]string{"field": "parent", "value": "/work/alpha"})
	f.run("core.library.form.submit", nil)
	if !f.has("core.card.placeholder-action", "") {
		t.Fatalf("the tab offers no install: %q", f.tester.Texts())
	}
	f.click("core.card.placeholder-action", "")
	if !slices.Contains(plugins.runs, "install terminal") {
		t.Fatalf("the operations are %v", plugins.runs)
	}
	plugins.plugins["terminal"]["enabled"] = false
	f.shell.Event("window-active", nil)
	f.settle()
	if !slices.Contains(f.tester.Texts(), fmt.Sprintf("%s 플러그인을 사용하지 않습니다.", "terminal")) {
		t.Fatalf("the tab of a disabled plugin says %q", f.tester.Texts())
	}
}

// The line of a placeholder is a paragraph of the page: its margin of one line and the gap of the placeholder stand between it and the button.
func TestThePlaceholderStandsAsThePageStandsIt(t *testing.T) {
	plugins := &pluginsHost{registry: "file:///registry/index.json", index: registryOf(map[string][]string{"terminal": {"1.0.0"}})}
	stored := &storedHost{plugins: plugins}
	plugins.core, plugins.plugins = "1.0.0", map[string]map[string]any{}
	f := newShell(t, stored)
	f.run("core.library.form.open", map[string]string{"mode": "open"})
	f.run("core.library.form.set", map[string]string{"field": "parent", "value": "/work/alpha"})
	f.run("core.library.form.submit", nil)
	var line ui.ElementNode
	var find func(nodes []ui.ElementNode)
	find = func(nodes []ui.ElementNode) {
		for _, node := range nodes {
			if line.Bounds.H == 0 && strings.HasSuffix(node.Label, "플러그인이 설치되어 있지 않습니다.") {
				line = node
			}
			find(node.Children)
		}
	}
	find(f.tester.ElementTree())
	button := f.box("core.card.placeholder-action", "")
	if line.Bounds.H == 0 {
		t.Fatalf("no line: %q", f.tester.Texts())
	}
	const size, margin, gap, lineHeight = 13, 13, 10, 1.45
	if got := button.Y - (line.Bounds.Y + line.Bounds.H); got < margin+gap-0.01 || got > margin+gap+0.01 {
		t.Fatalf("the button stands %v under the line %+v", got, line.Bounds)
	}
	if want := float32(size * lineHeight); line.Bounds.H < want-0.5 || line.Bounds.H > want+0.5 {
		t.Fatalf("the line is %v high, want %v", line.Bounds.H, want)
	}
}
