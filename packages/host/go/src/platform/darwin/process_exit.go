//go:build darwin && diagnostics

package darwin

// Waits for the exit of a process. The implementation is process_exit.m of native/darwin. It is included only in diagnostic builds.

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo pkg-config: soksak-darwin
#include <stdbool.h>
#include <stdint.h>
#include "process_exit.h"
#include "main_thread.h"
#include "host_callbacks.h"

// The callback runs its Go function on the worker, and the native call runs on the main thread (main_thread.h).
static void answered(void *context, bool exited) {
    hostRunOnWorker(^{ sp_host_diagnostic_callback_process_exit_answered((uintptr_t)context, exited); });
}
static void whenExited(pid_t pid, double seconds, uintptr_t handle) {
    hostRunOnMain(^{ sp_process_when_exited(pid, seconds, answered, (void *)handle); });
}
*/
import "C"

import handles "github.com/soksak-app/core/packages/host/go/src/callback"

//export goHost_process_exit_answered
func goHost_process_exit_answered(handle C.uintptr_t, exited C.bool) {
	// handle is the value that WhenProcessExited created, and the library calls done once.
	h := handles.Handle(handle)
	done := h.Value().(func(bool))
	h.Delete()
	done(bool(exited))
}

// WhenProcessExited replies to done when the process pid ends or seconds pass. Call it in a main-thread step.
func (implementation) WhenProcessExited(pid int32, seconds float64, done func(bool)) {
	C.whenExited(C.pid_t(pid), C.double(seconds), C.uintptr_t(handles.NewHandle(done)))
}
