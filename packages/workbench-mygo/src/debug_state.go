package workbench

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// The state files of the debug view (docs/spec/debug.md), as packages/workbench/debug-state.js reads them:
// `logs/state-<time>.json` is parsed, shown as tree lines in file order and compared with another state file.

// DebugEntry is a file of the logs folder that `debugFiles` lists.
type DebugEntry struct {
	Path     string `json:"path"`
	Size     int64  `json:"size"`
	Modified int64  `json:"modified"`
}

// DebugDifference is a path whose value differs between two state files. A value that a file does not have is nil.
type DebugDifference struct {
	Path string
	A    *string
	B    *string
}

// DebugState is a parsed state file. It keeps the members in file order.
type DebugState struct{ root stateValue }

// stateValue is a JSON value: the members of an object or an array, or the text of any other value.
type stateValue struct {
	array     bool
	container bool
	text      string
	members   []stateMember
}

type stateMember struct {
	name  string
	value stateValue
}

var (
	stateFilePath = regexp.MustCompile(`^logs/state-[^/]+\.json$`)
	identifier    = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]*$`)
	stateHosts    = []string{"wailsv3", "tauriv2", "mygo"}
)

// NewestFirst returns the entries in the order of the list: the newest first, and files of the same time by path.
func NewestFirst(entries []DebugEntry) []DebugEntry {
	sorted := slices.Clone(entries)
	slices.SortStableFunc(sorted, func(left, right DebugEntry) int {
		if left.Modified != right.Modified {
			return int(right.Modified - left.Modified)
		}
		return strings.Compare(left.Path, right.Path)
	})
	return sorted
}

// DebugStateFiles returns the state files of the list, in path order.
func DebugStateFiles(entries []DebugEntry) []string {
	paths := []string{}
	for _, entry := range entries {
		if stateFilePath.MatchString(entry.Path) {
			paths = append(paths, entry.Path)
		}
	}
	slices.Sort(paths)
	return paths
}

func parseStateValue(raw []byte) (stateValue, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || (raw[0] != '{' && raw[0] != '[') {
		var compact bytes.Buffer
		if err := json.Compact(&compact, raw); err != nil {
			return stateValue{}, err
		}
		return stateValue{text: compact.String()}, nil
	}
	array := raw[0] == '['
	value := stateValue{array: array, container: true}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if _, err := decoder.Token(); err != nil {
		return stateValue{}, err
	}
	for index := 0; decoder.More(); index++ {
		name := fmt.Sprint(index)
		if !array {
			token, err := decoder.Token()
			if err != nil {
				return stateValue{}, err
			}
			name = token.(string)
		}
		var member json.RawMessage
		if err := decoder.Decode(&member); err != nil {
			return stateValue{}, err
		}
		parsed, err := parseStateValue(member)
		if err != nil {
			return stateValue{}, err
		}
		// A key that the text repeats keeps its first position and takes the last value, as JSON.parse does.
		if at := slices.IndexFunc(value.members, func(m stateMember) bool { return m.name == name }); at >= 0 {
			value.members[at].value = parsed
		} else {
			value.members = append(value.members, stateMember{name, parsed})
		}
	}
	if _, err := decoder.Token(); err != nil {
		return stateValue{}, err
	}
	return value, nil
}

func (v stateValue) member(name string) (stateValue, bool) {
	at := slices.IndexFunc(v.members, func(m stateMember) bool { return m.name == name })
	if at < 0 {
		return stateValue{}, false
	}
	return v.members[at].value, true
}

// json returns the JSON text of the value.
func (v stateValue) json() string {
	if !v.container {
		return v.text
	}
	parts := make([]string, len(v.members))
	for i, member := range v.members {
		parts[i] = member.value.json()
		if !v.array {
			parts[i] = quoted(member.name) + ":" + parts[i]
		}
	}
	if v.array {
		return "[" + strings.Join(parts, ",") + "]"
	}
	return "{" + strings.Join(parts, ",") + "}"
}

func (v stateValue) isObject() bool { return v.container && !v.array }

func quoted(text string) string {
	buffer := &bytes.Buffer{}
	encoder := json.NewEncoder(buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(text); err != nil {
		return `""`
	}
	return strings.TrimSpace(buffer.String())
}

// foundText is the text of a member in an error: its JSON text, and `undefined` for a member that the file does not have.
func foundText(value stateValue, ok bool) string {
	if !ok {
		return "undefined"
	}
	return value.json()
}

// ParseDebugState reads the text of the state file, or fails with an error that names the file and what was found.
func ParseDebugState(file, text string, truncated bool) (DebugState, error) {
	if truncated {
		return DebugState{}, errors.New(file + ": the text was cut at the read limit, so the state cannot be read")
	}
	if !json.Valid([]byte(text)) {
		var unused any
		return DebugState{}, fmt.Errorf("%s: not JSON: %w", file, json.Unmarshal([]byte(text), &unused))
	}
	root, err := parseStateValue([]byte(text))
	if err != nil {
		return DebugState{}, fmt.Errorf("%s: not JSON: %w", file, err)
	}
	if !root.isObject() {
		start := []rune(text)
		return DebugState{}, fmt.Errorf("%s: not a state object: %s", file, string(start[:min(80, len(start))]))
	}
	time, ok := root.member("time")
	if !ok || time.container || !strings.HasPrefix(time.text, `"`) {
		return DebugState{}, fmt.Errorf("%s: time must be a string, found %s", file, foundText(time, ok))
	}
	host, ok := root.member("host")
	if !ok || !slices.ContainsFunc(stateHosts, func(name string) bool { return quoted(name) == host.text }) {
		return DebugState{}, fmt.Errorf("%s: host %s is not one of %s", file, foundText(host, ok), strings.Join(stateHosts, ", "))
	}
	versions, ok := root.member("versions")
	if !ok || !versions.isObject() {
		return DebugState{}, fmt.Errorf("%s: versions must be an object, found %s", file, foundText(versions, ok))
	}
	// `workbench` is the value the workbench sent: the entries of its exposure, so an array is as valid as an object.
	workbench, ok := root.member("workbench")
	if !ok || !workbench.container {
		return DebugState{}, fmt.Errorf("%s: workbench must be an object or an array, found %s", file, foundText(workbench, ok))
	}
	windows, ok := root.member("windows")
	if !ok || !windows.array {
		return DebugState{}, fmt.Errorf("%s: windows must be an array, found %s", file, foundText(windows, ok))
	}
	return DebugState{root: root}, nil
}

// DebugStateLines returns the tree lines of the state in file order: `key: <JSON value>` for a value and for an empty
// container, and `key {n}` or `key [n]` for an object or an array with n members, indented by depth.
func DebugStateLines(state DebugState) []string {
	lines := []string{}
	var walk func(value stateValue, key string, depth int)
	walk = func(value stateValue, key string, depth int) {
		indent := strings.Repeat("  ", depth)
		if !value.container || len(value.members) == 0 {
			lines = append(lines, indent+key+": "+value.json())
			return
		}
		size := fmt.Sprintf("{%d}", len(value.members))
		if value.array {
			size = fmt.Sprintf("[%d]", len(value.members))
		}
		lines = append(lines, indent+key+" "+size)
		for _, member := range value.members {
			name := member.name
			if value.array {
				name = "[" + name + "]"
			}
			walk(member.value, name, depth+1)
		}
	}
	for _, member := range state.root.members {
		walk(member.value, member.name, 0)
	}
	return lines
}

func memberPath(path, name string, array bool) string {
	switch {
	case array:
		return path + "[" + name + "]"
	case !identifier.MatchString(name):
		return path + "[" + quoted(name) + "]"
	case path == "":
		return name
	}
	return path + "." + name
}

type stateLeaf struct{ path, text string }

func stateLeaves(value stateValue, path string, leaves []stateLeaf) []stateLeaf {
	if !value.container || len(value.members) == 0 {
		return append(leaves, stateLeaf{path, value.json()})
	}
	for _, member := range value.members {
		leaves = stateLeaves(member.value, memberPath(path, member.name, value.array), leaves)
	}
	return leaves
}

// CompareDebugStates returns the paths of the first state whose value differs or is absent in the second, then the paths
// that only the second state has. A value is its JSON text.
func CompareDebugStates(first, second DebugState) []DebugDifference {
	left, right := stateLeaves(first.root, "", nil), stateLeaves(second.root, "", nil)
	find := func(leaves []stateLeaf, path string) *string {
		at := slices.IndexFunc(leaves, func(leaf stateLeaf) bool { return leaf.path == path })
		if at < 0 {
			return nil
		}
		return &leaves[at].text
	}
	differences := []DebugDifference{}
	for i := range left {
		if other := find(right, left[i].path); other == nil || *other != left[i].text {
			differences = append(differences, DebugDifference{Path: left[i].path, A: &left[i].text, B: other})
		}
	}
	for i := range right {
		if find(left, right[i].path) == nil {
			differences = append(differences, DebugDifference{Path: right[i].path, B: &right[i].text})
		}
	}
	return differences
}
