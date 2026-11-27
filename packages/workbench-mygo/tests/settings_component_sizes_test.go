package workbench_test

import (
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// The stepper of the text size is one input control, exposed as core.settings-tab.stepper, and its box is the field height of the
// declaration (docs/spec/settings.md#controls).
func TestTheSizeStepperOfTheLookPageIsOneFieldHeightBox(t *testing.T) {
	f := settingsMetricsPage(t, "look")
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	want, _ := declared.Metric("field-h")
	node, ok := exposedNode(f.tester.ElementTree(), "core.settings-tab.stepper", "size")
	if !ok {
		t.Fatalf("no stepper box of the text size in %q", f.tester.Texts())
	}
	if got := node.Bounds.H; got != float32(want) {
		t.Fatalf("the stepper box of the text size is %v high, not the field height %v", got, want)
	}
}
