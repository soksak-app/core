//go:build darwin

package darwin

import (
	"sync"
	"testing"

	handles "github.com/soksak-app/core/packages/host/go/src/callback"
	"github.com/soksak-app/core/packages/host/go/src/platform"
	"github.com/soksak-app/core/packages/host/go/src/platform/darwin/abi"
)

// An injection is a step of the main thread, and the delivery of an earlier injection comes in a later step, so an injection
// returns without waiting for that delivery; the native library orders the injections (docs/spec/exposure.md#named-pointers).
// contract: endpoint.input.pointer-injection-does-not-wait-for-earlier-delivery
func TestAnInjectionReturnsBeforeTheDeliveryOfTheInjectionBeforeIt(t *testing.T) {
	saved := native.InjectPointer
	t.Cleanup(func() { native.InjectPointer = saved })
	var mu sync.Mutex
	var handles []uintptr
	native.InjectPointer = func(_ uintptr, pointer *byte, _, _ float64, _, _ int32, _, _ float64, _ int32, handle uintptr) {
		mu.Lock()
		defer mu.Unlock()
		handles = append(handles, handle)
	}
	var results []platform.PointerResult
	done := func(result platform.PointerResult, _ platform.ButtonHeld) {
		mu.Lock()
		defer mu.Unlock()
		results = append(results, result)
	}
	if err := (implementation{}).InjectPointer(1, "main", 10, 10, 1, 0, 0, 0, 1, done); err != nil {
		t.Fatal(err)
	}
	// The second injection returns while the first is not delivered: its return is the event. An injection that waits for
	// the delivery never returns, and the runner reports the stop.
	if err := (implementation{}).InjectPointer(1, "main", 10, 10, 3, 0, 0, 0, 1, done); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	given := append([]uintptr(nil), handles...)
	mu.Unlock()
	if len(given) != 2 {
		t.Fatalf("the library received %d injections, want 2", len(given))
	}
	goHost_input_delivered(given[0], abi.SP_INPUT_DELIVERED, nil)
	goHost_input_delivered(given[1], abi.SP_INPUT_INACTIVE, nil)
	mu.Lock()
	defer mu.Unlock()
	if len(results) != 2 || results[0] != platform.PointerDelivered || results[1] != platform.PointerInactive {
		t.Fatalf("the injections answered %v, want each its own delivery once", results)
	}
}

// A press on a resize edge of the window is refused by the library with a message that names the point and the edge, and the
// host answers that message unchanged (docs/spec/exposure.md#methods).
// contract: endpoint.input.resize-edge-refusal
func TestAResizeEdgeRefusalCarriesTheMessageOfTheLibrary(t *testing.T) {
	message := "the point (200, 299) lies on the bottom resize edge of the window, where AppKit tracks a press as a window resize; the synthetic press was not delivered"
	reason := append([]byte(message), 0)
	var result platform.PointerResult
	var held platform.ButtonHeld
	handle := handles.NewHandle(func(got platform.PointerResult, state platform.ButtonHeld) { result, held = got, state })
	goHost_input_delivered(uintptr(handle), abi.SP_INPUT_RESIZE_EDGE, &abi.SpInputHeld{Pid: -1, Reason: &reason[0]})
	if result != platform.PointerResizeEdge || held.Reason != message {
		t.Fatalf("the refusal answered %v with %+v, want PointerResizeEdge with the message %q", result, held, message)
	}
}

// A drag or a release of a gesture that the press of a person ended is refused by the library with a message that names that press
// and the point where the gesture was released, and the host answers that message unchanged (docs/spec/exposure.md#named-pointers).
// contract: endpoint.input.interruption
func TestAnInterruptionCarriesTheMessageOfTheLibrary(t *testing.T) {
	message := "a person's down of the left button at (100, 80) in the window of the gesture ended the synthetic gesture of pointer a, whose press was released at (60, 50)"
	reason := append([]byte(message), 0)
	var result platform.PointerResult
	var held platform.ButtonHeld
	handle := handles.NewHandle(func(got platform.PointerResult, state platform.ButtonHeld) { result, held = got, state })
	goHost_input_delivered(uintptr(handle), abi.SP_INPUT_INTERRUPTED, &abi.SpInputHeld{Pid: -1, Reason: &reason[0]})
	if result != platform.PointerInterrupted || held.Reason != message {
		t.Fatalf("the interruption answered %v with %+v, want PointerInterrupted with the message %q", result, held, message)
	}
}
