//go:build e2e

package adapter_test

// Checks the input notice of a window of the mygo framework adapter: the workbench reads a pointer input in the next frame that it
// builds, so the notice that the host asks for after the delivery of a release runs once the workbench handled the click
// (docs/spec/exposure.md#methods). Input reaches a view only on a display, so this test is an end-to-end check
// (docs/operations/examples.md#test-kinds).

import (
	"slices"
	"testing"

	"github.com/egoist/mygo"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	"github.com/soksak-app/core/packages/host/mygo/tests/support"
)

func TestE2ETheInputNoticeOfAReleaseRunsAfterTheWorkbenchReadItsClick(t *testing.T) {
	_, scene, window := support.Open(t, "input")
	scene.Pressable()
	window.Show()
	support.Wait(t, "the show", window.Window().IsVisible, window.Window().OnShow)
	drawn := func() bool { return slices.Contains(scene.Received(), "draw input") }
	support.Wait(t, "the first draw of the scene", drawn, scene.OnRecord)
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	type answer struct {
		result  platform.PointerResult
		noticed error
		clicked bool
	}
	for _, phase := range []int{1, 3} {
		answered := make(chan answer, 1)
		var injected error
		// The delivery belongs to the main thread, as the delivery of input.pointer does, and the notice is asked for in the turn of the
		// answer of the delivery, before any frame of the window can follow it.
		mygo.RunOnMain(func() {
			injected = system.InjectPointer(window.NativeWindow(), "main", 200, 150, phase, 0, 0, 0, 1,
				func(result platform.PointerResult, _ platform.ButtonHeld, _ uintptr) {
					if result != platform.PointerDelivered {
						answered <- answer{result: result}
						return
					}
					if err := window.AfterInput(func(noticed error) {
						answered <- answer{result, noticed, slices.Contains(scene.Received(), "click input")}
					}); err != nil {
						answered <- answer{result, err, false}
					}
				})
		})
		if injected != nil {
			t.Fatal(injected)
		}
		got := <-answered
		if got.result != platform.PointerDelivered || got.noticed != nil {
			t.Fatalf("phase %d: the delivery answered %v and the input notice %v", phase, got.result, got.noticed)
		}
		if want := phase == 3; got.clicked != want {
			t.Fatalf("phase %d: the workbench had read the click %v at the input notice, want %v; records %v", phase, got.clicked, want,
				scene.Received())
		}
	}
}
