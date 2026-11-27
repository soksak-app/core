package workbench_test

import "testing"

// The group Plugins with settings lists every installed plugin, and a plugin without settings has its item too
// (docs/spec/settings.md#menu).
func TestTheMenuListsEveryInstalledPluginWithoutSettings(t *testing.T) {
	plugins := &pluginsHost{registry: "file:///registry/index.json", index: registryOf(map[string][]string{"zzz": {"1.0.0"}}),
		plugins: map[string]map[string]any{"zzz": {"version": "1.0.0", "enabled": true, "sidecars": map[string]string{}}}}
	f := pluginShell(t, plugins, "")
	f.run("core.settings.open", nil)
	found := false
	for _, control := range f.controlsOf() {
		if control.Name == "core.settings-tab.plugin-item" && control.Key != nil && *control.Key == "plugin:zzz" {
			found = true
		}
	}
	if !found {
		t.Fatal("the menu has no item plugin:zzz for an installed plugin without settings")
	}
}

// A disabled installed plugin has its item with the Off badge and no dot (docs/spec/settings.md#menu).
func TestTheMenuItemOfADisabledPluginShowsTheOffBadge(t *testing.T) {
	plugins := &pluginsHost{registry: "file:///registry/index.json", index: registryOf(map[string][]string{"zzz": {"1.0.0"}}),
		plugins: map[string]map[string]any{"zzz": {"version": "1.0.0", "enabled": false, "sidecars": map[string]string{}}}}
	f := pluginShell(t, plugins, "")
	f.run("core.settings.open", nil)
	for _, control := range f.controlsOf() {
		if control.Name == "core.settings-tab.plugin-item" && control.Key != nil && *control.Key == "plugin:zzz" {
			if control.Badge != "꺼짐" {
				t.Fatalf("the item of a disabled plugin has badge %q, want 꺼짐", control.Badge)
			}
			return
		}
	}
	t.Fatal("the menu has no item plugin:zzz")
}
