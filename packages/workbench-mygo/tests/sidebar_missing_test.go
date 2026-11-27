package workbench_test

import (
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The window sidebar of a set with a section of a plugin that is not loaded draws the line of that plugin: the element
// core.sidebar.missing of the plugin, with its text (docs/spec/plugins.md#missing-plugins).
func TestTheMissingSectionOfAWindowSidebarShowsItsLine(t *testing.T) {
	f := newTabShell(t, &storedHost{installed: sidebarsInstalled, environment: []byte(sidebarsEnvironment),
		projects: []map[string]any{gridProject(oneCard(tab("tab-aaaaaa", "plain")))}})
	f.open(t)
	if _, ok := exposedNode(f.tester.ElementTree(), "core.sidebar.missing", "gone"); !ok {
		t.Fatal("no line of the plugin gone")
	}
	if !f.tester.HasText("gone(gone) 플러그인이 없어 섹션 1개를 못 보여 준다.") {
		t.Fatalf("the sidebar shows %q", f.tester.Texts())
	}
}

// The warning line of a window sidebar stands in its status line at the bottom, and no line stands above its sections
// (docs/spec/external-sidebars.md#sidebar-head-and-edge, docs/spec/plugins.md#missing-plugins).
func TestTheMissingLineOfAWindowSidebarStandsInItsStatusLine(t *testing.T) {
	f := newSidebars(t, sidebarsEnvironment, sidebarsInstalled)
	var failed error
	tt := ui.NewTester(func(c *ui.Context) {
		f.sidebars.Begin()
		frame, err := f.sidebars.Frame("left", "spc-1", workbench.FocusedSurface{})
		if err != nil {
			failed = err
			return
		}
		f.sidebars.Draw(c, frame, layout.Rect{X: 10, Y: 20, W: 190, H: 480})
	}, 320, 520)
	if failed != nil {
		t.Fatal(failed)
	}
	status := element(t, tt, "core.sidebar.status", "left")
	if _, ok := exposedNode(status.Children, "core.sidebar.missing", "gone"); !ok {
		t.Fatalf("the status line of the sidebar has no line of the plugin gone; the texts are %q", tt.Texts())
	}
	set := element(t, tt, "core.sidebar", "left")
	if _, ok := exposedNode(set.Children, "core.sidebar.missing", "gone"); ok {
		t.Fatal("a warning line stands above the sections of the sidebar")
	}
	if !tt.HasText("gone(gone) 플러그인이 없어 섹션 1개를 못 보여 준다.") {
		t.Fatalf("the sidebar shows %q", tt.Texts())
	}
}

// The line of a plugin counts each of its missing sections, and a plugin in a state without a remedy has no line, as the page
// reports it (docs/spec/plugins.md#missing-plugins).
func TestTheMissingLineCountsEverySectionOfAPlugin(t *testing.T) {
	frame := workbench.SidebarFrame{Missing: []workbench.MissingSection{{ID: "gone.a", Plugin: "gone"}, {ID: "gone.b", Plugin: "gone"}}}
	lines := workbench.MissingLines(frame, func(string) workbench.PluginLine { return workbench.PluginLine{Name: "고", State: "available"} })
	if len(lines) != 1 || lines[0].Count != 2 || lines[0].Text != "고(gone) 플러그인이 없어 섹션 2개를 못 보여 준다." {
		t.Fatalf("the lines are %+v", lines)
	}
	lines = workbench.MissingLines(frame, func(string) workbench.PluginLine { return workbench.PluginLine{Name: "고", State: "reload"} })
	if len(lines) != 0 {
		t.Fatalf("a reloading plugin has the lines %+v", lines)
	}
}
