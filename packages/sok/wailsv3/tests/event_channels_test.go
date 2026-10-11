package tests

// Checks the files of the event writer of the tool (docs/spec/logging.md#files): the levels error, warn and info go to
// logs/sok-<boot>.jsonl and debug and trace go to logs/sok-<boot>.debug.jsonl, which exists once the first such event is
// written, and seq runs across both files.

import (
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// linesOfFile returns the lines of one file of the writer.
func linesOfFile(t *testing.T, path string) []string {
	t.Helper()
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSuffix(string(text), "\n"), "\n")
}

// contract: cli.log.splits-files-by-level
func TestTheToolStoresDebugAndTraceEventsInTheDebugFile(t *testing.T) {
	config := t.TempDir()
	log, err := sok.StartEventLog(config)
	if err != nil {
		t.Fatal(err)
	}
	for _, level := range []sok.Level{sok.LevelDebug, sok.LevelWarn, sok.LevelTrace, sok.LevelInfo, sok.LevelError} {
		if !log.Emit(level, "sok.command", map[string]any{"name": string(level)}) {
			t.Fatalf("the event of the level %s was refused", level)
		}
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	log.Close()
	debugPath := strings.TrimSuffix(log.Path(), ".jsonl") + ".debug.jsonl"
	names := func(path string) string {
		var found []string
		for _, line := range linesOfFile(t, path) {
			event := decodeEvent(t, line)
			if event.Event == "sok.command" {
				found = append(found, event.Level)
			} else if event.Event != "log.open" {
				t.Fatalf("%s holds %s", path, line)
			}
		}
		return strings.Join(found, ",")
	}
	if got := names(log.Path()); got != "warn,info,error" {
		t.Fatalf("the main file holds the levels %s", got)
	}
	if got := names(debugPath); got != "debug,trace" {
		t.Fatalf("the debug file holds the levels %s", got)
	}
	if first := decodeEvent(t, linesOfFile(t, debugPath)[0]); first.Event != "log.open" || first.Class != "lifecycle" {
		t.Fatalf("the debug file starts with %+v", first)
	}
	var seqs []int
	for _, path := range []string{log.Path(), debugPath} {
		for _, line := range linesOfFile(t, path) {
			seqs = append(seqs, int(decodeEvent(t, line).Seq))
		}
	}
	sort.Ints(seqs)
	for position, seq := range seqs {
		if seq != position+1 {
			t.Fatalf("seq across both files: %v", seqs)
		}
	}
}

// contract: cli.log.splits-files-by-level
func TestARunOfTheToolWithoutADebugEventLeavesNoDebugFile(t *testing.T) {
	config := t.TempDir()
	log, err := sok.StartEventLog(config)
	if err != nil {
		t.Fatal(err)
	}
	log.Emit(sok.LevelInfo, "sok.command", map[string]any{"name": "x"})
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	log.Close()
	if _, err := os.Stat(strings.TrimSuffix(log.Path(), ".jsonl") + ".debug.jsonl"); !os.IsNotExist(err) {
		t.Fatalf("a run without a debug event left a debug file: %v", err)
	}
}

// contract: cli.log.records-a-refused-event-as-log-dropped
func TestALossOfTheToolNamesTheChannelOfTheRefusedEvents(t *testing.T) {
	lines := writeEvents(t, func(log *sok.EventLog) {
		log.Emit(sok.LevelDebug, "sok.command", map[string]any{"name": "first"})
		if log.Emit(sok.LevelDebug, "sok.command", make(chan int)) {
			t.Error("an event with fields that cannot be serialized was accepted")
		}
		if log.Emit(sok.LevelInfo, "sok.command", make(chan int)) {
			t.Error("an event with fields that cannot be serialized was accepted")
		}
	})
	channels := map[string]float64{}
	for _, line := range lines {
		if event := decodeEvent(t, line); event.Event == "log.dropped" {
			channels[event.Fields["channel"].(string)] += event.Fields["count"].(float64)
		}
	}
	if len(channels) != 2 || channels["other"] != 1 || channels["debug"] != 1 {
		t.Fatalf("log.dropped counted %v, want one event in each channel", channels)
	}
}
