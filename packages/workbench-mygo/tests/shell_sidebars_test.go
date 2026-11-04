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
