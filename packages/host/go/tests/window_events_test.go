package host_test

import (
	"reflect"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/support"
)

// contract: windows.events.window-event-is-recorded
func TestAWindowEventIsRecordedAsAnEvent(t *testing.T) {
	config := t.TempDir()
	log := support.StartWriter(t, config)
	host.RecordWindowResize("main-2", 1440, 900, true)
	// The content of a window that closed is gone, so its resize records no size.
	host.RecordWindowResize("main-2", 0, 0, false)
	for _, kind := range []string{"focus", "window-active", "closed"} {
		host.RecordWindowEvent("main-2", kind)
	}
	// A kind outside the contract is reported on the standard error and stores nothing, and so is a resize without its size.
	host.RecordWindowEvent("main-2", "teleport")
	host.RecordWindowEvent("main-2", "resize")
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	var seen []map[string]any
	for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		if event["event"] != "host.window.event" {
			continue
		}
		seen = append(seen, map[string]any{"level": event["level"], "fields": event["fields"]})
	}
	want := []map[string]any{
		{"level": "debug", "fields": map[string]any{"window": "main-2", "kind": "resize", "width": float64(1440), "height": float64(900)}},
		{"level": "debug", "fields": map[string]any{"window": "main-2", "kind": "resize", "width": nil, "height": nil}},
		{"level": "info", "fields": map[string]any{"window": "main-2", "kind": "focus"}},
		{"level": "info", "fields": map[string]any{"window": "main-2", "kind": "window-active"}},
		{"level": "info", "fields": map[string]any{"window": "main-2", "kind": "closed"}},
	}
	if !reflect.DeepEqual(seen, want) {
		t.Fatalf("window events = %v, want %v", seen, want)
	}
}
