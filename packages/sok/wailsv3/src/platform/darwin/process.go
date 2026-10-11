//go:build darwin

package darwin

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/soksak-app/core/packages/sok/wailsv3/src/platform"
)

type darwin struct{}

func init() { platform.Register(darwin{}) }

// ProcessRunning checks with signal 0 whether the process exists. A process of another user (EPERM) is also running.
func (darwin) ProcessRunning(pid int) error {
	if err := syscall.Kill(pid, 0); err != nil && !errors.Is(err, syscall.EPERM) {
		return fmt.Errorf("process %d is not running: %w", pid, err)
	}
	return nil
}

// PathsDir is the path entry folder on macOS. The shell adds the line of each file in this folder to PATH.
func (darwin) PathsDir() (string, error) { return "/etc/paths.d", nil }

// Key is the release key of macOS.
func (darwin) Key() (string, error) {
	switch runtime.GOARCH {
	case "arm64":
		return "darwin-arm64", nil
	case "amd64":
		return "darwin-x64", nil
	}
	return "", fmt.Errorf("darwin/%s has no platform key", runtime.GOARCH)
}

// ExtractBundle extracts the zip with ditto, which keeps the modes and the signature of the bundle.
func (darwin) ExtractBundle(zipped, folder string) error {
	if output, err := exec.Command("ditto", "-x", "-k", zipped, folder).CombinedOutput(); err != nil {
		return fmt.Errorf("ditto: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

// WaitProcessEnd waits with the kernel notification of the end of a process, so no timer asks whether it ended.
func (darwin) WaitProcessEnd(pid int, timeout time.Duration) (bool, error) {
	if pid <= 0 {
		return true, nil
	}
	queue, err := syscall.Kqueue()
	if err != nil {
		return false, fmt.Errorf("cannot wait for process %d: kqueue: %w", pid, err)
	}
	defer syscall.Close(queue)
	change := syscall.Kevent_t{Ident: uint64(pid), Filter: syscall.EVFILT_PROC, Flags: syscall.EV_ADD | syscall.EV_ONESHOT, Fflags: syscall.NOTE_EXIT}
	limit := syscall.NsecToTimespec(timeout.Nanoseconds())
	events := make([]syscall.Kevent_t, 1)
	for {
		count, err := syscall.Kevent(queue, []syscall.Kevent_t{change}, events, &limit)
		switch {
		case err == syscall.EINTR:
			continue
		case err == syscall.ESRCH:
			return true, nil
		case err != nil:
			return false, fmt.Errorf("cannot wait for process %d: %w", pid, err)
		case count == 0:
			return false, nil
		case events[0].Flags&syscall.EV_ERROR != 0:
			if events[0].Data == int64(syscall.ESRCH) {
				return true, nil
			}
			return false, fmt.Errorf("cannot wait for process %d: %w", pid, syscall.Errno(events[0].Data))
		}
		return true, nil
	}
}

// CopyBundle copies with ditto, which keeps the modes and the signature of the bundle.
func (darwin) CopyBundle(source, destination string) error {
	if output, err := exec.Command("ditto", source, destination).CombinedOutput(); err != nil {
		return fmt.Errorf("ditto: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

// OpenApplication starts a new instance with open -n.
func (darwin) OpenApplication(bundle string, arguments []string) error {
	command := []string{"-n", bundle}
	if len(arguments) > 0 {
		command = append(command, "--args")
		command = append(command, arguments...)
	}
	if output, err := exec.Command("open", command...).CombinedOutput(); err != nil {
		return fmt.Errorf("open: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

// MonotonicNanos reads CLOCK_UPTIME_RAW, which is mach_absolute_time in nanoseconds: the clock of sp_mono_ns.
func (darwin) MonotonicNanos() (uint64, error) {
	var now unix.Timespec
	if err := unix.ClockGettime(unix.CLOCK_UPTIME_RAW, &now); err != nil {
		return 0, fmt.Errorf("the monotonic clock cannot be read: %w", err)
	}
	return uint64(now.Sec)*1_000_000_000 + uint64(now.Nsec), nil
}

// LockFile takes flock(LOCK_EX) on the file, which excludes the other open files of the same file in every process.
func (darwin) LockFile(file *os.File) error {
	if err := unix.Flock(int(file.Fd()), unix.LOCK_EX); err != nil {
		return fmt.Errorf("%s cannot be locked: %w", file.Name(), err)
	}
	return nil
}

// UnlockFile releases the lock of LockFile.
func (darwin) UnlockFile(file *os.File) error {
	if err := unix.Flock(int(file.Fd()), unix.LOCK_UN); err != nil {
		return fmt.Errorf("%s cannot be unlocked: %w", file.Name(), err)
	}
	return nil
}

// BundleVersion reads CFBundleShortVersionString of the Info.plist of the bundle.
func (darwin) BundleVersion(bundle string) (string, error) {
	output, err := exec.Command("plutil", "-extract", "CFBundleShortVersionString", "raw", "-o", "-", filepath.Join(bundle, "Contents", "Info.plist")).Output()
	if err != nil {
		return "", fmt.Errorf("the version of %s cannot be read: %w", filepath.Base(bundle), err)
	}
	return strings.TrimSpace(string(output)), nil
}
