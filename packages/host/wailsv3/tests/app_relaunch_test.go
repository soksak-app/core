package host_test

// Checks the command that diagnostics.host.relaunch starts at the end of the process (docs/spec/endpoint.md#diagnostic-builds).

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/tests/support"
)

// relaunchBundle writes a bundle with the executables of the application and of sok and returns the bundle and the
// executable of the application.
func relaunchBundle(t *testing.T) (string, string) {
	t.Helper()
	running := filepath.Join(t.TempDir(), "soksak.app")
	if err := os.MkdirAll(filepath.Join(running, "Contents", "MacOS"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(running, "Contents", "MacOS", "sok"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return running, filepath.Join(running, "Contents", "MacOS", "soksak-wailsv3")
}

// contract: app-relaunch.host.starts-sok-of-the-running-bundle
func TestTheRelaunchStartsSokOfTheRunningBundleWithTheArgumentsOfTheApplication(t *testing.T) {
	running, executable := relaunchBundle(t)
	command, err := host.PrepareAppRelaunch(executable, 4321, []string{"--config-dir", "/config"})
	if err != nil {
		t.Fatal(err)
	}
	sok := filepath.Join(running, "Contents", "MacOS", "sok")
	want := []string{sok, "app", "relaunch", "--wait", "4321", "--target", running, "--", "--config-dir", "/config"}
	if command.Path != sok || !slices.Equal(command.Args[1:], want[1:]) {
		t.Fatalf("the command is %v, want %v", command.Args, want)
	}
	// The command ends after this process, so its message has no reader but the standard error file of the run.
	if command.Stderr != os.Stderr {
		t.Fatalf("the standard error of the command is %v, want the standard error of the host", command.Stderr)
	}
	outside := filepath.Join(t.TempDir(), "soksak-wailsv3")
	_, err = host.PrepareAppRelaunch(outside, 4321, nil)
	if err == nil || err.Error() != "application relaunch: "+outside+" does not run from an application bundle" {
		t.Fatalf("an application outside a bundle gave %v", err)
	}
}

// contract: app-relaunch.host.records-the-detached-command
func TestTheDetachedRelaunchCommandIsRecordedWhenItStarts(t *testing.T) {
	config := t.TempDir()
	log := support.StartWriter(t, config)
	started := exec.Command("/bin/sh", "-c", "exit 0")
	if err := host.StartAppRelaunch(started); err != nil {
		t.Fatal(err)
	}
	if err := started.Wait(); err != nil {
		t.Fatal(err)
	}
	failing := exec.Command(filepath.Join(config, "missing-sok"), "app", "relaunch")
	err := host.StartAppRelaunch(failing)
	if err == nil || !strings.HasPrefix(err.Error(), "application relaunch: start "+filepath.Join(config, "missing-sok")+": ") {
		t.Fatalf("a command that cannot start gave %v, want an error that names it", err)
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var seen []map[string]any
	for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		if event["event"] == "host.relaunch.start" {
			seen = append(seen, event["fields"].(map[string]any))
		}
	}
	if len(seen) != 1 || seen[0]["pid"] != float64(started.Process.Pid) || seen[0]["command"] != "/bin/sh -c exit 0" {
		t.Fatalf("host.relaunch.start events = %v, want one for pid %d with the command line", seen, started.Process.Pid)
	}
}
