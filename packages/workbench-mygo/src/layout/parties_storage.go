package layout

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
)

// hexColor matches a party color: a #rrggbb value in either letter case, as the party module accepts it.
var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// StoredParty is a party of the parties member of a space object of projects.json. The storage holds no reason and no outline,
// because both are derived from the cards and the layout.
type StoredParty struct {
	ID          string   `json:"id"`
	Cards       []string `json:"cards"`
	Leader      *string  `json:"leader"`
	Color       string   `json:"color"`
	LeaderColor *string  `json:"leaderColor"`
}

// ReadStoredParties reads the parties member of a space object of projects.json (docs/spec/parties.md#storage). A space object
// without the member has no party. Each refusal is the storage error text, which names the file, the project root, the space
// identifier and the found value. cards are the identifiers of the cards of the space layout.
func ReadStoredParties(space json.RawMessage, project, spaceID string, cards []string) ([]StoredParty, error) {
	var members map[string]json.RawMessage
	if err := json.Unmarshal(space, &members); err != nil {
		return nil, fmt.Errorf("projects.json: project %s, space %s: %w", project, spaceID, err)
	}
	raw, ok := members["parties"]
	if !ok {
		return []StoredParty{}, nil
	}
	found := string(bytes.TrimSpace(raw))
	where := fmt.Sprintf("projects.json: project %s, space %s: parties %s", project, spaceID, found)
	if found == "null" {
		return nil, fmt.Errorf("%s", where)
	}
	var parties []StoredParty
	if err := json.Unmarshal(raw, &parties); err != nil {
		return nil, fmt.Errorf("%s", where)
	}
	if parties == nil {
		return nil, fmt.Errorf("%s", where)
	}
	owner := map[string]string{}
	for _, party := range parties {
		if !checkStoredParty(party, cards, owner) {
			return nil, fmt.Errorf("%s", where)
		}
	}
	return parties, nil
}

// checkStoredParty reports whether a party follows the rules of the storage, and records each of its cards in owner.
func checkStoredParty(party StoredParty, cards []string, owner map[string]string) bool {
	if len(party.Cards) < 2 {
		return false
	}
	for _, card := range party.Cards {
		if !slices.Contains(cards, card) {
			return false
		}
		if _, held := owner[card]; held {
			return false
		}
		owner[card] = party.ID
	}
	if party.Leader != nil && !slices.Contains(party.Cards, *party.Leader) {
		return false
	}
	if !hexColor.MatchString(party.Color) {
		return false
	}
	return party.LeaderColor == nil || hexColor.MatchString(*party.LeaderColor)
}

// WriteStoredParties returns the parties member of a space object. An empty list is written as an empty array.
func WriteStoredParties(parties []StoredParty) (json.RawMessage, error) {
	if parties == nil {
		parties = []StoredParty{}
	}
	text, err := json.Marshal(parties)
	if err != nil {
		return nil, fmt.Errorf("parties: %w", err)
	}
	return text, nil
}
