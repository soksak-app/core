package host_test

import (
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/support"
)

// contract: project.open.front-is-recorded
func TestAProjectFrontIsRecordedAsAnEvent(t *testing.T) {
	config := t.TempDir()
	log := support.StartWriter(t, config)
	active := false
	host.RecordProjectFront("main", "prj-one", true, &active)
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	var seen []map[string]any
	for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		if event["event"] == "host.project.front" {
			seen = append(seen, event)
		}
	}
	if len(seen) != 1 {
		t.Fatalf("host.project.front events = %v, want one", seen)
	}
	if seen[0]["level"] != "info" {
		t.Fatalf("host.project.front level = %v, want info", seen[0]["level"])
	}
	fields := seen[0]["fields"].(map[string]any)
	if fields["window"] != "main" || fields["project"] != "prj-one" || fields["key"] != true || fields["app_active"] != false {
		t.Fatalf("host.project.front fields = %v, want window main, project prj-one, key true, app_active false", fields)
	}
}
