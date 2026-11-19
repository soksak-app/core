// Red test of the party names that the workbench declares (docs/spec/parties.md#queries, docs/spec/exposure.md). The declarations are
// read by ReadDeclarations, the loader of the workbench. The party commands core.party.create, core.party.update, core.party.add,
// core.party.remove, core.party.delete, core.party.get and core.card.get, and the status core.parties, are declared in the same way as
// the other names of the workbench, so each is a name of the declared commands or statuses.
package workbench_test

import (
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

func TestPartyCommandsAndStatusAreDeclared(t *testing.T) {
	declared, err := workbench.ReadDeclarations()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{
		"core.party.create", "core.party.update", "core.party.add", "core.party.remove",
		"core.party.delete", "core.party.get", "core.card.get",
	} {
		if !declared.Commands[name] {
			t.Errorf("command %s is not declared", name)
		}
	}
	if !declared.Statuses["core.parties"] {
		t.Errorf("status core.parties is not declared")
	}
}
