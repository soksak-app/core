package tests

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"syscall"
	"testing"

	sok "github.com/soksak-app/core/packages/sok/go/src"
	"github.com/soksak-app/core/packages/sok/go/src/platform"
	_ "github.com/soksak-app/core/packages/sok/go/src/platform/darwin"
	_ "github.com/soksak-app/core/packages/sok/go/src/platform/linux"
	testplatform "github.com/soksak-app/core/packages/sok/go/tests/platform"
)

type processWaitPlatform struct {
	platform.Platform
	wait func(int) error
}

// WaitProcessEnd takes no time limit: it returns when the process ended, or with the error of the operating system.
func (p processWaitPlatform) WaitProcessEnd(pid int) error {
	return p.wait(pid)
}

func runProcessWait(t *testing.T, wait func(int) error, args ...string) (int, string, string) {
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

// contract: cli.process-wait.registered-platform-receives-request
// contract: cli.process-wait.takes-no-time-limit
func TestProcessWaitUsesThePlatformAndPrintsTheObservedPid(t *testing.T) {
	called := false
	code, stdout, stderr := runProcessWait(t, func(pid int) error {
		called = true
		if pid != 1234 {
			t.Fatalf("wait received pid=%d", pid)
		}
		return nil
	}, "process", "wait", "1234", "--config-dir", "/tmp/process-wait")
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

// A signal that sok receives while the platform waits ends the wait. The platform signals when the wait began, which is the
// point at which the wait has not ended; then the test sends the signal to its own process and receives the answer, and
// only after the answer lets the platform wait return.
// contract: cli.process-wait.signal-ends-the-wait
func TestProcessWaitEndsByASignal(t *testing.T) {
	for _, c := range []struct {
		name   string
		signal syscall.Signal
	}{{"SIGINT", syscall.SIGINT}, {"SIGTERM", syscall.SIGTERM}} {
		t.Run(c.name, func(t *testing.T) {
			began := make(chan struct{})
			release := make(chan struct{})
			defer close(release)
			type answer struct {
				code           int
				stdout, stderr string
			}
			answered := make(chan answer, 1)
			go func() {
				code, stdout, stderr := runProcessWait(t, func(int) error {
					close(began)
					<-release
					return nil
				}, "process", "wait", "1234")
				answered <- answer{code, stdout, stderr}
			}()
			<-began
			select {
			case got := <-answered:
				t.Fatalf("the wait answered before the process ended: %+v", got)
			default:
			}
			if err := testplatform.SignalSelf(c.signal); err != nil {
				t.Fatal(err)
			}
			got := <-answered
			want := "process 1234 wait was interrupted by " + c.name
			if got.code != 1 || got.stdout != "" || !strings.Contains(got.stderr, want) {
				t.Fatalf("interrupted wait returned code=%d stdout=%q stderr=%q, want %q", got.code, got.stdout, got.stderr, want)
			}
		})
	}
}

// contract: cli.process-wait.platform-error-is-reported
func TestProcessWaitReportsPlatformErrors(t *testing.T) {
	code, stdout, stderr := runProcessWait(t, func(int) error { return errors.New("kernel wait failed") },
		"process", "wait", "1234")
	if code != 1 || stdout != "" || !strings.Contains(stderr, "kernel wait failed") {
		t.Fatalf("platform error returned code=%d stdout=%q stderr=%q", code, stdout, stderr)
	}
}

// contract: cli.process-wait.rejects-invalid-arguments
func TestProcessWaitRejectsInvalidInputsBeforeThePlatformCall(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"missing pid", []string{"process", "wait"}, "process wait requires a pid"},
		{"zero pid", []string{"process", "wait", "0"}, "pid must be an integer from 1 to 2147483647"},
		{"negative pid", []string{"process", "wait", "-1"}, "pid must be an integer from 1 to 2147483647"},
		{"signed pid", []string{"process", "wait", "+1"}, "pid must be an integer from 1 to 2147483647"},
		{"overflow pid", []string{"process", "wait", "2147483648"}, "pid must be an integer from 1 to 2147483647"},
		{"nondecimal pid", []string{"process", "wait", "1x"}, "pid must be an integer from 1 to 2147483647"},
		{"time limit", []string{"process", "wait", "1", "--timeout-ms", "1"}, "unknown option --timeout-ms"},
		{"duplicate config dir", []string{"process", "wait", "1", "--config-dir", "/tmp/a", "--config-dir", "/tmp/b"}, "--config-dir is given twice"},
		{"unknown process option", []string{"process", "wait", "1", "--window", "main"}, "unknown option --window"},
		{"unexpected argument", []string{"process", "wait", "1", "extra"}, "unexpected argument extra"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			called := false
			code, stdout, stderr := runProcessWait(t, func(int) error {
				called = true
				return nil
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

// contract: cli.process-wait.repeated-help-is-idempotent
func TestProcessWaitRepeatedHelpIsIdempotent(t *testing.T) {
	code, stdout, stderr := runProcessWait(t, func(int) error {
		t.Fatal("help must not wait for a process")
		return nil
	}, "process", "wait", "--help", "--help")
	if code != 0 || !strings.Contains(stdout, "process wait PID") || stderr != "" {
		t.Fatalf("repeated help returned code=%d stdout=%q stderr=%q", code, stdout, stderr)
	}
}
