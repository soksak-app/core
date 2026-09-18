//go:build darwin

package darwin

import (
	"fmt"
	"os"
	"syscall"

	"github.com/min-median-max/soksak/sidecars/ptyd/src/platform"
)

// implementation은 darwin PTY 데몬 구현이다.
type implementation struct{}

func init() { platform.Register(implementation{}) }

// Daemonize는 프로세스를 데몬으로 만든다.
// setsid()를 호출하고 stdin/stdout/stderr를 /dev/null로 리다이렉트한다.
func (implementation) Daemonize() error {
	// setsid() 호출: 새 세션과 프로세스 그룹 생성
	if _, err := syscall.Setsid(); err != nil {
		return fmt.Errorf("setsid failed: %w", err)
	}

	// /dev/null 열기
	devNull, err := os.Open("/dev/null")
	if err != nil {
		return fmt.Errorf("open /dev/null: %w", err)
	}
	defer devNull.Close()

	// stdin, stdout, stderr를 /dev/null로 리다이렉트
	if err := syscall.Dup2(int(devNull.Fd()), 0); err != nil {
		return fmt.Errorf("dup2 stdin: %w", err)
	}
	if err := syscall.Dup2(int(devNull.Fd()), 1); err != nil {
		return fmt.Errorf("dup2 stdout: %w", err)
	}
	if err := syscall.Dup2(int(devNull.Fd()), 2); err != nil {
		return fmt.Errorf("dup2 stderr: %w", err)
	}

	return nil
}
