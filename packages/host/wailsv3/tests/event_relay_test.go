// The `log` call of the page (docs/spec/logging.md#writers): the page relays a batch of events, the host validates the
// whole batch before it writes any event, and every event of the batch is stored in the layer `page`.
package host_test

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
	"github.com/soksak-app/core/packages/host/wailsv3/tests/support"
)

func relayEvent(event string, index int) map[string]any {
	return map[string]any{"ts_us": float64(1_791_000_000_000_000 + index), "mono_ns": float64(5_000_000_000 + index), "level": "info", "event": event, "page": "1791948729050", "fields": map[string]any{"index": float64(index)}}
}

// contract: log.batch.stores-page-events-in-order
func TestARelayedBatchIsStoredInOrderInTheLayerPage(t *testing.T) {
	log, err := host.StartEventLog(eventLogOptions(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	request := map[string]any{"action": "batch", "events": []any{relayEvent("page.test.first", 1), relayEvent("page.test.second", 2)}}
	if _, err := host.LogCommand(log, request); err != nil {
		t.Fatal(err)
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	events := readEventLog(t, log.Path())
	if len(events) != 4 || events[2]["event"] != "page.test.first" || events[3]["event"] != "page.test.second" ||
		events[2]["layer"] != "page" || events[3]["ts_us"] != float64(1_791_000_000_000_002) {
		t.Fatalf("events %v", events)
	}
}

// contract: log.batch.rejects-an-invalid-batch-without-writing, log.batch.requires-the-page
func TestAnInvalidRelayedBatchWritesNothingAndNamesTheEvent(t *testing.T) {
	log, err := host.StartEventLog(eventLogOptions(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	cases := map[string]struct {
		request map[string]any
		message string
	}{
		"no action":      {map[string]any{"events": []any{}}, "action must be batch, clock, policy or policy-read"},
		"another action": {map[string]any{"action": "line", "events": []any{}}, "action must be batch, clock, policy or policy-read, not \"line\""},
		"no events":      {map[string]any{"action": "batch"}, "events must be an array"},
		"an event that names no page": {map[string]any{"action": "batch", "events": []any{map[string]any{"ts_us": float64(1), "mono_ns": float64(1), "level": "info", "event": "page.test.event", "fields": map[string]any{}}}},
			"events[0]: page must name the document that wrote the event"},
		"a layer other than page": {map[string]any{"action": "batch", "events": []any{relayEvent("page.test.ok", 1), relayEvent("host.test.forged", 2)}},
			"events[1]: the event \"host.test.forged\" does not start with page. or plugin."},
		"a level outside the contract": {map[string]any{"action": "batch", "events": []any{map[string]any{"ts_us": float64(1), "mono_ns": float64(1), "level": "loud", "event": "page.test.event", "page": "1791948729050", "fields": map[string]any{}}}},
			"events[0]: level must be one of error, warn, info, debug, trace"},
		"a time that is not a number": {map[string]any{"action": "batch", "events": []any{map[string]any{"ts_us": "now", "mono_ns": float64(1), "level": "info", "event": "page.test.event", "page": "1791948729050", "fields": map[string]any{}}}},
			"events[0]: ts_us must be a positive integer"},
		"a monotonic clock of 0": {map[string]any{"action": "batch", "events": []any{map[string]any{"ts_us": float64(1), "mono_ns": float64(0), "level": "info", "event": "page.test.event", "page": "1791948729050", "fields": map[string]any{}}}},
			"events[0]: mono_ns must be a positive integer"},
		"no monotonic clock": {map[string]any{"action": "batch", "events": []any{map[string]any{"ts_us": float64(1), "level": "info", "event": "page.test.event", "page": "1791948729050", "fields": map[string]any{}}}},
			"events[0]: mono_ns must be a positive integer"},
		"cids that are not a list": {map[string]any{"action": "batch", "events": []any{map[string]any{"ts_us": float64(1), "mono_ns": float64(1), "level": "info", "event": "page.test.event", "page": "1791948729050", "fields": map[string]any{}, "cids": "b1.1"}}},
			"events[0]: cids must be an array of non-empty strings without a quote, a backslash or a control character"},
		"an empty identifier": {map[string]any{"action": "batch", "events": []any{map[string]any{"ts_us": float64(1), "mono_ns": float64(1), "level": "info", "event": "page.test.event", "page": "1791948729050", "fields": map[string]any{}, "cids": []any{""}}}},
			"events[0]: cids must be an array of non-empty strings without a quote, a backslash or a control character"},
		"an identifier with a quote": {map[string]any{"action": "batch", "events": []any{map[string]any{"ts_us": float64(1), "mono_ns": float64(1), "level": "info", "event": "page.test.event", "page": "1791948729050", "fields": map[string]any{}, "cids": []any{"b1.1", "a\"b"}}}},
			"events[0]: cids must be an array of non-empty strings without a quote, a backslash or a control character"},
		"an identifier that is not a string": {map[string]any{"action": "batch", "events": []any{map[string]any{"ts_us": float64(1), "mono_ns": float64(1), "level": "info", "event": "page.test.event", "page": "1791948729050", "fields": map[string]any{}, "cids": []any{7}}}},
			"events[0]: cids must be an array of non-empty strings without a quote, a backslash or a control character"},
		"fields that are not an object": {map[string]any{"action": "batch", "events": []any{map[string]any{"ts_us": float64(1), "mono_ns": float64(1), "level": "info", "event": "page.test.event", "page": "1791948729050", "fields": "text"}}},
			"events[0]: fields must be an object"},
	}
	for name, c := range cases {
		_, err := host.LogCommand(log, c.request)
		if err == nil || !strings.Contains(err.Error(), c.message) {
			t.Errorf("%s: error %v, want %q", name, err, c.message)
		}
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	if events := readEventLog(t, log.Path()); len(events) != 2 {
		raw, _ := json.Marshal(events)
		t.Fatalf("an invalid batch wrote events: %s", raw)
	}
}

// contract: log.batch.returns-the-transcript-lines-of-page-records
func TestARelayedBatchReturnsTheTranscriptLinesOfItsPageRecords(t *testing.T) {
	log, err := host.StartEventLog(eventLogOptions(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	record := func(level, where, text string, index int) map[string]any {
		return map[string]any{"ts_us": float64(1_791_000_000_000_000 + index), "mono_ns": float64(5_000_000_000 + index), "level": level, "event": "page.record." + level, "page": "1791948729050",
			"fields": map[string]any{"where": where, "text": text}}
	}
	request := map[string]any{"action": "batch", "events": []any{
		record("error", "surface probe", "mount failed\nsecond line", 1),
		relayEvent("page.trace.action", 2),
		record("info", "page", "ready", 3),
	}}
	reply, err := host.LogCommand(log, request)
	if err != nil {
		t.Fatal(err)
	}
	lines := reply.Lines
	want := []string{"error page surface probe: mount failed\\nsecond line", "info page page: ready"}
	if len(lines) != len(want) || lines[0] != want[0] || lines[1] != want[1] {
		t.Fatalf("lines %q, want %q", lines, want)
	}
	// A record event whose fields are not the strings where and text is refused with the batch.
	bad := map[string]any{"action": "batch", "events": []any{map[string]any{"ts_us": float64(1), "mono_ns": float64(1), "level": "info", "event": "page.record.info", "page": "1791948729050", "fields": map[string]any{"where": 7}}}}
	if _, err := host.LogCommand(log, bad); err == nil || !strings.Contains(err.Error(), "events[0]: fields where and text must be strings") {
		t.Fatalf("error %v", err)
	}
}

// contract: log.batch.stores-clock-and-cids-of-page-events
func TestARelayedBatchStoresTheMonotonicClockAndTheIdentifiersThatThePageGave(t *testing.T) {
	log, err := host.StartEventLog(eventLogOptions(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	withCids := relayEvent("page.call", 1)
	withCids["cids"] = []any{"b1.7", "b1.8"}
	request := map[string]any{"action": "batch", "events": []any{withCids, relayEvent("page.call", 2)}}
	if _, err := host.LogCommand(log, request); err != nil {
		t.Fatal(err)
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	events := readEventLog(t, log.Path())
	if len(events) != 4 {
		t.Fatalf("events %v", events)
	}
	cids, ok := events[2]["cids"].([]any)
	if events[2]["mono_ns"] != float64(5_000_000_001) || !ok || len(cids) != 2 || cids[0] != "b1.7" || cids[1] != "b1.8" {
		t.Fatalf("the event with identifiers: %v", events[2])
	}
	if _, present := events[3]["cids"]; present || events[3]["mono_ns"] != float64(5_000_000_002) {
		t.Fatalf("the event without identifiers: %v", events[3])
	}
}

// contract: log.batch.answers-the-clock-request
func TestTheClockRequestAnswersTheClocksOfTheHostAndStoresNoEvent(t *testing.T) {
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	log, err := host.StartEventLog(eventLogOptions(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	wallBefore := time.Now().UnixMicro()
	monoBefore, err := system.MonotonicNanos()
	if err != nil {
		t.Fatal(err)
	}
	first, err := host.LogCommand(log, map[string]any{"action": "clock"})
	if err != nil || first.Clock == nil || len(first.Lines) != 0 {
		t.Fatalf("the first answer: %+v, %v", first, err)
	}
	second, err := host.LogCommand(log, map[string]any{"action": "clock"})
	if err != nil || second.Clock == nil {
		t.Fatalf("the second answer: %+v, %v", second, err)
	}
	wallAfter := time.Now().UnixMicro()
	monoAfter, err := system.MonotonicNanos()
	if err != nil {
		t.Fatal(err)
	}
	for _, clock := range []*host.ClockReading{first.Clock, second.Clock} {
		if clock.TsMicros < wallBefore || clock.TsMicros > wallAfter || clock.MonoNs < monoBefore || clock.MonoNs > monoAfter {
			t.Fatalf("the clocks %+v are outside ts_us [%d, %d] and mono_ns [%d, %d]", clock, wallBefore, wallAfter, monoBefore, monoAfter)
		}
	}
	if second.Clock.TsMicros < first.Clock.TsMicros || second.Clock.MonoNs < first.Clock.MonoNs {
		t.Fatalf("the second answer %+v is smaller than the first %+v", second.Clock, first.Clock)
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	if events := readEventLog(t, log.Path()); len(events) != 2 {
		t.Fatalf("a clock request stored events: %v", events)
	}
}

// contract: log.batch.stores-plugin-events-in-the-layer-plugin
func TestARelayedBatchStoresAPluginEventInTheLayerPlugin(t *testing.T) {
	log, err := host.StartEventLog(eventLogOptions(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	support.StoreEveryLevel(t, log)
	request := map[string]any{"action": "batch", "events": []any{relayEvent("plugin.fixture.input", 1), relayEvent("page.console.error", 2)}}
	if _, err := host.LogCommand(log, request); err != nil {
		t.Fatal(err)
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	events := readEventLog(t, log.Path())
	if len(events) != 4 || events[2]["layer"] != "plugin" || events[2]["event"] != "plugin.fixture.input" || events[3]["layer"] != "page" {
		t.Fatalf("events %v", events)
	}
}
