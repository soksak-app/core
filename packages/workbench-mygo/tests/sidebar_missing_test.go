package workbench_test

import (
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The window sidebar of a set with a section of a plugin that is not loaded shows the warning of that plugin as its notice, with the title
// and the text (docs/spec/plugins.md#missing-plugins).
func TestTheMissingSectionOfAWindowSidebarShowsItsLine(t *testing.T) {
	f := newTabShell(t, &storedHost{installed: sidebarsInstalled, environment: []byte(sidebarsEnvironment),
		projects: []map[string]any{gridProject(oneCard(tab("tab-aaaaaa", "plain")))}})
	f.open(t)
	if !f.tester.HasText("gone 플러그인이 없어 섹션 1개를 못 보여 준다.") {
		t.Fatalf("the sidebar shows %q", f.tester.Texts())
	}
}

// The warning of a window sidebar is one line at the top of the sidebar, with the element core.sidebar.missing of its plugin, and no
// status line notice (docs/spec/external-sidebars.md#sidebar-head-and-edge, docs/spec/plugins.md#missing-plugins).
func TestTheMissingLineOfAWindowSidebarStandsAtItsTop(t *testing.T) {
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
	element(t, tt, "core.sidebar.status", "left")
	element(t, tt, "core.sidebar.missing", "left:gone")
	if !tt.HasText("gone 플러그인이 없어 섹션 1개를 못 보여 준다.") {
		t.Fatalf("the sidebar shows %q", tt.Texts())
	}
}

// The line of a plugin counts each of its missing sections, and a plugin in a state without a remedy has no line, as the page
// reports it (docs/spec/plugins.md#missing-plugins).
func TestTheMissingLineCountsEverySectionOfAPlugin(t *testing.T) {
	frame := workbench.SidebarFrame{Missing: []workbench.MissingSection{{ID: "gone.a", Plugin: "gone"}, {ID: "gone.b", Plugin: "gone"}}}
	lines := workbench.MissingLines(frame, func(string) workbench.PluginLine { return workbench.PluginLine{Name: "고", State: "available"} })
	if len(lines) != 1 || lines[0].Count != 2 || lines[0].Title != "고(gone)" || lines[0].Text != "플러그인이 없어 섹션 2개를 못 보여 준다." {
		t.Fatalf("the lines are %+v", lines)
	}
	lines = workbench.MissingLines(frame, func(string) workbench.PluginLine { return workbench.PluginLine{Name: "고", State: "reload"} })
	if len(lines) != 0 {
		t.Fatalf("a reloading plugin has the lines %+v", lines)
	}
}
