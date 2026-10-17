// The files of the event writer (docs/spec/logging.md#files): the levels error, warn and info go to the main file, debug and
// trace go to the debug file, each file rotates on its own and keeps every generation, and seq runs across both.
package host_test

import (
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/tests/support"
)

// debugPathOf is the debug file beside the main file of a writer.
func debugPathOf(log *host.EventLog) string {
	return strings.TrimSuffix(log.Path(), ".jsonl") + ".debug.jsonl"
}

// seqsOf returns the seq of the events, in the order of the files given.
func seqsOf(events []map[string]any) []int {
	var seqs []int
	for _, event := range events {
		seqs = append(seqs, int(event["seq"].(float64)))
	}
	return seqs
}

// contract: log.writer.splits-files-by-level
func TestDebugAndTraceEventsGoToTheDebugFileAndTheOthersToTheMainFile(t *testing.T) {
	log, err := host.StartEventLog(eventLogOptions(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	levels := []host.Level{host.LevelError, host.LevelDebug, host.LevelWarn, host.LevelTrace, host.LevelInfo, host.LevelDebug}
	for index, level := range levels {
		if !log.Emit(level, "host.app.event", map[string]any{"kind": fmt.Sprint(index)}) {
			t.Fatalf("event %d was refused", index)
		}
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	main := readEventFile(t, log.Path())
	debug := readEventFile(t, debugPathOf(log))
	for _, file := range [][]map[string]any{main, debug} {
		if len(file) == 0 || file[0]["event"] != "log.open" {
			t.Fatalf("a file does not start with log.open: %v", file)
		}
	}
	levelsOf := func(events []map[string]any) []string {
		var found []string
		for _, event := range events {
			if event["event"] == "host.app.event" {
				found = append(found, event["level"].(string))
			}
		}
		return found
	}
	if got := strings.Join(levelsOf(main), ","); got != "error,warn,info" {
		t.Fatalf("the main file holds the levels %s", got)
	}
	if got := strings.Join(levelsOf(debug), ","); got != "debug,trace,debug" {
		t.Fatalf("the debug file holds the levels %s", got)
	}
	// seq is assigned by the writer across both files: the union is 1..n once each.
	seqs := append(seqsOf(main), seqsOf(debug)...)
	sort.Ints(seqs)
	for position, seq := range seqs {
		if seq != position+1 {
			t.Fatalf("seq across both files: %v", seqs)
		}
	}
}

// contract: log.writer.rotation-keeps-every-generation
func TestEachFileRotatesOnItsOwnAndRotationNeverRemovesAGeneration(t *testing.T) {
	options := eventLogOptions(t.TempDir())
	options.RotateBytes = 700
	options.QueueEvents = 500
	options.QueueBytes = 1 << 20
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	for index := 0; index < 120; index++ {
		if !log.Emit(host.LevelDebug, "host.app.event", map[string]any{"kind": strings.Repeat("x", 40)}) {
			t.Fatalf("event %d was refused", index)
		}
	}
	if !log.Emit(host.LevelInfo, "host.app.event", map[string]any{"kind": "info"}) {
		t.Fatal("the info event was refused")
	}
	if err := log.Flush(10 * time.Second); err != nil {
		t.Fatal(err)
	}
	debug := debugPathOf(log)
	var generations []string
	for n := 1; ; n++ {
		name := fmt.Sprintf("%s.%d", debug, n)
		if _, err := os.Stat(name); err != nil {
			break
		}
		generations = append(generations, name)
	}
	if len(generations) < 8 {
		t.Fatalf("the debug file rotated into %d generations, want more than the 5 that an earlier writer kept", len(generations))
	}
	if _, err := os.Stat(log.Path() + ".1"); err == nil {
		t.Fatal("the main file rotated although it holds a single info event")
	}
	// The generations are numbered in the order of rotation: .1 is the oldest, each later file starts with log.open and
	// log.rotated that names the generation just closed, and seq continues across the files.
	previousLast := 0
	for position, name := range append(generations, debug) {
		events := readEventFile(t, name)
		if events[0]["event"] != "log.open" {
			t.Fatalf("%s starts with %v", name, events[0])
		}
		if position > 0 {
			rotated := events[1]
			if rotated["event"] != "log.rotated" || rotated["fields"].(map[string]any)["generation"] != float64(position) {
				t.Fatalf("%s: the second line is %v, want log.rotated of generation %d", name, rotated, position)
			}
		}
		first := int(events[0]["seq"].(float64))
		if position > 0 && first <= previousLast {
			t.Fatalf("%s starts at seq %d, after %d", name, first, previousLast)
		}
		previousLast = int(events[len(events)-1]["seq"].(float64))
	}
}

// contract: log.writer.never-blocks-and-counts-loss
func TestALossNamesTheChannelOfTheRefusedEvents(t *testing.T) {
	options := eventLogOptions(t.TempDir())
	options.QueueEvents = 4
	options.BatchInterval = 30 * time.Second
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	refused := map[string]int{}
	// The writer takes events from the queue while the producer adds them, so the producer adds events until the queue has
	// refused events of both channels, not a fixed number that a fast writer can take in time.
	for index := 0; refused["other"] == 0 || refused["debug"] == 0; index++ {
		if index >= 1_000_000 {
			t.Fatalf("the queue refused %v after %d events", refused, index)
		}
		level, channel := host.LevelInfo, "other"
		if index%3 == 0 {
			level, channel = host.LevelDebug, "debug"
		}
		if !log.Emit(level, "host.app.event", map[string]any{"kind": fmt.Sprint(index)}) {
			refused[channel]++
		}
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	dropped := map[string]int{}
	for _, event := range readEventFile(t, log.Path()) {
		if event["event"] != "log.dropped" {
			continue
		}
		fields := event["fields"].(map[string]any)
		channel, _ := fields["channel"].(string)
		dropped[channel] += int(fields["count"].(float64))
	}
	if dropped["other"] != refused["other"] || dropped["debug"] != refused["debug"] || len(dropped) != 2 {
		t.Fatalf("log.dropped counted %v, the queue refused %v", dropped, refused)
	}
}
