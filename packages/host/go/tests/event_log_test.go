// The event writer of the host (docs/spec/logging.md#writers): events enter a bounded queue without blocking, one writer
// goroutine assigns seq, writes batches and counts the loss, and the file follows the contract that
// @soksak/log-contract audits.
package host_test

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform"
	"github.com/soksak-app/core/packages/host/go/tests/support"
)

// readEventLog returns the events of a process: the lines of the main file at path and, when it exists, of the debug file beside
// it, in the order of seq (the writer assigns seq across both files).
func readEventLog(t *testing.T, path string) []map[string]any {
	t.Helper()
	events := readEventFile(t, path)
	debug := strings.TrimSuffix(path, ".jsonl") + ".debug.jsonl"
	if _, err := os.Stat(debug); err == nil {
		events = append(events, readEventFile(t, debug)...)
		sort.SliceStable(events, func(i, j int) bool { return events[i]["seq"].(float64) < events[j]["seq"].(float64) })
	}
	return events
}

// readEventFile returns the events of one log file, parsed.
func readEventFile(t *testing.T, path string) []map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var events []map[string]any
	if len(data) == 0 {
		// The writer has not written its first batch yet.
		return events
	}
	for _, line := range strings.Split(strings.TrimSuffix(string(data), "\n"), "\n") {
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("not JSON: %q: %v", line, err)
		}
		events = append(events, event)
	}
	return events
}

// contract: log.writer.assigns-seq-and-opens-with-log-open
func TestTheFirstLineOfAnEventLogIsLogOpenAndSeqIsConsecutive(t *testing.T) {
	log, err := host.StartEventLog(support.EventLogOptions(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	for index := 0; index < 10; index++ {
		if !log.Emit(host.LevelInfo, "host.test.event", map[string]any{"index": index}) {
			t.Fatalf("event %d was refused", index)
		}
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	events := readEventLog(t, log.Path())
	if events[0]["event"] != "log.open" {
		t.Fatalf("first event %v", events[0])
	}
	fields := events[0]["fields"].(map[string]any)
	if fields["schema"] != float64(3) || fields["role"] != "host" || fields["boot"] != "b1" {
		t.Fatalf("log.open fields %v", fields)
	}
	for position, event := range events {
		if event["seq"] != float64(position+1) {
			t.Fatalf("event %d has seq %v", position, event["seq"])
		}
	}
	if len(events) != 12 || events[6]["fields"].(map[string]any)["index"] != float64(4) {
		t.Fatalf("events %v", events)
	}
}

// contract: log.writer.stores-both-clocks
func TestEveryLineCarriesTheWallClockAndTheMonotonicClockOfTheCall(t *testing.T) {
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	options := support.EventLogOptions(t.TempDir())
	// A small file rotates, so log.open and log.rotated are written by the writer after its start.
	options.RotateBytes = 4000
	options.QueueEvents = 1000
	wallStart := time.Now().UnixMicro()
	monoStart, err := system.MonotonicNanos()
	if err != nil {
		t.Fatal(err)
	}
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	for index := 0; index < 60; index++ {
		if !log.Emit(host.LevelInfo, "host.test.event", map[string]any{"index": index, "padding": "xxxxxxxxxxxxxxxxxxxx"}) {
			t.Fatalf("event %d was refused", index)
		}
	}
	if err := log.Flush(10 * time.Second); err != nil {
		t.Fatal(err)
	}
	wallEnd := time.Now().UnixMicro()
	monoEnd, err := system.MonotonicNanos()
	if err != nil {
		t.Fatal(err)
	}
	var all []map[string]any
	for _, name := range []string{log.Path() + ".1", log.Path() + ".2", log.Path() + ".3", log.Path()} {
		if _, err := os.Stat(name); err == nil {
			all = append(all, readEventLog(t, name)...)
		}
	}
	rotated, previous := 0, float64(0)
	for _, event := range all {
		ts, _ := event["ts_us"].(float64)
		mono, ok := event["mono_ns"].(float64)
		if !ok || mono <= 0 {
			t.Fatalf("the line has no positive mono_ns: %v", event)
		}
		if int64(ts) < wallStart || int64(ts) > wallEnd || uint64(mono) < monoStart || uint64(mono) > monoEnd {
			t.Fatalf("the line %v is outside the clocks of the test: ts_us [%d, %d], mono_ns [%d, %d]", event, wallStart, wallEnd, monoStart, monoEnd)
		}
		switch event["event"] {
		case "log.rotated":
			rotated++
		case "host.test.event":
			if mono < previous {
				t.Fatalf("mono_ns %v of %v is smaller than the %v of the event before it", mono, event, previous)
			}
			previous = mono
		}
	}
	if rotated == 0 {
		t.Fatal("the file did not rotate, so log.open and log.rotated of the writer were not checked")
	}
}

// contract: log.writer.stores-cids
func TestAnEventWithCorrelationIdentifiersStoresThemAndAnInvalidIdentifierIsRefused(t *testing.T) {
	log, err := host.StartEventLog(support.EventLogOptions(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	if !log.EmitCids(host.LevelInfo, "host.test.input", []string{"b1.1", "b1.2"}, map[string]any{"index": 1}) {
		t.Fatal("an event with identifiers was refused")
	}
	if !log.Emit(host.LevelInfo, "host.test.plain", map[string]any{"index": 2}) {
		t.Fatal("an event without identifiers was refused")
	}
	for _, bad := range [][]string{{""}, {`a"b`}, {`a\b`}, {"a\nb"}} {
		if log.EmitCids(host.LevelInfo, "host.test.bad", bad, map[string]any{}) {
			t.Fatalf("the identifiers %q were accepted", bad)
		}
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	events := readEventLog(t, log.Path())
	if len(events) < 5 {
		t.Fatalf("events %v", events)
	}
	cids, ok := events[2]["cids"].([]any)
	if !ok || len(cids) != 2 || cids[0] != "b1.1" || cids[1] != "b1.2" {
		t.Fatalf("the cids of the first event: %v", events[2])
	}
	if _, present := events[3]["cids"]; present {
		t.Fatalf("an event without identifiers has cids: %v", events[3])
	}
	// The writer turns the loss counters into log.dropped each time it writes what is queued, so the four refusals may be split
	// over several log.dropped events whose counts add up to them (docs/spec/logging.md#writers).
	var counted float64
	for _, dropped := range events[4:] {
		if dropped["event"] != "log.dropped" {
			t.Fatalf("an event after the stored ones is not log.dropped: %v", dropped)
		}
		counted += dropped["fields"].(map[string]any)["count"].(float64)
	}
	if counted != 4 {
		t.Fatalf("the four refused events were counted as %v: %v", counted, events[4:])
	}
}

// writerHold holds the writer goroutine in its write observer, as a slow disk holds it: while the writer is held it takes
// nothing from the queue, so the queue fills and stays full.
type writerHold struct {
	armed   atomic.Bool
	entered chan struct{}
	release chan struct{}
}

func holdWriter(log *host.EventLog) *writerHold {
	hold := &writerHold{entered: make(chan struct{}, 1), release: make(chan struct{})}
	log.SetOnWrite(func(string, int64) {
		if hold.armed.Swap(false) {
			hold.entered <- struct{}{}
			<-hold.release
		}
	})
	return hold
}

// refuseWhileHeld holds the writer, emits 20 events into a queue of 4 and releases the writer; it returns the accepted and the
// refused events. An error is written without waiting for the batch interval, so its write is where the writer is held.
func refuseWhileHeld(t *testing.T, log *host.EventLog, hold *writerHold, first int) (accepted, refused int) {
	t.Helper()
	hold.armed.Store(true)
	if !log.Emit(host.LevelError, "host.test.failure", map[string]any{"reason": "the writer is held"}) {
		t.Fatal("the error was refused")
	}
	select {
	case <-hold.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the writer did not write the error")
	}
	for index := first; index < first+20; index++ {
		if log.Emit(host.LevelInfo, "host.test.event", map[string]any{"index": index}) {
			accepted++
		} else {
			refused++
		}
	}
	hold.release <- struct{}{}
	return accepted, refused
}

// droppedRanges returns the log.dropped events of a run, after checking that each names count consecutive seq before its own
// and that the stored events and the named ranges hold every seq from 1 once.
func droppedRanges(t *testing.T, events []map[string]any) []map[string]any {
	t.Helper()
	var seqs []int
	var dropped []map[string]any
	for _, event := range events {
		seq := int(event["seq"].(float64))
		seqs = append(seqs, seq)
		if event["event"] != "log.dropped" {
			continue
		}
		fields := event["fields"].(map[string]any)
		from, to := int(fields["from_seq"].(float64)), int(fields["to_seq"].(float64))
		if to+1-from != int(fields["count"].(float64)) || seq <= to {
			t.Fatalf("the dropped event %v does not name count seq before its own", event)
		}
		for missing := from; missing <= to; missing++ {
			seqs = append(seqs, missing)
		}
		dropped = append(dropped, event)
	}
	sort.Ints(seqs)
	for index, seq := range seqs {
		if seq != index+1 {
			t.Fatalf("seq %d at position %d: the stored events and the dropped ranges do not hold every seq once: %v", seq, index, events)
		}
	}
	return dropped
}

// countOf returns the count of a log.dropped event.
func countOf(event map[string]any) int {
	return int(event["fields"].(map[string]any)["count"].(float64))
}

// contract: log.writer.never-blocks-and-counts-loss
func TestAFullEventQueueReturnsFalseAndTheWriterRecordsTheRangeAsDropped(t *testing.T) {
	options := support.EventLogOptions(t.TempDir())
	options.QueueEvents = 4
	options.BatchInterval = 30 * time.Second
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	hold := holdWriter(log)
	accepted, refused := refuseWhileHeld(t, log, hold, 0)
	if accepted != 4 || refused != 16 {
		t.Fatalf("accepted %d, refused %d", accepted, refused)
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	events := readEventLog(t, log.Path())
	dropped := droppedRanges(t, events)
	stored := 0
	for _, event := range events {
		if event["event"] == "host.test.event" {
			stored++
		}
	}
	if len(dropped) != 1 || countOf(dropped[0]) != refused || dropped[0]["fields"].(map[string]any)["channel"] != "other" || stored != accepted {
		t.Fatalf("dropped %v (refused %d), stored %d (accepted %d)", dropped, refused, stored, accepted)
	}
}

// contract: log.writer.never-blocks-and-counts-loss
func TestARecordOfTheLossBetweenTwoRefusalsSplitsThemIntoTwoDroppedRanges(t *testing.T) {
	// The writer records the loss counted so far each time it writes the queue (the end of an interval, an error, a flush or
	// the wakeup of a writer that slept); refusals on both sides of such a write are two ranges.
	options := support.EventLogOptions(t.TempDir())
	options.QueueEvents = 4
	options.BatchInterval = 30 * time.Second
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	hold := holdWriter(log)
	firstAccepted, firstRefused := refuseWhileHeld(t, log, hold, 0)
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	secondAccepted, secondRefused := refuseWhileHeld(t, log, hold, 20)
	if firstAccepted != 4 || firstRefused != 16 || secondAccepted != 4 || secondRefused != 16 {
		t.Fatalf("accepted %d and %d, refused %d and %d", firstAccepted, secondAccepted, firstRefused, secondRefused)
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	events := readEventLog(t, log.Path())
	dropped := droppedRanges(t, events)
	if len(dropped) != 2 {
		t.Fatalf("dropped events %d, want 2: %v", len(dropped), events)
	}
	if countOf(dropped[0]) != firstRefused || countOf(dropped[1]) != secondRefused {
		t.Fatalf("dropped counts %d and %d, refused %d and %d", countOf(dropped[0]), countOf(dropped[1]), firstRefused, secondRefused)
	}
	// The four events accepted after the first range are stored between the two ranges.
	after := dropped[0]["seq"].(float64)
	before := dropped[1]["fields"].(map[string]any)["from_seq"].(float64)
	var between []float64
	stored := 0
	for _, event := range events {
		if event["event"] != "host.test.event" {
			continue
		}
		stored++
		if seq := event["seq"].(float64); seq > after && seq < before {
			between = append(between, event["fields"].(map[string]any)["index"].(float64))
		}
	}
	if fmt.Sprint(between) != "[20 21 22 23]" || stored != firstAccepted+secondAccepted {
		t.Fatalf("stored between the ranges %v, stored %d (accepted %d)", between, stored, firstAccepted+secondAccepted)
	}
}

// contract: log.writer.error-wakes-the-writer
func TestAnEventLogErrorIsWrittenWithoutWaitingForTheBatchInterval(t *testing.T) {
	options := support.EventLogOptions(t.TempDir())
	options.BatchInterval = 30 * time.Second
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	if !log.Emit(host.LevelError, "host.test.failure", map[string]any{"reason": "disk"}) {
		t.Fatal("the error was refused")
	}
	// The file is the only place where the write shows; no event source announces it, so the test reads it in short
	// steps until a deadline.
	deadline := time.Now().Add(5 * time.Second)
	for {
		for _, event := range readEventLog(t, log.Path()) {
			if event["event"] == "host.test.failure" {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("the error was not written within 5 seconds")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// contract: log.writer.files-are-private
func TestTheEventLogFolderIs0700AndTheFileIs0600(t *testing.T) {
	log, err := host.StartEventLog(support.EventLogOptions(filepath.Join(t.TempDir(), "logs")))
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	file, err := os.Stat(log.Path())
	if err != nil {
		t.Fatal(err)
	}
	folder, err := os.Stat(filepath.Dir(log.Path()))
	if err != nil {
		t.Fatal(err)
	}
	if file.Mode().Perm() != 0o600 || folder.Mode().Perm() != 0o700 {
		t.Fatalf("file %v, folder %v", file.Mode().Perm(), folder.Mode().Perm())
	}
}

// contract: log.writer.output-follows-the-contract
func TestTheEventLogPassesTheAuditOfTheContractPackage(t *testing.T) {
	directory := t.TempDir()
	log, err := host.StartEventLog(support.EventLogOptions(directory))
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	for index := 0; index < 20; index++ {
		log.Emit(host.LevelInfo, "host.app.event", map[string]any{"kind": "started"})
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	catalog := filepath.Join(directory, "catalog.json")
	text := `{"schema":3,"layers":["host"],"events":{
	  "log.open":{"layer":"host","class":"lifecycle","level":"info","fields":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"schema":{"type":"number"},"pid":{"type":"number"},"role":{"type":"string"},"boot":{"type":"string"}},"required":["schema","pid","role","boot"]}},
	  "log.dropped":{"layer":"host","class":"lifecycle","level":"warn","fields":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"from_seq":{"type":"number"},"to_seq":{"type":"number"},"count":{"type":"number"},"bytes":{"type":"number"},"reason":{"type":"string"},"channel":{"type":"string"},"queued":{"type":"number"}},"required":["from_seq","to_seq","count","bytes","reason","channel"]}},
	  "log.policy":{"layer":"host","class":"lifecycle","level":"info","fields":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"source":{"type":"string"},"classes":{"type":"object"}},"required":["source","classes"]}},
	  "host.app.event":{"layer":"host","class":"lifecycle","level":"info","fields":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"kind":{"type":"string"}},"required":["kind"]}}}}`
	if err := os.WriteFile(catalog, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	// The audit command of the repository audits the log with the event contract and prints the findings as JSON.
	audit, err := filepath.Abs("../../../../scripts/audit-log.mjs")
	if err != nil {
		t.Fatal(err)
	}
	output, err := exec.Command("node", audit, log.Path(), catalog).CombinedOutput()
	if err != nil {
		t.Fatalf("%v: %s", err, output)
	}
	if strings.TrimSpace(string(output)) != "[]" {
		t.Fatalf("findings %s", output)
	}
}

// contract: log.writer.flush-at-exit
func TestEventLogFlushWritesEveryAcceptedEventBeforeItReturns(t *testing.T) {
	options := support.EventLogOptions(t.TempDir())
	options.BatchInterval = 30 * time.Second
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	for index := 0; index < 40; index++ {
		if !log.Emit(host.LevelInfo, "host.test.event", map[string]any{"index": index}) {
			t.Fatalf("event %d was refused", index)
		}
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	stored := 0
	for _, event := range readEventLog(t, log.Path()) {
		if event["event"] == "host.test.event" {
			stored++
		}
	}
	if stored != 40 {
		t.Fatalf("stored %d of 40", stored)
	}
}

// contract: log.writer.relays-events-with-their-layer-and-time
func TestARelayedEventKeepsItsLayerAndTimeAndGetsTheSeqOfTheWriter(t *testing.T) {
	log, err := host.StartEventLog(support.EventLogOptions(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	relayed := func(layer, event string, fields string) host.RelayedEvent {
		return host.RelayedEvent{TsMicros: 1, MonoNs: 1, Layer: layer, Level: host.LevelInfo, Event: event, Fields: json.RawMessage(fields)}
	}
	accepted, err := log.EmitRelayed(host.RelayedEvent{TsMicros: 1_791_000_000_000_123, MonoNs: 5_000_000_123, Layer: "page", Page: "1791948729050", Level: host.LevelWarn,
		Event: "page.test.event", Cids: []string{"b1.9"}, Fields: json.RawMessage(`{"index":7}`)})
	if err != nil || !accepted {
		t.Fatalf("accepted %v, error %v", accepted, err)
	}
	if _, err := log.EmitRelayed(relayed("page", "host.test.event", `{}`)); err == nil || !strings.Contains(err.Error(), "does not start with its layer") {
		t.Fatalf("a name outside its layer: %v", err)
	}
	if _, err := log.EmitRelayed(relayed("unknown", "unknown.test.event", `{}`)); err == nil || !strings.Contains(err.Error(), "is not one of") {
		t.Fatalf("a layer outside the contract: %v", err)
	}
	if _, err := log.EmitRelayed(relayed("page", "page.test.event", `{broken`)); err == nil || !strings.Contains(err.Error(), "fields") {
		t.Fatalf("fields that are not JSON: %v", err)
	}
	noClock := relayed("page", "page.test.event", `{}`)
	noClock.MonoNs = 0
	if _, err := log.EmitRelayed(noClock); err == nil || !strings.Contains(err.Error(), "mono_ns") {
		t.Fatalf("a monotonic clock of 0: %v", err)
	}
	for _, bad := range []string{"", `a"b`, `a\b`, "a\nb"} {
		invalid := relayed("page", "page.test.event", `{}`)
		invalid.Cids = []string{"b1.1", bad}
		if _, err := log.EmitRelayed(invalid); err == nil || !strings.Contains(err.Error(), "cid") {
			t.Fatalf("the identifier %q: %v", bad, err)
		}
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	events := readEventLog(t, log.Path())
	if len(events) != 3 {
		t.Fatalf("events %v", events)
	}
	stored := events[2]
	if stored["layer"] != "page" || stored["ts_us"] != float64(1_791_000_000_000_123) || stored["mono_ns"] != float64(5_000_000_123) || stored["seq"] != float64(3) ||
		stored["level"] != "warn" || stored["fields"].(map[string]any)["index"] != float64(7) || len(stored["cids"].([]any)) != 1 || stored["cids"].([]any)[0] != "b1.9" {
		t.Fatalf("relayed event %v", stored)
	}
}

// contract: log.writer.names-the-writing-document
func TestARelayedEventNamesTheDocumentThatWroteItInTheMemberOfItsLayer(t *testing.T) {
	log, err := host.StartEventLog(support.EventLogOptions(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	relayed := func(layer, event, page, start string) host.RelayedEvent {
		return host.RelayedEvent{TsMicros: 1, MonoNs: 1, Layer: layer, Page: page, Start: start, Level: host.LevelInfo, Event: event, Fields: json.RawMessage(`{}`)}
	}
	for _, accepted := range []host.RelayedEvent{
		relayed("workbench", "workbench.test.event", "", "S1"),
		relayed("page", "page.test.event", "P1", ""),
		relayed("plugin", "plugin.probe.saved", "", "S1"),
		relayed("plugin", "plugin.probe.saved", "P1", ""),
	} {
		if ok, err := log.EmitRelayed(accepted); err != nil || !ok {
			t.Fatalf("%+v: accepted %v, error %v", accepted, ok, err)
		}
	}
	for _, c := range []struct {
		event host.RelayedEvent
		want  string
	}{
		{relayed("workbench", "workbench.test.event", "", ""), "the event workbench.test.event of the layer workbench names its writer in start"},
		{relayed("workbench", "workbench.test.event", "P1", "S1"), "the event workbench.test.event of the layer workbench names page, which only an event of the layer page or plugin names"},
		{relayed("page", "page.test.event", "P1", "S1"), "the event page.test.event of the layer page names start, which only an event of the layer workbench or plugin names"},
		{relayed("plugin", "plugin.probe.saved", "P1", "S1"), "the event plugin.probe.saved of the layer plugin names its writer in one of page and start, not both"},
		{relayed("plugin", "plugin.probe.saved", "", ""), "the event plugin.probe.saved of the layer plugin names its writer in page or start"},
		{relayed("native", "native.test.event", "", "S1"), "the event native.test.event of the layer native names start, which only an event of the layer workbench or plugin names"},
	} {
		if _, err := log.EmitRelayed(c.event); err == nil || err.Error() != c.want {
			t.Errorf("%+v: error %v, want %q", c.event, err, c.want)
		}
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	events := readEventLog(t, log.Path())
	if len(events) != 6 {
		t.Fatalf("events %v", events)
	}
	for index, want := range []map[string]any{{"start": "S1"}, {"page": "P1"}, {"start": "S1"}, {"page": "P1"}} {
		stored := events[2+index]
		_, page := stored["page"]
		_, start := stored["start"]
		if (want["page"] != nil) != page || (want["start"] != nil) != start || (page && stored["page"] != want["page"]) || (start && stored["start"] != want["start"]) {
			t.Fatalf("event %d %v, want %v", index, stored, want)
		}
	}
}

// contract: log.writer.rotates-at-the-bound-and-keeps-generations
func TestTheEventLogRotatesAtTheBoundAndKeepsEveryGeneration(t *testing.T) {
	options := support.EventLogOptions(t.TempDir())
	options.RotateBytes = 4000
	// The queue holds every event, so no refusal makes a gap of seq that log.dropped would explain.
	options.QueueEvents = 1000
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	for index := 0; index < 300; index++ {
		if !log.Emit(host.LevelInfo, "host.test.event", map[string]any{"index": index, "padding": "xxxxxxxxxxxxxxxxxxxx"}) {
			t.Fatalf("event %d was refused", index)
		}
	}
	if err := log.Flush(10 * time.Second); err != nil {
		t.Fatal(err)
	}
	// The generations are numbered in the order of the rotations and none is removed.
	names := []string{log.Path()}
	for n := 1; ; n++ {
		name := fmt.Sprintf("%s.%d", log.Path(), n)
		if _, err := os.Stat(name); err != nil {
			break
		}
		names = append(names, name)
	}
	if len(names) < 8 {
		t.Fatalf("the file rotated into %d generations, want more than the 5 that an earlier writer kept", len(names)-1)
	}
	current := readEventLog(t, log.Path())
	if current[0]["event"] != "log.open" || current[1]["event"] != "log.rotated" {
		t.Fatalf("a rotated file starts with %v and %v", current[0]["event"], current[1]["event"])
	}
	rotated := current[1]["fields"].(map[string]any)
	// The latest archived file contains the exact number of bytes reported by log.rotated.
	archived, err := os.Stat(names[len(names)-1])
	if err != nil {
		t.Fatalf("latest archived generation: %v", err)
	}
	if rotated["generation"] != float64(len(names)-1) || rotated["bytes"] != float64(archived.Size()) {
		t.Fatalf("log.rotated fields %v with %d generations", rotated, len(names)-1)
	}
	if _, has := rotated["kept"]; has {
		t.Fatalf("log.rotated has the field kept: %v", rotated)
	}
	// Every generation is a file of the contract: it opens with log.open, and its seq is consecutive.
	for _, name := range names {
		if info, err := os.Stat(name); err != nil || info.Size() > 4000 {
			t.Fatalf("%s: %v, %v", name, info, err)
		}
		events := readEventLog(t, name)
		if events[0]["event"] != "log.open" {
			t.Fatalf("%s starts with %v", name, events[0]["event"])
		}
		for position := 1; position < len(events); position++ {
			if events[position]["seq"].(float64) != events[position-1]["seq"].(float64)+1 {
				t.Fatalf("%s: seq %v follows %v", name, events[position]["seq"], events[position-1]["seq"])
			}
		}
	}
	if current[0]["seq"].(float64) <= readEventFile(t, log.Path()+".1")[0]["seq"].(float64) {
		t.Fatal("seq does not continue across the rotation")
	}
	for position := 2; position < len(names); position++ {
		if readEventLog(t, names[position])[0]["seq"].(float64) <= readEventLog(t, names[position-1])[0]["seq"].(float64) {
			t.Fatalf("generation %d does not follow generation %d in seq", position, position-1)
		}
	}
}

// contract: log.writer.refuses-an-unbounded-file
func TestAnEventLogWithoutARotationBoundIsRefused(t *testing.T) {
	options := support.EventLogOptions(t.TempDir())
	options.RotateBytes = 0
	if _, err := host.StartEventLog(options); err == nil || !strings.Contains(err.Error(), "RotateBytes") {
		t.Fatalf("error %v", err)
	}
}

// contract: log.writer.announces-each-write-to-the-observer
func TestTheWriterAnnouncesEachWriteToItsObserver(t *testing.T) {
	log, err := host.StartEventLog(support.EventLogOptions(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	type announced struct {
		path string
		size int64
	}
	announcements := make(chan announced, 16)
	log.SetOnWrite(func(path string, size int64) { announcements <- announced{path, size} })
	if !log.Emit(host.LevelInfo, "host.test.event", map[string]any{"index": 1}) {
		t.Fatal("the event was refused")
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-announcements:
		info, err := os.Stat(got.path)
		if err != nil || filepath.Base(got.path) != "host-b1.jsonl" || got.size != info.Size() {
			t.Fatalf("announced %+v, the file is %v (%v)", got, info, err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the write was not announced")
	}
	log.Close()
}

// contract: log.writer.writes-each-interval
func TestASteadyStreamOfEventsIsWrittenAtEachBatchInterval(t *testing.T) {
	// Events arrive every 5 ms, faster than the batch interval of 50 ms, so a writer that waits for a quiet interval
	// writes nothing while they arrive.
	options := support.EventLogOptions(t.TempDir())
	options.QueueEvents = 4096
	options.QueueBytes = 1 << 22
	options.BatchInterval = 50 * time.Millisecond
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	started := time.Now()
	index := 0
	for time.Since(started) < 400*time.Millisecond {
		if !log.Emit(host.LevelInfo, "host.test.event", map[string]any{"index": index}) {
			t.Fatalf("event %d was refused", index)
		}
		index++
		time.Sleep(5 * time.Millisecond)
	}
	data, err := os.ReadFile(log.Path())
	if err != nil {
		t.Fatal(err)
	}
	if written := strings.Count(string(data), "\n"); written <= 1 {
		t.Fatalf("after 400 ms of events every 5 ms (%d emitted) the file holds %d line(s); the writer waits for a quiet interval", index, written)
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
}
