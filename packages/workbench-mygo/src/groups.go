package workbench

import (
	"encoding/json"
	"fmt"
	"slices"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The group cards of the shown space (docs/spec/groups.md): the tree of planes that the workbench holds over the root plane, the
// commands core.group.*, core.card.move and core.card.get, and the reads of the cards of every plane.

// planeOptions are the sizes that the tree of the shown space places its planes with: the gap of the plane, the smallest edge of a
// card and the head height of a card.
func (s *Shell) planeOptions(minimum float64) layout.PlaneOptions {
	return layout.PlaneOptions{Gap: s.palette.PlaneGap(), MinSize: minimum, Head: float64(s.metrics.headH)}
}

// allCards is every card of every plane of the shown space in workbench order.
func (s *Shell) allCards() []layout.Card {
	if s.planes == nil {
		return nil
	}
	cards := []layout.Card{}
	for _, card := range s.planes.Cards() {
		cards = append(cards, card.Card)
	}
	return cards
}

// contentCards is the cards of every plane of the shown space that are not group cards, in workbench order.
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

// cardSplitEven tells whether a split balances the plane of the split (cardSplit even).
func (s *Shell) cardSplitEven() bool { return false }

type groupCreateParam struct {
	Card   string          `json:"card"`
	Side   string          `json:"side"`
	Plugin string          `json:"plugin"`
	Params json.RawMessage `json:"params"`
}

type groupParam struct {
	Group string `json:"group"`
	Name  string `json:"name"`
}

type cardMoveParam struct {
	Card   string `json:"card"`
	Target string `json:"target"`
	Side   string `json:"side"`
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
		key, _ := s.planes.PlaneOf(value.Card) // silent: groupCard found the card.
		if leader, ok := s.planes.Leader(key); !ok || leader != value.Card {
			if _, err := s.planes.SetLeader(value.Card); err != nil {
				return nil, err
			}
			s.settle()
		}
		var plane *string
		if key != layout.RootPlane {
			plane = &key
		}
		return map[string]any{"card": value.Card, "plane": plane}, nil
	})
	command(s, "core.card.move", func(value cardMoveParam) (any, error) {
		if err := s.groupCard(value.Card); err != nil {
			return nil, err
		}
		if err := s.groupCard(value.Target); err != nil {
			return nil, err
		}
		if err := s.layoutChangeable(value.Card); err != nil {
			return nil, err
		}
		if err := s.planes.CheckMove(value.Card, value.Target, value.Side); err != nil {
			return nil, err
		}
		if s.planes.Moved(value.Card, value.Target, value.Side) {
			return map[string]string{"card": value.Card}, nil
		}
		if err := s.planes.Move(value.Card, value.Target, value.Side); err != nil {
			return nil, err
		}
		s.focusCard(value.Card)
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
	if err := s.groupCard(value.Card); err != nil {
		return nil, err
	}
	if err := s.layoutChangeable(value.Card); err != nil {
		return nil, err
	}
	if repeated, ok, err := s.createdGroup(value); err != nil || ok {
		return repeated, err
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
	group, born, err := s.planes.CreateGroup(value.Card, value.Side, encoded, s.cardSplitEven())
	if err != nil {
		// A refused command changes nothing, so the number of the title of the new tab is not taken.
		s.tabsNamed--
		return nil, err
	}
	s.focusCard(born)
	s.settle()
	return map[string]string{"group": group, "card": born, "tab": tab.ID}, nil
}

// createdGroup is the result of a core.group.create that already stands: card is a card of a group of exactly card and its neighbour
// toward side, which holds a tab of plugin with params (docs/spec/groups.md#idempotency).
func (s *Shell) createdGroup(value groupCreateParam) (map[string]string, bool, error) {
	key, _ := s.planes.PlaneOf(value.Card) // silent: groupCard found the card.
	if key == layout.RootPlane {
		return nil, false, nil
	}
	cards := s.planes.PlaneCards(key)
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

// groupCardRead is the group record of a group card that core.card.get returns, with its child plane in the tree form of core.layout.
type groupCardRead struct {
	Name   string       `json:"name"`
	Level  int          `json:"level"`
	Leader string       `json:"leader"`
	Plane  layout.State `json:"plane"`
}

// groupState is a group card as core.card.get returns it: its id, its group path and its group record.
type groupState struct {
	Card   string        `json:"card"`
	Groups []groupOnPath `json:"groups"`
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
		plane, err := s.planes.GroupTree(id)
		if err != nil {
			answer(nil, err)
			return
		}
		answer(groupState{Card: id, Groups: path, Group: groupCardRead{Name: record.Name, Level: record.Level, Leader: record.Leader,
			Plane: plane}}, nil)
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

// closeGroupAsked closes the group card id with every card of its child plane, after each modified tab of them is saved or discarded
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

// storedCards is every card of a stored root plane and of the planes in its group records.
func storedCards(state layout.State) []layout.Card {
	cards := slices.Clone(state.Cards)
	for _, card := range state.Cards {
		var record struct {
			Group *struct {
				Plane layout.State `json:"plane"`
			} `json:"group"`
		}
		if json.Unmarshal(card.Data, &record) == nil && record.Group != nil {
			cards = append(cards, storedCards(record.Group.Plane)...)
		}
	}
	return cards
}
