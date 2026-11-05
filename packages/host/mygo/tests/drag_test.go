//go:build e2e

package adapter_test

// Checks that native pointer input reaches a window of the mygo framework adapter as the steps that diagnostics.drag times. Input
// reaches a view only on a display, so this test is an end-to-end check (docs/operations/examples.md#test-kinds).

import (
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform"
)

func TestE2EEachDeliveredDragIsOneStepOfItsCallback(t *testing.T) {
	framework, _, window := open(t, "drag")
	window.Show()
	wait(t, "the show", window.Window().IsVisible)
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	steps := []host.StepRecord{}
	stop := framework.RecordSteps(func(step host.StepRecord) {
		if step.Callback == "mouseDragged:" {
			steps = append(steps, step)
		}
	}, func(lost uint64) { t.Errorf("the recording lost %d steps", lost) })
	for _, input := range []struct {
		x     float64
		phase int
	}{{100, 1}, {110, 2}, {120, 2}, {120, 3}} {
		done := make(chan platform.PointerResult, 1)
		if err := system.InjectPointer(window.NativeWindow(), input.x, 100, input.phase, 0, 0, 0, 1, 1, func(result platform.PointerResult, _ platform.ButtonHeld) {
			done <- result
		}); err != nil {
			t.Fatal(err)
		}
		if result := <-done; result != platform.PointerDelivered {
			t.Fatalf("phase %d: the delivery answered %v", input.phase, result)
		}
	}
	stop()
	if len(steps) != 2 {
		t.Fatalf("two drags recorded %d steps of mouseDragged:", len(steps))
	}
	for _, step := range steps {
		if step.Kind != "selector" || step.Return < step.Entry || step.Entry == 0 {
			t.Fatalf("the step is %+v", step)
		}
	}
}
