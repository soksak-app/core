package workbench_test

import (
	"image/color"
	"testing"
)

// The active tab of the focused card draws its border in the focus color, the color of the ring of the card, and the active tab of
// another card draws none, so the keyboard, the ring and the tab border show one focus (docs/spec/example-model.md#card-tabs).
func TestTheActiveTabOfTheFocusedCardTakesTheFocusBorder(t *testing.T) {
	f := quadShell(t)
	palette := f.palette()
	focus := color.RGBA{palette.Focus.R, palette.Focus.G, palette.Focus.B, 255}
	left := func(tab string) color.RGBA {
		f.tester.Frame()
		box, ok := exposedAll(f.tester.ElementTree(), "core.card.tab")[tab]
		if !ok {
			t.Fatalf("no drawn tab %s", tab)
		}
		return f.pixelOf(box.X+palette.BorderWidth/2, box.Y+box.H/2)
	}
	for _, step := range []struct{ card, ringed, other string }{{"card-1", "t1", "t2"}, {"card-2", "t2", "t1"}} {
		f.run(t, "core.card.focus", `{"card": "`+step.card+`"}`)
		f.settle()
		if got := left(step.ringed); got != focus {
			t.Fatalf("with %s focused the left edge of its active tab %s is %v, not the focus color %v", step.card, step.ringed, got, focus)
		}
		if got := left(step.other); got == focus {
			t.Fatalf("with %s focused the active tab %s of another card draws the focus color", step.card, step.other)
		}
	}
}
