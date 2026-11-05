package workbench_test

import (
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strings"
	"testing"

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
	made, err := f.answer("core.card.split", map[string]string{"card": left, "side": "right", "plugin": "terminal"})
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
			made, err := f.answer("core.card.split", map[string]string{"card": source, "side": side, "plugin": "terminal"})
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
		if _, err := f.answer("core.card.split", map[string]string{"card": c.card, "side": c.side, "plugin": "terminal"}); err == nil || err.Error() != c.want {
			t.Errorf("the split of %s toward %s failed with %v, want %s", c.card, c.side, err, c.want)
		}
	}
	// A card that the minimum size does not allow to split stays as it is and says so.
	f.tester.SetSize(260, 400)
	f.settle()
	for range 4 {
		card := f.tabbedCards()[len(f.tabbedCards())-1]
		if _, err := f.answer("core.card.split", map[string]string{"card": card, "side": "right", "plugin": "terminal"}); err != nil {
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
	third, err := f.answer("core.card.split", map[string]string{"card": left, "side": "right", "plugin": "terminal"})
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
	made, err := f.answer("core.card.split", map[string]string{"card": middle, "side": "right", "plugin": "terminal"})
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
	left, terminal := f.box("core.card", "left"), f.box("core.card", "terminal")
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

// A new tab is named by the mark of its plugin and the counter of the project, which is stored with the project.
func TestANewTabCarriesTheMarkOfItsPlugin(t *testing.T) {
	f := viewShell(t)
	card := f.tabbedCards()[0]
	f.run("core.card.add-tab", map[string]string{"card": card, "plugin": "browser"})
	f.settle()
	if !f.tester.HasText("www 탭 2") {
		t.Fatalf("the texts are %q", f.tester.Texts())
	}
	f.run("core.card.split", map[string]string{"card": card, "side": "right", "plugin": "terminal"})
	f.settle()
	if !f.tester.HasText("◊ 탭 3") {
		t.Fatalf("the texts are %q", f.tester.Texts())
	}
	if got := f.host.projects[0]["named"]; fmt.Sprint(got) != "3" {
		t.Fatalf("the stored counter is %v", got)
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
	f := narrowCard(t, 3, strings.Repeat("max@maxs-MacBook-Pro-9:/private/tmp/", 3))
	list, add, closing, card := f.box("core.card.tab-list", "main"), f.box("core.card.add", "main"), f.box("core.card.close", "main"), f.box("core.card", "main")
	if list.W != 20 || add.W != 20 || closing.W != 20 {
		t.Fatalf("the buttons of the head are %v wide, %v and %v, want the card button of 20", list.W, add.W, closing.W)
	}
	if closing.X+closing.W >= card.X+card.W-4 || add.X >= closing.X {
		t.Fatalf("the tools are at %v and %v in the card %v", add, closing, card)
	}
	right := list.X + list.W
	for i := range 3 {
		id := fmt.Sprintf("tab-%06d", i)
		tab, x := f.box("core.card.tab", id), f.box("core.card.tab-close", id)
		if x.X+x.W-tab.X > 200 {
			t.Fatalf("tab %d is %v wide, want at most 200", i, x.X+x.W-tab.X)
		}
		if tab.X < right {
			t.Fatalf("tab %d starts at %v, over the one that ends at %v", i, tab.X, right)
		}
		if x.X < tab.X+tab.W {
			t.Fatalf("the close button %v of tab %d stands over its name %v", x, i, tab)
		}
		right = x.X + x.W
	}
}

// The strip scrolls to the tab that a press chose, and the tools stay in the head.
func TestAHeadScrollsItsStripToTheActiveTab(t *testing.T) {
	f := narrowCard(t, 8, strings.Repeat("long-title-", 3))
	last := "tab-000007"
	f.run("core.tab.select", map[string]string{"tab": last})
	f.settle()
	f.tester.Frame()
	tab, list, add := f.box("core.card.tab", last), f.box("core.card.tab-list", "main"), f.box("core.card.add", "main")
	if tab.X < list.X+list.W || tab.X+tab.W > add.X {
		t.Fatalf("the active tab %v stands outside the strip between %v and %v", tab, list, add)
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
