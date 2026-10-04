//go:build darwin

package darwin

import (
	"errors"
	"fmt"
	"runtime"
	"syscall"

	"github.com/soksak-app/core/packages/sok/wailsv3/src/platform"
)

type darwin struct{}

func init() { platform.Register(darwin{}) }

// ProcessRunning 은 signal 0 으로 프로세스가 있는지 본다. 다른 사용자의 프로세스(EPERM)도 실행 중이다.
func (darwin) ProcessRunning(pid int) error {
	if err := syscall.Kill(pid, 0); err != nil && !errors.Is(err, syscall.EPERM) {
		return fmt.Errorf("process %d is not running: %w", pid, err)
	}
	return nil
}

// PathsDir 는 macOS 의 경로 항목 폴더다. shell 은 이 폴더의 파일마다 그 줄을 PATH 에 더한다.
func (darwin) PathsDir() (string, error) { return "/etc/paths.d", nil }

// Key 는 macOS 의 release asset key 다.
func (darwin) Key() (string, error) {
	switch runtime.GOARCH {
	case "arm64":
		return "darwin-arm64", nil
	case "amd64":
		return "darwin-x64", nil
	}
	return "", fmt.Errorf("darwin/%s has no platform key", runtime.GOARCH)
}
