// The drawing of group cards in the mygo workbench (docs/spec/groups.md#headers, docs/spec/groups.md#drawing): the group header with its
// name and buttons, the group and leader buttons of the card headers, the close menu of a group and the rename of a group.
package workbench_test

import (
	"slices"
	"testing"
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
		t.Fatalf("the leader buttons are %v; the root plane of one card shows none", got)
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
	if cards["main"]["plane"] != "card-2" || cards["card-3"]["plane"] != "card-2" {
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
