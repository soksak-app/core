//go:build darwin

package system_test

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/platform/darwin/standalone"
)

// crashOutputChild is the environment variable that tells the crashing child process the configuration directory.
const crashOutputChild = "SOKSAK_CRASH_OUTPUT_CHILD"

// A runtime fatal error of the host writes its output to logs/host-<boot>.crash and ends the process with SIGABRT. The test
// judges only that crash file and that signal; the system crash report is kept from being written by a handled crash exception.
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
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	config := t.TempDir()
	output, err := os.Create(filepath.Join(t.TempDir(), "output"))
	if err != nil {
		t.Fatal(err)
	}
	defer output.Close()
	pid, handle, err := standalone.SpawnHandledCrashChild(executable, "-test.run=^TestStartStandardErrorWritesAFatalErrorToTheCrashFileAndEndsTheProcessWithTheSystemCrash$", crashOutputChild+"="+config, output)
	if err != nil {
		t.Fatal(err)
	}
	status, handled, err := standalone.WaitHandledCrashChild(handle)
	if err != nil {
		t.Fatal(err)
	}
	childOutput, _ := os.ReadFile(output.Name())
	// The exception port answers each crash of the child, so the system writes no crash report for the child.
	if handled != 1 {
		t.Fatalf("child %d answered %d system crash exceptions, expected 1; output %q", pid, handled, childOutput)
	}
	wait := syscall.WaitStatus(status)
	if !wait.Signaled() || wait.Signal() != syscall.SIGABRT {
		t.Fatalf("child ended with wait status %#x, expected the signal SIGABRT; output %q", status, childOutput)
	}
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
