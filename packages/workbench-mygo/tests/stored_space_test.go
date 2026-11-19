// The refusal of a stored space that holds the member parties, which belongs to no current form of a space object
// (docs/spec/projects.md#persistence).
package workbench_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// contract: workbench.space.parties-refused
func TestASpaceThatHoldsPartiesIsRefusedByName(t *testing.T) {
	project := storedProject(tab("tab-aaaaaa", "notes"))
	project["spaces"].([]map[string]any)[0]["parties"] = []any{}
	stored := &storedHost{projects: []map[string]any{project}}
	f := newShell(t, stored)
	f.shell.Registry().RunLater("core.project.activate", json.RawMessage(`{"id":"prj-a"}`), func(any, error) {})
	f.pending.drain(t)
	f.tester.Frame()
	want := "projects.json: project /a, space spc-aaaaaa: obsolete member parties"
	// The command shows the refusal through the one error path, which writes it to the log.
	if errors := stored.written("workbench.record.error"); len(errors) != 1 || !strings.Contains(fmt.Sprint(errors[0]), want) {
		t.Fatalf("the window recorded %v", errors)
	}
}
