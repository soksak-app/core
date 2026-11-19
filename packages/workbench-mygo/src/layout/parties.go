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
	// palette holds the party theme tokens of the shown theme and mode, token to #rrggbb value, read from the declaration.
	palette map[string]string
	// rail is the rail width of the theme in points. The party border takes it, and each outline is inset by half of it.
	rail float64
}

// party is a group of touching cards. Cards keeps the order in which the cards joined the party.
type party struct {
	ID          string
	Cards       []string
	Leader      *string
	Color       string
	LeaderColor *string
	Reason      *string
}

// partyView is the party record of a reply: the color is the theme token that holds the value, or null for a color that the person chose.
type partyView struct {
	ID          string   `json:"id"`
	Cards       []string `json:"cards"`
	Leader      *string  `json:"leader"`
	ColorToken  *string  `json:"color_token"`
	LeaderColor *string  `json:"leaderColor"`
	Reason      *string  `json:"reason"`
}

// view returns the record of a party for a reply.
func (p *Parties) view(target *party) partyView {
	var token *string
	for _, name := range partyTokens {
		if value, ok := p.palette[name]; ok && value == target.Color {
			found := name
			token = &found
			break
		}
	}
	return partyView{ID: target.ID, Cards: target.Cards, Leader: target.Leader, ColorToken: token, LeaderColor: target.LeaderColor, Reason: target.Reason}
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

// cardState is the card query of docs/spec/parties.md#queries: the holding party, whether the card leads it, and its tabs.
type cardState struct {
	Card      string     `json:"card"`
	Party     *string    `json:"party"`
	Leader    bool       `json:"leader"`
	ActiveTab *string    `json:"activeTab"`
	Tabs      []tabState `json:"tabs"`
}

// tabState is one tab of a card state. Status is empty: the statuses that a plugin declares with summary are not read by this model.
type tabState struct {
	Tab    string            `json:"tab"`
	Plugin string            `json:"plugin"`
	Status map[string]string `json:"status"`
}

// partyTokens are the theme tokens of the six party colors, in the order a new party takes them.
var partyTokens = []string{"party-1", "party-2", "party-3", "party-4", "party-5", "party-6"}

// NewParties returns a space with no party. palette holds the party theme tokens of the shown theme and mode, token to #rrggbb value,
// as the declaration of workbench.json states them (docs/spec/parties.md#identity-and-values). rail is the rail width of the theme in
// points (docs/spec/parties.md#drawing).
func NewParties(palette map[string]string, rail float64) *Parties {
	return &Parties{palette: palette, rail: rail}
}

// Run runs one party command over the grid and returns its reply. An unknown command or an invalid parameter is an error.
func (p *Parties) Run(g *Grid, call string, params json.RawMessage) (any, error) {
	switch call {
	case "core.party.create":
		var in struct {
			Cards       []string `json:"cards"`
			Take        bool     `json:"take"`
			Color       *string  `json:"color"`
			Leader      *string  `json:"leader"`
			LeaderColor *string  `json:"leaderColor"`
		}
		if err := decodeParams(params, &in); err != nil {
			return nil, err
		}
		return p.create(g, in.Cards, in.Take, in.Color, in.Leader, in.LeaderColor)
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
	case "core.party.remove":
		var in struct {
			Party string `json:"party"`
			Card  string `json:"card"`
		}
		if err := decodeParams(params, &in); err != nil {
			return nil, err
		}
		return p.remove(g, in.Party, in.Card)
	case "core.party.update":
		var in struct {
			Party       string          `json:"party"`
			Color       *string         `json:"color"`
			Leader      json.RawMessage `json:"leader"`
			LeaderColor json.RawMessage `json:"leaderColor"`
		}
		if err := decodeParams(params, &in); err != nil {
			return nil, err
		}
		return p.update(in.Party, in.Color, in.Leader, in.LeaderColor)
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
		return p.record(g, found)
	case "core.card.get":
		var in struct {
			Card string `json:"card"`
		}
		if err := decodeParams(params, &in); err != nil {
			return nil, err
		}
		return p.cardGet(g, in.Card)
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

// nextColor returns the value of the first party theme token that no party uses, or of the first token when all six are used.
func (p *Parties) nextColor() (string, error) {
	for _, token := range partyTokens {
		value, ok := p.palette[token]
		if !ok {
			return "", fmt.Errorf("the theme palette has no %s", token)
		}
		used := false
		for _, item := range p.list {
			if item.Color == value {
				used = true
				break
			}
		}
		if !used {
			return value, nil
		}
	}
	return p.palette[partyTokens[0]], nil
}

// checkCards refuses a card list in the order of the refusal table (docs/spec/parties.md#commands): an unknown card, a window
// sidebar, a card listed twice, and a list of fewer than two cards.
func checkCards(g *Grid, cards []string) error {
	for _, id := range cards {
		if _, ok := g.Card(id); !ok {
			return fmt.Errorf("unknown card %s", id)
		}
	}
	for _, id := range cards {
		if slices.Contains(SidebarSides, id) {
			return fmt.Errorf("card %s is a window sidebar", id)
		}
	}
	seen := map[string]bool{}
	for _, id := range cards {
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

// groups returns the connected groups of touching cards, each group in the order of the cards, and the groups in the order of their first card.
func groups(g *Grid, cards []string) ([][]string, error) {
	rects := make([]Card, len(cards))
	for i, id := range cards {
		card, ok := g.Card(id)
		if !ok {
			return nil, fmt.Errorf("unknown card %s", id)
		}
		rects[i] = card
	}
	done := make([]bool, len(cards))
	var out [][]string
	for start := range cards {
		if done[start] {
			continue
		}
		done[start] = true
		group := []int{start}
		for next := 0; next < len(group); next++ {
			for other := range cards {
				if !done[other] && Touches(rects[group[next]], rects[other]) {
					done[other] = true
					group = append(group, other)
				}
			}
		}
		slices.Sort(group)
		members := make([]string, len(group))
		for i, index := range group {
			members[i] = cards[index]
		}
		out = append(out, members)
	}
	return out, nil
}

// checkConnected refuses a card list whose cards outside the group of its first card. The refusal lists those cards in request order.
func checkConnected(g *Grid, cards []string) error {
	parts, err := groups(g, cards)
	if err != nil {
		return err
	}
	var anchor []string
	for _, part := range parts {
		if slices.Contains(part, cards[0]) {
			anchor = part
		}
	}
	outside := []string{}
	for _, card := range cards {
		if !slices.Contains(anchor, card) {
			outside = append(outside, card)
		}
	}
	if len(outside) > 0 {
		return fmt.Errorf("cards are not touching: %s", strings.Join(outside, ", "))
	}
	return nil
}

// spaceIndex returns the position of the card in the space order, which is the order in which the grid holds its cards.
func spaceIndex(g *Grid, card string) int {
	for i, c := range g.Cards() {
		if c.ID == card {
			return i
		}
	}
	return -1
}

// inSpaceOrder returns the cards in the space order.
func inSpaceOrder(g *Grid, cards []string) []string {
	out := slices.Clone(cards)
	slices.SortFunc(out, func(a, b string) int { return spaceIndex(g, a) - spaceIndex(g, b) })
	return out
}

// splitRule applies the split rule of docs/spec/parties.md#changes-of-the-layout to the cards that remain of a party. The part with
// the leader stays. Without a leader the part with the most cards stays, and equal counts keep the part whose first card comes first
// in the space order. It returns the kept cards and the reason, or an empty reason when the cards still form one group.
func splitRule(g *Grid, target *party, cards []string) ([]string, string, error) {
	parts, err := groups(g, cards)
	if err != nil {
		return nil, "", err
	}
	if len(parts) <= 1 {
		return cards, "", nil
	}
	if target.Leader != nil {
		for _, part := range parts {
			if slices.Contains(part, *target.Leader) {
				return inSpaceOrder(g, part), "split-leader", nil
			}
		}
	}
	first := func(part []string) int { return spaceIndex(g, inSpaceOrder(g, part)[0]) }
	slices.SortStableFunc(parts, func(a, b []string) int {
		if len(a) != len(b) {
			return len(b) - len(a)
		}
		return first(a) - first(b)
	})
	return inSpaceOrder(g, parts[0]), "split-most-cards", nil
}

// settle applies the split rule to a party after its cards changed and deletes it when it keeps fewer than 2 cards. before holds the
// cards before the change; the change lists the cards of before that the party no longer holds.
func (p *Parties) settle(g *Grid, target *party, before []string, reason string) (partyChange, error) {
	reasonText := reason
	if len(target.Cards) >= 2 {
		kept, split, err := splitRule(g, target, target.Cards)
		if err != nil {
			return partyChange{}, err
		}
		if split != "" {
			target.Cards = kept
			if target.Leader != nil && !slices.Contains(kept, *target.Leader) {
				target.Leader = nil
			}
			reasonText = split
		}
	}
	deleted := len(target.Cards) < 2
	if deleted {
		reasonText = "too-few"
	}
	target.Reason = &reasonText
	removed := []string{}
	for _, card := range before {
		if deleted || !slices.Contains(target.Cards, card) {
			removed = append(removed, card)
		}
	}
	change := partyChange{Party: target.ID, Removed: removed, Leader: target.Leader, Deleted: deleted}
	if deleted {
		change.Leader = nil
		p.list = slices.DeleteFunc(p.list, func(item *party) bool { return item == target })
	}
	return change, nil
}

// create makes a party from the cards, or returns the party that holds exactly these cards.
func (p *Parties) create(g *Grid, cards []string, take bool, color, leader, leaderColor *string) (partyReply, error) {
	if err := checkCards(g, cards); err != nil {
		return partyReply{}, err
	}
	for _, existing := range p.list {
		if sameSet(existing.Cards, cards) {
			return partyReply{Party: p.view(existing), Taken: []takenCard{}, Changed: []partyChange{}}, nil
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
	if leader != nil && !slices.Contains(cards, *leader) {
		return partyReply{}, fmt.Errorf("leader %s is not in the party", *leader)
	}
	if err := checkColors(color, leaderColor); err != nil {
		return partyReply{}, err
	}
	// The identifier is the smallest one that no party holds when the party is created, so it is chosen before a former party is settled.
	chosen := ""
	if color != nil {
		chosen = *color
	} else {
		value, err := p.nextColor()
		if err != nil {
			return partyReply{}, err
		}
		chosen = value
	}
	fresh := &party{ID: p.nextID(), Cards: slices.Clone(cards), Leader: leader, Color: chosen, LeaderColor: leaderColor}
	return p.join(g, fresh, cards, "created")
}

// checkColors refuses a color that is not #rrggbb.
func checkColors(color, leaderColor *string) error {
	if color != nil && !hexColor.MatchString(*color) {
		return fmt.Errorf("color must be #rrggbb")
	}
	if leaderColor != nil && !hexColor.MatchString(*leaderColor) {
		return fmt.Errorf("color must be #rrggbb")
	}
	return nil
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
		return partyReply{Party: p.view(target), Taken: []takenCard{}, Changed: []partyChange{}}, nil
	}
	if owner := p.partyOf(card); owner != nil && !take {
		return partyReply{}, fmt.Errorf("card %s belongs to party %s", card, owner.ID)
	}
	members := append(slices.Clone(target.Cards), card)
	if err := checkConnected(g, members); err != nil {
		return partyReply{}, err
	}
	return p.join(g, target, []string{card}, "added")
}

// join moves the cards into the party. Each former party loses the cards, drops its leader when the leader moved, and is
// deleted when it keeps fewer than 2 cards. The former parties are listed before the party that the cards join.
func (p *Parties) join(g *Grid, target *party, cards []string, reason string) (partyReply, error) {
	taken := []takenCard{}
	changed := []partyChange{}
	formerBefore := map[string][]string{}
	for _, card := range cards {
		owner := p.partyOf(card)
		// A card with no former party, or one already in the target party, changed no party and is not listed.
		if owner == nil || owner == target {
			continue
		}
		if _, seen := formerBefore[owner.ID]; !seen {
			formerBefore[owner.ID] = slices.Clone(owner.Cards)
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
	// Former parties come first in the changes, in the order in which the cards left them.
	for _, record := range taken {
		owner := p.find(*record.From)
		if owner == nil || slices.ContainsFunc(changed, func(c partyChange) bool { return c.Party == owner.ID }) {
			continue
		}
		change, err := p.settle(g, owner, formerBefore[owner.ID], "taken")
		if err != nil {
			return partyReply{}, err
		}
		changed = append(changed, change)
	}
	if !slices.ContainsFunc(p.list, func(item *party) bool { return item == target }) {
		p.list = append(p.list, target)
	}
	target.Reason = &reason
	changed = append(changed, partyChange{Party: target.ID, Removed: []string{}, Leader: target.Leader})
	return partyReply{Party: p.view(target), Taken: taken, Changed: changed}, nil
}

// remove removes a card from a party and applies the split rule to the cards that remain. A card that the party does not hold is refused.
func (p *Parties) remove(g *Grid, partyID, card string) (any, error) {
	target := p.find(partyID)
	if target == nil {
		return nil, fmt.Errorf("unknown party %s", partyID)
	}
	if !slices.Contains(target.Cards, card) {
		return nil, fmt.Errorf("card %s is not in party %s", card, partyID)
	}
	before := slices.Clone(target.Cards)
	target.Cards = slices.DeleteFunc(target.Cards, func(id string) bool { return id == card })
	if target.Leader != nil && *target.Leader == card {
		target.Leader = nil
	}
	change, err := p.settle(g, target, before, "removed")
	if err != nil {
		return nil, err
	}
	var record any = p.view(target)
	if change.Deleted {
		record = nil
	}
	return struct {
		Party   any           `json:"party"`
		Changed []partyChange `json:"changed"`
	}{record, []partyChange{change}}, nil
}

// update sets the leader and the leader color of a party. A leader is null or a card of the party, and a leader color is null or
// a #rrggbb value. A change of the party color is refused until the model reads the theme palette (see checkColors).
func (p *Parties) update(partyID string, color *string, leader, leaderColor json.RawMessage) (any, error) {
	target := p.find(partyID)
	if target == nil {
		return nil, fmt.Errorf("unknown party %s", partyID)
	}
	if err := checkColors(color, optionalColor(leaderColor)); err != nil {
		return nil, err
	}
	var nextLeader *string
	setLeader := len(leader) > 0
	if setLeader && string(leader) != "null" {
		var id string
		if err := json.Unmarshal(leader, &id); err != nil {
			return nil, fmt.Errorf("invalid parameters: leader must be a card identifier or null")
		}
		if !slices.Contains(target.Cards, id) {
			return nil, fmt.Errorf("leader %s is not in the party", id)
		}
		nextLeader = &id
	}
	before := target.Color + "|" + strOrNull(target.Leader) + "|" + strOrNull(target.LeaderColor)
	if color != nil {
		target.Color = *color
	}
	if setLeader {
		target.Leader = nextLeader
	}
	if len(leaderColor) > 0 {
		target.LeaderColor = optionalColor(leaderColor)
	}
	changed := []partyChange{}
	if target.Color+"|"+strOrNull(target.Leader)+"|"+strOrNull(target.LeaderColor) != before {
		reason := "updated"
		target.Reason = &reason
		changed = append(changed, partyChange{Party: target.ID, Removed: []string{}, Leader: target.Leader})
	}
	return struct {
		Party   partyView     `json:"party"`
		Changed []partyChange `json:"changed"`
	}{p.view(target), changed}, nil
}

// strOrNull names a member that is a string or null, so two states compare by their values.
func strOrNull(value *string) string {
	if value == nil {
		return "null"
	}
	return *value
}

// optionalColor decodes a color member that is null or a #rrggbb string, and returns nil for null or an absent member.
func optionalColor(raw json.RawMessage) *string {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return &value
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

// cardGet reads the state of one card, whether or not a party holds it (docs/spec/parties.md#queries).
func (p *Parties) cardGet(g *Grid, id string) (cardState, error) {
	card, ok := g.Card(id)
	if !ok {
		return cardState{}, fmt.Errorf("unknown card %s", id)
	}
	state := cardState{Card: id, Tabs: []tabState{}}
	if owner := p.partyOf(id); owner != nil {
		holder := owner.ID
		state.Party = &holder
		state.Leader = owner.Leader != nil && *owner.Leader == id
	}
	data, err := DecodeCardData(card.Data)
	if err != nil {
		return cardState{}, err
	}
	if data != nil {
		for _, tab := range data.Tabs {
			state.Tabs = append(state.Tabs, tabState{Tab: tab.ID, Plugin: tab.Plugin, Status: map[string]string{}})
		}
		if data.activeSet {
			active := data.activeText
			state.ActiveTab = &active
		}
	}
	return state, nil
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

// Outline returns the loops of the outer outline of a party: the outline of the presented rectangles of its cards, with adjacent
// cards joined at half the gap and the outline inset by half the border width (docs/spec/parties.md#drawing).
func (p *Parties) Outline(g *Grid, partyID string) ([][]Point, error) {
	target := p.find(partyID)
	if target == nil {
		return nil, fmt.Errorf("unknown party %s", partyID)
	}
	outline, err := p.outline(g, target.Cards)
	if err != nil {
		return nil, err
	}
	return outline.Loops, nil
}

// outline returns the outline of the presented rectangles of cards, with adjacent cards joined at half the gap and the outline inset
// by half the border width.
func (p *Parties) outline(g *Grid, cards []string) (Outline, error) {
	rects := make([]Rect, 0, len(cards))
	for _, id := range cards {
		rect, ok := g.Rect(id)
		if !ok {
			return Outline{}, fmt.Errorf("unknown card %s", id)
		}
		rects = append(rects, rect)
	}
	pad, inset := g.Gap()/2, p.rail/2
	return ComputeOutline(rects, OutlineOptions{Pad: &pad, Inset: &inset}), nil
}

// Drawing is what the window draws for a party (docs/spec/parties.md#drawing): its outer outline in its color, and the sides of
// that outline on the border of its leader card in the leader color. Width is the border width, the rail width of the theme.
type Drawing struct {
	Party       string
	Outline     Outline
	Color       string
	Leader      [][2]Point
	LeaderColor string
	Width       float64
}

// Drawings returns the drawing of each party, in the order of the parties. A party with no leader has no leader sides, and a party
// with no leader color draws its leader sides in the theme token party-leader.
func (p *Parties) Drawings(g *Grid) ([]Drawing, error) {
	out := []Drawing{}
	for _, item := range p.list {
		outline, err := p.outline(g, item.Cards)
		if err != nil {
			return nil, fmt.Errorf("party %s: %w", item.ID, err)
		}
		drawing := Drawing{Party: item.ID, Outline: outline, Color: item.Color, Width: p.rail}
		if item.Leader != nil {
			own, err := p.outline(g, []string{*item.Leader})
			if err != nil {
				return nil, fmt.Errorf("party %s: %w", item.ID, err)
			}
			drawing.Leader = leaderBorder(outline.Loops, own.Loops)
			if item.LeaderColor != nil {
				drawing.LeaderColor = *item.LeaderColor
			} else if value, ok := p.palette["party-leader"]; ok {
				drawing.LeaderColor = value
			} else {
				return nil, fmt.Errorf("party %s: the palette has no party-leader", item.ID)
			}
		}
		out = append(out, drawing)
	}
	return out, nil
}

// loopSides returns the sides of loops, each from a point to the next point of its loop.
func loopSides(loops [][]Point) [][2]Point {
	sides := [][2]Point{}
	for _, loop := range loops {
		for i, point := range loop {
			sides = append(sides, [2]Point{point, loop[(i+1)%len(loop)]})
		}
	}
	return sides
}

// leaderBorder returns the parts of the party outline that lie on the outline of the leader card: the overlap of each side of the
// party outline with each side of the leader card's own outline on the same line.
func leaderBorder(loops, leaderLoops [][]Point) [][2]Point {
	borders := loopSides(leaderLoops)
	out := [][2]Point{}
	for _, side := range loopSides(loops) {
		for _, border := range borders {
			if shared, ok := sharedPart(side, border); ok {
				out = append(out, shared)
			}
		}
	}
	return out
}

// sharedPart returns the overlap of two axis-aligned sides on the same line, and false when they do not overlap.
func sharedPart(a, b [2]Point) ([2]Point, bool) {
	horizontal := a[0].Y == a[1].Y && b[0].Y == b[1].Y && a[0].Y == b[0].Y
	vertical := a[0].X == a[1].X && b[0].X == b[1].X && a[0].X == b[0].X
	if !horizontal && !vertical {
		return [2]Point{}, false
	}
	along := func(p Point) float64 {
		if horizontal {
			return p.X
		}
		return p.Y
	}
	lo := max(min(along(a[0]), along(a[1])), min(along(b[0]), along(b[1])))
	hi := min(max(along(a[0]), along(a[1])), max(along(b[0]), along(b[1])))
	if !(lo < hi) {
		return [2]Point{}, false
	}
	if horizontal {
		return [2]Point{{X: lo, Y: a[0].Y}, {X: hi, Y: a[0].Y}}, true
	}
	return [2]Point{{X: a[0].X, Y: lo}, {X: a[0].X, Y: hi}}, true
}

// Restore replaces the parties of the space with the stored parties. Each party must hold cards of the grid that touch, and a
// leader of its cards. A refused party names its identifier and leaves the parties of the space unchanged.
func (p *Parties) Restore(g *Grid, stored []StoredParty) error {
	restored := []*party{}
	for _, item := range stored {
		if err := checkCards(g, item.Cards); err != nil {
			return fmt.Errorf("party %s: %w", item.ID, err)
		}
		if err := checkConnected(g, item.Cards); err != nil {
			return fmt.Errorf("party %s: %w", item.ID, err)
		}
		if item.Leader != nil && !slices.Contains(item.Cards, *item.Leader) {
			return fmt.Errorf("party %s: leader %s is not in the party", item.ID, *item.Leader)
		}
		restored = append(restored, &party{ID: item.ID, Cards: slices.Clone(item.Cards), Leader: item.Leader, Color: item.Color, LeaderColor: item.LeaderColor})
	}
	p.list = restored
	return nil
}

// Stored returns the parties of the space in the form of the storage, in the order of the parties.
func (p *Parties) Stored() []StoredParty {
	out := []StoredParty{}
	for _, item := range p.list {
		out = append(out, StoredParty{ID: item.ID, Cards: slices.Clone(item.Cards), Leader: item.Leader, Color: item.Color, LeaderColor: item.LeaderColor})
	}
	return out
}

// Record is a party of the status core.parties: its stored fields, its outline as [x, y] pairs in window points, and the reason of its
// last change.
type Record struct {
	ID          string         `json:"id"`
	Cards       []string       `json:"cards"`
	Leader      *string        `json:"leader"`
	Color       string         `json:"color"`
	LeaderColor *string        `json:"leaderColor"`
	Outline     [][][2]float64 `json:"outline"`
	Reason      *string        `json:"reason"`
}

// Records returns one record for each party, in the order of the parties (docs/spec/parties.md#commands).
func (p *Parties) Records(g *Grid) ([]Record, error) {
	out := []Record{}
	for _, item := range p.list {
		record, err := p.record(g, item)
		if err != nil {
			return nil, err
		}
		out = append(out, record)
	}
	return out, nil
}

// record returns the record of a party, with its outline in points (docs/spec/parties.md#queries).
func (p *Parties) record(g *Grid, target *party) (Record, error) {
	loops, err := p.Outline(g, target.ID)
	if err != nil {
		return Record{}, err
	}
	pairs := [][][2]float64{}
	for _, loop := range loops {
		next := [][2]float64{}
		for _, point := range loop {
			next = append(next, [2]float64{point.X, point.Y})
		}
		pairs = append(pairs, next)
	}
	return Record{ID: target.ID, Cards: slices.Clone(target.Cards), Leader: target.Leader, Color: target.Color, LeaderColor: target.LeaderColor, Outline: pairs, Reason: target.Reason}, nil
}
