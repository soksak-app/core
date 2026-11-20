package workbench_test

import (
	"fmt"
	"testing"
)

// gridGap is the gap of the plane that core.grid reports.
func (f *shellFixture) gridGap(t *testing.T) float64 {
	t.Helper()
	return status[struct {
		Gap float64 `json:"gap"`
	}](t, f, "core.grid").Gap
}

// The gap setting is the full distance between two adjacent cards, and a change reaches the plane of the shown space at once (the
// values of docs/spec/settings.md#values).
func TestGapChangeSetsPlaneGap(t *testing.T) {
	f, left, right := splitShell(t)
	f.settle()
	for _, gap := range []float64{20, 7} {
		f.run("core.settings.change", map[string]any{"key": "gap", "value": gap, "scope": "common"})
		f.settle()
		a, b := f.box("core.card", left), f.box("core.card", right)
		if got, between := f.gridGap(t), float64(b.X-(a.X+a.W)); got != gap || between != gap {
			t.Fatalf("after the gap %v the plane gap is %v and the cards stand %v apart", gap, got, between)
		}
	}
}

// At gap 0 the two cards share one line, as the seam of the page (data-seam=line of packages/workbench/app.css): the plane gap is
// the border width, and a card draws no border and no radius of its own.
func TestGapZeroCardsShareOneLine(t *testing.T) {
	f, left, _ := splitShell(t)
	f.run("core.settings.change", map[string]any{"key": "gap", "value": 0, "scope": "common"})
	f.settle()
	palette := f.palette()
	if got := f.gridGap(t); got != float64(palette.BorderWidth) {
		t.Fatalf("at gap 0 the plane gap is %v, want the border width %v", got, palette.BorderWidth)
	}
	card := f.box("core.card", left)
	// The first column of the card is its content where a border would stand, and its corner is the content where a radius would
	// show the stage.
	middle := card.Y + card.H/2
	edge, inside := f.pixelOf(card.X+0.25, middle), f.pixelOf(card.X+4, middle)
	corner, top := f.pixelOf(card.X+0.25, card.Y+0.25), f.pixelOf(card.X+card.W/2, card.Y+0.25)
	if edge != inside || corner != top {
		t.Fatalf("at gap 0 the card draws a border or a radius: edge %v inside %v, corner %v top %v", edge, inside, corner, top)
	}
}

// A drag of a settings slider shows each value and writes the setting once, at its release, as the page reports a range only on
// change (the controls of docs/spec/settings.md#controls).
func TestSliderDragWritesOnce(t *testing.T) {
	f := opened(t)
	f.tester.SetSize(1200, 3200)
	f.settle()
	slider, ok := exposedNode(f.tester.ElementTree(), "core.settings-modal.set", "gap")
	if !ok {
		t.Fatal("no slider of the gap")
	}
	before := len(f.host.settings)
	y := slider.Bounds.Y + slider.Bounds.H/2
	x := slider.Bounds.X + slider.Bounds.W/4
	f.tester.Move(x, y)
	f.tester.Frame()
	f.tester.Press(x, y)
	f.tester.Frame()
	for step := range 5 {
		x += slider.Bounds.W / 10
		f.tester.Move(x, y)
		f.tester.Frame()
		f.pending.drain(t)
		if step == 4 {
			if writes := len(f.host.settings) - before; writes != 0 {
				t.Fatalf("the drag wrote the settings %d times before its release", writes)
			}
		}
	}
	f.tester.Release(x, y)
	f.settle()
	writes := f.host.settings[before:]
	if len(writes) != 1 {
		t.Fatalf("the drag wrote the settings %d times: %v", len(writes), writes)
	}
	gap := f.settingValues()["gap"].(float64)
	if got := writes[0]["patch"].(map[string]any)["gap"]; fmt.Sprint(got) != fmt.Sprint(gap) || gap == 12 {
		t.Fatalf("the drag wrote %v and the setting is %v", got, gap)
	}
}
