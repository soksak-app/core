package workbench_test

import (
	"encoding/json"
	"fmt"
	"image/color"
	"math"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// answer runs a command as the endpoint runs it and returns its answer as JSON.
func (f *shellFixture) answer(name string, params any) (map[string]any, error) {
	f.t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		f.t.Fatal(err)
	}
	value, err := f.shell.Registry().Run(name, raw)
	if err != nil {
		return nil, err
	}
	f.settle()
	encoded, err := json.Marshal(value)
	if err != nil {
		f.t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(encoded, &out); err != nil {
		f.t.Fatal(err)
	}
	return out, nil
}

// splitShell is a shown project whose first card is split to the right. It returns the two cards.
func splitShell(t *testing.T) (*shellFixture, string, string) {
	t.Helper()
	f := viewShell(t)
	left := f.tabbedCards()[0]
	made, err := f.answer("core.card.split", map[string]string{"card": left, "side": "right", "plugin": "textprobe"})
	if err != nil {
		t.Fatal(err)
	}
	return f, left, made["card"].(string)
}

func (f *shellFixture) box(name, item string) ui.Rect {
	f.t.Helper()
	node, ok := exposedNode(f.tester.ElementTree(), name, item)
	if !ok {
		f.t.Fatalf("no element %s %q", name, item)
	}
	return ui.Rect{X: node.Bounds.X, Y: node.Bounds.Y, W: node.Bounds.W, H: node.Bounds.H}
}

// divider returns the first divider between the two cards of a split.
func (f *shellFixture) divider(left, right string) (ui.Rect, string) {
	f.t.Helper()
	a, b := f.box("core.card", left), f.box("core.card", right)
	var found *ui.ElementNode
	var walk func(nodes []ui.ElementNode)
	walk = func(nodes []ui.ElementNode) {
		for i, node := range nodes {
			if exposed, ok := node.Key.(workbench.Exposed); ok && exposed.Name == "core.divider" &&
				node.Bounds.X+node.Bounds.W/2 >= a.X+a.W && node.Bounds.X+node.Bounds.W/2 <= b.X && node.Bounds.H > node.Bounds.W {
				found = &nodes[i]
			}
			walk(node.Children)
		}
	}
	walk(f.tester.ElementTree())
	if found == nil {
		f.t.Fatalf("no divider between %s and %s", left, right)
	}
	key := found.Key.(workbench.Exposed)
	if key.Command != "core.boundary.move" {
		f.t.Fatalf("the divider has the command %q", key.Command)
	}
	return ui.Rect{X: found.Bounds.X, Y: found.Bounds.Y, W: found.Bounds.W, H: found.Bounds.H}, key.Item
}

// A split through the registry answers the new card and its tab, the card takes the focus and both are stored.
func TestCoreCardSplitAnswersTheCardAndTheTab(t *testing.T) {
	for _, side := range []string{"right", "left", "top", "bottom"} {
		t.Run(side, func(t *testing.T) {
			f := viewShell(t)
			source := f.tabbedCards()[0]
			before := len(f.tabbedCards())
			made, err := f.answer("core.card.split", map[string]string{"card": source, "side": side, "plugin": "textprobe"})
			if err != nil {
				t.Fatal(err)
			}
			card, _ := made["card"].(string)
			tab, _ := made["tab"].(string)
			if card == "" || tab == "" {
				t.Fatalf("the split answered %v", made)
			}
			if !f.has("core.card", card) || !f.has("core.card.tab", tab) {
				t.Fatalf("the split drew no card and tab: %v", made)
			}
			a, b := f.box("core.card", source), f.box("core.card", card)
			placed := map[string]bool{"right": b.X >= a.X+a.W, "left": b.X+b.W <= a.X, "top": b.Y+b.H <= a.Y, "bottom": b.Y >= a.Y+a.H}
			if !placed[side] {
				t.Fatalf("the new card stands at %+v beside %+v", b, a)
			}
			if got := len(f.tabbedCards()); got != before+1 {
				t.Fatalf("%d cards are stored after %d", got, before)
			}
			f.audit()
		})
	}
}

func TestCoreCardSplitRefuses(t *testing.T) {
	f := viewShell(t)
	source := f.tabbedCards()[0]
	for _, c := range []struct {
		card, side, want string
	}{
		{"none", "right", "no card none"},
		{"left", "right", "no card left"},
		{source, "middle", "unknown side middle; use left, right, top or bottom"},
	} {
		if _, err := f.answer("core.card.split", map[string]string{"card": c.card, "side": c.side, "plugin": "textprobe"}); err == nil || err.Error() != c.want {
			t.Errorf("the split of %s toward %s failed with %v, want %s", c.card, c.side, err, c.want)
		}
	}
	// A card that the minimum size does not allow to split stays as it is and says so.
	f.tester.SetSize(260, 400)
	f.settle()
	for range 4 {
		card := f.tabbedCards()[len(f.tabbedCards())-1]
		if _, err := f.answer("core.card.split", map[string]string{"card": card, "side": "right", "plugin": "textprobe"}); err != nil {
			if want := "card " + card + " cannot split toward right"; err.Error() != want {
				t.Fatalf("the split failed with %v, want %s", err, want)
			}
			return
		}
	}
	t.Fatal("no split was refused")
}

// Closing a split gives its room back, answers closed, and moves the focus to a card that remains. The last card does not close.
func TestCoreCardCloseClosesASplit(t *testing.T) {
	f, left, right := splitShell(t)
	full := f.box("core.card", left)
	closed, err := f.answer("core.card.close", map[string]string{"card": right})
	if err != nil {
		t.Fatal(err)
	}
	if closed["closed"] != true {
		t.Fatalf("the close answered %v", closed)
	}
	if f.has("core.card", right) {
		t.Fatal("the closed card is still drawn")
	}
	if now := f.box("core.card", left); now.W <= full.W {
		t.Fatalf("the remaining card stands at %+v after %+v", now, full)
	}
	cards := f.tabbedCards()
	if len(cards) != 2 || cards[0] != left {
		t.Fatalf("the cards are %v", cards)
	}
	if _, err := f.answer("core.card.close", map[string]string{"card": cards[1]}); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ card, want string }{{"none", "no card none"}, {left, "card " + left + " cannot close"}} {
		if _, err := f.answer("core.card.close", map[string]string{"card": c.card}); err == nil || err.Error() != c.want {
			t.Errorf("the close of %s failed with %v, want %s", c.card, err, c.want)
		}
	}
}

// core.boundary.move moves a boundary without a snap and answers where it stands.
func TestCoreBoundaryMove(t *testing.T) {
	f, left, right := splitShell(t)
	before := f.box("core.card", right)
	moved, err := f.answer("core.boundary.move", map[string]any{"axis": "x", "line": 2, "position": 340})
	if err != nil {
		t.Fatal(err)
	}
	if position, _ := moved["position"].(float64); math.Abs(position-340) > 0.01 {
		t.Fatalf("the boundary answered %v", moved)
	}
	if now := f.box("core.card", right); now.X >= before.X || now.W <= before.W {
		t.Fatalf("the right card stands at %+v after %+v", now, before)
	}
	if now := f.box("core.card", left); now.W > 340 {
		t.Fatalf("the left card stands at %+v", now)
	}
	if _, err := f.answer("core.boundary.move", map[string]any{"axis": "x", "line": 99, "position": 340}); err == nil || err.Error() != "no x boundary at line 99" {
		t.Fatalf("a boundary that does not exist failed with %v", err)
	}
	if _, err := f.answer("core.boundary.move", map[string]any{"axis": "x", "line": 1}); err == nil || err.Error() != "core.boundary.move: position is missing" {
		t.Fatalf("a move without a position failed with %v", err)
	}
}

func cardRowsStored(t *testing.T, f *shellFixture) string {
	t.Helper()
	encoded, err := json.Marshal(f.host.projects[0]["spaces"])
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

// A press on a divider holds its boundary, each move moves it with the pointer, and the release stores the layout.
func TestDividerDragMovesTheBoundary(t *testing.T) {
	f, left, right := splitShell(t)
	f.audit()
	box, _ := f.divider(left, right)
	from := f.box("core.card", left)
	x, y := box.X+box.W/2, box.Y+box.H/2
	stored := cardRowsStored(t, f)
	f.tester.Move(x, y)
	f.tester.Frame()
	if got, want := f.tester.Cursor(), ui.CursorResizeEW; got != want {
		t.Fatalf("the cursor over the divider is %v, want %v", got, want)
	}
	f.tester.Press(x, y)
	f.tester.Frame()
	for _, step := range []float32{-40, -80, -120} {
		f.tester.Move(x+step, y)
		f.tester.Frame()
		if now := f.box("core.card", left); math.Abs(float64(now.W-from.W-step)) > 0.5 {
			t.Fatalf("after a move of %v the left card is %v wide, it was %v", step, now.W, from.W)
		}
	}
	if stored != cardRowsStored(t, f) {
		t.Fatal("a move stored the layout before the release")
	}
	f.tester.Release(x-120, y)
	f.settle()
	if stored == cardRowsStored(t, f) {
		t.Fatal("the release stored nothing")
	}
	// The boundary stays held by the same press only: a move after the release moves nothing.
	after := f.box("core.card", left)
	f.tester.Move(x, y)
	f.settle()
	if now := f.box("core.card", left); now.W != after.W {
		t.Fatalf("a move after the release left the card at %v, it was %v", now.W, after.W)
	}
}

// A drag stops at the minimum size of a card.
func TestDividerDragStopsAtTheMinimumSize(t *testing.T) {
	f, left, right := splitShell(t)
	box, _ := f.divider(left, right)
	x, y := box.X+box.W/2, box.Y+box.H/2
	f.tester.Press(x, y)
	f.tester.Frame()
	f.tester.Move(0, y)
	f.tester.Frame()
	f.tester.Release(0, y)
	f.settle()
	if now := f.box("core.card", left); now.W <= 0 {
		t.Fatalf("the left card stands at %+v", now)
	}
}

// A press with another button holds no boundary.
func TestDividerTakesOnlyThePrimaryButton(t *testing.T) {
	f, left, right := splitShell(t)
	box, _ := f.divider(left, right)
	before := f.box("core.card", left)
	x, y := box.X+box.W/2, box.Y+box.H/2
	f.tester.PressButton(1, x, y)
	f.tester.Frame()
	f.tester.Move(x-50, y)
	f.tester.Frame()
	f.tester.ReleaseButton(1, x-50, y)
	f.settle()
	if now := f.box("core.card", left); now.W != before.W {
		t.Fatalf("the second button moved the boundary to %+v", now)
	}
}

// A double press centers the boundary.
func TestDividerDoublePressCentersTheBoundary(t *testing.T) {
	f, left, right := splitShell(t)
	f.run("core.boundary.move", map[string]any{"axis": "x", "line": 2, "position": 340})
	box, _ := f.divider(left, right)
	x, y := box.X+box.W/2, box.Y+box.H/2
	f.tester.ClickAt(x, y)
	f.tester.ClickAt(x, y)
	f.settle()
	a, b := f.box("core.card", left), f.box("core.card", right)
	if math.Abs(float64(a.W-b.W)) > 1 {
		t.Fatalf("the cards are %v and %v wide", a.W, b.W)
	}
}

// A split while a boundary is held ends the hold: the lines that it named are not the same lines.
func TestASplitEndsTheHoldOfADivider(t *testing.T) {
	f, left, right := splitShell(t)
	box, _ := f.divider(left, right)
	x, y := box.X+box.W/2, box.Y+box.H/2
	f.tester.Press(x, y)
	f.tester.Frame()
	third, err := f.answer("core.card.split", map[string]string{"card": left, "side": "right", "plugin": "textprobe"})
	if err != nil {
		t.Fatal(err)
	}
	before := f.box("core.card", third["card"].(string))
	f.tester.Move(x-100, y)
	f.tester.Frame()
	f.tester.Release(x-100, y)
	f.settle()
	if now := f.box("core.card", third["card"].(string)); now != before {
		t.Fatalf("a held divider moved the new card to %+v from %+v", now, before)
	}
}

// A line that no card uses any more drops when a drag passes it, which renumbers the held line and the lines above it, and the same
// press goes on holding the boundary to its end. The element of the press keeps its key, so no other divider repeats it.
func TestDividerDragGoesOnPastALineThatItDrops(t *testing.T) {
	f, left, middle := splitShell(t)
	made, err := f.answer("core.card.split", map[string]string{"card": middle, "side": "right", "plugin": "textprobe"})
	if err != nil {
		t.Fatal(err)
	}
	third := made["card"].(string)
	f.run("core.card.close", map[string]string{"card": left})
	lines := dividerItems(f)
	box, _ := f.divider(middle, third)
	x, y := box.X+box.W/2, box.Y+box.H/2
	from := f.box("core.card", middle)
	f.tester.Press(x, y)
	f.tester.Frame()
	for _, step := range []float32{-30, -120, -240} {
		f.tester.Move(x+step, y)
		f.tester.Frame()
		if now := f.box("core.card", middle); math.Abs(float64(now.W-from.W-step)) > 0.5 {
			t.Fatalf("after a move of %v the card is %v wide, it was %v; the dividers were %v and are %v", step, now.W, from.W, lines, dividerItems(f))
		}
		seen := map[string]bool{}
		for _, item := range dividerItems(f) {
			if seen[item] {
				t.Fatalf("two dividers are the element %s: %v", item, dividerItems(f))
			}
			seen[item] = true
		}
	}
	f.tester.Release(x-240, y)
	f.settle()
	if got := dividerItems(f); len(got) != len(lines) {
		t.Fatalf("the dividers were %v and are %v", lines, got)
	}
	if slices.Equal(dividerItems(f), lines) {
		t.Fatalf("no line dropped: the dividers stay %v", lines)
	}
	f.audit()
}

func dividerItems(f *shellFixture) []string {
	var items []string
	var walk func(nodes []ui.ElementNode)
	walk = func(nodes []ui.ElementNode) {
		for _, node := range nodes {
			if exposed, ok := node.Key.(workbench.Exposed); ok && exposed.Name == "core.divider" {
				items = append(items, exposed.Item)
			}
			walk(node.Children)
		}
	}
	walk(f.tester.ElementTree())
	return items
}

// A window sidebar is a card of the plane with its status line, as on the page, so its column is not an empty margin.
func TestWindowSidebarsAreDrawnAsCards(t *testing.T) {
	f := openedShell(t)
	for side, label := range map[string]string{"left": "왼쪽 창 사이드바", "right": "오른쪽 창 사이드바"} {
		box := f.box("core.card", side)
		if box.W <= 0 || box.H <= 0 {
			t.Fatalf("the %s sidebar stands at %+v", side, box)
		}
		if !f.tester.HasText(label) {
			t.Fatalf("the status line %q is not drawn; the texts are %q", label, f.tester.Texts())
		}
	}
	f.audit()
}

// The plane stands as on the page: the cards are twice the gap of the theme apart, and the stage holds the gap and its border around
// the plane.
func TestThePlaneHasTheGapOfThePage(t *testing.T) {
	f := openedShell(t)
	left, terminal := f.box("core.card", "left"), f.box("core.card", "textprobe")
	if got := terminal.X - (left.X + left.W); got != 12 {
		t.Fatalf("the cards are %v apart, want 12", got)
	}
	if left.X != 7 {
		t.Fatalf("the plane starts at %v, want 7", left.X)
	}
}

// viewShell is a shell with a project and the plugins of a view.
func viewShell(t *testing.T) *shellFixture {
	t.Helper()
	f := newShell(t, &storedHost{installed: installedDocument})
	f.run("core.library.form.open", map[string]string{"mode": "open"})
	f.run("core.library.form.set", map[string]string{"field": "parent", "value": "/work/alpha"})
	f.run("core.library.form.submit", nil)
	return f
}

// A new tab is named by the mark of its plugin and the counter of its layout, which is stored with the layout.
func TestANewTabCarriesTheMarkOfItsPlugin(t *testing.T) {
	f := viewShell(t)
	card := f.tabbedCards()[0]
	f.run("core.card.add-tab", map[string]string{"card": card, "plugin": "boxprobe"})
	f.settle()
	if !f.tester.HasText("www 탭 1") {
		t.Fatalf("the texts are %q", f.tester.Texts())
	}
	f.run("core.card.split", map[string]string{"card": card, "side": "right", "plugin": "textprobe"})
	f.settle()
	if !f.tester.HasText("◊ 탭 2") {
		t.Fatalf("the texts are %q", f.tester.Texts())
	}
	encoded, err := json.Marshal(f.host.projects[0]["spaces"].([]any)[0].(map[string]any)["layout"])
	if err != nil {
		t.Fatal(err)
	}
	var kept struct{ Named int }
	if err := json.Unmarshal(encoded, &kept); err != nil {
		t.Fatal(err)
	}
	if kept.Named != 2 {
		t.Fatalf("the stored counter is %d", kept.Named)
	}
}

// A tab or a split of a plugin that is not loaded is refused, with the words of the page.
func TestAnUnknownPluginIsRefused(t *testing.T) {
	f := viewShell(t)
	card := f.tabbedCards()[0]
	before := len(f.tabbedCards())
	for name, params := range map[string]map[string]string{
		"core.card.split":   {"card": card, "side": "right", "plugin": "missing"},
		"core.card.add-tab": {"card": card, "plugin": "missing"},
	} {
		if _, err := f.answer(name, params); err == nil || err.Error() != "unknown plugin missing" {
			t.Fatalf("%s answered %v", name, err)
		}
	}
	if got := len(f.tabbedCards()); got != before {
		t.Fatalf("the refusals left %d cards", got)
	}
}

// An error line takes its height from the plane, so the cards keep the bottom of the window.
func TestAnErrorLineKeepsTheCardsInTheWindow(t *testing.T) {
	f := narrowCard(t, 1, "a")
	before := f.box("core.card", "main")
	f.shell.Event("surface-pressed", []any{7.0})
	f.pending.drain(t)
	f.tester.Frame()
	f.tester.Frame()
	after := f.box("core.card", "main")
	if after.Y <= before.Y {
		t.Fatalf("the card stands at %v under the error line, before it at %v", after.Y, before.Y)
	}
	if bottom, want := after.Y+after.H, before.Y+before.H; bottom != want {
		t.Fatalf("the card ends at %v under the error line, want %v", bottom, want)
	}
}

// narrowCard is a shell whose card main, beside the card other, holds tabs of title.
func narrowCard(t *testing.T, tabs int, title string) *shellFixture {
	t.Helper()
	list := []map[string]any{}
	for i := range tabs {
		list = append(list, map[string]any{"id": fmt.Sprintf("tab-%06d", i), "plugin": "notes", "title": fmt.Sprintf("%d %s", i, title)})
	}
	project := storedProject(list...)
	state := project["spaces"].([]map[string]any)[0]["layout"].(map[string]any)["state"].(map[string]any)
	state["xs"] = []float64{0, 0.5, 1}
	state["cards"] = append(state["cards"].([]map[string]any), map[string]any{"id": "other", "c0": 1, "c1": 2, "r0": 0, "r1": 1, "data": map[string]any{
		"tabs": []map[string]any{{"id": "tab-bbbbbb", "plugin": "notes", "title": "b"}}, "activeId": "tab-bbbbbb"}})
	// The window shows no sidebars, so the width of the card is half of the plane and its head holds its tabs.
	f := newShell(t, &storedHost{common: map[string]any{"left": false, "right": false}, projects: []map[string]any{project}})
	if _, err := f.answer("core.project.activate", map[string]string{"id": "prj-a"}); err != nil {
		t.Fatal(err)
	}
	f.settle()
	return f
}

// A card head starts with its tab list button and ends with its tools in one group. Its tabs stand between them, each with its name,
// cut within the bound of a tab, and its close button.
func TestACardHeadHoldsItsTabsBetweenItsListAndItsTools(t *testing.T) {
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	pad, _ := declared.Metric("tab-pad-x")
	xPad, _ := declared.Metric("tab-x-pad")
	f := narrowCard(t, 3, strings.Repeat("max@maxs-MacBook-Pro-9:/private/tmp/", 3))
	list, add, closing, card := f.box("core.card.tab-list", "main"), f.box("core.card.add", "main"), f.box("core.card.close", "main"), f.box("core.card", "main")
	if list.W != 20 || add.W != 20 || closing.W != 20 {
		t.Fatalf("the buttons of the head are %v wide, %v and %v, want the card button of 20", list.W, add.W, closing.W)
	}
	if closing.X+closing.W >= card.X+card.W-4 || add.X >= closing.X {
		t.Fatalf("the tools are at %v and %v in the card %v", add, closing, card)
	}
	right, painted := list.X+list.W, 0
	for i := range 3 {
		id := fmt.Sprintf("tab-%06d", i)
		tab, x := f.box("core.card.tab", id), f.box("core.card.tab-close", id)
		if tab.W > 200 {
			t.Fatalf("tab %d is %v wide, want at most 200", i, tab.W)
		}
		if tab.X < right {
			t.Fatalf("tab %d starts at %v, over the one that ends at %v", i, tab.X, right)
		}
		if !standsIn(x, tab) || tab.X+tab.W-(x.X+x.W) != 7 {
			t.Fatalf("the close button %v does not end tab %d %v by the padding of a tab", x, i, tab)
		}
		// The strip cuts the tabs past the tools, and the ink of a tab that it cuts is not the ink of its name.
		if tab.X+tab.W <= add.X {
			painted++
			if end := f.inkEnd(tab, x.X+float32(xPad)); end <= tab.X+float32(pad) || end > x.X {
				t.Fatalf("the name of tab %d ends at %v, its close button starts at %v", i, end, x.X)
			}
		}
		right = tab.X + tab.W
	}
	if painted == 0 {
		t.Fatal("the strip paints no whole tab")
	}
}

// A column that a setting brings takes its width from the plane, so the head of the card draws its list in the narrower card.
func TestAColumnThatASettingBringsNarrowsTheHeadOfACard(t *testing.T) {
	f := narrowCard(t, 3, "title")
	before, card := f.box("core.card.tab-list", "main"), f.box("core.card", "main")
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"left": true}, "scope": "common"})
	f.settle()
	after, narrowed := f.box("core.card.tab-list", "main"), f.box("core.card", "main")
	if narrowed.W >= card.W {
		t.Fatalf("the card is %v wide with the column, it was %v", narrowed.W, card.W)
	}
	if after.X <= before.X || after.X < narrowed.X {
		t.Fatalf("the tab list stands at %v in the card %v, it stood at %v", after, narrowed, before)
	}
}

// The strip scrolls to the tab that a press chose, and the tools stay in the head.
func TestAHeadScrollsItsStripToTheActiveTab(t *testing.T) {
	f := narrowCard(t, 8, strings.Repeat("long-title-", 3))
	last := "tab-000007"
	f.run("core.tab.select", map[string]string{"tab": last})
	f.settle()
	f.tester.Advance(2 * time.Second)
	f.tester.Frame()
	tab, list, add := f.box("core.card.tab", last), f.box("core.card.tab-list", "main"), f.box("core.card.add", "main")
	if tab.X < list.X+list.W || tab.X+tab.W > add.X {
		t.Fatalf("the active tab %v stands outside the strip between %v and %v", tab, list, add)
	}
}

// The strip glides to a tab that the user chose, and a change of the layout moves it at once.
func TestTheStripGlidesOnlyToAChosenTab(t *testing.T) {
	f := narrowCard(t, 8, strings.Repeat("long-title-", 3))
	first, last := "tab-000000", "tab-000007"
	f.run("core.tab.select", map[string]string{"tab": last})
	f.settle()
	f.tester.Advance(2 * time.Second)
	f.tester.Frame()
	f.run("core.tab.select", map[string]string{"tab": first})
	f.settle()
	f.tester.Advance(50 * time.Millisecond)
	f.tester.Frame()
	moving := f.box("core.card.tab", first).X
	f.tester.Advance(2 * time.Second)
	f.tester.Frame()
	landed := f.box("core.card.tab", first).X
	if moving >= landed {
		t.Fatalf("after 50 ms the chosen tab stands at %v, and it lands at %v", moving, landed)
	}
	f.run("core.tab.select", map[string]string{"tab": last})
	f.settle()
	f.tester.Advance(2 * time.Second)
	f.tester.Frame()
	before := f.box("core.card.tab", last)
	f.tester.SetSize(1000, 800)
	f.settle()
	after := f.box("core.card.tab", last)
	list, add := f.box("core.card.tab-list", "main"), f.box("core.card.add", "main")
	centre := (list.X + list.W + add.X) / 2
	if math.Abs(float64(after.X+after.W/2-centre)) > float64(before.W) {
		t.Fatalf("after the resize the tab %v stands off the centre %v of the strip at once", after, centre)
	}
}

// A tab name that does not fit ends with an ellipsis inside its tab, so the head keeps its tools and the tab its close button.
func TestALongTabNameKeepsTheHeadOfItsCard(t *testing.T) {
	title := strings.Repeat("max@host:/private/tmp/a-long-directory/", 4)
	f := newShell(t, &storedHost{projects: []map[string]any{storedProject(map[string]any{"id": "tab-aaaaaa", "plugin": "notes", "title": title})}})
	if _, err := f.answer("core.project.activate", map[string]string{"id": "prj-a"}); err != nil {
		t.Fatal(err)
	}
	f.settle()
	tab, closing := f.box("core.card.tab", "tab-aaaaaa"), f.box("core.card.tab-close", "tab-aaaaaa")
	if width := closing.X + closing.W - tab.X; width > 200 {
		t.Fatalf("the tab is %v wide, want at most 200", width)
	}
	f.box("core.card.add", "main")
}

// A status line that does not fit stays on the one line of the foot of its card.
func TestALongStatusKeepsTheFootOfItsCard(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := terminalSurface(t, stored)
	viewCall(t, f, stored, surface, "tab.footer", "short")
	short, ok := f.tester.Find("short")
	if !ok {
		t.Fatalf("the texts are %q", f.tester.Texts())
	}
	long := strings.Repeat("/private/tmp/a-long-directory", 40)
	viewCall(t, f, stored, surface, "tab.footer", long)
	found, ok := f.tester.Find(long)
	if !ok {
		t.Fatalf("the texts are %q", f.tester.Texts())
	}
	if found.H != short.H {
		t.Fatalf("the long status is %v high, the short one %v", found.H, short.H)
	}
	for _, card := range status[gridRead](t, f, "core.grid").Cards {
		if len(card.Tabs) == 0 || card.Tabs[0].ID != surface {
			continue
		}
		if foot := f.box("core.card.status", card.ID); found.X+found.W > foot.X+foot.W {
			t.Fatalf("the status %v leaves the foot %v", found, foot)
		}
	}
}

// tool reads a tool of the head of card from core.grid.
func (f *shellFixture) tool(t *testing.T, card, key string) (enabled bool, title string) {
	t.Helper()
	for _, read := range status[gridRead](t, f, "core.grid").Cards {
		if read.ID == card {
			tool, ok := read.Acts[key].(map[string]any)
			if !ok {
				t.Fatalf("card %s has no tool %s: %v", card, key, read.Acts)
			}
			return tool["enabled"].(bool), tool["title"].(string)
		}
	}
	t.Fatalf("no card %s", card)
	return false, ""
}

// The tooltip of a card tool is its name, and a refusal states its reason (docs/spec/example-model.md#card-tools).
func TestTheToolsOfAHeadFollowWhatTheCardCanDo(t *testing.T) {
	const held = "전체 화면에서는 배치를 바꿀 수 없다"
	f := narrowCard(t, 1, "a")
	f.run("core.card.close", map[string]string{"card": "other"})
	f.settle()
	// The last card of the plane has no neighbor that fills its place.
	if enabled, title := f.tool(t, "main", "close"); enabled || title != "이 자리를 빈틈없이 메울 이웃이 없어 닫을 수 없다" {
		t.Fatalf("the close tool of the last card is %v %q", enabled, title)
	}
	node, ok := exposedNode(f.tester.ElementTree(), "core.card.close", "main")
	if !ok || node.Actions&ui.ActionPress != 0 {
		t.Fatalf("the close tool of the last card takes a press: %+v", node)
	}
	if enabled, title := f.tool(t, "main", "split-x"); !enabled || title != "세로로 나누기" {
		t.Fatalf("the split tool is %v %q", enabled, title)
	}
	for key, name := range map[string]string{"add": "탭 추가", "split-y": "가로로 나누기", "fullscreen": "카드 전체 화면"} {
		if _, title := f.tool(t, "main", key); title != name {
			t.Fatalf("the tool %s is %q, want %q", key, title, name)
		}
	}

	f.click("core.card.fullscreen", "main")
	for _, key := range []string{"add", "split-x", "split-y", "close"} {
		if enabled, title := f.tool(t, "main", key); enabled || title != held {
			t.Fatalf("the tool %s of a fullscreen card is %v %q", key, enabled, title)
		}
	}
	if enabled, title := f.tool(t, "main", "fullscreen"); !enabled || title != "카드 배치 복원" {
		t.Fatalf("the fullscreen tool is %v %q", enabled, title)
	}
}

// A card that is too narrow to cut across stays open to a cut along it, and its tool menu leaves out what it cannot do.
func TestATooNarrowCardCannotSplitAndItsMenuHoldsWhatItCan(t *testing.T) {
	f := projectWithPlugins(t)
	card := f.tabbedCards()[0]
	refused := false
	for range 12 {
		if _, err := f.answer("core.card.split", map[string]string{"card": card, "side": "right", "plugin": "acme"}); err != nil {
			refused = true
			break
		}
	}
	if !refused {
		t.Fatal("the card never stopped splitting")
	}
	if enabled, _ := f.tool(t, card, "split-x"); enabled {
		t.Fatal("the split tool of a card that does not split is enabled")
	}
	if enabled, _ := f.tool(t, card, "split-y"); !enabled {
		t.Fatal("the card cannot split along its height")
	}
	f.click("core.card.tools", card)
	keys := f.menu().keys()
	if slices.Contains(keys, "x") || !slices.Contains(keys, "y") || !slices.Contains(keys, "fullscreen") {
		t.Fatalf("the tool menu holds %q", keys)
	}
	// The menu takes the names of the tools as their tooltips hold them.
	names := map[string]string{"add": "탭 추가", "y": "가로로 나누기", "fullscreen": "카드 전체 화면", "close": "카드 닫기"}
	for _, item := range f.menu().Items {
		if want, ok := names[item.Key]; ok && item.Name != want {
			t.Fatalf("the menu item %s is %q, want %q", item.Key, item.Name, want)
		}
	}
}

// themeToken returns the color token of a theme in its mode, as workbench.json declares it.
func themeToken(t *testing.T, name, mode, token string) color.RGBA {
	t.Helper()
	text, err := os.ReadFile("../src/workbench.json")
	if err != nil {
		t.Fatal(err)
	}
	var declared struct {
		Themes []map[string]any `json:"themes"`
	}
	if err := json.Unmarshal(text, &declared); err != nil {
		t.Fatal(err)
	}
	for _, theme := range declared.Themes {
		if theme["name"] == name {
			parsed := ui.Hex(theme[mode].(map[string]any)[token].(string))
			return color.RGBA{parsed.R, parsed.G, parsed.B, 255}
		}
	}
	t.Fatalf("no theme %s", name)
	return color.RGBA{}
}

// The first row and the row of the spaces are bands of the card color, each with its edge under it, over the background of the stage.
func TestTheBarsOfTheWindowTakeTheCardColorOfTheTheme(t *testing.T) {
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	metric := func(name string) float32 {
		value, ok := declared.Metric(name)
		if !ok {
			t.Fatalf("no metric %s", name)
		}
		return float32(value)
	}
	for _, theme := range [][2]string{{"midnight", "dark"}, {"paper", "light"}} {
		t.Run(theme[1], func(t *testing.T) {
			f := projectWithPlugins(t)
			f.run("core.settings.theme", map[string]any{"name": theme[0], "mode": theme[1]})
			f.settle()
			image := f.tester.Image()
			scale := float32(image.Bounds().Dx()) / 1200
			at := func(y float32) color.RGBA { return image.RGBAAt(int(600*scale), int(y*scale)) }
			first, second := metric("chrome-h"), metric("chrome-h")+metric("chrome-row-h")
			card, edge, stage := themeToken(t, theme[0], theme[1], "card"), themeToken(t, theme[0], theme[1], "edge"), themeToken(t, theme[0], theme[1], "bg")
			if got := at(1); got != card {
				t.Fatalf("the first row is %v, want %v", got, card)
			}
			if got := at(first - 0.5); got != edge {
				t.Fatalf("the edge of the first row is %v, want %v", got, edge)
			}
			if got := at(first + 1); got != card {
				t.Fatalf("the row of the spaces is %v, want %v", got, card)
			}
			if got := at(second - 0.5); got != edge {
				t.Fatalf("the edge of the row of the spaces is %v, want %v", got, edge)
			}
			plane := status[struct {
				Plane struct{ X float64 } `json:"plane"`
			}](t, f, "core.grid").Plane
			if got := at(second + 1); plane.X > 1 && got != stage {
				t.Fatalf("the stage is %v, want %v", got, stage)
			}
		})
	}
}

// The cards start under the two rows, whose heights the page declares.
func TestTheCardsStartUnderTheTwoRows(t *testing.T) {
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	first, _ := declared.Metric("chrome-h")
	second, _ := declared.Metric("chrome-row-h")
	f := projectWithPlugins(t)
	plane := status[struct {
		Plane struct{ X, Y float64 } `json:"plane"`
	}](t, f, "core.grid")
	if want := first + second + plane.Plane.X; plane.Plane.Y != want {
		t.Fatalf("the plane starts at %v, want %v under rows of %v and %v", plane.Plane.Y, want, first, second)
	}
	if box := f.box("core.card", f.tabbedCards()[0]); float64(box.Y) != plane.Plane.Y {
		t.Fatalf("the first card stands at %v in a plane at %v", box.Y, plane.Plane.Y)
	}
}

// The tabs of the bars are chips over the band of the card color: the selected one in the rail color, a selected project in its own color, the
// others in the text color, and the close button stands inside the chip.
func TestATabOfABarIsAChipOverTheBand(t *testing.T) {
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	share := func(name string) float64 {
		value, ok := declared.Share(name)
		if !ok {
			t.Fatalf("no share %s", name)
		}
		return value
	}
	over := func(under, tint color.RGBA, amount float64) color.RGBA {
		mix := func(a, b uint8) uint8 { return uint8(math.Round(float64(a)*(1-amount) + float64(b)*amount)) }
		return color.RGBA{mix(under.R, tint.R), mix(under.G, tint.G), mix(under.B, tint.B), 255}
	}
	near := func(a, b color.RGBA) bool {
		close := func(x, y uint8) bool { return math.Abs(float64(x)-float64(y)) <= 2 }
		return close(a.R, b.R) && close(a.G, b.G) && close(a.B, b.B)
	}
	f := projectWithPlugins(t)
	f.run("core.settings.theme", map[string]any{"name": "midnight", "mode": "dark"})
	f.click("core.space-tab.add", "")
	f.tester.Move(600, 500)
	f.settle()
	card, fg, rail := themeToken(t, "midnight", "dark", "card"), themeToken(t, "midnight", "dark", "fg"), themeToken(t, "midnight", "dark", "rail")
	image := f.tester.Image()
	scale := float32(image.Bounds().Dx()) / 1200
	inside := func(box ui.Rect) color.RGBA { return image.RGBAAt(int((box.X+3)*scale), int((box.Y+box.H/2)*scale)) }
	record := f.host.projects[0]
	on, off := record["activeSpaceId"].(string), ""
	for _, space := range record["spaces"].([]any) {
		if id := space.(map[string]any)["id"].(string); id != on {
			off = id
		}
	}
	if got, want := inside(f.box("core.space-tab", on)), over(card, rail, share("chip-on-mix")); !near(got, want) {
		t.Fatalf("the selected space tab is %v, want %v", got, want)
	}
	if got, want := inside(f.box("core.space-tab", off)), over(card, fg, share("chip-mix")); !near(got, want) {
		t.Fatalf("the other space tab is %v, want %v", got, want)
	}
	tint := ui.Hex(record["color"].(string))
	if got, want := inside(f.box("core.project-tab", record["id"].(string))), over(card, color.RGBA{tint.R, tint.G, tint.B, 255}, share("project-tab-mix")); !near(got, want) {
		t.Fatalf("the selected project tab is %v, want %v", got, want)
	}
	chip, closing := f.box("core.space-tab", on), f.box("core.space-tab.close", on)
	if !standsIn(closing, chip) {
		t.Fatalf("the close button %v stands out of the chip %v", closing, chip)
	}
	xPad, _ := declared.Metric("bar-tab-x-pad")
	pad, _ := declared.Metric("chrome-gap")
	if end := f.inkEnd(chip, closing.X+float32(xPad)); end <= chip.X+float32(pad) || end > closing.X {
		t.Fatalf("the name of the chip %v ends at %v, its close button starts at %v", chip, end, closing.X)
	}
	if got, want := image.RGBAAt(int((closing.X+closing.W+1)*scale), int((closing.Y+closing.H/2)*scale)), over(card, rail, share("chip-on-mix")); !near(got, want) {
		t.Fatalf("beside the close button the chip is %v, want %v", got, want)
	}
}

// The chrome bar holds the logo and the switches of the page, each with the size that the page declares, and a switch runs its setting.
func TestTheChromeBarHoldsTheLogoAndTheSwitchesOfThePage(t *testing.T) {
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	wide, _ := declared.Metric("act-w")
	high, _ := declared.Metric("act-h")
	f := projectWithPlugins(t)
	f.run("core.settings.theme", map[string]any{"name": "midnight", "mode": "dark"})
	settings := func() map[string]any {
		return status[struct {
			Values map[string]any `json:"values"`
		}](t, f, "core.settings").Values
	}
	order := []string{"core.chrome.projects", "core.chrome.balance", "core.chrome.left", "core.chrome.right", "core.chrome.top", "core.chrome.bottom", "core.chrome.mode", "core.chrome.settings"}
	last := float32(0)
	for _, name := range order {
		box := f.box(name, "")
		if float64(box.W) != wide || float64(box.H) != high || box.X <= last {
			t.Fatalf("%s is %v after %v", name, box, last)
		}
		last = box.X
	}
	logo := f.box("core.brand", "")
	image := f.tester.Image()
	scale := float32(image.Bounds().Dx()) / 1200
	tile := image.RGBAAt(int((logo.X+logo.H/8)*scale), int((logo.Y+logo.H/2)*scale))
	if want := (color.RGBA{0x16, 0x18, 0x1d, 255}); tile != want {
		t.Fatalf("the tile of the logo is %v, want %v", tile, want)
	}
	left, _ := settings()["left"].(bool)
	f.click("core.chrome.left", "")
	if got, _ := settings()["left"].(bool); got == left {
		t.Fatalf("the switch left the setting left at %v", got)
	}
	f.click("core.chrome.mode", "")
	if settings()["mode"] != "light" {
		t.Fatalf("the mode is %v after the switch", settings()["mode"])
	}
	f.click("core.chrome.projects", "")
	if f.has("core.chrome.projects", "") || f.has("core.chrome.balance", "") || !f.has("core.chrome.settings", "") || !f.has("core.brand", "") {
		t.Fatal("the bar of the library holds other switches than those of the page")
	}
}

// The number of a new tab counts the tabs of its layout and the name of a new space counts the spaces of its project, so neither moves the other.
func TestTabsAndSpacesCountApart(t *testing.T) {
	f, first, made := splitShell(t)
	layoutOf := func(index int) map[string]any {
		var layout map[string]any
		encoded, err := json.Marshal(f.host.projects[0]["spaces"].([]any)[index].(map[string]any)["layout"])
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(encoded, &layout); err != nil {
			t.Fatal(err)
		}
		return layout
	}
	f.settle()
	if got := fmt.Sprint(f.host.projects[0]["named"]); got != "1" {
		t.Fatalf("a new tab moved the counter of the spaces to %s", got)
	}
	if got := fmt.Sprint(layoutOf(0)["named"]); got != "1" {
		t.Fatalf("the layout counted %s tabs", got)
	}
	title := func(card string) string {
		tabs := f.tabsOf(card)
		return tabs[len(tabs)-1].(map[string]any)["title"].(string)
	}
	if got := title(made); !strings.HasSuffix(got, "탭 1") {
		t.Fatalf("the first new tab of the layout is %q", got)
	}
	f.run("core.space.add", nil)
	f.settle()
	spaces := f.host.projects[0]["spaces"].([]any)
	if got := spaces[1].(map[string]any)["title"]; got != "SPACE2" {
		t.Fatalf("the second space is %v", got)
	}
	if got := fmt.Sprint(layoutOf(1)["named"]); got != "0" {
		t.Fatalf("a new layout counted %s tabs", got)
	}
	f.run("core.space.activate", map[string]string{"id": spaces[0].(map[string]any)["id"].(string)})
	f.settle()
	f.run("core.card.add-tab", map[string]string{"card": first, "plugin": "textprobe"})
	f.settle()
	if got := title(first); !strings.HasSuffix(got, "탭 2") {
		t.Fatalf("the layout went on as %q", got)
	}
}

func TestCardSplitDistinguishesMissingEmptyAndNullSide(t *testing.T) {
	f := viewShell(t)
	card := f.tabbedCards()[0]
	for _, c := range []struct {
		name     string
		side     any
		present  bool
		expected string
	}{
		{name: "missing", expected: "unknown side undefined; use left, right, top or bottom"},
		{name: "empty", side: "", present: true, expected: "unknown side ; use left, right, top or bottom"},
		{name: "null", present: true, expected: "unknown side null; use left, right, top or bottom"},
	} {
		t.Run(c.name, func(t *testing.T) {
			argument := map[string]any{"card": card, "plugin": "textprobe"}
			if c.present {
				argument["side"] = c.side
			}
			before, err := json.Marshal(f.cardsOf())
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.answer("core.card.split", argument); err == nil || err.Error() != c.expected {
				t.Errorf("split side %s: got %v, expected %q", c.name, err, c.expected)
			}
			after, err := json.Marshal(f.cardsOf())
			if err != nil {
				t.Fatal(err)
			}
			if string(after) != string(before) {
				t.Fatalf("refused split changed the stored cards: %s -> %s", before, after)
			}
		})
	}
}

// focusInk counts the pixels of box that are drawn in the focus color, within the tolerance of e2e/card-fullscreen.test.mjs.
func (f *shellFixture) focusInk(box ui.Rect) int {
	f.t.Helper()
	focus := opaque(f.palette().Focus)
	image := f.tester.Image()
	scale := float32(image.Bounds().Dx()) / f.tester.ElementTree()[0].Bounds.W
	within := func(a, b uint8) bool { return int(a)-int(b) <= 40 && int(b)-int(a) <= 40 }
	count := 0
	for x := int(box.X * scale); x < int((box.X+box.W)*scale); x++ {
		for y := int(box.Y * scale); y < int((box.Y+box.H)*scale); y++ {
			if pixel := image.RGBAAt(x, y); within(pixel.R, focus.R) && within(pixel.G, focus.G) && within(pixel.B, focus.B) {
				count++
			}
		}
	}
	return count
}

// The fullscreen tool of a fullscreen card is a pressed switch, which the page draws in the focus color whether or not the pointer
// is over it (.chrome__act[aria-pressed=true] of packages/workbench/app.css); the close tool beside it keeps the muted color.
func TestThePressedFullscreenToolIsDrawnInTheFocusColor(t *testing.T) {
	f := narrowCard(t, 1, "a")
	f.settle()
	if ink := f.focusInk(f.box("core.card.fullscreen", "main")); ink != 0 {
		t.Fatalf("the fullscreen tool of a card that is not fullscreen has %d pixels of the focus color", ink)
	}
	f.click("core.card.fullscreen", "main")
	f.tester.Move(1, 1)
	f.settle()
	icon, closing := f.focusInk(f.box("core.card.fullscreen", "main")), f.focusInk(f.box("core.card.close", "main"))
	if icon == 0 || closing != 0 {
		t.Fatalf("the pressed fullscreen tool is not drawn in the focus color: icon %d px, close %d px", icon, closing)
	}
}
