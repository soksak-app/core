package host_test

import (
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/tests/support"
)

// contract: view.error.display
// A view.error message of a view is written once on the error display path with the plugin and surface of the view
// (docs/spec/native-surfaces.md#view-surfaces), and the message is accepted: a page that fails before its first call reports it.
func TestViewErrorMessageIsWrittenOnTheErrorDisplayPathWithItsView(t *testing.T) {
	config := t.TempDir()
	log := support.StartWriter(t, config)
	s := host.NewSurfaces(nil, nil)
	s.RegisterView("probe-surface", "probe")
	if err := s.ViewMessage("probe-surface", `{"message":{"event":"view.error","plugin":"probe","reason":"uncaught error: boom"}}`); err != nil {
		t.Fatalf("view.error message: %v, want the message accepted and written as a record", err)
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	// Records that other tests of this process buffered before the writer started are in the same file, so the check selects
	// the record of this view by its place.
	var found []map[string]any
	for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		if event["event"] == "host.record.error" {
			fields := event["fields"].(map[string]any)
			if fields["where"] == "view probe probe-surface" {
				found = append(found, fields)
			}
		}
	}
	if len(found) != 1 || found[0]["text"] != "uncaught error: boom" {
		t.Fatalf("host.record.error records of the view: %v, want one with text %q", found, "uncaught error: boom")
	}
}
