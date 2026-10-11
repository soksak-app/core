package tests

// Checks the options of the shared event writer that the hosts and the tool start (docs/spec/logging.md#writers): the layer
// and the clock of its own events, the goroutine entrance, the rotation that a writer may omit, the correlation identifiers,
// and the source of events that cannot call into the writer.

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/soksak-app/core/packages/sok/wailsv3/src"
)

func optionsIn(directory string, boot string) sok.EventLogOptions {
	return sok.EventLogOptions{
		Directory: directory, Role: "probe", Boot: boot, Layer: "host",
		Clock:       func() uint64 { return 42 },
		Spawn:       sok.Go,
		QueueEvents: 64, QueueBytes: 1 << 20, BatchInterval: 10 * time.Millisecond,
	}
}

func storedLines(t *testing.T, path string) []map[string]any {
	t.Helper()
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var lines []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(string(text)), "\n") {
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("%q: %v", line, err)
		}
		lines = append(lines, event)
	}
	return lines
}

func TestAWriterIsRefusedANegativeRotationBound(t *testing.T) {
	options := optionsIn(t.TempDir(), "refused")
	options.RotateBytes = -1
	if log, err := sok.StartEventLog(options); err == nil {
		log.Close()
		t.Error("a negative RotateBytes was accepted")
	}
}

func TestAWriterWithoutRotationStoresTheLayerTheClockAndTheCidsOfItsOptions(t *testing.T) {
	log, err := sok.StartEventLog(optionsIn(t.TempDir(), "plain"))
	if err != nil {
		t.Fatal(err)
	}
	if !log.EmitCids(sok.LevelInfo, "host.probe.event", []string{"c1", "c2"}, map[string]int{"n": 1}) {
		t.Fatal("the event was refused")
	}
	if log.EmitCids(sok.LevelInfo, "host.probe.bad", []string{`a"b`}, nil) {
		t.Error("a cid with a quote was accepted")
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	log.Close()
	lines := storedLines(t, log.Path())
	if len(lines) != 3 || lines[0]["event"] != "log.open" || lines[1]["event"] != "host.probe.event" || lines[2]["event"] != "log.dropped" {
		t.Fatalf("the lines are %v", lines)
	}
	for _, line := range lines {
		if line["layer"] != "host" || line["mono_ns"] != float64(42) {
			t.Errorf("%v does not carry the layer and the clock of the options", line)
		}
	}
	if cids, _ := json.Marshal(lines[1]["cids"]); string(cids) != `["c1","c2"]` {
		t.Errorf("the cids are %s", cids)
	}
}

func TestAWriterRotatesAtItsBoundAndTheNewFileStartsWithLogOpenAndLogRotated(t *testing.T) {
	options := optionsIn(t.TempDir(), "rotating")
	options.RotateBytes = 600
	log, err := sok.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 20; index++ {
		log.Emit(sok.LevelInfo, "host.probe.event", map[string]string{"text": strings.Repeat("x", 100)})
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	log.Close()
	if _, err := os.Stat(log.Path() + ".1"); err != nil {
		t.Fatal(err)
	}
	lines := storedLines(t, log.Path())
	if len(lines) < 3 || lines[0]["event"] != "log.open" || lines[1]["event"] != "log.rotated" {
		t.Fatalf("the new file starts with %v", lines[:min(len(lines), 2)])
	}
}

func TestAWriterStoresTheEventsAndTheLossOfItsPullSource(t *testing.T) {
	options := optionsIn(t.TempDir(), "pulling")
	delivered := false
	options.Pull = func(accept func(sok.RelayedEvent), lost func(events, bytes uint64, reason string, channel sok.Channel)) {
		if delivered {
			return
		}
		delivered = true
		accept(sok.RelayedEvent{TsMicros: 7, MonoNs: 9, Layer: "native", Level: sok.LevelWarn, Event: "native.probe.event", Fields: json.RawMessage(`{"a":1}`)})
		lost(3, 30, "the source was full", sok.ChannelOther)
	}
	log, err := sok.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	log.Close()
	lines := storedLines(t, log.Path())
	if len(lines) != 3 || lines[1]["event"] != "native.probe.event" || lines[1]["layer"] != "native" || lines[1]["mono_ns"] != float64(9) {
		t.Fatalf("the lines are %v", lines)
	}
	fields, _ := lines[2]["fields"].(map[string]any)
	if lines[2]["event"] != "log.dropped" || fields["reason"] != "the source was full" || fields["count"] != float64(3) {
		t.Errorf("the loss is %v", lines[2])
	}
}
