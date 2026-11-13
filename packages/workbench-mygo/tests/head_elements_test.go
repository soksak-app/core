package workbench_test

import (
	"fmt"
	"image/color"
	"math"
	"slices"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// itemsNamed returns the items of the elements of name in tree order, the order that gives an element its index.
func itemsNamed(nodes []ui.ElementNode, name string) []string {
	items := []string{}
	for _, node := range nodes {
		if exposed, ok := node.Key.(workbench.Exposed); ok && exposed.Name == name {
			items = append(items, exposed.Item)
		}
		items = append(items, itemsNamed(node.Children, name)...)
	}
	return items
}

// A request names a tab by its place in the order of core.grid, whichever tabs the head shows, as the page keeps a hidden tab in its
// document. Each element of a head keeps the index of its card or of its tab through every stage of the head and through a full screen card.
func TestEveryElementOfAHeadKeepsTheIndexOfItsCard(t *testing.T) {
	f := narrowCard(t, 8, strings.Repeat("long-title-", 3))
	f.run("core.tab.select", map[string]string{"tab": "tab-000004"})
	check := func(stage string) {
		t.Helper()
		f.settle()
		tabs, cards := []string{}, []string{}
		for _, card := range status[gridRead](t, f, "core.grid").Cards {
			cards = append(cards, card.ID)
			for _, tab := range card.Tabs {
				tabs = append(tabs, tab.ID)
			}
		}
		tree := f.tester.ElementTree()
		for _, name := range []string{"core.card.tab", "core.card.tab-close"} {
			if got := itemsNamed(tree, name); !slices.Equal(got, tabs) {
				t.Errorf("%s: the elements of %s are %v, the grid holds %v", stage, name, got, tabs)
			}
		}
		for _, name := range []string{"core.card", "core.card.header", "core.card.status", "core.card.tab-list", "core.card.space-apps", "core.card.tools", "core.card.add",
			"core.card.split-x", "core.card.split-y", "core.card.fullscreen", "core.card.close"} {
			if got := itemsNamed(tree, name); !slices.Equal(got, cards) {
				t.Errorf("%s: the elements of %s are %v, the grid holds %v", stage, name, got, cards)
			}
		}
	}
	for _, width := range []int{1600, 900, 500, 300, 150} {
		f.tester.SetSize(width, 600)
		check(fmt.Sprintf("a window of %d", width))
	}
	f.tester.SetSize(900, 600)
	f.run("core.card.fullscreen", map[string]string{"card": "other"})
	check("a full screen card")
}

// A tab that the head does not show has no size, and the tab that it shows stands where it stands without the others.
func TestAHiddenTabLeavesTheActiveTabInItsPlace(t *testing.T) {
	f := narrowCard(t, 8, strings.Repeat("long-title-", 3))
	f.tester.SetSize(1600, 600)
	f.settle()
	list, first := f.box("core.card.tab-list", "main"), f.box("core.card.tab", "tab-000000")
	gap := first.X - (list.X + list.W)
	f.tester.SetSize(300, 600)
	f.settle()
	card := status[gridRead](t, f, "core.grid").Cards[0]
	active := *card.Active
	list, shown := f.box("core.card.tab-list", "main"), f.box("core.card.tab", active)
	if shown.W <= 0 || shown.X-(list.X+list.W) != gap {
		t.Fatalf("the active tab stands at %+v after the list %+v, the gap is %v", shown, list, gap)
	}
	for _, tab := range card.Tabs {
		if tab.ID == active {
			continue
		}
		if box := f.box("core.card.tab", tab.ID); box.W != 0 || box.H != 0 {
			t.Fatalf("the hidden tab %s has the box %+v", tab.ID, box)
		}
	}
}

// The line above the foot of a card and the line below its head are the edge of the card, and the rule of the plane when the cards share one line.
func TestTheLinesOfACardFollowItsSeam(t *testing.T) {
	f := narrowCard(t, 1, "a")
	f.settle()
	line := func(box ui.Rect, y float32) color.RGBA { return f.pixelOf(box.X+box.W/2, y) }
	edge, rule := color.RGBA{0x2b, 0x2e, 0x3d, 0xff}, color.RGBA{0x22, 0x24, 0x2f, 0xff}
	foot, head := f.box("core.card.status", "other"), f.box("core.card.header", "other")
	if got := line(foot, foot.Y); got != edge {
		t.Errorf("the line above the foot is %v, want %v", got, edge)
	}
	if got := line(head, head.Y+head.H-0.5); got != edge {
		t.Errorf("the line below the head is %v, want %v", got, edge)
	}
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"gap": 0}})
	f.settle()
	foot, head = f.box("core.card.status", "other"), f.box("core.card.header", "other")
	if got := line(foot, foot.Y); got != rule {
		t.Errorf("at a seam the line above the foot is %v, want %v", got, rule)
	}
	if got := line(head, head.Y+head.H-0.5); got != rule {
		t.Errorf("at a seam the line below the head is %v, want %v", got, rule)
	}
}

// inkEnd is where the ink of a name ends in a box: the end of the last column before the given end that holds a pixel other than the fill of the box.
// The name lies at the start of the box, and its padding ends the box in its fill.
func (f *shellFixture) inkEnd(box ui.Rect, before float32) float32 {
	f.t.Helper()
	image := f.tester.Image()
	scale := float32(image.Bounds().Dx()) / f.tester.ElementTree()[0].Bounds.W
	fill := image.RGBAAt(int((box.X+box.W-2)*scale), int((box.Y+box.H/2)*scale))
	end := box.X
	for column := int((box.X + 2) * scale); column < int(before*scale); column++ {
		for row := int((box.Y + 2) * scale); row < int((box.Y+box.H-2)*scale); row++ {
			if image.RGBAAt(column, row) != fill {
				end = float32(column+1) / scale
				break
			}
		}
	}
	return end
}

// standsIn reports whether inner stands in outer, within the rounding of a layout.
func standsIn(inner, outer ui.Rect) bool {
	return inner.X >= outer.X-.01 && inner.Y >= outer.Y-.01 && inner.X+inner.W <= outer.X+outer.W+.01 && inner.Y+inner.H <= outer.Y+outer.H+.01
}

// The whole of a tab of a card is its button, as on the page: a press on its edge shows the tab, and its close button stands in it and
// only closes.
func TestTheWholeOfACardTabIsItsButton(t *testing.T) {
	f, card, tab, _ := cardWithTwoTabs(t)
	first := f.tabsOf(card)[0].(map[string]any)["id"].(string)
	f.run("core.tab.select", map[string]string{"tab": first})
	f.settle()
	box, closing := f.box("core.card.tab", tab), f.box("core.card.tab-close", tab)
	if !standsIn(closing, box) {
		t.Fatalf("the close button %+v stands out of the tab %+v", closing, box)
	}
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	pad, _ := declared.Metric("tab-pad-y")
	line, _ := declared.Metric("line-height")
	small, _ := declared.Metric("text-small-at-base")
	// A line box takes the whole points of its line height (docs/spec/settings.md#layout-values).
	if want := 2*pad + math.Floor(small*line+1e-3); math.Abs(float64(box.H)-want) > .01 {
		t.Fatalf("the tab is %v high, the page %v", box.H, want)
	}
	f.tester.ClickAt(box.X+1, box.Y+1)
	f.settle()
	if f.activeOf(card) != tab {
		t.Fatalf("a press on the edge of the tab shows %s", f.activeOf(card))
	}
	other := f.box("core.card.tab-close", first)
	f.tester.ClickAt(other.X+other.W/2, other.Y+other.H/2)
	f.settle()
	if hasTab(f, card, first) || f.activeOf(card) != tab {
		t.Fatalf("a press on the close button left %v showing %s", f.tabsOf(card), f.activeOf(card))
	}
}

// The whole of a chip of the bar is its button, so a press above its name shows the project.
func TestTheWholeOfAProjectTabIsItsButton(t *testing.T) {
	f, alpha, beta := twoProjects(t)
	shown := status[map[string]any](t, f, "core.project")["id"].(string)
	other := alpha
	if shown == alpha {
		other = beta
	}
	box, closing := f.box("core.project-tab", other), f.box("core.project-tab.close", other)
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	high, _ := declared.Metric("space-tab-h")
	if !standsIn(closing, box) || box.H != float32(high) {
		t.Fatalf("the tab %+v of height %v and its close button %+v", box, high, closing)
	}
	f.tester.ClickAt(box.X+1, box.Y+1)
	f.settle()
	if got := status[map[string]any](t, f, "core.project")["id"]; got != other {
		t.Fatalf("a press on the edge of the tab shows %v", got)
	}
}

// The line of a card keeps the side padding of the page.
func TestTheStatusLineStandsOnItsPadding(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := terminalSurface(t, stored)
	viewCall(t, f, stored, surface, "tab.footer", "short")
	found, ok := f.tester.Find("short")
	if !ok {
		t.Fatalf("the texts are %q", f.tester.Texts())
	}
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	pad, _ := declared.Metric("space-2")
	for _, card := range status[gridRead](t, f, "core.grid").Cards {
		if len(card.Tabs) == 0 || card.Tabs[0].ID != surface {
			continue
		}
		if got := found.X - f.box("core.card.status", card.ID).X; got != float32(pad) {
			t.Fatalf("the text stands %v from the start of the line, the page %v", got, pad)
		}
		return
	}
	t.Fatal("no card holds the surface")
}

// The name of a tab ends where its measured width ends, so the ink that the checks of a close button read is the ink of the name.
func TestTheInkOfTheNameOfATabIsAsWideAsTheName(t *testing.T) {
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	size, _ := declared.Metric("text-small-at-base")
	pad, _ := declared.Metric("tab-pad-x")
	catalog, err := workbench.ReadSettingsCatalog()
	if err != nil {
		t.Fatal(err)
	}
	f := narrowCard(t, 1, "title")
	stack := catalog.Stack(status[map[string]any](t, f, "core.settings")["values"].(map[string]any)["font"].(string))
	tab, closing := f.box("core.card.tab", "tab-000000"), f.box("core.card.tab-close", "tab-000000")
	node, ok := exposedNode(f.tester.ElementTree(), "core.card.tab", "tab-000000")
	if !ok {
		t.Fatal("no element of the tab")
	}
	plain := ui.NewTester(func(c *ui.Context) {
		ui.Row(c).Children(func() { ui.Text(c, node.Label).FontSize(float32(size)).Font(stack) })
	}, 1000, 100)
	bare, ok := nodeLabeled(plain.ElementTree(), node.Label)
	if !ok {
		t.Fatalf("no plain element of %q", node.Label)
	}
	end := f.inkEnd(tab, closing.X)
	if want := tab.X + float32(pad) + bare.Bounds.W; math.Abs(float64(end-want)) > 1.5 {
		t.Fatalf("the ink of %q ends at %v, its measured width ends at %v", node.Label, end, want)
	}
}

// The pointer over a tool of a card head is a hand, and over a tool that the head refuses it is the not-allowed cursor, as
// .chrome__act and .chrome__act:disabled of packages/workbench/app.css give the page.
func TestAToolOfACardHeadShowsItsCursor(t *testing.T) {
	f, left, _ := splitShell(t)
	cursorOver := func(name, item string) ui.Cursor {
		t.Helper()
		box := f.box(name, item)
		f.tester.Move(box.X+box.W/2, box.Y+box.H/2)
		f.tester.Frame()
		return f.tester.Cursor()
	}
	for _, name := range []string{"core.card.add", "core.card.split-x", "core.card.split-y", "core.card.fullscreen", "core.card.close"} {
		if got := cursorOver(name, left); got != ui.CursorPointer {
			t.Errorf("the cursor over %s is %v, want the hand %v", name, got, ui.CursorPointer)
		}
	}
	f.run("core.card.fullscreen", map[string]string{"card": left})
	f.settle()
	if got := cursorOver("core.card.close", left); got != ui.CursorNotAllowed {
		t.Errorf("the cursor over the close of a full screen card is %v, want the not-allowed cursor %v", got, ui.CursorNotAllowed)
	}
	if got := cursorOver("core.card.fullscreen", left); got != ui.CursorPointer {
		t.Errorf("the cursor over the restore of a full screen card is %v, want the hand %v", got, ui.CursorPointer)
	}
}
