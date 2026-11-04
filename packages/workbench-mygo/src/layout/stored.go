package layout

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

// The stored layout of a space (docs/spec/projects.md#persistence): the check that the layout opens in the current environment, and
// the width records of the fixed window sidebars. The stored form is JSON that the model reads member by member, so a member of
// another kind is refused as the workbench refuses it.

// PluginUnit is a loaded plugin as the stored layout check reads it: its id and whether it declares a surface.
type PluginUnit struct {
	ID      string `json:"id"`
	Surface bool   `json:"surface"`
}

// WindowSidebar is the width record of a fixed window sidebar.
type WindowSidebar struct {
	Width float64 `json:"width"`
}

// jsonKind is the kind of a JSON value: '{', '[', '"', 'n' (null), 'b' (a boolean), '0' (a number), or 0 for no value.
func jsonKind(raw json.RawMessage) byte {
	text := bytes.TrimSpace(raw)
	if len(text) == 0 {
		return 0
	}
	switch text[0] {
	case '{', '[', '"', 'n':
		return text[0]
	case 't', 'f':
		return 'b'
	}
	return '0'
}

// truthy is whether a JSON value is true in a condition of JavaScript: every value except null, false, 0 and "".
func truthy(raw json.RawMessage) bool {
	switch jsonKind(raw) {
	case 0, 'n':
		return false
	case 'b':
		return string(bytes.TrimSpace(raw)) == "true"
	case '"':
		var s string
		return json.Unmarshal(raw, &s) == nil && s != ""
	case '0':
		var n float64
		return json.Unmarshal(raw, &n) == nil && n != 0
	}
	return true
}

// strictEqual is === between two members: two absent members are equal, and two objects or arrays read from JSON are never the same.
func strictEqual(a json.RawMessage, aHas bool, b json.RawMessage, bHas bool) bool {
	if !aHas || !bHas {
		return aHas == bHas
	}
	ka, kb := jsonKind(a), jsonKind(b)
	if ka != kb {
		return false
	}
	switch ka {
	case 'n':
		return true
	case 'b':
		return string(bytes.TrimSpace(a)) == string(bytes.TrimSpace(b))
	case '"':
		var x, y string
		return json.Unmarshal(a, &x) == nil && json.Unmarshal(b, &y) == nil && x == y
	case '0':
		var x, y float64
		return json.Unmarshal(a, &x) == nil && json.Unmarshal(b, &y) == nil && x == y
	}
	return false
}

// object reads a JSON object as its members and their keys in the order Object.keys gives them: the array index keys in ascending
// order, then the other keys in the order of the text. It is false for a value that is not an object.
func object(raw json.RawMessage) (map[string]json.RawMessage, []string, bool) {
	if jsonKind(raw) != '{' {
		return nil, nil, false
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if _, err := decoder.Token(); err != nil {
		return nil, nil, false
	}
	members := map[string]json.RawMessage{}
	var keys []string
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, nil, false
		}
		key := token.(string)
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, nil, false
		}
		if _, seen := members[key]; !seen {
			keys = append(keys, key)
		}
		members[key] = value
	}
	var indices, names []string
	for _, key := range keys {
		if n, err := strconv.ParseUint(key, 10, 32); err == nil && n < math.MaxUint32 && strconv.FormatUint(n, 10) == key {
			indices = append(indices, key)
		} else {
			names = append(names, key)
		}
	}
	sort.SliceStable(indices, func(i, j int) bool {
		// silent: this key parsed as an array index above, so it parses here.
		a, _ := strconv.ParseUint(indices[i], 10, 32)
		// silent: this key parsed as an array index above, so it parses here.
		b, _ := strconv.ParseUint(indices[j], 10, 32)
		return a < b
	})
	return members, append(indices, names...), true
}

// list reads a JSON array as its items. It is false for a value that is not an array.
func list(raw json.RawMessage) ([]json.RawMessage, bool) {
	if jsonKind(raw) != '[' {
		return nil, false
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, false
	}
	return items, true
}

// isWindowSidebar is whether id names a fixed window sidebar.
func isWindowSidebar(id string) bool { return id == "left" || id == "right" }

// CheckStoredLayout is the reason the stored layout of a space cannot be opened with the loaded plugins units, or nil when it can.
func CheckStoredLayout(layout json.RawMessage, units []PluginUnit) error {
	kept, _, ok := object(layout)
	if !ok {
		return errors.New("a stored layout is not an object")
	}
	sidebars, hasSidebars := kept["sidebars"]
	_, sidebarIDs, sidebarsObject := object(sidebars)
	if hasSidebars && !sidebarsObject {
		return errors.New("invalid stored sidebar choices")
	}
	if _, rail := kept["railWidth"]; rail {
		return errors.New("obsolete window sidebar state")
	}
	if _, edge := kept["edgeWidth"]; edge {
		return errors.New("obsolete window sidebar state")
	}
	state, _, ok := object(kept["state"])
	if !ok {
		return errors.New("a stored layout has no state")
	}
	cards, ok := list(state["cards"])
	if !ok {
		return errors.New("a stored layout has no cards")
	}
	content := map[string]bool{}
	for _, raw := range cards {
		card, _, ok := object(raw)
		if !ok {
			return errors.New("a stored card is not an object")
		}
		var id string
		if err := json.Unmarshal(card["id"], &id); err != nil {
			return fmt.Errorf("a stored card has no id: %w", err)
		}
		if strings.HasPrefix(id, "window:") {
			return fmt.Errorf("obsolete stored window sidebar %s", id)
		}
		if strings.HasPrefix(id, "rail-") {
			return fmt.Errorf("obsolete stored rail card %s", id)
		}
		data, hasData := card["data"]
		if truthy(data) {
			content[id] = true
		}
		if isWindowSidebar(id) {
			if hasData && jsonKind(data) != 'n' {
				return fmt.Errorf("invalid stored window sidebar data %s", id)
			}
			continue
		}
		fields, _, dataObject := object(data)
		for _, key := range []string{"panels", "sidebar"} {
			if _, has := fields[key]; dataObject && has {
				return fmt.Errorf("card %s stores %s, an earlier form of sidebars", id, key)
			}
		}
		tabs, ok := list(fields["tabs"])
		if !dataObject || !ok || len(tabs) == 0 {
			return fmt.Errorf("invalid stored content card %s", id)
		}
		activeID, hasActive := fields["activeId"]
		active := false
		for _, rawTab := range tabs {
			if jsonKind(rawTab) == 'n' {
				return fmt.Errorf("a tab of card %s is null", id)
			}
			// silent: a tab that is not an object has no plugin, as reading tab.plugin of such a value gives in JavaScript.
			tab, _, _ := object(rawTab)
			if plugin, has := tab["plugin"]; has && jsonKind(plugin) == '"' {
				var name string
				if err := json.Unmarshal(plugin, &name); err != nil {
					return err
				}
				for _, unit := range units {
					if unit.ID == name {
						if !unit.Surface {
							return fmt.Errorf("stored tab plugin %s has no surface", name)
						}
						break
					}
				}
			}
			tabID, hasID := tab["id"]
			if strictEqual(tabID, hasID, activeID, hasActive) {
				active = true
			}
		}
		if !active {
			return fmt.Errorf("invalid stored active tab %s", id)
		}
	}
	for _, id := range sidebarIDs {
		if strings.HasPrefix(id, "rail-") || strings.HasPrefix(id, "window:") {
			return fmt.Errorf("obsolete stored sidebar %s", id)
		}
		if content[id] {
			return fmt.Errorf("sidebar choice %s names card %s, an earlier form of %s:left", id, id, id)
		}
	}
	return nil
}

// RestoreWindowSidebars reads the width records of the fixed window sidebars: an object from a window sidebar id to {width}, with a
// finite width above 0.
func RestoreWindowSidebars(saved json.RawMessage) (map[string]WindowSidebar, error) {
	records, ids, ok := object(saved)
	if !ok {
		return nil, errors.New("invalid window sidebar records")
	}
	out := map[string]WindowSidebar{}
	for _, id := range ids {
		if !isWindowSidebar(id) {
			return nil, fmt.Errorf("unknown window sidebar %s", id)
		}
		record, keys, ok := object(records[id])
		invalid := !ok || jsonKind(record["width"]) != '0'
		for _, key := range keys {
			if key != "width" {
				invalid = true
			}
		}
		var width float64
		if !invalid {
			invalid = json.Unmarshal(record["width"], &width) != nil || !finite(width) || width <= 0
		}
		if invalid {
			return nil, fmt.Errorf("invalid window sidebar %s", id)
		}
		out[id] = WindowSidebar{Width: width}
	}
	return out, nil
}
