//go:build darwin && diagnostics

package darwin

// Waits for the exit of a process. The implementation is process_exit.m of native/darwin. It is included only in diagnostic builds.

import handles "github.com/soksak-app/core/packages/host/go/src/callback"

func goHost_process_exit_answered(handle uintptr, exited bool) {
	// handle is the value that WhenProcessExited created, and the library calls done once.
	h := handles.Handle(handle)
	done := h.Value().(func(bool))
	h.Delete()
	done(bool(exited))
}

// WhenProcessExited replies to done when the process pid ends or seconds pass. Call it in a main-thread step.
func (implementation) WhenProcessExited(pid int32, seconds float64, done func(bool)) {
	diagnosticNative.WhenExited(int32(pid), float64(seconds), uintptr(handles.NewHandle(done)))
}
