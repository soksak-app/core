// The refusal of a stored project whose identity has the earlier form (docs/spec/projects.md#project-identity).
package workbench_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestAProjectWithTheEarlierIdentityFormIsRefusedByName(t *testing.T) {
	project := storedProject(tab("tab-aaaaaa", "notes"))
	project["identity"] = "1:1"
	stored := &storedHost{projects: []map[string]any{project}}
	f := newShell(t, stored)
	f.shell.Registry().RunLater("core.project.activate", json.RawMessage(`{"id":"prj-a"}`), func(any, error) {})
	f.pending.drain(t)
	f.tester.Frame()
	want := "projects.json: project /a stores the identity 1:1 of the earlier form <device>:<inode>; the identity is <volume UUID>:<inode>, so add the project again"
	// The command shows the refusal through the one error path, which writes it to the log.
	if errors := stored.written("workbench.record.error"); len(errors) != 1 || !strings.Contains(fmt.Sprint(errors[0]), want) {
		t.Fatalf("the window recorded %v", errors)
	}
}
