// The fullscreen of a group card in the mygo workbench (docs/spec/groups.md#commands): the group card with the cards inside it covers the
// work area, its header holds the fullscreen button, the layout does not change while it is fullscreen, and a content card inside a
// group still goes fullscreen alone.
package workbench_test

import (
	"strings"
	"testing"
)

// fullscreenShell is a grouped shell whose root level holds card-4 right of the group card card-2.
func fullscreenShell(t *testing.T) *tabShell {
	t.Helper()
	f := groupedShell(t)
	f.tester.SetSize(1400, 900)
	f.settle()
	if _, err := f.apply("core.card.split", `{"card": "card-2", "side": "right", "plugin": "plain"}`); err != nil {
		t.Fatal(err)
	}
	return f
}

// A group card goes fullscreen with the cards inside it, a focus inside it keeps it, and the second press restores the arrangement.
func TestAGroupCardGoesFullscreenWithTheCardsInsideIt(t *testing.T) {
	f := fullscreenShell(t)
	before := f.gridCards()
	f.click("core.group.fullscreen", "card-2")
	grid := status[gridRead](t, f.shellFixture, "core.grid")
	if grid.Fullscreen == nil || *grid.Fullscreen != "card-2" {
		t.Fatalf("core.grid reports the fullscreen card %v", grid.Fullscreen)
	}
	cards := f.gridCards()
	group := cards["card-2"]
	if group["x"] != float64(0) || group["y"] != float64(0) || group["w"].(float64) <= before["card-2"]["w"].(float64) {
		t.Fatalf("the fullscreen group card stands at %v", group)
	}
	for _, id := range []string{"main", "card-3"} {
		if card := cards[id]; card["w"].(float64) <= before[id]["w"].(float64) || card["h"].(float64) <= 0 {
			t.Fatalf("card %s of the fullscreen group stands at %v, before at %v", id, card, before[id])
		}
	}
	if cards["card-4"]["w"] != float64(0) || f.has("core.card", "card-4") {
		t.Fatalf("card-4 outside the fullscreen group stands at %v", cards["card-4"])
	}
	if !f.has("core.card", "main") || !f.has("core.group.header", "card-2") {
		t.Fatal("the fullscreen group does not show its header and its cards")
	}
	f.shellFixture.run("core.card.focus", map[string]string{"card": "card-3"})
	if grid := status[gridRead](t, f.shellFixture, "core.grid"); grid.Fullscreen == nil || *grid.Fullscreen != "card-2" {
		t.Fatalf("a focus inside the fullscreen group left the fullscreen %v", grid.Fullscreen)
	}
	f.click("core.group.fullscreen", "card-2")
	after := f.gridCards()
	for _, id := range []string{"card-2", "main", "card-3", "card-4"} {
		if after[id]["x"] != before[id]["x"] || after[id]["w"] != before[id]["w"] || after[id]["h"] != before[id]["h"] {
			t.Fatalf("after the restore card %s stands at %v, before at %v", id, after[id], before[id])
		}
	}
}

// While a group card is fullscreen the layout does not change, inside it too.
func TestTheLayoutInsideAFullscreenGroupDoesNotChange(t *testing.T) {
	f := fullscreenShell(t)
	f.shellFixture.run("core.card.fullscreen", map[string]string{"card": "card-2"})
	_, err := f.apply("core.card.split", `{"card": "main", "side": "bottom", "plugin": "plain"}`)
	if err == nil || !strings.Contains(err.Error(), "the layout does not change while card card-2 is fullscreen") {
		t.Fatalf("a split inside the fullscreen group answered %v", err)
	}
}

// A content card inside a group goes fullscreen alone.
func TestAContentCardInsideAGroupGoesFullscreenAlone(t *testing.T) {
	f := fullscreenShell(t)
	f.shellFixture.run("core.card.fullscreen", map[string]string{"card": "main"})
	cards := f.gridCards()
	if cards["main"]["x"] != float64(0) || cards["card-3"]["w"] != float64(0) || cards["card-2"]["w"] != float64(0) {
		t.Fatalf("with main fullscreen the grid holds %v", cards)
	}
}
