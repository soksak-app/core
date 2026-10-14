// The records of the host (docs/spec/logging.md#writers): an error or an observation of the host, and a record that the
// page reports, are events `<layer>.record.<level>` with the fields `where` and `text`. A bounded start buffer holds the
// records written before the writer exists and counts the records it refuses.
package host_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// useEventLog starts a writer, makes it the writer of the records of the host, and detaches it when the test ends.
func useEventLog(t *testing.T) *host.EventLog {
	t.Helper()
	// Records that earlier tests wrote while no writer was attached wait in the start buffer; they are not this test's.
	host.UseHostEventLog(nil)
	log, err := host.StartEventLog(eventLogOptions(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	host.UseHostEventLog(log)
	// The writer ends before the folder of the test is removed; a writer that outlives the test writes into a removed folder.
	t.Cleanup(func() { host.UseHostEventLog(nil); log.Close() })
	return log
}

// contract: log.record.error-and-info-are-events
func TestAnErrorAndAnObservationAreEventsWithWhereAndText(t *testing.T) {
	log := useEventLog(t)
	host.LogError("surface input", errors.New("the window has no content view"))
	host.LogInfo("webkit children", "pid 7: gone")
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	events := readEventLog(t, log.Path())
	want := []struct{ level, layer, event, where, text string }{
		{"error", "host", "host.record.error", "surface input", "the window has no content view"},
		{"info", "host", "host.record.info", "webkit children", "pid 7: gone"},
	}
	if len(events) != 1+len(want) {
		t.Fatalf("events %v", events)
	}
	for index, w := range want {
		event := events[1+index]
		fields := event["fields"].(map[string]any)
		if event["level"] != w.level || event["layer"] != w.layer || event["event"] != w.event || fields["where"] != w.where || fields["text"] != w.text {
			t.Fatalf("event %d is %v, want %+v", index, event, w)
		}
	}
}

// contract: log.record.start-buffer-holds-records-until-the-writer-exists
func TestRecordsWrittenBeforeTheWriterExistsAreStoredInOrderWithTheirOwnTime(t *testing.T) {
	host.UseHostEventLog(nil)
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	before := time.Now().UnixMicro()
	monoBefore, err := system.MonotonicNanos()
	if err != nil {
		t.Fatal(err)
	}
	host.LogError("early", "first")
	host.LogInfo("early", "second")
	after := time.Now().UnixMicro()
	monoAfter, err := system.MonotonicNanos()
	if err != nil {
		t.Fatal(err)
	}
	log, err := host.StartEventLog(eventLogOptions(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	host.UseHostEventLog(log)
	t.Cleanup(func() { host.UseHostEventLog(nil) })
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	events := readEventLog(t, log.Path())
	if len(events) != 3 || events[1]["fields"].(map[string]any)["text"] != "first" || events[2]["fields"].(map[string]any)["text"] != "second" {
		t.Fatalf("events %v", events)
	}
	for _, event := range events[1:] {
		if ts := int64(event["ts_us"].(float64)); ts < before || ts > after {
			t.Fatalf("ts_us %d is outside [%d, %d]: the record took the time of the attach", ts, before, after)
		}
		if mono := uint64(event["mono_ns"].(float64)); mono < monoBefore || mono > monoAfter {
			t.Fatalf("mono_ns %d is outside [%d, %d]: the record took the clock of the attach", mono, monoBefore, monoAfter)
		}
	}
}

// contract: log.record.start-buffer-counts-its-loss
func TestTheStartBufferRefusesRecordsBeyondItsBoundAndTheWriterCountsThem(t *testing.T) {
	host.UseHostEventLog(nil)
	const extra = 6
	for index := 0; index < host.StartBufferRecords+extra; index++ {
		host.LogInfo("flood", "record")
	}
	options := eventLogOptions(t.TempDir())
	options.QueueEvents = 4 * host.StartBufferRecords
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	host.UseHostEventLog(log)
	t.Cleanup(func() { host.UseHostEventLog(nil) })
	if err := log.Flush(10 * time.Second); err != nil {
		t.Fatal(err)
	}
	stored, dropped := 0, float64(0)
	for _, event := range readEventLog(t, log.Path()) {
		switch event["event"] {
		case "host.record.info":
			stored++
		case "log.dropped":
			dropped += event["fields"].(map[string]any)["count"].(float64)
		}
	}
	if stored != host.StartBufferRecords || dropped != extra {
		t.Fatalf("stored %d of %d, dropped %v of %d", stored, host.StartBufferRecords+extra, dropped, extra)
	}
}

// contract: log.record.flush-stores-the-records-written-so-far
func TestFlushRecordsStoresTheRecordsWrittenSoFarWithoutWaitingForTheBatchInterval(t *testing.T) {
	host.UseHostEventLog(nil)
	if err := host.FlushRecords(time.Second); err != nil {
		t.Fatalf("without a writer there is nothing to wait for: %v", err)
	}
	options := eventLogOptions(t.TempDir())
	options.BatchInterval = 30 * time.Second
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	host.UseHostEventLog(log)
	t.Cleanup(func() { host.UseHostEventLog(nil) })
	host.LogInfo("flush", "stored before the interval")
	if err := host.FlushRecords(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	events := readEventLog(t, log.Path())
	if len(events) != 2 || events[1]["fields"].(map[string]any)["text"] != "stored before the interval" {
		t.Fatalf("events %v", events)
	}
}

// contract: performance.trace.host-observation-is-an-event
func TestAHostObservationOfTheTraceIsAnEvent(t *testing.T) {
	log := useEventLog(t)
	if _, err := host.PerformanceCommand(map[string]any{"action": "on"}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := host.PerformanceCommand(map[string]any{"action": "off"}); err != nil {
			t.Error(err)
		}
	})
	host.PerformanceObserve("host", func() map[string]any {
		return map[string]any{"event": "region", "surface": "tab-1", "body": map[string]any{"key": "Enter"}}
	})
	host.PerformanceObserve("sampler", func() map[string]any {
		return map[string]any{"event": "memory", "rss_host_kb": float64(42)}
	})
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	events := readEventLog(t, log.Path())
	// The sampler that "on" starts stores its own events into the same writer, so the events are found by name.
	find := func(name string, accept func(map[string]any) bool) map[string]any {
		for _, event := range events {
			if event["event"] == name && accept(event) {
				return event
			}
		}
		t.Fatalf("no %s in %v", name, events)
		return nil
	}
	region := find("host.trace.region", func(map[string]any) bool { return true })
	memory := find("host.sampler.memory", func(event map[string]any) bool { return event["fields"].(map[string]any)["rss_host_kb"] == float64(42) })
	fields, _ := region["fields"].(map[string]any)
	if region["event"] != "host.trace.region" || region["layer"] != "host" || region["level"] != "debug" ||
		fields["surface"] != "tab-1" || fields["body"].(map[string]any)["key"] != "Enter" {
		t.Fatalf("host observation %v", region)
	}
	if _, has := fields["event"]; has {
		t.Fatalf("the name of the event is repeated in its fields: %v", fields)
	}
	if memory["event"] != "host.sampler.memory" || memory["fields"].(map[string]any)["rss_host_kb"] != float64(42) {
		t.Fatalf("sampler observation %v", memory)
	}
	// An observation without an event name is refused with an error and stores nothing.
	host.PerformanceObserve("host", func() map[string]any { return map[string]any{"surface": "tab-1"} })
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	events = readEventLog(t, log.Path())
	find("host.record.error", func(event map[string]any) bool {
		return event["fields"].(map[string]any)["where"] == "performance trace"
	})
}

// contract: log.input.region-event-with-cids-is-recorded
func TestARegionEventWithCorrelationIdentifiersIsRecordedAsAnInputRelay(t *testing.T) {
	log := useEventLog(t)
	if err := host.RecordInputRelay("tab-1", "view", `{"type":"key","key":"Enter","cids":["b1.3","b1.4"]}`); err != nil {
		t.Fatal(err)
	}
	if err := host.RecordInputRelay("tab-1", "view", `{"type":"focus","focused":true}`); err != nil {
		t.Fatalf("an event without identifiers: %v", err)
	}
	for event, message := range map[string]string{
		`{"type":"key","cids":"b1.3"}`:   "cids",
		`{"type":"key","cids":["a\"b"]}`: "cids",
		`{"cids":["b1.3"]}`:              "type",
		`{"type":7,"cids":["b1.3"]}`:     "type",
		`not json`:                       "region event",
	} {
		if err := host.RecordInputRelay("tab-1", "view", event); err == nil || !strings.Contains(err.Error(), message) {
			t.Fatalf("%s: error %v, want it to name %q", event, err, message)
		}
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	events := readEventLog(t, log.Path())
	if len(events) != 2 {
		t.Fatalf("events %v", events)
	}
	relay := events[1]
	cids, ok := relay["cids"].([]any)
	fields := relay["fields"].(map[string]any)
	if relay["event"] != "host.input.relay" || relay["layer"] != "host" || relay["level"] != "info" || !ok || len(cids) != 2 || cids[0] != "b1.3" || cids[1] != "b1.4" ||
		fields["surface"] != "tab-1" || fields["name"] != "view" || fields["type"] != "key" {
		t.Fatalf("the relay record: %v", relay)
	}
}
