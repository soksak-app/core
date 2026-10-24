package tests

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
	"github.com/soksak-app/core/packages/sok/wailsv3/src/platform"
	_ "github.com/soksak-app/core/packages/sok/wailsv3/src/platform/darwin"
	_ "github.com/soksak-app/core/packages/sok/wailsv3/src/platform/linux"
)

type processWaitPlatform struct {
	platform.Platform
	wait func(int, time.Duration) (bool, error)
}

func (p processWaitPlatform) WaitProcessEnd(pid int, timeout time.Duration) (bool, error) {
	return p.wait(pid, timeout)
}

func runProcessWait(t *testing.T, wait func(int, time.Duration) (bool, error), args ...string) (int, string, string) {
	t.Helper()
	previous, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	platform.Register(processWaitPlatform{Platform: previous, wait: wait})
	t.Cleanup(func() { platform.Register(previous) })
	var stdout, stderr bytes.Buffer
	options := sok.Options{Identifier: "com.soksak.test", CoreVersion: "0.0.21"}
	code := sok.Run(args, &stdout, &stderr, options)
	return code, stdout.String(), stderr.String()
}

// contract: cli.process-wait.delegates-to-platform-and-prints-pid
func TestProcessWaitUsesThePlatformAndPrintsTheObservedPid(t *testing.T) {
	called := false
	code, stdout, stderr := runProcessWait(t, func(pid int, timeout time.Duration) (bool, error) {
		called = true
		if pid != 1234 || timeout != 4321*time.Millisecond {
			t.Fatalf("wait received pid=%d timeout=%s", pid, timeout)
		}
		return true, nil
	}, "process", "wait", "1234", "--timeout-ms", "4321", "--config-dir", "/tmp/process-wait")
	if code != 0 || stderr != "" {
		t.Fatalf("process wait returned code=%d stdout=%q stderr=%q", code, stdout, stderr)
	}
	if !called {
		t.Fatal("process wait did not call the platform")
	}
	var result struct {
		PID   int  `json:"pid"`
		Ended bool `json:"ended"`
	}
	if err := json.Unmarshal([]byte(stdout), &result); err != nil || result.PID != 1234 || !result.Ended {
		t.Fatalf("process wait result %q parsed as %+v (%v)", stdout, result, err)
	}
}

// contract: cli.process-wait.timeout-is-an-error
func TestProcessWaitReportsTimeoutAsFailure(t *testing.T) {
	code, stdout, stderr := runProcessWait(t, func(int, time.Duration) (bool, error) { return false, nil },
		"process", "wait", "1234", "--timeout-ms", "4321")
	if code != 1 || stdout != "" || !strings.Contains(stderr, "process 1234 did not end within 4321ms") {
		t.Fatalf("timeout returned code=%d stdout=%q stderr=%q", code, stdout, stderr)
	}
}

// contract: cli.process-wait.platform-error-is-reported
func TestProcessWaitReportsPlatformErrors(t *testing.T) {
	code, stdout, stderr := runProcessWait(t, func(int, time.Duration) (bool, error) { return false, errors.New("kernel wait failed") },
		"process", "wait", "1234", "--timeout-ms", "4321")
	if code != 1 || stdout != "" || !strings.Contains(stderr, "kernel wait failed") {
		t.Fatalf("platform error returned code=%d stdout=%q stderr=%q", code, stdout, stderr)
	}
}

// contract: cli.process-wait.rejects-invalid-pid-and-timeout
func TestProcessWaitRejectsInvalidInputsBeforeThePlatformCall(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"missing pid", []string{"process", "wait", "--timeout-ms", "1"}, "process wait requires a pid"},
		{"missing timeout", []string{"process", "wait", "1234"}, "--timeout-ms is required"},
		{"zero pid", []string{"process", "wait", "0", "--timeout-ms", "1"}, "pid must be an integer from 1 to 2147483647"},
		{"negative pid", []string{"process", "wait", "-1", "--timeout-ms", "1"}, "pid must be an integer from 1 to 2147483647"},
		{"signed pid", []string{"process", "wait", "+1", "--timeout-ms", "1"}, "pid must be an integer from 1 to 2147483647"},
		{"overflow pid", []string{"process", "wait", "2147483648", "--timeout-ms", "1"}, "pid must be an integer from 1 to 2147483647"},
		{"nondecimal pid", []string{"process", "wait", "1x", "--timeout-ms", "1"}, "pid must be an integer from 1 to 2147483647"},
		{"zero timeout", []string{"process", "wait", "1", "--timeout-ms", "0"}, "timeout must be an integer from 1 to 600000 milliseconds"},
		{"negative timeout", []string{"process", "wait", "1", "--timeout-ms", "-1"}, "timeout must be an integer from 1 to 600000 milliseconds"},
		{"overflow timeout", []string{"process", "wait", "1", "--timeout-ms", "600001"}, "timeout must be an integer from 1 to 600000 milliseconds"},
		{"nondecimal timeout", []string{"process", "wait", "1", "--timeout-ms", "1x"}, "timeout must be an integer from 1 to 600000 milliseconds"},
		{"duplicate timeout", []string{"process", "wait", "1", "--timeout-ms", "1", "--timeout-ms", "2"}, "--timeout-ms is given twice"},
		{"unknown process option", []string{"process", "wait", "1", "--timeout-ms", "1", "--window", "main"}, "unknown option --window"},
		{"unexpected argument", []string{"process", "wait", "1", "extra", "--timeout-ms", "1"}, "unexpected argument extra"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			called := false
			code, stdout, stderr := runProcessWait(t, func(int, time.Duration) (bool, error) {
				called = true
				return true, nil
			}, c.args...)
			if code != 2 || stdout != "" || !strings.Contains(stderr, c.want) || called {
				t.Fatalf("invalid input returned code=%d stdout=%q stderr=%q platformCalled=%v", code, stdout, stderr, called)
			}
		})
	}
}

// contract: cli.process-wait.requires-an-action
func TestProcessCommandRequiresAnAction(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := sok.Run([]string{"process"}, &stdout, &stderr,
		sok.Options{Identifier: "com.soksak.test", CoreVersion: "0.0.21"})
	if code != 2 || stdout.Len() != 0 || !strings.Contains(stderr.String(), "process requires an action") {
		t.Fatalf("process command returned code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
}

// contract: cli.process-wait.option-is-command-scoped
func TestProcessWaitTimeoutOptionDoesNotChangeOtherCommands(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := sok.Run([]string{"windows", "--timeout-ms", "1"}, &stdout, &stderr,
		sok.Options{Identifier: "com.soksak.test", CoreVersion: "0.0.21"})
	if code != 2 || stdout.Len() != 0 || !strings.Contains(stderr.String(), "unknown option --timeout-ms") {
		t.Fatalf("other command returned code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
}

// contract: cli.process-wait.repeated-help-is-idempotent
func TestProcessWaitRepeatedHelpIsIdempotent(t *testing.T) {
	code, stdout, stderr := runProcessWait(t, func(int, time.Duration) (bool, error) {
		t.Fatal("help must not wait for a process")
		return false, nil
	}, "process", "wait", "--help", "--help")
	if code != 0 || !strings.Contains(stdout, "process wait PID") || stderr != "" {
		t.Fatalf("repeated help returned code=%d stdout=%q stderr=%q", code, stdout, stderr)
	}
}
