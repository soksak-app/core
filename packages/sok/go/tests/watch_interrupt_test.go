package tests

import (
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"

	"github.com/soksak-app/core/packages/sok/go/src"
)

// watchChild names the configuration directory of the watch that the child process of
// TestAnInterruptEndsAWatchThatWaitsInAWrite runs.
const watchChild = "SOK_TEST_WATCH_CHILD"

// SIGINT ends a watch whose write to its standard output waits, because nothing reads it: the routine that receives the
// signal closes the connection and ends the process with status 0 (docs/spec/cli.md).
func TestAnInterruptEndsAWatchThatWaitsInAWrite(t *testing.T) {
	if config := os.Getenv(watchChild); config != "" {
		os.Exit(sok.Main([]string{"status", "fixture.value", "--window", "main", "--watch", "--config-dir", config}, os.Stdout, os.Stderr,
			sok.Options{Identifier: "com.soksak.test", PathsDir: pathsDir, CoreVersion: "0.0.2"}))
	}
	// The value is larger than the buffer of a pipe, so its write waits while nothing reads the pipe.
	value := `"` + strings.Repeat("x", 1<<20) + `"`
	fake := startEndpoint(t, func(method string, _ map[string]any) answer {
		switch method {
		case "status.watch":
			return answer{result: "null"}
		case "status.get":
			return answer{result: value}
		}
		return answer{code: -32601, message: "unexpected " + method}
	})
	unread, stdout, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer unread.Close()
	var stderr strings.Builder
	cmd := exec.Command(os.Args[0], "-test.run=^TestAnInterruptEndsAWatchThatWaitsInAWrite$")
	cmd.Env = append(os.Environ(), watchChild+"="+fake.configDir)
	cmd.Stdout, cmd.Stderr = stdout, &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	stdout.Close()
	// The first byte of the value is the start of its write, which cannot end while the rest of the pipe is not read. A watch
	// that never writes leaves the test to the limit of its runner, which reports the stall.
	first := make([]byte, 1)
	if _, err := io.ReadFull(unread, first); err != nil || first[0] != '"' {
		cmd.Process.Signal(syscall.SIGKILL)
		cmd.Wait()
		t.Fatalf("the watch wrote %q (%v), want the start of the value", first, err)
	}
	if err := cmd.Process.Signal(syscall.SIGINT); err != nil {
		t.Fatal(err)
	}
	// The pipe stays unread, so the write still waits while the watch ends. A watch that does not end leaves the test to the
	// limit of its runner.
	code := 0
	if err := cmd.Wait(); err != nil {
		exit, ok := err.(*exec.ExitError)
		if !ok {
			t.Fatal(err)
		}
		code = exit.ExitCode()
	}
	if code != 0 || stderr.String() != "" {
		t.Fatalf("exit status %d stderr %q, want 0 and no error after SIGINT", code, stderr.String())
	}
}
