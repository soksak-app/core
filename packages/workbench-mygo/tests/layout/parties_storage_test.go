// The storage rules of the parties member of a space object of projects.json. A space without the member reads as no party, an
// explicit null or another form is refused with the file, the project root, the space identifier and the found value, and each
// party that breaks a rule of the specification is refused.
package layout_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// spaceWith returns a space object of projects.json whose parties member is the given JSON text, or no member when text is empty.
func spaceWith(parties string) json.RawMessage {
	if parties == "" {
		return json.RawMessage(`{"id":"s1","title":"Space","layout":{}}`)
	}
	return json.RawMessage(`{"id":"s1","title":"Space","layout":{},"parties":` + parties + `}`)
}

// contract: workbench.parties.storage
func TestSpaceWithoutPartiesReadsNoParty(t *testing.T) {
	got, err := layout.ReadStoredParties(spaceWith(""), "root-1", "s1", []string{"a", "b"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("parties = %v, want none", got)
	}
}

func TestSpacePartiesReadBackWithTheirMembers(t *testing.T) {
	text := `[{"id":"p1","cards":["a","b"],"leader":"a","color":"#112233","leaderColor":null}]`
	got, err := layout.ReadStoredParties(spaceWith(text), "root-1", "s1", []string{"a", "b"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != "p1" || got[0].Color != "#112233" || got[0].Leader == nil || *got[0].Leader != "a" {
		t.Fatalf("parties = %+v", got)
	}
}

func TestSpacePartiesWriteKeepsTheMemberForEachParty(t *testing.T) {
	leader := "a"
	written, err := layout.WriteStoredParties([]layout.StoredParty{{ID: "p1", Cards: []string{"a", "b"}, Leader: &leader, Color: "#112233"}})
	if err != nil {
		t.Fatal(err)
	}
	var members []map[string]any
	if err := json.Unmarshal(written, &members); err != nil {
		t.Fatal(err)
	}
	if len(members) != 1 || members[0]["id"] != "p1" || members[0]["color"] != "#112233" {
		t.Fatalf("written parties = %s", written)
	}
	for _, key := range []string{"id", "cards", "leader", "color", "leaderColor"} {
		if _, ok := members[0][key]; !ok {
			t.Fatalf("written party has no %s: %s", key, written)
		}
	}
	if _, ok := members[0]["reason"]; ok {
		t.Fatalf("written party holds a reason, which the storage does not keep: %s", written)
	}
}

func TestSpacePartiesOfAnotherFormAreRefused(t *testing.T) {
	for _, text := range []string{"null", `"p1"`, `{"id":"p1"}`} {
		_, err := layout.ReadStoredParties(spaceWith(text), "root-1", "s1", []string{"a", "b"})
		if err == nil {
			t.Fatalf("parties %s is accepted", text)
		}
		want := "projects.json: project root-1, space s1: parties " + text
		if !strings.HasPrefix(err.Error(), want) {
			t.Fatalf("error %q does not name the file, root, space and found value %s", err, text)
		}
	}
}

// The refusal of a party that breaks a rule carries the storage error text of docs/spec/parties.md#storage and no rule reason.
func TestSpacePartiesBreakingARuleNameOnlyTheStorageText(t *testing.T) {
	cases := map[string]string{
		"fewer than 2 cards": `[{"id":"p1","cards":["a"],"leader":null,"color":"#112233","leaderColor":null}]`,
		"an invalid color":   `[{"id":"p1","cards":["a","b"],"leader":null,"color":"red","leaderColor":null}]`,
	}
	for name, text := range cases {
		_, err := layout.ReadStoredParties(spaceWith(text), "root-1", "s1", []string{"a", "b"})
		want := "projects.json: project root-1, space s1: parties " + text
		if err == nil || err.Error() != want {
			t.Fatalf("%s: error = %v, want exactly %q", name, err, want)
		}
	}
}

func TestSpacePartiesBreakingARuleAreRefused(t *testing.T) {
	cases := map[string]string{
		"fewer than 2 cards":       `[{"id":"p1","cards":["a"],"leader":null,"color":"#112233","leaderColor":null}]`,
		"a card in two parties":    `[{"id":"p1","cards":["a","b"],"leader":null,"color":"#112233","leaderColor":null},{"id":"p2","cards":["b","c"],"leader":null,"color":"#445566","leaderColor":null}]`,
		"a card missing in layout": `[{"id":"p1","cards":["a","z"],"leader":null,"color":"#112233","leaderColor":null}]`,
		"a leader outside cards":   `[{"id":"p1","cards":["a","b"],"leader":"c","color":"#112233","leaderColor":null}]`,
		"an invalid color":         `[{"id":"p1","cards":["a","b"],"leader":null,"color":"red","leaderColor":null}]`,
	}
	for name, text := range cases {
		if _, err := layout.ReadStoredParties(spaceWith(text), "root-1", "s1", []string{"a", "b", "c"}); err == nil {
			t.Errorf("%s: the party is accepted", name)
		}
	}
}

func TestSpaceObjectKeepsThePartiesMemberWhenItIsWritten(t *testing.T) {
	var space layout.Space
	if err := json.Unmarshal(spaceWith(`[{"id":"p1","cards":["a","b"],"leader":null,"color":"#112233","leaderColor":null}]`), &space); err != nil {
		t.Fatal(err)
	}
	written, err := json.Marshal(space)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(written), `"parties":[{"id":"p1"`) {
		t.Fatalf("the written space drops the parties member: %s", written)
	}
}
