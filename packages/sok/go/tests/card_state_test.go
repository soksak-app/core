package tests

import (
	"encoding/json"
	"os"
	"sort"
	"strings"
	"testing"
)

// cardStateFile is docs/spec/cases/card-state/two-cards.json, the shared card-state case: the party of the cards and the card state
// that each card answers. The workbench runner reads the same file (packages/workbench-mygo/tests/party_card_get_test.go).
type cardStateFile struct {
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
	checkSnapshotState(t, kase)
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

// checkSnapshotState checks that the snapshot of the endpoint case holds the shared state: the party of the shared case, with the same
// cards and leader, and the layout cards of the same identifiers. Without it, describe could explain another input and still match the
// expected values.
func checkSnapshotState(t *testing.T, kase cardStateFile) {
	t.Helper()
	text, err := os.ReadFile(repositoryFile(t, "docs/spec/cases/endpoint/sok-describe-parties.json"))
	if err != nil {
		t.Fatal(err)
	}
	var endpoint struct {
		Variables struct {
			Snapshot struct {
				Example struct {
					Layout struct {
						Root struct {
							Children []struct {
								Card string `json:"card"`
							} `json:"children"`
						} `json:"root"`
					} `json:"layout"`
					Groups []struct {
						Owner  string `json:"owner"`
						Status []struct {
							Name  string `json:"name"`
							Value []struct {
								Cards  []string `json:"cards"`
								Leader *string  `json:"leader"`
							} `json:"value"`
						} `json:"status"`
					} `json:"groups"`
				} `json:"example"`
			} `json:"snapshot"`
		} `json:"variables"`
	}
	if err := json.Unmarshal(text, &endpoint); err != nil {
		t.Fatal(err)
	}
	example := endpoint.Variables.Snapshot.Example
	var records []struct {
		Cards  []string `json:"cards"`
		Leader *string  `json:"leader"`
	}
	for _, group := range example.Groups {
		if group.Owner != "core" {
			continue
		}
		for _, status := range group.Status {
			if status.Name == "core.parties" {
				records = status.Value
			}
		}
	}
	if len(records) != 1 {
		t.Fatalf("the endpoint snapshot has %d parties, the shared state has one", len(records))
	}
	sameCards := func(a, b []string) bool {
		a, b = append([]string(nil), a...), append([]string(nil), b...)
		sort.Strings(a)
		sort.Strings(b)
		return strings.Join(a, ",") == strings.Join(b, ",")
	}
	leader := ""
	if records[0].Leader != nil {
		leader = *records[0].Leader
	}
	if !sameCards(records[0].Cards, kase.Party.Cards) || leader != kase.Party.Leader {
		t.Fatalf("the endpoint snapshot differs from the shared state: party cards %v leader %q, the shared state has cards %v leader %q",
			records[0].Cards, leader, kase.Party.Cards, kase.Party.Leader)
	}
	var layoutCards []string
	for _, child := range example.Layout.Root.Children {
		layoutCards = append(layoutCards, child.Card)
	}
	var expectedCards []string
	for _, want := range kase.Expected {
		expectedCards = append(expectedCards, want.Card)
	}
	if !sameCards(layoutCards, expectedCards) {
		t.Fatalf("the endpoint layout holds cards %v, the shared state expects cards %v", layoutCards, expectedCards)
	}
}
