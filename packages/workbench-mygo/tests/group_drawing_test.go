// The drawing of group cards in the mygo workbench (docs/spec/groups.md#headers, docs/spec/groups.md#drawing): the group header with its
// name and buttons, the group and leader buttons of the card headers, the close menu of a group and the rename of a group.
package workbench_test

import (
	"encoding/json"
	"image/color"
	"math"
	"os"
	"slices"
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// The header of a group card holds its name and its buttons, and the headers of content cards stay the headers of the content cards.
func TestAGroupHeaderShowsItsNameAndItsButtons(t *testing.T) {
	f := groupedShell(t)
	f.settle()
	for _, name := range []string{"core.group", "core.group.header", "core.group.name", "core.group.add", "core.group.split-x",
		"core.group.split-y", "core.group.close"} {
		if !f.has(name, "card-2") {
			t.Errorf("the group card card-2 has no %s", name)
		}
	}
	if name, ok := exposedNode(f.tester.ElementTree(), "core.group.name", "card-2"); !ok || name.Label != "그룹 1" {
		t.Errorf("the group name reads %q", name.Label)
	}
	tree := f.tester.ElementTree()
	if got := itemsNamed(tree, "core.card.header"); !slices.Equal(got, []string{"main", "card-3"}) {
		t.Errorf("the card headers are %v", got)
	}
	if got := itemsNamed(tree, "core.group.header"); !slices.Equal(got, []string{"card-2"}) {
		t.Errorf("the group headers are %v", got)
	}
	group, inner := f.box("core.group", "card-2"), f.box("core.card", "main")
	if inner.X < group.X || inner.Y < group.Y+f.box("core.group.header", "card-2").H || inner.X+inner.W > group.X+group.W ||
		inner.Y+inner.H > group.Y+group.H {
		t.Errorf("the card main stands at %+v, outside the body of the group card at %+v", inner, group)
	}
	f.audit()
}

// The leader buttons stand in the headers of a plane of two or more cards, and a press makes its card the leader of its plane.
func TestTheLeaderButtonMakesItsCardTheLeader(t *testing.T) {
	f := groupedShell(t)
	f.settle()
	if got := itemsNamed(f.tester.ElementTree(), "core.card.leader"); !slices.Equal(got, []string{"main", "card-3"}) {
		t.Fatalf("the leader buttons are %v; the root level of one card shows none", got)
	}
	f.click("core.card.leader", "card-3")
	if cards := f.gridCards(); cards["card-3"]["leader"] != true || cards["main"]["leader"] == true {
		t.Fatalf("after the press the leaders are main %v and card-3 %v", cards["main"]["leader"], cards["card-3"]["leader"])
	}
	acts := f.gridCards()["card-3"]["acts"].(map[string]any)
	if leader, ok := acts["leader"].(map[string]any); !ok || leader["enabled"] != true {
		t.Fatalf("core.grid reports the leader tool %v", acts["leader"])
	}
}

// The group button is shown while the card can hold a group toward its longer axis, and its menu turns the card into a group card.
func TestTheGroupButtonShowsWhileTheGroupFitsAndMakesAGroup(t *testing.T) {
	f := layoutShell(t, oneCard(tab("t1", "notes")))
	f.settle()
	f.click("core.card.group", "main")
	f.click("core.picker.item", "plain")
	cards := f.gridCards()
	if cards["main"]["parent"] != "card-2" || cards["card-3"]["parent"] != "card-2" {
		t.Fatalf("after the group menu the grid holds %v", cards)
	}
	f.tester.SetSize(420, 300)
	f.settle()
	if f.has("core.card.group", "main") {
		t.Fatal("a card too small for a group shows the group button")
	}
}

// The close button of a group header opens its menu, whose 그룹 풀기 dissolves the group and keeps its cards.
func TestTheCloseMenuOfAGroupDissolvesIt(t *testing.T) {
	f := groupedShell(t)
	f.settle()
	f.click("core.group.close", "card-2")
	menu := f.menu()
	keys := []string{}
	for _, item := range menu.Items {
		keys = append(keys, item.Key)
	}
	if !slices.Equal(keys, []string{"close", "dissolve"}) {
		t.Fatalf("the close menu holds %v", keys)
	}
	f.click("core.picker.item", "dissolve")
	cards := f.gridCards()
	if _, kept := cards["card-2"]; kept || cards["main"] == nil || cards["card-3"] == nil {
		t.Fatalf("after 그룹 풀기 the grid holds %v", cards)
	}
	if _, err := f.apply("core.group.menu", `{"group": "main"}`); err == nil || err.Error() != "card main is not a group" {
		t.Fatalf("core.group.menu of a content card answered %v", err)
	}
}

// A rename of a group in place commits the new name.
func TestAGroupIsRenamedInPlace(t *testing.T) {
	f := groupedShell(t)
	f.settle()
	f.shellFixture.run("core.rename.begin", map[string]string{"kind": "group", "id": "card-2"})
	f.shellFixture.run("core.rename.set", map[string]string{"value": "작업"})
	f.shellFixture.run("core.rename.commit", nil)
	if group := f.gridCards()["card-2"]["group"].(map[string]any); group["name"] != "작업" {
		t.Fatalf("after the rename the group is %v", group)
	}
}

// A tab dropped on a card of a child plane moves into that card, and a tab dropped on the header of a group card goes into a new card

// nestedSideShell is a layout shell whose group card card-6 holds the nested group card card-5 at its left, card-1 over card-3, beside
// card-2 at its right, in a window large enough for both headers.
func nestedSideShell(t *testing.T) *tabShell {
	t.Helper()
	space := gridSpace("spc-aaaaaa", []float64{0, 0.5, 1}, []float64{0, 0.5, 1},
		gridCard("card-1", 0, 1, 0, 1, tab("t1", "notes")), gridCard("card-2", 1, 2, 0, 2, tab("t2", "notes")),
		gridCard("card-3", 0, 1, 1, 2, tab("t3", "notes")))
	stored := space["layout"].(map[string]any)
	stored["groups"] = []any{map[string]any{"card": "card-6", "name": "그룹 2", "leader": "card-5", "members": []any{
		map[string]any{"card": "card-5", "name": "그룹 1", "leader": "card-1", "members": []any{"card-1", "card-3"}}, "card-2"}}}
	stored["leader"], stored["lastCard"] = "card-6", 6
	f := layoutShell(t, space)
	f.tester.SetSize(1400, 900)
	f.settle()
	return f
}

// exposedAll is every element of the element name in the tree, with its item.
func exposedAll(nodes []ui.ElementNode, name string) map[string]ui.Rect {
	out := map[string]ui.Rect{}
	var walk func(nodes []ui.ElementNode)
	walk = func(nodes []ui.ElementNode) {
		for _, node := range nodes {
			if exposed, ok := node.Key.(workbench.Exposed); ok && exposed.Name == name {
				out[exposed.Item] = ui.Rect{X: node.Bounds.X, Y: node.Bounds.Y, W: node.Bounds.W, H: node.Bounds.H}
			}
			walk(node.Children)
		}
	}
	walk(nodes)
	return out
}

// A group header is one bar across the whole width of its group card, and no divider crosses a header by more than 1 point: the divider
// of the line between the nested group and the card beside it starts below the header of the outer group (docs/spec/groups.md#drawing).
func TestNoDividerCrossesAGroupHeader(t *testing.T) {
	f := nestedSideShell(t)
	heads := exposedAll(f.tester.ElementTree(), "core.group.header")
	dividers := exposedAll(f.tester.ElementTree(), "core.divider")
	if len(heads) != 2 || len(dividers) == 0 {
		t.Fatalf("the window shows the headers %v and the dividers %v", heads, dividers)
	}
	for group, head := range heads {
		frame := f.gridCards()[group]
		if math.Abs(float64(head.W)-frame["w"].(float64)) > 1 {
			t.Fatalf("the header of %s is %v wide and its group card %v", group, head.W, frame["w"])
		}
		for item, divider := range dividers {
			overlapX := min(head.X+head.W, divider.X+divider.W) - max(head.X, divider.X)
			overlapY := min(head.Y+head.H, divider.Y+divider.H) - max(head.Y, divider.Y)
			if overlapX > 1 && overlapY > 1 {
				t.Fatalf("the divider %s at %+v crosses the header of %s at %+v", item, divider, group, head)
			}
		}
	}
}

// The corridor separates a group header from every box below it, as it separates two cards: no card and no nested header begins
// within the gap below a header (docs/spec/groups.md#drawn-rectangles).
func TestABoxBelowAGroupHeaderStandsAGapBelowIt(t *testing.T) {
	f := nestedSideShell(t)
	tree := f.tester.ElementTree()
	cards := exposedAll(tree, "core.card")
	heads := exposedAll(tree, "core.group.header")
	gap := cards["card-3"].Y - (cards["card-1"].Y + cards["card-1"].H)
	if gap <= 1 {
		t.Fatalf("card-1 at %+v and card-3 at %+v stand no gap apart", cards["card-1"], cards["card-3"])
	}
	boxes := map[string]ui.Rect{}
	for id, r := range cards {
		boxes["core.card "+id] = r
	}
	for id, r := range heads {
		boxes["core.group.header "+id] = r
	}
	for group, head := range heads {
		bottom := head.Y + head.H
		for name, box := range boxes {
			across := min(head.X+head.W, box.X+box.W) - max(head.X, box.X)
			if across > 1 && box.Y > bottom-1 && box.Y < bottom+gap-1 {
				t.Fatalf("%s at %+v begins %v below the header of %s at %+v, within the gap %v", name, box, box.Y-bottom, group, head, gap)
			}
		}
	}
}

// A fullscreen group card is laid out as the whole work area at every level: its header at the top of the area, each card inside it the
// gap below the header above it, the header of a group card inside it drawn, and no line of the hidden cards
// (docs/spec/groups.md#card-commands-on-a-group-card).
func TestAFullscreenGroupIsLaidOutAsTheWholeArea(t *testing.T) {
	for _, group := range []string{"card-6", "card-5"} {
		t.Run(group, func(t *testing.T) {
			f := nestedSideShell(t)
			tree := f.tester.ElementTree()
			cards := exposedAll(tree, "core.card")
			gap := cards["card-3"].Y - (cards["card-1"].Y + cards["card-1"].H)
			outer := exposedAll(tree, "core.group.header")["card-6"]
			f.click("core.group.fullscreen", group)
			tree = f.tester.ElementTree()
			heads, cards := exposedAll(tree, "core.group.header"), exposedAll(tree, "core.card")
			head, ok := heads[group]
			if !ok || math.Abs(float64(head.Y-outer.Y)) > 1 || head.W < outer.W {
				t.Fatalf("the header of the fullscreen %s is %+v, the area starts at %+v", group, head, outer)
			}
			below := "card-1"
			if group == "card-6" {
				nested, ok := heads["card-5"]
				if !ok || math.Abs(float64(nested.Y-(head.Y+head.H+gap))) > 1 {
					t.Fatalf("the header of card-5 is %+v (%v), the gap below %+v", nested, ok, head)
				}
				head = nested
			}
			if card := cards[below]; math.Abs(float64(card.Y-(head.Y+head.H+gap))) > 1 {
				t.Fatalf("%s starts at %v, %v below the header %+v, not the gap %v", below, card.Y, card.Y-head.Y-head.H, head, gap)
			}
			if dividers := exposedAll(tree, "core.divider"); len(dividers) > 0 {
				t.Fatalf("the fullscreen shows the dividers %v", dividers)
			}
		})
	}
}

// Every box of a space stands one gap from the box beside it (docs/spec/groups.md#drawn-rectangles): a content card or a frame from
// its neighbour across a line, from the frame that holds it on its left, right and bottom, and from the header above it.
func TestEveryBoxStandsOneGapFromTheBoxBesideIt(t *testing.T) {
	f := nestedSideShell(t)
	tree := f.tester.ElementTree()
	cards, frames, heads := exposedAll(tree, "core.card"), exposedAll(tree, "core.group"), exposedAll(tree, "core.group.header")
	gap := cards["card-3"].Y - (cards["card-1"].Y + cards["card-1"].H)
	if gap <= 0 {
		t.Fatalf("card-1 %v and card-3 %v stand no gap apart", cards["card-1"], cards["card-3"])
	}
	stage := frames["card-6"]
	boxes := map[string]ui.Rect{}
	for id, r := range cards {
		if r.W > 0 && r.X >= stage.X-1 && r.X+r.W <= stage.X+stage.W+1 {
			boxes[id] = r
		}
	}
	for id, r := range frames {
		boxes[id] = r
	}
	inside := func(a, b ui.Rect) bool {
		return a.X >= b.X-0.5 && a.Y >= b.Y-0.5 && a.X+a.W <= b.X+b.W+0.5 && a.Y+a.H <= b.Y+b.H+0.5
	}
	overlaps := func(a0, a1, b0, b1 float32) bool { return a0 < b1-0.5 && b0 < a1-0.5 }
	// nearest is the distance from the side of the box id toward dir to the nearest edge that faces it: the inner side of a frame that
	// holds it, the outer side of a box beside it, or the bottom of a header above it; -1 when the side meets nothing.
	nearest := func(id string, dir string) float32 {
		r := boxes[id]
		best := float32(-1)
		take := func(d float32) {
			if d >= -0.5 && (best < 0 || d < best) {
				best = d
			}
		}
		for other, o := range boxes {
			if other == id {
				continue
			}
			switch {
			case inside(r, o):
				switch dir {
				case "left":
					take(r.X - o.X)
				case "right":
					take(o.X + o.W - (r.X + r.W))
				case "down":
					take(o.Y + o.H - (r.Y + r.H))
				}
			case inside(o, r):
			default:
				switch dir {
				case "left":
					if overlaps(r.Y, r.Y+r.H, o.Y, o.Y+o.H) {
						take(r.X - (o.X + o.W))
					}
				case "right":
					if overlaps(r.Y, r.Y+r.H, o.Y, o.Y+o.H) {
						take(o.X - (r.X + r.W))
					}
				case "down":
					if overlaps(r.X, r.X+r.W, o.X, o.X+o.W) {
						take(o.Y - (r.Y + r.H))
					}
				}
			}
		}
		if dir == "up" {
			for other, o := range boxes {
				if other != id && !inside(r, o) && !inside(o, r) && overlaps(r.X, r.X+r.W, o.X, o.X+o.W) && o.Y+o.H <= r.Y+0.5 {
					take(r.Y - (o.Y + o.H))
				}
			}
			for _, h := range heads {
				if overlaps(r.X, r.X+r.W, h.X, h.X+h.W) && h.Y+h.H <= r.Y+0.5 {
					take(r.Y - (h.Y + h.H))
				}
			}
		}
		return best
	}
	for id := range boxes {
		if id == "card-6" {
			continue
		}
		for _, dir := range []string{"left", "right", "down", "up"} {
			if dir == "up" && frames[id] != (ui.Rect{}) {
				continue
			}
			if d := nearest(id, dir); d >= 0 && math.Abs(float64(d-gap)) > 0.5 {
				t.Errorf("%s at %v stands %v from the box toward %s, not the gap %v", id, boxes[id], d, dir, gap)
			}
		}
	}
	for id, head := range heads {
		if frame := frames[id]; head.X != frame.X || head.Y != frame.Y || head.W != frame.W {
			t.Errorf("the header of %s at %v is not the top band of its frame %v", id, head, frame)
		}
	}
}

// A group card is one container filled with the color of the level of its members, its header included, and the setting group.tint
// mixes that color into bg (docs/spec/groups.md#drawing).
func TestAGroupIsFilledWithTheColorOfItsLevel(t *testing.T) {
	f := nestedSideShell(t)
	f.tester.Frame()
	raw, err := os.ReadFile("../src/workbench.json")
	if err != nil {
		t.Fatal(err)
	}
	var declared struct {
		Themes []struct {
			Dark map[string]string `json:"dark"`
		} `json:"themes"`
	}
	if err := json.Unmarshal(raw, &declared); err != nil {
		t.Fatal(err)
	}
	colors := declared.Themes[0].Dark
	tree := f.tester.ElementTree()
	cards, frames, heads := exposedAll(tree, "core.card"), exposedAll(tree, "core.group"), exposedAll(tree, "core.group.header")
	// The points stand a quarter of the gap from a box, away from the line in the middle of the corridor, where the grid draws its rule.
	quarter := (cards["card-3"].Y - cards["card-1"].Y - cards["card-1"].H) / 4
	outer := frames["card-5"].X + frames["card-5"].W + quarter
	points := []struct {
		name  string
		x, y  float32
		color string
	}{
		{"the gap between card-5 and card-2 in card-6", outer, cards["card-2"].Y + cards["card-2"].H/2, "group-1"},
		{"the gap between card-1 and card-3 in card-5", cards["card-1"].X + cards["card-1"].W/2,
			cards["card-1"].Y + cards["card-1"].H + quarter, "group-2"},
		{"the header of card-6", heads["card-6"].X + heads["card-6"].W/2, heads["card-6"].Y + 3, "group-1"},
	}
	for _, p := range points {
		if got, want := f.pixelOf(p.x, p.y), opaque(ui.Hex(colors[p.color])); !near(got, want) {
			t.Errorf("%s at %v,%v is %v, want %s %v", p.name, p.x, p.y, got, p.color, want)
		}
	}
	f.run(t, "core.settings.set", `{"patch": {"group.tint": 0}}`)
	f.tester.Frame()
	if got, want := f.pixelOf(points[0].x, points[0].y), opaque(ui.Hex(colors["bg"])); !near(got, want) {
		t.Errorf("with group.tint 0 %s is %v, want bg %v", points[0].name, got, want)
	}
}

// A rule of a line inside a group card is drawn only inside its frame below its header: never in the stage padding beyond the frame,
// nor across the frame of a nested group card (docs/spec/groups.md#drawing).
func TestARuleInsideAGroupStaysInsideItsFrame(t *testing.T) {
	f := nestedSideShell(t)
	f.tester.Frame()
	tree := f.tester.ElementTree()
	cards, frames := exposedAll(tree, "core.card"), exposedAll(tree, "core.group")
	outer, inner := frames["card-6"], frames["card-5"]
	// The x line between card-5 and card-2 and the y line between card-1 and card-3 lie inside the group cards.
	x := (inner.X + inner.W + cards["card-2"].X) / 2
	y := (cards["card-1"].Y + cards["card-1"].H + cards["card-3"].Y) / 2
	padding := f.pixelOf(outer.X+40, outer.Y-3)
	for _, p := range []struct {
		name string
		x, y float32
		want color.RGBA
	}{
		{"above the frame of card-6", x, outer.Y - 3, padding},
		{"below the frame of card-6", x, outer.Y + outer.H + 3, padding},
		{"left of the frame of card-6", outer.X - 3, y, padding},
		{"between the frames of card-6 and card-5", inner.X - 6, y, f.pixelOf(inner.X-6, y-40)},
	} {
		if got := f.pixelOf(p.x, p.y); !near(got, p.want) {
			t.Errorf("the rule reaches %s at %v,%v: %v, not %v", p.name, p.x, p.y, got, p.want)
		}
	}
}
