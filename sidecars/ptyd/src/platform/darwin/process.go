//go:build darwin

package darwin

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

// SessionHandle은 PTY 세션을 나타낸다.
type SessionHandle struct {
	Cmd  *exec.Cmd
	PTY  *PTYPair
	PGID int
}

// StartSession은 PTY에서 새 세션을 시작한다.
func StartSession(cmd string, args []string, env map[string]string, cwd string, pty *PTYPair, cols, rows int) (*SessionHandle, error) {
	// 창 크기 설정
	if err := SetWindowSize(pty, cols, rows); err != nil {
		return nil, fmt.Errorf("set window size: %w", err)
	}

	// exec.Cmd 생성
	command := exec.Command(cmd, args...)

	// 환경 설정: 기본값 + 사용자 제공 환경
	baseEnv := os.Environ()
	envMap := make(map[string]string)
	for _, e := range baseEnv {
		for i := 0; i < len(e); i++ {
			if e[i] == '=' {
				envMap[e[:i]] = e[i+1:]
				break
			}
		}
	}
	// 기본 터미널 환경
	envMap["TERM"] = "xterm-256color"
	envMap["COLORTERM"] = "truecolor"
	// 사용자 환경으로 덮어쓰기
	for k, v := range env {
		envMap[k] = v
	}
	// 환경 배열로 변환
	envList := make([]string, 0, len(envMap))
	for k, v := range envMap {
		envList = append(envList, k+"="+v)
	}
	command.Env = envList

	// 작업 디렉터리
	if cwd != "" {
		command.Dir = cwd
	}

	// PTY 설정: 자식이 제어 터미널을 갖도록
	command.Stdin = pty.Slave
	command.Stdout = pty.Slave
	command.Stderr = pty.Slave

	// 자식 프로세스가 새로운 세션을 가지도록
	// Setsid: 새 세션 생성 (세션 리더가 되므로 제어 터미널을 가질 수 있음)
	// Setctty: 제어 터미널 설정
	// Ctty: 자식의 파일 기술자 번호 (0 = stdin)
	command.SysProcAttr = &syscall.SysProcAttr{
		Setsid:  true,  // 새 세션의 리더
		Setctty: true,  // 제어 터미널 설정
		Ctty:    0,     // 자식 쪽 기술자 번호 (stdin)
	}

	// 프로세스 시작
	if err := command.Start(); err != nil {
		return nil, fmt.Errorf("start command: %w", err)
	}

	// 부모에서 슬레이브 fd 닫기 (자식이 유일한 열린 참조가 되도록)
	// 이렇게 해야 자식 종료 시 마스터에서 EOF가 옴
	pty.Slave.Close()

	// 자식의 프로세스 ID (세션 리더 = PGID 리더)
	pgid := command.Process.Pid

	handle := &SessionHandle{
		Cmd:  command,
		PTY:  pty,
		PGID: pgid,
	}

	return handle, nil
}

// Wait는 자식 프로세스가 종료될 때까지 기다린다.
func (h *SessionHandle) Wait() error {
	return h.Cmd.Wait()
}

// ExitCode는 자식의 종료 코드를 반환한다 (실행 중이면 -1).
func (h *SessionHandle) ExitCode() int {
	if h.Cmd.ProcessState == nil {
		return -1
	}
	if h.Cmd.ProcessState.Exited() {
		return h.Cmd.ProcessState.ExitCode()
	}
	return -1
}

// Kill은 프로세스 그룹에 신호를 보낸다.
func (h *SessionHandle) Kill(sig os.Signal) error {
	syscallSig := sig.(syscall.Signal)
	// 프로세스 그룹에 신호 전송: -PGID는 PGID 그룹 전체
	if err := syscall.Kill(-h.PGID, syscallSig); err != nil {
		return fmt.Errorf("kill pgid %d: %w", h.PGID, err)
	}
	return nil
}

// Close는 세션을 정리한다.
func (h *SessionHandle) Close() error {
	// 프로세스가 아직 살아있으면 SIGTERM 전송
	if h.Cmd.ProcessState == nil || !h.Cmd.ProcessState.Exited() {
		syscall.Kill(-h.PGID, syscall.SIGTERM)
	}

	// PTY 닫기
	if h.PTY != nil {
		h.PTY.Close()
	}

	return nil
}
