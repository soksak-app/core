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
	if name := element(t, f.tester, "core.sidebar.section.name", "left/files.tree"); name.Label != "파일 트리" {
		t.Fatalf("the name of the section is %q", name.Label)
	}
	element(t, f.tester, "core.sidebar.section.name", "left/files.bookmarks")
	// Texts lists the text of a line and its label.
	lines := 0
	for _, text := range f.tester.Texts() {
		if text == "오른쪽 창 사이드바" {
			lines++
		}
	}
	if lines != 2 {
		t.Fatalf("a window sidebar shows the status line %d times, want its text and its label: %q", lines, f.tester.Texts())
	}
	if status := element(t, f.tester, "core.sidebar.status", "right"); status.Label != "오른쪽 창 사이드바" {
		t.Fatalf("the status line says %q", status.Label)
	}
	left := element(t, f.tester, "core.card", "left")
	if left.Bounds.W != 190 {
		t.Fatalf("the left sidebar is %+v", left.Bounds)
	}
}

// A window sidebar ends in one status line, on the bottom edge inside its border, as the foot of a card does.
func TestAWindowSidebarHasOneStatusLineAtItsBottom(t *testing.T) {
	f := sidebarShell(t)
	for side, label := range map[string]string{"left": "왼쪽 창 사이드바", "right": "오른쪽 창 사이드바"} {
		card, status := element(t, f.tester, "core.card", side), element(t, f.tester, "core.sidebar.status", side)
		if status.Bounds.Y+status.Bounds.H != card.Bounds.Y+card.Bounds.H-cardBorder {
			t.Fatalf("the status line of %s is %+v in the card %+v", side, status.Bounds, card.Bounds)
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
			t.Fatalf("the sidebar %s has %d status lines, and says %q", side, lines, status.Label)
		}
	}
}

// The fold control closes the window sidebar, and the cards and the view of each card take its room.
func TestTheFoldControlGivesTheRoomOfASidebarToTheCards(t *testing.T) {
	f := sidebarShell(t)
	card := f.tabbedCards()[0]
	before := element(t, f.tester, "core.card", card).Bounds
	press(t, f.tester, "core.sidebar.fold", "left")
	f.settle()
	if f.has("core.sidebar.status", "left") {
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
	if f.has("core.sidebar.status", "right") {
		t.Fatal("a new space shows the hidden sidebar")
	}
	element(t, f.tester, "core.sidebar.status", "left")
}

// The control of a side in the chrome shows and hides the window sidebar of that side.
func TestTheChromeShowsAndHidesASidebar(t *testing.T) {
	f := sidebarShell(t)
	f.click("core.chrome.right", "")
	f.settle()
	if f.has("core.sidebar.status", "right") {
		t.Fatal("the right sidebar still stands")
	}
	f.click("core.chrome.right", "")
	f.settle()
	element(t, f.tester, "core.sidebar.status", "right")
}

func TestAFoldedSectionIsStoredWithTheSpace(t *testing.T) {
	f := sidebarShell(t)
	f.run("core.sidebar.section.fold", map[string]string{"sidebar": "left", "section": "files.tree"})
	f.settle()
	if _, ok := keyed(f.tester.ElementTree(), "core.sidebar.section.divider", "left/files.bookmarks"); ok {
		t.Fatal("a divider lies next to the folded section")
	}
	encoded, err := json.Marshal(f.host.projects[0]["spaces"])
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `folded\":[\"files.tree\"]`) && !strings.Contains(string(encoded), `"folded":["files.tree"]`) {
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

// The library draws no sidebar, so the sections of the fixed sidebars leave the placement while it is shown, and the return seats them
// again. The page empties the plane for the library, and its placement holds the tabs alone, hidden (TestLibraryHidesTheViews).
func TestTheLibraryLeavesTheSectionsOfTheSidebars(t *testing.T) {
	f, stored := surfaceShellOf(t, sidebarsInstalled)
	sections := func() (ids []string) {
		for id := range stored.lastSurfaces(t) {
			if strings.Contains(id, "/left/") || strings.Contains(id, "/right/") {
				ids = append(ids, id)
			}
		}
		return ids
	}
	shown := sections()
	if len(shown) == 0 {
		t.Fatal("the workspace places no section")
	}
	f.run("core.projects.browse", nil)
	if under := sections(); len(under) != 0 {
		t.Fatalf("the library places the sections %q", under)
	}
	f.run("core.library.return", nil)
	if back := sections(); len(back) != len(shown) {
		t.Fatalf("the return places the sections %q, want %q", back, shown)
	}
}
