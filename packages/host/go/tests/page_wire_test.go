package host_test

// The producer of the page-wire cases (docs/spec/cases/page-wire/README.md). Each case with replay true runs against the host:
// each call of the case goes through the recording entry of the bindings (host.RecordedCall, which Bindings.Call runs for every
// host call) and then through the operation that the host method of the call runs, and each reply is compared with the reply of the
// case. A call of the page is named as the page names it; the runtime maps the name to the Go method (apps/wailsv3/runtime/index.js).

import (
	"bytes"
	"context"
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

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/support"
)

// pageWireDirectory is the folder of the cases, relative to the folder of this package (packages/host/go/tests).
const pageWireDirectory = "../../../../docs/spec/cases/page-wire"

var pageWireVariable = regexp.MustCompile(`^\$[a-z][a-z0-9-]*$`)

// pageWireCase is one case file. Its members are the members of the README table; an unknown member is refused.
type pageWireCase struct {
	Name        string                          `json:"name"`
	Description string                          `json:"description"`
	Replay      *bool                           `json:"replay"`
	Reason      string                          `json:"reason"`
	Writer      *pageWireWriter                 `json:"writer"`
	Variables   map[string]pageWireVariableSpec `json:"variables"`
	Steps       []pageWireStep                  `json:"steps"`
}

// pageWireWriter is the state of the event writer of the host that the case runs against. Without the member, the writer has no policy file.
type pageWireWriter struct {
	Policy bool `json:"policy"`
}

// pageWireVariableSpec is a value that the host or the page chooses. Type is one type name or a list of them. The producer accepts any
// value of the type in a reply, and it sends Example in place of a page variable of a call; Source is "host" (the default) or "page".
type pageWireVariableSpec struct {
	Type    json.RawMessage `json:"type"`
	Example json.RawMessage `json:"example"`
	Source  string          `json:"source"`
}

// types returns the type names of the variable.
func (spec pageWireVariableSpec) types() []string {
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

// pageWireStep is one call step, one reply step or one notice step.
type pageWireStep struct {
	Call   *pageWireCall   `json:"call"`
	Reply  *pageWireReply  `json:"reply"`
	Notice *pageWireNotice `json:"notice"`
}

// pageWireNotice is a notice that the host sends to the listeners of the page.
type pageWireNotice struct {
	Event   string          `json:"event"`
	Payload json.RawMessage `json:"payload"`
}

type pageWireCall struct {
	Name    string          `json:"name"`
	Payload json.RawMessage `json:"payload"`
	Cids    []string        `json:"cids"`
}

// pageWireReply holds either the result, which is null when the host answers nothing, or the error text. Held is the reader's: the reader
// settles a held reply when the test releases it, and the producer compares the reply as any other.
type pageWireReply struct {
	Result json.RawMessage `json:"result"`
	Error  *string         `json:"error"`
	Held   bool            `json:"held"`
}

// TestPageWire runs each page-wire case of the folder with replay true, one subtest per case.
func TestPageWire(t *testing.T) {
	entries, err := os.ReadDir(pageWireDirectory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		name, isCase := strings.CutSuffix(entry.Name(), ".json")
		if !isCase || entry.IsDir() {
			continue
		}
		file := filepath.Join(pageWireDirectory, entry.Name())
		t.Run(name, func(t *testing.T) { runPageWireCase(t, name, file) })
	}
}

// readPageWireCase decodes a case file and refuses a member that the format does not declare.
func readPageWireCase(t *testing.T, file string) pageWireCase {
	t.Helper()
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var kase pageWireCase
	if err := decoder.Decode(&kase); err != nil {
		t.Fatalf("%s: %v", file, err)
	}
	return kase
}

func runPageWireCase(t *testing.T, name, file string) {
	kase := readPageWireCase(t, file)
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
	// The producer runs the calls of the host without a window, and a notice reaches only the listeners of a window, so a case with a
	// notice is replayed in the tier that has windows.
	for i, step := range kase.Steps {
		if step.Notice != nil {
			t.Fatalf("%s: step %d is a notice, which this producer cannot observe; the case needs replay false and the reason", file, i)
		}
	}
	if len(kase.Steps)%2 != 0 {
		t.Fatalf("%s: the steps are not call and reply pairs", file)
	}
	// A case with no steps sends no call, so the producer has no call to run and the case passes with nothing to compare.
	writer := startPageWireWriter(t, kase.Writer != nil && kase.Writer.Policy)
	hostWithoutWindows, err := host.NewHostWithoutWindows(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	bindings, err := host.NewBindings(hostWithoutWindows, "Bindings")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < len(kase.Steps); i += 2 {
		call, reply := kase.Steps[i].Call, kase.Steps[i+1].Reply
		if call == nil || reply == nil {
			t.Fatalf("step %d: a call step must be followed by its reply step", i)
		}
		var args []json.RawMessage
		if call.Payload != nil {
			payload, err := pageWireExamples(call.Payload, kase.Variables)
			if err != nil {
				t.Fatalf("step %d: %v", i, err)
			}
			args = []json.RawMessage{payload}
		}
		result, err := pageWireInvoke(context.Background(), writer, bindings, call.Name, args, call.Cids)
		if reply.Error != nil {
			if err == nil || err.Error() != *reply.Error {
				t.Fatalf("step %d: %s returned %v, the case records the error %q", i, call.Name, err, *reply.Error)
			}
			continue
		}
		if err != nil {
			t.Fatalf("step %d: %s returned the error %v, the case records the result %s", i, call.Name, err, reply.Result)
		}
		if difference := pageWireDifference(reply.Result, result, kase.Variables); difference != "" {
			t.Fatalf("step %d: %s: %s", i, call.Name, difference)
		}
	}
}

// startPageWireWriter starts the event writer of the host for a case and makes it the writer of the records of the host until the test
// ends. With policy, the writer has the policy file log-policy.json of its folder.
func startPageWireWriter(t *testing.T, policy bool) *host.EventLog {
	t.Helper()
	directory := t.TempDir()
	options := support.EventLogOptions(directory)
	if policy {
		options.PolicyPath = filepath.Join(directory, "log-policy.json")
	}
	host.UseHostEventLog(nil)
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	host.UseHostEventLog(log)
	t.Cleanup(func() { host.UseHostEventLog(nil); log.Close() })
	return log
}

// pageWireInvoke runs one call of the page. The page names the call as the runtime names it, and the Go method of the call is the
// name with the first letter upper-cased. The recording entry takes the identifiers of the call; the operation is what the host
// method runs.
func pageWireInvoke(ctx context.Context, writer *host.EventLog, bindings *host.Bindings, name string, args []json.RawMessage, cids []string) (any, error) {
	if len(args) != 1 {
		return nil, fmt.Errorf("call %s has %d arguments, the case records one payload", name, len(args))
	}
	switch name {
	case "log":
		// Host.Log: LogCommand answers the request, and Host.Log writes the lines of the reply to the transcript and returns the
		// classes or the clock of the reply, or nothing.
		var request map[string]any
		if err := json.Unmarshal(args[0], &request); err != nil {
			return nil, err
		}
		return host.RecordedCall(ctx, "Log", args, cids, func() (any, error) {
			reply, err := host.LogCommand(writer, request)
			if err != nil {
				return nil, err
			}
			return pageWireLogReply(reply), nil
		})
	case "workspace":
		// Host.Workspace runs through the bindings of a host without windows: the request goes to the storage, and a snapshot
		// carries the identifiers of the open windows, which are none in this run.
		return bindings.Call(ctx, "Workspace", args, cids)
	}
	return nil, fmt.Errorf("the case calls %s, which the producer does not run", name)
}

// pageWireLogReply is the reply that Host.Log gives for the reply of LogCommand: the classes of a policy-read, the clock of a clock
// request, and nothing for the other actions.
func pageWireLogReply(reply host.LogReply) any {
	if reply.Classes != nil {
		return map[string]any{"classes": reply.Classes}
	}
	if reply.Clock != nil {
		return reply.Clock
	}
	return nil
}

// pageWireDifference returns the first difference between the reply of the case and the reply of the host, or "" when they match.
// A string of the form $name in the case stands for any value of the declared type of that variable.
func pageWireDifference(expected json.RawMessage, actual any, variables map[string]pageWireVariableSpec) string {
	encoded, err := json.Marshal(actual)
	if err != nil {
		return fmt.Sprintf("the reply cannot be serialized: %v", err)
	}
	got, err := decodeWithNumbers(encoded)
	if err != nil {
		return fmt.Sprintf("the reply is not JSON: %v", err)
	}
	var want any
	if len(expected) > 0 {
		if want, err = decodeWithNumbers(expected); err != nil {
			return fmt.Sprintf("the case reply is not JSON: %v", err)
		}
	}
	return pageWireMatch("reply", want, got, variables)
}

// decodeWithNumbers decodes JSON and keeps each number as its text, so an integer of the reply compares exactly.
func decodeWithNumbers(data []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	err := decoder.Decode(&value)
	return value, err
}

func pageWireMatch(path string, want, got any, variables map[string]pageWireVariableSpec) string {
	if text, ok := want.(string); ok && pageWireVariable.MatchString(text) {
		spec, declared := variables[text[1:]]
		if !declared {
			return fmt.Sprintf("%s: the variable %s is not declared", path, text)
		}
		if !slices.ContainsFunc(spec.types(), func(typ string) bool { return pageWireHasType(got, typ) }) {
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
			if difference := pageWireMatch(path+"."+key, expectedValue, value, variables); difference != "" {
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
			if difference := pageWireMatch(fmt.Sprintf("%s[%d]", path, i), expected[i], actual[i], variables); difference != "" {
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

// pageWireExamples returns the payload of a call with each page variable replaced by its example: the page chooses those values, and the
// producer sends the example as the value the page chose.
func pageWireExamples(payload json.RawMessage, variables map[string]pageWireVariableSpec) (json.RawMessage, error) {
	value, err := decodeWithNumbers(payload)
	if err != nil {
		return nil, fmt.Errorf("the payload is not JSON: %v", err)
	}
	var replace func(any) (any, error)
	replace = func(value any) (any, error) {
		switch v := value.(type) {
		case string:
			if !pageWireVariable.MatchString(v) {
				return v, nil
			}
			spec, declared := variables[v[1:]]
			if !declared || spec.Source != "page" {
				return nil, fmt.Errorf("the call uses %s, which is not a declared page variable", v)
			}
			return json.RawMessage(spec.Example), nil
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
	replaced, err := replace(value)
	if err != nil {
		return nil, err
	}
	return json.Marshal(replaced)
}

// pageWireHasType reports whether value is a JSON value of the type of a variable: integer, number, string, boolean, object, array or
// null.
func pageWireHasType(value any, typ string) bool {
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
