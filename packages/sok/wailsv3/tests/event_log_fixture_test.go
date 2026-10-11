package tests

// Checks that the writer of the tool follows the event contract that the writers of the hosts follow: the golden files of
// packages/log-contract/fixtures fix the shape of a line, of log.open and of log.dropped (docs/spec/logging.md#writers).

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// keysOf returns the keys of a JSON object in the order they are written.
func keysOf(t *testing.T, text string) []string {
	t.Helper()
	decoder := json.NewDecoder(strings.NewReader(text))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		t.Fatalf("%q is not an object: %v", text, err)
	}
	var keys []string
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			t.Fatal(err)
		}
		keys = append(keys, key.(string))
		var skipped json.RawMessage
		if err := decoder.Decode(&skipped); err != nil {
			t.Fatal(err)
		}
	}
	return keys
}

// fixtureLines reads a golden file of packages/log-contract/fixtures.
func fixtureLines(t *testing.T, name string) []string {
	t.Helper()
	_, here, _, _ := runtime.Caller(0)
	text, err := os.ReadFile(filepath.Join(filepath.Dir(here), "..", "..", "..", "log-contract", "fixtures", name))
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSpace(string(text)), "\n")
}

// writeEvents starts the writer of the tool, emits through emit and returns the lines of its file.
func writeEvents(t *testing.T, emit func(*sok.EventLog)) []string {
	t.Helper()
	config := t.TempDir()
	log, err := sok.StartEventLog(config)
	if err != nil {
		t.Fatal(err)
	}
	emit(log)
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	log.Close()
	text, err := os.ReadFile(log.Path())
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSuffix(string(text), "\n"), "\n")
}

func decodeEvent(t *testing.T, line string) loggedEvent {
	t.Helper()
	var event loggedEvent
	if err := json.Unmarshal([]byte(line), &event); err != nil {
		t.Fatalf("%q: %v", line, err)
	}
	return event
}

// contract: cli.log.lines-follow-the-golden-fixtures
func TestLinesFollowTheGoldenFixtures(t *testing.T) {
	golden := fixtureLines(t, "key.jsonl")
	lines := writeEvents(t, func(log *sok.EventLog) { log.Emit(sok.LevelInfo, "sok.command", map[string]any{"name": "x"}) })
	if got, want := keysOf(t, lines[0]), keysOf(t, golden[0]); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("keys of log.open %v, golden %v", got, want)
	}
	open, goldenOpen := decodeEvent(t, lines[0]), decodeEvent(t, golden[0])
	if open.Fields["schema"] != goldenOpen.Fields["schema"] || open.Fields["role"] != "sok" || len(open.Fields) != len(goldenOpen.Fields) {
		t.Fatalf("log.open fields %v, golden %v", open.Fields, goldenOpen.Fields)
	}
	// An event line keeps the key order of a golden event line for the keys it has; the object identifiers and cids are optional.
	own := keysOf(t, lines[1])
	var kept []string
	for _, key := range keysOf(t, golden[1]) {
		for _, name := range own {
			if key == name {
				kept = append(kept, key)
			}
		}
	}
	if strings.Join(kept, ",") != strings.Join(own, ",") {
		t.Fatalf("keys of an event %v, golden order %v", own, keysOf(t, golden[1]))
	}
	if event := decodeEvent(t, lines[1]); event.Seq != 2 || event.MonoNs == 0 || event.TsMicros == 0 {
		t.Fatalf("event %+v", event)
	}
}

// contract: cli.log.escapes-and-truncates-like-the-contract
func TestFieldsAreEscapedAndAnOversizeEventIsCut(t *testing.T) {
	text := "quote \" backslash \\ newline \n tab \t unicode   é 한"
	lines := writeEvents(t, func(log *sok.EventLog) {
		log.Emit(sok.LevelInfo, "sok.command", map[string]any{"args": text})
		log.Emit(sok.LevelInfo, "sok.command", map[string]any{"args": strings.Repeat("a", 1<<20)})
	})
	if len(lines) != 3 {
		t.Fatalf("%d lines", len(lines))
	}
	if escaped := decodeEvent(t, lines[1]); escaped.Fields["args"] != text {
		t.Fatalf("args %q", escaped.Fields["args"])
	}
	var cut struct {
		Truncated int            `json:"truncated"`
		Fields    map[string]any `json:"fields"`
	}
	if err := json.Unmarshal([]byte(lines[2]), &cut); err != nil {
		t.Fatal(err)
	}
	head, _ := cut.Fields["head"].(string)
	if cut.Truncated <= 1<<20 || len(head) != 4096 || len(cut.Fields) != 1 {
		t.Fatalf("truncated %d, head %d bytes, %d fields", cut.Truncated, len(head), len(cut.Fields))
	}
}

// contract: cli.log.records-a-refused-event-as-log-dropped
func TestARefusedEventIsCountedAndExplainedByLogDropped(t *testing.T) {
	lines := writeEvents(t, func(log *sok.EventLog) {
		log.Emit(sok.LevelInfo, "sok.command", map[string]any{"name": "first"})
		// A value that JSON cannot carry is refused and counted in place of the event.
		if log.Emit(sok.LevelInfo, "sok.command", make(chan int)) {
			t.Error("an event with fields that cannot be serialized was accepted")
		}
		log.Emit(sok.LevelInfo, "sok.command", map[string]any{"name": "last"})
	})
	golden := decodeEvent(t, fixtureLines(t, "dropped.jsonl")[2])
	var seqs []uint64
	var dropped loggedEvent
	for _, line := range lines {
		event := decodeEvent(t, line)
		seqs = append(seqs, event.Seq)
		if event.Event == "log.dropped" {
			dropped = event
		}
	}
	for key := range golden.Fields {
		if _, ok := dropped.Fields[key]; !ok {
			t.Fatalf("log.dropped lacks the golden field %s: %+v", key, dropped)
		}
	}
	if dropped.Level != golden.Level || dropped.Fields["count"] != float64(1) || dropped.Fields["from_seq"] != dropped.Fields["to_seq"] {
		t.Fatalf("log.dropped = %+v", dropped)
	}
	// The stored seq and the range that log.dropped names cover 1..n once each, and log.dropped is stored after its range.
	covered := map[uint64]bool{uint64(dropped.Fields["from_seq"].(float64)): true}
	for _, seq := range seqs {
		if covered[seq] {
			t.Fatalf("seq %d appears twice: %v, dropped %+v", seq, seqs, dropped)
		}
		covered[seq] = true
	}
	for seq := uint64(1); seq <= uint64(len(covered)); seq++ {
		if !covered[seq] {
			t.Fatalf("seq %d is neither stored nor named by log.dropped: %v, dropped %+v", seq, seqs, dropped)
		}
	}
	if dropped.Seq <= uint64(dropped.Fields["to_seq"].(float64)) {
		t.Fatalf("log.dropped has seq %d before the end of its range %v", dropped.Seq, dropped.Fields["to_seq"])
	}
}

// contract: cli.log.run-stores-only-the-declared-events
func TestARunStoresOnlyTheEventsThatTheSpecificationNames(t *testing.T) {
	config := t.TempDir()
	loggedRun(config, sok.Run, "nothing")
	for _, event := range eventsOf(t, config) {
		switch event.Event {
		case "log.open", "sok.command", "sok.panic", "log.dropped":
		default:
			t.Fatalf("a run stored %s", event.Event)
		}
	}
}
