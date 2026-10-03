package host

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
)

// 페이지가 보낸 binding 인자를 해석한다. encoding/json 은 숫자 field 에 든 null 을 오류 없이 무시해 0 을 남기므로,
// 숫자 자리의 null 을 거부하는 형식은 이 해석을 UnmarshalJSON 으로 쓴다(docs/spec/native-host.md#host-calls).

// decodeRefusingNull 은 data 를 into 로 해석하고, into 의 숫자 자리에 null 이 있으면 그 자리를 밝혀 거부한다.
func decodeRefusingNull(data []byte, into any) error {
	if err := json.Unmarshal(data, into); err != nil {
		return err
	}
	var raw any
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	return nullNumber(raw, reflect.TypeOf(into).Elem(), "")
}

func numeric(t reflect.Type) bool {
	switch t.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Float32, reflect.Float64:
		return true
	}
	return false
}

// nullNumber 는 raw 를 형식 t 와 함께 따라가며 숫자 자리의 첫 null 을 오류로 돌려준다.
func nullNumber(raw any, t reflect.Type, path string) error {
	if numeric(t) {
		if raw == nil {
			if path == "" {
				return fmt.Errorf("the argument must be a number, not null")
			}
			return fmt.Errorf("%s must be a number, not null", path)
		}
		return nil
	}
	switch t.Kind() {
	case reflect.Pointer:
		if raw == nil {
			return nil
		}
		return nullNumber(raw, t.Elem(), path)
	case reflect.Slice, reflect.Array:
		items, ok := raw.([]any)
		if !ok {
			return nil
		}
		for i, item := range items {
			if err := nullNumber(item, t.Elem(), fmt.Sprintf("%s[%d]", path, i)); err != nil {
				return err
			}
		}
	case reflect.Map:
		fields, ok := raw.(map[string]any)
		if !ok {
			return nil
		}
		for key, item := range fields {
			if err := nullNumber(item, t.Elem(), joinPath(path, key)); err != nil {
				return err
			}
		}
	case reflect.Struct:
		fields, ok := raw.(map[string]any)
		if !ok {
			return nil
		}
		for i := 0; i < t.NumField(); i++ {
			field := t.Field(i)
			if !field.IsExported() {
				continue
			}
			// 기본값: 쉼표가 없는 태그는 태그 전체가 이름이므로 Cut 의 found 를 쓰지 않는다.
			name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
			if name == "-" {
				continue
			}
			if field.Anonymous && name == "" {
				if err := nullNumber(raw, field.Type, path); err != nil {
					return err
				}
				continue
			}
			if name == "" {
				name = field.Name
			}
			item, present := fields[name]
			if !present {
				continue
			}
			if err := nullNumber(item, field.Type, joinPath(path, name)); err != nil {
				return err
			}
		}
	}
	return nil
}

func joinPath(path, name string) string {
	if path == "" {
		return name
	}
	return path + "." + name
}

// Coordinate 는 binding 인자로 직접 받는 수다. null 을 거부한다.
type Coordinate float64

func (c *Coordinate) UnmarshalJSON(data []byte) error {
	var value float64
	if err := decodeRefusingNull(data, &value); err != nil {
		return err
	}
	*c = Coordinate(value)
	return nil
}

func (r *CompositionPlaceRequest) UnmarshalJSON(data []byte) error {
	type plain CompositionPlaceRequest
	return decodeRefusingNull(data, (*plain)(r))
}

func (r *ExposureReplyRequest) UnmarshalJSON(data []byte) error {
	type plain ExposureReplyRequest
	return decodeRefusingNull(data, (*plain)(r))
}

func (r *OverlayRequest) UnmarshalJSON(data []byte) error {
	type plain OverlayRequest
	return decodeRefusingNull(data, (*plain)(r))
}

func (r *PlaceRequest) UnmarshalJSON(data []byte) error {
	type plain PlaceRequest
	return decodeRefusingNull(data, (*plain)(r))
}

func (r *ShapeRequest) UnmarshalJSON(data []byte) error {
	type plain ShapeRequest
	return decodeRefusingNull(data, (*plain)(r))
}

func (r *SyncRequest) UnmarshalJSON(data []byte) error {
	type plain SyncRequest
	return decodeRefusingNull(data, (*plain)(r))
}

func (r *WorkspaceRequest) UnmarshalJSON(data []byte) error {
	type plain WorkspaceRequest
	return decodeRefusingNull(data, (*plain)(r))
}
