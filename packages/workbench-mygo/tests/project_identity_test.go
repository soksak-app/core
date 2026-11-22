// The refusal of a stored project whose directory identity differs from the identity of its folder (docs/spec/projects.md#project-identity).
package workbench_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestAProjectWhoseDirectoryIdentityChangedIsRefusedByItsRoot(t *testing.T) {
	project := storedProject(tab("tab-aaaaaa", "notes"))
	project["identity"] = "identity of /moved"
	stored := &storedHost{projects: []map[string]any{project}}
	f := newShell(t, stored)
	f.shell.Registry().RunLater("core.project.activate", json.RawMessage(`{"id":"prj-a"}`), func(any, error) {})
	f.pending.drain(t)
	f.tester.Frame()
	want := "Project directory has changed: /a"
	// The command shows the refusal through the one error path, which writes it to the log.
	if errors := stored.written("workbench.record.error"); len(errors) != 1 || !strings.Contains(fmt.Sprint(errors[0]), want) {
		t.Fatalf("the window recorded %v", errors)
	}
}
