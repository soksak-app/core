package tests

import (
	"encoding/json"
	"os"
	"testing"
)

// cardStateFile is docs/spec/cases/card-state/two-cards.json, the shared card-state case: the party of the cards and the card state
// that each card answers. The workbench runner reads the same file (packages/workbench-mygo/tests/party_card_get_test.go).
type cardStateFile struct {
	Expected []struct {
		Card   string `json:"card"`
		Party  string `json:"party"`
		Leader bool   `json:"leader"`
	} `json:"expected"`
}

// contract: cli.describe.parties-first-and-card-party
// TestDescribeCardItemsAnswerTheSharedCardState checks the card items of sok describe against the shared card-state case. The
// endpoint case sok-describe-parties holds the snapshot of the same two cards in one party.
func TestDescribeCardItemsAnswerTheSharedCardState(t *testing.T) {
	text, err := os.ReadFile(repositoryFile(t, "docs/spec/cases/card-state/two-cards.json"))
	if err != nil {
		t.Fatal(err)
	}
	var kase cardStateFile
	if err := json.Unmarshal(text, &kase); err != nil {
		t.Fatal(err)
	}
	player := playCase(t, "sok-describe-parties")
	code, stdout, stderr := run("describe", "--config-dir", player.configDir)
	if code != 0 {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	var description struct {
		Layout struct {
			Root struct {
				Children []struct {
					Card   string `json:"card"`
					Party  string `json:"party"`
					Leader bool   `json:"leader"`
				} `json:"children"`
			} `json:"root"`
		} `json:"layout"`
	}
	if err := json.Unmarshal([]byte(stdout), &description); err != nil {
		t.Fatalf("describe is not JSON: %v", err)
	}
	items := map[string]struct {
		Party  string
		Leader bool
	}{}
	for _, child := range description.Layout.Root.Children {
		items[child.Card] = struct {
			Party  string
			Leader bool
		}{child.Party, child.Leader}
	}
	for _, want := range kase.Expected {
		got, ok := items[want.Card]
		if !ok || got.Party != want.Party || got.Leader != want.Leader {
			t.Fatalf("describe card %s answers party %q leader %v, the shared case expects party %q leader %v", want.Card, got.Party, got.Leader, want.Party, want.Leader)
		}
	}
}
