package workbench_test

import "testing"

// TestCardGetAnswersThePartyOfEachCard checks the card state of core.card.get against the party that holds the card: the party
// identifier of the card is the identifier that core.party.create returned, and only the leader card is a leader. The describe
// output reads the same party records, so its party and leader fields follow the same rule (docs/spec/parties.md#queries).
func TestCardGetAnswersThePartyOfEachCard(t *testing.T) {
	f := tabAndSidebarShell(t)
	left := f.tabbedCards()[0]
	made, err := f.answer("core.card.split", map[string]string{"card": left, "side": "right", "plugin": "textprobe"})
	if err != nil {
		t.Fatal(err)
	}
	right := made["card"].(string)
	created, err := f.answer("core.party.create", map[string]any{"cards": []string{left, right}, "leader": left})
	if err != nil {
		t.Fatal(err)
	}
	party := created["party"].(map[string]any)["id"].(string)
	for card, leader := range map[string]bool{left: true, right: false} {
		state, err := f.answer("core.card.get", map[string]string{"card": card})
		if err != nil {
			t.Fatal(err)
		}
		if state["card"] != card || state["party"] != party || state["leader"] != leader {
			t.Fatalf("core.card.get of %s answers %v, want party %s and leader %v", card, state, party, leader)
		}
	}
}
