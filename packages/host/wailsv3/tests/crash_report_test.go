// The crash reports of the system (docs/spec/logging.md#automatic-entrances): the start of the host announces each crash report
// of the application once as the event `host.crash.found`. The same cases run in the Tauri host.
package host_test

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// writeCrashReport writes a report of the process pid of the application in the form of the system: a header line with
// the name and the time, and the body, a JSON document with the process identifier.
func writeCrashReport(t *testing.T, directory, name, application string, pid int, stamp string) string {
	t.Helper()
	path := filepath.Join(directory, name)
	text := fmt.Sprintf("{\"app_name\":%q,\"timestamp\":%q,\"bug_type\":\"309\"}\n{\n  \"pid\" : %d,\n  \"procName\" : %q\n}\n", application, stamp, pid, application)
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// foundEvents flushes the writer and returns the events `host.crash.found` that it stored.
func foundEvents(t *testing.T, log *host.EventLog) []map[string]any {
	t.Helper()
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var found []map[string]any
	for _, event := range readEventLog(t, log.Path()) {
		if event["event"] == "host.crash.found" {
			found = append(found, event)
		}
	}
	return found
}

// contract: diagnostics.crash.report-is-announced-once
func TestACrashReportOfTheApplicationIsAnnouncedOnce(t *testing.T) {
	log := useEventLog(t)
	reports, ledger := t.TempDir(), filepath.Join(t.TempDir(), "crash-found.txt")
	path := writeCrashReport(t, reports, "soksak-2026-10-11-023343.ips", "soksak", 4242, "2026-10-11 02:33:43.00 +0900")
	for run := 0; run < 2; run++ {
		if err := host.AnnounceCrashReports(reports, ledger, "soksak"); err != nil {
			t.Fatal(err)
		}
	}
	found := foundEvents(t, log)
	if len(found) != 1 {
		t.Fatalf("%d events host.crash.found after two starts, want 1: %v", len(found), found)
	}
	fields := found[0]["fields"].(map[string]any)
	if found[0]["level"] != "warn" || fields["path"] != path || fields["pid"] != float64(4242) || fields["time"] != "2026-10-11 02:33:43.00 +0900" {
		t.Fatalf("event %v", found[0])
	}
	// A report that appears after the first start is announced at the next start, and the earlier one is not announced again.
	later := writeCrashReport(t, reports, "soksak-2026-10-12-010000.ips", "soksak", 77, "2026-10-12 01:00:00.00 +0900")
	if err := host.AnnounceCrashReports(reports, ledger, "soksak"); err != nil {
		t.Fatal(err)
	}
	found = foundEvents(t, log)
	if len(found) != 2 || found[1]["fields"].(map[string]any)["path"] != later {
		t.Fatalf("events after the later report: %v", found)
	}
}

// contract: diagnostics.crash.report-belongs-to-the-application
func TestOnlyAReportOfTheApplicationIsAnnounced(t *testing.T) {
	log := useEventLog(t)
	reports, ledger := t.TempDir(), filepath.Join(t.TempDir(), "crash-found.txt")
	writeCrashReport(t, reports, "other-2026-10-11-023343.ips", "other", 1, "2026-10-11 02:33:43.00 +0900")
	writeCrashReport(t, reports, "soksak-helper-2026-10-11-023344.ips", "soksak-helper", 2, "2026-10-11 02:33:44.00 +0900")
	if err := os.WriteFile(filepath.Join(reports, "soksak-2026-10-11-023345.diag"), []byte("not a crash report"), 0o600); err != nil {
		t.Fatal(err)
	}
	mine := writeCrashReport(t, reports, "soksak-2026-10-11-023346.ips", "soksak", 3, "2026-10-11 02:33:46.00 +0900")
	if err := host.AnnounceCrashReports(reports, ledger, "soksak"); err != nil {
		t.Fatal(err)
	}
	found := foundEvents(t, log)
	if len(found) != 1 || found[0]["fields"].(map[string]any)["path"] != mine {
		t.Fatalf("events %v, want only %s", found, mine)
	}
}

// contract: diagnostics.crash.lookup-is-bounded
func TestTheLookupOfCrashReportsReadsTheNewestReportsOnly(t *testing.T) {
	log := useEventLog(t)
	reports, ledger := t.TempDir(), filepath.Join(t.TempDir(), "crash-found.txt")
	for i := 0; i < host.CrashReportLimit+6; i++ {
		writeCrashReport(t, reports, fmt.Sprintf("soksak-2026-10-11-%06d.ips", i), "soksak", 100+i, "2026-10-11 00:00:00.00 +0900")
	}
	if err := host.AnnounceCrashReports(reports, ledger, "soksak"); err != nil {
		t.Fatal(err)
	}
	found := foundEvents(t, log)
	if len(found) != host.CrashReportLimit {
		t.Fatalf("%d events host.crash.found, want %d", len(found), host.CrashReportLimit)
	}
	if first := found[0]["fields"].(map[string]any)["path"].(string); !strings.HasSuffix(first, "000006.ips") {
		t.Fatalf("the oldest announced report is %s, want the seventh", first)
	}
}

// contract: diagnostics.crash.unreadable-report-is-an-error
func TestAReportThatCannotBeReadIsAnErrorAndIsNotRepeated(t *testing.T) {
	log := useEventLog(t)
	reports, ledger := t.TempDir(), filepath.Join(t.TempDir(), "crash-found.txt")
	broken := filepath.Join(reports, "soksak-2026-10-11-023343.ips")
	if err := os.WriteFile(broken, []byte("{\"app_name\":\"soksak\",\"timestamp\":\"2026-10-11 02:33:43.00 +0900\"}\nnot json\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := host.AnnounceCrashReports(reports, ledger, "soksak")
	if err == nil || !strings.Contains(err.Error(), broken) || !strings.Contains(err.Error(), "pid") {
		t.Fatalf("error %v, want one that names %s and the pid", err, broken)
	}
	if again := host.AnnounceCrashReports(reports, ledger, "soksak"); again != nil {
		t.Fatalf("the second start reports %v, want nothing: the error was reported once", again)
	}
	if found := foundEvents(t, log); len(found) != 0 {
		t.Fatalf("events %v for a report without a pid", found)
	}
}

// contract: diagnostics.crash.missing-folder-has-no-reports
func TestAMissingFolderOfCrashReportsHasNoReports(t *testing.T) {
	log := useEventLog(t)
	missing := filepath.Join(t.TempDir(), "absent")
	if err := host.AnnounceCrashReports(missing, filepath.Join(t.TempDir(), "crash-found.txt"), "soksak"); err != nil {
		t.Fatalf("a folder that the system has not created yet is an error: %v", err)
	}
	if found := foundEvents(t, log); len(found) != 0 {
		t.Fatalf("events %v for a missing folder", found)
	}
}

// contract: diagnostics.crash.folder-that-cannot-be-read-is-an-error
func TestAFolderOfCrashReportsThatCannotBeReadIsAnError(t *testing.T) {
	useEventLog(t)
	file := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	err := host.AnnounceCrashReports(file, filepath.Join(t.TempDir(), "crash-found.txt"), "soksak")
	if err == nil || !strings.Contains(err.Error(), file) {
		t.Fatalf("error %v, want one that names %s", err, file)
	}
}

// contract: diagnostics.crash.folder-is-named-by-the-platform
func TestThePlatformNamesTheFolderOfCrashReports(t *testing.T) {
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	directory, err := system.DiagnosticReportsDirectory()
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(directory) || !strings.HasSuffix(directory, "/Library/Logs/DiagnosticReports") {
		t.Fatalf("the folder of the crash reports is %q", directory)
	}
}
