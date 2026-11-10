//go:build darwin

package darwin

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// privateDirectory makes path a directory that only the current user can access. When it already exists, it
// checks the kind, the owner and the permissions in turn. It fails when another user can access the socket.
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

// removeEnded removes from directory the application sockets that ended processes left. A process that was
// killed cannot delete its own socket. When a process with the number exists, the socket is kept even if the process is another program.
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

// socketPathLimit is the length in bytes of a unix socket path. sockaddr_un.sun_path has 104 bytes on macOS
// (sys/un.h), and the last of them is the terminating NUL.
const socketPathLimit = 103

// Listen creates a Unix domain socket in directory. directory must be a 0700
// directory that only this user accesses. It first removes the sockets that ended processes left. The socket path is limited to 103 bytes, so the application uses the
// temporary directory and not the configuration directory. A longer path is refused before the directory is changed.
func (implementation) Listen(directory, application string) (net.Listener, platform.Endpoint, error) {
	address := filepath.Join(directory, fmt.Sprintf("%s-%d.sock", application, os.Getpid()))
	if len(address) > socketPathLimit {
		return nil, platform.Endpoint{}, fmt.Errorf("endpoint socket path %s is %d bytes, over the limit of %d bytes of a unix socket address", address, len(address), socketPathLimit)
	}
	if err := privateDirectory(directory); err != nil {
		return nil, platform.Endpoint{}, err
	}
	if err := removeEnded(directory, application); err != nil {
		return nil, platform.Endpoint{}, err
	}
	// A socket that a previous process with the same process number left.
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

// ServiceProcessExists checks whether the process of a persistent service endpoint still exists.
// Only a process that can receive a signal exists. A spawn that was not waited for stays as a zombie and
// passes kill(pid, 0) (V5-106), so for a process that passed, the state is read to tell zombies apart;
// a zombie has already ended, and its endpoint is stale. A refusal (EPERM) for a process of another user means that the process
// exists. It is an error when the existence cannot be determined.
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
	// Only the state character that ps printed is used for the decision, not the exit status of ps. It is an error when ps cannot be run.
	state, err := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output()
	var exit *exec.ExitError
	if err != nil && !errors.As(err, &exit) {
		return false, fmt.Errorf("cannot inspect service process %d state: %w", pid, err)
	}
	return !strings.HasPrefix(strings.TrimSpace(string(state)), "Z"), nil
}

// stopEvent is the identifier of the user event that wakes the wait for a service process when its stop closes.
const stopEvent = 1

// WaitServiceProcessEnd waits for the end of the service process pid with the kqueue notification NOTE_EXIT, or for stop,
// which triggers a user event of the same queue. A process that does not exist has ended; the registration for it fails
// with ESRCH.
func (implementation) WaitServiceProcessEnd(pid int, stop <-chan struct{}) (bool, error) {
	if pid <= 0 {
		return true, nil
	}
	queue, err := syscall.Kqueue()
	if err != nil {
		return false, fmt.Errorf("cannot wait for service process %d: kqueue: %w", pid, err)
	}
	defer syscall.Close(queue)
	wake := syscall.Kevent_t{Ident: stopEvent, Filter: syscall.EVFILT_USER, Flags: syscall.EV_ADD | syscall.EV_CLEAR}
	if _, err := syscall.Kevent(queue, []syscall.Kevent_t{wake}, nil, nil); err != nil {
		return false, fmt.Errorf("cannot wait for service process %d: stop event: %w", pid, err)
	}
	// The trigger runs before the queue closes: the wait ends the trigger goroutine and waits for it. A trigger that fails leaves
	// the wait to the exit of the process, and the wait returns that failure with its answer.
	done, triggered := make(chan struct{}), make(chan error, 1)
	go func() {
		select {
		case <-stop:
			trigger := syscall.Kevent_t{Ident: stopEvent, Filter: syscall.EVFILT_USER, Fflags: syscall.NOTE_TRIGGER}
			_, err := syscall.Kevent(queue, []syscall.Kevent_t{trigger}, nil, nil)
			triggered <- err
		case <-done:
			triggered <- nil
		}
	}()
	ended, err := waitProcessExitEvent(queue, pid)
	close(done)
	if triggerErr := <-triggered; triggerErr != nil && err == nil {
		err = fmt.Errorf("cannot wake the wait for service process %d: %w", pid, triggerErr)
	}
	return ended, err
}

// waitProcessExitEvent registers the exit of pid in queue and waits for it or for the stop event of the queue.
func waitProcessExitEvent(queue, pid int) (bool, error) {
	change := syscall.Kevent_t{
		Ident:  uint64(pid),
		Filter: syscall.EVFILT_PROC,
		Flags:  syscall.EV_ADD | syscall.EV_ONESHOT,
		Fflags: syscall.NOTE_EXIT,
	}
	changes := []syscall.Kevent_t{change}
	events := make([]syscall.Kevent_t, 1)
	for {
		_, err := syscall.Kevent(queue, changes, events, nil)
		switch {
		case err == syscall.EINTR:
			// The kernel applied the registration before the wait; a repeated wait only reads events.
			changes = nil
			continue
		case err == syscall.ESRCH:
			return true, nil
		case err != nil:
			return false, fmt.Errorf("cannot wait for service process %d: %w", pid, err)
		case events[0].Flags&syscall.EV_ERROR != 0:
			if events[0].Data == int64(syscall.ESRCH) {
				return true, nil
			}
			return false, fmt.Errorf("cannot wait for service process %d: %w", pid, syscall.Errno(events[0].Data))
		case events[0].Filter == syscall.EVFILT_USER:
			return false, nil
		}
		return true, nil
	}
}

// NewSession makes command the leader of a new session with setsid.
func (implementation) NewSession(command *exec.Cmd) error {
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return nil
}

// NewProcessGroup makes command the leader of a new process group with setpgid.
func (implementation) NewProcessGroup(command *exec.Cmd) error {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return nil
}

// EndProcessGroup sends SIGKILL to the process group pid; ESRCH means that no process of the group remains.
func (implementation) EndProcessGroup(pid int) error {
	if err := syscall.Kill(-pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		return fmt.Errorf("end process group %d: %w", pid, err)
	}
	return nil
}

// TerminateProcessGroup sends SIGTERM to the process group pid; ESRCH means that no process of the group remains.
func (implementation) TerminateProcessGroup(pid int) error {
	if err := syscall.Kill(-pid, syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
		return fmt.Errorf("terminate process group %d: %w", pid, err)
	}
	return nil
}

// ExitedByTermination answers whether the wait status of state is the end by SIGTERM.
func (implementation) ExitedByTermination(state *os.ProcessState) bool {
	status, ok := state.Sys().(syscall.WaitStatus)
	return ok && status.Signaled() && status.Signal() == syscall.SIGTERM
}

// ReadAvailable reads once from the non-blocking descriptor of file: EAGAIN and a read of 0 bytes are the end of what it
// holds.
func (implementation) ReadAvailable(file *os.File, buffer []byte) (int, error) {
	raw, err := file.SyscallConn()
	if err != nil {
		return 0, err
	}
	var n int
	var readErr error
	if err := raw.Read(func(descriptor uintptr) bool {
		n, readErr = syscall.Read(int(descriptor), buffer)
		return true
	}); err != nil {
		return 0, err
	}
	switch {
	case errors.Is(readErr, syscall.EAGAIN), readErr == nil && n == 0:
		return 0, io.EOF
	case readErr != nil:
		return 0, readErr
	}
	return n, nil
}

// ExitStatus reads the exit of an ended process from the wait status and writes it as `exit status <code>` or `signal <number>`.
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
