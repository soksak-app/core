//go:build !windows

// The FIFO and the process checks of the checks that hold a fixture process until the check ends.
package host_test

import (
	"errors"
	"fmt"
	"syscall"
)

// makeFifo makes the FIFO path that only the owner reads and writes.
func makeFifo(path string) error {
	return syscall.Mkfifo(path, 0o600)
}

// processAbsent fails unless no process has the pid.
func processAbsent(pid int) error {
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		return fmt.Errorf("the signal check of the process answered %v", err)
	}
	return nil
}
