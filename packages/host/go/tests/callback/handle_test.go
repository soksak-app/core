package callback_test

import (
	"runtime"
	"sync"
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/callback"
)

func rejects(t *testing.T, operation func()) {
	t.Helper()
	defer func() {
		if recover() == nil {
			t.Error("an invalid callback handle was accepted")
		}
	}()
	operation()
}

func TestAHandleRetainsItsGoCallbackUntilDeleted(t *testing.T) {
	value := 17
	handle := callback.NewHandle(func() int { return value })
	if handle == 0 {
		t.Fatal("the callback received the zero sentinel")
	}
	runtime.GC()
	if got := handle.Value().(func() int)(); got != 17 {
		t.Fatalf("the retained callback returned %d, want 17", got)
	}
	value = 31
	if got := handle.Value().(func() int)(); got != 31 {
		t.Fatalf("the callback lost its Go state: got %d, want 31", got)
	}
	handle.Delete()
	rejects(t, func() { handle.Value() })
	rejects(t, func() { handle.Delete() })
}

func TestTheZeroCallbackHandleIsInvalid(t *testing.T) {
	rejects(t, func() { callback.Handle(0).Value() })
	rejects(t, func() { callback.Handle(0).Delete() })
}

func TestANilCallbackValueIsDistinctFromAnInvalidHandle(t *testing.T) {
	handle := callback.NewHandle(nil)
	defer handle.Delete()
	if got := handle.Value(); got != nil {
		t.Fatalf("the nil value became %v", got)
	}
}

func TestDeletedCallbackHandlesNeverNameANewerCallback(t *testing.T) {
	old := callback.NewHandle("old")
	old.Delete()
	current := callback.NewHandle("current")
	defer current.Delete()
	if current == old {
		t.Fatal("a deleted token was reused for another callback")
	}
	rejects(t, func() { old.Value() })
	if got := current.Value(); got != "current" {
		t.Fatalf("the current callback changed: %v", got)
	}
}

func TestConcurrentCallbackOwnersKeepSeparateHandles(t *testing.T) {
	const owners = 64
	var group sync.WaitGroup
	group.Add(owners)
	for owner := range owners {
		go func() {
			defer group.Done()
			for range 128 {
				handle := callback.NewHandle(owner)
				if got := handle.Value(); got != owner {
					t.Errorf("callback owner %d read %v", owner, got)
				}
				handle.Delete()
			}
		}()
	}
	group.Wait()
}
