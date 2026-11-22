package host_test

// The commands core.role.define and core.role.remove and the status core.roles, driven through the workspace store with real
// files (docs/spec/agent-roles.md#commands and #role-status). No agent CLI runs here.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// defineEntry is the definition that core.role.define receives, as the request carries it.
func defineEntry(text, ko string, files ...string) host.Record {
	list := []any{}
	for _, file := range files {
		list = append(list, file)
	}
	return host.Record{"text": text, "ko": ko, "files": list}
}

// seqOf returns the seq member of the status core.roles answer.
func seqOf(t *testing.T, answer any) float64 {
	t.Helper()
	seq, ok := answer.(map[string]any)["seq"].(float64)
	if !ok {
		t.Fatalf("status has no seq: %v", answer)
	}
	return seq
}

// readFileOrFatal returns the content of path.
func readFileOrFatal(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// contract: roles.define-writes-roles-first
func TestRoleDefineWritesRolesAndPublishesTheStatus(t *testing.T) {
	config, w, _ := roleFixture(t)
	checklist := filepath.Join(config, "checklist.md")
	if err := os.WriteFile(checklist, []byte("list\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	answer := roleAsk(t, w, host.WorkspaceRequest{Kind: "roleDefine", ID: "c", Entry: defineEntry("Check.", "점검한다.", checklist)})
	want := map[string]any{"id": "c", "text": "Check.", "ko": "점검한다.", "files": []any{checklist}}
	if !reflect.DeepEqual(answer, want) {
		t.Fatalf("define answered %v, want %v", answer, want)
	}
	var written map[string]any
	if err := json.Unmarshal(readFileOrFatal(t, filepath.Join(config, "roles.json")), &written); err != nil {
		t.Fatal(err)
	}
	if written["format"] != float64(3) || written["roles"].(map[string]any)["c"] == nil {
		t.Fatalf("roles.json holds %v, want format 3 with role c", written)
	}
	status := roleAsk(t, w, host.WorkspaceRequest{Kind: "rolesStatus"})
	if seq := seqOf(t, status); seq != 1 {
		t.Fatalf("status seq is %v after one change, want 1", seq)
	}
	roles := status.(map[string]any)["roles"].([]any)
	if len(roles) != 3 || roles[2].(map[string]any)["id"] != "c" {
		t.Fatalf("status lists %v, want the roles a, b and c in identifier order", roles)
	}
}

// contract: roles.define-same-definition-writes-nothing
func TestRoleDefineOfTheSameDefinitionWritesNothing(t *testing.T) {
	config, w, _ := roleFixture(t)
	checklist := filepath.Join(config, "checklist.md")
	if err := os.WriteFile(checklist, []byte("list\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	roleAsk(t, w, host.WorkspaceRequest{Kind: "roleDefine", ID: "c", Entry: defineEntry("Check.", "점검한다.", checklist)})
	before := readFileOrFatal(t, filepath.Join(config, "roles.json"))
	roleAsk(t, w, host.WorkspaceRequest{Kind: "roleDefine", ID: "c", Entry: defineEntry("Check.", "점검한다.", checklist)})
	if after := readFileOrFatal(t, filepath.Join(config, "roles.json")); string(after) != string(before) {
		t.Fatal("a define of the stored definition rewrote roles.json")
	}
	if seq := seqOf(t, roleAsk(t, w, host.WorkspaceRequest{Kind: "rolesStatus"})); seq != 1 {
		t.Fatalf("status seq is %v, want 1: the repeated define changed nothing", seq)
	}
}

// contract: roles.define-refuses-paths
func TestRoleDefineRefusesPathsAndWritesNothing(t *testing.T) {
	config, w, _ := roleFixture(t)
	before := readFileOrFatal(t, filepath.Join(config, "roles.json"))
	missing := filepath.Join(config, "missing.md")
	cases := map[string]string{
		"checklist.md": "role c: file checklist.md is not absolute",
		"/x\ty":        "role c: file /x\ty holds a control character",
		missing:        "role c: file " + missing + " does not exist",
	}
	for file, want := range cases {
		got := roleRefusal(t, w, host.WorkspaceRequest{Kind: "roleDefine", ID: "c", Entry: defineEntry("Check.", "점검한다.", file)})
		if got != want {
			t.Fatalf("define refused %q with %q, want %q", file, got, want)
		}
	}
	if after := readFileOrFatal(t, filepath.Join(config, "roles.json")); string(after) != string(before) {
		t.Fatal("a refused define changed roles.json")
	}
	if seq := seqOf(t, roleAsk(t, w, host.WorkspaceRequest{Kind: "rolesStatus"})); seq != 0 {
		t.Fatalf("a refused define changed the status seq to %v", seq)
	}
}

func TestRoleDefineChangesEachTabThatHoldsTheRole(t *testing.T) {
	_, w, _ := roleFixture(t)
	roleAsk(t, w, host.WorkspaceRequest{Kind: "rolePut", Tab: "tab-aaaaaa", Role: "a"})
	answer := roleAsk(t, w, host.WorkspaceRequest{Kind: "roleDefine", ID: "a", Entry: defineEntry("Role A changed.", "역할 A 변경.")})
	if answer.(map[string]any)["text"] != "Role A changed." {
		t.Fatalf("define answered %v", answer)
	}
	// The tab that holds the role takes the new definition as a new generation; the other tab holds no role and is unchanged.
	role := roleAsk(t, w, host.WorkspaceRequest{Kind: "role", Tab: "tab-aaaaaa"}).(map[string]any)
	if role["generation"] != float64(2) || role["state"] != "pending" || role["fingerprint"] != host.RoleFingerprint("a", "Role A changed.", nil) {
		t.Fatalf("tab-aaaaaa holds %v, want generation 2 pending with the new fingerprint", role)
	}
	if other := roleAsk(t, w, host.WorkspaceRequest{Kind: "role", Tab: "tab-bbbbbb"}).(map[string]any); other["role"] != nil {
		t.Fatalf("tab-bbbbbb holds %v, want no role", other)
	}
}

// contract: roles.remove-refusals
func TestRoleRemoveRefusesUndefinedAndUsedRoles(t *testing.T) {
	config, w, _ := roleFixture(t)
	if got := roleRefusal(t, w, host.WorkspaceRequest{Kind: "roleDefinitionRemove", ID: "z"}); got != "role z is not defined" {
		t.Fatalf("remove of an undefined role refused with %q", got)
	}
	roleAsk(t, w, host.WorkspaceRequest{Kind: "rolePut", Tab: "tab-bbbbbb", Role: "b"})
	before := readFileOrFatal(t, filepath.Join(config, "roles.json"))
	if got := roleRefusal(t, w, host.WorkspaceRequest{Kind: "roleDefinitionRemove", ID: "b"}); got != "role b is used by tab tab-bbbbbb" {
		t.Fatalf("remove of a used role refused with %q", got)
	}
	if after := readFileOrFatal(t, filepath.Join(config, "roles.json")); string(after) != string(before) {
		t.Fatal("a refused remove changed roles.json")
	}
}

// contract: roles.remove-unused-publishes-roles
func TestRoleRemoveOfAnUnusedRoleWritesRolesAndPublishesTheStatus(t *testing.T) {
	config, w, _ := roleFixture(t)
	if answer := roleAsk(t, w, host.WorkspaceRequest{Kind: "roleDefinitionRemove", ID: "b"}); answer != true {
		t.Fatalf("remove answered %v, want true", answer)
	}
	var written map[string]any
	if err := json.Unmarshal(readFileOrFatal(t, filepath.Join(config, "roles.json")), &written); err != nil {
		t.Fatal(err)
	}
	if _, has := written["roles"].(map[string]any)["b"]; has {
		t.Fatalf("roles.json still holds role b: %v", written)
	}
	if seq := seqOf(t, roleAsk(t, w, host.WorkspaceRequest{Kind: "rolesStatus"})); seq != 1 {
		t.Fatalf("status seq is %v after one removal, want 1", seq)
	}
}

// contract: roles.roles-status
func TestRolesStatusStartsAtZeroInANewSession(t *testing.T) {
	config, w, _ := roleFixture(t)
	roleAsk(t, w, host.WorkspaceRequest{Kind: "roleDefinitionRemove", ID: "b"})
	if seq := seqOf(t, roleAsk(t, host.NewWorkspace(config), host.WorkspaceRequest{Kind: "rolesStatus"})); seq != 0 {
		t.Fatalf("a new session starts the status seq at %v, want 0", seq)
	}
}

// contract: roles.define-repairs-failed-tab
func TestRoleDefineRewritesOnlyTheTabWhoseRecordDiffers(t *testing.T) {
	config, w, _ := roleFixture(t)
	roleAsk(t, w, host.WorkspaceRequest{Kind: "rolePut", Tab: "tab-aaaaaa", Role: "a"})
	// roles.json holds the new definition while tab-aaaaaa keeps the record of the earlier one, as a define leaves it when the
	// write of that tab fails.
	writeRoleFixtureFile(t, config, "roles.json", map[string]any{"format": 3, "roles": map[string]any{
		"a": map[string]any{"text": "Role A changed.", "ko": "역할 A 변경.", "files": []any{}},
		"b": map[string]any{"text": "Role B definition.", "ko": "역할 B 정의.", "files": []any{}},
	}})
	roleAsk(t, w, host.WorkspaceRequest{Kind: "rolePut", Tab: "tab-bbbbbb", Role: "a"})
	// The define of the stored definition writes nothing, and repairs tab-aaaaaa only.
	roleAsk(t, w, host.WorkspaceRequest{Kind: "roleDefine", ID: "a", Entry: defineEntry("Role A changed.", "역할 A 변경.")})
	if seq := seqOf(t, roleAsk(t, w, host.WorkspaceRequest{Kind: "rolesStatus"})); seq != 0 {
		t.Fatalf("status seq is %v, want 0: roles.json was not written", seq)
	}
	repaired := roleAsk(t, w, host.WorkspaceRequest{Kind: "role", Tab: "tab-aaaaaa"}).(map[string]any)
	if repaired["generation"] != float64(2) || repaired["fingerprint"] != host.RoleFingerprint("a", "Role A changed.", nil) {
		t.Fatalf("tab-aaaaaa holds %v, want generation 2 with the new fingerprint", repaired)
	}
	unchanged := roleAsk(t, w, host.WorkspaceRequest{Kind: "role", Tab: "tab-bbbbbb"}).(map[string]any)
	if unchanged["generation"] != float64(1) {
		t.Fatalf("tab-bbbbbb holds %v, want generation 1: its record already had the fingerprint", unchanged)
	}
}
