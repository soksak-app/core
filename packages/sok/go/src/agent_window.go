package sok

// The parts of the exposure that an agent reads, shared by the commands of sok and the tools of `sok mcp`: the window of an agent
// (docs/spec/cli.md#the-window-of-an-agent), the discovery of entries (docs/spec/cli.md#discovery) and the window description
// (docs/spec/cli.md#window-description). The Rust implementation (packages/sok/rust/src/agent_window.rs) gives the same JSON
// text for the same endpoint replies.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// SurfaceVariable is the variable that names the surface whose process started the agent.
const SurfaceVariable = "SOKSAK_SURFACE"

// agentSurface is the surface that SOKSAK_SURFACE names, or "" when the variable is not set or empty.
func agentSurface() string { return os.Getenv(SurfaceVariable) }

// requester sends one endpoint request and returns its result.
type requester func(method string, params any) (json.RawMessage, error)

// surfaceHome is the answer of surface.window: the window and the space whose layout holds a surface, nil for a section surface,
// which a sidebar of the window draws and no layout of a space holds.
type surfaceHome struct {
	Window string
	Space  *string
}

// surfaceWindow asks the endpoint for the window and the space whose layout holds surface. An answer 1012 is the error that names the
// variable, because a request of an agent never falls back to another window.
func surfaceWindow(request requester, surface string) (surfaceHome, error) {
	result, err := request("surface.window", map[string]any{"surface": surface})
	var endpointErr *EndpointError
	if errors.As(err, &endpointErr) && endpointErr.Code == 1012 {
		return surfaceHome{}, fmt.Errorf("%s names surface %s, which is in no window of the application", SurfaceVariable, surface)
	}
	if err != nil {
		return surfaceHome{}, err
	}
	var answer map[string]json.RawMessage
	var home surfaceHome
	if json.Unmarshal(result, &answer) != nil || json.Unmarshal(answer["window"], &home.Window) != nil || home.Window == "" ||
		answer["space"] == nil || json.Unmarshal(answer["space"], &home.Space) != nil {
		return surfaceHome{}, fmt.Errorf("surface.window returned an unexpected value: %s", result)
	}
	return home, nil
}

// readWindows reads windows.list.
func readWindows(request requester) ([]windowEntry, error) {
	result, err := request("windows.list", nil)
	if err != nil {
		return nil, err
	}
	var windows []windowEntry
	if err := json.Unmarshal(result, &windows); err != nil {
		return nil, fmt.Errorf("windows.list returned an unexpected value: %w", err)
	}
	return windows, nil
}

// keyWindow is the key window of windows.list, else its first window.
func keyWindow(request requester) (string, error) {
	windows, err := readWindows(request)
	if err != nil {
		return "", err
	}
	for _, entry := range windows {
		if entry.Key {
			return entry.Window, nil
		}
	}
	if len(windows) == 0 {
		return "", errors.New("the application has no window")
	}
	return windows[0].Window, nil
}

// agentContext is `{configDirectory, surface, window}` of `sok context` and the tool agent_context.
func agentContext(request requester, configDir string) (map[string]any, error) {
	context := map[string]any{"configDirectory": configDir, "surface": nil, "window": nil}
	surface := agentSurface()
	if surface == "" {
		return context, nil
	}
	home, err := surfaceWindow(request, surface)
	if err != nil {
		return nil, err
	}
	context["surface"], context["window"] = surface, home.Window
	return context, nil
}

// encodeJSON writes value as compact JSON text: object members in the order of their names, no escape of <, > and &, and the
// line and paragraph separators as they are, as serde_json writes them, so both implementations give the same text.
func encodeJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return keepSeparators(bytes.TrimSuffix(buffer.Bytes(), []byte("\n"))), nil
}

// keepSeparators replaces each escape   and   that encoding/json writes in a string with the character itself. An escape
// is one when an even number of backslashes precedes it, because \\u2028 is a backslash followed by the text u2028.
func keepSeparators(text []byte) []byte {
	if !bytes.Contains(text, []byte(`\u202`)) {
		return text
	}
	var out bytes.Buffer
	for i := 0; i < len(text); i++ {
		if text[i] == '\\' && i+5 < len(text) && string(text[i+1:i+5]) == "u202" && (text[i+5] == '8' || text[i+5] == '9') {
			out.WriteRune(rune(0x2020 + int(text[i+5]-'0')))
			i += 5
			continue
		}
		if text[i] == '\\' && i+1 < len(text) {
			out.WriteByte(text[i])
			i++
		}
		out.WriteByte(text[i])
	}
	return out.Bytes()
}

// compactRaw removes the white space between the tokens of an endpoint value and keeps everything else of its text.
func compactRaw(raw json.RawMessage) (json.RawMessage, error) {
	var buffer bytes.Buffer
	if err := json.Compact(&buffer, raw); err != nil {
		return nil, fmt.Errorf("endpoint returned invalid JSON: %w", err)
	}
	return buffer.Bytes(), nil
}

// queryMatches tells whether each word of query is a part of name or of description. Words are separated by spaces, tabs and line
// breaks; the letters A-Z and a-z match regardless of case and every other character only itself (docs/spec/cli.md#discovery).
func queryMatches(query, name, description string) bool {
	name, description = asciiLower(name), asciiLower(description)
	for _, word := range strings.FieldsFunc(query, func(r rune) bool { return r == ' ' || r == '\t' || r == '\n' || r == '\r' }) {
		word = asciiLower(word)
		if !strings.Contains(name, word) && !strings.Contains(description, word) {
			return false
		}
	}
	return true
}

func asciiLower(text string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'A' && r <= 'Z' {
			return r + ('a' - 'A')
		}
		return r
	}, text)
}

// exposureKinds are the kinds of entries in the order of exposure.list, with the member of each list.
var exposureKinds = []struct{ kind, member string }{{"status", "status"}, {"command", "commands"}, {"element", "element"}}

// exposureEntry is one declared entry of exposure.list with its declaration as the endpoint gave it.
type exposureEntry struct {
	kind        string
	name        string
	description string
	registered  json.RawMessage
	raw         json.RawMessage
}

// exposure is the result of exposure.list: the members in their order and the entries of each kind.
type exposure struct {
	order   []string
	members map[string]json.RawMessage
	entries map[string][]exposureEntry
}

// readExposure reads the result of exposure.list. A result without one of the three lists, or with a command without params, is no
// list of the exposure (docs/spec/exposure.md#entry-fields) and is refused instead of completed.
func readExposure(result json.RawMessage) (exposure, error) {
	members, order, err := orderedMembers(result)
	if err != nil {
		return exposure{}, fmt.Errorf("exposure.list returned an unexpected value: %w", err)
	}
	read := exposure{order: order, members: members, entries: map[string][]exposureEntry{}}
	for _, kind := range exposureKinds {
		var list []json.RawMessage
		if raw, ok := members[kind.member]; !ok || json.Unmarshal(raw, &list) != nil || list == nil {
			return exposure{}, fmt.Errorf("exposure.list has no %s list", kind.member)
		}
		for _, raw := range list {
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
				return exposure{}, fmt.Errorf("exposure.list has an entry that is not an object in its %s list", kind.member)
			}
			var name, description string
			if json.Unmarshal(fields["name"], &name) != nil || name == "" {
				return exposure{}, fmt.Errorf("exposure.list has an entry without a name in its %s list", kind.member)
			}
			if err := json.Unmarshal(fields["description"], &description); err != nil {
				return exposure{}, fmt.Errorf("%s %s has no description", kind.kind, name)
			}
			if _, ok := fields["params"]; kind.kind == "command" && !ok {
				return exposure{}, fmt.Errorf("command %s declares no params schema", name)
			}
			compacted, err := compactRaw(raw)
			if err != nil {
				return exposure{}, err
			}
			registered := fields["registered"]
			read.entries[kind.kind] = append(read.entries[kind.kind], exposureEntry{kind: kind.kind, name: name, description: description, registered: registered, raw: compacted})
		}
	}
	return read, nil
}

// orderedMembers reads a JSON object into its members and their order.
func orderedMembers(raw json.RawMessage) (map[string]json.RawMessage, []string, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil {
		return nil, nil, err
	}
	if token != json.Delim('{') {
		return nil, nil, errors.New("not an object")
	}
	members := map[string]json.RawMessage{}
	var order []string
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return nil, nil, err
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, nil, err
		}
		name := key.(string)
		if _, seen := members[name]; !seen {
			order = append(order, name)
		}
		members[name] = value
	}
	return members, order, nil
}

// filterExposure keeps the entries of kind (every kind when it is "") that query matches, in the order of exposure.list, and writes
// the object of exposure.list with the kept lists and the members in their order (`sok exposures`).
func filterExposure(read exposure, kind, query string) ([]byte, error) {
	var out bytes.Buffer
	out.WriteByte('{')
	first := true
	for _, name := range read.order {
		value := read.members[name]
		listed := ""
		for _, k := range exposureKinds {
			if k.member == name {
				listed = k.kind
			}
		}
		if listed != "" && kind != "" && listed != kind {
			continue
		}
		if !first {
			out.WriteByte(',')
		}
		first = false
		key, err := json.Marshal(name)
		if err != nil {
			return nil, err
		}
		out.Write(key)
		out.WriteByte(':')
		if listed == "" {
			out.Write(value)
			continue
		}
		out.WriteByte('[')
		kept := 0
		for _, entry := range read.entries[listed] {
			if !queryMatches(query, entry.name, entry.description) {
				continue
			}
			if kept > 0 {
				out.WriteByte(',')
			}
			kept++
			out.Write(entry.raw)
		}
		out.WriteByte(']')
	}
	out.WriteByte('}')
	return out.Bytes(), nil
}

// matchingCommands is the commands list of exposure.list with the commands that query matches (`sok commands`).
func matchingCommands(read exposure, query string) []byte {
	var out bytes.Buffer
	out.WriteByte('[')
	kept := 0
	for _, entry := range read.entries["command"] {
		if !queryMatches(query, entry.name, entry.description) {
			continue
		}
		if kept > 0 {
			out.WriteByte(',')
		}
		kept++
		out.Write(entry.raw)
	}
	out.WriteByte(']')
	return out.Bytes()
}

// searchExposure is the result of exposure_search: the entries of kind that query matches, as {kind, name, description,
// registered}, after the entry whose key is after, at most limit of them, with their number and the key of the last entry of the
// page when more follow.
func searchExposure(read exposure, kind, query, after string, limit int) (map[string]any, error) {
	var matched []exposureEntry
	for _, k := range exposureKinds {
		if kind != "" && k.kind != kind {
			continue
		}
		for _, entry := range read.entries[k.kind] {
			if queryMatches(query, entry.name, entry.description) {
				matched = append(matched, entry)
			}
		}
	}
	start := 0
	if after != "" {
		start = -1
		for n, entry := range matched {
			if entry.kind+" "+entry.name == after {
				start = n + 1
			}
		}
		if start < 0 {
			return nil, fmt.Errorf("after %s names no entry of the search", after)
		}
	}
	end := min(start+limit, len(matched))
	entries := []any{}
	for _, entry := range matched[start:end] {
		if entry.registered == nil {
			return nil, fmt.Errorf("%s %s has no registered", entry.kind, entry.name)
		}
		entries = append(entries, map[string]any{"kind": entry.kind, "name": entry.name, "description": entry.description, "registered": entry.registered})
	}
	var next any
	if end < len(matched) {
		next = matched[end-1].kind + " " + matched[end-1].name
	}
	return map[string]any{"entries": entries, "total": len(matched), "next": next}, nil
}

// describeEntry is the declaration of one entry of exposure.list, with registered, for exposure_describe.
func describeEntry(read exposure, kind, name string) (json.RawMessage, error) {
	for _, entry := range read.entries[kind] {
		if entry.name == name {
			return entry.raw, nil
		}
	}
	return nil, fmt.Errorf("%s %s is not declared", kind, name)
}

// Bounds of the window description (docs/spec/cli.md#window-description).
const (
	describePageBytes    = 40000
	describeValueChars   = 200
	describeCompactItems = 20
	describeDefaultLimit = 200
	describeMaxLimit     = 500
)

// describeRow is one entry of the description with the JSON text of its row.
type describeRow struct {
	key     string
	fields  map[string]any
	kind    string
	cutText string
	items   []json.RawMessage
	text    []byte
}

// snapshotGroup is one group of exposure.snapshot.
type snapshotGroup struct {
	Owner    string            `json:"owner"`
	Surface  string            `json:"surface"`
	Plugin   json.RawMessage   `json:"plugin"`
	Status   []json.RawMessage `json:"status"`
	Commands []json.RawMessage `json:"commands"`
	Element  []json.RawMessage `json:"element"`
}

// agentPlace is `agent` of the description: the surface of the agent, its space that surface.window answered (nil for a section
// surface), and the card of its tab when that space is the active space whose layout the snapshot holds, else null.
func agentPlace(layout json.RawMessage, surface string, space *string) (map[string]any, error) {
	var tree struct {
		Space *string         `json:"space"`
		Root  json.RawMessage `json:"root"`
	}
	if err := json.Unmarshal(layout, &tree); err != nil {
		return nil, fmt.Errorf("exposure.snapshot has an unexpected layout: %w", err)
	}
	place := map[string]any{"surface": surface, "space": space, "card": nil}
	if space == nil || tree.Space == nil || *tree.Space != *space {
		return place, nil
	}
	card, err := cardOfTab(tree.Root, surface)
	if err != nil {
		return nil, err
	}
	if card != nil {
		place["card"] = card
	}
	return place, nil
}

// cardOfTab finds the card whose tabs hold tab in a node of the layout tree, or nil.
func cardOfTab(node json.RawMessage, tab string) (json.RawMessage, error) {
	if len(node) == 0 || string(node) == "null" {
		return nil, nil
	}
	var fields struct {
		Card     json.RawMessage        `json:"card"`
		Tabs     []struct{ Tab string } `json:"tabs"`
		Children []json.RawMessage      `json:"children"`
	}
	if err := json.Unmarshal(node, &fields); err != nil {
		return nil, fmt.Errorf("exposure.snapshot has an unexpected layout: %w", err)
	}
	for _, entry := range fields.Tabs {
		if entry.Tab == tab {
			return fields.Card, nil
		}
	}
	for _, child := range fields.Children {
		if card, err := cardOfTab(child, tab); card != nil || err != nil {
			return card, err
		}
	}
	return nil, nil
}

// describeWindow is one page of the description of a window from the result of exposure.snapshot. agent is `agent` of the
// description, nil for null. full gives the rows as the snapshot gives them; after and limit select the page.
func describeWindow(snapshot json.RawMessage, agent any, full bool, after string, limit int) ([]byte, error) {
	var parts struct {
		Window       json.RawMessage   `json:"window"`
		Layout       json.RawMessage   `json:"layout"`
		Plugins      json.RawMessage   `json:"plugins"`
		Groups       []snapshotGroup   `json:"groups"`
		Unregistered []json.RawMessage `json:"unregistered"`
	}
	if err := json.Unmarshal(snapshot, &parts); err != nil || parts.Window == nil || parts.Layout == nil || parts.Plugins == nil || parts.Groups == nil || parts.Unregistered == nil {
		return nil, fmt.Errorf("exposure.snapshot returned an unexpected value: %s", snapshot)
	}
	var rows []*describeRow
	for _, group := range parts.Groups {
		name := group.Owner
		if group.Owner == "surface" {
			name = group.Surface
		}
		for _, list := range []struct {
			kind    string
			entries []json.RawMessage
		}{{"status", group.Status}, {"command", group.Commands}, {"element", group.Element}} {
			for _, raw := range list.entries {
				// Without --full, a tab holds only its summary statuses (docs/spec/cli.md#window-description, docs/spec/exposure.md#entry-fields).
				if !full && list.kind == "status" && group.Owner == "surface" {
					summary, err := summaryStatus(raw)
					if err != nil {
						return nil, err
					}
					if !summary {
						continue
					}
				}
				row, err := entryRow(name, group, list.kind, raw, full)
				if err != nil {
					return nil, err
				}
				rows = append(rows, row)
			}
		}
	}
	for _, raw := range parts.Unregistered {
		var entry struct {
			Kind string `json:"kind"`
			Name string `json:"name"`
		}
		if err := json.Unmarshal(raw, &entry); err != nil {
			return nil, fmt.Errorf("exposure.snapshot has an unexpected unregistered entry: %s", raw)
		}
		key := "unregistered " + entry.Kind + " " + entry.Name
		rows = append(rows, &describeRow{key: key, kind: entry.Kind, fields: map[string]any{"key": key, "group": "unregistered", "kind": entry.Kind, "name": entry.Name}})
	}
	start := 0
	if after != "" {
		start = -1
		for n, row := range rows {
			if row.key == after {
				start = n + 1
			}
		}
		if start < 0 {
			return nil, fmt.Errorf("after %s names no row of the description", after)
		}
	}
	page := map[string]any{"rows": []any{}, "total": len(rows), "next": nil}
	var err error
	if after == "" {
		if page["window"], err = compacted(parts.Window); err != nil {
			return nil, err
		}
		if page["layout"], err = compacted(parts.Layout); err != nil {
			return nil, err
		}
		if page["plugins"], err = compacted(parts.Plugins); err != nil {
			return nil, err
		}
		page["agent"] = agent
	}
	base, err := encodeJSON(page)
	if err != nil {
		return nil, err
	}
	// A page without a row holds an empty list.
	kept := []json.RawMessage{}
	size := len(base)
	for n := start; n < len(rows) && len(kept) < limit; n++ {
		row := rows[n]
		text, err := row.encode()
		if err != nil {
			return nil, err
		}
		grown := size + len(text)
		if len(kept) > 0 {
			grown++
		}
		growth, err := nextGrowth(rows, n)
		if err != nil {
			return nil, err
		}
		if grown+growth > describePageBytes {
			if len(kept) > 0 {
				break
			}
			if text, err = row.cutToFit(describePageBytes - size - growth); err != nil {
				return nil, err
			}
			grown = size + len(text)
		}
		kept = append(kept, text)
		size = grown
	}
	page["rows"] = kept
	if last := start + len(kept); last < len(rows) {
		page["next"] = rows[last-1].key
	}
	return encodeJSON(page)
}

// summaryStatus reads the summary member of a status entry of exposure.snapshot. An absent member is false (docs/spec/exposure.md#entry-fields).
func summaryStatus(raw json.RawMessage) (bool, error) {
	var entry struct {
		Summary bool `json:"summary"`
	}
	if err := json.Unmarshal(raw, &entry); err != nil {
		return false, fmt.Errorf("exposure.snapshot has a status whose summary is not a boolean: %s", raw)
	}
	return entry.Summary, nil
}

// compacted is the compact text of a value of the snapshot, which encodeJSON writes as it is.
func compacted(raw json.RawMessage) (json.RawMessage, error) {
	return compactRaw(raw)
}

// nextGrowth is the number of bytes by which `next` grows when the page ends with row n: the key of that row instead of null when
// rows follow it.
func nextGrowth(rows []*describeRow, n int) (int, error) {
	if n+1 >= len(rows) {
		return 0, nil
	}
	key, err := encodeJSON(rows[n].key)
	if err != nil {
		return 0, err
	}
	return len(key) - len("null"), nil
}

// entryRow is the row of one entry of a group.
func entryRow(group string, owner snapshotGroup, kind string, raw json.RawMessage, full bool) (*describeRow, error) {
	var entry map[string]json.RawMessage
	if err := json.Unmarshal(raw, &entry); err != nil || entry == nil {
		return nil, fmt.Errorf("exposure.snapshot has an entry that is not an object in group %s", group)
	}
	var name, description string
	if err := json.Unmarshal(entry["name"], &name); err != nil {
		return nil, fmt.Errorf("exposure.snapshot has an entry without a name in group %s", group)
	}
	if err := json.Unmarshal(entry["description"], &description); err != nil {
		return nil, fmt.Errorf("%s %s of group %s has no description", kind, name, group)
	}
	key := group + " " + kind + " " + name
	row := &describeRow{key: key, kind: kind, fields: map[string]any{}}
	var err error
	if full {
		for member, value := range entry {
			if row.fields[member], err = compacted(value); err != nil {
				return nil, err
			}
		}
	} else {
		row.fields["name"] = name
		row.fields["description"] = firstSentence(description)
	}
	row.fields["key"], row.fields["group"], row.fields["kind"] = key, group, kind
	if owner.Owner == "surface" {
		if row.fields["plugin"], err = compacted(owner.Plugin); err != nil {
			return nil, err
		}
	}
	switch kind {
	case "status":
		if value, ok := entry["value"]; ok {
			text, err := canonicalText(value)
			if err != nil {
				return nil, fmt.Errorf("status %s of group %s: %w", name, group, err)
			}
			row.cutText = string(text)
			if !full {
				row.setValueText(describeValueChars)
			}
		} else if failure, ok := entry["error"]; ok {
			if row.fields["error"], err = compacted(failure); err != nil {
				return nil, err
			}
		}
	case "command":
		if !full {
			params, err := parameterList(entry["params"])
			if err != nil {
				return nil, fmt.Errorf("command %s of group %s: %w", name, group, err)
			}
			row.fields["params"] = params
		}
	case "element":
		if err := json.Unmarshal(entry["items"], &row.items); err != nil {
			return nil, fmt.Errorf("element %s of group %s has no items", name, group)
		}
		if !full {
			for n, item := range row.items {
				brief, err := briefItem(item)
				if err != nil {
					return nil, fmt.Errorf("element %s of group %s: %w", name, group, err)
				}
				row.items[n] = brief
			}
			row.setItems(describeCompactItems)
		}
	}
	return row, nil
}

// canonicalText is the JSON text of a value as encodeJSON writes it, so the text does not depend on the escapes and the member
// order with which the endpoint wrote the value.
func canonicalText(raw json.RawMessage) ([]byte, error) {
	if loneSurrogate(raw) {
		return nil, errors.New("the value holds a lone surrogate escape")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("the value is no JSON: %w", err)
	}
	return encodeJSON(value)
}

// loneSurrogate tells whether a JSON text holds a \u escape of a UTF-16 surrogate that is not one half of a pair, which names no
// character. encoding/json decodes such an escape to U+FFFD and serde_json refuses it, so both implementations refuse the value
// before they decode it.
func loneSurrogate(text []byte) bool {
	surrogate := func(at int) (rune, bool) {
		if at+6 > len(text) || text[at] != '\\' || text[at+1] != 'u' {
			return 0, false
		}
		code, err := strconv.ParseUint(string(text[at+2:at+6]), 16, 32)
		return rune(code), err == nil
	}
	for at := 0; at < len(text); at++ {
		if text[at] != '\\' {
			continue
		}
		code, ok := surrogate(at)
		if !ok {
			// Another escape: the escaped character is skipped with the backslash.
			at++
			continue
		}
		switch {
		case code >= 0xD800 && code <= 0xDBFF:
			low, ok := surrogate(at + 6)
			if !ok || low < 0xDC00 || low > 0xDFFF {
				return true
			}
			at += 11
		case code >= 0xDC00 && code <= 0xDFFF:
			return true
		default:
			at += 5
		}
	}
	return false
}

// setValueText writes the JSON text of the status value cut to chars Unicode scalar values, with cut when it was cut.
func (r *describeRow) setValueText(chars int) {
	text := r.cutText
	if utf8.RuneCountInString(text) > chars {
		runes := []rune(text)
		r.fields["value"] = string(runes[:chars])
		r.fields["cut"] = true
		return
	}
	r.fields["value"] = text
	delete(r.fields, "cut")
}

// setItems keeps the first count items, with cut and itemsTotal when it left items out.
func (r *describeRow) setItems(count int) {
	if len(r.items) > count {
		r.fields["items"] = r.items[:count]
		r.fields["cut"] = true
		r.fields["itemsTotal"] = len(r.items)
		return
	}
	r.fields["items"] = r.items
	delete(r.fields, "cut")
	delete(r.fields, "itemsTotal")
}

func (r *describeRow) encode() ([]byte, error) {
	return encodeJSON(r.fields)
}

// cutToFit cuts the value or the items of a row that alone passes the bound of a page to the longest part with which its text has
// at most room bytes. A row that has no value or items to cut stays whole.
func (r *describeRow) cutToFit(room int) ([]byte, error) {
	var set func(int)
	var total int
	switch {
	case r.kind == "status" && r.fields["value"] != nil:
		set, total = r.setValueText, utf8.RuneCountInString(r.cutText)
		// The full form gives the value whole, so a cut value is its JSON text as in the compact form.
	case r.kind == "element" && r.items != nil:
		set, total = r.setItems, len(r.items)
	default:
		return r.encode()
	}
	fits := func(count int) bool {
		set(count)
		r.fields["cut"] = true
		text, err := r.encode()
		return err == nil && len(text) <= room
	}
	// The longest part that fits: fits(low) holds or low is 0, and fits(high) does not hold.
	low, high := 0, total
	for low+1 < high {
		middle := (low + high) / 2
		if fits(middle) {
			low = middle
		} else {
			high = middle
		}
	}
	set(low)
	r.fields["cut"] = true
	if r.kind == "element" {
		r.fields["itemsTotal"] = len(r.items)
	}
	return r.encode()
}

// firstSentence is the text up to the end of its first sentence: the first period that a white space or the end follows.
func firstSentence(text string) string {
	for n := 0; n < len(text); n++ {
		if text[n] == '.' && (n+1 == len(text) || text[n+1] == ' ' || text[n+1] == '\t' || text[n+1] == '\n' || text[n+1] == '\r') {
			return text[:n+1]
		}
	}
	return text
}

// parameterList writes the parameters of a command schema as `<name>: <type>` in the order of their names. A type list is
// joined with |, and a parameter without a type is any.
func parameterList(schema json.RawMessage) ([]string, error) {
	var fields struct {
		Properties map[string]struct {
			Type json.RawMessage `json:"type"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(schema, &fields); err != nil {
		return nil, errors.New("its params schema is not an object")
	}
	names := make([]string, 0, len(fields.Properties))
	for name := range fields.Properties {
		names = append(names, name)
	}
	sort.Strings(names)
	params := []string{}
	for _, name := range names {
		kind := "any"
		raw := fields.Properties[name].Type
		var single string
		var several []string
		if json.Unmarshal(raw, &single) == nil {
			kind = single
		} else if json.Unmarshal(raw, &several) == nil && len(several) > 0 {
			kind = strings.Join(several, "|")
		}
		params = append(params, name+": "+kind)
	}
	return params, nil
}

// briefItem is an element item of the compact form: index, role, text, visible, inert and command.
func briefItem(item json.RawMessage) (json.RawMessage, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(item, &fields); err != nil || fields == nil {
		return nil, errors.New("an item is not an object")
	}
	brief := map[string]any{}
	for _, member := range []string{"index", "role", "text", "visible", "inert", "command"} {
		if value, ok := fields[member]; ok {
			compact, err := compacted(value)
			if err != nil {
				return nil, err
			}
			brief[member] = compact
		}
	}
	return encodeJSON(brief)
}

// runAgentView runs `sok describe`, `sok context`, and `sok commands` and `sok exposures` with --kind or --query. It reports
// whether the command is one of them.
func runAgentView(a arguments, stdout io.Writer, options Options, connect func() (*Client, error)) (bool, error) {
	command := ""
	if len(a.positionals) > 0 {
		command = a.positionals[0]
	}
	_, byKind := a.values["kind"]
	_, byQuery := a.values["query"]
	switch {
	case command == "describe" || command == "context":
	case command == "exposures" && (byKind || byQuery):
	case command == "commands" && byQuery && !byKind:
	default:
		if byKind || byQuery || a.flags["full"] {
			return false, usage("--kind, --query and --full belong to describe, exposures and commands")
		}
		return false, nil
	}
	if command == "context" {
		// context names no window and reads only the configuration directory.
		if len(a.positionals) > 1 {
			return true, usage("context takes no argument: %s", a.positionals[1])
		}
		for name := range a.values {
			if name != "config-dir" {
				return true, usage("context takes only --config-dir")
			}
		}
		for _, given := range a.flags {
			if given {
				return true, usage("context takes only --config-dir")
			}
		}
	}
	if len(a.positionals) > 1 {
		return true, usage("%s takes no argument besides [window]", command)
	}
	kind := a.values["kind"]
	if byKind && kind != "status" && kind != "command" && kind != "element" {
		return true, usage("--kind must be status, command or element")
	}
	limit := describeDefaultLimit
	if text, ok := a.values["limit"]; ok {
		parsed, err := strconv.Atoi(text)
		if err != nil || parsed < 1 || parsed > describeMaxLimit {
			return true, usage("--limit must be an integer from 1 to %d", describeMaxLimit)
		}
		limit = parsed
	}
	var out []byte
	if command == "context" {
		configDir, err := configDirOf(a.values, options)
		if err != nil {
			return true, err
		}
		// Without SOKSAK_SURFACE the context needs no request, so it connects only for surface.window.
		context, err := agentContext(func(method string, params any) (json.RawMessage, error) {
			client, err := connect()
			if err != nil {
				return nil, err
			}
			return client.Request(method, params)
		}, configDir)
		if err != nil {
			return true, err
		}
		if out, err = encodeJSON(context); err != nil {
			return true, err
		}
		text, err := indent(out)
		if err != nil {
			return true, err
		}
		_, err = stdout.Write(text)
		return true, err
	}
	client, err := connect()
	if err != nil {
		return true, err
	}
	switch command {
	case "describe":
		// The window of the agent's surface is asked once, and its answer gives the space of the agent too.
		var home *surfaceHome
		_, byName := a.values["window"]
		_, byProject := a.values["project"]
		if own := agentSurface(); own != "" && !byName && !byProject {
			found, err := surfaceWindow(client.Request, own)
			if err != nil {
				return true, err
			}
			home = &found
		}
		var window string
		if home != nil {
			window = home.Window
		} else if window, err = selectWindow(a, client); err != nil {
			return true, err
		}
		if out, err = describeRequest(client.Request, window, home, a.values["surface"], a.flags["full"], a.values["after"], limit); err != nil {
			return true, err
		}
	default:
		window, err := selectWindow(a, client)
		if err != nil {
			return true, err
		}
		result, err := client.Request("exposure.list", map[string]any{"window": window})
		if err != nil {
			return true, err
		}
		read, err := readExposure(result)
		if err != nil {
			return true, err
		}
		if command == "commands" {
			out = matchingCommands(read, a.values["query"])
		} else if out, err = filterExposure(read, kind, a.values["query"]); err != nil {
			return true, err
		}
	}
	text, err := indent(out)
	if err != nil {
		return true, err
	}
	_, err = stdout.Write(text)
	return true, err
}
