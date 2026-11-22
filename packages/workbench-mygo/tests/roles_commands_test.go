package workbench_test

import (
	"encoding/json"
	"testing"
)

// The role commands run through the workspace store of the host, and the status core.roles follows the stored definitions
// (docs/spec/agent-roles.md#commands, docs/spec/agent-roles.md#role-status).

// runRole runs a role command and waits for its answer.
func runRole(t *testing.T, f *tabShell, name, params string) (any, error) {
	t.Helper()
	var value any
	var failure error
	f.shell.Registry().RunLater(name, json.RawMessage(params), func(answer any, err error) { value, failure = answer, err })
	f.settle()
	return value, failure
}

// The define command answers the stored definition {id, text, ko, files} and the host holds it.
func TestTheRoleDefineCommandStoresTheDefinitionThroughTheHost(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	value, err := runRole(t, f, "core.role.define", `{"id":"reviewer","text":"Review the changes.","ko":"변경을 검토한다.","files":[]}`)
	if err != nil {
		t.Fatalf("the define answered %v", err)
	}
	answer, _ := value.(map[string]any)
	if answer["id"] != "reviewer" || answer["text"] != "Review the changes." || answer["ko"] != "변경을 검토한다." {
		t.Fatalf("the define answered %v", value)
	}
	if held := f.host.roles["reviewer"]; held == nil || held["text"] != "Review the changes." {
		t.Fatalf("the host holds %v", f.host.roles)
	}
}

// The remove command removes the definition through the host and answers true.
func TestTheRoleRemoveCommandRemovesTheDefinitionThroughTheHost(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	if _, err := runRole(t, f, "core.role.define", `{"id":"reviewer","text":"Review.","ko":"검토한다.","files":[]}`); err != nil {
		t.Fatal(err)
	}
	value, err := runRole(t, f, "core.role.remove", `{"id":"reviewer"}`)
	if err != nil || value != true {
		t.Fatalf("the remove answered %v, %v", value, err)
	}
	if _, held := f.host.roles["reviewer"]; held {
		t.Fatal("the host still holds the removed role")
	}
}

// jsonText is the JSON text of a value, so that the comparison reads the value as a person would.
func jsonText(value any) string {
	data, _ := json.Marshal(value)
	return string(data)
}

// The status core.roles reads the host when the stored workspace changed, so it holds the definitions in identifier order with
// the sequence of the host.
func TestTheRolesStatusFollowsTheStoredDefinitionsAtEachChange(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	read := func() map[string]any {
		t.Helper()
		var held any
		done := make(chan error, 1)
		f.shell.Registry().Reply("status.get", json.RawMessage(`{"name":"core.roles"}`), nil, func(value any, err error) {
			held = value
			done <- err
		})
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		answer, _ := held.(map[string]any)
		return answer
	}
	if got := jsonText(read()); got != `{"roles":[],"seq":0}` {
		t.Fatalf("the status before any definition is %s", got)
	}
	f.host.roles = map[string]map[string]any{"writer": {"text": "Write.", "ko": "쓴다.", "files": []any{}}}
	f.host.rolesSeq = 1
	f.shell.Event("workspace-changed", nil)
	f.settle()
	if got := jsonText(read()); got != `{"roles":[{"files":[],"id":"writer","ko":"쓴다.","text":"Write."}],"seq":1}` {
		t.Fatalf("the status after the change is %s", got)
	}
}
