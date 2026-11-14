//go:build diagnostics

// The fault injection point of the read of the window state by the attach of a region. It is compiled only with the diagnostics build tag;
// the release build has the no-op counterpart in window_on_screen_fault_release.go.

package host

import (
	"errors"
	"os"
)

// faultWindowOnScreen is the fault injection point of readOnScreen. Its value fail makes the read fail after the platform call returned,
// with the failure of the window state read. docs/operations/examples.md#test-kinds
const faultWindowOnScreen = "SOKSAK_FAULT_WINDOW_ON_SCREEN"

// windowOnScreenFault returns the failure that the fault point injects into the read of the window state, or nil.
func windowOnScreenFault() error {
	if os.Getenv(faultWindowOnScreen) == "fail" {
		return errors.New("the window state cannot be read")
	}
	return nil
}
