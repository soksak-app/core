//go:build !windows

package platform

import (
	"errors"
	"fmt"
	"syscall"
)

// MakeFifo makes the FIFO path that only the owner reads and writes, for the checks that hold a fixture process until the
// check ends.
func MakeFifo(path string) error {
	return syscall.Mkfifo(path, 0o600)
}

// ProcessAbsent fails unless no process has the pid.
func ProcessAbsent(pid int) error {
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		return fmt.Errorf("the signal check of the process answered %v", err)
	}
	return nil
}
