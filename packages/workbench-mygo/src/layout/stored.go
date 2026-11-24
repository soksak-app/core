package layout

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
)

// The stored layout of a space (docs/spec/projects.md#persistence): the check that the layout opens in the current environment, and
// the size records of the fixed window sidebars. The stored form is JSON that the model reads member by member, so a member of
// another kind is refused as the workbench refuses it.

// PluginUnit is a loaded plugin as the stored layout check reads it: its id and whether it declares a surface.
type PluginUnit struct {
	ID      string `json:"id"`
	Surface bool   `json:"surface"`
}

// WindowSidebar is the size record of a fixed window sidebar: the width of a left or right sidebar, the height of a top or bottom
// sidebar (docs/spec/external-sidebars.md). The member of the other axis is zero and not written.
type WindowSidebar struct {
	Width  float64 `json:"width,omitempty"`
	Height float64 `json:"height,omitempty"`
}

// WindowSides are the sides of a window; each holds at most one fixed window sidebar, whose card id is the side.
var WindowSides = []string{"left", "right", "top", "bottom"}

// IsWindowSide is whether id names a side of the window, and so the fixed window sidebar of that side.
func IsWindowSide(id string) bool { return slices.Contains(WindowSides, id) }

// WindowAxis is the axis of the sidebar of a side: x for left and right, y for top and bottom.
func WindowAxis(side string) Axis {
	if side == "left" || side == "right" {
		return "x"
	}
	return "y"
}

// SizeKey is the member of the saved size of the sidebar of a side: width for left and right, height for top and bottom.
func SizeKey(side string) string {
	if WindowAxis(side) == "x" {
		return "width"
	}
	return "height"
}

// SidebarSize returns the record of size on the axis of side.
func SidebarSize(side string, size float64) WindowSidebar {
	if WindowAxis(side) == "x" {
		return WindowSidebar{Width: size}
	}
	return WindowSidebar{Height: size}
}

// Size is the size of the record on its axis.
func (r WindowSidebar) Size() float64 { return r.Width + r.Height }

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
func isWindowSidebar(id string) bool { return IsWindowSide(id) }

// layoutMembers are the members of a stored space layout (docs/spec/groups.md#storage), with groups, the earlier group list that ReadTree
// refuses.
var layoutMembers = []string{"state", "leader", "lastCard", "focusedId", "named", "sidebars", "windowSidebars", "groups"}

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
	// A member that the storage does not define is refused, so a member of an earlier form is not dropped at the next write; groups is
	// refused by ReadTree with the text of the earlier group list (docs/spec/groups.md#storage).
	var unknown []string
	for key := range kept {
		if !slices.Contains(layoutMembers, key) {
			unknown = append(unknown, key)
		}
	}
	if len(unknown) > 0 {
		slices.Sort(unknown)
		return fmt.Errorf("layout stores %s, which a space layout does not hold", strings.Join(unknown, ", "))
	}
	if jsonKind(kept["state"]) != '{' {
		return errors.New("a stored layout has no state")
	}
	var state State
	if err := json.Unmarshal(kept["state"], &state); err != nil {
		return err
	}
	if err := CheckState(state); err != nil {
		return err
	}
	content := map[string]bool{}
	// The cards are checked in the order of the tree, each card node as its id and its data.
	for _, leaf := range cardsOf(state.Root) {
		id := leaf.Card
		card := map[string]json.RawMessage{}
		if leaf.Data != nil {
			card["data"] = leaf.Data
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
		if !dataObject || !ok {
			return fmt.Errorf("invalid stored content card %s", id)
		}
		activeID, hasActive := fields["activeId"]
		// An empty card stores the active id null, and a card with tabs the id of one of them (docs/spec/projects.md#persistence).
		active := len(tabs) == 0 && hasActive && jsonKind(activeID) == 'n'
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
			if err := checkTabRole(tab); err != nil {
				return err
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

// RestoreWindowSidebars reads the size records of the fixed window sidebars: an object from a window sidebar id to {width} for left
// and right and {height} for top and bottom, with a finite size above 0. The record of the other axis is refused, not converted.
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
		size, other := SizeKey(id), "height"
		if size == "height" {
			other = "width"
		}
		record, keys, ok := object(records[id])
		if ok && len(keys) == 1 && keys[0] == other {
			return nil, fmt.Errorf("window sidebar %s saves %s, not %s", id, size, other)
		}
		invalid := !ok || jsonKind(record[size]) != '0'
		for _, key := range keys {
			if key != size {
				invalid = true
			}
		}
		var value float64
		if !invalid {
			invalid = json.Unmarshal(record[size], &value) != nil || !finite(value) || value <= 0
		}
		if invalid {
			return nil, fmt.Errorf("invalid window sidebar %s", id)
		}
		out[id] = SidebarSize(id, value)
	}
	return out, nil
}

// roleRecordMembers are the members of the stored record of a tab role (docs/spec/agent-roles.md#tab-role-state).
var roleRecordMembers = []string{"id", "generation", "fingerprint", "confirmedFingerprint"}

var (
	roleIdentifierPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)
	fingerprintPattern    = regexp.MustCompile(`^[0-9a-f]{16}$`)
)

// checkTabRole checks the member role of a stored tab: null, or the whole record of the tab role with exactly the four members of
// docs/spec/agent-roles.md#tab-role-state. An absent member or another value is refused with the id of the tab.
func checkTabRole(tab map[string]json.RawMessage) error {
	var id string
	if raw, has := tab["id"]; has && json.Unmarshal(raw, &id) != nil {
		id = string(raw)
	}
	role, has := tab["role"]
	if !has {
		return fmt.Errorf("tab %s member role is missing", id)
	}
	if jsonKind(role) == 'n' {
		return nil
	}
	if !validRoleRecord(role) {
		return fmt.Errorf("tab %s member role is invalid", id)
	}
	return nil
}

// validRoleRecord reports whether raw is a record with exactly the members of roleRecordMembers and the form that the spec gives each.
func validRoleRecord(raw json.RawMessage) bool {
	members, _, ok := object(raw)
	if !ok || len(members) != len(roleRecordMembers) {
		return false
	}
	for _, key := range roleRecordMembers {
		if _, has := members[key]; !has {
			return false
		}
	}
	var identifier string
	if json.Unmarshal(members["id"], &identifier) != nil || !roleIdentifierPattern.MatchString(identifier) {
		return false
	}
	var fingerprint string
	if json.Unmarshal(members["fingerprint"], &fingerprint) != nil || !fingerprintPattern.MatchString(fingerprint) {
		return false
	}
	if jsonKind(members["confirmedFingerprint"]) != 'n' {
		var confirmed string
		if json.Unmarshal(members["confirmedFingerprint"], &confirmed) != nil || !fingerprintPattern.MatchString(confirmed) {
			return false
		}
	}
	var generation float64
	return json.Unmarshal(members["generation"], &generation) == nil && generation >= 1 && generation == math.Trunc(generation)
}
