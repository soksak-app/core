package workbench_test

import (
	"fmt"
	"image/color"
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
