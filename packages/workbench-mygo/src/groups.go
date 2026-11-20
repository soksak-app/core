package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
	"unicode/utf8"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The group cards of the shown space (docs/spec/groups.md): the group tree that the workbench holds beside the grid, the commands
// core.group.*, core.card.move and core.card.get, and the reads of the cards of every level.

// groupOptions are the sizes that the group tree of the shown space draws with: the head height of a card, and whether the cards share
// one line at the seam.
func (s *Shell) groupOptions() layout.GroupOptions {
	return layout.GroupOptions{Head: float64(s.metrics.headH), Seam: s.palette.Seam()}
}

// allCards is every card of every level of the shown space in workbench order, a group card with its span.
func (s *Shell) allCards() []layout.Card {
	if s.planes == nil {
		return nil
	}
	cards := []layout.Card{}
	for _, id := range s.planes.Cards() {
		card, _ := s.planes.Card(id) // silent: Cards lists cards of the space.
		cards = append(cards, card)
	}
	return cards
}

// contentCards is the cards of every level of the shown space that are not group cards, in workbench order.
func (s *Shell) contentCards() []layout.Card {
	cards := []layout.Card{}
	for _, card := range s.allCards() {
		if !s.planes.IsGroup(card.ID) {
			cards = append(cards, card)
		}
	}
	return cards
}

// isGroup tells whether id is a group card of the shown space.
func (s *Shell) isGroup(id string) bool { return s.planes != nil && s.planes.IsGroup(id) }

// findCard is the card id of any plane of the shown space.
func (s *Shell) findCard(id string) (layout.Card, bool) {
	if s.planes == nil {
		return layout.Card{}, false
	}
	return s.planes.Card(id)
}

// groupCard refuses an id that is no card of the shown space, and returns the id of a card of any plane.
func (s *Shell) groupCard(id string) error {
	if err := s.requirePlane(); err != nil {
		return err
	}
	if _, ok := s.findCard(id); !ok {
		_, err := s.layoutCard(id)
		return err
	}
	return nil
}

type groupCreateParam struct {
	Card    string          `json:"card"`
	Side    string          `json:"side"`
	Plugin  string          `json:"plugin"`
	Params  json.RawMessage `json:"params,omitempty"`
	Request json.RawMessage `json:"request,omitempty"`
}

// groupRequest is the request of value, "" without one, or the refusal of a request that is no string of 1 to 128 characters.
func groupRequest(value groupCreateParam) (string, error) {
	if value.Request == nil {
		return "", nil
	}
	var request string
	if err := json.Unmarshal(value.Request, &request); err != nil || request == "" || utf8.RuneCountInString(request) > 128 {
		return "", errors.New("core.group.create: request must be a string of 1 to 128 characters")
	}
	return request, nil
}

type groupParam struct {
	Group string `json:"group"`
	// Name is omitted when empty, so a run of the workbench gives a command only the members that it declares.
	Name string `json:"name,omitempty"`
}

type cardMoveParam struct {
	Card   string        `json:"card"`
	Target layout.Target `json:"target"`
	Side   string        `json:"side"`
	Index  *int          `json:"index,omitempty"`
}

// joinStrip joins every tab of the content card card, in its order, to the content card into at index, and closes card
// (docs/spec/groups.md#commands); the active tab of card is the active tab of into.
func (s *Shell) joinStrip(card, into string, index *int) (any, error) {
	if index == nil {
		return nil, errors.New("index is required with side strip")
	}
	from, err := s.cardData(card)
	if err != nil {
		return nil, err
	}
	target, err := s.cardData(into)
	if err != nil {
		return nil, err
	}
	if count := len(target.TabList()); *index < 0 || *index > count {
		return nil, fmt.Errorf("index %d is outside the tabs of card %s, 0 to %d", *index, into, count)
	}
	if !s.planes.CanClose(card) {
		return nil, fmt.Errorf("card %s cannot move to strip of %s", card, into)
	}
	target.InsertTabs(*index, from.TabList()...)
	if active := from.ActiveTab(); active != nil {
		target.SelectTab(active.ID)
	}
	if err := s.storeCard(into, target); err != nil {
		return nil, err
	}
	if _, err := s.planes.Close(card); err != nil {
		return nil, err
	}
	delete(s.operated, card)
	s.focusCard(into)
	s.settle()
	return map[string]string{"card": card}, nil
}

// registerGroups registers the commands of group cards and the card query.
func (s *Shell) registerGroups() {
	command(s, "core.group.create", func(value groupCreateParam) (any, error) { return s.createGroup(value) })
	command(s, "core.group.dissolve", func(value groupParam) (any, error) {
		if s.dissolved[value.Group] {
			return map[string]bool{"dissolved": true}, nil
		}
		if err := s.groupCard(value.Group); err != nil {
			return nil, err
		}
		if err := s.layoutChangeable(value.Group); err != nil {
			return nil, err
		}
		if err := s.planes.Dissolve(value.Group); err != nil {
			return nil, err
		}
		s.dissolved[value.Group] = true
		s.settle()
		return map[string]bool{"dissolved": true}, nil
	})
	command(s, "core.group.rename", func(value groupParam) (any, error) {
		if err := s.groupCard(value.Group); err != nil {
			return nil, err
		}
		if !s.isGroup(value.Group) {
			return nil, fmt.Errorf("card %s is not a group", value.Group)
		}
		if s.planes.GroupName(value.Group) == value.Name {
			return map[string]string{"group": value.Group, "name": value.Name}, nil
		}
		name, err := s.planes.Rename(value.Group, value.Name)
		if err != nil {
			return nil, err
		}
		s.settle()
		return map[string]string{"group": value.Group, "name": name}, nil
	})
	command(s, "core.group.leader", func(value cardParam) (any, error) {
		if err := s.groupCard(value.Card); err != nil {
			return nil, err
		}
		key := s.planes.Parent(value.Card)
		if leader, ok := s.planes.Leader(key); !ok || leader != value.Card {
			if _, err := s.planes.SetLeader(value.Card); err != nil {
				return nil, err
			}
			s.settle()
		}
		var group *string
		if key != "" {
			group = &key
		}
		return map[string]any{"card": value.Card, "group": group}, nil
	})
	command(s, "core.card.move", func(value cardMoveParam) (any, error) {
		if err := s.groupCard(value.Card); err != nil {
			return nil, err
		}
		for _, target := range value.Target {
			if err := s.groupCard(target); err != nil {
				return nil, err
			}
		}
		if err := s.layoutChangeable(value.Card); err != nil {
			return nil, err
		}
		if value.Index != nil && value.Side != "strip" {
			return nil, errors.New("index is given with side strip only")
		}
		if err := s.planes.CheckMove(value.Card, value.Target, value.Side); err != nil {
			return nil, err
		}
		if value.Side == "strip" {
			return s.joinStrip(value.Card, value.Target[0], value.Index)
		}
		if s.planes.Moved(value.Card, value.Target, value.Side) {
			return map[string]string{"card": value.Card}, nil
		}
		if err := s.planes.Move(value.Card, value.Target, value.Side); err != nil {
			return nil, err
		}
		s.focusCard(s.planes.Focusable(value.Card))
		s.settle()
		return map[string]string{"card": value.Card}, nil
	})
	later(s, "core.card.get", func(value cardParam, answer func(any, error)) { s.cardGet(value.Card, answer) })
	act(s, "core.group.menu", func(value groupParam) error {
		if err := s.requirePlane(); err != nil {
			return err
		}
		return s.openGroupMenu(value.Group, "core.group.close/"+value.Group)
	})
}

// createGroup runs core.group.create: the refusals in the order of docs/spec/groups.md#commands, the repetition that finds the group
// that the same command made, and the group with a new card of plugin toward side.
func (s *Shell) createGroup(value groupCreateParam) (any, error) {
	request, err := groupRequest(value)
	if err != nil {
		return nil, err
	}
	// A request that the space answered answers again with its first answer; a new request groups also where the group stands.
	if answer, ok := s.groupRequests[s.planeSpace][request]; request != "" && ok {
		return answer, nil
	}
	if err := s.groupCard(value.Card); err != nil {
		return nil, err
	}
	if err := s.layoutChangeable(value.Card); err != nil {
		return nil, err
	}
	if request == "" {
		if repeated, ok, err := s.createdGroup(value); err != nil || ok {
			return repeated, err
		}
	}
	if err := s.planes.CheckGroup(value.Card, value.Side); err != nil {
		return nil, err
	}
	known, err := s.knownPlugin(value.Plugin)
	if err != nil {
		return nil, err
	}
	checked, err := checkTabParams(known, value.Params)
	if err != nil {
		return nil, err
	}
	var from *layout.Tab
	if !s.isGroup(value.Card) {
		data, err := s.cardData(value.Card)
		if err != nil {
			return nil, err
		}
		from = data.ActiveTab()
	}
	tab, err := s.newTabOf(known, from)
	if err != nil {
		return nil, err
	}
	if checked != nil {
		tab.Rest["params"] = checked
	}
	encoded, err := json.Marshal(tabData([]layout.Tab{tab}, tab.ID))
	if err != nil {
		return nil, err
	}
	group, born, err := s.planes.CreateGroup(value.Card, value.Side, encoded)
	if err != nil {
		// A refused command changes nothing, so the number of the title of the new tab is not taken.
		s.tabsNamed--
		return nil, err
	}
	s.focusCard(born)
	s.settle()
	answer := map[string]string{"group": group, "card": born, "tab": tab.ID}
	if request != "" {
		if s.groupRequests[s.planeSpace] == nil {
			s.groupRequests[s.planeSpace] = map[string]map[string]string{}
		}
		s.groupRequests[s.planeSpace][request] = answer
	}
	return answer, nil
}

// newGroupRequest is a request of core.group.create that the shown space has not answered, for one press of the group button.
func (s *Shell) newGroupRequest() json.RawMessage {
	id := issueID(s.options.Random, "req-", func(id string) bool { _, ok := s.groupRequests[s.planeSpace][id]; return ok })
	encoded, _ := json.Marshal(id) // silent: a string always encodes.
	return encoded
}

// createdGroup is the result of a core.group.create that already stands: card is a card of a group of exactly card and its neighbour
// toward side, which holds a tab of plugin with params (docs/spec/groups.md#idempotency).
func (s *Shell) createdGroup(value groupCreateParam) (map[string]string, bool, error) {
	key := s.planes.Parent(value.Card)
	if key == "" {
		return nil, false, nil
	}
	cards := s.planes.Members(key)
	neighbour := s.planes.Neighbour(value.Card, value.Side)
	if len(cards) != 2 || neighbour == "" || s.isGroup(neighbour) {
		return nil, false, nil
	}
	known, err := s.knownPlugin(value.Plugin)
	if err != nil {
		return nil, false, err
	}
	checked, err := checkTabParams(known, value.Params)
	if err != nil {
		return nil, false, err
	}
	tab, err := s.equalTab(neighbour, value.Plugin, checked)
	if err != nil || tab == "" {
		return nil, false, err
	}
	return map[string]string{"group": key, "card": neighbour, "tab": tab}, true, nil
}

// addGroupCard runs core.card.add-tab on the group card id: a new content card with a tab of plugin at the right edge of its child
// plane (docs/spec/groups.md#card-commands-on-a-group-card).
func (s *Shell) addGroupCard(id, plugin string, params json.RawMessage) (string, error) {
	known, err := s.knownPlugin(plugin)
	if err != nil {
		return "", err
	}
	checked, err := checkTabParams(known, params)
	if err != nil {
		return "", err
	}
	tab, err := s.newTabOf(known, nil)
	if err != nil {
		return "", err
	}
	if checked != nil {
		tab.Rest["params"] = checked
	}
	encoded, err := json.Marshal(tabData([]layout.Tab{tab}, tab.ID))
	if err != nil {
		return "", err
	}
	born, err := s.planes.AddCard(id, encoded)
	if err != nil {
		// A refused command changes nothing, so the number of the title of the new tab is not taken.
		s.tabsNamed--
		return "", err
	}
	s.focusCard(born)
	s.settle()
	return tab.ID, nil
}

// cardState is the state of a content card that core.card.get returns (docs/spec/groups.md#status-and-queries).
type cardState struct {
	Card      string         `json:"card"`
	ActiveTab *string        `json:"activeTab"`
	Tabs      []tabState     `json:"tabs"`
	Groups    []groupOnPath  `json:"groups"`
	Group     *groupCardRead `json:"group,omitempty"`
}

// tabState is a tab of a card state with the summary statuses of its surface.
type tabState struct {
	Tab    string         `json:"tab"`
	Plugin string         `json:"plugin"`
	Status map[string]any `json:"status"`
}

// groupOnPath is a group card on the group path of a card.
type groupOnPath struct {
	Card string `json:"card"`
	Name string `json:"name"`
}

// groupCardRead is the group record of a group card that core.card.get returns, with its members in the tree form of core.layout.
type groupCardRead struct {
	Name    string `json:"name"`
	Level   int    `json:"level"`
	Leader  string `json:"leader"`
	Members []any  `json:"members"`
}

// groupState is a group card as core.card.get returns it: its id, its group path, the number of levels from the focused card up to it,
// null when the focused card stands outside it, and its group record.
type groupState struct {
	Card   string        `json:"card"`
	Groups []groupOnPath `json:"groups"`
	Focus  *int          `json:"focus"`
	Group  groupCardRead `json:"group"`
}

// cardGet answers core.card.get: one walk of the tree finds the card, its group path and its subtree, and the summary statuses of its
// tabs are read from the snapshot of the window (docs/spec/exposure.md#entry-fields).
func (s *Shell) cardGet(id string, answer func(any, error)) {
	if _, ok := s.findCard(id); ok && layout.IsWindowSide(id) {
		answer(nil, fmt.Errorf("card %s is a window sidebar", id))
		return
	}
	if err := s.groupCard(id); err != nil {
		answer(nil, err)
		return
	}
	path := []groupOnPath{}
	for _, group := range s.planes.Groups(id) {
		path = append(path, groupOnPath{Card: group, Name: s.planes.GroupName(group)})
	}
	if s.isGroup(id) {
		record, _ := s.planes.Group(id) // silent: isGroup found the group card.
		answer(groupState{Card: id, Groups: path, Focus: s.groupFocus(id), Group: groupCardRead{Name: record.Name, Level: record.Level, Leader: record.Leader,
			Members: s.planes.ReportedMembers(id)}}, nil)
		return
	}
	data, err := s.cardData(id)
	if err != nil {
		answer(nil, err)
		return
	}
	state := cardState{Card: id, Tabs: []tabState{}, Groups: path}
	if active := data.ActiveTab(); active != nil {
		state.ActiveTab = &active.ID
	}
	for _, tab := range data.TabList() {
		state.Tabs = append(state.Tabs, tabState{Tab: tab.ID, Plugin: tab.Plugin, Status: map[string]any{}})
	}
	s.registry.Reply("exposure.snapshot", json.RawMessage(`{}`), nil, func(result any, err error) {
		if err != nil {
			answer(nil, err)
			return
		}
		summaries, err := summaryStatuses(result)
		if err != nil {
			answer(nil, err)
			return
		}
		for i := range state.Tabs {
			if values, ok := summaries[state.Tabs[i].Tab]; ok {
				state.Tabs[i].Status = values
			}
		}
		answer(state, nil)
	})
}

// summaryStatuses reads the statuses that each surface of a window snapshot declares with summary true, by surface.
func summaryStatuses(result any) (map[string]map[string]any, error) {
	text, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	var snapshot struct {
		Groups []struct {
			Owner   string `json:"owner"`
			Surface string `json:"surface"`
			Status  []struct {
				Name    string          `json:"name"`
				Summary json.RawMessage `json:"summary"`
				Value   any             `json:"value"`
			} `json:"status"`
		} `json:"groups"`
	}
	if err := json.Unmarshal(text, &snapshot); err != nil {
		return nil, fmt.Errorf("exposure.snapshot returned an unexpected value: %w", err)
	}
	out := map[string]map[string]any{}
	for _, group := range snapshot.Groups {
		if group.Owner != "surface" {
			continue
		}
		values := map[string]any{}
		for _, status := range group.Status {
			switch string(status.Summary) {
			case "", "false":
			case "true":
				values[status.Name] = status.Value
			default:
				return nil, fmt.Errorf("exposure.snapshot has a status whose summary is not a boolean: %s %s", status.Name, status.Summary)
			}
		}
		out[group.Surface] = values
	}
	return out, nil
}

// closeGroupAsked closes the group card id with every card inside it, after each modified tab of them is saved or discarded
// in turn (docs/spec/groups.md#card-commands-on-a-group-card). It tells whether the group closed now.
func (s *Shell) closeGroupAsked(id string) (bool, error) {
	type asked struct {
		card string
		tab  layout.Tab
	}
	var modified []asked
	for _, card := range s.planes.ContentInside(id) {
		data, err := s.cardData(card)
		if err != nil {
			return false, err
		}
		for _, tab := range data.TabList() {
			if s.tabModified(tab.ID) {
				modified = append(modified, asked{card, tab})
			}
		}
	}
	if len(modified) == 0 {
		return true, s.closeCard(id)
	}
	var next func(index int)
	next = func(index int) {
		if index == len(modified) {
			s.showFailure(s.closeCard(id))
			return
		}
		s.askModified(modified[index].card, modified[index].tab, closeAnswers, func(settled bool) {
			if settled && s.isGroup(id) {
				next(index + 1)
			}
		})
	}
	next(0)
	return false, nil
}
