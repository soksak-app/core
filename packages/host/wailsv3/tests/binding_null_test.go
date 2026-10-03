// binding 인자의 숫자 자리에 든 null 을 거부하는지 검사한다. encoding/json 은 숫자 field 의 null 을 오류 없이
// 무시하므로, 거부하지 않으면 잘못된 요청이 0 을 담은 요청이 된다.
package host_test

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	host "github.com/min-median-max/soksak/packages/host/wailsv3/src"
)

func isNumber(t reflect.Type) bool {
	switch t.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Float32, reflect.Float64:
		return true
	}
	return false
}

// jsonName 은 field 의 JSON 이름이다. 해석하지 않는 field 는 빈 문자열이다.
func jsonName(field reflect.StructField) string {
	if !field.IsExported() {
		return ""
	}
	name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
	if name == "-" {
		return ""
	}
	if name == "" {
		return field.Name
	}
	return name
}

// nullDocuments 는 t 의 숫자 자리 하나마다 그 자리만 null 인 JSON 값을 만든다. 배열은 원소 하나로 만든다.
func nullDocuments(t reflect.Type, depth int) []any {
	if isNumber(t) {
		return []any{nil}
	}
	if depth > 6 {
		return nil
	}
	switch t.Kind() {
	case reflect.Struct:
		var documents []any
		for i := 0; i < t.NumField(); i++ {
			field := t.Field(i)
			name := jsonName(field)
			if name == "" || field.Anonymous {
				continue
			}
			for _, inner := range nullDocuments(field.Type, depth+1) {
				documents = append(documents, map[string]any{name: inner})
			}
		}
		return documents
	case reflect.Slice, reflect.Array:
		if t.Elem().Kind() == reflect.Uint8 {
			return nil
		}
		var documents []any
		for _, inner := range nullDocuments(t.Elem(), depth+1) {
			documents = append(documents, []any{inner})
		}
		return documents
	}
	return nil
}

// contract: host-calls.decode.refuses-null-number
func TestBindingArgumentsRefuseNullNumbers(t *testing.T) {
	methods := reflect.TypeOf(&host.Host{})
	context := reflect.TypeOf((*interface{ Done() <-chan struct{} })(nil)).Elem()
	checked := 0
	for i := 0; i < methods.NumMethod(); i++ {
		method := methods.Method(i)
		for p := 1; p < method.Type.NumIn(); p++ {
			param := method.Type.In(p)
			if param.Kind() == reflect.Interface && param.Implements(context) {
				continue
			}
			for _, document := range nullDocuments(param, 0) {
				raw, err := json.Marshal(document)
				if err != nil {
					t.Fatal(err)
				}
				checked++
				if err := json.Unmarshal(raw, reflect.New(param).Interface()); err == nil {
					t.Errorf("%s argument %d (%s) accepted %s", method.Name, p, param, raw)
				}
			}
		}
	}
	if checked == 0 {
		t.Fatal("no binding argument has a numeric field")
	}
}
