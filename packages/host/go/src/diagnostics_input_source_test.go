//go:build diagnostics

package host

import (
	"reflect"
	"testing"
)

// fakeInputSources is a platform whose input source of a role is `source-<role>` and whose person's input source has no role.
type fakeInputSources struct {
	current string
	calls   []string
}

func (f *fakeInputSources) InputSource() (string, string, error) {
	for _, role := range inputSourceRoles {
		if f.current == "source-"+role {
			return role, f.current, nil
		}
	}
	return "", f.current, nil
}

func (f *fakeInputSources) SelectInputSource(role string, adopted func(error)) {
	f.calls = append(f.calls, "select "+role)
	f.current = "source-" + role
	adopted(nil)
}

func (f *fakeInputSources) RestoreInputSource(source string, adopted func(error)) {
	f.calls = append(f.calls, "restore "+source)
	f.current = source
	adopted(nil)
}

func runStep(task func()) { task() }

// contract: diagnostics.input-source.selects-a-role
func TestInputSourceRefusesAStringThatIsNotARole(t *testing.T) {
	for _, params := range []string{`{"select":"source-latin"}`, `{"select":"greek"}`, `{"select":""}`, `{"select":3}`} {
		_, err := parseInputSource([]byte(params))
		if params == `{"select":3}` {
			if err == nil {
				t.Fatalf("accepted %s", params)
			}
			continue
		}
		if err == nil || err.Error() != "-32602: select must be one of latin, korean, japanese" {
			t.Fatalf("params %s error = %v", params, err)
		}
	}
	for params, message := range map[string]string{
		`{"select":"latin","restore":"source-latin"}`: "-32602: select and restore exclude each other",
		`{"restore":""}`: "-32602: restore must be a non-empty string",
	} {
		if _, err := parseInputSource([]byte(params)); err == nil || err.Error() != message {
			t.Fatalf("params %s error = %v", params, err)
		}
	}
}

// contract: diagnostics.input-source.selects-a-role
func TestInputSourceSelectsTheRoleThroughThePlatform(t *testing.T) {
	sources := &fakeInputSources{current: "person-source"}
	read, err := answerInputSource(sources, inputSourceRequest{}, runStep)
	if err != nil || !reflect.DeepEqual(read, map[string]any{"current": nil, "source": "person-source"}) {
		t.Fatalf("read = %v, %v", read, err)
	}
	for _, role := range []string{"latin", "korean", "japanese"} {
		request, err := parseInputSource([]byte(`{"window":"main","select":"` + role + `"}`))
		if err != nil || request != (inputSourceRequest{Select: role}) {
			t.Fatalf("select %s parsed as %+v, %v", role, request, err)
		}
		reply, err := answerInputSource(sources, request, runStep)
		if err != nil || !reflect.DeepEqual(reply, map[string]any{"current": role, "source": "source-" + role}) {
			t.Fatalf("select %s = %v, %v", role, reply, err)
		}
	}
	request, err := parseInputSource([]byte(`{"restore":"person-source"}`))
	if err != nil {
		t.Fatal(err)
	}
	restored, err := answerInputSource(sources, request, runStep)
	if err != nil || !reflect.DeepEqual(restored, map[string]any{"current": nil, "source": "person-source"}) {
		t.Fatalf("restore = %v, %v", restored, err)
	}
	if want := []string{"select latin", "select korean", "select japanese", "restore person-source"}; !reflect.DeepEqual(sources.calls, want) {
		t.Fatalf("platform calls = %v, want %v", sources.calls, want)
	}
}
