// The fixed sidebars of the window in the plane of a project (docs/spec/plugins.md#sections).
package workbench_test

import (
	"encoding/json"
	"strings"
	"testing"
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
	if status := element(t, f.tester, "core.sidebar.status", "right"); status.Label != "오른쪽 창 사이드바" {
		t.Fatalf("the status line says %q", status.Label)
	}
	left := element(t, f.tester, "core.card", "left")
	if left.Bounds.W != 190 {
		t.Fatalf("the left sidebar is %+v", left.Bounds)
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
