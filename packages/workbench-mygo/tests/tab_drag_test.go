package workbench_test

import (
	"math"
	"strings"
	"testing"
	"time"
)

// dragRead is the status core.drag.
type dragRead struct {
	Tab    string `json:"tab"`
	Card   string `json:"card"`
	Moved  bool   `json:"moved"`
	Target *struct {
		Card string `json:"card"`
		Zone string `json:"zone"`
	} `json:"target"`
	Preview *struct {
		X float64 `json:"x"`
		Y float64 `json:"y"`
		W float64 `json:"w"`
		H float64 `json:"h"`
	} `json:"preview"`
}

// cardWithTwoTabs returns a project whose first card holds two tabs, with the card, the second tab and the other card.
func cardWithTwoTabs(t *testing.T) (f *shellFixture, card, tab, other string) {
	t.Helper()
	f = projectWithPlugins(t)
	cards := f.tabbedCards()
	card, other = cards[0], cards[1]
	f.click("core.card.add", card)
	f.click("core.picker.item", "acme")
	tabs := f.tabsOf(card)
	return f, card, tabs[1].(map[string]any)["id"].(string), other
}

// dragTab presses the tab, moves the pointer to x and y and returns the status of the drag before the release.
func dragTab(t *testing.T, f *shellFixture, tab string, x, y float32) *dragRead {
	t.Helper()
	box := f.box("core.card.tab", tab)
	from, at := box.X+box.W/2, box.Y+box.H/2
	f.tester.Move(from, at)
	f.tester.Frame()
	f.tester.Press(from, at)
	f.tester.Frame()
	f.tester.Move(x, y)
	f.tester.Frame()
	return status[*dragRead](t, f, "core.drag")
}

func hasTab(f *shellFixture, card, tab string) bool {
	for _, held := range f.tabsOf(card) {
		if held.(map[string]any)["id"] == tab {
			return true
		}
	}
	return false
}

// A drop on the centre of another card moves the tab there, and the status shows the drag and its preview before the release.
func TestDroppingATabOnTheCentreOfACardMovesItThere(t *testing.T) {
	f, card, tab, other := cardWithTwoTabs(t)
	if status[*dragRead](t, f, "core.drag") != nil {
		t.Fatal("the status shows a drag before a press")
	}
	box := f.box("core.card", other)
	x, y := box.X+box.W/2, box.Y+box.H/2
	drag := dragTab(t, f, tab, x, y)
	if drag == nil || drag.Tab != tab || drag.Card != card || !drag.Moved || drag.Target == nil || drag.Target.Card != other || drag.Target.Zone != "centre" {
		t.Fatalf("the drag is %+v", drag)
	}
	plane := status[gridRead](t, f, "core.grid").Plane
	if drag.Preview == nil || math.Abs(drag.Preview.X+plane.X-float64(box.X)) > 0.01 || math.Abs(drag.Preview.Y+plane.Y-float64(box.Y)) > 0.01 {
		t.Fatalf("the preview is %+v over the card %v", drag.Preview, box)
	}
	f.tester.Release(x, y)
	f.settle()
	if status[*dragRead](t, f, "core.drag") != nil {
		t.Fatal("the status shows a drag after the release")
	}
	if hasTab(f, card, tab) || !hasTab(f, other, tab) {
		t.Fatalf("the cards hold %v and %v", f.tabsOf(card), f.tabsOf(other))
	}
}

// A drop on the edge of a card makes a new card for the tab and keeps the card that it left.
func TestDroppingATabOnTheEdgeOfACardMakesACard(t *testing.T) {
	f, card, tab, other := cardWithTwoTabs(t)
	before := len(f.tabbedCards())
	box := f.box("core.card", other)
	x, y := box.X+box.W-4, box.Y+box.H/2
	drag := dragTab(t, f, tab, x, y)
	if drag == nil || drag.Target == nil || drag.Target.Zone != "right" || drag.Preview == nil {
		t.Fatalf("the drag is %+v", drag)
	}
	f.tester.Release(x, y)
	f.settle()
	if got := len(f.tabbedCards()); got != before+1 || hasTab(f, card, tab) {
		t.Fatalf("the plane holds %v with the tabs %v", f.tabbedCards(), f.tabsOf(card))
	}
}

// A card with one tab moves as a whole, so no empty card remains.
func TestDroppingTheOnlyTabMovesTheCard(t *testing.T) {
	f, _, _, other := cardWithTwoTabs(t)
	cards := f.tabbedCards()
	tab := f.tabsOf(other)[0].(map[string]any)["id"].(string)
	target := f.box("core.card", cards[0])
	x, y := target.X+target.W-4, target.Y+target.H/2
	dragTab(t, f, tab, x, y)
	f.tester.Release(x, y)
	f.settle()
	if got := f.tabbedCards(); len(got) != len(cards) || !hasTab(f, other, tab) {
		t.Fatalf("the plane holds %v", got)
	}
	moved, kept := f.box("core.card", other), f.box("core.card", cards[0])
	if moved.Y != kept.Y || moved.X <= kept.X {
		t.Fatalf("the moved card stands at %v beside %v", moved, kept)
	}
}

// A press that does not move selects the tab and keeps the layout and the full screen.
func TestAPressOnATabIsNoDrag(t *testing.T) {
	f, card, tab, _ := cardWithTwoTabs(t)
	first := f.tabsOf(card)[0].(map[string]any)["id"].(string)
	f.run("core.tab.select", map[string]string{"tab": first})
	f.run("core.card.fullscreen", map[string]string{"card": card})
	box := f.box("core.card.tab", tab)
	x, y := box.X+box.W/2, box.Y+box.H/2
	if drag := dragTab(t, f, tab, x+2, y); drag == nil || drag.Moved || drag.Target != nil {
		t.Fatalf("the drag is %+v", drag)
	}
	f.settle() // The press selects the tab through a command that finishes on the queue of the shell.
	if f.activeOf(card) != tab {
		t.Fatalf("the press showed %s", f.activeOf(card))
	}
	f.tester.Release(x+2, y)
	f.settle()
	grid := status[gridRead](t, f, "core.grid")
	if grid.Fullscreen == nil || *grid.Fullscreen != card || !hasTab(f, card, tab) {
		t.Fatalf("the press left the full screen on %v", grid.Fullscreen)
	}
}

// A drag that moved releases the full screen, since the drop zones are the cards of the ordinary layout.
func TestADragReleasesTheFullScreen(t *testing.T) {
	f, card, tab, _ := cardWithTwoTabs(t)
	f.run("core.card.fullscreen", map[string]string{"card": card})
	box := f.box("core.card.tab", tab)
	dragTab(t, f, tab, box.X+box.W/2, box.Y+200)
	if grid := status[gridRead](t, f, "core.grid"); grid.Fullscreen != nil {
		t.Fatalf("the drag left the full screen on %v", *grid.Fullscreen)
	}
	f.tester.Release(box.X+box.W/2, box.Y+200)
	f.settle()
}

// The preview shows over the cards in the focus color of the theme.
func TestThePreviewOfADropIsDrawn(t *testing.T) {
	f, _, tab, other := cardWithTwoTabs(t)
	box := f.box("core.card", other)
	x, y := box.X+box.W/2, box.Y+box.H/2
	f.tester.Frame()
	image := f.tester.Image()
	scale := float32(image.Bounds().Dx()) / 1200
	before := image.RGBAAt(int((box.X+3)*scale), int(y*scale))
	dragTab(t, f, tab, x, y)
	f.tester.Frame()
	image = f.tester.Image()
	if after := image.RGBAAt(int((box.X+3)*scale), int(y*scale)); after == before {
		t.Fatalf("the card shows %v under the preview", after)
	}
	f.tester.Release(x, y)
	f.settle()
}

func TestTheMoveCommandRefusesWhatADropCannotDo(t *testing.T) {
	f, card, tab, other := cardWithTwoTabs(t)
	only := f.tabsOf(other)[0].(map[string]any)["id"].(string)
	for _, refused := range []struct {
		params map[string]string
		text   string
	}{
		{map[string]string{"tab": tab, "card": other, "zone": "middle"}, "unknown zone middle"},
		{map[string]string{"tab": tab, "card": "absent", "zone": "centre"}, "no card absent"},
		{map[string]string{"tab": "absent", "card": other, "zone": "centre"}, "absent"},
		{map[string]string{"tab": only, "card": other, "zone": "left"}, "cannot move to the left of " + other},
	} {
		if _, err := f.answer("core.tab.move", refused.params); err == nil || !strings.Contains(err.Error(), refused.text) {
			t.Fatalf("%v answered %v", refused.params, err)
		}
	}
	if _, err := f.answer("core.tab.move", map[string]string{"tab": tab, "card": other, "zone": "centre"}); err != nil {
		t.Fatal(err)
	}
	if !hasTab(f, other, tab) || hasTab(f, card, tab) {
		t.Fatal("the command did not move the tab")
	}
}

// The strip holds still under a press, so the tab stays under the pointer, and centres the tab after the release.
func TestTheStripWaitsForTheReleaseOfAPress(t *testing.T) {
	f := narrowCard(t, 8, strings.Repeat("long-title-", 3))
	tab := "tab-000001"
	box := f.box("core.card.tab", tab)
	x, y := box.X+box.W/2, box.Y+box.H/2
	f.tester.Move(x, y)
	f.tester.Frame()
	f.tester.Press(x, y)
	f.tester.Advance(2 * time.Second)
	f.tester.Frame()
	if held := f.box("core.card.tab", tab); held.X != box.X {
		t.Fatalf("under the press the tab moved from %v to %v", box.X, held.X)
	}
	f.tester.Release(x, y)
	f.tester.Advance(2 * time.Second)
	f.tester.Frame()
	if landed := f.box("core.card.tab", tab); landed.X == box.X {
		t.Fatalf("after the release the tab stays at %v", landed.X)
	}
}
