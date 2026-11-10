//go:build windows && diagnostics

package windows

import (
	"errors"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// WindowNumbers returns the handle of the window. It is the number that CaptureStill takes, and a web view is no window of its own here.
func (implementation) WindowNumbers(window platform.Window) ([]int, error) {
	return []int{int(uintptr(window))}, nil
}

// CaptureStill writes one picture of the web view of the window to path as PNG. Call it outside the UI thread. WindowNumbers
// returns the window alone here, so the first number is the whole list. Its wait keeps the limit of captureStill, so it takes
// no token.
func (implementation) CaptureStill(windowNumbers []int, path string, _ uint64) error {
	if len(windowNumbers) == 0 {
		return errors.New("still capture needs the number of a window")
	}
	return captureStill(uintptr(windowNumbers[0]), path)
}

func (implementation) CaptureOpen(int, bool, uint64) error { return unsupported("window recording") }

func (implementation) CaptureStart(string, bool) error { return unsupported("window recording") }

func (implementation) CaptureWait(uint64) (bool, error) {
	return false, unsupported("window recording")
}

func (implementation) CaptureStop(float64, uint64) (int, error) {
	return 0, unsupported("window recording")
}

// CaptureEndWait has no wait to end: this platform records no window, and its still capture ends by its own limit.
func (implementation) CaptureEndWait(uint64, string) {}

func (implementation) CaptureHasStream() (bool, error) { return false, unsupported("window recording") }

func (implementation) CaptureLimited() bool { return false }

func (implementation) CaptureLongestGap() float64 { return 0 }

func (implementation) CaptureClock() float64 { return 0 }

func (implementation) LayoutTraceStart() {}

func (implementation) LayoutTraceStop() ([]platform.LayoutRecord, error) {
	return nil, unsupported("layout trace")
}

func (implementation) LayoutTraceRequested() func() { return func() {} }

// DeliveredNotifications answers text that is no list, so the request fails and names this: Windows has no list of them here.
func (implementation) DeliveredNotifications(done func(json string)) {
	done("delivered notifications are not implemented on windows")
}
