//go:build e2e

package adapter_test

// Checks that native pointer input reaches a window of the mygo framework adapter as the steps that diagnostics.drag times. Input
// reaches a view only on a display, so this test is an end-to-end check (docs/operations/examples.md#test-kinds).

import (
	"testing"

	"github.com/egoist/mygo"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform"
	"github.com/soksak-app/core/packages/host/mygo/tests/support"
)

func TestE2EEachDeliveredDragIsOneStepOfItsCallback(t *testing.T) {
	framework, _, window := support.Open(t, "drag")
	window.Show()
	support.Wait(t, "the show", window.Window().IsVisible, window.Window().OnShow)
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
		// The delivery belongs to the main thread, as the delivery of input.pointer does.
		done := make(chan platform.PointerResult, 1)
		var injected error
		mygo.RunOnMain(func() {
			injected = system.InjectPointer(window.NativeWindow(), "main", input.x, 100, input.phase, 0, 0, 0, 1, func(result platform.PointerResult, _ platform.ButtonHeld) {
				done <- result
			})
		})
		if injected != nil {
			t.Fatal(injected)
		}
		if result := <-done; result != platform.PointerDelivered {
			var hit string
			mygo.RunOnMain(func() { hit, _ = system.WindowHit(window.NativeWindow(), input.x, 100) })
			t.Fatalf("phase %d at %v: the delivery answered %v, the window finds %s", input.phase, input.x, result, hit)
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
