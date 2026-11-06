//go:build windows && diagnostics

package windows

import (
	"errors"
	"unsafe"
)

// WindowNumbers returns the handle of the window. It is the number that CaptureStill takes, and a web view is no window of its own here.
func (implementation) WindowNumbers(window unsafe.Pointer) ([]int, error) {
	return []int{int(uintptr(window))}, nil
}

// CaptureStill writes one picture of the web view of the window to path as PNG. Call it outside the UI thread. WindowNumbers
// returns the window alone here, so the first number is the whole list.
func (implementation) CaptureStill(windowNumbers []int, path string) error {
	if len(windowNumbers) == 0 {
		return errors.New("still capture needs the number of a window")
	}
	return captureStill(uintptr(windowNumbers[0]), path)
}

func (implementation) CaptureOpen(int, bool) error { return unsupported("window recording") }

func (implementation) CaptureStart(string, bool) error { return unsupported("window recording") }

func (implementation) CaptureWait() (bool, error) { return false, unsupported("window recording") }

func (implementation) CaptureStop(float64) (int, error) { return 0, unsupported("window recording") }

func (implementation) CaptureHasStream() (bool, error) { return false, unsupported("window recording") }

func (implementation) CaptureLimited() bool { return false }

func (implementation) CaptureLongestGap() float64 { return 0 }

func (implementation) CaptureClock() float64 { return 0 }

func (implementation) LayoutTraceStart() {}

func (implementation) LayoutTraceStop() ([][5]float64, error) {
	return nil, unsupported("layout trace")
}

func (implementation) LayoutTraceRequested() func() { return func() {} }

// DeliveredNotifications answers text that is no list, so the request fails and names this: Windows has no list of them here.
func (implementation) DeliveredNotifications(done func(json string)) {
	done("delivered notifications are not implemented on windows")
}
