package host_test

import (
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/tests/support"
)

// contract: application.events.app-event-is-recorded
func TestAnApplicationEventIsRecordedAsAnEvent(t *testing.T) {
	config := t.TempDir()
	log := support.StartWriter(t, config)
	for _, kind := range []string{"started", "activated", "exit"} {
		host.RecordAppEvent(kind)
	}
	// A kind outside the contract is reported on the standard error and stores nothing.
	host.RecordAppEvent("teleport")
	// No framework of the hosts reports a reopen, so the kind is outside the contract too.
	host.RecordAppEvent("reopened")
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var seen []string
	for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		if event["event"] != "host.app.event" {
			continue
		}
		seen = append(seen, event["level"].(string)+" "+event["fields"].(map[string]any)["kind"].(string))
	}
	want := []string{"info started", "info activated", "info exit"}
	if len(seen) != len(want) {
		t.Fatalf("application events = %v, want %v", seen, want)
	}
	for i := range want {
		if seen[i] != want[i] {
			t.Fatalf("application events = %v, want %v", seen, want)
		}
	}
}
