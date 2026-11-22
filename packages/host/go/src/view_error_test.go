//go:build diagnostics

package host

import (
	"os"
	"testing"
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
		if err := log.Flush(); err != nil {
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

// contract: view.error.display
// A view.error message with a reason other than a queue overflow sends one view-stopped event to its surface, which names the surface,
// the plugin and the reason, so the workbench shows the failure of a page that failed before its first call (docs/spec/host-contract.md).
func TestViewErrorMessageSendsViewStoppedWithItsReason(t *testing.T) {
	s := registeredViewRecordSurfaces(t)
	events := recordWindowEvents(s)
	if err := s.ViewMessage("probe-surface", `{"message":{"event":"view.error","plugin":"probe","reason":"script soksak://probe/ui/view.js failed to load"}}`); err != nil {
		t.Fatalf("view.error message: %v, want the message accepted", err)
	}
	var stops []map[string]any
	for _, event := range *events {
		if event.name == "view-stopped" {
			stops = append(stops, event.data.(map[string]any))
		}
	}
	if len(stops) != 1 || stops[0]["surface"] != "probe-surface" || stops[0]["plugin"] != "probe" || stops[0]["reason"] != "script soksak://probe/ui/view.js failed to load" {
		t.Fatalf("view-stopped events %v, want one for surface probe-surface, plugin probe and the reason", stops)
	}
}

// contract: view.error.display
// A view.error message after the first call of the view writes its record and sends no view-stopped event, because the view continues
// and its surface keeps its state (docs/spec/native-surfaces.md#view-surfaces).
func TestViewErrorAfterACallSendsNoViewStopped(t *testing.T) {
	s := registeredViewRecordSurfaces(t)
	channel, ok := s.documents.view("probe-surface")
	if !ok {
		t.Fatal("the view channel of the probe surface is missing")
	}
	s.documents.trackViewCall("probe-surface", channel.generation, 1, "runtime.textSize.read")
	events := recordWindowEvents(s)
	if err := s.ViewMessage("probe-surface", `{"message":{"event":"view.error","plugin":"probe","reason":"uncaught error: boom"}}`); err != nil {
		t.Fatalf("view.error message: %v, want the message accepted", err)
	}
	for _, event := range *events {
		if event.name == "view-stopped" {
			t.Fatalf("view-stopped event %v after the first call, want none", event.data)
		}
	}
}
