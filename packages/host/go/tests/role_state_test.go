package host_test

// The role handshake state of a tab (docs/spec/agent-roles.md#tab-role-state and #confirmation): the stored record of
// projects.json, the role files of the surface, the generation, the idempotency, the per-surface serialization and the stale
// refusal, driven through the workspace store with real files. No agent CLI runs here.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// roleFixture is a configuration directory whose projects.json holds one project with one space of one card of two tabs, and
// whose roles.json defines the roles a and b.
func roleFixture(t *testing.T) (string, *host.Workspace, string) {
	t.Helper()
	config := t.TempDir()
	space := map[string]any{"id": "spc-aaaaaa", "title": "SPACE1", "layout": map[string]any{
		"state": map[string]any{"root": map[string]any{"card": "card-1", "data": map[string]any{"tabs": []any{
			map[string]any{"id": "tab-aaaaaa", "plugin": "terminal", "title": "a", "role": nil},
			map[string]any{"id": "tab-bbbbbb", "plugin": "terminal", "title": "b", "role": nil},
		}}}},
		"focusedId": "card-1", "leader": "card-1", "lastCard": 1, "named": 0,
	}}
	registry := map[string]any{"format": 4, "projects": []any{map[string]any{
		"id": "prj-aaaaaa", "root": filepath.Join(config, "work"), "identity": "6F1D2C3B-4A5B-4C6D-8E9F-0A1B2C3D4E5F:7", "spaces": []any{space}, "activeSpaceId": "spc-aaaaaa",
	}}}
	if err := os.Mkdir(filepath.Join(config, "work"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeRoleFixtureFile(t, config, "projects.json", registry)
	roles := map[string]any{"format": 3, "roles": map[string]any{
		"a": map[string]any{"text": "Role A definition.", "ko": "역할 A 정의.", "files": []any{}},
		"b": map[string]any{"text": "Role B definition.", "ko": "역할 B 정의.", "files": []any{}},
	}}
	writeRoleFixtureFile(t, config, "roles.json", roles)
	return config, host.NewWorkspace(config), filepath.Join(config, "work")
}

func writeRoleFixtureFile(t *testing.T, config, name string, value any) {
	t.Helper()
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(config, name), append(data, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
}

// roleAsk runs one role operation and returns its answer as decoded JSON.
func roleAsk(t *testing.T, w *host.Workspace, request host.WorkspaceRequest) any {
	t.Helper()
	result, err := w.Apply(request)
	if err != nil {
		t.Fatalf("%s returned error %v", request.Kind, err)
	}
	return jsonValue(t, result)
}

// roleRefusal runs one role operation and returns its error text.
func roleRefusal(t *testing.T, w *host.Workspace, request host.WorkspaceRequest) string {
	t.Helper()
	_, err := w.Apply(request)
	if err == nil {
		t.Fatalf("%s returned no error", request.Kind)
	}
	return err.Error()
}

// storedRole reads the member role of the tab id from projects.json.
func storedRole(t *testing.T, config, tab string) any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(config, "projects.json"))
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Projects []struct {
			Spaces []struct {
				Layout struct {
					State struct {
						Root struct {
							Data struct {
								Tabs []map[string]any `json:"tabs"`
							} `json:"data"`
						} `json:"root"`
					} `json:"state"`
				} `json:"layout"`
			} `json:"spaces"`
		} `json:"projects"`
	}
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	for _, project := range document.Projects {
		for _, space := range project.Spaces {
			for _, entry := range space.Layout.State.Root.Data.Tabs {
				if entry["id"] == tab {
					return entry["role"]
				}
			}
		}
	}
	t.Fatalf("projects.json holds no tab %s", tab)
	return nil
}

// contract: roles.role-state-handshake
func TestTheRoleHandshakeAnswersTheStatusAndStoresTheRecord(t *testing.T) {
	config, w, _ := roleFixture(t)
	// A tab without a role answers the null members.
	want := map[string]any{"role": nil, "generation": nil, "state": nil, "seq": 0, "fingerprint": nil, "path": nil}
	if got := roleAsk(t, w, host.WorkspaceRequest{Kind: "role", Tab: "tab-aaaaaa"}); !reflect.DeepEqual(got, jsonValue(t, want)) {
		t.Fatalf("the status is %v, want %v", got, want)
	}
	// The assignment writes the role files, stores the record and answers pending with the path.
	got := roleAsk(t, w, host.WorkspaceRequest{Kind: "rolePut", Tab: "tab-aaaaaa", Role: "a"})
	fingerprint := host.RoleFingerprint("a", "Role A definition.", nil)
	path := filepath.Join(config, "agents", "tab-aaaaaa", "role.md")
	want = map[string]any{"role": "a", "generation": 1, "state": "pending", "seq": 1, "fingerprint": fingerprint, "path": path}
	if !reflect.DeepEqual(got, jsonValue(t, want)) {
		t.Fatalf("the answer of the assignment is %v, want %v", got, want)
	}
	if held := storedRole(t, config, "tab-aaaaaa"); !reflect.DeepEqual(held, jsonValue(t, map[string]any{"id": "a", "generation": 1, "fingerprint": fingerprint, "confirmedFingerprint": nil})) {
		t.Fatalf("the stored record is %v", held)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("the role file is absent: %v", err)
	}
	// The confirmation of the current fingerprint stores the confirmation and gives ready.
	got = roleAsk(t, w, host.WorkspaceRequest{Kind: "roleConfirm", Tab: "tab-aaaaaa", Fingerprint: fingerprint})
	want["state"] = "ready"
	want["seq"] = 2
	if !reflect.DeepEqual(got, jsonValue(t, want)) {
		t.Fatalf("the answer of the confirmation is %v, want %v", got, want)
	}
}

// contract: roles.role-state-idempotency
func TestTheRepetitionsOfTheRoleHandshakeChangeNothing(t *testing.T) {
	config, w, _ := roleFixture(t)
	fingerprintA := host.RoleFingerprint("a", "Role A definition.", nil)
	fingerprintB := host.RoleFingerprint("b", "Role B definition.", nil)
	path := filepath.Join(config, "agents", "tab-aaaaaa", "role.md")
	roleAsk(t, w, host.WorkspaceRequest{Kind: "rolePut", Tab: "tab-aaaaaa", Role: "a"})
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	// A repeated assignment of the same role and definition writes no file: the inode and the content stay the same.
	again := roleAsk(t, w, host.WorkspaceRequest{Kind: "rolePut", Tab: "tab-aaaaaa", Role: "a"})
	if again.(map[string]any)["generation"] != 1.0 || again.(map[string]any)["seq"] != 1.0 {
		t.Fatalf("a repeated assignment answered %v", again)
	}
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(before, after) {
		t.Fatal("a repeated assignment wrote the role file again")
	}
	// A change to b and back to a returns the fingerprint of a, and a confirmation of it gives ready.
	roleAsk(t, w, host.WorkspaceRequest{Kind: "rolePut", Tab: "tab-aaaaaa", Role: "b"})
	changed := roleAsk(t, w, host.WorkspaceRequest{Kind: "rolePut", Tab: "tab-aaaaaa", Role: "a"})
	if changed.(map[string]any)["generation"] != 3.0 || changed.(map[string]any)["fingerprint"] != fingerprintA {
		t.Fatalf("the change back to a answered %v", changed)
	}
	ready := roleAsk(t, w, host.WorkspaceRequest{Kind: "roleConfirm", Tab: "tab-aaaaaa", Fingerprint: fingerprintA})
	// A repeated confirmation with the current fingerprint answers ready again and changes nothing, including seq.
	repeated := roleAsk(t, w, host.WorkspaceRequest{Kind: "roleConfirm", Tab: "tab-aaaaaa", Fingerprint: fingerprintA})
	if !reflect.DeepEqual(ready, repeated) {
		t.Fatalf("a repeated confirmation answered %v, want %v", repeated, ready)
	}
	// A confirmation of the earlier fingerprint of b is refused as stale, names the path and names no fingerprint.
	text := roleRefusal(t, w, host.WorkspaceRequest{Kind: "roleConfirm", Tab: "tab-aaaaaa", Fingerprint: fingerprintB})
	if text != "stale fingerprint: read the role file again at "+path {
		t.Fatalf("the stale confirmation answered %q", text)
	}
}

// contract: roles.role-state-invalid-input
func TestTheRoleHandshakeRefusesItsInvalidInputs(t *testing.T) {
	config, w, _ := roleFixture(t)
	// A role that roles.json does not define is refused, and the tab keeps its earlier role.
	roleAsk(t, w, host.WorkspaceRequest{Kind: "rolePut", Tab: "tab-aaaaaa", Role: "a"})
	if text := roleRefusal(t, w, host.WorkspaceRequest{Kind: "rolePut", Tab: "tab-aaaaaa", Role: "c"}); text != "unknown agent role c" {
		t.Fatalf("an unknown role answered %q", text)
	}
	if held := storedRole(t, config, "tab-aaaaaa"); held.(map[string]any)["id"] != "a" {
		t.Fatalf("the refused change changed the record to %v", held)
	}
	// A confirmation value of another form is refused before the stale rule.
	if text := roleRefusal(t, w, host.WorkspaceRequest{Kind: "roleConfirm", Tab: "tab-aaaaaa", Fingerprint: "ZZZ"}); text != "fingerprint ZZZ is not 16 lowercase hexadecimal characters" {
		t.Fatalf("an invalid fingerprint answered %q", text)
	}
	// A tab without a role and a tab that no stored layout holds.
	if text := roleRefusal(t, w, host.WorkspaceRequest{Kind: "roleConfirm", Tab: "tab-bbbbbb", Fingerprint: "0123456789abcdef"}); text != "tab tab-bbbbbb has no role" {
		t.Fatalf("a tab without a role answered %q", text)
	}
	if text := roleRefusal(t, w, host.WorkspaceRequest{Kind: "roleConfirm", Tab: "tab-zzzzzz", Fingerprint: "0123456789abcdef"}); text != `surface "tab-zzzzzz" has no tab` {
		t.Fatalf("an unknown tab answered %q", text)
	}
	if text := roleRefusal(t, w, host.WorkspaceRequest{Kind: "rolePut", Tab: "tab-zzzzzz", Role: "a"}); text != `surface "tab-zzzzzz" has no tab` {
		t.Fatalf("an assignment to an unknown tab answered %q", text)
	}
}

// contract: roles.role-state-clear-and-removal
func TestTheRoleHandshakeClearsAndEndsTheRoleOfARemovedTab(t *testing.T) {
	config, w, _ := roleFixture(t)
	roleAsk(t, w, host.WorkspaceRequest{Kind: "rolePut", Tab: "tab-aaaaaa", Role: "a"})
	// Setting the role to null clears the record and removes the role files.
	cleared := roleAsk(t, w, host.WorkspaceRequest{Kind: "rolePut", Tab: "tab-aaaaaa", Role: nil})
	want := map[string]any{"role": nil, "generation": nil, "state": nil, "seq": 2, "fingerprint": nil, "path": nil}
	if !reflect.DeepEqual(cleared, jsonValue(t, want)) {
		t.Fatalf("the clear answered %v, want %v", cleared, want)
	}
	if held := storedRole(t, config, "tab-aaaaaa"); held != nil {
		t.Fatalf("the clear left the record %v", held)
	}
	if _, err := os.Stat(filepath.Join(config, "agents", "tab-aaaaaa")); !os.IsNotExist(err) {
		t.Fatal("the clear left the folder of the role files")
	}
	// A removed tab refuses a later change and confirmation.
	roleAsk(t, w, host.WorkspaceRequest{Kind: "rolePut", Tab: "tab-bbbbbb", Role: "a"})
	if _, err := w.Apply(host.WorkspaceRequest{Kind: "roleRemove", Tab: "tab-bbbbbb"}); err != nil {
		t.Fatal(err)
	}
	if text := roleRefusal(t, w, host.WorkspaceRequest{Kind: "rolePut", Tab: "tab-bbbbbb", Role: "b"}); text != "tab tab-bbbbbb was removed; its role cannot change" {
		t.Fatalf("a change of a removed tab answered %q", text)
	}
	if text := roleRefusal(t, w, host.WorkspaceRequest{Kind: "roleConfirm", Tab: "tab-bbbbbb", Fingerprint: "0123456789abcdef"}); text != "tab tab-bbbbbb has no role" {
		t.Fatalf("a confirmation of a removed tab answered %q", text)
	}
}

// contract: roles.role-state-restart
func TestTheRoleHandshakeIsRebuiltFromTheStoredRecordAfterARestart(t *testing.T) {
	config, w, _ := roleFixture(t)
	fingerprint := host.RoleFingerprint("a", "Role A definition.", nil)
	roleAsk(t, w, host.WorkspaceRequest{Kind: "rolePut", Tab: "tab-aaaaaa", Role: "a"})
	// A restart without a stored confirmation answers pending; the seq of a new session starts at zero.
	restarted := host.NewWorkspace(config)
	pending := roleAsk(t, restarted, host.WorkspaceRequest{Kind: "role", Tab: "tab-aaaaaa"})
	want := map[string]any{"role": "a", "generation": 1, "state": "pending", "seq": 0, "fingerprint": fingerprint,
		"path": filepath.Join(config, "agents", "tab-aaaaaa", "role.md")}
	if !reflect.DeepEqual(pending, jsonValue(t, want)) {
		t.Fatalf("the restarted status is %v, want %v", pending, want)
	}
	// A restart with a stored confirmation answers ready without input.
	roleAsk(t, w, host.WorkspaceRequest{Kind: "roleConfirm", Tab: "tab-aaaaaa", Fingerprint: fingerprint})
	ready := roleAsk(t, host.NewWorkspace(config), host.WorkspaceRequest{Kind: "role", Tab: "tab-aaaaaa"})
	want["state"] = "ready"
	if !reflect.DeepEqual(ready, jsonValue(t, want)) {
		t.Fatalf("the restarted confirmed status is %v, want %v", ready, want)
	}
}

// contract: roles.role-state-write-failures
func TestTheOrderedChangeFailsAtItsStepsAndKeepsTheEarlierState(t *testing.T) {
	// Step 1: the folder of the surface is a file, so the temporary write fails and nothing is stored.
	config, w, _ := roleFixture(t)
	if err := os.WriteFile(filepath.Join(config, "agents"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	text := roleRefusal(t, w, host.WorkspaceRequest{Kind: "rolePut", Tab: "tab-aaaaaa", Role: "a"})
	if !strings.HasPrefix(text, "role file "+filepath.Join(config, "agents", "tab-aaaaaa")+": write failed: ") {
		t.Fatalf("the failed step 1 answered %q", text)
	}
	if held := storedRole(t, config, "tab-aaaaaa"); held != nil {
		t.Fatalf("the failed step 1 stored the record %v", held)
	}

	// Step 2: a read-only configuration directory fails the store of projects.json; the temporary file is removed and the
	// stored role keeps its earlier value.
	config, w, _ = roleFixture(t)
	roleAsk(t, w, host.WorkspaceRequest{Kind: "rolePut", Tab: "tab-aaaaaa", Role: "a"})
	if err := os.Chmod(config, 0o500); err != nil {
		t.Fatal(err)
	}
	text = roleRefusal(t, w, host.WorkspaceRequest{Kind: "rolePut", Tab: "tab-aaaaaa", Role: "b"})
	if !strings.HasPrefix(text, "role file "+filepath.Join(config, "projects.json")+": write failed: ") {
		t.Fatalf("the failed step 2 answered %q", text)
	}
	if err := os.Chmod(config, 0o700); err != nil {
		t.Fatal(err)
	}
	if held := storedRole(t, config, "tab-aaaaaa"); held.(map[string]any)["id"] != "a" {
		t.Fatalf("the failed step 2 left the record %v", held)
	}
	leftovers, err := filepath.Glob(filepath.Join(config, "agents", "tab-aaaaaa", ".role-*.tmp"))
	if err != nil {
		t.Fatal(err)
	}
	if len(leftovers) != 0 {
		t.Fatalf("the failed step 2 left the temporary files %v", leftovers)
	}

	// Step 3: a directory in the place of role.ko.md fails its rename; the earlier record is restored.
	config, w, _ = roleFixture(t)
	roleAsk(t, w, host.WorkspaceRequest{Kind: "rolePut", Tab: "tab-aaaaaa", Role: "a"})
	if err := os.Remove(filepath.Join(config, "agents", "tab-aaaaaa", "role.ko.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(config, "agents", "tab-aaaaaa", "role.ko.md"), 0o700); err != nil {
		t.Fatal(err)
	}
	text = roleRefusal(t, w, host.WorkspaceRequest{Kind: "rolePut", Tab: "tab-aaaaaa", Role: "b"})
	if !strings.HasPrefix(text, "role file "+filepath.Join(config, "agents", "tab-aaaaaa", "role.ko.md")+": rename failed: ") {
		t.Fatalf("the failed step 3 answered %q", text)
	}
	if held := storedRole(t, config, "tab-aaaaaa"); held.(map[string]any)["id"] != "a" {
		t.Fatalf("the failed step 3 left the record %v", held)
	}
}

// contract: roles.role-state-serialization
func TestTheRoleOperationsOfOneSurfaceRunInArrivalOrder(t *testing.T) {
	_, w, _ := roleFixture(t)
	fingerprintA := host.RoleFingerprint("a", "Role A definition.", nil)
	fingerprintB := host.RoleFingerprint("b", "Role B definition.", nil)
	// Consecutive changes a to b to a raise the generation at each change, and the last file holds the latest role.
	first := roleAsk(t, w, host.WorkspaceRequest{Kind: "rolePut", Tab: "tab-aaaaaa", Role: "a"})
	second := roleAsk(t, w, host.WorkspaceRequest{Kind: "rolePut", Tab: "tab-aaaaaa", Role: "b"})
	third := roleAsk(t, w, host.WorkspaceRequest{Kind: "rolePut", Tab: "tab-aaaaaa", Role: "a"})
	for i, answer := range []map[string]any{first.(map[string]any), second.(map[string]any), third.(map[string]any)} {
		if answer["generation"] != float64(i+1) {
			t.Fatalf("the change %d answered the generation %v", i+1, answer["generation"])
		}
	}
	// A confirmation of the earlier fingerprint of the first a is refused as stale; the confirmation of the current one is
	// accepted, whatever the order, because each is judged against the state at its turn.
	if text := roleRefusal(t, w, host.WorkspaceRequest{Kind: "roleConfirm", Tab: "tab-aaaaaa", Fingerprint: fingerprintB}); !strings.HasPrefix(text, "stale fingerprint: read the role file again at ") {
		t.Fatalf("an interleaved confirmation answered %q", text)
	}
	// The change back to a returned the fingerprint of a, so a confirmation of it is correct, not stale.
	ready := roleAsk(t, w, host.WorkspaceRequest{Kind: "roleConfirm", Tab: "tab-aaaaaa", Fingerprint: fingerprintA})
	if ready.(map[string]any)["state"] != "ready" {
		t.Fatalf("the confirmation of the current fingerprint answered %v", ready)
	}
}
