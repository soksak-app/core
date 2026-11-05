package support

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// CrashReports watches the folder in which the system writes crash reports, so a test whose child crashes on purpose removes
// the report that the system writes for that child.
type CrashReports struct {
	watcher     *fsnotify.Watcher
	directory   string
	application string
}

// CrashingExecutable copies the running test executable to a name of this run. The system counts the crash reports of one process
// name, also the reports that a test removed, and after 25 it writes none and gives the crashing process no error. A child that
// crashes under a fixed name gets no report after the runs of a day, so the test would judge the runs before it.
func CrashingExecutable(t *testing.T) string {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	source, err := os.Open(executable)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	path := filepath.Join(t.TempDir(), fmt.Sprintf("crash-%08x", uint32(time.Now().UnixNano())))
	target, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o700)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(target, source); err != nil {
		t.Fatal(err)
	}
	if err := target.Close(); err != nil {
		t.Fatal(err)
	}
	return path
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
	return WatchCrashReportsIn(t, directory, application)
}

// WatchCrashReportsIn starts the watch of the crash reports of application in directory.
func WatchCrashReportsIn(t *testing.T, directory, application string) *CrashReports {
	t.Helper()
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
