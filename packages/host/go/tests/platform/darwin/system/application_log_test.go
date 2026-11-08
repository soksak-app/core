//go:build darwin

package system_test

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/support"
)

// crashOutputChild is the environment variable that tells the crashing child process the configuration directory.
const crashOutputChild = "SOKSAK_CRASH_OUTPUT_CHILD"

// A runtime fatal error of the host writes its output to logs/host-<boot>.crash and ends the process with SIGABRT, so the
// system writes a crash report that holds the native frames of every thread (docs/spec/logging.md#files). The test removes the
// crash report that the system writes for its child.
// contract: log.fatal-error.writes-the-crash-file
func TestStartStandardErrorWritesAFatalErrorToTheCrashFileAndEndsTheProcessWithTheSystemCrash(t *testing.T) {
	if config := os.Getenv(crashOutputChild); config != "" {
		log, err := host.StartHostEventLog(config)
		if err != nil {
			os.Stdout.WriteString(err.Error() + "\n")
			os.Exit(2)
		}
		host.UseHostEventLog(log)
		if err := host.StartStandardError(config, "com.soksak.test"); err != nil {
			os.Stdout.WriteString(err.Error() + "\n")
			os.Exit(2)
		}
		var table map[string]int
		done := make(chan struct{})
		// The channel closes only after the assignment: a panicking goroutine runs its deferred calls before the runtime writes the
		// fatal error, so a deferred close would let os.Exit(0) end the child before the crash.
		go func() {
			table["entry"] = 1
			close(done)
		}()
		<-done
		os.Exit(0)
	}
	executable := support.CrashingExecutable(t)
	reports := support.WatchCrashReports(t, filepath.Base(executable))
	config := t.TempDir()
	command := exec.Command(executable, "-test.run=^TestStartStandardErrorWritesAFatalErrorToTheCrashFileAndEndsTheProcessWithTheSystemCrash$")
	command.Env = append(os.Environ(), crashOutputChild+"="+config)
	output, err := command.Output()
	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		t.Fatalf("child ended with %v, output %q", err, output)
	}
	status := exit.Sys().(syscall.WaitStatus)
	if !status.Signaled() || status.Signal() != syscall.SIGABRT {
		t.Fatalf("child ended with %v, expected the signal SIGABRT; output %q", exit, output)
	}
	reports.Remove(t, command.Process.Pid)
	crash, err := filepath.Glob(filepath.Join(config, "logs", "host-*.crash"))
	if err != nil || len(crash) != 1 {
		t.Fatalf("crash files %v, %v", crash, err)
	}
	data, err := os.ReadFile(crash[0])
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "panic: assignment to entry in nil map") {
		t.Fatalf("crash file %q", data)
	}
}
