package host

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Programs of a test run with the PATH of the test environment, so each test names its own PATH.
var programRunEnvironment = []string{"PATH=/usr/bin:/bin"}

// runProgramOrFail runs one program and fails the test when the run answers an error that the test does not expect.
func runProgramOrFail(t *testing.T, run ProgramRun) ProgramOutcome {
	t.Helper()
	outcome, err := RunProgram(context.Background(), run)
	if err != nil {
		t.Fatalf("RunProgram: %v", err)
	}
	return outcome
}

// contract: program.run.exit-reply
func TestProgramRunReplyCarriesExitStatusAndOutput(t *testing.T) {
	outcome := runProgramOrFail(t, ProgramRun{
		Name: "run", Program: "/bin/sh", Args: []string{"-c", "echo ok; echo warn >&2; exit 3"},
		Directory: t.TempDir(), Environment: programRunEnvironment,
	})
	if outcome.Result != "exited" || outcome.Code == nil || *outcome.Code != 3 {
		t.Fatalf("result %q code %v, want exited with 3", outcome.Result, outcome.Code)
	}
	if outcome.Stdout != "ok\n" || outcome.Stderr != "warn\n" {
		t.Fatalf("stdout %q stderr %q", outcome.Stdout, outcome.Stderr)
	}
	if outcome.StdoutTruncated || outcome.StderrTruncated {
		t.Fatal("a short output was marked truncated")
	}
}

// contract: program.run.argument-vector-without-shell
func TestProgramRunArgumentsReachTheProgramWithoutShell(t *testing.T) {
	outcome := runProgramOrFail(t, ProgramRun{
		Name: "run", Program: "/usr/bin/printf", Args: []string{"%s\n", "$HOME", ";"},
		Directory: t.TempDir(), Environment: programRunEnvironment,
	})
	if outcome.Stdout != "$HOME\n;\n" {
		t.Fatalf("stdout %q: the arguments were expanded or split", outcome.Stdout)
	}
}

// contract: program.run.path-lookup-as-terminal
func TestProgramRunBareNameIsFoundThroughTheRunPath(t *testing.T) {
	outcome := runProgramOrFail(t, ProgramRun{
		Name: "run", Program: "sh", Args: []string{"-c", "exit 0"},
		Directory: t.TempDir(), Environment: []string{"PATH=/nonexistent-folder:/bin:/usr/bin"},
	})
	if outcome.Result != "exited" {
		t.Fatalf("result %q", outcome.Result)
	}
	_, err := RunProgram(context.Background(), ProgramRun{
		Name: "run", Program: "soksak-no-such-program", Directory: t.TempDir(), Environment: programRunEnvironment,
	})
	if err == nil || err.Error() != "program not found: soksak-no-such-program" {
		t.Fatalf("error %v, want program not found", err)
	}
}

// contract: program.run.relative-path-from-project
func TestProgramRunRelativePathResolvesFromTheProjectFolder(t *testing.T) {
	project := t.TempDir()
	folder := filepath.Join(project, "bin")
	if err := os.Mkdir(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(folder, "tool")
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho relative\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	outcome := runProgramOrFail(t, ProgramRun{
		Name: "run", Program: "bin/tool", Directory: project, Environment: programRunEnvironment,
	})
	if outcome.Stdout != "relative\n" {
		t.Fatalf("stdout %q", outcome.Stdout)
	}
}

// contract: program.run.working-directory-is-project
func TestProgramRunWorkingDirectoryIsTheProjectFolder(t *testing.T) {
	project, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	outcome := runProgramOrFail(t, ProgramRun{
		Name: "run", Program: "/bin/pwd", Directory: project, Environment: programRunEnvironment,
	})
	if strings.TrimSpace(outcome.Stdout) != project {
		t.Fatalf("working directory %q, want %q", outcome.Stdout, project)
	}
}

// contract: program.run.standard-input-is-null
func TestProgramRunStandardInputIsEndOfFile(t *testing.T) {
	outcome := runProgramOrFail(t, ProgramRun{
		Name: "run", Program: "/bin/cat", Directory: t.TempDir(), Environment: programRunEnvironment,
	})
	if outcome.Result != "exited" || outcome.Stdout != "" {
		t.Fatalf("result %q stdout %q: standard input was not the end of file", outcome.Result, outcome.Stdout)
	}
}

// contract: program.run.output-bound-truncates
func TestProgramRunOutputBeyondTheBoundIsDiscardedAndMarked(t *testing.T) {
	outcome := runProgramOrFail(t, ProgramRun{
		Name: "run", Program: "/bin/sh", Args: []string{"-c", "head -c 1048577 /dev/zero"},
		Directory: t.TempDir(), Environment: programRunEnvironment,
	})
	if int64(len(outcome.Stdout)) != programOutputMaxBytes || !outcome.StdoutTruncated {
		t.Fatalf("kept %d bytes, truncated %v", len(outcome.Stdout), outcome.StdoutTruncated)
	}
	if outcome.StdoutBytes != programOutputMaxBytes+1 {
		t.Fatalf("counted %d bytes, want %d", outcome.StdoutBytes, programOutputMaxBytes+1)
	}
}

// A kept part that ends inside a UTF-8 character ends before that character (docs/spec/native-surfaces.md#program-runs).
func TestProgramRunTruncationKeepsWholeCharacters(t *testing.T) {
	outcome := runProgramOrFail(t, ProgramRun{
		Name: "run", Program: "/bin/sh",
		Args:      []string{"-c", "head -c 1048575 /dev/zero | tr '\\000' a; printf '\\303\\251'"},
		Directory: t.TempDir(), Environment: programRunEnvironment,
	})
	if len(outcome.Stdout) != programOutputMaxBytes-1 || !outcome.StdoutTruncated {
		t.Fatalf("kept %d bytes, truncated %v: the character was cut", len(outcome.Stdout), outcome.StdoutTruncated)
	}
}

// contract: program.run.output-not-utf8-fails
func TestProgramRunStreamThatIsNotUTF8Fails(t *testing.T) {
	_, err := RunProgram(context.Background(), ProgramRun{
		Name: "run", Program: "/bin/sh", Args: []string{"-c", "printf '\\377' >&2"},
		Directory: t.TempDir(), Environment: programRunEnvironment,
	})
	if err == nil || err.Error() != "program run: stderr is not UTF-8" {
		t.Fatalf("error %v, want stderr is not UTF-8", err)
	}
}

// contract: program.run.start-failure-text
func TestProgramRunStartFailureNamesTheProgram(t *testing.T) {
	file := filepath.Join(t.TempDir(), "plain")
	if err := os.WriteFile(file, []byte("not a program\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := RunProgram(context.Background(), ProgramRun{
		Name: "run", Program: file, Directory: t.TempDir(), Environment: programRunEnvironment,
	})
	if err == nil || !strings.HasPrefix(err.Error(), "program "+file+": start failed: ") {
		t.Fatalf("error %v, want the start failure of %s", err, file)
	}
}

// contract: program.run.cancel-ends-the-group
func TestProgramRunCancelKillsTheProgramGroup(t *testing.T) {
	ctx, cancel := context.WithCancelCause(context.Background())
	started := make(chan struct{})
	done := make(chan ProgramOutcome, 1)
	go func() {
		outcome, _ := RunProgram(ctx, ProgramRun{
			Name: "run", Program: "/bin/sh", Args: []string{"-c", "sleep 30 & echo started; wait"},
			Directory: t.TempDir(), Environment: programRunEnvironment,
			OnStart: func(int) { close(started) },
		})
		done <- outcome
	}()
	<-started
	cancel(ProgramCancelled)
	select {
	case outcome := <-done:
		if outcome.Result != "cancelled" {
			t.Fatalf("result %q, want cancelled", outcome.Result)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the run did not end: the child of the program kept the pipes open")
	}
}

// contract: program.run.view-end-ends-the-run, program.run.surface-close-ends-the-run, program.run.window-close-ends-the-run
func TestProgramRunEndKindsAreReportedAsTheirResult(t *testing.T) {
	for _, end := range []ProgramEnd{ProgramProcessEnded, ProgramSurfaceClosed, ProgramWindowClosed} {
		ctx, cancel := context.WithCancelCause(context.Background())
		started := make(chan struct{})
		done := make(chan ProgramOutcome, 1)
		go func() {
			outcome, _ := RunProgram(ctx, ProgramRun{
				Name: "run", Program: "/bin/sleep", Args: []string{"30"},
				Directory: t.TempDir(), Environment: programRunEnvironment,
				OnStart: func(int) { close(started) },
			})
			done <- outcome
		}()
		<-started
		cancel(end)
		select {
		case outcome := <-done:
			if outcome.Result != string(end) {
				t.Fatalf("result %q, want %q", outcome.Result, end)
			}
		case <-time.After(10 * time.Second):
			t.Fatalf("the run ended by %s did not end", end)
		}
	}
}
