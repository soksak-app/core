package workbench_test

import (
	"testing"

	"github.com/egoist/mygo/ui"
	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// firstExposedInBar returns the name of the first exposed element inside the chrome bar, in tree order.
func firstExposedInBar(f *shellFixture) string {
	f.t.Helper()
	bar, ok := exposedNode(f.tester.ElementTree(), "core.chrome.bar", "")
	if !ok {
		f.t.Fatal("the window has no title bar")
	}
	var first string
	var walk func(nodes []ui.ElementNode) bool
	walk = func(nodes []ui.ElementNode) bool {
		for _, node := range nodes {
			if exposed, ok := node.Key.(workbench.Exposed); ok {
				first = exposed.Name
				return true
			}
			if walk(node.Children) {
				return true
			}
		}
		return false
	}
	walk(bar.Children)
	return first
}

// The title bar of the work screen shows the logo first, the four side switches and the settings button, and no other tool
// (docs/spec/external-sidebars.md#window-tools).
func TestTheWorkScreenTitleBarShowsTheLogoAndOnlyTheWindowTools(t *testing.T) {
	f, _, _ := twoProjects(t)
	for _, name := range []string{"core.chrome.projects", "core.chrome.left", "core.chrome.right", "core.chrome.top", "core.chrome.bottom", "core.chrome.settings"} {
		if !f.has(name, "") {
			t.Fatalf("the work screen has no %s", name)
		}
	}
	if first := firstExposedInBar(f); first != "core.chrome.projects" {
		t.Fatalf("the first element of the title bar is %s, want the logo core.chrome.projects", first)
	}
}

// The logo runs core.projects.browse, which shows the project home and keeps the work: the side switches leave the title bar.
func TestPressingTheLogoShowsTheProjectHome(t *testing.T) {
	f, _, _ := twoProjects(t)
	if !f.has("core.chrome.left", "") {
		t.Fatal("the work screen has no side switch before the press")
	}
	f.click("core.chrome.projects", "")
	if f.has("core.chrome.left", "") {
		t.Fatal("the side switch is still in the title bar after the logo opened the project home")
	}
	if !f.has("core.chrome.projects", "") || !f.has("core.chrome.settings", "") {
		t.Fatal("the project home lost the logo or the settings button")
	}
}

// The project home shows the logo and only the settings button as the window tools (docs/spec/external-sidebars.md#window-tools).
func TestTheProjectHomeTitleBarShowsTheLogoAndSettingsOnly(t *testing.T) {
	f, _, _ := homeOfTwoProjects(t)
	for _, name := range []string{"core.chrome.projects", "core.chrome.settings"} {
		if !f.has(name, "") {
			t.Fatalf("the project home title bar has no %s", name)
		}
	}
	for _, name := range []string{"core.chrome.left", "core.chrome.right", "core.chrome.top", "core.chrome.bottom"} {
		if f.has(name, "") {
			t.Fatalf("the project home title bar shows %s", name)
		}
	}
}
