// Package platform gives the checks of sok the advisory lock and the signals of their operating system. Windows, a held
// platform, has neither.
package platform

import (
	"errors"
	"os"
	"syscall"
)

// HoldLock fails: Windows has no advisory lock of a file.
func HoldLock(*os.File) error {
	return errors.New("an advisory file lock is not supported on windows")
}

// SignalSelf fails: Windows sends no signal to a process.
func SignalSelf(syscall.Signal) error {
	return errors.New("a signal to a process is not supported on windows")
}
