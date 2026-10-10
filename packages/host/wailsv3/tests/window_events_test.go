package host_test

import (
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/tests/support"
)

// contract: windows.events.window-event-is-recorded
func TestAWindowEventIsRecordedAsAnEvent(t *testing.T) {
	config := t.TempDir()
	log := support.StartWriter(t, config)
	for _, kind := range []string{"resize", "focus", "closed"} {
		host.RecordWindowEvent("main-2", kind)
	}
	// A kind outside the contract is reported on the standard error and stores nothing.
	host.RecordWindowEvent("main-2", "teleport")
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var seen [][3]string
	for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		if event["event"] != "host.window.event" {
			continue
		}
		fields := event["fields"].(map[string]any)
		seen = append(seen, [3]string{event["level"].(string), fields["window"].(string), fields["kind"].(string)})
	}
	want := [][3]string{{"debug", "main-2", "resize"}, {"info", "main-2", "focus"}, {"info", "main-2", "closed"}}
	if len(seen) != len(want) {
		t.Fatalf("window events = %v, want %v", seen, want)
	}
	for i := range want {
		if seen[i] != want[i] {
			t.Fatalf("window events = %v, want %v", seen, want)
		}
	}
}
