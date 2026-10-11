// The event writer of the host (docs/spec/logging.md#writers): events enter a bounded queue without blocking, one writer
// goroutine assigns seq, writes batches and counts the loss, and the file follows the contract that
// @soksak/log-contract audits.
package host_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

func eventLogOptions(directory string) host.EventLogOptions {
	return host.EventLogOptions{
		Directory: directory, Role: "host", Boot: "b1", QueueEvents: 64, QueueBytes: 64 * 1024,
		BatchInterval: 20 * time.Millisecond, RotateBytes: 1 << 30, Generations: 5,
	}
}

// readEventLog returns the events of a log file, parsed.
func readEventLog(t *testing.T, path string) []map[string]any {
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
	log, err := host.StartEventLog(eventLogOptions(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
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
	if fields["schema"] != float64(2) || fields["role"] != "host" || fields["boot"] != "b1" {
		t.Fatalf("log.open fields %v", fields)
	}
	for position, event := range events {
		if event["seq"] != float64(position+1) {
			t.Fatalf("event %d has seq %v", position, event["seq"])
		}
	}
	if len(events) != 11 || events[5]["fields"].(map[string]any)["index"] != float64(4) {
		t.Fatalf("events %v", events)
	}
}

// contract: log.writer.stores-both-clocks
func TestEveryLineCarriesTheWallClockAndTheMonotonicClockOfTheCall(t *testing.T) {
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	options := eventLogOptions(t.TempDir())
	// A small file rotates, so log.open and log.rotated are written by the writer after its start.
	options.RotateBytes = 4000
	options.Generations = 3
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
	for _, name := range []string{log.Path() + ".3", log.Path() + ".2", log.Path() + ".1", log.Path()} {
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
	log, err := host.StartEventLog(eventLogOptions(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
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
	if len(events) != 4 {
		t.Fatalf("events %v", events)
	}
	cids, ok := events[1]["cids"].([]any)
	if !ok || len(cids) != 2 || cids[0] != "b1.1" || cids[1] != "b1.2" {
		t.Fatalf("the cids of the first event: %v", events[1])
	}
	if _, present := events[2]["cids"]; present {
		t.Fatalf("an event without identifiers has cids: %v", events[2])
	}
	dropped := events[3]
	if dropped["event"] != "log.dropped" || dropped["fields"].(map[string]any)["count"] != float64(4) {
		t.Fatalf("the four refused events were not counted: %v", dropped)
	}
}

// contract: log.writer.never-blocks-and-counts-loss
func TestAFullEventQueueReturnsFalseAndTheWriterRecordsTheRangeAsDropped(t *testing.T) {
	options := eventLogOptions(t.TempDir())
	options.QueueEvents = 4
	// The writer waits a long time between batches, so the queue stays full while the producer pushes.
	options.BatchInterval = 30 * time.Second
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	accepted, refused := 0, 0
	for index := 0; index < 50; index++ {
		if log.Emit(host.LevelInfo, "host.test.event", map[string]any{"index": index}) {
			accepted++
		} else {
			refused++
		}
	}
	if accepted < 4 || refused == 0 {
		t.Fatalf("accepted %d, refused %d", accepted, refused)
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	dropped, stored := 0, 0
	var count any
	for _, event := range readEventLog(t, log.Path()) {
		switch event["event"] {
		case "log.dropped":
			dropped++
			count = event["fields"].(map[string]any)["count"]
		case "host.test.event":
			stored++
		}
	}
	if dropped != 1 || count != float64(refused) || stored != accepted {
		t.Fatalf("dropped events %d with count %v (refused %d), stored %d (accepted %d)", dropped, count, refused, stored, accepted)
	}
}

// contract: log.writer.error-wakes-the-writer
func TestAnEventLogErrorIsWrittenWithoutWaitingForTheBatchInterval(t *testing.T) {
	options := eventLogOptions(t.TempDir())
	options.BatchInterval = 30 * time.Second
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
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
	log, err := host.StartEventLog(eventLogOptions(filepath.Join(t.TempDir(), "logs")))
	if err != nil {
		t.Fatal(err)
	}
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
	log, err := host.StartEventLog(eventLogOptions(directory))
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 20; index++ {
		log.Emit(host.LevelInfo, "host.test.event", map[string]any{"index": index})
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	catalog := filepath.Join(directory, "catalog.json")
	text := `{"schema":2,"events":{
	  "log.open":{"layer":"host","class":"lifecycle","level":"info","fields":{"schema":"number","pid":"number","role":"string","boot":"string"}},
	  "log.dropped":{"layer":"host","class":"lifecycle","level":"warn","fields":{"from_seq":"number","to_seq":"number","count":"number"}},
	  "host.test.event":{"layer":"host","class":"lifecycle","level":"info","fields":{"index":"number"}}}}`
	if err := os.WriteFile(catalog, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	contract, err := filepath.Abs("../../../log-contract/index.js")
	if err != nil {
		t.Fatal(err)
	}
	script := `import { readFileSync } from 'node:fs'; import { auditLog } from 'file://` + contract + `';
const catalog = JSON.parse(readFileSync(` + quote(catalog) + `, 'utf8'));
console.log(JSON.stringify(auditLog(` + quote(log.Path()) + `, readFileSync(` + quote(log.Path()) + `, 'utf8'), catalog)));`
	output, err := exec.Command("node", "--input-type=module", "-e", script).CombinedOutput()
	if err != nil {
		t.Fatalf("%v: %s", err, output)
	}
	if strings.TrimSpace(string(output)) != "[]" {
		t.Fatalf("findings %s", output)
	}
}

func quote(text string) string {
	data, _ := json.Marshal(text)
	return string(data)
}

// contract: log.writer.flush-at-exit
func TestEventLogFlushWritesEveryAcceptedEventBeforeItReturns(t *testing.T) {
	options := eventLogOptions(t.TempDir())
	options.BatchInterval = 30 * time.Second
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
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
	log, err := host.StartEventLog(eventLogOptions(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	relayed := func(layer, event string, fields string) host.RelayedEvent {
		return host.RelayedEvent{TsMicros: 1, MonoNs: 1, Layer: layer, Level: host.LevelInfo, Event: event, Fields: json.RawMessage(fields)}
	}
	accepted, err := log.EmitRelayed(host.RelayedEvent{TsMicros: 1_791_000_000_000_123, MonoNs: 5_000_000_123, Layer: "page", Level: host.LevelWarn,
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
	if len(events) != 2 {
		t.Fatalf("events %v", events)
	}
	stored := events[1]
	if stored["layer"] != "page" || stored["ts_us"] != float64(1_791_000_000_000_123) || stored["mono_ns"] != float64(5_000_000_123) || stored["seq"] != float64(2) ||
		stored["level"] != "warn" || stored["fields"].(map[string]any)["index"] != float64(7) || len(stored["cids"].([]any)) != 1 || stored["cids"].([]any)[0] != "b1.9" {
		t.Fatalf("relayed event %v", stored)
	}
}

// contract: log.writer.rotates-at-the-bound-and-keeps-generations
func TestTheEventLogRotatesAtTheBoundAndKeepsTheNewestGenerations(t *testing.T) {
	options := eventLogOptions(t.TempDir())
	options.RotateBytes = 4000
	options.Generations = 2
	// The queue holds every event, so no refusal makes a gap of seq that log.dropped would explain.
	options.QueueEvents = 1000
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 300; index++ {
		if !log.Emit(host.LevelInfo, "host.test.event", map[string]any{"index": index, "padding": "xxxxxxxxxxxxxxxxxxxx"}) {
			t.Fatalf("event %d was refused", index)
		}
	}
	if err := log.Flush(10 * time.Second); err != nil {
		t.Fatal(err)
	}
	names := []string{log.Path(), log.Path() + ".1", log.Path() + ".2"}
	for _, name := range names {
		if _, err := os.Stat(name); err != nil {
			t.Fatalf("generation %s: %v", name, err)
		}
	}
	if _, err := os.Stat(log.Path() + ".3"); err == nil {
		t.Fatal("a third generation was kept")
	}
	current := readEventLog(t, log.Path())
	if current[0]["event"] != "log.open" || current[1]["event"] != "log.rotated" {
		t.Fatalf("a rotated file starts with %v and %v", current[0]["event"], current[1]["event"])
	}
	rotated := current[1]["fields"].(map[string]any)
	// A file is closed when the next line would pass the bound, so it is full to within one line of 150 bytes.
	if rotated["kept"] != float64(2) || rotated["bytes"].(float64) > 4000 || rotated["bytes"].(float64) < 4000-150 {
		t.Fatalf("log.rotated fields %v", rotated)
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
	if current[0]["seq"].(float64) <= readEventLog(t, log.Path()+".1")[0]["seq"].(float64) {
		t.Fatal("seq does not continue across the rotation")
	}
}

// contract: log.writer.refuses-an-unbounded-file
func TestAnEventLogWithoutARotationBoundIsRefused(t *testing.T) {
	options := eventLogOptions(t.TempDir())
	options.RotateBytes = 0
	if _, err := host.StartEventLog(options); err == nil || !strings.Contains(err.Error(), "RotateBytes") {
		t.Fatalf("error %v", err)
	}
	options = eventLogOptions(t.TempDir())
	options.Generations = 0
	if _, err := host.StartEventLog(options); err == nil || !strings.Contains(err.Error(), "Generations") {
		t.Fatalf("error %v", err)
	}
}

// contract: log.writer.announces-each-write-to-the-observer
func TestTheWriterAnnouncesEachWriteToItsObserver(t *testing.T) {
	log, err := host.StartEventLog(eventLogOptions(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
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
