//go:build darwin

package darwin

import (
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"

	_ "github.com/soksak-app/core/packages/sok/go/src/platform/darwin"
	"github.com/soksak-app/core/packages/sok/go/tests/support"
)

func TestMain(m *testing.M) {
	switch os.Getenv("SOKSAK_PROCESS_WAIT_CHILD") {
	case "1":
		os.Exit(0)
	case "stdin":
		// The child runs until the test closes its standard input.
		_, _ = io.Copy(io.Discard, os.Stdin)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// The wait has no time limit: it answers when the process the test controls exits, which the test causes by closing the
// standard input of the process.
// contract: cli.process-wait.takes-no-time-limit
func TestProcessWaitEndsByTheExitOfTheProcess(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command(executable)
	child.Env = append(os.Environ(), "SOKSAK_PROCESS_WAIT_CHILD=stdin")
	input, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	pid := child.Process.Pid
	type result struct {
		code           int
		stdout, stderr string
	}
	answered := make(chan result, 1)
	go func() {
		code, stdout, stderr := support.RunProcessWait("process", "wait", strconv.Itoa(pid))
		answered <- result{code, stdout, stderr}
	}()
	if err := input.Close(); err != nil {
		t.Fatal(err)
	}
	if err := child.Wait(); err != nil {
		t.Fatalf("child: %v", err)
	}
	got := <-answered
	if got.code != 0 || got.stderr != "" {
		t.Fatalf("process wait returned code=%d stdout=%q stderr=%q", got.code, got.stdout, got.stderr)
	}
	var ended struct {
		PID   int  `json:"pid"`
		Ended bool `json:"ended"`
	}
	if err := json.Unmarshal([]byte(got.stdout), &ended); err != nil || ended.PID != pid || !ended.Ended {
		t.Fatalf("process wait result %q parsed as %+v (%v)", got.stdout, ended, err)
	}
}

// contract: cli.process-wait.reports-pid-absent
func TestProcessWaitReportsAnAlreadyEndedPID(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command(executable)
	child.Env = append(os.Environ(), "SOKSAK_PROCESS_WAIT_CHILD=1")
	if output, err := child.CombinedOutput(); err != nil {
		t.Fatalf("run child: %v: %s", err, output)
	}
	pid := child.Process.Pid
	code, stdout, stderr := support.RunProcessWait("process", "wait", strconv.Itoa(pid), "--config-dir", "/tmp/process-wait")
	if code != 0 || stderr != "" {
		t.Fatalf("already-ended pid returned code=%d stdout=%q stderr=%q", code, stdout, stderr)
	}
	var result struct {
		PID   int  `json:"pid"`
		Ended bool `json:"ended"`
	}
	if err := json.Unmarshal([]byte(stdout), &result); err != nil {
		t.Fatalf("parse process wait result %q: %v", stdout, err)
	}
	if result.PID != pid || !result.Ended {
		t.Fatalf("process wait result = %+v, want pid %d ended", result, pid)
	}
}
