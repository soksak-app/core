package host

import "sync/atomic"

// processLockHook is the function that SetProcessLockHook declares.
var processLockHook atomic.Pointer[func(directory string)]

// SetProcessLockHook declares the function that the acquisition of the process lock calls with the configuration directory of the lock,
// when it has read the content of a lock file that was not locked, before it claims the file (docs/spec/endpoint.md#discovery). A test
// starts a second acquisition from it, which places the race of two starters at a known point. nil removes the function.
func SetProcessLockHook(hook func(directory string)) {
	processLockHook.Store(&hook)
}
