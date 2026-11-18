package tests

// Red tests of the party contract of sok (docs/spec/cli.md#window-description, docs/spec/parties.md#queries). The cases of these tests
// are in docs/spec/cases/endpoint (sok-describe-parties, sok-describe-summary-and-full, sok-status-parties, sok-party-get-and-card-get,
// sok-commands-query-party). The application does not answer the party requests yet, so each test fails on the unchanged
// implementation: the describe output has no parties member, the status and the commands are absent, and the card state has no party.
// The Rust tests in rust/tests/party_test.rs have the same names.

import (
	"encoding/json"
	"strings"
	"testing"
)

// contract: cli.describe.parties-first-and-card-party
func TestDescribeListsThePartiesFirstAndEachCardPartyAndLeader(t *testing.T) {
	player := playCase(t, "sok-describe-parties")
	code, stdout, stderr := run("describe", "--config-dir", player.configDir)
	if code != 0 {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	if strings.Index(stdout, `"parties"`) < 0 || strings.Index(stdout, `"parties"`) > strings.Index(stdout, `"window"`) {
		t.Fatalf("describe does not begin with the parties: %s", stdout)
	}
	var description struct {
		Parties []struct {
			ID string `json:"id"`
		} `json:"parties"`
		Layout struct {
			Root struct {
				Children []struct {
					Card   string `json:"card"`
					Party  any    `json:"party"`
					Leader bool   `json:"leader"`
				} `json:"children"`
			} `json:"root"`
		} `json:"layout"`
	}
	if err := json.Unmarshal([]byte(stdout), &description); err != nil {
		t.Fatalf("describe is not JSON: %v", err)
	}
	if len(description.Parties) != 1 || description.Parties[0].ID != "p1" {
		t.Fatalf("parties %v", description.Parties)
	}
	cards := description.Layout.Root.Children
	if len(cards) != 2 || cards[0].Party != "p1" || !cards[0].Leader || cards[1].Party != "p1" || cards[1].Leader {
		t.Fatalf("card party and leader %v", cards)
	}
}

// contract: cli.describe.summary-and-full
func TestDescribeSummaryHoldsSummaryStatusesAndFullHoldsEveryStatus(t *testing.T) {
	player := playCase(t, "sok-describe-summary-and-full")
	_, summary, stderr := run("describe", "--config-dir", player.configDir)
	if !strings.Contains(summary, `"probe.busy"`) {
		t.Fatalf("summary lacks the tab statuses: stderr %q stdout %s", stderr, summary)
	}
	if strings.Contains(summary, `"probe.detail"`) {
		t.Fatalf("summary holds a status that is not a summary: %s", summary)
	}
	_, full, stderr := run("describe", "--full", "--config-dir", player.configDir)
	if !strings.Contains(full, `"probe.detail"`) || !strings.Contains(full, `"probe.busy"`) {
		t.Fatalf("full lacks the statuses of the tab: stderr %q stdout %s", stderr, full)
	}
}

// contract: cli.status.core-parties-every-field
func TestStatusCorePartiesReturnsEveryPartyField(t *testing.T) {
	player := playCase(t, "sok-status-parties")
	code, stdout, stderr := run("status", "core.parties", "--config-dir", player.configDir)
	var parties []map[string]any
	if err := json.Unmarshal([]byte(stdout), &parties); err != nil || code != 0 {
		t.Fatalf("code %d stderr %q stdout %q", code, stderr, stdout)
	}
	if len(parties) != 1 {
		t.Fatalf("parties %v", parties)
	}
	for _, field := range []string{"id", "cards", "leader", "color", "leaderColor", "outline", "reason"} {
		if _, ok := parties[0][field]; !ok {
			t.Fatalf("party record lacks %s: %v", field, parties[0])
		}
	}
}

// contract: cli.party.get-and-card-get
func TestPartyGetAndCardGetAnswerThePartyAndCardQueries(t *testing.T) {
	player := playCase(t, "sok-party-get-and-card-get")
	code, stdout, stderr := run("core.party.get", "--party", "p1", "--config-dir", player.configDir)
	var party map[string]any
	if err := json.Unmarshal([]byte(stdout), &party); err != nil || code != 0 {
		t.Fatalf("code %d stderr %q stdout %q", code, stderr, stdout)
	}
	if _, ok := party["members"]; !ok {
		t.Fatalf("core.party.get lacks members: %v", party)
	}
	code, stdout, stderr = run("core.card.get", "--card", "b", "--config-dir", player.configDir)
	var card map[string]any
	if err := json.Unmarshal([]byte(stdout), &card); err != nil || code != 0 {
		t.Fatalf("code %d stderr %q stdout %q", code, stderr, stdout)
	}
	if card["party"] != "p1" || card["leader"] != false {
		t.Fatalf("core.card.get %v", card)
	}
}

// contract: cli.commands.query-party
func TestCommandsQueryPartyListsThePartyCommandsOnly(t *testing.T) {
	player := playCase(t, "sok-commands-query-party")
	code, stdout, stderr := run("commands", "--query", "party", "--config-dir", player.configDir)
	var commands []map[string]any
	if err := json.Unmarshal([]byte(stdout), &commands); err != nil || code != 0 {
		t.Fatalf("code %d stderr %q stdout %q", code, stderr, stdout)
	}
	names := map[string]bool{}
	for _, command := range commands {
		names[command["name"].(string)] = true
	}
	for _, name := range []string{"core.party.create", "core.party.update", "core.party.add", "core.party.remove", "core.party.delete", "core.party.get"} {
		if !names[name] {
			t.Fatalf("query party lacks %s: %v", name, names)
		}
	}
	if names["core.card.close"] {
		t.Fatalf("query party lists a command that is not a party command")
	}
}
