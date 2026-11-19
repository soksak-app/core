package workbench_test

import (
	"math"
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

type partyDrawnRead struct {
	ID          string         `json:"id"`
	Color       string         `json:"color"`
	LeaderColor *string        `json:"leaderColor"`
	Outline     [][][2]float64 `json:"outline"`
}

// TestAPartyDrawsItsOutlineInItsColorAndTheLeaderBorder checks the drawing of docs/spec/parties.md#drawing in the frame: the outer
// outline of a party of two touching cards is drawn in the party color, and the part of it on the border of the leader card is drawn
// in the leader color, which follows party-leader of the theme while the party has no leader color. The frame is read as its pixels at
// the outline that core.parties reports, which the plane origin, the top left corner of the left card, places in the window.
func TestAPartyDrawsItsOutlineInItsColorAndTheLeaderBorder(t *testing.T) {
	f, left, right := splitShell(t)
	f.settle()
	f.run("core.party.create", map[string]any{"cards": []string{left, right}, "leader": left})
	f.settle()
	parties := status[[]partyDrawnRead](t, f, "core.parties")
	if len(parties) != 1 || len(parties[0].Outline) != 1 || parties[0].LeaderColor != nil {
		t.Fatalf("core.parties is %+v", parties)
	}
	declared, err := workbench.ReadDeclarations()
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := declared.DefaultPartyPalette()
	if err != nil {
		t.Fatal(err)
	}
	leftBox, rightBox := f.box("core.card", left), f.box("core.card", right)
	// The left card is the first card of the plane, so its plane rectangle starts at the plane origin.
	originY := leftBox.Y
	top := math.Inf(1)
	for _, point := range parties[0].Outline[0] {
		top = math.Min(top, point[1])
	}
	y := originY + float32(top)
	if got, want := f.pixelOf(rightBox.X+rightBox.W/2, y), opaque(ui.Hex(parties[0].Color)); !near(got, want) {
		t.Fatalf("the party outline above the right card is %v, want the party color %v", got, want)
	}
	if got, want := f.pixelOf(leftBox.X+leftBox.W/2, y), opaque(ui.Hex(tokens["party-leader"])); !near(got, want) {
		t.Fatalf("the party outline above the leader card is %v, want the leader color %v", got, want)
	}
}
