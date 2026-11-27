package workbench_test

import (
	"math"
	"testing"

	"github.com/egoist/mygo/ui"
)

// exposedNodeOf returns the element with the name and the item, found through the element tree of the window. The rows, the control
// areas and the labels of a settings page are not named, so the element tree holds no row box: the metrics of a row are judged from
// the controls only (docs/spec/settings.md#rows).
func exposedNodeOf(f *shellFixture, name, item string) ui.ElementNode {
	f.t.Helper()
	node, ok := exposedNode(f.tester.ElementTree(), name, item)
	if !ok {
		f.t.Fatalf("no element %s %q", name, item)
	}
	return node
}

// settingsMetricsPage opens the page of a settings test with a window tall enough to draw its rows.
func settingsMetricsPage(t *testing.T, section string) *shellFixture {
	t.Helper()
	f := settingsSection(t, section)
	f.tester.SetSize(1200, 3200)
	f.settle()
	return f
}

// The control column of every row has the same end, which is 260 points from the start of its column (docs/spec/settings.md#rows). The
// controls stand at the end of the column, so the select of font, the slider of gap and the switch of dim end at one x: the web grid
// right-aligns the controls of .set-row__control.
func TestTheControlColumnEndsAtOneXInEveryRow(t *testing.T) {
	f := settingsMetricsPage(t, "look")
	font := exposedNodeOf(f, "core.settings-tab.choice", "font").Bounds
	end := font.X + font.W
	// The slider of gap ends with its value text, which is drawn after the track, so the value text is its end.
	value, ok := setupRowTextNode(f.tester.ElementTree(), "12px")
	if !ok {
		t.Fatal("no value text 12px of gap")
	}
	if got := value.Bounds.X + value.Bounds.W; math.Abs(float64(got-end)) > 0.5 {
		t.Fatalf("the value of gap ends at x %v, the select of font at %v", got, end)
	}
	dim := exposedNodeOf(f, "core.settings-tab.set", "dim").Bounds
	if got := dim.X + dim.W; math.Abs(float64(got-end)) > 0.5 {
		t.Fatalf("the switch of dim ends at x %v, the select of font at %v", got, end)
	}
}

// The control column is 260 points wide, and a control that fills it is 260 points wide (docs/spec/settings.md#rows).
func TestAControlThatFillsTheColumnIsTwoHundredSixtyPointsWide(t *testing.T) {
	f := settingsMetricsPage(t, "look")
	if w := exposedNodeOf(f, "core.settings-tab.choice", "font").Bounds.W; math.Abs(float64(w-260)) > 0.5 {
		t.Fatalf("the select of font is %v wide, want the column of 260", w)
	}
}

// A row without a label keeps its control in the control column: the button New set of the sets page ends at the end of the column.
func TestARowWithoutALabelKeepsItsControlInTheControlColumn(t *testing.T) {
	look := settingsMetricsPage(t, "look")
	sets := settingsMetricsPage(t, "sets")
	end := exposedNodeOf(look, "core.settings-tab.choice", "font").Bounds
	button := exposedNodeOf(sets, "core.settings-tab.create", "sets:create").Bounds
	if got := button.X + button.W; math.Abs(float64(got-(end.X+end.W))) > 0.5 {
		t.Fatalf("the button without a label ends at x %v, the control column at %v", got, end.X+end.W)
	}
}

// An input and a select are 28 points high (docs/spec/settings.md#controls).
func TestAnInputAndASelectAreTwentyEightPointsHigh(t *testing.T) {
	f := settingsMetricsPage(t, "look")
	if h := exposedNodeOf(f, "core.settings-tab.choice", "font").Bounds.H; math.Abs(float64(h-28)) > 0.5 {
		t.Fatalf("the select of font is %v high, want 28", h)
	}
}

// A small button (sm) is 24 points high (docs/spec/settings.md#controls). The button Edit of a set is a small button.
func TestASmallButtonIsTwentyFourPointsHigh(t *testing.T) {
	f := settingsMetricsPage(t, "sets")
	if h := exposedNodeOf(f, "core.settings-tab.edit", "edit:set-1").Bounds.H; math.Abs(float64(h-24)) > 0.5 {
		t.Fatalf("the small button 편집 is %v high, want 24", h)
	}
}
