package workbench_test

import (
	"testing"
)

// A status read that names a surface is recorded as workbench.status.read with the surface of the request, the surface that answers it
// and the owned session that the answering surface shows (docs/spec/events.json).
func TestASurfaceStatusReadIsRecordedWithItsSurfaceAndSession(t *testing.T) {
	stored := &surfaceHost{classes: traceClasses()}
	stored.installed = hiddenTabsDocument
	stored.common = map[string]any{"diagnostics.log": traceClasses()}
	shown := tab("tab-aaaaaa", "notes")
	shown["params"] = map[string]any{"session": "s7"}
	stored.projects = []map[string]any{storedProject(shown, tab("tab-bbbbbb", "notes"))}
	f := newTabApp(t, stored, hiddenTabsDocument)
	f.command("core.project.activate", map[string]string{"id": "prj-a"})
	f.ask("status.get", map[string]any{"name": "core.tab.role", "surface": "tab-aaaaaa"})
	f.ask("status.get", map[string]any{"name": "core.tab.role", "surface": "tab-bbbbbb"})
	recordOf := func(surface string) map[string]any {
		for _, event := range stored.written("workbench.status.read") {
			if fields := event["fields"].(map[string]any); fields["requested"] == surface {
				return fields
			}
		}
		return nil
	}
	f.queue.until(t, func() bool { return recordOf("tab-aaaaaa") != nil && recordOf("tab-bbbbbb") != nil })
	with, without := recordOf("tab-aaaaaa"), recordOf("tab-bbbbbb")
	if with["name"] != "core.tab.role" || with["resolved"] != "tab-aaaaaa" || with["session"] != "s7" || with["ok"] != true || with["code"] != nil {
		t.Fatalf("the status read with a session is recorded as %v", with)
	}
	if without["resolved"] != "tab-bbbbbb" || without["session"] != nil {
		t.Fatalf("the status read without a session is recorded as %v", without)
	}
}
