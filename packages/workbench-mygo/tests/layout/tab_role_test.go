package layout_test

import (
	"encoding/json"
	"testing"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// TestTabWrittenWithoutRoleStoresNullRole checks that a tab without a role is written with the member role as null, as
// docs/spec/agent-roles.md#tab-role-state requires, so that the stored layout it writes opens again.
func TestTabWrittenWithoutRoleStoresNullRole(t *testing.T) {
	var tab layout.Tab
	if err := json.Unmarshal([]byte(`{"id":"t1","plugin":"alpha","title":"t1"}`), &tab); err != nil {
		t.Fatal(err)
	}
	text, err := json.Marshal(tab)
	if err != nil {
		t.Fatal(err)
	}
	var members map[string]any
	if err := json.Unmarshal(text, &members); err != nil {
		t.Fatal(err)
	}
	if role, has := members["role"]; !has || role != nil {
		t.Fatalf("a tab without a role is written as %s; want the member role null", text)
	}
}

// TestTabWrittenWithRoleKeepsTheRecord checks that a stored role record is written as it was read.
func TestTabWrittenWithRoleKeepsTheRecord(t *testing.T) {
	const record = `{"id":"reviewer","generation":2,"fingerprint":"0123456789abcdef","confirmedFingerprint":null,"requests":1}`
	var tab layout.Tab
	if err := json.Unmarshal([]byte(`{"id":"t1","plugin":"alpha","title":"t1","role":`+record+`}`), &tab); err != nil {
		t.Fatal(err)
	}
	text, err := json.Marshal(tab)
	if err != nil {
		t.Fatal(err)
	}
	var written, want map[string]any
	if err := json.Unmarshal(text, &written); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(record), &want); err != nil {
		t.Fatal(err)
	}
	if got, _ := json.Marshal(written["role"]); string(got) != string(mustJSON(t, want)) {
		t.Fatalf("the role record is written as %s, want %s", got, mustJSON(t, want))
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	text, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return text
}
