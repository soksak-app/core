package host

import (
	"bytes"
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"regexp"
	"slices"
	"strings"
)

// rolesFormat is the format number of roles.json, the role definitions of the agent roles
// (docs/spec/agent-roles.md#role-definitions).
const rolesFormat = 1

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
	document, err := checkRoles(path, value)
	if err != nil {
		return nil, err
	}
	return document, nil
}

// writeRoles writes the role definitions of roles to roles.json at path, after the same check that the reader makes.
// A refused definition writes nothing.
func writeRoles(path string, roles Record) (Record, error) {
	if roles == nil {
		return nil, fmt.Errorf("%s: roles: roles must be an object", path)
	}
	document := map[string]any{"format": float64(rolesFormat), "roles": map[string]any(roles)}
	if _, err := checkRoles(path, document); err != nil {
		return nil, err
	}
	if err := writeJSON(path, document); err != nil {
		return nil, err
	}
	return roles, nil
}

// checkRoles checks a decoded roles.json document and returns its role definitions. Each refusal names the file. The members
// are checked in a fixed order: the format, the unknown members, the roles object, then each role in identifier order.
func checkRoles(path string, value any) (Record, error) {
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
		for _, field := range slices.Sorted(maps.Keys(definition)) {
			if field != "text" {
				return nil, fmt.Errorf("%s: roles: role %s unknown field %s", path, id, field)
			}
		}
		if _, ok := definition["text"].(string); !ok {
			return nil, fmt.Errorf("%s: roles: role %s text must be a string", path, id)
		}
	}
	return Record(roles), nil
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
