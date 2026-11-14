//go:build diagnostics

package host

// The producer of the view-wire cases (docs/spec/cases/view-wire/README.md). Each case with replay true runs against the view
// handler of the host: each call of the case is the runtime.log call that the view sends through the sok-view handler of a view with
// a ready document, which the host answers itself with the writer of its event log, and each reply is compared with the reply of the
// case. A call that the page of the workbench answers has no producer here, so its case has replay false and its reason.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// viewWireDirectory is the folder of the cases, relative to the folder of this package (packages/host/go/src).
const viewWireDirectory = "../../../../docs/spec/cases/view-wire"

var viewWireVariable = regexp.MustCompile(`^\$[a-z][a-z0-9-]*$`)

// viewWireCase is one case file. Its members are the members of the README table; an unknown member is refused.
type viewWireCase struct {
	Name        string                          `json:"name"`
	Description string                          `json:"description"`
	Plugin      string                          `json:"plugin"`
	Replay      *bool                           `json:"replay"`
	Reason      string                          `json:"reason"`
	Variables   map[string]viewWireVariableSpec `json:"variables"`
	Steps       []viewWireStep                  `json:"steps"`
}

// viewWireVariableSpec is a value that the host or the view chooses. Type is one type name or a list of them. The producer accepts any
// value of the type in a reply, and it sends Example in place of a page variable of a call; Source is "host" (the default) or "page".
type viewWireVariableSpec struct {
	Type    json.RawMessage `json:"type"`
	Example json.RawMessage `json:"example"`
	Source  string          `json:"source"`
}

// types returns the type names of the variable.
func (spec viewWireVariableSpec) types() []string {
	var many []string
	if err := json.Unmarshal(spec.Type, &many); err == nil {
		return many
	}
	var one string
	if err := json.Unmarshal(spec.Type, &one); err == nil {
		return []string{one}
	}
	return nil
}

// viewWireStep is one call step, one reply step, one notice step or one request step.
type viewWireStep struct {
	Call    *viewWireCall    `json:"call"`
	Reply   *viewWireReply   `json:"reply"`
	Notice  *viewWireNotice  `json:"notice"`
	Request *viewWireRequest `json:"request"`
}

type viewWireCall struct {
	Command string          `json:"command"`
	Params  json.RawMessage `json:"params"`
	Cids    []string        `json:"cids"`
}

// viewWireReply holds either the result, which is null when the host answers nothing, or the error text. Held is the reader's.
type viewWireReply struct {
	Result json.RawMessage `json:"result"`
	Error  *string         `json:"error"`
	Held   bool            `json:"held"`
}

type viewWireNotice struct {
	Event string          `json:"event"`
	Data  json.RawMessage `json:"data"`
}

type viewWireRequest struct {
	ID      int64           `json:"id"`
	Command string          `json:"command"`
	Params  json.RawMessage `json:"params"`
}

// contract: view.wire.replays-recorded-cases
// TestViewWire runs each view-wire case of the folder with replay true, one subtest per case.
func TestViewWire(t *testing.T) {
	entries, err := os.ReadDir(viewWireDirectory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		name, isCase := strings.CutSuffix(entry.Name(), ".json")
		if !isCase || entry.IsDir() {
			continue
		}
		file := filepath.Join(viewWireDirectory, entry.Name())
		t.Run(name, func(t *testing.T) { runViewWireCase(t, name, file) })
	}
}

func readViewWireCase(t *testing.T, file string) viewWireCase {
	t.Helper()
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var kase viewWireCase
	if err := decoder.Decode(&kase); err != nil {
		t.Fatalf("%s: %v", file, err)
	}
	return kase
}

func runViewWireCase(t *testing.T, name, file string) {
	kase := readViewWireCase(t, file)
	if kase.Name != name {
		t.Fatalf("%s: name %q does not match the file name", file, kase.Name)
	}
	if kase.Replay == nil {
		t.Fatalf("%s: replay is missing", file)
	}
	if !*kase.Replay {
		if kase.Reason == "" {
			t.Fatalf("%s: a case with replay false must give its reason", file)
		}
		t.Skip(kase.Reason)
	}
	// The ready view of the producer belongs to the plugin probe, so a case that it replays names that plugin.
	if kase.Plugin != "probe" {
		t.Fatalf("%s: the plugin is %q, the view of this producer belongs to probe", file, kase.Plugin)
	}
	if len(kase.Steps)%2 != 0 {
		t.Fatalf("%s: the steps are not call and reply pairs", file)
	}
	surfaces := readyViewLogSurfaces(t, startViewRecordWriter(t, t.TempDir()))
	for i := 0; i < len(kase.Steps); i += 2 {
		call, reply := kase.Steps[i].Call, kase.Steps[i+1].Reply
		if call == nil || reply == nil {
			t.Fatalf("%s: step %d: only a call step followed by its reply step is replayed; a notice or a request of the host is played by a view", file, i)
		}
		if call.Command != "runtime.log" {
			t.Fatalf("%s: step %d: the call %s is answered by the page of the workbench, so the case needs replay false and the reason", file, i, call.Command)
		}
		params, err := viewWireExamples(call.Params, kase.Variables)
		if err != nil {
			t.Fatalf("%s: step %d: %v", file, i, err)
		}
		message := viewLogReplyForTest(t, surfaces, uint64(i/2+1), params)
		if reply.Error != nil {
			failure, ok := message["error"].(map[string]any)
			if !ok || failure["code"] != float64(viewLogFailureCode) || failure["message"] != *reply.Error {
				t.Fatalf("%s: step %d: runtime.log replied %v, the case records the error %q with code %d", file, i, message, *reply.Error, viewLogFailureCode)
			}
			continue
		}
		if failure, failed := message["error"]; failed {
			t.Fatalf("%s: step %d: runtime.log replied the error %v, the case records the result %s", file, i, failure, reply.Result)
		}
		if difference := viewWireDifference(reply.Result, message["result"], kase.Variables); difference != "" {
			t.Fatalf("%s: step %d: runtime.log: %s", file, i, difference)
		}
	}
}

// viewWireDifference returns the first difference between the result of the case and the result of the host, or "" when they match.
// A string of the form $name in the case stands for any value of the declared type of that variable.
func viewWireDifference(expected json.RawMessage, actual any, variables map[string]viewWireVariableSpec) string {
	encoded, err := json.Marshal(actual)
	if err != nil {
		return fmt.Sprintf("the reply cannot be serialized: %v", err)
	}
	got, err := viewWireNumbers(encoded)
	if err != nil {
		return fmt.Sprintf("the reply is not JSON: %v", err)
	}
	var want any
	if len(expected) > 0 {
		if want, err = viewWireNumbers(expected); err != nil {
			return fmt.Sprintf("the case reply is not JSON: %v", err)
		}
	}
	return viewWireMatch("reply", want, got, variables)
}

// viewWireNumbers decodes JSON and keeps each number as its text, so an integer of the reply compares exactly.
func viewWireNumbers(data []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	err := decoder.Decode(&value)
	return value, err
}

func viewWireMatch(path string, want, got any, variables map[string]viewWireVariableSpec) string {
	if text, ok := want.(string); ok && viewWireVariable.MatchString(text) {
		spec, declared := variables[text[1:]]
		if !declared {
			return fmt.Sprintf("%s: the variable %s is not declared", path, text)
		}
		if !slices.ContainsFunc(spec.types(), func(typ string) bool { return viewWireHasType(got, typ) }) {
			return fmt.Sprintf("%s is %v, the variable %s has the type %s", path, got, text, string(spec.Type))
		}
		return ""
	}
	switch expected := want.(type) {
	case map[string]any:
		actual, ok := got.(map[string]any)
		if !ok {
			return fmt.Sprintf("%s: the case records an object, the reply is %v", path, got)
		}
		keys := map[string]bool{}
		for key := range expected {
			keys[key] = true
		}
		for key := range actual {
			keys[key] = true
		}
		names := make([]string, 0, len(keys))
		for key := range keys {
			names = append(names, key)
		}
		sort.Strings(names)
		for _, key := range names {
			expectedValue, held := expected[key]
			if !held {
				return fmt.Sprintf("%s: the reply has the field %s, which the case does not record", path, key)
			}
			value, present := actual[key]
			if !present {
				return fmt.Sprintf("%s: the reply lacks the field %s", path, key)
			}
			if difference := viewWireMatch(path+"."+key, expectedValue, value, variables); difference != "" {
				return difference
			}
		}
		return ""
	case []any:
		actual, ok := got.([]any)
		if !ok || len(actual) != len(expected) {
			return fmt.Sprintf("%s: the case records %d items, the reply is %v", path, len(expected), got)
		}
		for i := range expected {
			if difference := viewWireMatch(fmt.Sprintf("%s[%d]", path, i), expected[i], actual[i], variables); difference != "" {
				return difference
			}
		}
		return ""
	}
	if !reflect.DeepEqual(want, got) {
		return fmt.Sprintf("%s is %v, the case records %v", path, got, want)
	}
	return ""
}

// viewWireExamples returns the params of a call with each page variable replaced by its example: the view chooses those values, and
// the producer sends the example as the value the view chose. The params are decoded as JSON values of the host.
func viewWireExamples(params json.RawMessage, variables map[string]viewWireVariableSpec) (any, error) {
	if params == nil {
		return nil, nil
	}
	var value any
	if err := json.Unmarshal(params, &value); err != nil {
		return nil, fmt.Errorf("the params are not JSON: %v", err)
	}
	var replace func(any) (any, error)
	replace = func(value any) (any, error) {
		switch v := value.(type) {
		case string:
			if !viewWireVariable.MatchString(v) {
				return v, nil
			}
			spec, declared := variables[v[1:]]
			if !declared || spec.Source != "page" {
				return nil, fmt.Errorf("the call uses %s, which is not a declared page variable", v)
			}
			var example any
			if err := json.Unmarshal(spec.Example, &example); err != nil {
				return nil, err
			}
			return example, nil
		case map[string]any:
			for key, item := range v {
				replaced, err := replace(item)
				if err != nil {
					return nil, err
				}
				v[key] = replaced
			}
		case []any:
			for i, item := range v {
				replaced, err := replace(item)
				if err != nil {
					return nil, err
				}
				v[i] = replaced
			}
		}
		return value, nil
	}
	return replace(value)
}

// viewWireHasType reports whether value is a JSON value of the type of a variable: integer, number, string, boolean, object, array or
// null.
func viewWireHasType(value any, typ string) bool {
	switch typ {
	case "object":
		_, ok := value.(map[string]any)
		return ok
	case "array":
		_, ok := value.([]any)
		return ok
	case "null":
		return value == nil
	case "integer":
		number, ok := value.(json.Number)
		if !ok {
			return false
		}
		_, err := strconv.ParseInt(number.String(), 10, 64)
		return err == nil
	case "number":
		_, ok := value.(json.Number)
		return ok
	case "string":
		_, ok := value.(string)
		return ok
	case "boolean":
		_, ok := value.(bool)
		return ok
	}
	return false
}
