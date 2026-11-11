//go:build darwin && diagnostics

package darwin

// The drive of a window by a check is implemented by sp_input_check_begin and sp_input_check_end in native/darwin.

import (
	"errors"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// DriveInput starts the drive of the window by a check: until EndInput the window takes only the pointer input of the check
// (diagnostics.drag, docs/spec/endpoint.md#diagnostic-builds). Call it in a main-thread step.
func (implementation) DriveInput(window platform.Window) error {
	if !diagnosticNative.MainSpInputCheckBegin(uintptr(window)) {
		return errors.New("a check already drives the window")
	}
	return nil
}

// EndInput ends the drive of the window and returns the number of pointer events of a person that the window did not take.
// Call it in a main-thread step.
func (implementation) EndInput(window platform.Window) uint64 {
	return diagnosticNative.MainSpInputCheckEnd(uintptr(window))
}
