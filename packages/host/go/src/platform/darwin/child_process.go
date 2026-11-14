//go:build darwin

package darwin

import (
	"errors"
	"fmt"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

// pID and siginfoSize are P_PID of <sys/wait.h> and the size of siginfo_t of <sys/signal.h>, which golang.org/x/sys/unix
// does not declare for darwin.
const (
	pID         = 1
	siginfoSize = 104
)

// WaitProcessExit waits until the child process pid exits, without reaping it, with waitid and WEXITED|WNOWAIT: os.Process
// waits on darwin only by reaping the process, and golang.org/x/sys/unix declares no waitid for darwin. A child that another
// wait reaped first has exited too (ECHILD).
func (implementation) WaitProcessExit(pid int) error {
	var info [siginfoSize]byte
	for {
		_, _, errno := unix.Syscall6(unix.SYS_WAITID, pID, uintptr(pid), uintptr(unsafe.Pointer(&info[0])),
			unix.WEXITED|unix.WNOWAIT, 0, 0)
		switch {
		case errno == 0:
			return nil
		case errors.Is(errno, syscall.EINTR):
			continue
		case errors.Is(errno, syscall.ECHILD):
			return nil
		}
		return fmt.Errorf("wait for the exit of process %d: %w", pid, errno)
	}
}
