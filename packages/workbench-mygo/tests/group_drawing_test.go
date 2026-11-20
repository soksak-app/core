// The drawing of group cards in the mygo workbench (docs/spec/groups.md#headers, docs/spec/groups.md#drawing): the group header with its
// name and buttons, the group and leader buttons of the card headers, the close menu of a group and the rename of a group.
package workbench_test

import (
	"encoding/json"
	"fmt"
	"image/color"
	"math"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// The header of a group card holds its name and its buttons, and the headers of content cards stay the headers of the content cards.
func TestAGroupHeaderShowsItsNameAndItsButtons(t *testing.T) {
	f := groupedShell(t)
	f.settle()
	for _, name := range []string{"core.group", "core.group.header", "core.group.name", "core.group.split-x", "core.group.split-y",
		"core.group.group-x", "core.group.group-y", "core.group.close"} {
		if !f.has(name, "card-2") {
			t.Errorf("the group card card-2 has no %s", name)
		}
	}
	// A group header holds no add button, and its add menu is refused (docs/spec/groups.md#headers).
	if f.has("core.group.add", "card-2") {
		t.Error("the group card card-2 has an add button")
	}
	if _, err := f.apply("core.card.menu", `{"card": "card-2", "menu": "add"}`); err == nil ||
		err.Error() != "card card-2 is a group; a group header has no add menu" {
		t.Errorf("the add menu of the group card answered %v", err)
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

// Each group split button groups the card with a new card toward its own side, whatever the shape of the card, and a card too small
// for a group keeps both buttons, disabled, as a split button that cannot split (docs/spec/groups.md#headers).
func TestEachGroupSplitButtonGroupsTowardItsSide(t *testing.T) {
	for _, c := range []struct{ button, side string }{{"core.card.group-x", "right"}, {"core.card.group-y", "bottom"}} {
		f := layoutShell(t, oneCard(tab("t1", "notes")))
		f.settle()
		f.click(c.button, "main")
		f.click("core.picker.item", "plain")
		cards := f.gridCards()
		if cards["main"]["parent"] != "card-2" || cards["card-3"]["parent"] != "card-2" {
			t.Fatalf("%s: after the menu the grid holds %v", c.button, cards)
		}
		main, born := f.box("core.card", "main"), f.box("core.card", "card-3")
		if toward := born.X > main.X+main.W-1; (c.side == "right") != toward || (c.side == "bottom") != (born.Y > main.Y+main.H-1) {
			t.Errorf("%s: the new card stands at %+v beside main at %+v, not toward %s", c.button, born, main, c.side)
		}
	}
	f := layoutShell(t, oneCard(tab("t1", "notes")))
	f.tester.SetSize(420, 300)
	f.settle()
	acts := f.gridCards()["main"]["acts"].(map[string]any)
	for _, name := range []string{"group-x", "group-y"} {
		if tool, ok := acts[name].(map[string]any); !ok || tool["enabled"] != false {
			t.Errorf("a card too small for a group reports the tool %s as %v, not disabled", name, acts[name])
		}
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
	space := treeSpace("spc-aaaaaa", boxNode("card-6", "그룹 2", "card-5", cutNode("x",
		kidNode(0.5, boxNode("card-5", "그룹 1", "card-1", cutNode("y", kidNode(0.5, cardNode("card-1", tab("t1", "notes"))), kidNode(0.5, cardNode("card-3", tab("t3", "notes")))))),
		kidNode(0.5, cardNode("card-2", tab("t2", "notes"))))))
	stored := space["layout"].(map[string]any)
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

// A group card draws its header in the color of the head of a card and the area around its members in bg mixed into card by
// group-fill-fade to the power of the level of its members, in the dark and the light mode (docs/spec/groups.md#drawing).
func TestAGroupDrawsItsHeaderAndBodyFromTheCardTokens(t *testing.T) {
	f := nestedSideShell(t)
	raw, err := os.ReadFile("../src/workbench.json")
	if err != nil {
		t.Fatal(err)
	}
	var declared struct {
		Themes []struct {
			Dark  map[string]string `json:"dark"`
			Light map[string]string `json:"light"`
		} `json:"themes"`
		Chrome map[string]string `json:"chrome"`
	}
	if err := json.Unmarshal(raw, &declared); err != nil {
		t.Fatal(err)
	}
	fade, err := strconv.ParseFloat(declared.Chrome["group-fill-fade"], 64)
	if err != nil {
		t.Fatalf("the chrome value group-fill-fade: %v", err)
	}
	// body is bg mixed into card by fade to the power level, each channel rounded (docs/spec/cases/group-look.json).
	body := func(colors map[string]string, level int) color.RGBA {
		bg, card, share := ui.Hex(colors["bg"]), ui.Hex(colors["card"]), math.Pow(fade, float64(level))
		mix := func(a, b uint8) uint8 { return uint8(math.Round(float64(a)*share + float64(b)*(1-share))) }
		return color.RGBA{R: mix(bg.R, card.R), G: mix(bg.G, card.G), B: mix(bg.B, card.B), A: 255}
	}
	for _, mode := range []string{"dark", "light"} {
		colors := declared.Themes[0].Dark
		if mode == "light" {
			colors = declared.Themes[0].Light
		}
		f.run(t, "core.settings.set", fmt.Sprintf(`{"patch": {"mode": %q}}`, mode))
		f.tester.Frame()
		tree := f.tester.ElementTree()
		cards, frames, heads := exposedAll(tree, "core.card"), exposedAll(tree, "core.group"), exposedAll(tree, "core.group.header")
		// The points stand a quarter of the gap from a box, away from the line in the middle of the corridor, where the grid draws its rule.
		quarter := (cards["card-3"].Y - cards["card-1"].Y - cards["card-1"].H) / 4
		outer := frames["card-5"].X + frames["card-5"].W + quarter
		for _, p := range []struct {
			name string
			x, y float32
			want color.RGBA
		}{
			{"the gap between card-5 and card-2 in card-6", outer, cards["card-2"].Y + cards["card-2"].H/2, body(colors, 1)},
			{"the gap between card-1 and card-3 in card-5", cards["card-1"].X + cards["card-1"].W/2, cards["card-1"].Y + cards["card-1"].H + quarter,
				body(colors, 2)},
			{"the header of card-6", heads["card-6"].X + heads["card-6"].W/2, heads["card-6"].Y + 3, opaque(ui.Hex(colors["card"]))},
			{"the header of card-5", heads["card-5"].X + heads["card-5"].W/2, heads["card-5"].Y + 3, opaque(ui.Hex(colors["card"]))},
		} {
			if got := f.pixelOf(p.x, p.y); !near(got, p.want) {
				t.Errorf("%s: %s at %v,%v is %v, want %v", mode, p.name, p.x, p.y, got, p.want)
			}
		}
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

// The leader keeps its leader mark in a header too narrow for its tools: the other tools move into the tool menu, and the mark stays
// in the header beside the menu button; a member that does not lead moves its leader button into the menu (docs/spec/groups.md#headers).
func TestTheLeaderMarkStaysInANarrowHeader(t *testing.T) {
	f := groupedShell(t)
	f.tester.SetSize(760, 500)
	f.settle()
	acts := f.gridCards()["main"]["acts"].(map[string]any)
	if acts["tools"] != "menu" {
		t.Fatalf("the head of main is not narrow: its tools stand in %v", acts["tools"])
	}
	if !f.has("core.card.leader", "main") || !f.has("core.card.tools", "main") {
		t.Fatalf("the narrow head of the leader main shows the leader mark %v and the tool menu %v", f.has("core.card.leader", "main"),
			f.has("core.card.tools", "main"))
	}
	if leader := acts["leader"].(map[string]any); leader["hidden"] != false {
		t.Fatalf("core.grid reports the leader mark of main %v", leader)
	}
	if f.has("core.card.split-x", "main") {
		t.Fatal("the narrow head of main shows the split button beside the leader mark")
	}
	mark, more := f.box("core.card.leader", "main"), f.box("core.card.tools", "main")
	if head := f.box("core.card.header", "main"); mark.X+mark.W > more.X || more.X+more.W > head.X+head.W {
		t.Fatalf("the leader mark at %+v and the tool menu at %+v do not stand in order inside the head %+v", mark, more, head)
	}
	if acts := f.gridCards()["card-3"]["acts"].(map[string]any); acts["tools"] == "menu" && f.has("core.card.leader", "card-3") {
		t.Fatal("the narrow head of card-3, which does not lead, shows its leader button")
	}
	f.click("core.card.tools", "main")
	for _, item := range f.read("core.picker")["items"].([]any) {
		if item.(map[string]any)["key"] == "leader" {
			t.Fatal("the tool menu of the leader main holds the leader mark")
		}
	}
}

// Each group card that holds the focused card mixes the focus color into its frame line by group-focus-fade to the power of the levels
// up to it, the mark follows the focus in the next frame, and at the seam it recolors the frame line and draws no line beside it
// (docs/spec/groups.md#focus).
func TestEveryGroupCardThatHoldsTheFocusMarksItsFrame(t *testing.T) {
	raw, err := os.ReadFile("../src/workbench.json")
	if err != nil {
		t.Fatal(err)
	}
	var declared struct {
		Chrome map[string]string `json:"chrome"`
	}
	if err := json.Unmarshal(raw, &declared); err != nil {
		t.Fatal(err)
	}
	fade, err := strconv.ParseFloat(declared.Chrome["group-focus-fade"], 64)
	if err != nil || fade <= 0 || fade >= 1 || fade*fade < 0.3 {
		t.Fatalf("group-focus-fade %q does not keep two levels visible (%v)", declared.Chrome["group-focus-fade"], err)
	}
	f := nestedSideShell(t)
	palette := f.palette()
	marked := func(d int) color.RGBA {
		share := math.Pow(fade, float64(d))
		mix := func(a, b uint8) uint8 { return uint8(math.Round(float64(a)*share + float64(b)*(1-share))) }
		return color.RGBA{mix(palette.Focus.R, palette.Edge.R), mix(palette.Focus.G, palette.Edge.G), mix(palette.Focus.B, palette.Edge.B), 255}
	}
	focusOf := func(id string) any {
		text, err := json.Marshal(f.run(t, "core.card.get", `{"card": "`+id+`"}`))
		if err != nil {
			t.Fatal(err)
		}
		var state map[string]any
		if err := json.Unmarshal(text, &state); err != nil {
			t.Fatal(err)
		}
		focus, ok := state["focus"]
		if !ok {
			t.Fatalf("core.card.get of %s holds no focus: %s", id, text)
		}
		return focus
	}
	// The left frame line of card-5 and of card-6 beside the middle of card-3, and the bottom frame line of card-5 below card-3.
	lines := func() map[string]color.RGBA {
		f.tester.Frame()
		tree := f.tester.ElementTree()
		cards, frames := exposedAll(tree, "core.card"), exposedAll(tree, "core.group")
		y := cards["card-3"].Y + cards["card-3"].H/2
		line := palette.BorderWidth / 2
		return map[string]color.RGBA{
			"card-5 left":         f.pixelOf(frames["card-5"].X+line, y),
			"card-6 left":         f.pixelOf(frames["card-6"].X+line, y),
			"card-5 bottom":       f.pixelOf(cards["card-3"].X+cards["card-3"].W/2, frames["card-5"].Y+frames["card-5"].H-line),
			"outside card-6 left": f.pixelOf(frames["card-6"].X-line, y),
			"card-6 bottom":       f.pixelOf(cards["card-3"].X+cards["card-3"].W/2, frames["card-6"].Y+frames["card-6"].H-line),
			"below card-6":        f.pixelOf(cards["card-3"].X+cards["card-3"].W/2, frames["card-6"].Y+frames["card-6"].H+line),
		}
	}
	check := func(when string, want map[string]color.RGBA) {
		t.Helper()
		got := lines()
		for name, color := range want {
			if !near(got[name], color) {
				t.Errorf("%s: the %s frame line is %v, want %v", when, name, got[name], color)
			}
		}
	}
	f.run(t, "core.card.focus", `{"card": "card-3"}`)
	check("card-3 focused", map[string]color.RGBA{"card-5 left": marked(1), "card-6 left": marked(2), "card-5 bottom": marked(1)})
	if got := []any{focusOf("card-5"), focusOf("card-6")}; got[0] != 1.0 || got[1] != 2.0 {
		t.Errorf("with card-3 focused core.card.get reports the focus %v of card-5 and card-6, want 1 and 2", got)
	}
	f.run(t, "core.card.focus", `{"card": "card-2"}`)
	check("card-2 focused", map[string]color.RGBA{"card-5 left": opaque(palette.Edge), "card-6 left": marked(1)})
	if got := []any{focusOf("card-5"), focusOf("card-6")}; got[0] != nil || got[1] != 1.0 {
		t.Errorf("with card-2 focused core.card.get reports the focus %v of card-5 and card-6, want null and 1", got)
	}
	// At the seam a frame draws no line of its own: the marks color the one line of the plane outside the frames, and the innermost mark
	// owns the line that card-5 and card-6 both end on (docs/spec/groups.md#drawing); TestTheInnermostMarkOwnsASeamLine checks every line
	// of the seam.
	f.run(t, "core.settings.change", `{"key": "gap", "value": 0, "scope": "common"}`)
	f.run(t, "core.card.focus", `{"card": "card-1"}`)
	check("card-1 focused at the seam", map[string]color.RGBA{"outside card-6 left": marked(1), "below card-6": marked(1)})
}

// The name of a group stands at the start of the header, in the place of the tab strip where the first tab of a content card stands,
// and not in the middle of the room that the buttons leave (docs/spec/groups.md#headers).
func TestAGroupNameStandsAtTheStartOfItsHeader(t *testing.T) {
	f := groupedShell(t)
	f.settle()
	var label *ui.ElementNode
	var walk func(nodes []ui.ElementNode)
	walk = func(nodes []ui.ElementNode) {
		for i := range nodes {
			if exposed, ok := nodes[i].Key.(workbench.Exposed); ok && exposed.Name == "core.group.name" && exposed.Item == "card-2" {
				label = &nodes[i]
			}
			walk(nodes[i].Children)
		}
	}
	walk(f.tester.ElementTree())
	if label == nil {
		t.Fatal("the group card card-2 shows no name")
	}
	// The ink of the name is every point of its middle row whose color differs from the end of the name, which no text reaches.
	box := label.Bounds
	y := box.Y + box.H/2
	ground := f.pixelOf(box.X+box.W-1, y)
	first, last := float32(-1), float32(-1)
	for x := box.X; x < box.X+box.W; x++ {
		if !near(f.pixelOf(x, y), ground) {
			if first < 0 {
				first = x
			}
			last = x
		}
	}
	if first < 0 {
		t.Fatalf("the name %+v shows no text", box)
	}
	if left, right := first-box.X, box.X+box.W-last; left >= right {
		t.Fatalf("the name text runs from %v to %v in the name %+v: %v from its start and %v from its end", first, last, box, left, right)
	}
}

// A divider draws its grip at the center of each drawn stretch that holds the grip, and a stretch shorter than the grip draws none, so
// no grip reaches into a header: the line between the members of a group card nested at the top of another one is cut by both headers
// and keeps a stretch of one gap between them (docs/spec/groups.md#drawing).
func TestAGripStandsOnlyOnAStretchThatHoldsIt(t *testing.T) {
	f := groupedShell(t)
	f.tester.SetSize(1600, 900)
	// A new request groups main again, inside the group card that holds it.
	if _, err := f.apply("core.group.create", `{"card": "main", "side": "right", "plugin": "plain", "request": "nested"}`); err != nil {
		t.Fatal(err)
	}
	f.settle()
	f.tester.Frame()
	outer, inner := f.box("core.group.header", "card-2"), f.box("core.group.header", "card-4")
	main, born := f.box("core.card", "main"), f.box("core.card", "card-5")
	x := (main.X + main.W + born.X) / 2
	between := (outer.Y + outer.H + inner.Y) / 2
	if inner.Y-(outer.Y+outer.H) >= 24 {
		t.Fatalf("the headers stand %v apart, which holds a grip", inner.Y-(outer.Y+outer.H))
	}
	if got, beside := f.pixelOf(x, between), f.pixelOf(x-8, between); !near(got, beside) {
		t.Errorf("the stretch of the line between the headers at %v,%v draws %v, not the body %v beside it", x, between, got, beside)
	}
	body := (main.Y + main.Y + main.H) / 2
	if got, beside := f.pixelOf(x, body), f.pixelOf(x, body-20); near(got, beside) {
		t.Errorf("the stretch of the line beside the bodies draws no grip at its center %v,%v: %v", x, body, got)
	}
}

// The rename field of a group header is the rename field of a project or a space tab: its height, padding, outline and selection come
// from the tokens of the theme, it takes the place of the name with its text where the text of the name started and its end where the
// name ended, and the header keeps its height (docs/spec/groups.md#headers).
func TestTheRenameFieldOfAGroupTakesThePlaceOfItsName(t *testing.T) {
	raw, err := os.ReadFile("../src/workbench.json")
	if err != nil {
		t.Fatal(err)
	}
	var declared struct {
		Chrome map[string]string `json:"chrome"`
	}
	if err := json.Unmarshal(raw, &declared); err != nil {
		t.Fatal(err)
	}
	token := func(name string) float32 {
		value, err := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSuffix(declared.Chrome[name], "px"), "%"), 32)
		if err != nil {
			t.Fatalf("the token %s is %q: %v", name, declared.Chrome[name], err)
		}
		return float32(value)
	}
	padX, rootPad, rootH, headH := token("tab-pad-x"), token("bar-tab-root-pad"), token("bar-tab-root-h"), token("head-h")
	f := groupedShell(t)
	f.settle()
	palette := f.palette()
	name, header := f.box("core.group.name", "card-2"), f.box("core.group.header", "card-2")
	// The ink of a text row runs from the first to the last point that stands nearer the text color than the ground of the row: the
	// header for the name, and the selection, which covers the whole value when the field opens, for the field.
	distance := func(a, b color.RGBA) int {
		d := func(x, y uint8) int { return (int(x) - int(y)) * (int(x) - int(y)) }
		return d(a.R, b.R) + d(a.G, b.G) + d(a.B, b.B)
	}
	ink := func(box ui.Rect, ground color.RGBA) float32 {
		y := box.Y + box.H/2
		first, last := float32(-1), float32(-1)
		for x := box.X; x < box.X+box.W/2; x++ {
			if p := f.pixelOf(x, y); distance(p, opaque(palette.Fg)) < distance(p, ground) {
				if first < 0 {
					first = x
				}
				last = x
			}
		}
		return last - first
	}
	before := ink(name, f.pixelOf(name.X+name.W-2, name.Y+name.H/2))
	f.run(t, "core.rename.begin", `{"kind": "group", "id": "card-2"}`)
	f.settle()
	field, after := f.box("core.rename.input", ""), f.box("core.group.header", "card-2")
	border := palette.BorderWidth
	if after != header || header.H != headH {
		t.Errorf("the header %+v of %v points becomes %+v while the name is renamed", header, headH, after)
	}
	if want := (ui.Rect{X: name.X + padX - border - rootPad, Y: header.Y + (header.H-border-rootH)/2, W: name.X + name.W - (name.X + padX - border - rootPad), H: rootH}); field != want {
		t.Errorf("the rename field is %+v for the name %+v, want %+v: its text where the text of the name started", field, name, want)
	}
	// The scan of the field starts inside its outline.
	inner := f.box("core.rename.input", "")
	inner.X, inner.W = inner.X+palette.BorderWidth+1, inner.W-2*palette.BorderWidth-2
	if during := ink(inner, opaque(mixed(palette.Focus, palette.Bg, token("rename-selection-mix")/100))); math.Abs(float64(during-before)) > 1 {
		t.Errorf("the text of the name is %v wide and %v in the rename field: the field does not keep the size of the name", before, during)
	}
	// The field selects its whole value when it opens; the selection is the color that covers most of the start of its text row, which
	// the name of two letters and more fills.
	counts := map[color.RGBA]int{}
	y := field.Y + field.H/2
	for x := field.X + border + rootPad; x < field.X+border+rootPad+16; x++ {
		counts[f.pixelOf(x, y)]++
	}
	want := opaque(mixed(palette.Focus, palette.Bg, token("rename-selection-mix")/100))
	most, seen := color.RGBA{}, 0
	for c, n := range counts {
		if n > seen {
			most, seen = c, n
		}
	}
	if !near(most, want) {
		t.Errorf("the selection of the rename field is %v, want the focus color mixed into bg %v", most, want)
	}
}

// mixed is a color with share of color and the rest of base, as color-mix in srgb.
func mixed(c, base ui.Color, share float32) ui.Color {
	blend := func(a, b uint8) uint8 {
		return uint8(math.Round(float64(a)*float64(share) + float64(b)*float64(1-share)))
	}
	return ui.Color{R: blend(c.R, base.R), G: blend(c.G, base.G), B: blend(c.B, base.B), A: 255}
}

// The header of a group card is the band of head-h at the top of its frame rectangle, and the frame is the border and the radius of a
// card around the whole rectangle, its header included: the line of the frame runs along the header as along the body, the rounded
// corner shows the stage, and the content of the header starts the head padding inside the line, as in the head of a content card
// (docs/spec/groups.md#drawn-rectangles, docs/spec/groups.md#drawing).
func TestTheFrameOfAGroupCardRunsAroundItsHeader(t *testing.T) {
	raw, err := os.ReadFile("../src/workbench.json")
	if err != nil {
		t.Fatal(err)
	}
	var declared struct {
		Chrome map[string]string `json:"chrome"`
	}
	if err := json.Unmarshal(raw, &declared); err != nil {
		t.Fatal(err)
	}
	headPad, err := strconv.ParseFloat(strings.TrimSuffix(declared.Chrome["card-head-pad"], "px"), 32)
	if err != nil {
		t.Fatal(err)
	}
	f := groupedShell(t)
	f.settle()
	palette := f.palette()
	frame, header, name := f.box("core.group", "card-2"), f.box("core.group.header", "card-2"), f.box("core.group.name", "card-2")
	if header.X != frame.X || header.Y != frame.Y || header.W != frame.W {
		t.Fatalf("the header %+v is not the band at the top of the frame %+v", header, frame)
	}
	border := palette.BorderWidth
	if pad := name.X - frame.X; pad != border+float32(headPad) {
		t.Errorf("the name of the header %+v starts %v inside the frame %+v, want the line and the head padding %v", name, pad, frame, border+float32(headPad))
	}
	image := f.tester.Image()
	scale := float32(image.Bounds().Dx()) / f.tester.ElementTree()[0].Bounds.W
	at := func(x, y float32) color.RGBA { return image.RGBAAt(int(x*scale), int(y*scale)) }
	line := at(frame.X+border/2, frame.Y+frame.H/2)
	if got := at(frame.X+border/2, header.Y+header.H/2); got != line {
		t.Errorf("the left line of the frame is %v along the header and %v along the body", got, line)
	}
	if got := at(frame.X+frame.W-border/2, header.Y+header.H/2); got != line {
		t.Errorf("the right line of the frame is %v along the header and %v along the body", got, line)
	}
	if got := at(frame.X+frame.W/2, frame.Y+border/2); got != line {
		t.Errorf("the top line of the frame is %v over the header, want the line %v", got, line)
	}
	if corner, stage := at(frame.X+border/2, frame.Y+border/2), at(frame.X-2, frame.Y+frame.H/2); corner != stage {
		t.Errorf("the top left corner of the frame is %v, want the stage %v around its radius", corner, stage)
	}
}
