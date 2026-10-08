// host 호출 인자의 해석을 검사한다(docs/spec/native-host.md#host-calls). 두 host 는 같은 인자를 같은 문장으로
// 거부한다.
package host_test

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// contract: host-calls.decode.every-binding
func TestEveryBindingDecodesItsArgumentsFirst(t *testing.T) {
	bindings := reflect.ValueOf(&host.Host{})
	contextType := reflect.TypeOf((*context.Context)(nil)).Elem()
	rawType := reflect.TypeOf(json.RawMessage(nil))
	checked := 0
	for i := 0; i < bindings.NumMethod(); i++ {
		method := bindings.Type().Method(i)
		kind := bindings.Method(i).Type()
		var args []reflect.Value
		decoded := false
		for p := 0; p < kind.NumIn(); p++ {
			switch kind.In(p) {
			case contextType:
				args = append(args, reflect.ValueOf(context.Background()))
			case rawType:
				args = append(args, reflect.ValueOf(json.RawMessage("true")))
				decoded = true
			default:
				t.Errorf("%s takes %s, which the framework decodes", method.Name, kind.In(p))
			}
		}
		if !decoded || len(args) != kind.NumIn() {
			continue
		}
		checked++
		results := bindings.Method(i).Call(args)
		err, _ := results[len(results)-1].Interface().(error)
		if err == nil || !strings.HasPrefix(err.Error(), "argument ") {
			t.Errorf("%s with true arguments returned %v, want an argument error", method.Name, err)
		}
	}
	if checked == 0 {
		t.Fatal("no binding takes an argument")
	}
}

// contract: host-calls.decode.messages
func TestArgumentRefusalMessages(t *testing.T) {
	h := &host.Host{}
	background := context.Background()
	raw := func(text string) json.RawMessage { return json.RawMessage(text) }
	surface := `{"id":"tab-1","x":0,"y":0,"w":1,"h":null,"visible":true,"dim":false,"plugin":"page","composition":{"kind":"web"}}`
	cases := []struct {
		name string
		call func() error
		want string
	}{
		{"missing field", func() error {
			_, err := h.SyncSurfaces(background, raw(`{"settled":true}`))
			return err
		}, "argument request.surfaces is missing"},
		{"missing title bar", func() error {
			_, err := h.SyncSurfaces(background, raw(`{"settled":true,"surfaces":[]}`))
			return err
		}, "argument request.titlebar is missing"},
		{"null field", func() error {
			_, err := h.SyncSurfaces(background, raw(`{"settled":true,"surfaces":[`+surface+`]}`))
			return err
		}, "argument request.surfaces[0].h is missing"},
		{"another type", func() error {
			_, err := h.SyncSurfaces(background, raw(`{"settled":true,"surfaces":[],"overlays":[{"x":"1","y":0,"w":1,"h":1}]}`))
			return err
		}, "argument request.overlays[0].x must be a number, not a string"},
		{"null argument", func() error {
			return h.DocumentAttach(background, raw(`null`))
		}, "argument request must be an object, not null"},
		{"fractional integer", func() error {
			_, err := h.DocumentGo(background, raw(`{"surface":"s","document":"d","action":"entry","offset":1.5}`))
			return err
		}, "argument request.offset must be an integer from -2147483648 to 2147483647"},
		{"integer out of range", func() error {
			_, err := h.DocumentGo(background, raw(`{"surface":"s","document":"d","action":"entry","offset":2147483648}`))
			return err
		}, "argument request.offset must be an integer from -2147483648 to 2147483647"},
		{"string field", func() error {
			return h.ImageFocus(background, raw(`{"surface":5,"name":"view"}`))
		}, "argument request.surface must be a string, not a number"},
		{"object field", func() error {
			_, err := h.Workspace(raw(`{"kind":"add","project":5}`))
			return err
		}, "argument request.project must be an object, not a number"},
		{"string argument", func() error {
			return h.ClearShape(background, raw(`5`))
		}, "argument id must be a string, not a number"},
		{"array length", func() error {
			return h.SetShape(background, raw(`{"id":"s","rect":{"x":0,"y":0,"w":1,"h":1},"radius":0,"lineWidth":0,"fill":[0,0,0],"line":[0,0,0,0]}`))
		}, "argument request.fill must be an array of 4 items"},
		// 선택 field 는 빠지거나 null 일 수 있다. 해석이 끝나면 호출은 창을 찾는 다음 단계에서 실패한다.
		{"optional fields", func() error {
			return h.DocumentAttach(background, raw(`{"surface":"s","document":"d","url":null}`))
		}, "host call has no window"},
		// 상태 값은 null 일 수 있고, 값이 없는 상태 변경은 값이 null 인 변경이다.
		{"null status value", func() error {
			return h.ExposureChanged(background, raw(`{"name":"core.grid","value":null}`))
		}, "host call has no window"},
		{"missing status value", func() error {
			return h.ExposureChanged(background, raw(`{"name":"core.grid"}`))
		}, "host call has no window"},
	}
	for _, c := range cases {
		if err := c.call(); err == nil || err.Error() != c.want {
			t.Errorf("%s: %v, want %s", c.name, err, c.want)
		}
	}
}
