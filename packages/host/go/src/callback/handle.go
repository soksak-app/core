// Package callback owns Go values that native code refers to by integer tokens.
// A token is never a Go pointer. Its owner deletes it after native code stops using it.
// runtime/cgo.Handle cannot provide this contract to a cgo-free build: that package
// links foreign runtime symbols even when only its handle operations are imported.
package callback

import (
	"fmt"
	"sync"
	"sync/atomic"
)

// Handle identifies one live Go value. Zero is invalid and may be used as a native sentinel.
type Handle uintptr

var sequence atomic.Uintptr
var values sync.Map

// NewHandle retains value until Delete. Tokens are not reused when a value is deleted.
func NewHandle(value any) Handle {
	for {
		last := sequence.Load()
		if last == ^uintptr(0) {
			panic("callback handle space is exhausted")
		}
		id := last + 1
		if sequence.CompareAndSwap(last, id) {
			values.Store(id, value)
			return Handle(id)
		}
	}
}

// Value returns the retained value, or panics for an invalid or deleted handle.
func (handle Handle) Value() any {
	value, live := values.Load(uintptr(handle))
	if !live {
		panic(fmt.Errorf("callback handle %d is not live", handle))
	}
	return value
}

// Delete releases the value after its last native use. A second deletion is invalid.
func (handle Handle) Delete() {
	if _, live := values.LoadAndDelete(uintptr(handle)); !live {
		panic(fmt.Errorf("callback handle %d is not live", handle))
	}
}
