// A shell process behind a terminal surface.
//
// A terminal surface is a webview like the browser one; what differs is that
// its page is local and a process here feeds it. The output keeps arriving,
// which is the point: a surface showing a running program cannot be replaced by
// a still of itself.
//
// This is a console, not a terminal emulator. Output is streamed as text and
// input is sent a line at a time. The shell is not started interactive: an
// interactive shell draws its prompt with the escape sequences a terminal would
// act on, and this page is not a terminal.
package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"sync"
)

type session struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
}

type Shells struct {
	mu      sync.Mutex
	running map[string]*session
	// Where a line of output goes. The reader passes each line straight to it,
	// so no line waits in a queue and none is dropped.
	say func(id string, text string)
}

// NewShells makes the set of shells. say receives every line each shell writes,
// from the goroutine reading it.
func NewShells(say func(id string, text string)) *Shells {
	return &Shells{running: map[string]*session{}, say: say}
}

// shell reports the user's shell, or the platform's default when it is not set.
func shell() string {
	if runtime.GOOS == "windows" {
		if program := os.Getenv("COMSPEC"); program != "" {
			return program
		}
		return "cmd.exe"
	}
	if program := os.Getenv("SHELL"); program != "" {
		return program
	}
	return "/bin/sh"
}

// Open starts a shell for id and reports whether it started one. A shell that is
// already running is left alone and false is returned, so the caller does not
// attach a second reader to the same output.
func (s *Shells) Open(id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, live := s.running[id]; live {
		return false, nil
	}

	cmd := exec.Command(shell())
	// Started in the user's home directory, not the app's working directory.
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return false, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		return false, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		stdin.Close()
		stdout.Close()
		return false, err
	}
	// Wait 이 닫아 주는 것은 프로세스가 시작된 뒤의 일이다. 시작에 실패하면 여기서
	// 닫지 않는 한 부모 쪽 기술자가 남는다.
	if err := cmd.Start(); err != nil {
		stdin.Close()
		stdout.Close()
		stderr.Close()
		return false, err
	}

	live := &session{cmd: cmd, stdin: stdin}
	s.running[id] = live

	for _, stream := range []io.Reader{stdout, stderr} {
		go func(stream io.Reader) {
			reader := bufio.NewReader(stream)
			for {
				// ReadString keeps the newline, so the page receives the breaks
				// the shell actually wrote.
				line, err := reader.ReadString('\n')
				if line != "" {
					s.say(id, line)
				}
				if err != nil {
					return
				}
			}
		}(stream)
	}
	return true, nil
}

func (s *Shells) Write(id string, data string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	live, ok := s.running[id]
	if !ok {
		return fmt.Errorf("shell %s is not running", id)
	}
	_, err := io.WriteString(live.stdin, data)
	return err
}

// Close ends the shell whose surface is gone: a process with nothing left to
// write to is a process whose output no one reads.
//
// The process is ended with the lock released. Ending it means waiting for it,
// and a wait while holding the lock would stop the next call to this set.
//
func (s *Shells) Close(id string) {
	s.mu.Lock()
	live, ok := s.running[id]
	if ok {
		delete(s.running, id)
	}
	s.mu.Unlock()
	if !ok {
		return
	}

	_ = live.stdin.Close()
	_ = live.cmd.Process.Kill()
	_ = live.cmd.Wait()
}
