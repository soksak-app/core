//go:build windows && diagnostics

package windows

import "unsafe"

// WindowNumbers returns the handle of the window. It is the number that CaptureStill takes, and a web view is no window of its own here.
func (implementation) WindowNumbers(window unsafe.Pointer) ([]int, error) {
	return []int{int(uintptr(window))}, nil
}

// CaptureStill writes one picture of the web view of the window to path as PNG. Call it outside the UI thread.
func (implementation) CaptureStill(windowNumber int, path string) error {
	return captureStill(uintptr(windowNumber), path)
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
