//go:build !windows

// Package platform gives the checks of sok the advisory lock and the signals of their operating system.
package platform

import (
	"os"
	"syscall"
)

// HoldLock takes the advisory lock of the open file, as a live owner of the configuration directory holds it.
func HoldLock(file *os.File) error {
	return syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
}

// SignalSelf sends signal to the process of the test.
func SignalSelf(signal syscall.Signal) error {
	return syscall.Kill(os.Getpid(), signal)
}
