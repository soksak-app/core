package workbench_test

import "testing"

// After the settings tab closes, the work screen shows the hint that the settings are closed, with the open-settings button, which runs core.settings.open.
// A window that never opened the tab shows no hint, and the hint hides when the tab opens again (docs/spec/settings.md#opening-and-closing).
func TestTheClosedSettingsHintShowsAfterCloseAndHidesOnReopen(t *testing.T) {
	f := projectWithPlugins(t)
	if f.tester.HasText("설정이 닫혀 있다") {
		t.Fatal("a window that never opened the settings tab shows the closed hint")
	}
	f.click("core.chrome.settings", "")
	f.run("core.settings.close", nil)
	f.settle()
	if !f.tester.HasText("설정이 닫혀 있다") || !f.tester.HasText("설정 열기") {
		t.Fatalf("the work screen shows no closed hint after the tab closed: %q", f.tester.Texts())
	}
	f.click("core.settings-tab.reopen", "")
	f.settle()
	if f.tester.HasText("설정이 닫혀 있다") {
		t.Fatal("the closed hint stays after the settings tab opened again")
	}
}

// The hint stands above the status bar at the bottom right of the work screen, so its open button does not cover the status line
// (docs/spec/settings.md#opening-and-closing).
func TestTheClosedSettingsHintEndsAboveTheStatusBar(t *testing.T) {
	f := projectWithPlugins(t)
	f.click("core.chrome.settings", "")
	f.run("core.settings.close", nil)
	f.settle()
	open := exposedNodeOf(f, "core.settings-tab.reopen", "").Bounds
	// The home button of the status bar is the first element inside the bar, so its top is the top of the status line.
	bar := exposedNodeOf(f, "core.statusbar.home", "").Bounds
	if bottom := open.Y + open.H; bottom > bar.Y+0.5 {
		t.Fatalf("the open button of the closed hint ends at y %v, below the status line whose content starts at %v", bottom, bar.Y)
	}
}
