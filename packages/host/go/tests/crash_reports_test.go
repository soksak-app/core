// The watch of the crash reports of the system (support/crash_reports.go): the system writes a report into a hidden file and
// renames it to its saved name `<application>-<time>.ips`, and the watch removes only the saved report. The same case runs in
// the Tauri host.
package host_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/soksak-app/core/packages/host/go/tests/support"
)

// contract: test-support.crash-reports.removes-only-the-saved-report
func TestTheWatchRemovesTheSavedReportAndNotTheHiddenFileThatTheSystemRenames(t *testing.T) {
	directory := t.TempDir()
	reports := support.WatchCrashReportsIn(t, directory, "probe")
	body := []byte("{\"app_name\":\"probe\",\"bug_type\":\"309\"}\n{\n  \"pid\" : 4242\n}\n")
	hidden := filepath.Join(directory, ".probe-2026-10-31-000000.ips")
	saved := filepath.Join(directory, "probe-2026-10-31-000000.ips")
	if err := os.WriteFile(hidden, body, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(saved, body, 0o600); err != nil {
		t.Fatal(err)
	}
	reports.Remove(t, 4242)
	if _, err := os.Stat(saved); !os.IsNotExist(err) {
		t.Fatalf("the saved report %s remains: %v", saved, err)
	}
	if _, err := os.Stat(hidden); err != nil {
		t.Fatalf("the watch removed the hidden file %s, which the system renames to the saved report: %v", hidden, err)
	}
}

// contract: test-support.crash-reports.child-runs-under-a-name-of-its-run
func TestACrashingChildRunsACopyOfTheTestExecutableUnderANameOfItsRun(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	expected, err := os.Stat(executable)
	if err != nil {
		t.Fatal(err)
	}
	first := support.CrashingExecutable(t)
	second := support.CrashingExecutable(t)
	if filepath.Base(first) == filepath.Base(second) || filepath.Base(first) == filepath.Base(executable) {
		t.Fatalf("names %s, %s of the test executable %s", first, second, executable)
	}
	for _, path := range []string{first, second} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Size() != expected.Size() || info.Mode().Perm()&0o100 == 0 {
			t.Fatalf("%s has size %d and mode %v, the test executable has size %d", path, info.Size(), info.Mode(), expected.Size())
		}
	}
}
