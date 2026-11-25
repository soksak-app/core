package workbench

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"

	"github.com/egoist/mygo/ui"
)

// The part of the workbench in a window snapshot (docs/spec/exposure.md#window-snapshot), the steps of snapshot in
// packages/workbench/exposure.js: the layout and the plugins of the window, the group of the main document, one group per surface and
// the declared entries that no owner registered. The host adds the window and its own group.

// SnapshotParts are what the window gives a snapshot besides its entries: the layout of the shown space or nil, the loaded plugins
// and the surfaces in the order of core.surfaces.
type SnapshotParts struct {
	Layout   any
	Plugins  []PluginDescription
	Surfaces []SnapshotSurface
}

// PluginDescription describes a loaded plugin; Surface is nil for a plugin without a tab surface.
type PluginDescription struct {
	Plugin      string         `json:"plugin"`
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Surface     *PluginSurface `json:"surface"`
}

// PluginSurface is the surface.params schema of the tabs of a plugin, or nil, and the extensions of surface.opens.
type PluginSurface struct {
	Params any      `json:"params"`
	Opens  []string `json:"opens"`
}

// SnapshotSurface is a surface of the window; State is "unloaded" for a surface that the memory saver unloaded, else "loaded".
type SnapshotSurface struct {
	Surface string `json:"surface"`
	Plugin  string `json:"plugin"`
	Kind    string `json:"kind"`
	State   string `json:"state"`
	Visible bool   `json:"visible"`
}

// SnapshotPartsOf gives the registry what the window adds to a snapshot. Without it a snapshot has no layout, no plugin and no
// surface.
func (r *Registry) SnapshotPartsOf(parts func() (SnapshotParts, error)) { r.parts = parts }

// snapshotGroup is one group of a snapshot.
type snapshotGroup map[string]any

// snapshot answers exposure.snapshot. The main document is read in the step of the request, then each surface that registered entries
// is asked in turn. With surface, the groups hold only the group of that surface.
func (r *Registry) snapshot(origin uint64, params json.RawMessage, answer func(result any, err error)) {
	var request map[string]json.RawMessage
	if len(params) > 0 && string(params) != "null" {
		if err := json.Unmarshal(params, &request); err != nil {
			answer(nil, Refuse(InvalidParams, "exposure.snapshot params must be an object"))
			return
		}
	}
	var only *string
	if raw, present := request["surface"]; present {
		if json.Unmarshal(raw, &only) != nil || only == nil {
			answer(nil, Refuse(InvalidParams, "surface must be a string"))
			return
		}
	}
	parts := SnapshotParts{Plugins: []PluginDescription{}, Surfaces: []SnapshotSurface{}}
	if r.parts != nil {
		read, err := r.parts()
		if err != nil {
			answer(nil, Refuse(Failed, "%v", err))
			return
		}
		parts = read
	}
	chosen := parts.Surfaces
	if only != nil {
		chosen = nil
		for _, surface := range parts.Surfaces {
			if surface.Surface == *only {
				chosen = append(chosen, surface)
			}
		}
		if len(chosen) == 0 {
			answer(nil, Refuse(InvalidParams, "surface %s is not a surface of this window", *only))
			return
		}
	}
	groups := []snapshotGroup{}
	unregistered := []map[string]string{}
	if only == nil {
		listed, err := r.unregisteredEntries()
		if err != nil {
			answer(nil, err)
			return
		}
		unregistered = listed
		main, err := r.mainGroup()
		if err != nil {
			answer(nil, err)
			return
		}
		groups = append(groups, main)
	}
	r.surfaceGroups(origin, chosen, groups, func(groups []snapshotGroup, err error) {
		if err != nil {
			answer(nil, err)
			return
		}
		answer(map[string]any{"layout": parts.Layout, "plugins": parts.Plugins, "groups": groups, "unregistered": unregistered}, nil)
	})
}

// unregisteredEntries are the declared entries that no owner registered, {kind, name}, in the order of exposure.list.
func (r *Registry) unregisteredEntries() ([]map[string]string, error) {
	listed, err := r.list()
	if err != nil {
		return nil, err
	}
	entries := []map[string]string{}
	for _, key := range []string{"status", "commands", "element"} {
		for _, row := range listed[key] {
			if row["registered"] == false {
				entries = append(entries, map[string]string{"kind": exposeKinds[key], "name": row["name"].(string)})
			}
		}
	}
	return entries, nil
}

// mainGroup is the group of the main document: each status that the workbench registered with its value or the error of its read,
// each registered command and each element name with its elements, in declaration order and each in the declaration format.
func (r *Registry) mainGroup() (snapshotGroup, error) {
	declared, err := readExposures()
	if err != nil {
		return nil, err
	}
	drawn, err := r.drawn()
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	var readers []Status
	var statuses []map[string]any
	for _, row := range declared["status"] {
		name := row["name"].(string)
		if read := r.statuses[name]; read != nil && !registeredBySurface(name) {
			readers, statuses = append(readers, read), append(statuses, row)
		}
	}
	commands := []map[string]any{}
	for _, row := range declared["commands"] {
		name := row["name"].(string)
		if (r.commands[name] != nil || r.later[name] != nil) && !registeredBySurface(name) {
			commands = append(commands, row)
		}
	}
	r.mu.Unlock()
	status := []map[string]any{}
	for i, row := range statuses {
		status = append(status, statusEntry(row, readers[i]))
	}
	element := []map[string]any{}
	for _, row := range declared["element"] {
		name := row["name"].(string)
		if len(drawn[name]) == 0 || registeredBySurface(name) {
			continue
		}
		items := make([]map[string]any, 0, len(drawn[name]))
		for index, node := range drawn[name] {
			item, err := r.snapshotItem(name, index, node)
			if err != nil {
				return nil, err
			}
			if item != nil {
				items = append(items, item)
			}
		}
		row["items"] = items
		element = append(element, row)
	}
	return snapshotGroup{"owner": "core", "status": status, "commands": commands, "element": element}, nil
}

// statusEntry is the declaration of a status with its value, or with the text of the failure of its read.
func statusEntry(row map[string]any, read Status) map[string]any {
	name := row["name"].(string)
	value := read()
	if _, err := json.Marshal(value); err != nil {
		row["error"] = fmt.Sprintf("status %s value: %v", name, err)
		return row
	}
	row["value"] = value
	return row
}

// snapshotItem is one element of an element name: its role and its rectangle as element.rect gives them, its text content, whether it is
// behind the open dialog, and the command and the params that it runs, or null. An element with an empty box, which the window does
// not draw, has no item and answers nil.
func (r *Registry) snapshotItem(name string, index int, node ui.ElementNode) (map[string]any, error) {
	if node.Bounds.W <= 0 || node.Bounds.H <= 0 {
		return nil, nil
	}
	var command, params any
	if key, keyed := node.Key.(Exposed); keyed && key.Command != "" {
		command = key.Command
		if given := r.params[key]; given != nil {
			text, err := json.Marshal(given)
			if err != nil {
				return nil, fmt.Errorf("element %s index %d has params that are not JSON: %w", name, index, err)
			}
			value, err := jsonValue(text)
			if err != nil {
				return nil, fmt.Errorf("element %s index %d has params that are not JSON: %w", name, index, err)
			}
			params = value
		}
	}
	return map[string]any{
		"index": index, "role": ElementRole(node.Role), "text": snapshotText(node.Text),
		"rect":  map[string]any{"x": node.Bounds.X, "y": node.Bounds.Y, "width": node.Bounds.W, "height": node.Bounds.H},
		"inert": node.Inert, "command": command, "params": params,
	}, nil
}

// pageSpace is \s of a regular expression of the page: the white space and the line ends of JavaScript.
var pageSpace = regexp.MustCompile(`[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)

// snapshotLimit is the length of the text of an item in Unicode scalar values.
const snapshotLimit = 120

// snapshotText is a text with each run of white space joined into one space and cut to its first snapshotLimit Unicode scalar values,
// so a cut never splits a character (docs/spec/exposure.md#window-snapshot).
func snapshotText(text string) string {
	joined := pageSpace.ReplaceAllString(text, " ")
	count := 0
	for at := range joined {
		if count == snapshotLimit {
			return joined[:at]
		}
		count++
	}
	return joined
}

// surfaceGroups adds the group of each surface to groups in turn: a surface that is unloaded or registered nothing has no entries, a
// surface whose document ends before it answers has the error 1003, and another failure of a surface fails the snapshot.
func (r *Registry) surfaceGroups(origin uint64, surfaces []SnapshotSurface, groups []snapshotGroup, done func(groups []snapshotGroup, err error)) {
	if len(surfaces) == 0 {
		done(groups, nil)
		return
	}
	surface, rest := surfaces[0], surfaces[1:]
	group := snapshotGroup{"owner": "surface", "surface": surface.Surface, "plugin": surface.Plugin, "kind": surface.Kind,
		"state": surface.State, "visible": surface.Visible}
	empty := func() {
		group["status"], group["commands"], group["element"] = []any{}, []any{}, []any{}
	}
	if surface.State == "unloaded" || len(r.EntriesOf(surface.Surface)) == 0 {
		empty()
		r.surfaceGroups(origin, rest, append(groups, group), done)
		return
	}
	r.forward(origin, surface.Surface, "exposure.snapshot", json.RawMessage(`{}`), func(result any, err error) {
		var refusal *Refusal
		switch {
		case errors.As(err, &refusal) && refusal.Code == Gone:
			// The document of the surface ended before it answered.
			group["error"] = Gone
			empty()
		case err != nil:
			done(nil, err)
			return
		default:
			if err := r.placePart(surface.Surface, result, group); err != nil {
				done(nil, err)
				return
			}
		}
		r.surfaceGroups(origin, rest, append(groups, group), done)
	})
}

// surfacePart is the group that a surface document answers.
type surfacePart struct {
	Status   []json.RawMessage `json:"status"`
	Commands []json.RawMessage `json:"commands"`
	Element  []json.RawMessage `json:"element"`
}

// placePart puts the part of a surface into its group, with the rectangles of its items in window coordinates and inert: the view
// answers in its own document coordinates, so the applied frame of the view is added, as for element.rect, and only the workbench
// knows the open dialog.
func (r *Registry) placePart(surface string, result any, group snapshotGroup) error {
	raw, ok := result.(json.RawMessage)
	if !ok {
		return Refuse(Failed, "surface %s answered no snapshot part", surface)
	}
	var part surfacePart
	if err := json.Unmarshal(raw, &part); err != nil || part.Status == nil || part.Commands == nil || part.Element == nil {
		return Refuse(Failed, "surface %s answered a snapshot part without status, commands and element", surface)
	}
	x, y, placed := r.surfaces.links.Frame(surface)
	if !placed {
		return Refuse(Failed, "surface %s has no valid applied frame", surface)
	}
	inert := r.surfaces.links.BehindDialog(surface)
	status, err := snapshotRows(surface, part.Status)
	if err != nil {
		return err
	}
	commands, err := snapshotRows(surface, part.Commands)
	if err != nil {
		return err
	}
	element, err := snapshotRows(surface, part.Element)
	if err != nil {
		return err
	}
	for _, entry := range element {
		items, ok := entry["items"].([]any)
		if !ok {
			return Refuse(Failed, "surface %s answered element %v without items", surface, entry["name"])
		}
		for _, each := range items {
			item, ok := each.(map[string]any)
			rect, okRect := item["rect"].(map[string]any)
			if !ok || !okRect {
				return Refuse(Failed, "surface %s answered an item of element %v without a rectangle", surface, entry["name"])
			}
			left, errLeft := numberOf(rect["x"])
			top, errTop := numberOf(rect["y"])
			if errLeft != nil || errTop != nil {
				return Refuse(Failed, "surface %s has no valid rectangle", surface)
			}
			rect["x"], rect["y"], item["inert"] = left+x, top+y, inert
		}
	}
	group["status"], group["commands"], group["element"] = status, commands, element
	return nil
}

// snapshotRows decodes the entries of a part of a surface and keeps their numbers as written.
func snapshotRows(surface string, entries []json.RawMessage) ([]map[string]any, error) {
	rows := make([]map[string]any, 0, len(entries))
	for _, raw := range entries {
		row := map[string]any{}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		if err := decoder.Decode(&row); err != nil {
			return nil, Refuse(Failed, "surface %s answered a snapshot entry that is no object: %v", surface, err)
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// numberOf reads a number that the decoder kept as written.
func numberOf(value any) (float64, error) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, fmt.Errorf("%v is no number", value)
	}
	return number.Float64()
}
