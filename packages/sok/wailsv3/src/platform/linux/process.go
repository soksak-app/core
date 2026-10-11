//go:build linux

package linux

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/soksak-app/core/packages/sok/wailsv3/src/platform"
)

type linux struct{}

func init() { platform.Register(linux{}) }

// ProcessRunning checks with signal 0 whether the process exists. A process of another user (EPERM) is also running.
func (linux) ProcessRunning(pid int) error {
	if err := syscall.Kill(pid, 0); err != nil && !errors.Is(err, syscall.EPERM) {
		return fmt.Errorf("process %d is not running: %w", pid, err)
	}
	return nil
}

// Key is the release key of Linux.
func (linux) Key() (string, error) {
	switch runtime.GOARCH {
	case "arm64":
		return "linux-arm64", nil
	case "amd64":
		return "linux-x64", nil
	}
	return "", fmt.Errorf("linux/%s has no platform key", runtime.GOARCH)
}

// ExtractBundle is an error: an application bundle is a macOS file.
func (linux) ExtractBundle(string, string) error {
	return errors.New("application bundles are not implemented on linux")
}

// BundleVersion is an error: an application bundle is a macOS file.
func (linux) BundleVersion(string) (string, error) {
	return "", errors.New("application bundles are not implemented on linux")
}

// WaitProcessEnd is an error: the application update replaces a macOS bundle.
func (linux) WaitProcessEnd(int, time.Duration) (bool, error) {
	return false, errors.New("waiting for a process end is not implemented on linux")
}

// CopyBundle is an error: an application bundle is a macOS file.
func (linux) CopyBundle(string, string) error {
	return errors.New("application bundles are not implemented on linux")
}

// OpenApplication is an error: an application bundle is a macOS file.
func (linux) OpenApplication(string, []string) error {
	return errors.New("application bundles are not implemented on linux")
}

// MonotonicNanos reads CLOCK_MONOTONIC.
func (linux) MonotonicNanos() (uint64, error) {
	var now unix.Timespec
	if err := unix.ClockGettime(unix.CLOCK_MONOTONIC, &now); err != nil {
		return 0, fmt.Errorf("the monotonic clock cannot be read: %w", err)
	}
	return uint64(now.Sec)*1_000_000_000 + uint64(now.Nsec), nil
}

// LockFile takes flock(LOCK_EX) on the file, which excludes the other open files of the same file in every process.
func (linux) LockFile(file *os.File) error {
	if err := unix.Flock(int(file.Fd()), unix.LOCK_EX); err != nil {
		return fmt.Errorf("%s cannot be locked: %w", file.Name(), err)
	}
	return nil
}

// UnlockFile releases the lock of LockFile.
func (linux) UnlockFile(file *os.File) error {
	if err := unix.Flock(int(file.Fd()), unix.LOCK_UN); err != nil {
		return fmt.Errorf("%s cannot be unlocked: %w", file.Name(), err)
	}
	return nil
}

// PathsDir is an error. The shell on Linux has no folder that adds a PATH entry for each file.
func (linux) PathsDir() (string, error) {
	return "", errors.New("path entries are not implemented on linux")
}
