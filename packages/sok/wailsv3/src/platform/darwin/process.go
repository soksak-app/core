//go:build darwin

package darwin

import (
	"errors"
	"fmt"
	"syscall"

	"github.com/min-median-max/soksak/packages/sok/wailsv3/src/platform"
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
