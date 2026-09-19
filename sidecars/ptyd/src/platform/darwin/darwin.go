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

// Setsid는 새 세션과 프로세스 그룹을 생성한다.
func (implementation) Setsid() error {
	// setsid() 호출: 새 세션과 프로세스 그룹 생성
	if _, err := syscall.Setsid(); err != nil {
		return fmt.Errorf("setsid failed: %w", err)
	}
	return nil
}

// Detach는 stdin, stdout, stderr를 /dev/null로 리다이렉트한다.
// PTYD_LOG 환경변수가 설정되면 stderr을 그 파일로 리다이렉트한다.
func (implementation) Detach() error {
	// /dev/null 열기
	devNull, err := os.Open("/dev/null")
	if err != nil {
		return fmt.Errorf("open /dev/null: %w", err)
	}
	defer devNull.Close()

	// stdin, stdout를 /dev/null로 리다이렉트
	if err := syscall.Dup2(int(devNull.Fd()), 0); err != nil {
		return fmt.Errorf("dup2 stdin: %w", err)
	}
	if err := syscall.Dup2(int(devNull.Fd()), 1); err != nil {
		return fmt.Errorf("dup2 stdout: %w", err)
	}

	// stderr: PTYD_LOG 에 경로가 있으면 그 파일로, 없으면 /dev/null 로.
	// 기본값이 /dev/null 이라 데몬의 사고가 흔적 없이 묻히므로 진단용 통로를 하나 남긴다.
	stderr := devNull
	if logPath := os.Getenv("PTYD_LOG"); logPath != "" {
		logFile, err := os.OpenFile(logPath, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0600)
		if err != nil {
			return fmt.Errorf("open log file: %w", err)
		}
		defer logFile.Close()
		stderr = logFile
	}
	if err := syscall.Dup2(int(stderr.Fd()), 2); err != nil {
		return fmt.Errorf("dup2 stderr: %w", err)
	}

	return nil
}
