package layout

import (
	"bytes"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"
)

// Parties holds the parties of one space and runs the party commands over the cards of its grid (docs/spec/parties.md#commands).
// A command validates its whole request before it changes a party, so a refused command changes nothing.
type Parties struct {
	list []*party
}

// party is a group of touching cards. Cards keeps the order in which the cards joined the party.
type party struct {
	ID          string   `json:"id"`
	Cards       []string `json:"cards"`
	Leader      *string  `json:"leader"`
	ColorToken  string   `json:"color_token"`
	LeaderColor *string  `json:"leaderColor"`
}

// partyReply is the reply of create and add: the party, the cards that changed party, and each party that changed.
type partyReply struct {
	Party   any           `json:"party"`
	Taken   []takenCard   `json:"taken"`
	Changed []partyChange `json:"changed"`
}

// takenCard names a card that changed party and the party it left, or null when it had none.
type takenCard struct {
	Card string  `json:"card"`
	From *string `json:"from"`
}

// partyChange names a party that changed: the cards that left it, its leader after the change, and whether it was deleted.
type partyChange struct {
	Party   string   `json:"party"`
	Removed []string `json:"removed"`
	Leader  *string  `json:"leader"`
	Deleted bool     `json:"deleted"`
}

// partyTokens are the theme tokens of the six party colors, in the order a new party takes them.
var partyTokens = []string{"party-1", "party-2", "party-3", "party-4", "party-5", "party-6"}

// NewParties returns a space with no party.
func NewParties() *Parties { return &Parties{} }

// Run runs one party command over the grid and returns its reply. An unknown command or an invalid parameter is an error.
func (p *Parties) Run(g *Grid, call string, params json.RawMessage) (any, error) {
	switch call {
	case "core.party.create":
		var in struct {
			Cards []string `json:"cards"`
			Take  bool     `json:"take"`
		}
		if err := decodeParams(params, &in); err != nil {
			return nil, err
		}
		return p.create(g, in.Cards, in.Take)
	case "core.party.add":
		var in struct {
			Party string `json:"party"`
			Card  string `json:"card"`
			Take  bool   `json:"take"`
		}
		if err := decodeParams(params, &in); err != nil {
			return nil, err
		}
		return p.add(g, in.Party, in.Card, in.Take)
	case "core.party.delete":
		var in struct {
			Party string `json:"party"`
		}
		if err := decodeParams(params, &in); err != nil {
			return nil, err
		}
		return p.deleteParty(in.Party)
	case "core.party.get":
		var in struct {
			Party string `json:"party"`
		}
		if err := decodeParams(params, &in); err != nil {
			return nil, err
		}
		found := p.find(in.Party)
		if found == nil {
			return nil, fmt.Errorf("unknown party %s", in.Party)
		}
		return found, nil
	}
	return nil, fmt.Errorf("unknown party command %s", call)
}

// decodeParams decodes the parameters of a command and refuses a member that the command does not take.
func decodeParams(params json.RawMessage, out any) error {
	decoder := json.NewDecoder(bytes.NewReader(params))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return fmt.Errorf("invalid parameters: %v", err)
	}
	return nil
}

// find returns the party with the identifier, or nil.
func (p *Parties) find(id string) *party {
	for _, item := range p.list {
		if item.ID == id {
			return item
		}
	}
	return nil
}

// partyOf returns the party that holds the card, or nil.
func (p *Parties) partyOf(card string) *party {
	for _, item := range p.list {
		if slices.Contains(item.Cards, card) {
			return item
		}
	}
	return nil
}

// nextID returns the smallest positive p<n> that no party holds.
func (p *Parties) nextID() string {
	for n := 1; ; n++ {
		id := "p" + strconv.Itoa(n)
		if p.find(id) == nil {
			return id
		}
	}
}

// nextToken returns the first party color token that no party uses, or the first token when all six are used.
func (p *Parties) nextToken() string {
	for _, token := range partyTokens {
		used := false
		for _, item := range p.list {
			if item.ColorToken == token {
				used = true
				break
			}
		}
		if !used {
			return token
		}
	}
	return partyTokens[0]
}

// checkCards refuses a card list that names an unknown card or a card twice, and a list of fewer than two cards.
func checkCards(g *Grid, cards []string) error {
	seen := map[string]bool{}
	for _, id := range cards {
		if _, ok := g.Card(id); !ok {
			return fmt.Errorf("unknown card %s", id)
		}
		if seen[id] {
			return fmt.Errorf("card %s is listed more than once", id)
		}
		seen[id] = true
	}
	if len(cards) < 2 {
		return fmt.Errorf("a party needs at least 2 cards")
	}
	return nil
}

// checkConnected refuses a card list that does not form one group of touching cards.
func checkConnected(g *Grid, cards []string) error {
	rects := make([]Card, len(cards))
	for i, id := range cards {
		card, ok := g.Card(id)
		if !ok {
			return fmt.Errorf("unknown card %s", id)
		}
		rects[i] = card
	}
	reached := map[int]bool{0: true}
	queue := []int{0}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		for next := range rects {
			if !reached[next] && Touches(rects[current], rects[next]) {
				reached[next] = true
				queue = append(queue, next)
			}
		}
	}
	if len(reached) != len(cards) {
		return fmt.Errorf("cards are not touching: %s", strings.Join(cards, ", "))
	}
	return nil
}

// create makes a party from the cards, or returns the party that holds exactly these cards.
func (p *Parties) create(g *Grid, cards []string, take bool) (partyReply, error) {
	if err := checkCards(g, cards); err != nil {
		return partyReply{}, err
	}
	for _, existing := range p.list {
		if sameSet(existing.Cards, cards) {
			return partyReply{Party: existing, Taken: []takenCard{}, Changed: []partyChange{}}, nil
		}
	}
	if err := checkConnected(g, cards); err != nil {
		return partyReply{}, err
	}
	for _, id := range cards {
		if owner := p.partyOf(id); owner != nil && !take {
			return partyReply{}, fmt.Errorf("card %s belongs to party %s", id, owner.ID)
		}
	}
	fresh := &party{ID: p.nextID(), Cards: slices.Clone(cards), ColorToken: p.nextToken()}
	return p.join(g, fresh, cards, "created"), nil
}

// add adds a touching card to a party, and moves the card out of its former party when take is true.
func (p *Parties) add(g *Grid, partyID, card string, take bool) (partyReply, error) {
	if _, ok := g.Card(card); !ok {
		return partyReply{}, fmt.Errorf("unknown card %s", card)
	}
	target := p.find(partyID)
	if target == nil {
		return partyReply{}, fmt.Errorf("unknown party %s", partyID)
	}
	if slices.Contains(target.Cards, card) {
		return partyReply{Party: target, Taken: []takenCard{}, Changed: []partyChange{}}, nil
	}
	if owner := p.partyOf(card); owner != nil && !take {
		return partyReply{}, fmt.Errorf("card %s belongs to party %s", card, owner.ID)
	}
	members := append(slices.Clone(target.Cards), card)
	if err := checkConnected(g, members); err != nil {
		return partyReply{}, err
	}
	return p.join(g, target, []string{card}, "added"), nil
}

// join moves the cards into the party. Each former party loses the cards, drops its leader when the leader moved, and is
// deleted when it keeps fewer than 2 cards. The former parties are listed before the party that the cards join.
func (p *Parties) join(g *Grid, target *party, cards []string, reason string) partyReply {
	taken := []takenCard{}
	changed := []partyChange{}
	for _, card := range cards {
		owner := p.partyOf(card)
		// A card with no former party, or one already in the target party, changed no party and is not listed.
		if owner == nil || owner == target {
			continue
		}
		owner.Cards = slices.DeleteFunc(owner.Cards, func(id string) bool { return id == card })
		if owner.Leader != nil && *owner.Leader == card {
			owner.Leader = nil
		}
		id := owner.ID
		taken = append(taken, takenCard{Card: card, From: &id})
	}
	for _, card := range cards {
		if !slices.Contains(target.Cards, card) {
			target.Cards = append(target.Cards, card)
		}
	}
	// Former parties come first in the changes, as the taken cards list them.
	for _, record := range taken {
		if record.From == nil {
			continue
		}
		owner := p.find(*record.From)
		if owner == nil || slices.ContainsFunc(changed, func(c partyChange) bool { return c.Party == owner.ID }) {
			continue
		}
		removed := []string{}
		for _, other := range taken {
			if other.From != nil && *other.From == owner.ID {
				removed = append(removed, other.Card)
			}
		}
		change := partyChange{Party: owner.ID, Removed: removed, Leader: owner.Leader}
		if len(owner.Cards) < 2 {
			change.Deleted = true
			change.Leader = nil
			p.list = slices.DeleteFunc(p.list, func(item *party) bool { return item == owner })
		}
		changed = append(changed, change)
	}
	if !slices.ContainsFunc(p.list, func(item *party) bool { return item == target }) {
		p.list = append(p.list, target)
	}
	changed = append(changed, partyChange{Party: target.ID, Removed: []string{}, Leader: target.Leader})
	return partyReply{Party: withReason(target, reason), Taken: taken, Changed: changed}
}

// withReason returns the party record with the reason of the command that made the change, as the reply of create carries it.
func withReason(target *party, reason string) any {
	if reason == "created" {
		return struct {
			*party
			Reason string `json:"reason"`
		}{target, reason}
	}
	return target
}

// deleteParty removes the party and keeps its cards in the layout.
func (p *Parties) deleteParty(id string) (any, error) {
	target := p.find(id)
	if target == nil {
		return nil, fmt.Errorf("unknown party %s", id)
	}
	change := partyChange{Party: id, Removed: slices.Clone(target.Cards), Leader: nil, Deleted: true}
	p.list = slices.DeleteFunc(p.list, func(item *party) bool { return item == target })
	return struct {
		Party   map[string]string `json:"party"`
		Changed []partyChange     `json:"changed"`
	}{map[string]string{"id": id}, []partyChange{change}}, nil
}

// sameSet tells whether two card lists hold the same cards.
func sameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for _, id := range a {
		if !slices.Contains(b, id) {
			return false
		}
	}
	return true
}
