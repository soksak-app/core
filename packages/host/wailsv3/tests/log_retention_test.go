// The retention of the event files (docs/spec/logging.md#retention): the files of the runs in logs/ stay within a stated bound; the
// oldest runs go first, the run of the writer and a run with a `.keep` file never go, and every removal is the event log.pruned.
package host_test

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// run writes the files of an earlier run into logs: an event file of size bytes whose first line is log.open at ts and whose last line
// is an event at last, its debug file, an index and a standard error file, and gives them the modification time at.
func run(t *testing.T, logs, name string, ts, last int64, size int, at time.Time) int {
	t.Helper()
	line := func(seq int, at int64, event, padding string) string {
		return fmt.Sprintf(`{"ts_us":%d,"mono_ns":1,"seq":%d,"level":"info","class":"lifecycle","layer":"host","event":%q,"fields":{"padding":%q}}`, at, seq, event, padding)
	}
	// The padding fills the middle event so that the file has the size; the first and the last line are events.
	fixed := len(line(1, ts, "log.open", "")) + len(line(3, ts+1, "host.app.event", "")) + len(line(2, last, "host.app.event", "")) + 3
	main := line(1, ts, "log.open", "") + "\n" + line(3, ts+1, "host.app.event", strings.Repeat("x", size-fixed)) + "\n" + line(2, last, "host.app.event", "") + "\n"
	files := map[string]string{
		name + ".jsonl":       main,
		name + ".debug.jsonl": line(3, ts+1, "log.open", "") + "\n" + line(4, last-1, "host.trace.mark", "") + "\n",
		name + ".jsonl.idx":   strings.Repeat("i", 100),
		name + ".stderr":      "raw\n",
	}
	total := 0
	for file, text := range files {
		path := filepath.Join(logs, file)
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, at, at); err != nil {
			t.Fatal(err)
		}
		total += len(text)
	}
	return total
}

func startRetention(t *testing.T, logs string, bound int64) *host.EventLog {
	t.Helper()
	options := eventLogOptions(logs)
	options.Boot = "1791500009-9"
	options.RetentionBytes = bound
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	return log
}

func prunedEvents(t *testing.T, log *host.EventLog) []map[string]any {
	t.Helper()
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	// The event lies in the file at the path or in a generation that a later rotation closed.
	files := []string{log.Path()}
	for n := 1; ; n++ {
		generation := fmt.Sprintf("%s.%d", log.Path(), n)
		if _, err := os.Stat(generation); err != nil {
			break
		}
		files = append(files, generation)
	}
	var found []map[string]any
	for _, file := range files {
		for _, event := range readEventFile(t, file) {
			if event["event"] == "log.pruned" {
				found = append(found, event)
			}
		}
	}
	return found
}

// contract: log.retention.removes-the-oldest-runs-over-the-bound
func TestTheOldestRunsAreRemovedWhenTheFilesPassTheBoundAndEachRemovalIsAnEvent(t *testing.T) {
	logs := filepath.Join(t.TempDir(), "logs")
	if err := os.MkdirAll(logs, 0o700); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	oldest := run(t, logs, "host-1791500001-1", 1_791_500_001_000_000, 1_791_500_001_900_000, 2000, now.Add(-4*time.Hour))
	older := run(t, logs, "vt-1791500002-2", 1_791_500_002_000_000, 1_791_500_002_800_000, 2000, now.Add(-3*time.Hour))
	newer := run(t, logs, "host-1791500003-3", 1_791_500_003_000_000, 1_791_500_003_700_000, 2000, now.Add(-2*time.Hour))
	// Files that are no part of a run are left alone.
	for _, name := range []string{"application.log", "state-1.json", "crash-found.txt"} {
		if err := os.WriteFile(filepath.Join(logs, name), []byte(strings.Repeat("z", 5000)), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// The bound leaves room for the newest earlier run and the files of the writer, not for the two older runs.
	log := startRetention(t, logs, int64(newer)+1000)
	pruned := prunedEvents(t, log)
	if len(pruned) != 1 {
		t.Fatalf("%d log.pruned events: %v", len(pruned), pruned)
	}
	fields := pruned[0]["fields"].(map[string]any)
	runs := fields["runs"].([]any)
	if len(runs) != 2 || runs[0] != "host-1791500001-1" || runs[1] != "vt-1791500002-2" {
		t.Fatalf("the pruned runs: %v", runs)
	}
	if fields["files"] != float64(8) || fields["bytes"] != float64(oldest+older) {
		t.Fatalf("pruned %v files and %v bytes, want 8 files and %d bytes", fields["files"], fields["bytes"], oldest+older)
	}
	if fields["from_us"] != float64(1_791_500_001_000_000) || fields["to_us"] != float64(1_791_500_002_800_000) {
		t.Fatalf("the time range: %v to %v", fields["from_us"], fields["to_us"])
	}
	if fields["bound"] != float64(int64(newer)+1000) || fields["remaining"].(float64) > fields["bound"].(float64) || pruned[0]["level"] != "info" || pruned[0]["class"] != "lifecycle" {
		t.Fatalf("the event: %v", pruned[0])
	}
	for _, gone := range []string{"host-1791500001-1.jsonl", "host-1791500001-1.debug.jsonl", "host-1791500001-1.jsonl.idx", "host-1791500001-1.stderr", "vt-1791500002-2.jsonl"} {
		if _, err := os.Stat(filepath.Join(logs, gone)); err == nil {
			t.Errorf("%s was not removed", gone)
		}
	}
	for _, kept := range []string{"host-1791500003-3.jsonl", "host-1791500003-3.stderr", "application.log", "state-1.json", "crash-found.txt", filepath.Base(log.Path())} {
		if _, err := os.Stat(filepath.Join(logs, kept)); err != nil {
			t.Errorf("%s was removed: %v", kept, err)
		}
	}
}

// contract: log.retention.keeps-a-pinned-run-and-the-current-run
func TestARunWithAKeepFileAndTheRunOfTheWriterAreNeverRemoved(t *testing.T) {
	logs := filepath.Join(t.TempDir(), "logs")
	if err := os.MkdirAll(logs, 0o700); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	run(t, logs, "host-1791500001-1", 1_791_500_001_000_000, 1_791_500_001_900_000, 2000, now.Add(-4*time.Hour))
	run(t, logs, "host-1791500002-2", 1_791_500_002_000_000, 1_791_500_002_900_000, 2000, now.Add(-3*time.Hour))
	if err := os.WriteFile(filepath.Join(logs, "host-1791500001-1.keep"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	// The bound is smaller than the pinned run: the run that is not pinned goes, the pinned run stays, and the event says that the bound is
	// not met.
	log := startRetention(t, logs, 100)
	pruned := prunedEvents(t, log)
	if len(pruned) != 1 {
		t.Fatalf("%d log.pruned events: %v", len(pruned), pruned)
	}
	fields := pruned[0]["fields"].(map[string]any)
	if runs := fields["runs"].([]any); len(runs) != 1 || runs[0] != "host-1791500002-2" {
		t.Fatalf("the pruned runs: %v", runs)
	}
	if pruned[0]["level"] != "warn" || fields["remaining"].(float64) <= fields["bound"].(float64) {
		t.Fatalf("a bound that cannot be met is a warning with the remaining size: %v", pruned[0])
	}
	for _, kept := range []string{"host-1791500001-1.jsonl", "host-1791500001-1.keep", filepath.Base(log.Path())} {
		if _, err := os.Stat(filepath.Join(logs, kept)); err != nil {
			t.Errorf("%s was removed: %v", kept, err)
		}
	}
}

// contract: log.retention.stores-nothing-under-the-bound
func TestFilesUnderTheBoundAreNotRemovedAndStoreNoEvent(t *testing.T) {
	logs := filepath.Join(t.TempDir(), "logs")
	if err := os.MkdirAll(logs, 0o700); err != nil {
		t.Fatal(err)
	}
	run(t, logs, "host-1791500001-1", 1_791_500_001_000_000, 1_791_500_001_900_000, 2000, time.Now().Add(-time.Hour))
	log := startRetention(t, logs, 1<<20)
	if pruned := prunedEvents(t, log); len(pruned) != 0 {
		t.Fatalf("an event was stored although the files are under the bound: %v", pruned)
	}
	if _, err := os.Stat(filepath.Join(logs, "host-1791500001-1.jsonl")); err != nil {
		t.Fatal(err)
	}
}

// contract: log.retention.runs-after-a-rotation
func TestARotationRunsTheRetentionAgain(t *testing.T) {
	logs := filepath.Join(t.TempDir(), "logs")
	if err := os.MkdirAll(logs, 0o700); err != nil {
		t.Fatal(err)
	}
	options := eventLogOptions(logs)
	options.Boot = "1791500009-9"
	options.RotateBytes = 1500
	options.QueueEvents = 200
	options.RetentionBytes = 600000
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	// An earlier run appears after the start; the first rotation finds the files past the bound and removes it.
	run(t, logs, "host-1791500001-1", 1_791_500_001_000_000, 1_791_500_001_900_000, 1000000, time.Now().Add(-time.Hour))
	for index := 0; index < 30; index++ {
		log.Emit(host.LevelInfo, "host.app.event", map[string]any{"kind": strings.Repeat("x", 60)})
	}
	pruned := prunedEvents(t, log)
	if len(pruned) == 0 {
		t.Fatal("no rotation removed the earlier run")
	}
	if runs := pruned[0]["fields"].(map[string]any)["runs"].([]any); len(runs) != 1 || runs[0] != "host-1791500001-1" {
		t.Fatalf("the pruned runs: %v", runs)
	}
}

// contract: log.retention.requires-a-bound
func TestAnEventLogWithoutARetentionBoundIsRefused(t *testing.T) {
	options := eventLogOptions(t.TempDir())
	options.RetentionBytes = 0
	if _, err := host.StartEventLog(options); err == nil || !strings.Contains(err.Error(), "RetentionBytes") {
		t.Fatalf("error %v", err)
	}
}
