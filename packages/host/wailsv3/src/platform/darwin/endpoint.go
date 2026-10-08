//go:build darwin

package darwin

import (
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// privateDirectory 는 path 를 현재 사용자만 접근할 수 있는 디렉터리로 만든다. 이미 있으면
// 종류, 소유자, 권한을 차례로 확인한다. 다른 사용자가 소켓에 접근할 수 있으면 실패한다.
func privateDirectory(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	if err := os.Mkdir(path, 0700); err != nil && !os.IsExist(err) {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("%s is not a directory", path)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != os.Geteuid() {
		return fmt.Errorf("%s belongs to another user", path)
	}
	if info.Mode().Perm() != 0700 {
		return fmt.Errorf("%s has mode %o, want 700", path, info.Mode().Perm())
	}
	return nil
}

// removeEnded 는 directory 에서 끝난 프로세스가 남긴 application 의 소켓을 제거한다. 강제 종료된
// 프로세스는 자기 소켓을 지우지 못한다. 번호의 프로세스가 있으면 다른 프로그램이어도 남긴다.
func removeEnded(directory, application string) error {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		number, found := strings.CutPrefix(entry.Name(), application+"-")
		number, suffixed := strings.CutSuffix(number, ".sock")
		pid, err := strconv.Atoi(number)
		if !found || !suffixed || err != nil || pid <= 0 {
			continue
		}
		if syscall.Kill(pid, 0) != syscall.ESRCH {
			continue
		}
		if err := os.Remove(filepath.Join(directory, entry.Name())); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

// Listen 은 directory 에 Unix 도메인 소켓을 만든다. directory 는 이 사용자만 접근하는 0700
// 디렉터리여야 한다. 끝난 프로세스가 남긴 소켓을 먼저 제거한다. 소켓 경로는 104 바이트로 제한되므로 애플리케이션은 설정 디렉터리가 아니라
// 임시 디렉터리를 사용한다.
func (implementation) Listen(directory, application string) (net.Listener, platform.Endpoint, error) {
	if err := privateDirectory(directory); err != nil {
		return nil, platform.Endpoint{}, err
	}
	if err := removeEnded(directory, application); err != nil {
		return nil, platform.Endpoint{}, err
	}
	address := filepath.Join(directory, fmt.Sprintf("%s-%d.sock", application, os.Getpid()))
	// 같은 프로세스 번호를 사용한 이전 프로세스가 남긴 소켓이다.
	if err := os.Remove(address); err != nil && !os.IsNotExist(err) {
		return nil, platform.Endpoint{}, err
	}
	listener, err := net.Listen("unix", address)
	if err != nil {
		return nil, platform.Endpoint{}, err
	}
	if err := os.Chmod(address, 0600); err != nil {
		listener.Close()
		return nil, platform.Endpoint{}, err
	}
	return listener, platform.Endpoint{Transport: "unix", Address: address}, nil
}

// ServiceProcessExists 는 persistent service endpoint의 프로세스가 아직 존재하는지
// 확인한다. 시그널을 받을 수 있는 프로세스만 존재한다. 기다리지 않은 스폰은 좀비로 남아
// kill(pid, 0) 을 통과하므로(V5-106), 통과한 프로세스는 상태를 읽어 좀비를 가려낸다 —
// 좀비는 이미 끝났고, 그 endpoint 는 낡은 것이다. 다른 사용자의 프로세스에 대한 거부(EPERM)는 그 프로세스가
// 있다는 뜻이다. 존재를 확인하지 못하면 오류다.
func (implementation) ServiceProcessExists(pid int) (bool, error) {
	if pid <= 0 {
		return false, nil
	}
	err := syscall.Kill(pid, 0)
	if err == syscall.ESRCH {
		return false, nil
	}
	if err != nil && err != syscall.EPERM {
		return false, fmt.Errorf("cannot inspect service process %d: %w", pid, err)
	}
	// ps 의 종료 상태가 아니라 출력한 상태 문자만 판정에 쓴다. ps 를 실행하지 못하면 오류다.
	state, err := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output()
	var exit *exec.ExitError
	if err != nil && !errors.As(err, &exit) {
		return false, fmt.Errorf("cannot inspect service process %d state: %w", pid, err)
	}
	return !strings.HasPrefix(strings.TrimSpace(string(state)), "Z"), nil
}

// WaitServiceProcessEnd waits for the end of the service process pid with the kqueue notification NOTE_EXIT, for at
// most timeout. A process that does not exist has ended; the registration for it fails with ESRCH.
func (implementation) WaitServiceProcessEnd(pid int, timeout time.Duration) (bool, error) {
	if pid <= 0 {
		return true, nil
	}
	queue, err := syscall.Kqueue()
	if err != nil {
		return false, fmt.Errorf("cannot wait for service process %d: kqueue: %w", pid, err)
	}
	defer syscall.Close(queue)
	change := syscall.Kevent_t{
		Ident:  uint64(pid),
		Filter: syscall.EVFILT_PROC,
		Flags:  syscall.EV_ADD | syscall.EV_ONESHOT,
		Fflags: syscall.NOTE_EXIT,
	}
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
			return false, fmt.Errorf("cannot wait for service process %d: %w", pid, err)
		case count == 0:
			return false, nil
		case events[0].Flags&syscall.EV_ERROR != 0:
			if events[0].Data == int64(syscall.ESRCH) {
				return true, nil
			}
			return false, fmt.Errorf("cannot wait for service process %d: %w", pid, syscall.Errno(events[0].Data))
		}
		return true, nil
	}
}

// NewSession 은 command 가 setsid 로 새 session 의 leader 가 되게 한다.
func (implementation) NewSession(command *exec.Cmd) error {
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return nil
}

// ExitStatus 는 끝난 프로세스의 종료를 wait 상태에서 읽어 `exit status <code>` 나 `signal <number>` 로 쓴다.
func (implementation) ExitStatus(state *os.ProcessState) (string, error) {
	status, ok := state.Sys().(syscall.WaitStatus)
	if !ok {
		return "", fmt.Errorf("process %d: state %T is not a wait status", state.Pid(), state.Sys())
	}
	switch {
	case status.Signaled():
		return fmt.Sprintf("signal %d", int(status.Signal())), nil
	case status.Exited():
		return fmt.Sprintf("exit status %d", status.ExitStatus()), nil
	default:
		return "", fmt.Errorf("process %d has not ended: wait status %#x", state.Pid(), uint32(status))
	}
}
