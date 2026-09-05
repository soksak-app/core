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
	"io"
	"os"
	"os/exec"
	"runtime"
	"sync"
)

type session struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
	// Everyone watching this shell. A view added straight to the window has no
	// bridge to Go, so its page reads an event stream instead.
	watchers map[chan string]bool
}

type Shells struct {
	mu      sync.Mutex
	running map[string]*session
}

func NewShells() *Shells { return &Shells{running: map[string]*session{}} }

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

// Open starts a shell for id, or does nothing if one is already running.
func (s *Shells) Open(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, live := s.running[id]; live {
		return nil
	}

	cmd := exec.Command(shell())
	// Started where the person lives, not where the app happens to run from.
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}

	live := &session{cmd: cmd, stdin: stdin, watchers: map[chan string]bool{}}
	s.running[id] = live

	for _, stream := range []io.Reader{stdout, stderr} {
		go func(stream io.Reader) {
			reader := bufio.NewReader(stream)
			for {
				// ReadString keeps the newline, so the page receives the breaks
				// the shell actually wrote.
				line, err := reader.ReadString('\n')
				if line != "" {
					s.emit(id, line)
				}
				if err != nil {
					return
				}
			}
		}(stream)
	}
	return nil
}

// emit hands one line to everyone watching that shell. A watcher that has
// stopped reading is skipped rather than waited for.
func (s *Shells) emit(id string, text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	live, ok := s.running[id]
	if !ok {
		return
	}
	for watcher := range live.watchers {
		select {
		case watcher <- text:
		default:
		}
	}
}

// Listen returns a channel carrying that shell's output.
func (s *Shells) Listen(id string) chan string {
	s.mu.Lock()
	defer s.mu.Unlock()
	lines := make(chan string, 256)
	live, ok := s.running[id]
	if !ok {
		return lines
	}
	live.watchers[lines] = true
	return lines
}

func (s *Shells) Unlisten(id string, lines chan string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if live, ok := s.running[id]; ok {
		delete(live.watchers, lines)
	}
	close(lines)
}

func (s *Shells) Write(id string, data string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	live, ok := s.running[id]
	if !ok {
		return nil
	}
	_, err := io.WriteString(live.stdin, data)
	return err
}

// Close ends the shell whose surface is gone: a process with nothing left to
// write to is a process nobody will read.
func (s *Shells) Close(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	live, ok := s.running[id]
	if !ok {
		return
	}
	_ = live.stdin.Close()
	_ = live.cmd.Process.Kill()
	_ = live.cmd.Wait()
	for watcher := range live.watchers {
		close(watcher)
	}
	delete(s.running, id)
}
