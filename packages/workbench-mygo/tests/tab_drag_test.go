package workbench_test

import (
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// dragRead is the status core.drag.
type dragRead struct {
	Tab    string `json:"tab"`
	Card   string `json:"card"`
	Moved  bool   `json:"moved"`
	Target *struct {
		Card  layout.Target `json:"card"`
		Zone  string        `json:"zone"`
		Index *int          `json:"index"`
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
	if drag == nil || drag.Tab != tab || drag.Card != card || !drag.Moved || drag.Target == nil || strings.Join(drag.Target.Card, " ") != other || drag.Target.Zone != "centre" {
		t.Fatalf("the drag is %+v", drag)
	}
	plane := status[gridRead](t, f, "core.grid").Plane
	if drag.Preview == nil || math.Abs(drag.Preview.X+plane.X-float64(box.X)) > 0.01 || math.Abs(drag.Preview.Y+plane.Y-float64(box.Y)) > 0.01 {
		t.Fatalf("the preview is %+v over the card %v", drag.Preview, box)
	}
	if !f.has("core.drop", "") {
		t.Fatal("the preview has no element name")
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
	// The point lies in the outer quarter of the body, outside the bands of the line, which are targets of the nodes on it
	// (docs/spec/groups.md#target-search).
	box := f.box("core.card", other)
	x, y := box.X+box.W*0.9, box.Y+box.H/2
	drag := dragTab(t, f, tab, x, y)
	if drag == nil || drag.Target == nil || strings.Join(drag.Target.Card, " ") != other || drag.Target.Zone != "right" || drag.Preview == nil {
		t.Fatalf("the drag is %+v", drag)
	}
	f.tester.Release(x, y)
	f.settle()
	if got := len(f.tabbedCards()); got != before+1 || hasTab(f, card, tab) {
		t.Fatalf("the plane holds %v with the tabs %v", f.tabbedCards(), f.tabsOf(card))
	}
}

// A drag that enters the left line on the band of one card and stays on that band into the band of the card below it selects the run of
// both, and the release adds the new card beside the run (docs/spec/groups.md#target-search).
func TestADragAlongALineSelectsTheRunFromItsAnchor(t *testing.T) {
	f, card, tab, other := cardWithTwoTabs(t)
	first, second := f.box("core.card", card), f.box("core.card", other)
	if first.X != second.X || second.Y <= first.Y {
		t.Fatalf("the cards stand at %v and %v, not one above the other", first, second)
	}
	drag := dragTab(t, f, tab, first.X+8, first.Y+first.H/2)
	if drag == nil || drag.Target == nil || strings.Join(drag.Target.Card, " ") != card || drag.Target.Zone != "left" {
		t.Fatalf("the drag at the anchor is %+v", drag)
	}
	x, y := second.X+8, second.Y+second.H/2
	f.tester.Move(x, y)
	f.tester.Frame()
	drag = status[*dragRead](t, f, "core.drag")
	if drag == nil || drag.Target == nil || strings.Join(drag.Target.Card, " ") != card+" "+other || drag.Target.Zone != "left" {
		t.Fatalf("the drag along the line is %+v with the target %+v", drag, drag.Target)
	}
	f.tester.Release(x, y)
	f.settle()
	cards := f.tabbedCards()
	if len(cards) != 3 {
		t.Fatalf("the plane holds %v", cards)
	}
	added := ""
	for _, id := range cards {
		if id != card && id != other {
			added = id
		}
	}
	box, top, bottom := f.box("core.card", added), f.box("core.card", card), f.box("core.card", other)
	if box.X >= top.X || box.Y != top.Y || math.Abs(float64(box.Y+box.H-(bottom.Y+bottom.H))) > 0.01 {
		t.Fatalf("the new card stands at %v beside %v and %v", box, top, bottom)
	}
}

// The width of the bands is the chrome metric drop-band of workbench.json, the one source of both workbenches
// (docs/spec/settings.md#layout-values): with bands of 40 points, a point 20 points inside the left line of a card lies on the outer
// band, the content of the plane, where bands of 5 points leave it in the outer quarter of the card.
func TestTheBandsHaveTheDeclaredWidth(t *testing.T) {
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	f := startedShellOf(t, acme(), declared.WithChrome("drop-band", "40px"))
	f.settle()
	f.run("core.home.form.open", map[string]string{"mode": "open"})
	f.run("core.home.form.set", map[string]string{"field": "parent", "value": "/work/alpha"})
	f.run("core.home.form.submit", nil)
	cards := f.tabbedCards()
	card, other := cards[0], cards[1]
	f.click("core.card.add", card)
	f.click("core.picker.item", "acme")
	tab := f.tabsOf(card)[1].(map[string]any)["id"].(string)
	box := f.box("core.card", card)
	drag := dragTab(t, f, tab, box.X+20, box.Y+box.H/2)
	if drag == nil || drag.Target == nil || strings.Join(drag.Target.Card, " ") != card+" "+other || drag.Target.Zone != "left" {
		t.Fatalf("the drag is %+v with the target %+v", drag, drag.Target)
	}
}

// A shell whose workbench.json holds no number for a metric of the bands is refused with the file and the metric.
func TestABandMetricWithoutANumberIsRefused(t *testing.T) {
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"drop-band", "drop-band-margin"} {
		_, err := workbench.NewShell(workbench.ShellOptions{Name: "main", Random: strings.NewReader(""), Declared: declared.WithChrome(name, "wide")})
		if want := "workbench.json: the chrome metric " + name + " has no number"; err == nil || err.Error() != want {
			t.Errorf("the shell starts with %v, not %q", err, want)
		}
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
	f.settle() // The press selects the tab through a command, and writes the layout through the host, whose answer the fixture delivers here.
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

// At gap 0 the preview draws no radius and a border of the border width, as the cards at the seam (row gap of
// docs/spec/settings.md).
func TestThePreviewOfADropAtTheSeamIsSquareWithTheBorderWidth(t *testing.T) {
	f, _, tab, other := cardWithTwoTabs(t)
	f.run("core.settings.change", map[string]any{"key": "gap", "value": 0, "scope": "common"})
	f.settle()
	box := f.box("core.card", other)
	x, y := box.X+box.W/2, box.Y+box.H/2
	dragTab(t, f, tab, x, y)
	f.tester.Frame()
	line := f.palette().BorderWidth
	// The left column of the preview is its border. Two and a half pixels below the top, a radius of the theme leaves that column
	// to the card; one pixel right of the border width the column is the fill.
	edge, corner, fill := f.pixelOf(box.X+line/2, y), f.pixelOf(box.X+line/2, box.Y+2.5), f.pixelOf(box.X+line+0.5, y)
	if corner != edge {
		t.Errorf("at gap 0 the preview draws a radius: the border is %v and its corner %v", edge, corner)
	}
	if fill == edge {
		t.Errorf("at gap 0 the preview draws a border wider than the border width %v: %v right of it", line, fill)
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
		{map[string]string{"tab": tab, "card": other, "zone": "middle"}, "invalid params for core.tab.move"},
		{map[string]string{"tab": tab, "card": "absent", "zone": "centre"}, "no card absent"},
		{map[string]string{"tab": "absent", "card": other, "zone": "centre"}, "no tab absent"},
	} {
		if _, err := f.answer("core.tab.move", refused.params); err == nil || !strings.Contains(err.Error(), refused.text) {
			t.Fatalf("%v answered %v", refused.params, err)
		}
	}
	// The only tab of a card toward a side of its own card names the vacated slot of the card and changes nothing
	// (docs/spec/groups.md#vacated-slot).
	if _, err := f.answer("core.tab.move", map[string]string{"tab": only, "card": other, "zone": "left"}); err != nil || !hasTab(f, other, only) {
		t.Fatalf("the only tab toward a side of its own card answered %v with the tabs %v", err, f.tabsOf(other))
	}
	if _, err := f.answer("core.tab.move", map[string]string{"tab": tab, "card": other, "zone": "centre"}); err != nil {
		t.Fatal(err)
	}
	if !hasTab(f, other, tab) || hasTab(f, card, tab) {
		t.Fatal("the command did not move the tab")
	}
}

// A tab command that names no tab answers as the page answers it, no tab <id> (cardOfTab of packages/workbench/plane.js).
func TestATabCommandRefusesATabThatNoCardHolds(t *testing.T) {
	f, _, _, _ := cardWithTwoTabs(t)
	for _, command := range []string{"core.tab.select", "core.tab.close"} {
		if _, err := f.answer(command, map[string]string{"tab": "absent"}); err == nil || !strings.Contains(err.Error(), "no tab absent") {
			t.Fatalf("%s of an absent tab answered %v", command, err)
		}
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

// A drag in steps reaches its last place while an error toast floats above the plane.
func TestATabDragUnderTheErrorToastsDropsWhereItEnds(t *testing.T) {
	f, card, tab, other := cardWithTwoTabs(t)
	before := f.box("core.card", other)
	f.shell.StartFailed(errors.New("a fault"))
	if shown := f.shownErrors(); len(shown) == 0 {
		t.Fatal("no error to show")
	}
	target := f.box("core.card", other)
	if target != before {
		t.Fatalf("the target card changed from %+v to %+v under the toast", before, target)
	}
	box := f.box("core.card.tab", tab)
	from, at := box.X+box.W/2, box.Y+box.H/2
	x, y := target.X+target.W/2, target.Y+target.H/2
	f.tester.Move(from, at)
	f.tester.Frame()
	f.tester.Press(from, at)
	f.tester.Frame()
	for step := float32(1); step <= 10; step++ {
		f.tester.Move(from+(x-from)*step/10, at+(y-at)*step/10)
		f.tester.Frame()
	}
	f.tester.Release(x, y)
	f.settle()
	if hasTab(f, card, tab) || !hasTab(f, other, tab) {
		t.Fatalf("the cards hold %v and %v", f.tabsOf(card), f.tabsOf(other))
	}
}

// A drag of a tab resolves its drop where the pointer is in the window when its move comes right after the frame that moved the tab:
// the move arrives while that frame builds, so it applies after it, when the handler of the tab holds the Bounds of the frame before
// and the move measures from the box of the frame that moved it.
func TestATabDragResolvesItsDropAtThePointerAfterTheTabMoved(t *testing.T) {
	f := layoutShell(t, oneCard(tab("t1", "notes"), tab("t2", "notes")))
	f.tester.SetSize(1400, 900)
	f.settle()
	split, err := f.apply("core.card.split", `{"card": "main", "side": "left", "plugin": "plain"}`)
	if err != nil {
		t.Fatal(err)
	}
	var created struct{ Card string }
	if err := json.Unmarshal([]byte(split), &created); err != nil || created.Card == "" {
		t.Fatalf("the split answered %s: %v", split, err)
	}
	// The left zone of the new card in the narrower window, where the move goes.
	f.tester.SetSize(1000, 900)
	f.settle()
	narrow, target := f.box("core.card.tab", "t2"), f.box("core.card", created.Card)
	x, y := target.X+4, target.Y+target.H/2
	f.tester.SetSize(1400, 900)
	f.settle()
	pill := f.box("core.card.tab", "t2")
	if narrow.X == pill.X {
		t.Fatalf("the tab t2 stands at x %v in both windows", pill.X)
	}
	from, at := pill.X+pill.W/2, pill.Y+pill.H/2
	f.tester.Move(from, at)
	f.tester.Press(from, at)
	f.tester.Move(from+20, at+20)
	// The resize builds the frame that moves the tab, and the move comes while it builds.
	f.building = func() { f.tester.Move(x, y) }
	f.tester.SetSize(1000, 900)
	if moved := f.box("core.card", created.Card); moved != target {
		t.Fatalf("card %s stands at %+v after the window narrowed, not at %+v as before", created.Card, moved, target)
	}
	drag := status[*dragRead](t, f.shellFixture, "core.drag")
	if drag == nil {
		t.Fatal("the press and the moves of the tab t2 began no drag")
	}
	if drag.Tab != "t2" || drag.Target == nil || strings.Join(drag.Target.Card, " ") != created.Card || drag.Target.Zone != "left" {
		t.Fatalf("the drag of the tab t2, which moved from x %v to %v, to the left zone of %s at %v,%v is %+v with the target %+v",
			pill.X, narrow.X, created.Card, x, y, drag, drag.Target)
	}
	f.tester.Release(x, y)
	f.settle()
}
