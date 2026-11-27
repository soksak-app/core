// The head of each window sidebar shows its placement number, and the edge of a hidden side with a choice shows its + <side> button
// (docs/spec/external-sidebars.md#sidebar-head-and-edge).
package workbench_test

import (
	"slices"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// headRow is the height of the head row of a window sidebar, the chrome metric foot-h that the row takes above the set.
func headRow(t *testing.T) float32 {
	t.Helper()
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	foot, ok := declared.Metric("foot-h")
	if !ok {
		t.Fatal("the chrome metric foot-h is not declared")
	}
	return float32(foot)
}

// The head of each drawn window sidebar shows the position of its side in sidebarOrder, counted from 1.
func TestTheHeadOfAWindowSidebarShowsItsPlacementNumber(t *testing.T) {
	f, _ := surfaceShellOf(t, sidebarsInstalled)
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"sidebarOrder": []string{"right", "bottom", "left", "top"}}, "scope": "common"})
	if text := element(t, f.tester, "core.sidebar.head", "left").Text; text != "3" {
		t.Fatalf("the head of the left sidebar shows %q, want its place 3", text)
	}
	if text := element(t, f.tester, "core.sidebar.head", "right").Text; text != "1" {
		t.Fatalf("the head of the right sidebar shows %q, want its place 1", text)
	}
}

// The × of the head shows while the pointer is over its sidebar, and it turns the sidebar off.
func TestTheFoldOfTheHeadShowsOverItsSidebarAndTurnsItOff(t *testing.T) {
	f, _ := surfaceShellOf(t, sidebarsInstalled)
	left, right := f.box("core.card", "left"), f.box("core.card", "right")
	if f.has("core.sidebar.fold", "left") {
		t.Fatal("the fold of the left sidebar shows while the pointer is elsewhere")
	}
	f.tester.Move(left.X+left.W/2, left.Y+left.H/2)
	f.settle()
	if !f.has("core.sidebar.fold", "left") {
		t.Fatal("the fold of the left sidebar does not show while the pointer is over it")
	}
	f.tester.Move(right.X+right.W/2, right.Y+right.H/2)
	f.settle()
	if f.has("core.sidebar.fold", "left") {
		t.Fatal("the fold of the left sidebar stays while the pointer is over another sidebar")
	}
	f.tester.Move(left.X+left.W/2, left.Y+left.H/2)
	f.settle()
	f.click("core.sidebar.fold", "left")
	if f.has("core.card", "left") {
		t.Fatal("the left sidebar still stands after its fold")
	}
	if !f.has("core.card", "right") {
		t.Fatal("the right sidebar went with the left one")
	}
}

// A hidden side that has a choice shows its + <side> button while the pointer is over its edge, and the button shows the side.
func TestAHiddenSideWithAChoiceShowsItsEdgeButtonOverItsEdge(t *testing.T) {
	f, _ := surfaceShellOf(t, sidebarsInstalled)
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"left": false}, "scope": "common"})
	if f.has("core.sidebar.edge", "left") {
		t.Fatal("the edge of the left side shows while the pointer is elsewhere")
	}
	f.tester.Move(4, 400)
	f.settle()
	if text := element(t, f.tester, "core.sidebar.edge", "left").Text; text != "+ 왼쪽" {
		t.Fatalf("the edge button of the left side says %q", text)
	}
	if f.has("core.sidebar.edge", "right") || f.has("core.sidebar.edge", "top") {
		t.Fatal("an edge shows for a shown side or for a side without a choice")
	}
	f.click("core.sidebar.edge", "left")
	if !f.has("core.card", "left") {
		t.Fatal("the left sidebar does not stand after its edge button")
	}
	if f.has("core.sidebar.edge", "left") {
		t.Fatal("the edge of a shown side still shows")
	}
}

// The head is the top row of a window sidebar: it stands above the set, and it shows the name of the set and the layout badge 탭 or
// 목록 beside its place (docs/spec/external-sidebars.md#sidebar-head-and-edge).
func TestTheHeadOfAWindowSidebarStandsAtItsTopWithTheSetNameAndBadge(t *testing.T) {
	f, _ := surfaceShellOf(t, sidebarsInstalled)
	card, head := f.box("core.card", "left"), f.box("core.sidebar.head", "left")
	top := card.Y + cardBorder
	if head.Y < top || head.Y+head.H > top+headRow(t) {
		t.Fatalf("the head of the left sidebar is at y %v to %v, want inside the top row from y %v of %v", head.Y, head.Y+head.H, top, headRow(t))
	}
	texts := f.tester.Texts()
	if !slices.Contains(texts, "탐색기") {
		t.Fatalf("the head shows no set name 파일: %q", texts)
	}
	if !slices.Contains(texts, "목록") {
		t.Fatalf("the head shows no list badge 목록: %q", texts)
	}
}
