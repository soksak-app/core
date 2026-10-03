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

// 페이지가 보낸 host 호출 인자를 해석한다(docs/spec/native-host.md#host-calls). encoding/json 은 빠진 field 와
// 숫자 field 의 null 을 오류 없이 zero value 로 두므로, 먼저 JSON 값을 선언된 형식과 대조해 다르면 거부하고
// 같을 때만 해석한다. Tauri host 의 인자 decoder 와 같은 문장으로 거부한다.

var rawMessageType = reflect.TypeOf(json.RawMessage(nil))

// decodeArgument 는 이름이 name 인 인자 raw 를 into 로 해석한다.
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

// jsonKind 는 JSON 값의 형식 이름이다.
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

// integerRange 는 정수 형식 t 의 범위를 문장으로 쓴다.
func integerRange(t reflect.Type) string {
	bits := t.Bits()
	switch t.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return fmt.Sprintf("from %d to %d", int64(-1)<<(bits-1), int64(1)<<(bits-1)-1)
	}
	return fmt.Sprintf("from 0 to %d", uint64(math.MaxUint64)>>(64-bits))
}

// checkArgument 는 JSON 값 value 가 형식 t 를 따르는지 path 의 자리에서 확인한다.
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

// checkFields 는 객체 fields 가 구조체 t 의 field 를 따르는지 확인한다. 이름 없이 포함한 구조체는 같은 객체의
// field 다. pointer field 와 json tag 에 omitempty 가 있는 field 는 빠질 수 있다.
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
		// null 인 field 는 빠진 field 다(docs/spec/native-host.md#host-calls).
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

// argument 는 이름이 name 인 binding 인자 raw 를 T 로 해석한다.
func argument[T any](name string, raw json.RawMessage) (T, error) {
	var value T
	err := decodeArgument(name, raw, &value)
	return value, err
}
