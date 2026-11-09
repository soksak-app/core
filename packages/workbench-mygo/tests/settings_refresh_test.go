package workbench_test

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"
)

// settingsOf reads the settings status of a window: the values in force and the overridden keys.
func settingsOf(t *testing.T, f *shellFixture) (map[string]any, []string) {
	t.Helper()
	read := status[struct {
		Values     map[string]any `json:"values"`
		Overridden []string       `json:"overridden"`
	}](t, f, "core.settings")
	return read.Values, read.Overridden
}

// A window reads the settings again at each change of the store, as refresh of packages/workbench/settings.js: the common settings
// that another window wrote and the settings file of the shown project take effect in its store and on its screen.
func TestTheSettingsThatAnotherWindowStoredReachTheWindow(t *testing.T) {
	stored := &storedHost{projects: []map[string]any{storedProject(tab("tab-aaaaaa", "notes"))}}
	f := newTabShell(t, stored)
	f.open(t)
	other := newShell(t, stored)
	other.run("core.settings.set", map[string]any{"patch": map[string]any{"mode": "light"}, "scope": "common"})
	stored.mu.Lock()
	stored.folderSettings = map[string]map[string]any{"/a": {"fullRule": "over"}}
	stored.theme = nil
	stored.mu.Unlock()
	f.shell.Event("workspace-changed", nil)
	f.settle()
	values, overridden := settingsOf(t, f.shellFixture)
	if values["mode"] != "light" || values["fullRule"] != "over" || !slices.Contains(overridden, "fullRule") {
		t.Fatalf("the window holds the settings %v with the overrides %v", values, overridden)
	}
	var theme struct {
		Scheme string `json:"scheme"`
	}
	stored.mu.Lock()
	err := json.Unmarshal(stored.theme, &theme)
	stored.mu.Unlock()
	if err != nil || theme.Scheme != "light" {
		t.Fatalf("the window shows the scheme %q (%v)", theme.Scheme, err)
	}
}

// The settings file of the shown project that the host refuses at a change of the store is reported, and the window keeps the
// settings that it applied (docs/spec/projects.md#settings).
func TestARefusedSettingsFileOfTheShownProjectKeepsTheAppliedSettings(t *testing.T) {
	stored := &storedHost{projects: []map[string]any{storedProject(tab("tab-aaaaaa", "notes"))}}
	f := newTabShell(t, stored)
	f.open(t)
	stored.mu.Lock()
	stored.common = map[string]any{"mode": "light"}
	stored.projects[0]["settingsError"] = "the settings file is refused"
	stored.mu.Unlock()
	f.shell.Event("workspace-changed", nil)
	f.pending.drain(t)
	f.tester.Frame()
	if errors := stored.written("workbench.record.error"); len(errors) != 1 || !strings.Contains(fmt.Sprint(errors[0]), "the settings file is refused") {
		t.Fatalf("the window recorded %v", errors)
	}
	if values, _ := settingsOf(t, f.shellFixture); values["mode"] != "dark" {
		t.Fatalf("the window took the mode %v beside a refused settings file", values["mode"])
	}
}
