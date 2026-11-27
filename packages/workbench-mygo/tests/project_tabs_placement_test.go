package workbench_test

import (
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// statusBarHeight is the chrome metric statusbar-h, the height of the status bar at the bottom of the window.
func statusBarHeight(t *testing.T) float32 {
	t.Helper()
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	height, ok := declared.Metric("statusbar-h")
	if !ok {
		t.Fatal("the chrome metric statusbar-h is not declared")
	}
	return float32(height)
}

// The right column holds the project tabs beside the work area, at the right edge of the window, from under the chrome row to the status bar
// (docs/spec/settings.md#values, projectTabs = right).
func TestTheRightColumnHoldsTheProjectTabsAfterTheWorkArea(t *testing.T) {
	f, first, second := twoProjects(t)
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"projectTabs": "right"}})
	f.settle()
	card := f.box("core.card", f.cardsOf()[0]["card"].(string))
	column := f.box("core.projects.column", "")
	if column.X < card.X+card.W {
		t.Fatalf("the column %+v stands over the work area at %+v", column, card)
	}
	if want := fixtureHeight - statusBarHeight(t); column.Y+column.H != want {
		t.Fatalf("the column ends at %v, not at the status bar %v", column.Y+column.H, want)
	}
	for _, id := range []string{first, second} {
		tab := f.box("core.project-tab", id)
		if tab.X < column.X || tab.X+tab.W > column.X+column.W || tab.H != 36 {
			t.Fatalf("the tab %s is at %+v in the column %+v", id, tab, column)
		}
	}
}

// The bottom row holds the project tabs in one line under the work area, across the window, above the status bar
// (docs/spec/settings.md#values, projectTabs = bottom).
func TestTheBottomRowHoldsTheProjectTabsUnderTheWorkArea(t *testing.T) {
	f, first, second := twoProjects(t)
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"projectTabs": "bottom"}})
	f.settle()
	card := f.box("core.card", f.cardsOf()[0]["card"].(string))
	if f.has("core.projects.column", "") {
		t.Fatal("a column in the bottom mode")
	}
	a, b := f.box("core.project-tab", first), f.box("core.project-tab", second)
	if a.Y != b.Y || a.Y < card.Y+card.H {
		t.Fatalf("the tabs are at %+v and %+v, want one line under the work area that ends at %v", a, b, card.Y+card.H)
	}
	if a.Y+a.H > fixtureHeight-statusBarHeight(t) {
		t.Fatalf("the tab %+v stands under the status bar", a)
	}
	if b.X <= a.X {
		t.Fatalf("the tabs %+v and %+v are not in the order of the projects", a, b)
	}
}
