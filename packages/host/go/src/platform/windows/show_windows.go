//go:build windows

package windows

import (
	"unsafe"

	sys "golang.org/x/sys/windows"
)

var procShowWindow = user32.NewProc("ShowWindow")

// holdsForeground reports whether the foreground window belongs to this process. No foreground window means that it does not.
func holdsForeground() bool {
	// default: GetForegroundWindow sets no error that GetLastError reads, so its value is the whole answer and the error of Call holds nothing.
	foreground, _, _ := procGetForegroundWindow.Call()
	var process uint32
	// The thread that it answers is not needed, and a window that is gone leaves process 0.
	if _, err := sys.GetWindowThreadProcessId(sys.HWND(foreground), &process); err != nil {
		return false
	}
	return process == sys.GetCurrentProcessId()
}

// ShowWindow answers no failure: the system call reports only whether the window was already shown.
func (implementation) ShowWindow(window unsafe.Pointer) error {
	procShowWindow.Call(uintptr(window), uintptr(showCommand(holdsForeground())))
	return nil
}
