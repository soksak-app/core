package host_test

// Replays the shared roles.json cases (docs/spec/cases/agent-roles/roles.json) against the workspace store of the Go host. The store
// is the one that the mygo host uses too. Each read case writes its stored value to roles.json, reads it through the request roles,
// and compares the result or the error text with the case; each write case writes its roles through the request rolesPut.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
)

type rolesCase struct {
	Name   string          `json:"name"`
	Stored json.RawMessage `json:"stored"`
	Result any             `json:"result"`
	Error  string          `json:"error"`
	Roles  map[string]any  `json:"roles"`
	File   any             `json:"file"`
}

type rolesCases struct {
	Reads  []rolesCase `json:"reads"`
	Writes []rolesCase `json:"writes"`
}

const rolesCasesPath = "../../../../docs/spec/cases/agent-roles/roles.json"

func loadRolesCases(t *testing.T) rolesCases {
	t.Helper()
	data, err := os.ReadFile(rolesCasesPath)
	if err != nil {
		t.Fatal(err)
	}
	var cases rolesCases
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	return cases
}

// jsonValue returns the decoded form of value, so that a value of the store and a value of a case compare equal.
func jsonValue(t *testing.T, value any) any {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var decoded any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	return decoded
}

// contract: roles.reads-shared-cases
func TestRolesReadCasesMatchSharedFile(t *testing.T) {
	for _, c := range loadRolesCases(t).Reads {
		t.Run(c.Name, func(t *testing.T) {
			config := t.TempDir()
			path := filepath.Join(config, "roles.json")
			if c.Stored != nil {
				if err := os.WriteFile(path, c.Stored, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			result, err := host.NewWorkspace(config).Apply(host.WorkspaceRequest{Kind: "roles"})
			if c.Error != "" {
				want := strings.ReplaceAll(c.Error, "<file>", path)
				if err == nil || err.Error() != want {
					t.Fatalf("roles returned %v, want error %q", err, want)
				}
				return
			}
			if err != nil {
				t.Fatalf("roles returned error %v, want %v", err, c.Result)
			}
			if got := jsonValue(t, result); !reflect.DeepEqual(got, jsonValue(t, c.Result)) {
				t.Fatalf("roles returned %v, want %v", got, c.Result)
			}
		})
	}
}

// contract: roles.writes-shared-cases
func TestRolesWriteCasesMatchSharedFile(t *testing.T) {
	for _, c := range loadRolesCases(t).Writes {
		t.Run(c.Name, func(t *testing.T) {
			config := t.TempDir()
			path := filepath.Join(config, "roles.json")
			_, err := host.NewWorkspace(config).Apply(host.WorkspaceRequest{Kind: "rolesPut", Roles: c.Roles})
			if c.Error != "" {
				want := strings.ReplaceAll(c.Error, "<file>", path)
				if err == nil || err.Error() != want {
					t.Fatalf("rolesPut returned %v, want error %q", err, want)
				}
				if _, statErr := os.Stat(path); statErr == nil {
					t.Fatalf("a refused rolesPut wrote %s", path)
				}
				return
			}
			if err != nil {
				t.Fatalf("rolesPut returned error %v", err)
			}
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var written any
			if err := json.Unmarshal(data, &written); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(written, c.File) {
				t.Fatalf("rolesPut wrote %v, want %v", written, c.File)
			}
		})
	}
}

// contract: roles.reads-absent-file-without-creating
func TestRolesReadDoesNotCreateAbsentFile(t *testing.T) {
	config := t.TempDir()
	if _, err := host.NewWorkspace(config).Apply(host.WorkspaceRequest{Kind: "roles"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(config, "roles.json")); err == nil {
		t.Fatal("a read created roles.json")
	}
}
