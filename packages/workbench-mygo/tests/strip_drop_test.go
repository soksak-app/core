// The drops on a tab strip and on the centre of a content card in the mygo workbench: a tab joins at the index under the point,
// core.tab.move and core.card.move join at an index, and a card or a group card on the centre of a content card exchanges places with it
// (docs/spec/groups.md#moving-and-dropping, docs/spec/groups.md#commands).
package workbench_test

import (
	"encoding/json"
	"math"
	"slices"
	"strings"
	"testing"
)

// stripShell is a layout shell of card-1, with the tabs t1, t2 and t3, left of card-2, with the tabs t4 and t5.
func stripShell(t *testing.T) *tabShell {
	t.Helper()
	f := layoutShell(t, treeSpace("spc-aaaaaa", cutNode("x",
		kidNode(0.5, cardNode("card-1", tab("t1", "notes"), tab("t2", "notes"), tab("t3", "notes"))),
		kidNode(0.5, cardNode("card-2", tab("t4", "notes"), tab("t5", "notes"))))))
	f.tester.SetSize(1400, 900)
	f.settle()
	return f
}

// tabIDs is the ids of the tabs of the card in core.grid, in their order.
func (f *tabShell) tabIDs(card string) []string {
	f.t.Helper()
	entry, ok := f.gridCards()[card]
	if !ok {
		return nil
	}
	ids := []string{}
	for _, held := range entry["tabs"].([]any) {
		ids = append(ids, held.(map[string]any)["id"].(string))
	}
	return ids
}

// A tab dropped on a tab strip joins the card at the index under the point, the number of the other tabs of the card whose middle lies
// before it, and core.drag reports that index before the release.
func TestATabDropOnATabStripJoinsAtTheIndexUnderThePoint(t *testing.T) {
	f := stripShell(t)
	five := f.box("core.card.tab", "t5")
	x, y := five.X+five.W/2-2, five.Y+five.H/2
	drag := dragTab(t, f.shellFixture, "t1", x, y)
	if drag == nil || drag.Target == nil || strings.Join(drag.Target.Card, " ") != "card-2" || drag.Target.Zone != "strip" || drag.Target.Index == nil || *drag.Target.Index != 1 {
		t.Fatalf("the drag over the strip is %+v with the target %+v", drag, drag.Target)
	}
	f.tester.Release(x, y)
	f.settle()
	if got := f.tabIDs("card-2"); !slices.Equal(got, []string{"t4", "t1", "t5"}) {
		t.Fatalf("card-2 holds %v", got)
	}
	if got := f.tabIDs("card-1"); !slices.Equal(got, []string{"t2", "t3"}) {
		t.Fatalf("card-1 holds %v", got)
	}
	// Within its own strip the moving tab is left out of the count.
	three := f.box("core.card.tab", "t3")
	x, y = three.X+three.W/2+2, three.Y+three.H/2
	drag = dragTab(t, f.shellFixture, "t2", x, y)
	if drag == nil || drag.Target == nil || drag.Target.Zone != "strip" || drag.Target.Index == nil || *drag.Target.Index != 1 {
		t.Fatalf("the drag over its own strip is %+v with the target %+v", drag, drag.Target)
	}
	f.tester.Release(x, y)
	f.settle()
	if got := f.tabIDs("card-1"); !slices.Equal(got, []string{"t3", "t2"}) {
		t.Fatalf("card-1 holds %v", got)
	}
}

// core.tab.move with the zone strip puts the tab at index of the card, and refuses what the specification lists, in its order.
func TestTabMoveToAStripJoinsAtIndex(t *testing.T) {
	f := stripShell(t)
	if _, err := f.apply("core.tab.move", `{"tab": "t1", "card": "card-2", "zone": "strip", "index": 0}`); err != nil {
		t.Fatal(err)
	}
	if got := f.tabIDs("card-2"); !slices.Equal(got, []string{"t1", "t4", "t5"}) {
		t.Fatalf("card-2 holds %v", got)
	}
	created, err := f.apply("core.group.create", `{"card": "card-2", "side": "right", "plugin": "plain"}`)
	if err != nil {
		t.Fatal(err)
	}
	var group map[string]string
	if err := json.Unmarshal([]byte(created), &group); err != nil {
		t.Fatal(err)
	}
	for _, refusal := range []struct{ params, want string }{
		{`{"tab": "t2", "card": ["card-1", "card-2"], "zone": "strip", "index": 0}`, "tab t2 moves to the strip of one card, not of card-1, card-2"},
		{`{"tab": "t2", "card": "` + group["group"] + `", "zone": "strip", "index": 0}`, "card " + group["group"] + " is a group and has no tab strip"},
		{`{"tab": "t2", "card": "card-2", "zone": "strip"}`, "index is required with zone strip"},
		{`{"tab": "t2", "card": "card-2", "zone": "centre", "index": 0}`, "index is given with zone strip only"},
		{`{"tab": "t2", "card": "card-2", "zone": "strip", "index": 4}`, "index 4 is outside the tabs of card card-2, 0 to 3"},
		{`{"tab": "t1", "card": "card-2", "zone": "strip", "index": 3}`, "index 3 is outside the tabs of card card-2, 0 to 2"},
		{`{"tab": "t2", "card": "card-2", "zone": "strip", "index": -1}`, "index -1 is outside the tabs of card card-2, 0 to 3"},
	} {
		if _, err := f.apply("core.tab.move", refusal.params); err == nil || err.Error() != refusal.want {
			t.Errorf("core.tab.move %s answers %v, not %q", refusal.params, err, refusal.want)
		}
	}
}

// core.card.move with the side strip joins every tab of a content card at index, in its order, and closes the card; it refuses what the
// specification lists, in its order.
func TestCardMoveToAStripJoinsEveryTab(t *testing.T) {
	f := stripShell(t)
	created, err := f.apply("core.group.create", `{"card": "card-2", "side": "bottom", "plugin": "plain"}`)
	if err != nil {
		t.Fatal(err)
	}
	var group map[string]string
	if err := json.Unmarshal([]byte(created), &group); err != nil {
		t.Fatal(err)
	}
	g := group["group"]
	for _, refusal := range []struct{ params, want string }{
		{`{"card": "card-1", "target": "card-2", "side": "right", "index": 0}`, "index is given with side strip only"},
		{`{"card": "card-1", "target": ["card-2", "` + group["card"] + `"], "side": "strip", "index": 0}`, "card card-1 moves to the strip of one card, not of card-2, " + group["card"]},
		{`{"card": "` + g + `", "target": "card-1", "side": "strip", "index": 0}`, "card " + g + " is a group and holds no tabs"},
		{`{"card": "card-1", "target": "` + g + `", "side": "strip", "index": 0}`, "card " + g + " is a group and has no tab strip"},
		{`{"card": "card-1", "target": "card-2", "side": "strip"}`, "index is required with side strip"},
		{`{"card": "card-1", "target": "card-2", "side": "strip", "index": 3}`, "index 3 is outside the tabs of card card-2, 0 to 2"},
	} {
		if _, err := f.apply("core.card.move", refusal.params); err == nil || err.Error() != refusal.want {
			t.Errorf("core.card.move %s answers %v, not %q", refusal.params, err, refusal.want)
		}
	}
	if _, err := f.apply("core.card.move", `{"card": "card-1", "target": "card-2", "side": "strip", "index": 1}`); err != nil {
		t.Fatal(err)
	}
	if got := f.tabIDs("card-2"); !slices.Equal(got, []string{"t4", "t1", "t2", "t3", "t5"}) {
		t.Fatalf("card-2 holds %v", got)
	}
	if _, held := f.gridCards()["card-1"]; held {
		t.Fatal("card-1 stays after its tabs joined card-2")
	}
}

// core.card.move with the side centre and a content card target exchanges the two cards, and each place keeps its size.
func TestCardMoveToTheCentreOfACardExchangesThem(t *testing.T) {
	f := stripShell(t)
	before := f.gridCards()
	if _, err := f.apply("core.card.move", `{"card": "card-1", "target": "card-2", "side": "centre"}`); err != nil {
		t.Fatal(err)
	}
	after := f.gridCards()
	for _, pair := range [][2]string{{"card-1", "card-2"}, {"card-2", "card-1"}} {
		for _, key := range []string{"x", "y", "w", "h"} {
			if math.Abs(after[pair[0]][key].(float64)-before[pair[1]][key].(float64)) > 1e-6 {
				t.Fatalf("%s stands at %v after the exchange, %s stood at %v", pair[0], after[pair[0]], pair[1], before[pair[1]])
			}
		}
	}
}

// The preview of a drop is its result: a drop of the only tab of a card on the centre or the tab strip of another card closes the card
// that it leaves, so the preview is the rectangle of the target after that close (docs/spec/groups.md#invariants, I3).
func TestThePreviewOfADropThatClosesItsCardIsItsResult(t *testing.T) {
	for _, zone := range []string{"centre", "strip"} {
		t.Run(zone, func(t *testing.T) {
			f := layoutShell(t, treeSpace("spc-aaaaaa", cutNode("x",
				kidNode(0.5, cardNode("card-1", tab("t1", "notes"))),
				kidNode(0.5, cardNode("card-2", tab("t4", "notes"), tab("t5", "notes"))))))
			f.tester.SetSize(1400, 900)
			f.settle()
			x, y := float32(0), float32(0)
			if zone == "centre" {
				box := f.box("core.card", "card-2")
				x, y = box.X+box.W/2, box.Y+box.H/2
			} else {
				five := f.box("core.card.tab", "t5")
				x, y = five.X+five.W/2+2, five.Y+five.H/2
			}
			drag := dragTab(t, f.shellFixture, "t1", x, y)
			if drag == nil || drag.Target == nil || drag.Target.Zone != zone || drag.Preview == nil {
				t.Fatalf("the drag is %+v with the target %+v", drag, drag.Target)
			}
			preview := *drag.Preview
			f.tester.Release(x, y)
			f.settle()
			cards := f.gridCards()
			if _, held := cards["card-1"]; held {
				t.Fatal("card-1 stays after its only tab left it")
			}
			result := cards["card-2"]
			got := [4]float64{preview.X, preview.Y, preview.W, preview.H}
			want := [4]float64{result["x"].(float64), result["y"].(float64), result["w"].(float64), result["h"].(float64)}
			for i := range got {
				if math.Abs(got[i]-want[i]) > 1e-6 {
					t.Fatalf("the preview is %v and the result %v", got, want)
				}
			}
		})
	}
}
