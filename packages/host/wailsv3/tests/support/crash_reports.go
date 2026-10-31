package support

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// CrashReports watches the folder in which the system writes crash reports, so a test whose child crashes on purpose removes
// the report that the system writes for that child.
type CrashReports struct {
	watcher     *fsnotify.Watcher
	directory   string
	application string
}

// WatchCrashReports starts the watch of the crash reports of application before the test starts the child that crashes.
func WatchCrashReports(t *testing.T, application string) *CrashReports {
	t.Helper()
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	directory, err := system.DiagnosticReportsDirectory()
	if err != nil {
		t.Fatal(err)
	}
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := watcher.Close(); err != nil {
			t.Errorf("crash report watch: %v", err)
		}
	})
	if err := watcher.Add(directory); err != nil {
		t.Fatalf("crash report watch of %s: %v", directory, err)
	}
	return &CrashReports{watcher: watcher, directory: directory, application: application}
}

// Remove waits until the system wrote the crash report of the process pid and removes it. The wait ends one second before the
// limit of the test when no report arrives, so the failure names the missing report instead of the limit.
func (r *CrashReports) Remove(t *testing.T, pid int) {
	t.Helper()
	var limit <-chan time.Time
	if deadline, ok := t.Deadline(); ok {
		limit = time.After(time.Until(deadline) - time.Second)
	}
	for {
		select {
		case event := <-r.watcher.Events:
			name := filepath.Base(event.Name)
			if !strings.HasPrefix(name, r.application+"-") || !strings.HasSuffix(name, ".ips") {
				continue
			}
			if crashReportPid(event.Name) != pid {
				continue
			}
			if err := os.Remove(event.Name); err != nil {
				t.Fatalf("remove the crash report %s: %v", event.Name, err)
			}
			return
		case err := <-r.watcher.Errors:
			t.Fatalf("crash report watch of %s: %v", r.directory, err)
		case <-limit:
			t.Fatalf("the system wrote no crash report of process %d in %s", pid, r.directory)
		}
	}
}

// crashReportPid is the pid of the body of a report, the JSON value after the header line, or 0 while the system has not
// written the whole body.
func crashReportPid(path string) int {
	file, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer file.Close()
	reader := bufio.NewReader(file)
	if _, err := reader.ReadString('\n'); err != nil {
		return 0
	}
	var body struct {
		Pid int `json:"pid"`
	}
	if err := json.NewDecoder(reader).Decode(&body); err != nil {
		return 0
	}
	return body.Pid
}
