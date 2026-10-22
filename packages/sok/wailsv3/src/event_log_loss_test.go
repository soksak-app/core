package sok

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

// A line that the writer cannot serialize is a loss of the writer: the record names the seq of the gap, its count and its cause
// in log.dropped after the gap, and the later events are still written.
// contract: log.writer.unwritable-line-is-dropped
func TestAnUnserializableLineIsReportedAsDropped(t *testing.T) {
	saved := marshalRecord
	marshalRecord = func(record eventRecord) ([]byte, error) {
		if record.Event == "probe.unserializable" {
			return nil, errors.New("probe fault")
		}
		return saved(record)
	}
	t.Cleanup(func() { marshalRecord = saved })
	log, err := StartEventLog(EventLogOptions{
		Directory: t.TempDir(), Role: "probe", Boot: "boot-a", Layer: "host",
		Clock:       func() uint64 { return 42 },
		Spawn:       func(name string, fn func()) { go fn() },
		QueueEvents: 64, QueueBytes: 1 << 20, BatchInterval: 10 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(log.Close)
	log.Emit(LevelInfo, "probe.unserializable", map[string]any{"n": 1})
	log.Emit(LevelInfo, "probe.after", map[string]any{"n": 2})
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(log.Path())
	if err != nil {
		t.Fatal(err)
	}
	var dropped map[string]any
	var after bool
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("line %q is not JSON: %v", line, err)
		}
		switch record["event"] {
		case "log.dropped":
			dropped = record["fields"].(map[string]any)
		case "probe.after":
			after = true
		}
	}
	if dropped == nil {
		t.Fatalf("no log.dropped record for the unserializable line in:\n%s", data)
	}
	if dropped["from_seq"] != float64(2) || dropped["to_seq"] != float64(2) || dropped["count"] != float64(1) {
		t.Fatalf("log.dropped %v, want the gap at seq 2", dropped)
	}
	if reason, _ := dropped["reason"].(string); !strings.Contains(reason, "probe fault") {
		t.Fatalf("log.dropped reason %q does not state the cause", reason)
	}
	if !after {
		t.Fatalf("the event after the unserializable line is not written:\n%s", data)
	}
}

// A line of a file that cannot be opened is a loss of the writer, reported as log.dropped in the main file with the file and the
// cause, and the later events of the main file are still written.
// contract: log.writer.unwritable-line-is-dropped
func TestAnUnwritableLineIsReportedAsDropped(t *testing.T) {
	log, err := StartEventLog(EventLogOptions{
		Directory: t.TempDir(), Role: "probe", Boot: "boot-b", Layer: "host",
		Clock:       func() uint64 { return 42 },
		Spawn:       func(name string, fn func()) { go fn() },
		QueueEvents: 64, QueueBytes: 1 << 20, BatchInterval: 10 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(log.Close)
	// The debug file is a directory, so the debug file cannot be opened.
	if err := os.Mkdir(log.DebugPath(), 0o755); err != nil {
		t.Fatal(err)
	}
	log.Emit(LevelDebug, "probe.debug", map[string]any{"n": 1})
	log.Emit(LevelInfo, "probe.after", map[string]any{"n": 2})
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(log.Path())
	if err != nil {
		t.Fatal(err)
	}
	var dropped map[string]any
	var after bool
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("line %q is not JSON: %v", line, err)
		}
		switch record["event"] {
		case "log.dropped":
			if fields := record["fields"].(map[string]any); fields["channel"] == "debug" {
				dropped = fields
			}
		case "probe.after":
			after = true
		}
	}
	if dropped == nil {
		t.Fatalf("no log.dropped record for the debug line in:\n%s", data)
	}
	if reason, _ := dropped["reason"].(string); !strings.Contains(reason, "cannot be opened") || dropped["count"] != float64(1) {
		t.Fatalf("log.dropped %v does not state the open failure", dropped)
	}
	if !after {
		t.Fatalf("the main event after the open failure is not written:\n%s", data)
	}
}
