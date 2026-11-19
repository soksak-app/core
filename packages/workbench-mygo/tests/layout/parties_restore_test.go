// A space restores its parties from the stored members and exports them back unchanged. A stored party that the grid does not
// hold as touching cards is refused by the restore with the party identifier, and nothing is restored.
package layout_test

import (
	"encoding/json"
	"testing"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// contract: workbench.parties.storage
func TestStoredPartiesRestoreAndExportUnchanged(t *testing.T) {
	state := layout.State{
		Xs: []float64{0, 1, 2},
		Ys: []float64{0, 1},
		Cards: []layout.Card{
			{ID: "a", C0: 0, C1: 1, R0: 0, R1: 1},
			{ID: "b", C0: 1, C1: 2, R0: 0, R1: 1},
		},
	}
	gap := 0.0
	options := layout.DefaultOptions()
	options.Gap = &gap
	grid, err := layout.New(&state, options)
	if err != nil {
		t.Fatal(err)
	}
	leader := "a"
	stored := []layout.StoredParty{{ID: "p1", Cards: []string{"a", "b"}, Leader: &leader, Color: "#112233"}}
	parties := layout.NewParties(shownPalette(t))
	if err := parties.Restore(grid, stored); err != nil {
		t.Fatal(err)
	}
	got := parties.Stored()
	want, _ := json.Marshal(stored)
	have, _ := json.Marshal(got)
	if string(want) != string(have) {
		t.Fatalf("exported parties %s, want the restored parties %s", have, want)
	}
}

func TestStoredPartyNotTouchingIsRefusedWithItsIdentifier(t *testing.T) {
	state := layout.State{
		Xs: []float64{0, 1, 2, 3},
		Ys: []float64{0, 1},
		Cards: []layout.Card{
			{ID: "a", C0: 0, C1: 1, R0: 0, R1: 1},
			{ID: "b", C0: 2, C1: 3, R0: 0, R1: 1},
		},
	}
	gap := 0.0
	options := layout.DefaultOptions()
	options.Gap = &gap
	grid, err := layout.New(&state, options)
	if err != nil {
		t.Fatal(err)
	}
	parties := layout.NewParties(shownPalette(t))
	err = parties.Restore(grid, []layout.StoredParty{{ID: "p1", Cards: []string{"a", "b"}, Color: "#112233"}})
	if err == nil || err.Error() != "party p1: cards are not touching: b" {
		t.Fatalf("restore error %v, want the party identifier and the touching refusal", err)
	}
	if got := parties.Stored(); len(got) != 0 {
		t.Fatalf("a refused restore kept parties: %+v", got)
	}
}
