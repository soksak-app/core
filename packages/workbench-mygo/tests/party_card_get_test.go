package workbench_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// cardStateCase is docs/spec/cases/card-state/two-cards.json: the party of the cards and the card state that each card answers. The
// describe runner of sok reads the same file (packages/sok/go/tests/card_state_test.go).
type cardStateCase struct {
	Party struct {
		Cards  []string `json:"cards"`
		Leader string   `json:"leader"`
	} `json:"party"`
	Expected []struct {
		Card   string `json:"card"`
		Party  string `json:"party"`
		Leader bool   `json:"leader"`
	} `json:"expected"`
}

func readCardStateCase(t *testing.T) cardStateCase {
	t.Helper()
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "docs", "spec", "cases", "card-state", "two-cards.json"))
	if err != nil {
		t.Fatal(err)
	}
	var out cardStateCase
	if err := json.Unmarshal(text, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// TestCardGetAnswersThePartyOfEachCard checks core.card.get against the shared card-state case: each card of the case answers the party
// that core.party.create returned and the leader value of the case (docs/spec/parties.md#queries).
func TestCardGetAnswersThePartyOfEachCard(t *testing.T) {
	kase := readCardStateCase(t)
	f := tabAndSidebarShell(t)
	// The case names its cards a and b; the shell names its cards by identifier, so a is the first card and b the second.
	left := f.tabbedCards()[0]
	made, err := f.answer("core.card.split", map[string]string{"card": left, "side": "right", "plugin": "textprobe"})
	if err != nil {
		t.Fatal(err)
	}
	right := made["card"].(string)
	shellCards := map[string]string{"a": left, "b": right}
	members := []string{}
	for _, card := range kase.Party.Cards {
		members = append(members, shellCards[card])
	}
	leader := shellCards[kase.Party.Leader]
	created, err := f.answer("core.party.create", map[string]any{"cards": members, "leader": leader})
	if err != nil {
		t.Fatal(err)
	}
	party := created["party"].(map[string]any)["id"].(string)
	for _, want := range kase.Expected {
		state, err := f.answer("core.card.get", map[string]string{"card": shellCards[want.Card]})
		if err != nil {
			t.Fatal(err)
		}
		if state["party"] != party || state["leader"] != want.Leader || want.Party != party {
			t.Fatalf("core.card.get of %s answers party %v leader %v, the case expects party %s leader %v (party %s)",
				want.Card, state["party"], state["leader"], want.Party, want.Leader, party)
		}
	}
}
