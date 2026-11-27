package workbench_test

import (
	"encoding/json"
	"slices"
	"testing"
)

// A row of Installed shows the badge 불러오지 못함 for a refused plugin, and not the badge 필요한 플러그인 없음, which the state requires
// shows (docs/spec/settings.md#plugins).
func TestARefusedPluginRowShowsTheRefusedBadgeOnly(t *testing.T) {
	record := func() map[string]any {
		return map[string]any{"version": "1.0.0", "enabled": true, "sidecars": map[string]string{}}
	}
	plugins := &pluginsHost{registry: "file:///registry/index.json", index: registryOf(map[string][]string{"alpha": {"1.0.0"}, "beta": {"1.0.0"}}),
		plugins: map[string]map[string]any{"alpha": record(), "beta": record()}}
	plugins.core = "1.0.0"
	stored := &storedHost{plugins: plugins, installed: `{"plugins":[
		{"id":"alpha","package":"@scope/plugin-alpha","version":"1.0.0","folder": "/installed/plugin", "manifest":{"id":"alpha","name":"알파","description":"alpha","contributes":{}}},
		{"id":"beta","package":"@scope/plugin-beta","version":"1.0.0","folder": "/installed/plugin", "manifest":{"id":"beta","name":"베타","description":"beta","contributes":{},"state":{}}}]}`}
	f := startedShell(t, stored)
	f.pending.drain(t)
	f.tester.Frame()
	f.pending.drain(t)
	// The refused manifest records its error, which settle reports as a failure, so the page is opened without settle.
	for _, command := range []struct {
		name   string
		params any
	}{{"core.settings.open", nil}, {"core.settings-tab.nav", map[string]string{"page": "installed"}}} {
		raw, err := json.Marshal(command.params)
		if err != nil {
			t.Fatal(err)
		}
		f.shell.Registry().RunLater(command.name, raw, func(_ any, err error) {
			if err != nil {
				t.Fatal(err)
			}
		})
		f.pending.drain(t)
		f.tester.Frame()
	}
	badges := labelsOf(f.controlsOf(), "core.settings-tab.badge")
	if !slices.Contains(badges, "불러오지 못함") || slices.Contains(badges, "필요한 플러그인 없음") {
		t.Fatalf("the badges of the refused plugin are %q", badges)
	}
}

// A row of Installed shows the badge 개발 빌드 for an installed version newer than the newest published version
// (docs/spec/settings.md#plugins).
func TestAnInstalledVersionNewerThanThePublishedOneShowsTheDevelopmentBuildBadge(t *testing.T) {
	plugins := &pluginsHost{registry: "file:///registry/index.json", index: registryOf(map[string][]string{"zzz": {"1.0.0", "1.2.0"}}),
		plugins: map[string]map[string]any{"zzz": {"version": "2.0.0", "enabled": true, "sidecars": map[string]string{}}}}
	f := pluginShell(t, plugins, "")
	f.run("core.settings.open", nil)
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	if badges := labelsOf(f.controlsOf(), "core.settings-tab.badge"); !slices.Contains(badges, "개발 빌드") {
		t.Fatalf("the badges are %q, want 개발 빌드", badges)
	}
}
