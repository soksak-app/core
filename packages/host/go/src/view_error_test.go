//go:build diagnostics

package host

import (
	"os"
	"testing"
	"time"
)

// contract: view.error.display
// A view.error message of a view is written once on the error display path with the plugin and surface of the view
// (docs/spec/native-surfaces.md#view-surfaces), and the message is accepted: a page that fails before its first call reports it.
func TestViewErrorMessageIsWrittenOnTheErrorDisplayPathWithItsView(t *testing.T) {
	if config := os.Getenv(viewRecordChild); config != "" {
		log := startViewRecordWriter(t, config)
		s := registeredViewRecordSurfaces(t)
		if err := s.ViewMessage("probe-surface", `{"message":{"event":"view.error","plugin":"probe","reason":"uncaught error: boom"}}`); err != nil {
			t.Fatalf("view.error message: %v, want the message accepted and written as a record", err)
		}
		if err := log.Flush(5 * time.Second); err != nil {
			t.Fatal(err)
		}
		return
	}
	config := t.TempDir()
	runViewRecordChild(t, config, "TestViewErrorMessageIsWrittenOnTheErrorDisplayPathWithItsView")
	var errors []map[string]any
	for _, event := range viewRecordEvents(t, config) {
		if event["event"] == "host.record.error" {
			errors = append(errors, event["fields"].(map[string]any))
		}
	}
	if len(errors) != 1 || errors[0]["where"] != "view probe probe-surface" || errors[0]["text"] != "uncaught error: boom" {
		t.Fatalf("host.record.error records: %v, want exactly one with where %q and text %q", errors, "view probe probe-surface", "uncaught error: boom")
	}
}
