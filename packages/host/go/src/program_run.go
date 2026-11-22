package host

// The run of a declared program of a plugin page (docs/spec/native-surfaces.md#program-runs): the host starts the program
// without a shell, reads its output with a bound, and ends it with its group when the run ends before the exit.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// programOutputMaxBytes is the number of bytes that a run keeps of each output stream; the bytes beyond it are read and discarded.
const programOutputMaxBytes = 1 << 20

// ProgramEnd is the cause of a run that ends before its program exits. Its text is the result of the run.
type ProgramEnd string

const (
	ProgramCancelled     ProgramEnd = "cancelled"
	ProgramProcessEnded  ProgramEnd = "process-ended"
	ProgramSurfaceClosed ProgramEnd = "surface-closed"
	ProgramWindowClosed  ProgramEnd = "window-closed"
)

// Error makes a ProgramEnd usable as the cause of a context.
func (e ProgramEnd) Error() string {
	return string(e)
}

// ProgramRun is one run: the declared program with its arguments, the project folder and the complete environment.
type ProgramRun struct {
	// Name is the declared name of the program, which the messages of the run name.
	Name string
	// Program is the declared text: a bare name found through the PATH of Environment, or a path.
	Program string
	Args    []string
	// Directory is the working directory, the project folder of the surface.
	Directory string
	// Environment is the complete environment of the program as KEY=VALUE entries.
	Environment []string
	// OnStart, when set, receives the process identifier after the program started.
	OnStart func(pid int)
}

// ProgramOutcome is the result of a run that started its program. Result is `exited` or the ProgramEnd that ended the run.
type ProgramOutcome struct {
	Result string
	// Code is the exit status, or nil when a signal ended the program; Signal names that signal.
	Code   *int
	Signal string
	// Stdout and Stderr hold the kept bytes; StdoutBytes and StderrBytes count every byte the program wrote.
	Stdout          string
	Stderr          string
	StdoutBytes     int64
	StderrBytes     int64
	StdoutTruncated bool
	StderrTruncated bool
	Duration        time.Duration
}

// boundedCapture keeps the first limit bytes that it is written and discards the rest, counting every byte. It reports no error,
// so the copy of the output never stops the program; a discarded byte is reported through truncated.
type boundedCapture struct {
	limit int
	kept  []byte
	total int64
}

func (b *boundedCapture) Write(p []byte) (int, error) {
	b.total += int64(len(p))
	if room := b.limit - len(b.kept); room > 0 {
		b.kept = append(b.kept, p[:min(room, len(p))]...)
	}
	return len(p), nil
}

func (b *boundedCapture) truncated() bool {
	return b.total > int64(len(b.kept))
}

// trimIncompleteTail removes the bytes of a UTF-8 character that the bound cut, so the kept text ends at a whole character.
func trimIncompleteTail(kept []byte) []byte {
	for i := len(kept) - 1; i >= 0 && i >= len(kept)-utf8.UTFMax; i-- {
		if utf8.RuneStart(kept[i]) {
			if !utf8.FullRune(kept[i:]) {
				return kept[:i]
			}
			return kept
		}
	}
	return kept
}

// resolveProgram finds the program of a run as a terminal session finds its program (docs/spec/agent-roles.md#start-parameters):
// a path with a separator resolves from the directory and an absolute path as it is, and a bare name resolves through the PATH of
// the environment. os/exec finds a bare name through the PATH of the host process, which may differ from the environment of the
// run, so this searches the PATH of the environment with the rule of os/exec: a regular file with an execute bit.
func resolveProgram(program, directory string, environment []string) (string, error) {
	if strings.ContainsRune(program, filepath.Separator) {
		path := program
		if !filepath.IsAbs(path) {
			path = filepath.Join(directory, path)
		}
		if _, err := os.Stat(path); err != nil {
			return "", fmt.Errorf("program not found: %s", program)
		}
		return path, nil
	}
	pathValue := ""
	for _, entry := range environment {
		if value, ok := strings.CutPrefix(entry, "PATH="); ok {
			pathValue = value
		}
	}
	for _, folder := range filepath.SplitList(pathValue) {
		if folder == "" {
			folder = "."
		}
		candidate := filepath.Join(folder, program)
		info, err := os.Stat(candidate)
		if err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0 {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("program not found: %s", program)
}

// RunProgram starts the program of run and waits for it to exit or for its context to end. A context that ends first ends the
// program group with the force-kill signal and answers the cause of the context as the result, without waiting for the program
// (docs/spec/native-surfaces.md#program-runs). It refuses a program that does not resolve or does not start, and a stream that the
// run kept and that is not UTF-8, with an error that names the program or the stream.
func RunProgram(ctx context.Context, run ProgramRun) (ProgramOutcome, error) {
	path, err := resolveProgram(run.Program, run.Directory, run.Environment)
	if err != nil {
		return ProgramOutcome{}, err
	}
	system, err := platform.Current()
	if err != nil {
		return ProgramOutcome{}, fmt.Errorf("program %s: %w", run.Program, err)
	}
	stdout := &boundedCapture{limit: programOutputMaxBytes}
	stderr := &boundedCapture{limit: programOutputMaxBytes}
	command := &exec.Cmd{
		Path:   path,
		Args:   append([]string{run.Program}, run.Args...),
		Dir:    run.Directory,
		Env:    run.Environment,
		Stdout: stdout,
		Stderr: stderr,
	}
	if err := system.NewProcessGroup(command); err != nil {
		return ProgramOutcome{}, fmt.Errorf("program %s: start failed: %w", run.Program, err)
	}
	started := time.Now()
	if err := command.Start(); err != nil {
		return ProgramOutcome{}, fmt.Errorf("program %s: start failed: %w", run.Program, err)
	}
	if run.OnStart != nil {
		run.OnStart(command.Process.Pid)
	}
	waited := make(chan error, 1)
	go func() {
		waited <- command.Wait()
	}()
	outcome := ProgramOutcome{}
	select {
	case waitErr := <-waited:
		// An exit with a status is the normal end of the program; any other error of the wait is a failure of the run.
		var exit *exec.ExitError
		if waitErr != nil && !errors.As(waitErr, &exit) {
			return outcome, fmt.Errorf("program %s: wait failed: %w", run.Program, waitErr)
		}
		outcome.Result = "exited"
	case <-ctx.Done():
		outcome.Result = string(endCause(ctx))
		killErr := system.EndProcessGroup(command.Process.Pid)
		// The wait of a killed program reports the signal of the kill, which is the expected end of the run.
		<-waited
		if killErr != nil {
			return outcome, fmt.Errorf("program %s: end failed: %w", run.Program, killErr)
		}
	}
	outcome.Duration = time.Since(started)
	outcome.StdoutBytes = stdout.total
	outcome.StderrBytes = stderr.total
	outcome.StdoutTruncated = stdout.truncated()
	outcome.StderrTruncated = stderr.truncated()
	if outcome.Result != "exited" {
		outcome.Signal = syscall.SIGKILL.String()
		return outcome, nil
	}
	state := command.ProcessState
	if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		outcome.Signal = status.Signal().String()
	} else {
		code := state.ExitCode()
		outcome.Code = &code
	}
	stdoutKept := stdout.kept
	if outcome.StdoutTruncated {
		stdoutKept = trimIncompleteTail(stdoutKept)
	}
	stderrKept := stderr.kept
	if outcome.StderrTruncated {
		stderrKept = trimIncompleteTail(stderrKept)
	}
	outcome.Stdout = string(stdoutKept)
	outcome.Stderr = string(stderrKept)
	if !utf8.Valid(stdoutKept) {
		return outcome, fmt.Errorf("program %s: stdout is not UTF-8", run.Name)
	}
	if !utf8.Valid(stderrKept) {
		return outcome, fmt.Errorf("program %s: stderr is not UTF-8", run.Name)
	}
	return outcome, nil
}

// endCause is the ProgramEnd that caused the context to end; a context that ended for another cause is a cancellation.
func endCause(ctx context.Context) ProgramEnd {
	if end, ok := context.Cause(ctx).(ProgramEnd); ok {
		return end
	}
	return ProgramCancelled
}
