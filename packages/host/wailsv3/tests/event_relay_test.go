// The `log` call of the page (docs/spec/logging.md#writers): the page relays a batch of events, the host validates the
// whole batch before it writes any event, and every event of the batch is stored in the layer `page`.
package host_test

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

func relayEvent(event string, index int) map[string]any {
	return map[string]any{"ts_us": float64(1_791_000_000_000_000 + index), "level": "info", "event": event, "fields": map[string]any{"index": float64(index)}}
}

// contract: log.batch.stores-page-events-in-order
func TestARelayedBatchIsStoredInOrderInTheLayerPage(t *testing.T) {
	log, err := host.StartEventLog(eventLogOptions(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	request := map[string]any{"action": "batch", "events": []any{relayEvent("page.test.first", 1), relayEvent("page.test.second", 2)}}
	if _, err := host.LogCommand(log, request); err != nil {
		t.Fatal(err)
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	events := readEventLog(t, log.Path())
	if len(events) != 3 || events[1]["event"] != "page.test.first" || events[2]["event"] != "page.test.second" ||
		events[1]["layer"] != "page" || events[2]["ts_us"] != float64(1_791_000_000_000_002) {
		t.Fatalf("events %v", events)
	}
}

// contract: log.batch.rejects-an-invalid-batch-without-writing
func TestAnInvalidRelayedBatchWritesNothingAndNamesTheEvent(t *testing.T) {
	log, err := host.StartEventLog(eventLogOptions(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]struct {
		request map[string]any
		message string
	}{
		"no action":      {map[string]any{"events": []any{}}, "action must be batch"},
		"another action": {map[string]any{"action": "line", "events": []any{}}, "action must be batch, not \"line\""},
		"no events":      {map[string]any{"action": "batch"}, "events must be an array"},
		"a layer other than page": {map[string]any{"action": "batch", "events": []any{relayEvent("page.test.ok", 1), relayEvent("host.test.forged", 2)}},
			"events[1]: the event \"host.test.forged\" does not start with page. or plugin."},
		"a level outside the contract": {map[string]any{"action": "batch", "events": []any{map[string]any{"ts_us": float64(1), "level": "loud", "event": "page.test.event", "fields": map[string]any{}}}},
			"events[0]: level must be one of error, warn, info, debug, trace"},
		"a time that is not a number": {map[string]any{"action": "batch", "events": []any{map[string]any{"ts_us": "now", "level": "info", "event": "page.test.event", "fields": map[string]any{}}}},
			"events[0]: ts_us must be a positive integer"},
		"fields that are not an object": {map[string]any{"action": "batch", "events": []any{map[string]any{"ts_us": float64(1), "level": "info", "event": "page.test.event", "fields": "text"}}},
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
	if events := readEventLog(t, log.Path()); len(events) != 1 {
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
	record := func(level, where, text string, index int) map[string]any {
		return map[string]any{"ts_us": float64(1_791_000_000_000_000 + index), "level": level, "event": "page.record." + level,
			"fields": map[string]any{"where": where, "text": text}}
	}
	request := map[string]any{"action": "batch", "events": []any{
		record("error", "surface probe", "mount failed\nsecond line", 1),
		relayEvent("page.trace.action", 2),
		record("info", "page", "ready", 3),
	}}
	lines, err := host.LogCommand(log, request)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"error page surface probe: mount failed\\nsecond line", "info page page: ready"}
	if len(lines) != len(want) || lines[0] != want[0] || lines[1] != want[1] {
		t.Fatalf("lines %q, want %q", lines, want)
	}
	// A record event whose fields are not the strings where and text is refused with the batch.
	bad := map[string]any{"action": "batch", "events": []any{map[string]any{"ts_us": float64(1), "level": "info", "event": "page.record.info", "fields": map[string]any{"where": 7}}}}
	if _, err := host.LogCommand(log, bad); err == nil || !strings.Contains(err.Error(), "events[0]: fields where and text must be strings") {
		t.Fatalf("error %v", err)
	}
}

// contract: log.batch.stores-plugin-events-in-the-layer-plugin
func TestARelayedBatchStoresAPluginEventInTheLayerPlugin(t *testing.T) {
	log, err := host.StartEventLog(eventLogOptions(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	request := map[string]any{"action": "batch", "events": []any{relayEvent("plugin.fixture.input", 1), relayEvent("page.console.error", 2)}}
	if _, err := host.LogCommand(log, request); err != nil {
		t.Fatal(err)
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	events := readEventLog(t, log.Path())
	if len(events) != 3 || events[1]["layer"] != "plugin" || events[1]["event"] != "plugin.fixture.input" || events[2]["layer"] != "page" {
		t.Fatalf("events %v", events)
	}
}
