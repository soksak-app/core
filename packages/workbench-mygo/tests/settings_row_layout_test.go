package workbench_test

import (
	"math"
	"testing"

	"github.com/egoist/mygo/ui"
)

// The description of a row stands under its label in the label column, which ends where the control column starts, so the text does
// not run under the controls (docs/spec/settings.md#rows).
func TestTheDescriptionOfARowStandsUnderItsLabelInTheLabelColumn(t *testing.T) {
	f := settingsMetricsPage(t, "look")
	nodes := f.tester.ElementTree()
	label, ok := setupRowTextNode(nodes, "통로")
	if !ok {
		t.Fatal("no label 통로")
	}
	description, ok := setupRowTextNode(nodes, "카드 사이 간격. 0이면 카드가 선 하나를 공유한다.")
	if !ok {
		t.Fatalf("no description of gap; the texts are %q", f.tester.Texts())
	}
	controlX := exposedNodeOf(f, "core.settings-tab.choice", "font").Bounds.X
	if math.Abs(float64(description.Bounds.X-label.Bounds.X)) > 0.5 {
		t.Fatalf("the description starts at x %v, the label at %v", description.Bounds.X, label.Bounds.X)
	}
	if right := description.Bounds.X + description.Bounds.W; right > controlX-0.5 {
		t.Fatalf("the description ends at x %v, past the control column that starts at %v", right, controlX)
	}
}

// A control stands at the end of the control column, which is 260 points wide (docs/spec/settings.md#rows): the switch of dim ends where
// the select of font ends.
func TestAControlStandsAtTheEndOfTheControlColumn(t *testing.T) {
	f := settingsMetricsPage(t, "look")
	font := exposedNodeOf(f, "core.settings-tab.choice", "font").Bounds
	dim := exposedNodeOf(f, "core.settings-tab.set", "dim").Bounds
	if math.Abs(float64((dim.X+dim.W)-(font.X+font.W))) > 0.5 {
		t.Fatalf("the switch of dim ends at x %v, the select of font at %v", dim.X+dim.W, font.X+font.W)
	}
}

// A dependent row is indented by space-3 (12 points) at its start (docs/spec/settings.md#rows): the label of memorySaverDelay starts 12
// points right of the label of quietToasts, which is an independent row of the same page.
func TestADependentRowIsIndentedByTwelvePoints(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]any{"page": "behavior"})
	f.tester.SetSize(1200, 3200)
	f.settle()
	nodes := f.tester.ElementTree()
	independent, ok := setupRowTextNode(nodes, "조용히")
	if !ok {
		t.Fatal("no label 조용히")
	}
	dependent, ok := setupRowTextNode(nodes, "숨긴 뒤 내리기까지")
	if !ok {
		t.Fatal("no label 숨긴 뒤 내리기까지")
	}
	if got := dependent.Bounds.X - independent.Bounds.X; math.Abs(float64(got-12)) > 0.5 {
		t.Fatalf("the dependent label starts %v points right of the independent one, want 12", got)
	}
}

// A dependent row whose parent is off takes no press in its control (docs/spec/settings.md#rows): the delay of the memory saver takes
// presses while the saver is on and takes none while it is off.
func TestADependentRowIsDisabledWhileItsParentIsOff(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]any{"page": "behavior"})
	f.tester.SetSize(1200, 3200)
	f.settle()
	// A control that takes no press has no press action in the element tree.
	delayPresses := func() bool {
		t.Helper()
		return exposedNodeOf(f, "core.settings-tab.step", "memorySaverDelay").Actions&ui.ActionPress != 0
	}
	if !delayPresses() {
		t.Fatal("the delay takes no press while the memory saver is on")
	}
	f.run("core.settings.change", map[string]any{"key": "memorySaver", "scope": "common", "value": false})
	f.settle()
	if delayPresses() {
		t.Fatal("the delay takes a press while the memory saver is off")
	}
}

// The label column takes the width that the control column leaves, less the gap of the row (docs/spec/settings.md#rows): the name 통로
// ends one space-2 gap (8 points) before the control column of font.
func TestTheLabelColumnTakesTheWidthThatTheControlColumnLeaves(t *testing.T) {
	f := settingsMetricsPage(t, "look")
	label, ok := setupRowTextNode(f.tester.ElementTree(), "통로")
	if !ok {
		t.Fatal("no label 통로")
	}
	controlX := exposedNodeOf(f, "core.settings-tab.choice", "font").Bounds.X
	if right := label.Bounds.X + label.Bounds.W; math.Abs(float64(right-(controlX-8))) > 0.5 {
		t.Fatalf("the label ends at x %v, want one gap before the control column at %v", right, controlX)
	}
}
