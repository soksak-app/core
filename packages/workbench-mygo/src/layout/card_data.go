package layout

import (
	"encoding/json"
	"errors"
	"fmt"
)

// The values of a card that the layout reads, as packages/workbench/card-data.js gives them: the order of its tabs, its active tab, its
// text size and the tab name whose width the head measures. The shared layout cases of docs/spec/cases/layout/tabs.json state them.

// Tab is one tab of a card. The members that the layout reads are fields, and Rest holds every other member as it is stored.
type Tab struct {
	ID     string
	Plugin string
	Title  string
	Rest   map[string]json.RawMessage
}

// UnmarshalJSON reads a tab. The members id, plugin and title are required.
func (t *Tab) UnmarshalJSON(text []byte) error {
	var members map[string]json.RawMessage
	if err := json.Unmarshal(text, &members); err != nil {
		return err
	}
	*t = Tab{}
	for _, member := range []struct {
		key string
		out *string
	}{{"id", &t.ID}, {"plugin", &t.Plugin}, {"title", &t.Title}} {
		raw, ok := members[member.key]
		if !ok {
			return errors.New("a tab has no " + member.key)
		}
		delete(members, member.key)
		if err := json.Unmarshal(raw, member.out); err != nil {
			return fmt.Errorf("tab member %s: %w", member.key, err)
		}
	}
	t.Rest = members
	return nil
}

// MarshalJSON writes the tab with every member it was read with.
func (t Tab) MarshalJSON() ([]byte, error) {
	members := make(map[string]any, len(t.Rest)+3)
	for key, value := range t.Rest {
		members[key] = value
	}
	members["id"], members["plugin"], members["title"] = t.ID, t.Plugin, t.Title
	return json.Marshal(members)
}

// CardData is the data of a card. A member that the data does not hold keeps its zero value: Tabs nil, TextSize nil and Sidebars nil. Rest
// holds every member that the layout does not read, as it is stored.
type CardData struct {
	Tabs     []Tab
	TextSize *float64
	Sidebars json.RawMessage
	Rest     map[string]json.RawMessage
	// activeID is the stored value of activeId, a string or null, and empty without the member.
	activeID json.RawMessage
	// activeText is the id in activeID, and activeSet tells that activeID holds a string.
	activeText string
	activeSet  bool
}

// DecodeCardData reads the data of a card, which is nil for a card without data.
func DecodeCardData(raw json.RawMessage) (*CardData, error) {
	if kind := jsonKind(raw); kind == 0 || kind == 'n' {
		return nil, nil
	}
	data := &CardData{}
	if err := json.Unmarshal(raw, data); err != nil {
		return nil, err
	}
	return data, nil
}

// UnmarshalJSON reads the data of a card.
func (d *CardData) UnmarshalJSON(text []byte) error {
	var members map[string]json.RawMessage
	if err := json.Unmarshal(text, &members); err != nil {
		return err
	}
	*d = CardData{}
	if raw, ok := members["tabs"]; ok {
		delete(members, "tabs")
		if err := json.Unmarshal(raw, &d.Tabs); err != nil {
			return fmt.Errorf("card data member tabs: %w", err)
		}
	}
	if raw, ok := members["textSize"]; ok {
		delete(members, "textSize")
		if err := json.Unmarshal(raw, &d.TextSize); err != nil {
			return fmt.Errorf("card data member textSize: %w", err)
		}
	}
	if raw, ok := members["activeId"]; ok {
		delete(members, "activeId")
		d.holdActive(raw)
	}
	if raw, ok := members["sidebars"]; ok {
		delete(members, "sidebars")
		d.Sidebars = raw
	}
	d.Rest = members
	return nil
}

// MarshalJSON writes the data of the card with every member it was read with.
func (d CardData) MarshalJSON() ([]byte, error) {
	members := make(map[string]any, len(d.Rest)+4)
	for key, value := range d.Rest {
		members[key] = value
	}
	if d.Tabs != nil {
		members["tabs"] = d.Tabs
	}
	if d.TextSize != nil {
		members["textSize"] = *d.TextSize
	}
	if d.activeID != nil {
		members["activeId"] = d.activeID
	}
	if d.Sidebars != nil {
		members["sidebars"] = d.Sidebars
	}
	return json.Marshal(members)
}

// TabList is the tabs of the card in their order. A card without data has none.
func (d *CardData) TabList() []Tab {
	if d == nil || d.Tabs == nil {
		return []Tab{}
	}
	return d.Tabs
}

// ActiveTab is the tab of the active id, or nil when no tab has that id.
func (d *CardData) ActiveTab() *Tab {
	if d == nil {
		return nil
	}
	if !d.activeSet {
		return nil
	}
	for i := range d.Tabs {
		if d.Tabs[i].ID == d.activeText {
			return &d.Tabs[i]
		}
	}
	return nil
}

// CardTextSize is the text size factor of the card. A card that was never resized has the factor 1.
func (d *CardData) CardTextSize() float64 {
	if d == nil || d.TextSize == nil {
		return 1
	}
	return *d.TextSize
}

// RemoveTab takes a tab out of the card. The others keep their order, and the active tab stays until SettleActiveTab.
func (d *CardData) RemoveTab(id string) {
	kept := make([]Tab, 0, len(d.Tabs))
	for _, tab := range d.Tabs {
		if tab.ID != id {
			kept = append(kept, tab)
		}
	}
	d.Tabs = kept
}

// AppendTab puts a tab at the end of the card and makes it the active tab.
func (d *CardData) AppendTab(tab Tab) {
	d.Tabs = append(d.Tabs, tab)
	d.setActive(&tab.ID)
}

// SelectTab makes the tab id the active tab.
func (d *CardData) SelectTab(id string) { d.setActive(&id) }

// SettleActiveTab selects the first tab when the active tab has left the card. A card with no tabs left has no active tab.
func (d *CardData) SettleActiveTab() {
	if d == nil || d.ActiveTab() != nil {
		return
	}
	if len(d.Tabs) == 0 {
		d.setActive(nil)
		return
	}
	d.setActive(&d.Tabs[0].ID)
}

// setActive stores the active id, null for nil.
func (d *CardData) setActive(id *string) {
	raw, err := json.Marshal(id)
	if err != nil {
		panic(err) // A string or a nil pointer always marshals.
	}
	d.holdActive(raw)
}

// holdActive stores raw as the value of activeId.
func (d *CardData) holdActive(raw json.RawMessage) {
	d.activeID, d.activeText = raw, ""
	d.activeSet = jsonKind(raw) == '"' && json.Unmarshal(raw, &d.activeText) == nil
}

// TabName is the name on a tab: the title that its surface reported, or the title of its layout entry when it reported none (reported nil),
// with a dot before a modified tab.
func TabName(tab Tab, reported *string, modified bool) string {
	label := tab.Title
	if reported != nil {
		label = *reported
	}
	if modified {
		return "● " + label
	}
	return label
}
