package workbench_test

import "testing"

// A project tab of the top bar is a chip of the declared height project-chip-h (24 points), as the design of the project chip requires
// (docs/spec/projects.md#project-home).
func TestTheProjectTabChipIsTheDeclaredHeight(t *testing.T) {
	f := projectWithPlugins(t)
	tab := exposedNodeOf(f, "core.project-tab", "")
	if tab.Bounds.H != 24 {
		t.Fatalf("the project tab is %v points high, want the declared project-chip-h of 24", tab.Bounds.H)
	}
}
