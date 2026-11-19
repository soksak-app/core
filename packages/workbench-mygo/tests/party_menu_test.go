package workbench_test

import (
	"fmt"
	"slices"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// The party items of the card tool menu (docs/spec/parties.md#card-menu): each item is an element of its declared name that runs its
// declared command, with the labels of the page workbench (partyMenuItems of packages/workbench/parties.js).

// partyMenuShell is a shell of four content cards in two rows, a b over c d, whose heads are narrow enough to fold their tools into
// the tool menu. a touches b and c, and d touches b and c.
func partyMenuShell(t *testing.T) (*shellFixture, []string) {
	t.Helper()
	f := tabAndSidebarShell(t)
	split := func(card, side string) string {
		made, err := f.answer("core.card.split", map[string]string{"card": card, "side": side, "plugin": "textprobe"})
		if err != nil {
			t.Fatal(err)
		}
		return made["card"].(string)
	}
	a := f.tabbedCards()[0]
	b := split(a, "right")
	c := split(a, "bottom")
	d := split(b, "bottom")
	cards := []string{a, b, c, d}
	f.tester.SetSize(500, 500)
	f.settle()
	for _, card := range cards {
		if !f.has("core.card.tools", card) {
			t.Fatalf("card %s has no tool menu button", card)
		}
	}
	return f, cards
}

// menuItem is an item of the open layer with the element name that it shows.
type menuItem struct{ key, name, element string }

// partyItems returns the items of the open layer that show a party element, in the order of the layer.
func (f *shellFixture) partyItems() []menuItem {
	f.t.Helper()
	items := []menuItem{}
	for _, item := range f.menu().Items {
		for _, element := range []string{"core.party.menu.group", "core.party.menu.leader", "core.party.menu.color", "core.party.menu.take"} {
			if f.has(element, item.Key) {
				items = append(items, menuItem{item.Key, item.Name, element})
			}
		}
	}
	return items
}

// cardParty returns the party and the leader value that core.card.get answers for a card.
func (f *shellFixture) cardParty(card string) (any, any) {
	f.t.Helper()
	state, err := f.answer("core.card.get", map[string]string{"card": card})
	if err != nil {
		f.t.Fatal(err)
	}
	return state["party"], state["leader"]
}

func TestCardToolMenuGroupsTheCardWithATouchingCard(t *testing.T) {
	f, cards := partyMenuShell(t)
	f.click("core.card.tools", cards[0])
	items := f.partyItems()
	if len(items) != 1 || items[0].element != "core.party.menu.group" || items[0].name != "카드 묶기" {
		t.Fatalf("the party items of a card in no party are %+v", items)
	}
	f.click("core.party.menu.group", items[0].key)
	menu := f.menu()
	touching := []string{}
	for _, card := range f.tabbedCards() {
		if card == cards[1] || card == cards[2] {
			touching = append(touching, "card-"+card)
		}
	}
	if !menu.Open || menu.Title != "묶을 카드 고르기" || !slices.Equal(menu.keys(), touching) {
		t.Fatalf("the group chooser is %+v", menu)
	}
	f.click("core.picker.item", "card-"+cards[1])
	menu = f.menu()
	if !menu.Open || len(menu.Items) != 3 || menu.Items[2].Name != "카드 2개 묶기" {
		t.Fatalf("the group chooser with a selected card is %+v", menu)
	}
	for _, item := range menu.Items[:2] {
		if item.Active != (item.Key == "card-"+cards[1]) {
			t.Fatalf("the group chooser with a selected card is %+v", menu)
		}
	}
	if party, _ := f.cardParty(cards[0]); party != nil {
		t.Fatalf("a card press created party %v", party)
	}
	confirm := menu.Items[2].Key
	if !f.has("core.party.menu.group", confirm) {
		t.Fatalf("the confirm item %s has no element core.party.menu.group", confirm)
	}
	f.click("core.party.menu.group", confirm)
	if f.menu().Open {
		t.Fatalf("the confirm item left the layer open: %+v", f.menu())
	}
	for _, card := range cards[:2] {
		if party, _ := f.cardParty(card); party != "p1" {
			t.Fatalf("core.party.create through the confirm item put card %s in party %v", card, party)
		}
	}
}

func TestCardToolMenuOffersTheLeaderColorAndTakeItems(t *testing.T) {
	f, cards := partyMenuShell(t)
	f.run("core.party.create", map[string]any{"cards": []string{cards[0], cards[2]}})
	f.run("core.party.create", map[string]any{"cards": []string{cards[1], cards[3]}})
	f.click("core.card.tools", cards[0])
	items := f.partyItems()
	want := []menuItem{{"", "대표 카드로 지정", "core.party.menu.leader"}}
	for n := 1; n <= 6; n++ {
		want = append(want, menuItem{"", fmt.Sprintf("색 %d", n), "core.party.menu.color"})
	}
	want = append(want, menuItem{"", "파티 p2에 합치기, 파티 p1가 사라짐", "core.party.menu.take"})
	if len(items) != len(want) {
		t.Fatalf("the party items of a card in a party are %+v, the menu expects %+v", items, want)
	}
	for i := range want {
		if items[i].name != want[i].name || items[i].element != want[i].element {
			t.Fatalf("party item %d is %+v, the menu expects %+v", i, items[i], want[i])
		}
	}
	// core.party.update with leader set to the card.
	f.click("core.party.menu.leader", items[0].key)
	if party, leader := f.cardParty(cards[0]); party != "p1" || leader != true {
		t.Fatalf("the leader item left card %s in party %v with leader %v", cards[0], party, leader)
	}
	f.click("core.card.tools", cards[0])
	items = f.partyItems()
	if items[0].name != "대표 카드 해제" || items[0].element != "core.party.menu.leader" {
		t.Fatalf("the leader item of the leader is %+v", items[0])
	}
	// core.party.update with color set to the value of party-3.
	f.click("core.party.menu.color", items[3].key)
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	palette, err := declared.DefaultPartyPalette()
	if err != nil {
		t.Fatal(err)
	}
	got, err := f.answer("core.party.get", map[string]string{"party": "p1"})
	if err != nil {
		t.Fatal(err)
	}
	if got["color"] != palette["party-3"] {
		t.Fatalf("the color item 색 3 set party p1 to %v, party-3 is %s", got["color"], palette["party-3"])
	}
	// core.party.update with leader null.
	f.click("core.card.tools", cards[0])
	f.click("core.party.menu.leader", f.partyItems()[0].key)
	if _, leader := f.cardParty(cards[0]); leader != false {
		t.Fatalf("the leader item of the leader left leader %v", leader)
	}
	// core.party.add with the card and take: true.
	f.click("core.card.tools", cards[0])
	items = f.partyItems()
	// The layer holds more items than its height shows, so the person scrolls the layer to the take item at its end.
	first, ok := exposedNode(f.tester.ElementTree(), "core.party.menu.leader", items[0].key)
	if !ok {
		t.Fatalf("no leader item %s", items[0].key)
	}
	f.tester.Scroll(first.Bounds.X+first.Bounds.W/2, first.Bounds.Y+first.Bounds.H/2, 0, 400)
	f.settle()
	f.click("core.party.menu.take", items[len(items)-1].key)
	if party, _ := f.cardParty(cards[0]); party != "p2" {
		t.Fatalf("the take item left card %s in party %v", cards[0], party)
	}
	if party, _ := f.cardParty(cards[2]); party != nil {
		t.Fatalf("the take item left card %s in party %v", cards[2], party)
	}
}
