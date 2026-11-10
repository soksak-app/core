// The advisory lock and the signals of the checks on Windows, a held platform: Windows has neither.
package tests

import (
	"errors"
	"os"
	"syscall"
)

// holdLock fails: Windows has no advisory lock of a file.
func holdLock(*os.File) error {
	return errors.New("an advisory file lock is not supported on windows")
}

// signalSelf fails: Windows sends no signal to a process.
func signalSelf(syscall.Signal) error {
	return errors.New("a signal to a process is not supported on windows")
}
