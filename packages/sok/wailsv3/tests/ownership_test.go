package tests

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// contract: cli.plugin.writing-commands-own-the-configuration
func TestConfigurationOwnershipUsesPrivateProcessLockOperation(t *testing.T) {
	recorder := installPrivateFilesRecorder(t)
	config := t.TempDir()
	var stdout, stderr bytes.Buffer
	code := sok.Run([]string{"plugin", "disable", "probe", "extra", "--config-dir", config}, &stdout, &stderr,
		sok.Options{Identifier: "com.soksak.test", CoreVersion: "0.0.21"})
	if code != 2 || stdout.Len() != 0 {
		t.Fatalf("code %d stdout %q stderr %q, want usage failure after lock acquisition", code, stdout.String(), stderr.String())
	}
	if recorder.openProcessLockFile != 1 {
		t.Fatalf("process lock operation calls %d, want one", recorder.openProcessLockFile)
	}
	if _, err := os.Stat(filepath.Join(config, "process.lock")); !os.IsNotExist(err) {
		t.Fatalf("process lock remains after command: %v", err)
	}
}

// contract: cli.file.errors-name-the-path-and-the-reason
func TestConfigurationOwnershipReportsPrivateProcessLockFailure(t *testing.T) {
	recorder := installPrivateFilesRecorder(t)
	recorder.openProcessLockFileError = fmt.Errorf("process lock file is not implemented on windows")
	config := t.TempDir()
	var stdout, stderr bytes.Buffer
	code := sok.Run([]string{"plugin", "disable", "probe", "--config-dir", config}, &stdout, &stderr,
		sok.Options{Identifier: "com.soksak.test", CoreVersion: "0.0.21"})
	if code != 1 || stdout.Len() != 0 {
		t.Fatalf("code %d stdout %q stderr %q, want writing command failure", code, stdout.String(), stderr.String())
	}
	want := "sok: " + filepath.Join(config, "process.lock") + ": process lock file is not implemented on windows\n"
	if got := stderr.String(); got != want {
		t.Fatalf("stderr %q, want %q", got, want)
	}
	if _, err := os.Stat(filepath.Join(config, "process.lock")); !os.IsNotExist(err) {
		t.Fatalf("failed lock operation created its path: %v", err)
	}
}

// contract: cli.plugin.writing-commands-own-the-configuration
func TestAPluginCommandRefusesWhileAnotherProcessOwnsTheConfiguration(t *testing.T) {
	config := t.TempDir()
	if err := os.MkdirAll(filepath.Join(config, "plugins"), 0o755); err != nil {
		t.Fatal(err)
	}
	// A live process (this test) owns the configuration directory through its lock, as a running host does, in the form of
	// the host: the owner's process identifier and boot identifier.
	lock := filepath.Join(config, "process.lock")
	if err := os.WriteFile(lock, []byte(fmt.Sprintf(`{"pid":%d,"boot":"1700000000-%d"}`, os.Getpid(), os.Getpid())), 0o600); err != nil {
		t.Fatal(err)
	}
	owner, err := os.Open(lock)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	if err := syscall.Flock(int(owner.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	code, _, stderr := run("plugin", "disable", "probe", "--config-dir", config)
	if code != 1 {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	want := "sok: configuration directory " + config + " is already owned by process " + fmt.Sprintf("%d", os.Getpid()) + "\n"
	if stderr != want {
		t.Fatalf("stderr %q, want %q", stderr, want)
	}
	// The host calls RunPluginAction inside its own ownership of the configuration directory, so that entry takes no
	// lock: beside a live owner it still runs (docs/spec/installation.md).
	if err := os.Remove(lock); err != nil {
		t.Fatal(err)
	}
}

// contract: cli.plugin.writing-commands-own-the-configuration
func TestAWritingCommandReleasesTheConfigurationWhenItEnds(t *testing.T) {
	config := t.TempDir()
	writeInstalledRaw(t, config, releasedFormat2)
	for id, version := range map[string]string{"probe": "0.0.4", "probe2": "0.0.2"} {
		plugin := filepath.Join(config, "plugins", id, version)
		if err := os.MkdirAll(plugin, 0o755); err != nil {
			t.Fatal(err)
		}
		name := map[string]string{"probe": "@scope/plugin-probe", "probe2": "@scope/plugin-probe2"}[id]
		if err := os.WriteFile(filepath.Join(plugin, "package.json"), []byte(`{"name":"`+name+`"}`), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(plugin, "plugin.json"), []byte(`{"id":"`+id+`"}`), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	code, _, stderr := run("plugin", "disable", "probe", "--config-dir", config)
	if code != 0 {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	if _, err := os.Stat(filepath.Join(config, "process.lock")); !os.IsNotExist(err) {
		t.Fatalf("the lock stayed: %v", err)
	}
	// A second command runs at once: the first released the configuration when it ended.
	if code, _, stderr := run("plugin", "disable", "probe2", "--config-dir", config); code != 0 {
		t.Fatalf("second code %d stderr %q", code, stderr)
	}
	if strings.Contains(readText(t, filepath.Join(config, "plugins", "installed.json")), "package") {
		t.Fatal("the second command did not see the migrated file")
	}
}

// contract: cli.plugin.host-entry-takes-no-lock
// The host calls RunPluginAction inside its own ownership, so that entry must take no lock: a host that holds
// process.lock for its lifetime still runs its plugin operations.
func TestRunPluginActionTakesNoLockBesideALiveOwner(t *testing.T) {
	config := t.TempDir()
	writeInstalledRaw(t, config, releasedFormat2)
	for id, version := range map[string]string{"probe": "0.0.4", "probe2": "0.0.2"} {
		plugin := filepath.Join(config, "plugins", id, version)
		if err := os.MkdirAll(plugin, 0o755); err != nil {
			t.Fatal(err)
		}
		name := map[string]string{"probe": "@scope/plugin-probe", "probe2": "@scope/plugin-probe2"}[id]
		if err := os.WriteFile(filepath.Join(plugin, "package.json"), []byte(`{"name":"`+name+`"}`), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(plugin, "plugin.json"), []byte(`{"id":"`+id+`"}`), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// The host's own lock is present, owned by this live process.
	if err := os.WriteFile(filepath.Join(config, "process.lock"), []byte(fmt.Sprintf("%d", os.Getpid())), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := sok.RunPluginAction(config, "disable", "probe", "", ""); err != nil {
		t.Fatalf("the host entry refused beside its own lock: %v", err)
	}
}
