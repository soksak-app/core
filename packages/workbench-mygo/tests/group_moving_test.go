// The lines, the tab drops and the header drags of group cards in the mygo workbench (docs/spec/groups.md#model,
// docs/spec/groups.md#moving-and-dropping, docs/spec/groups.md#minimum-size), and the library preview of a group card.
package workbench_test

import (
	"fmt"
	"math"
	"slices"
	"testing"
)

// quadShell is a layout shell of four cards in two rows, a, b over c, d, in a window large enough for groups inside it.
func quadShell(t *testing.T) *tabShell {
	t.Helper()
	f := layoutShell(t, treeSpace("spc-aaaaaa", cutNode("x", kidNode(0.5, cutNode("y", kidNode(0.5, cardNode("card-1", tab("t1", "notes"))), kidNode(0.5, cardNode("card-3", tab("t3", "notes"))))), kidNode(0.5, cutNode("y", kidNode(0.5, cardNode("card-2", tab("t2", "notes"))), kidNode(0.5, cardNode("card-4", tab("t4", "notes"))))))))
	f.tester.SetSize(1400, 900)
	f.settle()
	return f
}

// A line that a group card and the cards outside it share is one line: the frame of the group card and the cards outside it on the
// line are drawn at one coordinate, the cards inside one gap within the frame, and one move of its boundary moves it in the group and
// outside it (docs/spec/groups.md#drawn-rectangles).
func TestALineAcrossAGroupIsOneLine(t *testing.T) {
	f := quadShell(t)
	if _, err := f.apply("core.group.create", `{"card": "card-1", "side": "right", "plugin": "plain"}`); err != nil {
		t.Fatal(err)
	}
	right := func(card map[string]any) float64 { return card["x"].(float64) + card["w"].(float64) }
	check := func(when string) {
		t.Helper()
		cards := f.gridCards()
		frame, inside, outside := right(cards[cards["card-6"]["parent"].(string)]), right(cards["card-6"]), right(cards["card-3"])
		gap := cards["card-6"]["x"].(float64) - right(cards["card-1"])
		if math.Abs(frame-outside) > 1e-6 || math.Abs(frame-gap-inside) > 1e-6 {
			t.Fatalf("%s the right edge of the frame is %v, of card-6 in the group %v and of card-3 below it %v, with the gap %v", when, frame,
				inside, outside, gap)
		}
	}
	check("before the move")
	line := f.gridCards()["card-3"]["c1"]
	if _, err := f.apply("core.boundary.move", fmt.Sprintf(`{"axis": "x", "line": %v, "position": 500}`, line)); err != nil {
		t.Fatal(err)
	}
	check("after the move")
}

// A boundary stops where a content card under a group header is drawn at minSize (docs/spec/groups.md#minimum-size).
func TestABoundaryStopsAtTheDrawnMinimumUnderAHeader(t *testing.T) {
	f := quadShell(t)
	if _, err := f.apply("core.group.create", `{"card": "card-1", "side": "right", "plugin": "plain"}`); err != nil {
		t.Fatal(err)
	}
	move := fmt.Sprintf(`{"axis": "y", "line": %v, "position": 10}`, f.gridCards()["card-3"]["r0"])
	if _, err := f.apply("core.boundary.move", move); err != nil {
		t.Fatal(err)
	}
	if height := f.gridCards()["card-1"]["h"].(float64); height < 96-1e-6 || height > 97 {
		t.Fatalf("card-1 under the header is drawn %v high after the move, its minimum is 96", height)
	}
}

// A move of a card of the root level beside a member of a group withdraws the card, whose cut gives its space to its other kids in
// proportion, and inserts it into that group (docs/spec/groups.md#commands).
func TestAMoveBesideAMemberKeepsTheGroupOneRectangle(t *testing.T) {
	space := treeSpace("spc-aaaaaa", cutNode("y",
		kidNode(0.5, boxNode("card-5", "그룹 1", "card-1", cutNode("x", kidNode(0.5, cardNode("card-1", tab("t1", "notes"))), kidNode(0.5, cardNode("card-2", tab("t2", "notes")))))),
		kidNode(0.5, cutNode("x", kidNode(0.5, cardNode("card-3", tab("t3", "notes"))), kidNode(0.5, cardNode("card-4", tab("t4", "notes")))))))
	stored := space["layout"].(map[string]any)
	stored["leader"], stored["lastCard"] = "card-5", 5
	f := layoutShell(t, space)
	f.tester.SetSize(1400, 900)
	f.settle()
	if _, err := f.apply("core.card.move", `{"card": "card-4", "target": "card-1", "side": "left"}`); err != nil {
		t.Fatal(err)
	}
	cards := f.gridCards()
	if cards["card-4"]["parent"] != "card-5" || cards["card-3"]["w"].(float64) <= cards["card-1"]["w"].(float64) {
		t.Fatalf("after the move card-4 is %v and card-3 %v", cards["card-4"]["parent"], cards["card-3"]["w"])
	}
}

// A tab dropped on a card inside a group moves into that card, and a tab dropped on the header of a group card goes into a new card
// at the right edge of its rectangle.
func TestATabDropResolvesIntoTheGroup(t *testing.T) {
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
		if card["parent"] == "card-2" && id != "card-4" {
			right = math.Max(right, card["x"].(float64)+card["w"].(float64))
		}
	}
	if card := cards["card-4"]; card == nil || card["parent"] != "card-2" || card["x"].(float64) < right-1e-6 || !f.holdsTab("card-4", "t3") {
		t.Fatalf("the new card is %v, not at the right edge of the group", card)
	}
}

// The library preview of a space with a group card draws the cards of the grid and shows no refusal.
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
	if slices.Contains(panes, "card-2") || !slices.Contains(panes, "main") || !slices.Contains(panes, "card-3") {
		t.Fatalf("the preview holds the panes %v; the panes are the cards of the grid", panes)
	}
}

// holdsTab tells whether the card of any level holds the tab in core.grid.
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
	f.tester.SetSize(1400, 900)
	f.settle()
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
// level holds card-4 right of the group card.
func outsideShell(t *testing.T) *tabShell {
	t.Helper()
	f := layoutShell(t, oneCard(tab("t1", "notes"), tab("t2", "notes")))
	f.tester.SetSize(1400, 900)
	f.settle()
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

// A tab of a card inside a group dropped on the right zone of a card of the root level goes into a new card right of that card in the
// root level, and the card that it left keeps its other tab in the group.
func TestATabOutOfAGroupSplitsACardOfTheRootLevel(t *testing.T) {
	f := outsideShell(t)
	// The narrow head of main shows its active tab only, so t2 is shown first.
	f.shellFixture.run("core.tab.select", map[string]string{"tab": "t2"})
	drag := f.dropOnRightOf(t, "t2", "card-4")
	if drag == nil || drag.Target == nil || drag.Target.Card != "card-4" || drag.Target.Zone != "right" || drag.Preview == nil {
		t.Fatalf("the drag over the right of card-4 is %+v", drag)
	}
	cards := f.gridCards()
	born := cards["card-5"]
	if born == nil || born["parent"] != nil || !f.holdsTab("card-5", "t2") || born["x"].(float64) <= cards["card-4"]["x"].(float64) {
		t.Fatalf("after the drop the new card is %v", born)
	}
	if !f.holdsTab("main", "t1") || f.holdsTab("main", "t2") || cards["main"]["parent"] != "card-2" {
		t.Fatalf("after the drop main is %v", cards["main"])
	}
}

// The only tab of a card inside a group dropped on the right zone of a card of the root level moves its card there, and the group card
// that keeps one card is replaced by that card.
func TestTheOnlyTabOutOfAGroupMovesItsCardAndDissolvesTheGroup(t *testing.T) {
	f := outsideShell(t)
	only := f.gridCards()["card-3"]["tabs"].([]any)[0].(map[string]any)["id"].(string)
	drag := f.dropOnRightOf(t, only, "card-4")
	if drag == nil || drag.Target == nil || drag.Target.Card != "card-4" || drag.Target.Zone != "right" || drag.Preview == nil {
		t.Fatalf("the drag over the right of card-4 is %+v", drag)
	}
	cards := f.gridCards()
	if _, kept := cards["card-2"]; kept || cards["main"]["parent"] != nil || cards["card-3"]["parent"] != nil ||
		cards["card-3"]["x"].(float64) <= cards["card-4"]["x"].(float64) {
		t.Fatalf("after the drop the grid holds %v", cards)
	}
}
