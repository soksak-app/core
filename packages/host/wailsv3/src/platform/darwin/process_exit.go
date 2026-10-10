//go:build darwin && diagnostics

package darwin

// Waits for the exit of a process. The implementation is process_exit.m of native/darwin. It is included only in diagnostic builds.

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo pkg-config: soksak-darwin
#include <stdbool.h>
#include <stdint.h>
#include "process_exit.h"

extern void processExitAnswered(uintptr_t handle, bool exited);
static void answered(void *context, bool exited) { processExitAnswered((uintptr_t)context, exited); }
static void whenExited(pid_t pid, double seconds, uintptr_t handle) {
    sp_process_when_exited(pid, seconds, answered, (void *)handle);
}
*/
import "C"

import "runtime/cgo"

//export processExitAnswered
func processExitAnswered(handle C.uintptr_t, exited C.bool) {
	// handle is the value that WhenProcessExited created, and the library calls done once.
	h := cgo.Handle(handle)
	done := h.Value().(func(bool))
	h.Delete()
	done(bool(exited))
}

// WhenProcessExited replies to done when the process pid ends or seconds pass. Call it on the main thread.
func (implementation) WhenProcessExited(pid int32, seconds float64, done func(bool)) {
	C.whenExited(C.pid_t(pid), C.double(seconds), C.uintptr_t(cgo.NewHandle(done)))
}
