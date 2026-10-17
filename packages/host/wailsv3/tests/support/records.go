// Package support holds the helpers of the tests that read the records of the host (docs/spec/logging.md#writers): they
// attach a writer of events to the records, and they render the record events as the lines of the text form
// `<time> <level> <layer> <place>: <text>`.
package support

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// StartWriter starts the writer of the host in logs/ of config and makes it the writer of the records.
func StartWriter(t *testing.T, config string) *host.EventLog {
	t.Helper()
	log, err := host.StartHostEventLog(config)
	if err != nil {
		t.Fatal(err)
	}
	StoreEveryLevel(t, log)
	host.UseHostEventLog(log)
	// The writer ends before the folder of the test is removed; a writer that outlives the test writes into a removed folder.
	t.Cleanup(func() { host.UseHostEventLog(nil); log.Close() })
	return log
}

// ReadEvents returns the events of a process of the host: the lines of the main file at path and, when it exists, of the debug file
// beside it, in the order of seq (the writer assigns seq across both files).
func ReadEvents(t *testing.T, path string) []map[string]any {
	t.Helper()
	events := readFile(t, path)
	debug := strings.TrimSuffix(path, ".jsonl") + ".debug.jsonl"
	if _, err := os.Stat(debug); err == nil {
		events = append(events, readFile(t, debug)...)
		sort.SliceStable(events, func(i, j int) bool { return events[i]["seq"].(float64) < events[j]["seq"].(float64) })
	} else if !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	return events
}

// readFile returns the events of one event log file.
func readFile(t *testing.T, path string) []map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var events []map[string]any
	for _, line := range strings.Split(strings.TrimSuffix(string(data), "\n"), "\n") {
		if line == "" {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("not JSON: %q: %v", line, err)
		}
		events = append(events, event)
	}
	return events
}

// EventLogPath is the only main event log (error, warn and info) of the host under the logs folder of a configuration folder.
func EventLogPath(t *testing.T, config string) string {
	t.Helper()
	all, err := filepath.Glob(filepath.Join(config, "logs", "host-*.jsonl"))
	var paths []string
	for _, path := range all {
		if !strings.HasSuffix(path, ".debug.jsonl") {
			paths = append(paths, path)
		}
	}
	if err != nil || len(paths) != 1 {
		t.Fatalf("event logs %v, %v", paths, err)
	}
	return paths[0]
}

// TextOf renders the record events of events as lines of the text form, one per line, each with its own time.
func TextOf(events []map[string]any) string {
	var text strings.Builder
	for _, event := range events {
		name, _ := event["event"].(string)
		parts := strings.Split(name, ".")
		if len(parts) != 3 || parts[1] != "record" {
			continue
		}
		fields := event["fields"].(map[string]any)
		entry := host.Entry{Level: parts[2], Layer: parts[0], Where: fields["where"].(string), Text: fields["text"]}
		stamp := time.UnixMicro(int64(event["ts_us"].(float64))).UTC().Format("2006-01-02T15:04:05.000Z07:00")
		text.WriteString(stamp + " " + entry.Line() + "\n")
	}
	return text.String()
}

// RecordsText gives the records of the host written to the event log of config, as lines of the text form, after the writer
// flushed.
func RecordsText(t *testing.T, config string, log *host.EventLog) string {
	t.Helper()
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	return TextOf(ReadEvents(t, EventLogPath(t, config)))
}
