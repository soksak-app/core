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
)

func eventLogOptions(directory string) host.EventLogOptions {
	return host.EventLogOptions{
		Directory: directory, Role: "host", Boot: "b1", QueueEvents: 64, QueueBytes: 64 * 1024,
		BatchInterval: 20 * time.Millisecond,
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
	if fields["schema"] != float64(1) || fields["role"] != "host" || fields["boot"] != "b1" {
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
	text := `{"schema":1,"events":{
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
	accepted, err := log.EmitRelayed(1_791_000_000_000_123, "page", host.LevelWarn, "page.test.event", json.RawMessage(`{"index":7}`))
	if err != nil || !accepted {
		t.Fatalf("accepted %v, error %v", accepted, err)
	}
	if _, err := log.EmitRelayed(1, "page", host.LevelInfo, "host.test.event", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "does not start with its layer") {
		t.Fatalf("a name outside its layer: %v", err)
	}
	if _, err := log.EmitRelayed(1, "unknown", host.LevelInfo, "unknown.test.event", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "is not one of") {
		t.Fatalf("a layer outside the contract: %v", err)
	}
	if _, err := log.EmitRelayed(1, "page", host.LevelInfo, "page.test.event", json.RawMessage(`{broken`)); err == nil || !strings.Contains(err.Error(), "fields") {
		t.Fatalf("fields that are not JSON: %v", err)
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	events := readEventLog(t, log.Path())
	if len(events) != 2 {
		t.Fatalf("events %v", events)
	}
	relayed := events[1]
	if relayed["layer"] != "page" || relayed["ts_us"] != float64(1_791_000_000_000_123) || relayed["seq"] != float64(2) ||
		relayed["level"] != "warn" || relayed["fields"].(map[string]any)["index"] != float64(7) {
		t.Fatalf("relayed event %v", relayed)
	}
}
