// The settings chip beside the project tabs, the content rectangle of the settings tab under the title bar, and the surfaces of
// the window while the tab is in front (docs/spec/settings.md#opening-and-closing).
package workbench_test

import "testing"

// The chip shows ⚙ 설정 after the project tabs of the title bar, in both places of the project tabs.
func TestTheSettingsChipStandsInTheTitleBarAfterTheProjectTabs(t *testing.T) {
	f, _, second := twoProjects(t)
	f.run("core.settings.open", nil)
	bar := element(t, f.tester, "core.chrome.bar", "")
	chip := element(t, f.tester, "core.settings-tab.chip", "")
	if chip.Text != "⚙ 설정" {
		t.Fatalf("the chip says %q", chip.Text)
	}
	last := f.box("core.project-tab", second)
	if chip.Bounds.X < last.X+last.W {
		t.Fatalf("the chip %+v stands before the last project tab %+v", chip.Bounds, last)
	}
	if chip.Bounds.Y < bar.Bounds.Y || chip.Bounds.Y+chip.Bounds.H > bar.Bounds.Y+bar.Bounds.H {
		t.Fatalf("the chip %+v is outside the title bar %+v", chip.Bounds, bar.Bounds)
	}
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"projectTabs": "left"}, "scope": "common"})
	bar = element(t, f.tester, "core.chrome.bar", "")
	brand := element(t, f.tester, "core.chrome.projects", "")
	chip = element(t, f.tester, "core.settings-tab.chip", "")
	if chip.Bounds.X < brand.Bounds.X+brand.Bounds.W || chip.Bounds.Y+chip.Bounds.H > bar.Bounds.Y+bar.Bounds.H {
		t.Fatalf("with the project tabs on the left the chip %+v is not in the title bar after the logo %+v", chip.Bounds, brand.Bounds)
	}
}

// The chip brings the tab to the front, and its close control closes the tab and removes the chip.
func TestTheChipBringsTheTabToTheFrontAndItsCloseClosesIt(t *testing.T) {
	f, _, _ := twoProjects(t)
	f.run("core.settings.open", nil)
	f.click("core.settings-tab.chip", "")
	if f.tabStatus() == nil {
		t.Fatal("the chip closed the settings tab")
	}
	f.click("core.settings-tab.close", "")
	if f.tabStatus() != nil {
		t.Fatal("the close control left the settings tab open")
	}
	if f.has("core.settings-tab.chip", "") {
		t.Fatal("the chip stays in the title bar after the tab closed")
	}
}

// The content of the settings tab fills the rectangle under the title bar: the place that the work screen takes.
func TestTheSettingsTabFillsTheContentRectangleUnderTheTitleBar(t *testing.T) {
	f, _, _ := twoProjects(t)
	f.run("core.settings.open", nil)
	bar := element(t, f.tester, "core.chrome.bar", "")
	tab := element(t, f.tester, "core.settings-tab", "")
	barBottom := bar.Bounds.Y + bar.Bounds.H
	if tab.Bounds.X != 0 || tab.Bounds.Y != barBottom || tab.Bounds.W != bar.Bounds.W || tab.Bounds.Y+tab.Bounds.H != fixtureHeight {
		t.Fatalf("the settings tab is %+v, want the rectangle under the title bar that ends at %v in a window %v high", tab.Bounds, barBottom, fixtureHeight)
	}
}

// The title bar shows no window tool while the settings tab is in front (docs/spec/external-sidebars.md#window-tools).
func TestTheSettingsTabTitleBarShowsNoWindowTool(t *testing.T) {
	f, _, _ := twoProjects(t)
	f.run("core.settings.open", nil)
	for _, name := range []string{"core.chrome.left", "core.chrome.right", "core.chrome.top", "core.chrome.bottom", "core.chrome.settings"} {
		if f.has(name, "") {
			t.Fatalf("the settings tab shows %s in its title bar", name)
		}
	}
}

// While the settings tab is in front no surface of the window is visible, and every surface keeps its session as a hidden tab does.
func TestWhileTheSettingsTabIsInFrontNoSurfaceIsVisible(t *testing.T) {
	f, stored := surfaceShellOf(t, sidebarsInstalled)
	before := stored.lastSurfaces(t)
	if len(before) == 0 {
		t.Fatal("the window placed no surface")
	}
	f.run("core.settings.open", nil)
	after := stored.lastSurfaces(t)
	if len(after) != len(before) {
		t.Fatalf("the settings tab changed the surfaces from %d to %d", len(before), len(after))
	}
	for id, surface := range after {
		if surface["visible"] != false {
			t.Fatalf("surface %s stays visible while the settings tab is in front", id)
		}
	}
	f.run("core.settings.close", nil)
	for id, surface := range stored.lastSurfaces(t) {
		if surface["visible"] != true {
			t.Fatalf("surface %s stays hidden after the settings tab closed", id)
		}
	}
}
