package workbench_test

import (
	"encoding/json"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// The status of core.workbench.audit states unbound as an array, so a tree with nothing unbound reports an empty list.
func TestAnAuditWithNothingUnboundIsAnEmptyList(t *testing.T) {
	encoded, err := json.Marshal(map[string]any{"unbound": workbench.Audit(nil)})
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"unbound":[]}` {
		t.Fatalf("the audit encodes as %s", encoded)
	}
}
