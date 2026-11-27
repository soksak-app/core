package workbench_test

import "testing"

// The settings tab is a tab of the work screen: on the project home it comes to the front, and core.screen reports the work
// screen, as the web body does (docs/spec/settings.md#opening-and-closing, docs/spec/exposure.md).
func TestTheSettingsTabOnTheProjectHomeReportsTheWorkScreen(t *testing.T) {
	f, _, _ := twoProjects(t)
	f.run("core.projects.browse", nil)
	f.settle()
	if screen := status[map[string]any](t, f, "core.screen")["screen"]; screen != "home" {
		t.Fatalf("before the settings tab the window shows %v, want home", screen)
	}
	f.run("core.settings.open", nil)
	f.settle()
	if screen := status[map[string]any](t, f, "core.screen")["screen"]; screen != "workspace" {
		t.Fatalf("with the settings tab in front the window reports %v, want workspace", screen)
	}
}
