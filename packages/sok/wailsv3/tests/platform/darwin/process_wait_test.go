//go:build darwin

package darwin

import (
	"encoding/json"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"

	_ "github.com/soksak-app/core/packages/sok/wailsv3/src/platform/darwin"
	"github.com/soksak-app/core/packages/sok/wailsv3/tests/support"
)

func TestProcessWaitChild(t *testing.T) {
	if os.Getenv("SOKSAK_PROCESS_WAIT_CHILD") == "1" {
		os.Exit(0)
	}
}

// contract: cli.process-wait.timeout-is-an-error
func TestProcessWaitReportsTimeout(t *testing.T) {
	pid := os.Getpid()
	code, stdout, stderr := support.RunProcessWait("process", "wait", strconv.Itoa(pid), "--timeout-ms", "1")
	if code != 1 || stdout != "" || !strings.Contains(stderr, "process "+strconv.Itoa(pid)+" did not end within 1ms") {
		t.Fatalf("timeout returned code=%d stdout=%q stderr=%q", code, stdout, stderr)
	}
}

// contract: cli.process-wait.reports-pid-absent
func TestProcessWaitReportsAnAlreadyEndedPID(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command(executable, "-test.run=^TestProcessWaitChild$")
	child.Env = append(os.Environ(), "SOKSAK_PROCESS_WAIT_CHILD=1")
	if output, err := child.CombinedOutput(); err != nil {
		t.Fatalf("run child: %v: %s", err, output)
	}
	pid := child.Process.Pid
	code, stdout, stderr := support.RunProcessWait("process", "wait", strconv.Itoa(pid), "--timeout-ms", "1000", "--config-dir", "/tmp/process-wait")
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
