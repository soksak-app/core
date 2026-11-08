package workbench_test

import (
	"image/color"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// pixelOf reads the color at a point of the window of the fixture.
func (f *shellFixture) pixelOf(x, y float32) color.RGBA {
	f.t.Helper()
	image := f.tester.Image()
	scale := float32(image.Bounds().Dx()) / f.tester.ElementTree()[0].Bounds.W
	return image.RGBAAt(int(x*scale), int(y*scale))
}

func (f *shellFixture) palette() workbench.Palette {
	f.t.Helper()
	declared, err := workbench.ReadDeclarations()
	if err != nil {
		f.t.Fatal(err)
	}
	palette, err := declared.DefaultPalette()
	if err != nil {
		f.t.Fatal(err)
	}
	return palette
}

func opaque(c ui.Color) color.RGBA { return color.RGBA{c.R, c.G, c.B, 255} }

func over(base color.RGBA, c ui.Color, share float32) color.RGBA {
	mix := func(from, to uint8) uint8 { return uint8(float32(from)*(1-share) + float32(to)*share + 0.5) }
	return color.RGBA{mix(base.R, c.R), mix(base.G, c.G), mix(base.B, c.B), 255}
}

// A divider shows a bar of the grip length and thickness at its center, in the muted color, and in the focus color under the pointer
// and while it is dragged.
func TestADividerShowsAGripAtItsCenter(t *testing.T) {
	f, left, right := splitShell(t)
	f.tester.Frame()
	box, _ := f.divider(left, right)
	x, y := box.X+box.W/2, box.Y+box.H/2
	palette := f.palette()
	base := f.pixelOf(x, y-20)
	if want := over(base, palette.Muted, 0.7); !near(f.pixelOf(x, y), want) {
		t.Fatalf("the center of the divider is %v, want %v over %v", f.pixelOf(x, y), want, base)
	}
	for name, at := range map[string]float32{"above": -11, "below": 11} {
		if near(f.pixelOf(x, y+at), base) {
			t.Fatalf("the grip does not reach %s the center: %v", name, f.pixelOf(x, y+at))
		}
	}
	for name, at := range map[string]float32{"above": -13, "below": 13} {
		if !near(f.pixelOf(x, y+at), base) {
			t.Fatalf("the grip goes past 12 points %s the center: %v", name, f.pixelOf(x, y+at))
		}
	}
	if !near(f.pixelOf(x-3, y), f.pixelOf(x-3, y-20)) {
		t.Fatalf("the grip is wider than its thickness: %v", f.pixelOf(x-3, y))
	}
	f.tester.Move(x, y)
	f.tester.Advance(300 * time.Millisecond)
	f.tester.Frame()
	if got, want := f.pixelOf(x, y), opaque(palette.Focus); !near(got, want) {
		t.Fatalf("the grip under the pointer is %v, want %v", got, want)
	}
	f.tester.Press(x, y)
	f.tester.Frame()
	f.tester.Move(x-40, y+200)
	f.tester.Advance(300 * time.Millisecond)
	f.tester.Frame()
	if got, want := f.pixelOf(x-40, y), opaque(palette.Focus); !near(got, want) {
		t.Fatalf("the grip of a held divider away from the pointer is %v, want %v", got, want)
	}
	f.tester.Release(x-40, y+200)
	f.settle()
}

// A boundary is a line at its coordinate. Where a card crosses it, it follows the fullRule setting.
func TestABoundaryDrawsItsLine(t *testing.T) {
	f, left, right := splitShell(t)
	made, err := f.answer("core.card.split", map[string]string{"card": left, "side": "bottom", "plugin": "textprobe"})
	if err != nil {
		t.Fatal(err)
	}
	f.settle()
	palette := f.palette()
	upper, lower, beside := f.box("core.card", left), f.box("core.card", made["card"].(string)), f.box("core.card", right)

	// The stretch where the cards end against the line, away from the grip.
	lineX := (upper.X + upper.W + beside.X) / 2
	if got, want := f.pixelOf(lineX, upper.Y+8), opaque(palette.Rule); !near(got, want) {
		t.Fatalf("the solid line is %v, want %v", got, want)
	}

	// The rest of the horizontal line, which the right card crosses, in the margin of the plane beyond that card.
	lineY := (upper.Y + upper.H + lower.Y) / 2
	margin, inside := beside.X+beside.W+2, beside.X+beside.W/2
	bare := f.pixelOf(margin, lineY-20)
	card := f.pixelOf(inside, lineY-20)
	if got, want := f.pixelOf(margin, lineY), over(bare, palette.Rule, 0.45); !near(got, want) {
		t.Fatalf("the crossed line reaches the edge of the stage as %v, want %v", got, want)
	}
	if got := f.pixelOf(inside, lineY); !near(got, card) {
		t.Fatalf("the card shows the line that it covers: %v, the card is %v", got, card)
	}

	f.run("core.settings.set", map[string]any{"patch": map[string]any{"fullRule": "over"}})
	f.settle()
	if got, want := f.pixelOf(inside, lineY), over(card, palette.Rule, 0.45); !near(got, want) {
		t.Fatalf("the line over the card is %v, want %v", got, want)
	}

	f.run("core.settings.set", map[string]any{"patch": map[string]any{"fullRule": "none"}})
	f.settle()
	if got := f.pixelOf(margin, lineY); !near(got, bare) {
		t.Fatalf("the crossed line that is not drawn shows as %v, the margin is %v", got, bare)
	}
	if got, want := f.pixelOf(lineX, upper.Y+8), opaque(palette.Rule); !near(got, want) {
		t.Fatalf("the setting took the solid line: %v, want %v", got, want)
	}
}

// The keys drive a focused divider, and a press on a divider leaves the focus where it is.
func TestADividerTakesTheKeys(t *testing.T) {
	f, left, right := splitShell(t)
	box, _ := f.divider(left, right)
	x, y := box.X+box.W/2, box.Y+box.H/2
	f.tester.ClickAt(x, y)
	f.settle()
	from := f.box("core.card", left).W
	f.tester.Key(0, ui.KeyRight)
	f.settle()
	if now := f.box("core.card", left).W; now != from {
		t.Fatalf("a press took the focus to the divider: the card went from %v to %v", from, now)
	}
	focused := false
	for range 80 {
		f.tester.Key(0, ui.KeyTab)
		f.settle()
		f.tester.Key(0, ui.KeyRight)
		f.settle()
		now := f.box("core.card", left).W
		if now == from+8 {
			focused = true
			break
		}
		// The stop on the boundary at the other side of the card, which the arrow moves into the card.
		if now == from-8 {
			f.tester.Key(0, ui.KeyLeft)
			f.settle()
			continue
		}
		if now != from {
			t.Fatalf("an arrow moved the boundary from %v to %v", from, now)
		}
	}
	if !focused {
		t.Fatal("no tab stop moves the boundary with an arrow")
	}
	f.tester.Key(0, ui.KeyLeft)
	f.settle()
	if now := f.box("core.card", left).W; now != from {
		t.Fatalf("the left arrow left the card at %v, it was %v", now, from)
	}
	f.tester.Key(0, ui.KeyRight)
	f.tester.Key(0, ui.KeyRight)
	f.settle()
	stored := cardRowsStored(t, f)
	f.tester.Key(0, ui.KeyEnter)
	f.settle()
	if stored == cardRowsStored(t, f) {
		t.Fatal("enter stored no centered boundary")
	}
	a, b := f.box("core.card", left), f.box("core.card", right)
	if diff := a.W - b.W; diff > 1 || diff < -1 {
		t.Fatalf("enter did not center the boundary: %v and %v", a.W, b.W)
	}
}

// The boundary of a window sidebar is a divider like any other: a drag sizes the sidebar, and the sidebar keeps that width.
func TestADragSizesAWindowSidebar(t *testing.T) {
	f := sidebarShell(t)
	card := f.tabbedCards()[0]
	for _, side := range []struct {
		name          string
		first, second string
		move          float32
	}{{"left", "left", card, 40}, {"right", card, "right", -40}} {
		box, _ := f.divider(side.first, side.second)
		x, y := box.X+box.W/2, box.Y+box.H/2
		before := f.box("core.card", side.name)
		stored := cardRowsStored(t, f)
		f.tester.Move(x, y)
		f.tester.Frame()
		f.tester.Press(x, y)
		f.tester.Frame()
		f.tester.Move(x+side.move, y)
		f.tester.Frame()
		f.tester.Release(x+side.move, y)
		f.settle()
		if now := f.box("core.card", side.name); now.W != before.W+40 {
			t.Fatalf("after the drag the %s sidebar is %v wide, it was %v", side.name, now.W, before.W)
		}
		if stored == cardRowsStored(t, f) {
			t.Fatalf("the drag of the %s sidebar stored nothing", side.name)
		}
		f.run("core.settings.set", map[string]any{"patch": map[string]any{side.name: false}})
		f.settle()
		f.run("core.settings.set", map[string]any{"patch": map[string]any{side.name: true}})
		f.settle()
		if now := f.box("core.card", side.name); now.W != before.W+40 {
			t.Fatalf("the %s sidebar came back %v wide, it was dragged to %v", side.name, now.W, before.W+40)
		}
	}
}

// A folded side shows three dots at the center of its grip.
func TestAFoldedSideShowsThreeDots(t *testing.T) {
	f, card := cardSidebar(t, "left")
	item := card + ":left"
	f.run("core.card.sidebar.toggle", map[string]string{"card": card, "side": "left"})
	f.settle()
	grip := f.box("core.card.sidebar.grip", item)
	x, y := grip.X+grip.W/2, grip.Y+grip.H/2
	palette := f.palette()
	base := f.pixelOf(x, y+3)
	want := over(base, palette.Muted, 0.7)
	for _, at := range []float32{-6, 0, 6} {
		if got := f.pixelOf(x, y+at); !near(got, want) {
			t.Fatalf("the dot %v from the center is %v, want %v", at, got, want)
		}
	}
	if got := f.pixelOf(x, y+12); !near(got, base) {
		t.Fatalf("a fourth dot: %v", got)
	}
	f.tester.Move(x, y)
	f.tester.Advance(300 * time.Millisecond)
	f.tester.Frame()
	if got, want := f.pixelOf(x, y), opaque(palette.Focus); !near(got, want) {
		t.Fatalf("the dot under the pointer is %v, want %v", got, want)
	}
}

// A line of the rule color stands around the stage, and the plane starts inside it.
func TestAStageHasALineAround(t *testing.T) {
	f, left, _ := splitShell(t)
	f.settle()
	palette := f.palette()
	card := f.box("core.card", left)
	root := f.tester.ElementTree()[0].Bounds
	y := card.Y + card.H/2
	if got, want := f.pixelOf(0.5, y), opaque(palette.Rule); !near(got, want) {
		t.Fatalf("the left edge of the stage is %v, want %v", got, want)
	}
	if got, want := f.pixelOf(root.W-0.5, y), opaque(palette.Rule); !near(got, want) {
		t.Fatalf("the right edge of the stage is %v, want %v", got, want)
	}
	bottom := card.Y + card.H + palette.Gap + palette.BorderWidth - 0.5
	if got, want := f.pixelOf(card.X+card.W/2, bottom), opaque(palette.Rule); !near(got, want) {
		t.Fatalf("the bottom edge of the stage at %v of %v is %v, want %v", bottom, root.H, got, want)
	}
	if got := f.pixelOf(palette.BorderWidth+1, y); near(got, opaque(palette.Rule)) {
		t.Fatalf("the line is wider than the border: %v", got)
	}
}
