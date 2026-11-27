package workbench_test

import (
	"slices"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
)

// pageTexts returns the text of each drawn element of the settings tab in document order.
func pageTexts(f *shellFixture) []string {
	var texts []string
	var walk func(nodes []ui.ElementNode)
	walk = func(nodes []ui.ElementNode) {
		for _, n := range nodes {
			if n.Text != "" {
				texts = append(texts, n.Text)
			}
			walk(n.Children)
		}
	}
	walk(f.tester.ElementTree())
	return texts
}

// A plugin that is not installed shows its sidecars and the add row under the install button, with the sidecar names and ranges and
// the dash of a plugin without a loaded manifest (docs/spec/settings.md#plugin-page).
func TestAnUninstalledPluginPageShowsItsSidecarsAndContributions(t *testing.T) {
	plugins := &pluginsHost{registry: "file:///registry/index.json", index: registryOf(map[string][]string{"alpha": {"1.0.0"}, "beta": {"1.0.0"}})}
	plugins.plugins = map[string]map[string]any{"alpha": {"version": "1.0.0", "enabled": true, "sidecars": map[string]string{"hello": "^2.0.0"}}}
	f := pluginShell(t, plugins, loadedAlpha)
	f.run("core.settings.open", nil)
	f.run("core.settings-tab.nav", map[string]string{"page": "browse"})
	f.run("core.settings-tab.plugin", map[string]string{"plugin": "beta"})
	texts := pageTexts(f)
	if !slices.Contains(texts, "사이드카") || !slices.Contains(texts, "더하는 것") {
		t.Fatalf("the plugin page of an uninstalled plugin shows %q, want the rows 사이드카 and 더하는 것", texts)
	}
	if !slices.ContainsFunc(texts, func(text string) bool { return strings.Contains(text, "hello ^2.0.0") }) {
		t.Fatalf("the sidecar row does not name hello ^2.0.0: %q", texts)
	}
}

// The Sections group is not drawn for a plugin without sections (docs/spec/settings.md#plugin-page).
func TestAPluginWithoutSectionsDrawsNoSectionsGroup(t *testing.T) {
	plugins := &pluginsHost{registry: "file:///registry/index.json", index: registryOf(map[string][]string{"alpha": {"1.0.0"}})}
	plugins.plugins = map[string]map[string]any{"alpha": {"version": "1.0.0", "enabled": true, "sidecars": map[string]string{"hello": "^2.0.0"}}}
	f := pluginShell(t, plugins, loadedAlpha)
	f.run("core.settings.open", nil)
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	f.run("core.settings-tab.plugin", map[string]string{"plugin": "alpha"})
	if texts := pageTexts(f); slices.Contains(texts, "이 플러그인이 사이드바에 제공하는 섹션.") {
		t.Fatalf("the plugin page without sections draws the group 섹션: %q", texts)
	}
}

// The plugin page shows the development build badge when the installed version is newer than the published one (docs/spec/settings.md#plugin-page).
func TestAPluginPageShowsTheDevelopmentBuildBadge(t *testing.T) {
	plugins := &pluginsHost{registry: "file:///registry/index.json", index: registryOf(map[string][]string{"zzz": {"1.0.0", "1.2.0"}}),
		plugins: map[string]map[string]any{"zzz": {"version": "2.0.0", "enabled": true, "sidecars": map[string]string{}}}}
	f := pluginShell(t, plugins, "")
	f.run("core.settings.open", nil)
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	f.run("core.settings-tab.plugin", map[string]string{"plugin": "zzz"})
	if badges := labelsOf(f.controlsOf(), "core.settings-tab.badge"); !slices.Contains(badges, "개발 빌드") {
		t.Fatalf("the plugin page badges are %q, want 개발 빌드", badges)
	}
}

// The Required row of a plugin page names the required plugin by its name and id, and its button installs the plugin by its name
// (docs/spec/settings.md#plugin-page).
func TestTheRequiredRowNamesTheRequiredPlugin(t *testing.T) {
	const requiring = `{"plugins":[{"id":"alpha","package":"alpha","version":"1.0.0","folder": "/installed/plugin", "manifest":{"id":"alpha","name":"Alpha","description":"Loaded alpha",
	"mark":"a","icon":"<path d=\"M1 1h14\"/>","surface":{"composition":{"kind":"view","page":"ui/index.html"}},"dependencies":{"beta":"^1.0.0"}}}]}`
	plugins := &pluginsHost{registry: "file:///registry/index.json", index: registryOf(map[string][]string{"alpha": {"1.0.0"}, "beta": {"1.0.0"}}),
		plugins: map[string]map[string]any{"alpha": {"version": "1.0.0", "enabled": true, "sidecars": map[string]string{}}}}
	f := pluginShell(t, plugins, requiring)
	f.run("core.settings.open", nil)
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	f.run("core.settings-tab.plugin", map[string]string{"plugin": "alpha"})
	texts := pageTexts(f)
	if !slices.Contains(texts, "필요한 Name of beta(beta) 플러그인이 설치되어 있지 않다.") {
		t.Fatalf("the required row is %q, want the name and the id of beta", texts)
	}
	if !slices.Contains(texts, "Name of beta 설치") {
		t.Fatalf("the install button of the required row is not named by the plugin name: %q", texts)
	}
}
