//go:build windows && diagnostics

package windows

import (
	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// WindowNumbers returns the handle of the window. It is the number that CaptureStill takes, and a web view is no window of its own here.
func (implementation) WindowNumbers(window platform.Window) ([]int, error) {
	return []int{int(uintptr(window))}, nil
}

// CaptureStill writes one picture of the web view of the window to path as PNG. Call it outside the UI thread. windowNumber is
// the handle that WindowNumbers returns. Its wait keeps the limit of captureStill.
func (implementation) CaptureStill(windowNumber int, path string) error {
	return captureStill(uintptr(windowNumber), path)
}

func (implementation) CaptureOpen(int, bool) error { return unsupported("window recording") }

func (implementation) CaptureStart(string, float64, float64, int, bool, uint64) error {
	return unsupported("window recording")
}

func (implementation) CaptureStop(float64, uint64) (int, error) {
	return 0, unsupported("window recording")
}

// CaptureEndWait has no wait to end: this platform records no window, and its still capture ends by its own limit.
func (implementation) CaptureEndWait(uint64, string) {}

func (implementation) CaptureMissed() int { return 0 }

func (implementation) CaptureLate() int { return 0 }

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
