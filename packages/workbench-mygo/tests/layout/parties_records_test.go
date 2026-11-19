// The status core.parties lists one record per party: the stored fields, the outline in window points and the reason of the last
// change. The outline of each record is the outline of the party (Parties.Outline) as [x, y] pairs.
package layout_test

import (
	"encoding/json"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// contract: workbench.parties.commands
func TestPartyRecordsCarryTheStoredFieldsOutlineAndReason(t *testing.T) {
	state := layout.State{
		Xs:    []float64{0, 1, 2},
		Ys:    []float64{0, 1},
		Cards: []layout.Card{{ID: "a", C0: 0, C1: 1, R0: 0, R1: 1}, {ID: "b", C0: 1, C1: 2, R0: 0, R1: 1}},
	}
	gap := 8.0
	options := layout.DefaultOptions()
	options.Gap = &gap
	grid, err := layout.New(&state, options)
	if err != nil {
		t.Fatal(err)
	}
	declared, err := workbench.ReadDeclarations()
	if err != nil {
		t.Fatal(err)
	}
	border := declared.ChromeNumber("theme-rail-w", "px")
	parties := layout.NewParties(shownPalette(t))
	if _, err := parties.Run(grid, "core.party.create", []byte(`{"cards":["a","b"],"leader":"a"}`)); err != nil {
		t.Fatal(err)
	}
	records, err := parties.Records(grid, border)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 {
		t.Fatalf("records %d, want one party", len(records))
	}
	record := records[0]
	if record.ID != "p1" || record.Color != "#a06ce0" || record.Leader == nil || *record.Leader != "a" || record.Reason == nil || *record.Reason != "created" {
		t.Fatalf("record %+v does not carry the stored fields and the reason of the create", record)
	}
	loops, err := parties.Outline(grid, "p1", border)
	if err != nil {
		t.Fatal(err)
	}
	want, _ := json.Marshal(record.Outline)
	pairs := [][][2]float64{}
	for _, loop := range loops {
		next := [][2]float64{}
		for _, point := range loop {
			next = append(next, [2]float64{point.X, point.Y})
		}
		pairs = append(pairs, next)
	}
	have, _ := json.Marshal(pairs)
	if string(want) != string(have) {
		t.Fatalf("record outline %s, want the party outline %s", want, have)
	}
}
