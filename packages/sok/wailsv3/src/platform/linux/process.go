//go:build linux

package linux

import (
	"errors"
	"fmt"
	"runtime"
	"syscall"
	"time"

	"github.com/soksak-app/core/packages/sok/wailsv3/src/platform"
)

type linux struct{}

func init() { platform.Register(linux{}) }

// ProcessRunning 은 signal 0 으로 프로세스가 있는지 본다. 다른 사용자의 프로세스(EPERM)도 실행 중이다.
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

// PathsDir 는 오류다. Linux 의 shell 에는 파일마다 PATH 항목을 더하는 폴더가 없다.
func (linux) PathsDir() (string, error) {
	return "", errors.New("path entries are not implemented on linux")
}
