package workbench_test

import (
	"encoding/json"
	"math"
	"testing"
)

// A row label is one line that ends with an ellipsis, as .set-row__name is (docs/spec/settings.md#rows): in a narrow pane the label of
// the memory saver delay keeps one line, which is 14 points high, and a wrapped label would be about 28 points high.
func TestALongRowLabelStaysOnOneLineWithAnEllipsis(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]any{"page": "behavior"})
	f.tester.SetSize(460, 3200)
	f.settle()
	label, ok := setupRowTextNode(f.tester.ElementTree(), "오류·경고 자동 닫힘")
	if !ok {
		t.Fatal("no label 오류·경고 자동 닫힘")
	}
	if label.Bounds.H >= 20 {
		t.Fatalf("the label is %v high in a narrow pane, want one line", label.Bounds.H)
	}
}

// The switch of a side follows its set select after a gap of space-2 (8 points), as the grid of .set-side (docs/spec/settings.md#작업-공간).
func TestTheSideSwitchFollowsItsSelectAfterASpaceTwoGap(t *testing.T) {
	f := settingsMetricsPage(t, "workspace")
	for _, side := range []string{"left", "right", "top", "bottom"} {
		link := exposedNodeOf(f, "core.settings-tab.link", "link:"+side+":").Bounds
		sw := exposedNodeOf(f, "core.settings-tab.side", side).Bounds
		if got := sw.X - (link.X + link.W); math.Abs(float64(got-8)) > 0.5 {
			t.Fatalf("the switch of %s starts %v points after its select, want 8", side, got)
		}
	}
}

// Every set select of the sides has one width, because each lists the same options and is sized to its widest (docs/spec/settings.md#작업-공간).
func TestTheSideSelectsHaveOneWidth(t *testing.T) {
	f := settingsMetricsPage(t, "workspace")
	first := exposedNodeOf(f, "core.settings-tab.link", "link:left:").Bounds.W
	for _, side := range []string{"right", "top", "bottom"} {
		if got := exposedNodeOf(f, "core.settings-tab.link", "link:"+side+":").Bounds.W; math.Abs(float64(got-first)) > 0.5 {
			t.Fatalf("the select of %s is %v wide, the select of left %v", side, got, first)
		}
	}
}

// The buttons of an account are 4 points apart, the gap of .set-account__buttons (space-1) (docs/spec/settings.md#설치됨).
func TestTheAccountButtonsAreFourPointsApart(t *testing.T) {
	host := &accountsHost{runs: []accountAnswer{{stdout: loggedIn}, {code: 1, stderr: "codex: command not found\n"}, {stdout: "not json"}, {stdout: loggedOut}}}
	f := accountsShell(t, host, []map[string]any{{"id": "account-1", "name": "업무", "kind": "claude"}, {"id": "account-2", "name": "개인", "kind": "codex"}})
	f.click("core.chrome.settings", "")
	f.run("core.settings-tab.nav", map[string]any{"page": "installed"})
	f.shell.Registry().RunLater("core.settings-tab.plugin", json.RawMessage(`{"plugin":"agents"}`), func(any, error) {})
	_ = f.shownRecords()
	f.settle()
	f.tester.SetSize(1200, 3200)
	f.settle()
	logout := exposedNodeOf(f, "core.settings-tab.account-logout", "account-logout:account-1").Bounds
	edit := exposedNodeOf(f, "core.settings-tab.account-edit", "account-edit:account-1").Bounds
	if got := edit.X - (logout.X + logout.W); math.Abs(float64(got-4)) > 0.5 {
		t.Fatalf("the button 이름 변경 starts %v points after 로그아웃, want 4", got)
	}
}

// The action of the core update row stands below its caption, because the row is a column (docs/spec/settings.md#설치됨): the button
// 업데이트 starts below the caption line.
func TestTheCoreUpdateButtonStandsBelowItsCaption(t *testing.T) {
	f, _ := updateShell(t, appRelease)
	f.run("core.settings.open", nil)
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	f.tester.SetSize(1200, 3200)
	f.settle()
	nodes := f.tester.ElementTree()
	caption, ok := setupRowTextNode(nodes, "core: 1.0.0 → 2.0.0")
	if !ok {
		t.Fatal("no caption of the core row")
	}
	update, ok := exposedNode(nodes, "core.settings-tab.plugins.app-update", "")
	if !ok {
		t.Fatal("no button 업데이트 of the core row")
	}
	if update.Bounds.Y < caption.Bounds.Y+caption.Bounds.H-0.5 {
		t.Fatalf("the button 업데이트 is at y %v, above the bottom of its caption at %v", update.Bounds.Y, caption.Bounds.Y+caption.Bounds.H)
	}
}

// The search field of the settings menu stands at the top of the menu and fills its width, as the web field .set-find does
// (docs/spec/settings.md#menu).
func TestTheSettingsSearchFillsTheMenuWidth(t *testing.T) {
	f := opened(t)
	f.tester.SetSize(1200, 3200)
	f.settle()
	nodes := f.tester.ElementTree()
	field, ok := exposedNode(nodes, "core.settings-tab.find", "")
	if !ok {
		t.Fatal("no search field of the settings menu")
	}
	nav := exposedNodeOf(f, "core.settings-tab.nav", "nav:look").Bounds
	if math.Abs(float64(field.Bounds.W-nav.W)) > 0.5 || math.Abs(float64(field.Bounds.X-nav.X)) > 0.5 {
		t.Fatalf("the search field is at x %v wide %v, the first menu item at x %v wide %v", field.Bounds.X, field.Bounds.W, nav.X, nav.W)
	}
	if field.Bounds.Y >= nav.Y {
		t.Fatalf("the search field is at y %v, below the first menu item at %v", field.Bounds.Y, nav.Y)
	}
}

// Two adjacent theme swatches are one theme-grid-gap (8 points) apart, as the grid .th-grid (docs/spec/settings.md#pages).
func TestTheThemeSwatchesAreOneGridGapApart(t *testing.T) {
	f := settingsMetricsPage(t, "look")
	first := exposedNodeOf(f, "core.settings-tab.theme", "theme:midnight").Bounds
	second := exposedNodeOf(f, "core.settings-tab.theme", "theme:nord").Bounds
	if math.Abs(float64(first.Y-second.Y)) > 0.5 {
		t.Fatalf("the swatches midnight and nord are not in one row: y %v and %v", first.Y, second.Y)
	}
	if got := second.X - (first.X + first.W); math.Abs(float64(got-8)) > 0.5 {
		t.Fatalf("the swatches are %v points apart, want 8", got)
	}
}
