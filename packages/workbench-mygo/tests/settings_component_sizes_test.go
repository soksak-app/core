package workbench_test

import (
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// The search field is an input control, so its box is the field height of the declaration, 28 px (docs/spec/settings.md#controls).
func TestTheSearchFieldOfTheSettingsIsAFieldHeight(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]string{"page": "look"})
	f.settle()
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	want, _ := declared.Metric("field-h")
	node, ok := exposedNode(f.tester.ElementTree(), "core.settings-tab.find", "find")
	if !ok {
		t.Fatalf("no search field in %q", f.tester.Texts())
	}
	if got := node.Bounds.H; got != float32(want) {
		t.Fatalf("the search field is %v high, not the field height %v", got, want)
	}
}

// A select is an input control of the field height and the control column width (docs/spec/settings.md#rows).
func TestTheSelectOfTheLookPageIsAFieldHeightInTheControlColumn(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]string{"page": "look"})
	f.settle()
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	height, _ := declared.Metric("field-h")
	width, _ := declared.Metric("set-control-w")
	node, ok := exposedNode(f.tester.ElementTree(), "core.settings-tab.choice", "font")
	if !ok {
		t.Fatalf("no select of the font in %q", f.tester.Texts())
	}
	if node.Bounds.H != float32(height) || node.Bounds.W != float32(width) {
		t.Fatalf("the font select is %vx%v, not %vx%v", node.Bounds.W, node.Bounds.H, width, height)
	}
}
