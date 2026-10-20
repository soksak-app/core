package host

import "sync/atomic"

// processLockHook is the function that SetProcessLockHook declares.
var processLockHook atomic.Pointer[func()]

// SetProcessLockHook declares the function that the acquisition of the process lock calls when it finds a lock file that an earlier
// owner left, before it claims the file (docs/spec/endpoint.md#discovery). A test starts a second acquisition from it, which places
// the race of two starters at a known point. nil removes the function.
func SetProcessLockHook(hook func()) {
	processLockHook.Store(&hook)
}
