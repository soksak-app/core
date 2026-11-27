package workbench_test

import "testing"

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
