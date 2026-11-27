// The fixed sidebars of the window in the plane of a project (docs/spec/plugins.md#sections).
package workbench_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
)

func sidebarShell(t *testing.T) *shellFixture {
	t.Helper()
	f, _ := surfaceShellOf(t, sidebarsInstalled)
	return f
}

func TestAProjectShowsTheFixedSidebarsOfTheEnvironment(t *testing.T) {
	f := sidebarShell(t)
	if name := element(t, f.tester, "core.sidebar.section.name", "left/fieldprobe.tree"); name.Label != "파일 트리" {
		t.Fatalf("the name of the section is %q", name.Label)
	}
	element(t, f.tester, "core.sidebar.section.name", "left/fieldprobe.bookmarks")
	// The head of a window sidebar shows its place in sidebarOrder, and its label names the side.
	if head := element(t, f.tester, "core.sidebar.head", "right"); len(head.Text) != 1 || head.Text < "1" || head.Text > "4" {
		t.Fatalf("the head of the right sidebar shows %q, want its place", head.Text)
	}
	if status := element(t, f.tester, "core.sidebar.head", "right"); status.Label != "오른쪽 창 사이드바" {
		t.Fatalf("the status line says %q", status.Label)
	}
	left := element(t, f.tester, "core.card", "left")
	if left.Bounds.W != 190 {
		t.Fatalf("the left sidebar is %+v", left.Bounds)
	}
}

// A window sidebar has one head, in the top row inside its border, and no status line at its bottom
// (docs/spec/external-sidebars.md#sidebar-head-and-edge).
func TestAWindowSidebarHasOneHeadAtItsTop(t *testing.T) {
	f := sidebarShell(t)
	for side, label := range map[string]string{"left": "왼쪽 창 사이드바", "right": "오른쪽 창 사이드바"} {
		card, status := element(t, f.tester, "core.card", side), element(t, f.tester, "core.sidebar.head", side)
		top := card.Bounds.Y + cardBorder
		if status.Bounds.Y < top || status.Bounds.Y+status.Bounds.H > top+headRow(t) {
			t.Fatalf("the head of %s is %+v in the card %+v", side, status.Bounds, card.Bounds)
		}
		lines := 0
		var walk func(nodes []ui.ElementNode)
		walk = func(nodes []ui.ElementNode) {
			for _, node := range nodes {
				if node.Role == ui.RoleStatus && node.Bounds.X >= card.Bounds.X && node.Bounds.X < card.Bounds.X+card.Bounds.W {
					lines++
				}
				walk(node.Children)
			}
		}
		walk(f.tester.ElementTree())
		if lines != 1 || status.Label != label {
			t.Fatalf("the sidebar %s has %d head lines, and says %q", side, lines, status.Label)
		}
	}
}

// The fold control closes the window sidebar, and the cards and the view of each card take its room.
func TestTheFoldControlGivesTheRoomOfASidebarToTheCards(t *testing.T) {
	f := sidebarShell(t)
	card := f.tabbedCards()[0]
	before := element(t, f.tester, "core.card", card).Bounds
	// The fold shows while the pointer is over its sidebar, as it does on the page.
	side := element(t, f.tester, "core.card", "left").Bounds
	f.tester.Move(side.X+side.W/2, side.Y+side.H/2)
	f.settle()
	press(t, f.tester, "core.sidebar.fold", "left")
	f.settle()
	if f.has("core.sidebar.head", "left") {
		t.Fatal("the left sidebar still stands")
	}
	after := element(t, f.tester, "core.card", card).Bounds
	if after.X >= before.X || after.W <= before.W {
		t.Fatalf("the card went from %+v to %+v", before, after)
	}
}

// A window sidebar that opens again has the width it folded with, and not the width of the setting.
func TestASidebarComesBackWithItsWidth(t *testing.T) {
	f := sidebarShell(t)
	before := element(t, f.tester, "core.card", "left").Bounds
	card := f.tabbedCards()[0]
	beside := element(t, f.tester, "core.card", card).Bounds
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"sidebarWidth": before.W + 40}})
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"left": false}})
	f.settle()
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"left": true}})
	f.settle()
	if got := element(t, f.tester, "core.card", "left").Bounds; got != before {
		t.Fatalf("the sidebar went from %+v to %+v", before, got)
	}
	if got := element(t, f.tester, "core.card", card).Bounds; got != beside {
		t.Fatalf("the card went from %+v to %+v", beside, got)
	}
}

// A project whose settings hide a sidebar opens without it, and a space keeps its width record while it does.
func TestASpaceOpensWithoutAHiddenSidebar(t *testing.T) {
	f := sidebarShell(t)
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"right": false}})
	f.settle()
	f.run("core.space.add", nil)
	f.settle()
	if f.has("core.sidebar.head", "right") {
		t.Fatal("a new space shows the hidden sidebar")
	}
	element(t, f.tester, "core.sidebar.head", "left")
}

// The control of a side in the chrome shows and hides the window sidebar of that side.
func TestTheChromeShowsAndHidesASidebar(t *testing.T) {
	f := sidebarShell(t)
	f.click("core.chrome.right", "")
	f.settle()
	if f.has("core.sidebar.head", "right") {
		t.Fatal("the right sidebar still stands")
	}
	f.click("core.chrome.right", "")
	f.settle()
	element(t, f.tester, "core.sidebar.head", "right")
}

func TestAFoldedSectionIsStoredWithTheSpace(t *testing.T) {
	f := sidebarShell(t)
	f.run("core.sidebar.section.fold", map[string]string{"sidebar": "left", "section": "fieldprobe.tree"})
	f.settle()
	if divider := element(t, f.tester, "core.sidebar.section.divider", "left/fieldprobe.bookmarks").Bounds; divider.W != 0 || divider.H != 0 {
		t.Fatalf("a divider next to the folded section has the place %+v", divider)
	}
	encoded, err := json.Marshal(f.host.projects[0]["spaces"])
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `folded\":[\"fieldprobe.tree\"]`) && !strings.Contains(string(encoded), `"folded":["fieldprobe.tree"]`) {
		t.Fatalf("the stored spaces are %s", encoded)
	}
}

func TestStatusOfTheShellReportsItsSidebars(t *testing.T) {
	f := sidebarShell(t)
	value, err := f.shell.Registry().Read("core.sidebars")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"sidebar":"left"`) {
		t.Fatalf("the status is %s", encoded)
	}
}

// core.grid reports the status line of a window sidebar card as the status of that card, as the page reports the text of the status
// line of each card.
func TestTheGridReportsTheStatusLineOfAWindowSidebar(t *testing.T) {
	f := sidebarShell(t)
	value, err := f.shell.Registry().Read("core.grid")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var grid struct {
		Cards []struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"cards"`
	}
	if err := json.Unmarshal(encoded, &grid); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"left": "왼쪽 창 사이드바", "right": "오른쪽 창 사이드바"}
	for _, card := range grid.Cards {
		if label, ok := want[card.ID]; ok {
			if line := element(t, f.tester, "core.sidebar.head", card.ID).Label; card.Status != label || card.Status != line {
				t.Fatalf("core.grid reports the status %q of the sidebar %s, whose status line says %q", card.Status, card.ID, line)
			}
			delete(want, card.ID)
		}
	}
	if len(want) > 0 {
		t.Fatalf("core.grid has no card of the sidebars %v: %s", want, encoded)
	}
}

// The project home draws no sidebar, so the sections of the fixed sidebars leave the placement while it is shown, and the return seats them
// again. The page empties the plane for the project home, and its placement holds the tabs alone, hidden.

// A project whose settings file holds a set that names a section its loaded plugin does not declare does not open: the command that
// opens it fails with that error, as the page refuses the project before it shows it (docs/spec/settings.md#stored-sets-and-links), and
// the window keeps the project that it showed.
func TestAProjectWithAnUnknownSectionInItsSetsDoesNotOpen(t *testing.T) {
	// The sets of the environment, the first of which names a section that the loaded fieldprobe does not declare.
	broken := []any{
		map[string]any{"id": "set-install", "title": "탐색기", "sections": []any{"fieldprobe.tree", "fieldprobe.gone"}, "layout": "list"},
		map[string]any{"id": "set-boxprobe", "title": "브라우저", "sections": []any{"boxprobe.tabs"}, "layout": "tabs"},
	}
	stored := &surfaceHost{storedHost: storedHost{folderSettings: map[string]map[string]any{"/work/broken": {"sets": broken}}}}
	f := surfaceShellOn(t, sidebarsInstalled, stored)
	before := status[map[string]any](t, f, "core.project")
	err := f.finish("core.project.open", map[string]string{"root": "/work/broken"})
	if err == nil || !strings.Contains(err.Error(), "settings: set set-install names unknown section fieldprobe.gone") {
		t.Fatalf("opening the project answered %v", err)
	}
	if after := status[map[string]any](t, f, "core.project"); after["id"] != before["id"] {
		t.Fatalf("the window shows %v after the refusal, %v before", after["id"], before["id"])
	}
}

// The rail groups read the plugin sets of the four window sides in their order, as railSidebars of the page does
// (docs/spec/external-sidebars.md#override-context-and-rail-border).
func TestTheRailGroupsHoldThePluginSetsOfTheFourWindowSides(t *testing.T) {
	f := sidebarShell(t)
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"top": true}, "scope": "common"})
	f.run("core.settings.link", map[string]any{"place": "window-top", "plugin": "boxprobe", "set": "set-page", "scope": "common"})
	type group struct {
		Card     string   `json:"card"`
		Sidebars []string `json:"sidebars"`
	}
	var found []group
	for _, card := range f.tabbedCards() {
		f.run("core.card.focus", map[string]string{"card": card})
		rail := status[struct {
			Groups []group `json:"groups"`
		}](t, f, "core.rail")
		found = append(found, rail.Groups...)
	}
	if len(found) != 1 || strings.Join(found[0].Sidebars, ",") != "right,top" {
		t.Fatalf("the rail groups are %+v, want one group of the sidebars right and top", found)
	}
}

// A window sidebar that its side holds through a plugin window link while the focused card belongs to another plugin shows no set and
// draws its status line; core.sidebars reports it with its rectangle and a null set (docs/spec/external-sidebars.md#override-context-and-rail-border).
func TestCoreSidebarsReportsAWindowSidebarThatShowsNoSet(t *testing.T) {
	f := sidebarShell(t)
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"top": true}, "scope": "common"})
	f.run("core.settings.link", map[string]any{"place": "window-top", "plugin": "boxprobe", "set": "set-page", "scope": "common"})
	type sidebar struct {
		Sidebar   string                 `json:"sidebar"`
		Set       *string                `json:"set"`
		Layout    *string                `json:"layout"`
		Placement string                 `json:"placement"`
		Plugin    *string                `json:"plugin"`
		Card      *string                `json:"card"`
		Rect      struct{ W, H float64 } `json:"rect"`
		Sections  []any                  `json:"sections"`
	}
	checked := 0
	for _, card := range f.tabbedCards() {
		f.run("core.card.focus", map[string]string{"card": card})
		f.settle()
		if status := element(t, f.tester, "core.sidebar.head", "top"); status.Label == "" {
			t.Fatal("the top sidebar shows no status line")
		}
		var top *sidebar
		for _, entry := range status[[]sidebar](t, f, "core.sidebars") {
			if entry.Sidebar == "top" {
				top = &entry
			}
		}
		if top == nil {
			t.Fatalf("core.sidebars omits the drawn top sidebar while %s has the focus: %s", card, f.status("core.sidebars"))
		}
		if top.Plugin != nil {
			continue
		}
		checked++
		if top.Set != nil || top.Layout != nil || top.Card != nil || top.Placement != "window" || len(top.Sections) != 0 || top.Rect.W <= 0 || top.Rect.H <= 0 {
			t.Fatalf("the top sidebar without a set is reported as %+v", *top)
		}
	}
	if checked == 0 {
		t.Fatal("no focused card left the top sidebar without a set")
	}
}

// A content card inside a group card keeps the rail of its overridden window sidebar: the rail joins the focused card and its sidebar,
// which a group frame and a gap separate, so it draws one outline around the card and one around the sidebar beside the focus ring of
// the card (docs/spec/external-sidebars.md#override-context-and-rail-border, docs/spec/groups.md#drawing).
func TestTheRailOfACardInsideAGroupCardOutlinesTheCardAndItsSidebarApart(t *testing.T) {
	f := sidebarShell(t)
	type group struct {
		Card     string   `json:"card"`
		Sidebars []string `json:"sidebars"`
	}
	type rail struct {
		Path   string  `json:"path"`
		Groups []group `json:"groups"`
	}
	railed := ""
	for _, card := range f.tabbedCards() {
		f.run("core.card.focus", map[string]string{"card": card})
		if groups := status[rail](t, f, "core.rail").Groups; len(groups) == 1 {
			railed = card
		}
	}
	if railed == "" {
		t.Fatal("no card of the fixture overrides a window sidebar")
	}
	f.run("core.group.create", map[string]string{"card": railed, "side": "right", "plugin": "boxprobe"})
	f.run("core.card.focus", map[string]string{"card": railed})
	f.settle()
	got := status[rail](t, f, "core.rail")
	if len(got.Groups) != 1 || got.Groups[0].Card != railed || strings.Join(got.Groups[0].Sidebars, ",") != "right" {
		t.Fatalf("with %s inside a group card the rail groups are %+v, want %s with the sidebar right", railed, got.Groups, railed)
	}
	if loops := strings.Count(got.Path, "M"); loops != 2 {
		t.Fatalf("the rail path draws %d outlines, want one around the card and one around the sidebar: %s", loops, got.Path)
	}
}
