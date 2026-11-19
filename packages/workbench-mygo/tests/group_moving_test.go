// The boundaries, the tab drops and the header drags of the child planes in the mygo workbench (docs/spec/groups.md#drawing,
// docs/spec/groups.md#moving-and-dropping, docs/spec/groups.md#minimum-size), and the library preview of a group card.
package workbench_test

import (
	"fmt"
	"math"
	"slices"
	"strings"
	"testing"
)

// A divider of a child plane moves the boundary of that plane and leaves the group card where it stands.
func TestADividerOfAChildPlaneMovesItsBoundary(t *testing.T) {
	f := groupedShell(t)
	f.settle()
	divided := false
	for _, item := range itemsNamed(f.tester.ElementTree(), "core.divider") {
		divided = divided || strings.HasPrefix(item, "card-2/")
	}
	if !divided {
		t.Fatal("the child plane of card-2 draws no divider")
	}
	before := f.gridCards()
	if _, err := f.apply("core.boundary.move", `{"plane": "card-2", "axis": "x", "line": 1, "position": 300}`); err != nil {
		t.Fatal(err)
	}
	after := f.gridCards()
	if after["main"]["w"] == before["main"]["w"] || after["card-2"]["w"] != before["card-2"]["w"] {
		t.Fatalf("the move changed main from %v to %v and card-2 from %v to %v", before["main"]["w"], after["main"]["w"],
			before["card-2"]["w"], after["card-2"]["w"])
	}
}

// A boundary of the root plane stops where the group card beside it reaches its smallest size.
func TestARootBoundaryStopsAtTheSmallestSizeOfAGroupCard(t *testing.T) {
	f := groupedShell(t)
	if _, err := f.apply("core.card.split", `{"card": "card-2", "side": "right", "plugin": "plain"}`); err != nil {
		t.Fatal(err)
	}
	group := f.gridCards()["card-2"]
	move := fmt.Sprintf(`{"axis": "x", "line": %v, "position": %v}`, group["c1"], group["x"].(float64)+10)
	if _, err := f.apply("core.boundary.move", move); err != nil {
		t.Fatal(err)
	}
	gap, minSize := f.gridGap(t), 96.0
	smallest := minSize + gap + minSize + gap
	if width := f.gridCards()["card-2"]["w"].(float64); width < smallest-1e-6 || width > smallest+1 {
		t.Fatalf("the group card is %v wide after the move, its smallest width is %v", width, smallest)
	}
}

// A tab dropped on a card of a child plane moves into that card, and a tab dropped on the header of a group card goes into a new card
// at the right edge of its child plane.
func TestATabDropResolvesIntoTheChildPlane(t *testing.T) {
	f := layoutShell(t, oneCard(tab("t1", "notes"), tab("t2", "notes"), tab("t3", "notes")))
	if _, err := f.apply("core.group.create", `{"card": "main", "side": "right", "plugin": "plain"}`); err != nil {
		t.Fatal(err)
	}
	// The point lies in the centre zone of card-3 and in the inner half of the group card, whose outer quarters are its sides.
	box := f.box("core.card", "card-3")
	x, y := box.X+box.W*0.35, box.Y+box.H/2
	drag := dragTab(t, f.shellFixture, "t2", x, y)
	if drag == nil || drag.Target == nil || drag.Target.Card != "card-3" || drag.Target.Zone != "centre" {
		t.Fatalf("the drag over card-3 is %+v with the target %+v", drag, drag.Target)
	}
	f.tester.Release(x, y)
	f.settle()
	if !f.holdsTab("card-3", "t2") {
		t.Fatalf("card-3 holds %v", f.gridCards()["card-3"]["tabs"])
	}
	head := f.box("core.group.header", "card-2")
	x, y = head.X+head.W/2, head.Y+head.H/2
	drag = dragTab(t, f.shellFixture, "t3", x, y)
	if drag == nil || drag.Target == nil || drag.Target.Card != "card-2" || drag.Target.Zone != "centre" {
		t.Fatalf("the drag over the group header is %+v", drag)
	}
	f.tester.Release(x, y)
	f.settle()
	cards := f.gridCards()
	if f.holdsTab("main", "t3") {
		t.Fatalf("after the drop on the group header the grid holds %v", cards)
	}
	right := 0.0
	for id, card := range cards {
		if card["plane"] == "card-2" && id != "card-4" {
			right = math.Max(right, card["x"].(float64)+card["w"].(float64))
		}
	}
	if card := cards["card-4"]; card == nil || card["plane"] != "card-2" || card["x"].(float64) < right-1e-6 || !f.holdsTab("card-4", "t3") {
		t.Fatalf("the new card is %v, not at the right edge of the child plane", card)
	}
}

// The library preview of a space with a group card draws it with the cards of its child plane and shows no refusal.
func TestTheLibraryPreviewDrawsAGroupCard(t *testing.T) {
	f := groupedShell(t)
	f.shellFixture.run("core.projects.browse", nil)
	library := status[libraryRead](t, f.shellFixture, "core.library")
	if len(library.PreviewErrors) > 0 {
		t.Fatalf("the library shows the preview errors %v", library.PreviewErrors)
	}
	panes := []string{}
	for _, pane := range library.Previews["prj-a"] {
		panes = append(panes, pane.Card)
	}
	if !slices.Contains(panes, "card-2") || slices.Contains(panes, "main") {
		t.Fatalf("the preview holds the panes %v; the panes are the cards of the root plane", panes)
	}
}

// holdsTab tells whether the card of any plane holds the tab in core.grid.
func (f *tabShell) holdsTab(card, tab string) bool {
	entry, ok := f.gridCards()[card]
	if !ok {
		return false
	}
	for _, held := range entry["tabs"].([]any) {
		if held.(map[string]any)["id"] == tab {
			return true
		}
	}
	return false
}

// A press and drag on the header of a group card moves the group card, and a release with no drop changes nothing.
func TestAGroupCardIsDraggedByItsHeader(t *testing.T) {
	f := groupedShell(t)
	if _, err := f.apply("core.card.split", `{"card": "card-2", "side": "right", "plugin": "plain"}`); err != nil {
		t.Fatal(err)
	}
	head, target := f.box("core.group.header", "card-2"), f.box("core.card", "card-4")
	from, at := head.X+30, head.Y+head.H/2
	x, y := target.X+target.W-4, target.Y+target.H/2
	f.tester.Move(from, at)
	f.tester.Frame()
	f.tester.Press(from, at)
	f.tester.Frame()
	f.tester.Move(x, y)
	f.tester.Frame()
	drag := status[*dragRead](t, f.shellFixture, "core.drag")
	if drag == nil || drag.Card != "card-2" || drag.Target == nil || drag.Target.Card != "card-4" || drag.Target.Zone != "right" || drag.Preview == nil {
		t.Fatalf("the drag of the group header is %+v", drag)
	}
	f.tester.Release(x, y)
	f.settle()
	cards := f.gridCards()
	if cards["card-2"]["x"].(float64) <= cards["card-4"]["x"].(float64) {
		t.Fatalf("the group card stands at %v, not right of card-4 at %v", cards["card-2"]["x"], cards["card-4"]["x"])
	}
}

// outsideShell is a layout shell whose card main, with the tabs t1 and t2, is in the group card card-2 beside card-3, and the root
// plane holds card-4 right of the group card.
func outsideShell(t *testing.T) *tabShell {
	t.Helper()
	f := layoutShell(t, oneCard(tab("t1", "notes"), tab("t2", "notes")))
	if _, err := f.apply("core.group.create", `{"card": "main", "side": "right", "plugin": "plain"}`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.apply("core.card.split", `{"card": "card-2", "side": "right", "plugin": "plain"}`); err != nil {
		t.Fatal(err)
	}
	return f
}

// dropOnRightOf drags tab to the right zone of card and releases it there.
func (f *tabShell) dropOnRightOf(t *testing.T, tab, card string) *dragRead {
	t.Helper()
	box := f.box("core.card", card)
	x, y := box.X+box.W-4, box.Y+box.H/2
	drag := dragTab(t, f.shellFixture, tab, x, y)
	f.tester.Release(x, y)
	f.settle()
	return drag
}

// A tab of a card inside a group dropped on the right zone of a card of the root plane goes into a new card right of that card in the
// root plane, and the card that it left keeps its other tab in the group.
func TestATabOutOfAGroupSplitsACardOfTheRootPlane(t *testing.T) {
	f := outsideShell(t)
	// The narrow head of main shows its active tab only, so t2 is shown first.
	f.shellFixture.run("core.tab.select", map[string]string{"tab": "t2"})
	drag := f.dropOnRightOf(t, "t2", "card-4")
	if drag == nil || drag.Target == nil || drag.Target.Card != "card-4" || drag.Target.Zone != "right" || drag.Preview == nil {
		t.Fatalf("the drag over the right of card-4 is %+v", drag)
	}
	cards := f.gridCards()
	born := cards["card-5"]
	if born == nil || born["plane"] != nil || !f.holdsTab("card-5", "t2") || born["x"].(float64) <= cards["card-4"]["x"].(float64) {
		t.Fatalf("after the drop the new card is %v", born)
	}
	if !f.holdsTab("main", "t1") || f.holdsTab("main", "t2") || cards["main"]["plane"] != "card-2" {
		t.Fatalf("after the drop main is %v", cards["main"])
	}
}

// The only tab of a card inside a group dropped on the right zone of a card of the root plane moves its card there, and the group card
// that keeps one card is replaced by that card.
func TestTheOnlyTabOutOfAGroupMovesItsCardAndDissolvesTheGroup(t *testing.T) {
	f := outsideShell(t)
	only := f.gridCards()["card-3"]["tabs"].([]any)[0].(map[string]any)["id"].(string)
	drag := f.dropOnRightOf(t, only, "card-4")
	if drag == nil || drag.Target == nil || drag.Target.Card != "card-4" || drag.Target.Zone != "right" || drag.Preview == nil {
		t.Fatalf("the drag over the right of card-4 is %+v", drag)
	}
	cards := f.gridCards()
	if _, kept := cards["card-2"]; kept || cards["main"]["plane"] != nil || cards["card-3"]["plane"] != nil ||
		cards["card-3"]["x"].(float64) <= cards["card-4"]["x"].(float64) {
		t.Fatalf("after the drop the grid holds %v", cards)
	}
}
