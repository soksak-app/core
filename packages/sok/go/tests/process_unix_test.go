//go:build !windows

// The advisory lock and the signals of the checks, which the platforms other than Windows give.
package tests

import (
	"os"
	"syscall"
)

// holdLock takes the advisory lock of the open file, as a live owner of the configuration directory holds it.
func holdLock(file *os.File) error {
	return syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
}

// signalSelf sends signal to the process of the test.
func signalSelf(signal syscall.Signal) error {
	return syscall.Kill(os.Getpid(), signal)
}
