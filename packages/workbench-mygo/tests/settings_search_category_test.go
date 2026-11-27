package workbench_test

import (
	"slices"
	"testing"
)

// The search of Installed matches a plugin by the name of one of its plugin categories (docs/spec/settings.md#plugins).
func TestTheSearchMatchesAPluginByTheNameOfItsCategory(t *testing.T) {
	document := `{"plugins":[` + categoryPlugin("term-a", `,"categories":["terminal"]`) + `]}`
	f := categoryShell(t, enabledPlugins("term-a"), document)
	f.run("core.settings.open", nil)
	f.run("core.settings-tab.nav", map[string]string{"page": "installed"})
	f.run("core.settings-tab.search", map[string]string{"query": "terminal"})
	if want := []string{"term-a"}; !slices.Equal(f.tabStatus().Listed, want) {
		t.Fatalf("the search lists %v, want %v", f.tabStatus().Listed, want)
	}
}
