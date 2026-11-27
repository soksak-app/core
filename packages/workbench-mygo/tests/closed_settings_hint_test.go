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
