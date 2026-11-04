package host

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"slices"
	"strconv"
	"strings"
)

// Decodes the host call arguments that the page sent (docs/spec/native-host.md#host-calls). encoding/json leaves a missing field and a
// null in a numeric field as the zero value without an error, so the JSON value is first compared with the declared type, rejected when it differs,
// and decoded only when it matches. The rejection uses the same sentence as the argument decoder of the Tauri host.

var rawMessageType = reflect.TypeOf(json.RawMessage(nil))

// decodeArgument decodes the argument raw named name into into.
func decodeArgument(name string, raw json.RawMessage, into any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return fmt.Errorf("argument %s is not JSON: %w", name, err)
	}
	if err := checkArgument(value, reflect.TypeOf(into).Elem(), name); err != nil {
		return err
	}
	return json.Unmarshal(raw, into)
}

// jsonKind is the type name of a JSON value.
func jsonKind(value any) string {
	switch value.(type) {
	case nil:
		return "null"
	case bool:
		return "a boolean"
	case json.Number:
		return "a number"
	case string:
		return "a string"
	case []any:
		return "an array"
	default:
		return "an object"
	}
}

func mismatch(path, expected string, value any) error {
	return fmt.Errorf("argument %s must be %s, not %s", path, expected, jsonKind(value))
}

// integerRange writes the range of the integer type t as a sentence.
func integerRange(t reflect.Type) string {
	bits := t.Bits()
	switch t.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return fmt.Sprintf("from %d to %d", int64(-1)<<(bits-1), int64(1)<<(bits-1)-1)
	}
	return fmt.Sprintf("from 0 to %d", uint64(math.MaxUint64)>>(64-bits))
}

// checkArgument checks at the position path that the JSON value value follows the type t.
func checkArgument(value any, t reflect.Type, path string) error {
	if t == rawMessageType || t.Kind() == reflect.Interface {
		return nil
	}
	if t.Kind() == reflect.Pointer {
		if value == nil {
			return nil
		}
		return checkArgument(value, t.Elem(), path)
	}
	switch t.Kind() {
	case reflect.Bool:
		if _, ok := value.(bool); !ok {
			return mismatch(path, "a boolean", value)
		}
	case reflect.String:
		if _, ok := value.(string); !ok {
			return mismatch(path, "a string", value)
		}
	case reflect.Float32, reflect.Float64:
		if _, ok := value.(json.Number); !ok {
			return mismatch(path, "a number", value)
		}
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		number, ok := value.(json.Number)
		if !ok {
			return mismatch(path, "a number", value)
		}
		if _, err := strconv.ParseInt(number.String(), 10, t.Bits()); err != nil {
			return fmt.Errorf("argument %s must be an integer %s", path, integerRange(t))
		}
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		number, ok := value.(json.Number)
		if !ok {
			return mismatch(path, "a number", value)
		}
		if _, err := strconv.ParseUint(number.String(), 10, t.Bits()); err != nil {
			return fmt.Errorf("argument %s must be an integer %s", path, integerRange(t))
		}
	case reflect.Slice, reflect.Array:
		items, ok := value.([]any)
		if !ok {
			return mismatch(path, "an array", value)
		}
		if t.Kind() == reflect.Array && len(items) != t.Len() {
			return fmt.Errorf("argument %s must be an array of %d items", path, t.Len())
		}
		for i, item := range items {
			if err := checkArgument(item, t.Elem(), fmt.Sprintf("%s[%d]", path, i)); err != nil {
				return err
			}
		}
	case reflect.Map:
		fields, ok := value.(map[string]any)
		if !ok {
			return mismatch(path, "an object", value)
		}
		for key, item := range fields {
			if err := checkArgument(item, t.Elem(), path+"."+key); err != nil {
				return err
			}
		}
	case reflect.Struct:
		fields, ok := value.(map[string]any)
		if !ok {
			return mismatch(path, "an object", value)
		}
		return checkFields(fields, t, path)
	default:
		return fmt.Errorf("argument %s has the undecodable type %s", path, t)
	}
	return nil
}

// checkFields checks that the object fields follows the fields of the struct t. A struct embedded without a name contributes fields of the same object.
// A pointer field and a field whose json tag has omitempty may be missing.
func checkFields(fields map[string]any, t reflect.Type, path string) error {
	for i := 0; i < t.NumField(); i++ {
		field := t.Field(i)
		if !field.IsExported() {
			continue
		}
		tag := strings.Split(field.Tag.Get("json"), ",")
		name := tag[0]
		if name == "-" {
			continue
		}
		if field.Anonymous && name == "" && field.Type.Kind() == reflect.Struct {
			if err := checkFields(fields, field.Type, path); err != nil {
				return err
			}
			continue
		}
		if name == "" {
			name = field.Name
		}
		// A field that is null is a missing field (docs/spec/native-host.md#host-calls).
		item := fields[name]
		if item == nil {
			if field.Type.Kind() == reflect.Pointer || slices.Contains(tag[1:], "omitempty") {
				continue
			}
			return fmt.Errorf("argument %s is missing", path+"."+name)
		}
		if err := checkArgument(item, field.Type, path+"."+name); err != nil {
			return err
		}
	}
	return nil
}

// argument decodes the binding argument raw named name as T.
func argument[T any](name string, raw json.RawMessage) (T, error) {
	var value T
	err := decodeArgument(name, raw, &value)
	return value, err
}
