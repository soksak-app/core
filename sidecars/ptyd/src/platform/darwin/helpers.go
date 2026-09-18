//go:build darwin

package darwin

import (
	"fmt"
	"io"
	"strings"
	"syscall"

	"github.com/min-median-max/soksak/sidecars/ptyd/src/ptyd"
)

// init은 플랫폼별 헬퍼 함수를 등록한다.
func init() {
	ptyd.StartPTYSession = startPTYSession
	ptyd.GetPTYReader = getPTYReader
	ptyd.GetPTYWriter = getPTYWriter
	ptyd.SignalHandler = signalHandler
	ptyd.WaitHandler = waitHandler
}

// startPTYSession은 PTY 세션을 시작한다.
func startPTYSession(shell string, args []string, env map[string]string, cwd string, cols, rows int) (any, error) {
	// PTY 할당
	pty, err := AllocatePTY()
	if err != nil {
		return nil, fmt.Errorf("allocate PTY: %w", err)
	}

	// 자식 프로세스 시작
	handle, err := StartSession(shell, args, env, cwd, pty, cols, rows)
	if err != nil {
		pty.Close()
		return nil, fmt.Errorf("start session: %w", err)
	}

	return handle, nil
}

// getPTYReader는 PTY 마스터를 Reader로 반환한다.
func getPTYReader(handleAny any) any {
	handle, ok := handleAny.(*SessionHandle)
	if !ok || handle == nil {
		return nil
	}
	return io.Reader(handle.PTY.Master)
}

// getPTYWriter는 PTY 마스터를 Writer로 반환한다.
func getPTYWriter(handleAny any) any {
	handle, ok := handleAny.(*SessionHandle)
	if !ok || handle == nil {
		return nil
	}
	return io.Writer(handle.PTY.Master)
}

// signalHandler는 세션 핸들에 신호를 보낸다.
func signalHandler(handleAny any, sigName string) error {
	handle, ok := handleAny.(*SessionHandle)
	if !ok || handle == nil {
		return fmt.Errorf("invalid handle")
	}

	// 신호 이름을 syscall.Signal으로 변환
	sig, err := stringToSignal(sigName)
	if err != nil {
		return err
	}

	return handle.Kill(sig)
}

// stringToSignal은 신호 이름을 syscall.Signal으로 변환한다.
func stringToSignal(name string) (syscall.Signal, error) {
	name = strings.ToUpper(strings.TrimPrefix(name, "SIG"))
	switch name {
	case "INT":
		return syscall.SIGINT, nil
	case "TERM":
		return syscall.SIGTERM, nil
	case "KILL":
		return syscall.SIGKILL, nil
	case "HUP":
		return syscall.SIGHUP, nil
	case "QUIT":
		return syscall.SIGQUIT, nil
	case "ABRT":
		return syscall.SIGABRT, nil
	default:
		return 0, fmt.Errorf("unknown signal: %s", name)
	}
}

// waitHandler는 자식 프로세스가 종료될 때까지 기다리고 종료 코드를 반환한다.
func waitHandler(handleAny any) int {
	handle, ok := handleAny.(*SessionHandle)
	if !ok || handle == nil {
		return -1
	}

	// 자식이 종료될 때까지 대기
	err := handle.Wait()
	if err != nil {
		return -1
	}

	// 종료 코드 반환
	return handle.ExitCode()
}
