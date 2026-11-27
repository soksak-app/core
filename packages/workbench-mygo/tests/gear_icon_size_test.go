package workbench_test

import (
	"testing"
)

// The gear of the notice center is the icon switch of the title bar gear, so both are drawn at one size
// (docs/spec/notifications.md#notice-center).
func TestTheNoticeCenterGearHasTheSizeOfTheTitleBarGear(t *testing.T) {
	f := noticeShell(t, nil)
	if err := f.finish("core.notices.toggle", nil); err != nil {
		t.Fatalf("core.notices.toggle answered %v", err)
	}
	f.settle()
	tree := f.tester.ElementTree()
	bar, ok := exposedNode(tree, "core.chrome.settings", "")
	if !ok {
		t.Fatal("the title bar has no gear")
	}
	center, ok := exposedNode(tree, "core.notices.settings", "")
	if !ok {
		t.Fatal("the notice center has no gear")
	}
	if center.Bounds.W != bar.Bounds.W || center.Bounds.H != bar.Bounds.H {
		t.Fatalf("the notice center gear is %.1f×%.1f and the title bar gear %.1f×%.1f, want one size", center.Bounds.W, center.Bounds.H, bar.Bounds.W, bar.Bounds.H)
	}
}

// The settings tab chip names the tab 설정 beside the settings icon, not beside a gear character of the text
// (docs/spec/settings.md#opening-and-closing).
func TestTheSettingsChipDrawsTheGearAsTheSettingsIcon(t *testing.T) {
	f := noticeShell(t, nil)
	if err := f.finish("core.settings.open", nil); err != nil {
		t.Fatalf("core.settings.open answered %v", err)
	}
	f.settle()
	if f.tester.HasText("⚙ 설정") {
		t.Fatal("the chip draws the gear as a character of its text")
	}
	if !f.tester.HasText("설정") {
		t.Fatalf("the chip does not name the tab 설정: %q", f.tester.Texts())
	}
}
