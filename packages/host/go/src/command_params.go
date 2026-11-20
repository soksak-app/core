package host

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"

	sok "github.com/soksak-app/core/packages/sok/go/src"
)

// CommandParamsRefusal is the refusal of the parameters of the command name by its params schema, or "" when the command may run
// (docs/spec/exposure.md#command-parameters): the first member in code point order that properties of the schema does not name, then
// the first member of required that the parameters lack, then parameters that do not match the schema otherwise. The registry of the
// mygo workbench and the endpoint of the host refuse a command with it. The check is written here and not taken from a JSON Schema
// library, because the registry of the page and the Rust host answer the same texts, which the libraries of the three languages word
// differently.
func CommandParamsRefusal(name string, schema any, raw json.RawMessage) string {
	// The schema is read again as JSON, and both are decoded with numbers as json.Number, as the matcher of the reader takes them.
	text, err := json.Marshal(schema)
	if err != nil {
		return fmt.Sprintf("the params schema of %s is not JSON: %v", name, err)
	}
	var declared, params map[string]any
	if err := decodeNumbers(text, &declared); err != nil || declared == nil {
		return fmt.Sprintf("the params schema of %s is not an object", name)
	}
	if err := decodeNumbers(raw, &params); err != nil || params == nil {
		return fmt.Sprintf("params of %s must be an object", name)
	}
	// default: a schema without properties declares no parameter, and one without required requires none.
	properties, _ := declared["properties"].(map[string]any)
	names := make([]string, 0, len(params))
	for key := range params {
		names = append(names, key)
	}
	sort.Strings(names)
	for _, key := range names {
		if _, ok := properties[key]; !ok {
			return fmt.Sprintf("command %s: unknown parameter %s", name, key)
		}
	}
	required, _ := declared["required"].([]any)
	for _, key := range required {
		member, _ := key.(string)
		if _, present := params[member]; !present {
			return fmt.Sprintf("command %s: parameter %s is required", name, member)
		}
	}
	if !sok.MatchesSchema(declared, params) {
		return "invalid params for " + name
	}
	return ""
}

// decodeNumbers decodes JSON text into into with numbers as json.Number.
func decodeNumbers(text []byte, into any) error {
	decoder := json.NewDecoder(bytes.NewReader(text))
	decoder.UseNumber()
	return decoder.Decode(into)
}
