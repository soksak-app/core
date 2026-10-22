package host_test

import (
	"os"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/tests/support"
)

// contract: view.call.record
// The host records a call request of a view and its reply at the debug level, with the plugin, the surface and the id, so a call
// without its reply record is unanswered (docs/spec/native-surfaces.md#view-surfaces).
func TestViewCallAndReplyAreRecordedAtDebugWithTheirIdentifier(t *testing.T) {
	if config := os.Getenv(viewRecordChild); config != "" {
		log := support.StartWriter(t, config)
		s := host.NewSurfaces(nil, nil)
		s.RegisterView("probe-surface", "probe")
		if err := s.ViewMessage("probe-surface", `{"message":{"sok":1,"id":7,"command":"probe.run","params":{"a":1}}}`); err != nil {
			t.Fatalf("view call: %v", err)
		}
		if err := s.ViewMessage("probe-surface", `{"message":{"sok":1,"reply":7,"result":{"ok":true}}}`); err != nil {
			t.Fatalf("view reply: %v", err)
		}
		if err := log.Flush(5 * time.Second); err != nil {
			t.Fatal(err)
		}
		return
	}
	config := runViewRecordChild(t, "TestViewCallAndReplyAreRecordedAtDebugWithTheirIdentifier")
	var calls, replies []map[string]any
	for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		switch event["event"] {
		case "host.view.call":
			calls = append(calls, event)
		case "host.view.reply":
			replies = append(replies, event)
		}
	}
	if len(calls) != 1 || calls[0]["level"] != "debug" || calls[0]["fields"].(map[string]any)["command"] != "probe.run" ||
		calls[0]["fields"].(map[string]any)["id"] != float64(7) || calls[0]["fields"].(map[string]any)["plugin"] != "probe" {
		t.Fatalf("host.view.call records: %v, want exactly one debug record of plugin probe, id 7 and command probe.run", calls)
	}
	if len(replies) != 1 || replies[0]["level"] != "debug" || replies[0]["fields"].(map[string]any)["outcome"] != "result" ||
		replies[0]["fields"].(map[string]any)["id"] != float64(7) {
		t.Fatalf("host.view.reply records: %v, want exactly one debug record of id 7 with outcome result", replies)
	}
}
