package tests

// Checks the options of the shared event writer that the hosts and the tool start (docs/spec/logging.md#writers): the layer
// and the clock of its own events, the goroutine entrance, the rotation that a writer may omit, the correlation identifiers,
// and the source of events that cannot call into the writer.

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"sync"
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

// contract: cli.log.writer-options.refuses-a-negative-rotation-bound
func TestAWriterIsRefusedANegativeRotationBound(t *testing.T) {
	options := optionsIn(t.TempDir(), "refused")
	options.RotateBytes = -1
	if log, err := sok.StartEventLog(options); err == nil {
		log.Close()
		t.Error("a negative RotateBytes was accepted")
	}
}

// contract: cli.log.writer-options.stores-the-layer-the-clock-and-the-cids
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

// contract: cli.log.writer-options.rotates-at-its-bound
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

// contract: cli.log.writer-options.stores-the-events-and-the-loss-of-its-pull-source
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

// contract: cli.log.writer-options.records-refused-events-as-loss-before-the-next-accepted-event
func TestRefusedPlacedEventsAreRecordedAsLossBeforeTheNextAcceptedEvent(t *testing.T) {
	options := optionsIn(t.TempDir(), "full-queue")
	options.QueueEvents = 2
	options.QueueBytes = 1 << 20
	options.BatchInterval = time.Hour
	options.Spawn = func(name string, fn func()) { go fn() }
	// The pull runs on the writer goroutine at each drain. Holding it there keeps the writer from taking the queued events,
	// so the queue stays full until the test releases it.
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	options.Pull = func(accept func(sok.RelayedEvent), lost func(events, bytes uint64, reason string, channel sok.Channel)) {
		once.Do(func() {
			close(entered)
			<-release
		})
	}
	log, err := sok.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := sok.ParseLogPolicy("log-policy.json", []byte(`{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"trace","io":"trace","frame":"trace"}}`))
	if err != nil {
		t.Fatal(err)
	}
	log.SetPolicy(policy, "file")
	flushed := make(chan error, 1)
	go func() { flushed <- log.Flush(5 * time.Second) }()
	<-entered
	if !log.Emit(sok.LevelWarn, "host.stall.dump", map[string]any{"path": "/first"}) || !log.Emit(sok.LevelWarn, "host.stall.dump", map[string]any{"path": "/second"}) {
		t.Fatal("the queue refused an event before it was full")
	}
	for range 2 {
		_, err := log.EmitPlaced(sok.LevelWarn, "host.stall.dump", json.RawMessage(`{"path":"/refused"}`), 5*time.Second)
		if err == nil || err.Error() != "the event writer refused host.stall.dump because its queue was full" {
			t.Fatalf("a placed event on a full queue returned %v", err)
		}
	}
	close(release)
	if err := <-flushed; err != nil {
		t.Fatal(err)
	}
	if !log.Emit(sok.LevelInfo, "sok.command", map[string]any{"name": "after"}) {
		t.Fatal("the queue refused an event after the writer took its batch")
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	log.Close()
	lines := storedLines(t, log.Path())
	dropped := -1
	for i, line := range lines {
		if line["event"] == "log.dropped" {
			dropped = i
		}
	}
	if dropped < 0 {
		t.Fatalf("no log.dropped records the two refused events: %v", lines)
	}
	fields2, _ := lines[dropped]["fields"].(map[string]any)
	if fields2["count"] != float64(2) || fields2["reason"] != "the queue was full" || fields2["channel"] != "other" || fields2["queued"] != float64(2) {
		t.Fatalf("log.dropped = %v", lines[dropped])
	}
	if lines[dropped]["level"] != "warn" {
		t.Fatalf("log.dropped has level %v", lines[dropped]["level"])
	}
	for i := dropped + 1; i < len(lines); i++ {
		if lines[i]["event"] == "sok.command" && lines[i]["fields"].(map[string]any)["name"] == "after" {
			return
		}
	}
	t.Fatalf("the event after the refusals is not stored after log.dropped: %v", lines)
}

// contract: cli.log.writer-options.refuses-a-placed-event-by-its-cause
func TestAPlacedEventRefusedByThePolicyNamesThePolicy(t *testing.T) {
	options := optionsIn(t.TempDir(), "policy-refusal")
	log, err := sok.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	// The default policy stores only errors, so a warning of a lifecycle class that passes no gate exception is refused by the
	// gate and not by the queue.
	_, err = log.EmitPlaced(sok.LevelWarn, "host.buffer.dropped", json.RawMessage(`{"path":"/probe"}`), 5*time.Second)
	if err == nil || err.Error() != "the event writer refused host.buffer.dropped because the policy does not store it" {
		t.Fatalf("a placed event refused by the policy returned %v", err)
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	log.Close()
	for _, line := range storedLines(t, log.Path()) {
		if line["event"] == "log.dropped" {
			t.Fatalf("a gated event was recorded as a loss: %v", line)
		}
		if line["event"] == "log.gated" {
			fields, _ := line["fields"].(map[string]any)
			if fields["class"] == "lifecycle" && fields["level"] == "warn" && fields["count"] == float64(1) {
				return
			}
		}
	}
	t.Fatal("the gated event is not recorded by log.gated")
}

// contract: log.closed.passes-every-gate
func TestAClosedRecordIsStoredUnderAPolicyThatTurnsLifecycleOff(t *testing.T) {
	log, err := sok.StartEventLog(optionsIn(t.TempDir(), "b1"))
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	policy, err := sok.ParseLogPolicy("log-policy.json", []byte(`{"schema":1,"classes":{"lifecycle":"error","input":"error","call":"error","io":"error","frame":"error"}}`))
	if err != nil {
		t.Fatal(err)
	}
	log.SetPolicy(policy, "file")
	signal := 15
	if !log.RecordClosed("signal", &signal) {
		t.Fatal("the record was refused")
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var closed []map[string]any
	for _, event := range storedLines(t, log.Path()) {
		if event["event"] == "log.closed" {
			closed = append(closed, event)
		}
	}
	if len(closed) != 1 {
		t.Fatalf("log.closed records %v, want 1", closed)
	}
	if closed[0]["level"] != "info" || closed[0]["class"] != "lifecycle" || !reflect.DeepEqual(closed[0]["fields"], map[string]any{"cause": "signal", "signal": float64(15)}) {
		t.Fatalf("log.closed record %v", closed[0])
	}
}

// contract: host.stall.passes-every-gate
// contract: host.stall.passes-every-gate
func TestTheStallRecordsAreStoredUnderAPolicyThatTurnsLifecycleOff(t *testing.T) {
	log, err := sok.StartEventLog(optionsIn(t.TempDir(), "b1"))
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	policy, err := sok.ParseLogPolicy("log-policy.json", []byte(`{"schema":1,"classes":{"lifecycle":"error","input":"error","call":"error","io":"error","frame":"error"}}`))
	if err != nil {
		t.Fatal(err)
	}
	log.SetPolicy(policy, "file")
	names := []string{"host.stall", "host.stall.sampled", "host.stall.dump"}
	for _, name := range names {
		if !log.Emit(sok.LevelWarn, name, map[string]any{"late_ms": 1000}) {
			t.Fatalf("%s was refused", name)
		}
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	events := storedLines(t, log.Path())
	for _, name := range names {
		var stored []map[string]any
		for _, event := range events {
			if event["event"] == name {
				stored = append(stored, event)
			}
		}
		if len(stored) != 1 {
			t.Fatalf("%s records %v, want 1", name, stored)
		}
		if stored[0]["level"] != "warn" || stored[0]["class"] != "lifecycle" {
			t.Fatalf("%s record %v", name, stored[0])
		}
	}
}
