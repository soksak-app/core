package host

// The role definitions of roles.json and the commands that define and remove them (docs/spec/agent-roles.md#role-definitions,
// #commands and #role-status).

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"unicode"
)

// rolesFormat is the format number of roles.json, the role definitions of the agent roles
// (docs/spec/agent-roles.md#role-definitions). The reader refuses every other number.
const rolesFormat = 3

// roleIdentifier is the identifier rule of a role: a lowercase letter, then lowercase letters, digits and hyphens, at most 64
// characters in all.
var roleIdentifier = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

// readRoles reads the role definitions of roles.json at path. A missing file holds no role and is not created.
func readRoles(path string) (Record, error) {
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return Record{}, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return checkRoles(path, value, true)
}

// writeRoles writes the role definitions of roles to roles.json at path, after the same check that the reader makes.
// A refused definition writes nothing.
func writeRoles(path string, roles Record) (Record, error) {
	if roles == nil {
		return nil, fmt.Errorf("%s: roles: roles must be an object", path)
	}
	document := map[string]any{"format": float64(rolesFormat), "roles": map[string]any(roles)}
	if _, err := checkRoles(path, document, true); err != nil {
		return nil, err
	}
	if err := writeJSON(path, document); err != nil {
		return nil, fmt.Errorf("%s: roles: write failed: %w", path, err)
	}
	return roles, nil
}

// checkRoles checks a decoded roles.json document and returns its role definitions. Each refusal names the file. The members
// are checked in a fixed order: the format, the unknown members, the roles object, then each role in identifier order, whose
// members are checked as text, ko, files and then the unknown members. checkPaths also checks each path of files; the command
// that defines a role checks its own paths with its own texts, so it passes false.
func checkRoles(path string, value any, checkPaths bool) (Record, error) {
	// default: a document that is not an object has no format, which the refusal names as null (docs/spec/agent-roles.md#role-definitions).
	document, _ := value.(map[string]any)
	format := document["format"]
	if number, ok := format.(float64); !ok || number != rolesFormat {
		text, err := jsonText(format)
		if err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("%s: roles: format must be %d, found %s", path, rolesFormat, text)
	}
	for _, key := range slices.Sorted(maps.Keys(document)) {
		if key != "format" && key != "roles" {
			return nil, fmt.Errorf("%s: roles: unknown field %s", path, key)
		}
	}
	roles, ok := document["roles"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s: roles: roles must be an object", path)
	}
	for _, id := range slices.Sorted(maps.Keys(roles)) {
		if !roleIdentifier.MatchString(id) {
			return nil, fmt.Errorf("%s: roles: invalid role identifier %s", path, id)
		}
		definition, ok := roles[id].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("%s: roles: role %s must be an object", path, id)
		}
		if _, ok := definition["text"].(string); !ok {
			return nil, fmt.Errorf("%s: roles: role %s text must be a string", path, id)
		}
		if _, ok := definition["ko"].(string); !ok {
			return nil, fmt.Errorf("%s: roles: role %s ko must be a string", path, id)
		}
		files, ok := stringList(definition["files"])
		if !ok {
			return nil, fmt.Errorf("%s: roles: role %s files must be an array of strings", path, id)
		}
		if checkPaths {
			for _, file := range files {
				if !filepath.IsAbs(file) {
					return nil, fmt.Errorf("%s: roles: role %s file %s is not absolute", path, id, file)
				}
				if holdsControl(file) {
					return nil, fmt.Errorf("%s: roles: role %s file %s holds a control character", path, id, file)
				}
			}
		}
		for _, field := range slices.Sorted(maps.Keys(definition)) {
			if field != "text" && field != "ko" && field != "files" {
				return nil, fmt.Errorf("%s: roles: role %s unknown field %s", path, id, field)
			}
		}
	}
	return Record(roles), nil
}

// stringList returns the texts of a list that holds only texts, decoded from JSON or built by a caller, and reports whether
// value is such a list.
func stringList(value any) ([]string, bool) {
	switch list := value.(type) {
	case []string:
		return list, true
	case []any:
		texts := make([]string, 0, len(list))
		for _, item := range list {
			text, ok := item.(string)
			if !ok {
				return nil, false
			}
			texts = append(texts, text)
		}
		return texts, true
	}
	return nil, false
}

// holdsControl reports whether text holds a control character.
func holdsControl(text string) bool {
	return strings.IndexFunc(text, unicode.IsControl) >= 0
}

// jsonText returns the compact JSON text of a decoded JSON value, as a refusal names the value it found.
func jsonText(value any) (string, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return "", err
	}
	return strings.TrimSuffix(buffer.String(), "\n"), nil
}

// roleDefine defines the role id with the definition entry, `{text, ko, files}`, or changes its definition
// (docs/spec/agent-roles.md#commands). It checks the input and the paths, writes roles.json when the definition differs from the
// stored one, then repairs each tab that holds the role with a record of another fingerprint. A failed tab is reported and the
// other tabs continue; roles.json keeps the new definition.
func (w *Workspace) roleDefine(id string, entry Record) (Record, error) {
	path := filepath.Join(w.directory, "roles.json")
	stored, err := readRoles(path)
	if err != nil {
		return nil, err
	}
	candidate := Record{}
	maps.Copy(candidate, stored)
	candidate[id] = map[string]any(entry)
	// The input is checked with the rules of roles.json; the paths are checked below with the texts of the command.
	if _, err := checkRoles(path, map[string]any{"format": float64(rolesFormat), "roles": map[string]any(candidate)}, false); err != nil {
		return nil, err
	}
	// silent: checkRoles above rejects an entry whose text is not a string, so the read holds the validated text.
	text, _ := entry["text"].(string)
	// silent: checkRoles above rejects an entry whose ko is not a string, so the read holds the validated ko.
	ko, _ := entry["ko"].(string)
	// silent: checkRoles above rejects an entry whose files is not a string list, so the ok result is true here.
	files, _ := stringList(entry["files"])
	for _, file := range files {
		if err := checkDefinedPath(id, file); err != nil {
			return nil, err
		}
	}
	definition := map[string]any(entry)
	if held, has := stored[id]; !has || !sameJSON(held, definition) {
		if _, err := writeRoles(path, candidate); err != nil {
			return nil, err
		}
		w.rolesSeq++
	}
	holders, err := w.tabRoles()
	if err != nil {
		return nil, err
	}
	fingerprint := RoleFingerprint(id, text, files)
	var failures []error
	for _, holder := range holders {
		if holder.record == nil || holder.record["id"] != id || holder.record["fingerprint"] == fingerprint {
			continue
		}
		if _, err := w.roleChange(holder.tab, id); err != nil {
			failures = append(failures, err)
		}
	}
	if err := errors.Join(failures...); err != nil {
		return nil, err
	}
	if files == nil {
		files = []string{}
	}
	return Record{"id": id, "text": text, "ko": ko, "files": files}, nil
}

// checkDefinedPath checks one path of a role that core.role.define gives, in the texts of the command.
func checkDefinedPath(id, file string) error {
	if !filepath.IsAbs(file) {
		return fmt.Errorf("role %s: file %s is not absolute", id, file)
	}
	if holdsControl(file) {
		return fmt.Errorf("role %s: file %s holds a control character", id, file)
	}
	if _, err := os.Stat(file); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("role %s: file %s does not exist", id, file)
		}
		return fmt.Errorf("role %s: file %s: %w", id, file, err)
	}
	return nil
}

// sameJSON reports whether two values have the same JSON text, so that a stored definition and a new one compare by their content.
func sameJSON(a, b any) bool {
	left, errA := json.Marshal(a)
	right, errB := json.Marshal(b)
	return errA == nil && errB == nil && bytes.Equal(left, right)
}

// roleDefinitionRemove removes the role id from roles.json (docs/spec/agent-roles.md#commands). A role that is not defined, or
// that a tab uses, is refused and nothing is written; the refusal of a used role names the first such tab in layout order.
func (w *Workspace) roleDefinitionRemove(id string) (any, error) {
	path := filepath.Join(w.directory, "roles.json")
	stored, err := readRoles(path)
	if err != nil {
		return nil, err
	}
	if _, has := stored[id]; !has {
		return nil, fmt.Errorf("role %s is not defined", id)
	}
	holders, err := w.tabRoles()
	if err != nil {
		return nil, err
	}
	for _, holder := range holders {
		if holder.record != nil && holder.record["id"] == id {
			return nil, fmt.Errorf("role %s is used by tab %s", id, holder.tab)
		}
	}
	remaining := Record{}
	maps.Copy(remaining, stored)
	delete(remaining, id)
	if _, err := writeRoles(path, remaining); err != nil {
		return nil, err
	}
	w.rolesSeq++
	return true, nil
}

// rolesStatus answers the status core.roles: `{seq, roles}` with the definitions in identifier order, and no tab
// (docs/spec/agent-roles.md#role-status).
func (w *Workspace) rolesStatus() (Record, error) {
	stored, err := readRoles(filepath.Join(w.directory, "roles.json"))
	if err != nil {
		return nil, err
	}
	list := []any{}
	for _, id := range slices.Sorted(maps.Keys(stored)) {
		definition, ok := stored[id].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("role %s must be an object", id)
		}
		list = append(list, Record{"id": id, "text": definition["text"], "ko": definition["ko"], "files": definition["files"]})
	}
	return Record{"seq": w.rolesSeq, "roles": list}, nil
}

// tabRole is one tab of the stored layouts with its validated role record, nil for a tab without a role.
type tabRole struct {
	tab    string
	record Record
}

// tabRoles returns every tab of the stored layouts in layout order, with its validated role record. A stored layout or a role
// record of another form is refused with the text of the file.
func (w *Workspace) tabRoles() ([]tabRole, error) {
	registry := filepath.Join(w.directory, "projects.json")
	projects, err := readProjects(registry)
	if err != nil {
		return nil, err
	}
	if err := checkProjects(registry, projects); err != nil {
		return nil, err
	}
	var tabs []tabRole
	for _, project := range projects {
		root, hasRoot := project["root"].(string)
		if !hasRoot {
			return nil, invalidStoredLayout(registry, "a project record without a root")
		}
		spaces, hasSpaces := project["spaces"].([]any)
		if !hasSpaces {
			return nil, invalidStoredLayout(registry, "a project record without a spaces list")
		}
		for _, item := range spaces {
			space, isSpace := item.(map[string]any)
			if !isSpace {
				return nil, invalidStoredLayout(registry, "a space record that is not an object")
			}
			spaceID, hasID := space["id"].(string)
			if !hasID {
				return nil, invalidStoredLayout(registry, "a space record without an id")
			}
			var found []foundTab
			if err := walkTabs(registry, space["layout"], func(held foundTab) { found = append(found, held) }); err != nil {
				return nil, err
			}
			for _, held := range found {
				record, err := checkedTabRole(registry, root, spaceID, held.id, held.record)
				if err != nil {
					return nil, err
				}
				tabs = append(tabs, tabRole{tab: held.id, record: record})
			}
		}
	}
	return tabs, nil
}
