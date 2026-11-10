//go:build darwin

package darwin

import (
	"sync"
	"testing"
	"time"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	"github.com/soksak-app/core/packages/host/go/src/platform/darwin/abi"
)

// An injection is a step of the main thread, and the delivery of an earlier injection comes in a later step, so an injection
// returns without waiting for that delivery; the native library orders the injections (docs/spec/exposure.md#named-pointers).
func TestAnInjectionReturnsBeforeTheDeliveryOfTheInjectionBeforeIt(t *testing.T) {
	saved := native.InjectPointer
	t.Cleanup(func() { native.InjectPointer = saved })
	var mu sync.Mutex
	var handles []uintptr
	native.InjectPointer = func(_ uintptr, pointer *byte, _, _ float64, _, _ int32, _, _ float64, _ int32, _ float64, handle uintptr) {
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
	if err := (implementation{}).InjectPointer(1, "main", 10, 10, 1, 0, 0, 0, 1, 1, done); err != nil {
		t.Fatal(err)
	}
	returned := make(chan error, 1)
	go func() { returned <- (implementation{}).InjectPointer(1, "main", 10, 10, 3, 0, 0, 0, 1, 1, done) }()
	select {
	case err := <-returned:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the second injection waited in its step for the delivery of the first, which only a later step can deliver")
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
