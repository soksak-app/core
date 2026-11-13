package host_test

// Replays the endpoint contract cases that the endpoint answers without a window and without a page (docs/spec/endpoint.md#checks).
// Each case runs on a loopback listener of the real endpoint. Its client frames are sent in order, and each frame of the host must
// equal the frame of the case: a variable binds the value of the host and must have its declared type and keys, as
// e2e/endpoint-contract.test.mjs checks a running application.

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"math"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// endpointCase is one case file of docs/spec/cases/endpoint.
type endpointCase struct {
	Name        string                  `json:"name"`
	Description string                  `json:"description"`
	Replay      bool                    `json:"replay"`
	Variables   map[string]caseVariable `json:"variables"`
	Steps       []caseStep              `json:"steps"`
}

// caseVariable is a variable of a case: the types that its value has and the keys that an object value has.
type caseVariable struct {
	Type json.RawMessage `json:"type"`
	Keys []string        `json:"keys"`
}

// caseStep is one step of a case. Exactly one of its members is present.
type caseStep struct {
	Send   json.RawMessage `json:"send"`
	Reply  json.RawMessage `json:"reply"`
	Notify json.RawMessage `json:"notify"`
	Close  *string         `json:"close"`
}

// endpointTierCase is a case that the endpoint answers alone. windows are the windows that exist when the case runs.
type endpointTierCase struct {
	name    string
	windows []string
}

// endpointTierCases are the cases that this runner plays. Each one has its contract declared in the host contract (docs/spec/host-contract.md).
var endpointTierCases = []endpointTierCase{
	{name: "framing-http-request-line"},
	{name: "framing-invalid-json"},
	{name: "framing-length-over-limit"},
	{name: "framing-not-object"},
	{name: "framing-version-not-2"},
	{name: "undeclared-method"},
	{name: "error-invalid-params"},
	{name: "error-window-missing"},
	{name: "command-window-missing"},
	{name: "command-unknown-host", windows: []string{"main"}},
}

// endpointCasesOutsideTier are the cases with replay true that this runner does not play, with the reason. Each of them needs a
// window with a page, a diagnostic build, or no host frame at all.
var endpointCasesOutsideTier = map[string]string{
	"capture-still":                    "diagnostics.capture.still answers the path of a captured window, which needs a registered window and a diagnostic build",
	"closed-by-client-pending":         "the case has no host frame: its outcome is the client rejecting a pending request, which the client tests check",
	"no-request":                       "the case has no host frame: it checks the reading of endpoint.json by the client, which the client tests check",
	"exposure-list":                    "exposure.list answers the entries that the page declares",
	"hello":                            "windows.list answers the entry of the main window with the ready state that the page reports",
	"mcp-tools-list":                   "the MCP client reads exposure.list of a window, which needs a page",
	"sok-capture-still":                "the sok client captures a registered window, which needs a page",
	"sok-commands":                     "the sok client reads exposure.list of a window, which needs a page",
	"sok-declared-rejects":             "the sok client reads exposure.list of a window, which needs a page",
	"sok-status-value":                 "status.get of a page status, which the page answers",
	"status-get-screen":                "status.get of a page status, which the page answers",
	"status-unknown-name":              "status.get of a name that is not a host status is answered by the page",
	"watch-current-value":              "status.watch of a page status, whose value the page reports",
	"watch-predicate-not-boolean":      "status.watch of a page status, whose predicate the page evaluates",
	"watch-until-close":                "status.watch of a page status, whose value the page reports",
	"window-check-no-mark":             "the window check refuses the run before any request, so the host receives no frame",
	"window-check-test-mark-fail":      "diagnostics.test.mark needs a registered window and a diagnostic build",
	"window-check-test-mark-pass":      "diagnostics.test.mark needs a registered window and a diagnostic build",
	"window-check-test-mark-start-end": "diagnostics.test.mark needs a registered window and a diagnostic build",
	"window-check-test-mark-start":     "diagnostics.test.mark needs a registered window and a diagnostic build",
}

// caseVariablePattern is the form of a variable of a case.
var caseVariablePattern = regexp.MustCompile(`^\$[a-z][a-z0-9-]*$`)

// caseFrameLimit is the largest frame of the framing (docs/spec/endpoint.md#framing).
const caseFrameLimit = 16 << 20

// caseReadLimit is the longest wait for one frame of the host. A frame that does not arrive in it fails the case.
const caseReadLimit = 10 * time.Second

// TestEndpointCases plays each endpoint case of the tier and checks that the cases of docs/spec/cases/endpoint are all covered.
// contract: endpoint.transport.http-request-line-closes, endpoint.transport.invalid-json-closes, endpoint.transport.non-jsonrpc-object-closes, endpoint.transport.undeclared-method-closes, endpoint.names.owner-form-required, endpoint.rpc.target-params-are-checked-in-order, endpoint.rpc.unknown-window-1003, endpoint.names.unknown-host-name-1001, endpoint.errors.unknown-name-text, endpoint.transport.length-over-limit-closes, endpoint.cases.replayed-cases-are-covered
func TestEndpointCases(t *testing.T) {
	directory := endpointCaseDirectory(t)
	t.Run("coverage", func(t *testing.T) {
		entries, err := os.ReadDir(directory)
		if err != nil {
			t.Fatal(err)
		}
		tier := map[string]bool{}
		for _, tc := range endpointTierCases {
			tier[tc.name] = true
		}
		found := map[string]bool{}
		for _, entry := range entries {
			if !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			name := strings.TrimSuffix(entry.Name(), ".json")
			kase, err := loadEndpointCase(filepath.Join(directory, entry.Name()))
			if err != nil {
				t.Errorf("%v", err)
				continue
			}
			found[name] = true
			if !kase.Replay {
				continue
			}
			_, outside := endpointCasesOutsideTier[name]
			if !tier[name] && !outside {
				t.Errorf("%s is replayed by its case but neither played by this runner nor listed outside it", name)
			}
		}
		for name := range maps.Keys(endpointCasesOutsideTier) {
			if !found[name] {
				t.Errorf("%s is listed outside the tier but has no case file", name)
			}
		}
		for _, tc := range endpointTierCases {
			if !found[tc.name] {
				t.Errorf("%s is played by this runner but has no case file", tc.name)
			}
		}
	})
	for _, tc := range endpointTierCases {
		t.Run(tc.name, func(t *testing.T) {
			kase, err := loadEndpointCase(filepath.Join(directory, tc.name+".json"))
			if err != nil {
				t.Fatal(err)
			}
			if !kase.Replay {
				t.Fatalf("%s is played by this runner but its case has replay false", tc.name)
			}
			_, address, _ := serve(t, newTierBackend(tc.windows))
			problems, err := replayEndpointCase(kase, address)
			if err != nil {
				t.Fatal(err)
			}
			if len(problems) > 0 {
				t.Fatal(strings.Join(problems, "\n"))
			}
		})
	}
}

// endpointCaseDirectory finds docs/spec/cases/endpoint by walking up from the source directory of this file.
func endpointCaseDirectory(t *testing.T) string {
	t.Helper()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("the source path of this test is unknown")
	}
	for dir := filepath.Dir(source); ; {
		candidate := filepath.Join(dir, "docs", "spec", "cases", "endpoint")
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("no docs/spec/cases/endpoint above %s", source)
		}
		dir = parent
	}
}

// loadEndpointCase reads one case file. The name of the case is the name of its file.
func loadEndpointCase(path string) (endpointCase, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return endpointCase{}, err
	}
	var kase endpointCase
	if err := json.Unmarshal(data, &kase); err != nil {
		return endpointCase{}, fmt.Errorf("%s is not a readable case: %w", path, err)
	}
	if want := strings.TrimSuffix(filepath.Base(path), ".json"); kase.Name != want {
		return endpointCase{}, fmt.Errorf("%s: name %q does not match the file name", path, kase.Name)
	}
	return kase, nil
}

// stepKind returns the member of a step: send, reply, notify or close.
func stepKind(step caseStep) (string, error) {
	var kinds []string
	if step.Send != nil {
		kinds = append(kinds, "send")
	}
	if step.Reply != nil {
		kinds = append(kinds, "reply")
	}
	if step.Notify != nil {
		kinds = append(kinds, "notify")
	}
	if step.Close != nil {
		kinds = append(kinds, "close")
	}
	if len(kinds) != 1 {
		return "", fmt.Errorf("a step must have exactly one of send, reply, notify and close, has %d", len(kinds))
	}
	return kinds[0], nil
}

// caseSendFrame returns the bytes that the client writes for a send step: the raw bytes of raw_hex, or the length prefix and the
// JSON body of the step.
func caseSendFrame(send json.RawMessage) ([]byte, error) {
	var raw struct {
		RawHex *string `json:"raw_hex"`
	}
	if err := json.Unmarshal(send, &raw); err != nil {
		return nil, err
	}
	if raw.RawHex != nil {
		return hex.DecodeString(*raw.RawHex)
	}
	frame := binary.BigEndian.AppendUint32(nil, uint32(len(send)))
	return append(frame, send...), nil
}

// readCaseFrame reads one frame of the host and decodes its JSON body.
func readCaseFrame(conn net.Conn) (any, error) {
	if err := conn.SetReadDeadline(time.Now().Add(caseReadLimit)); err != nil {
		return nil, err
	}
	var size [4]byte
	if _, err := io.ReadFull(conn, size[:]); err != nil {
		return nil, err
	}
	length := binary.BigEndian.Uint32(size[:])
	if length > caseFrameLimit {
		return nil, fmt.Errorf("host frame of %d bytes exceeds the limit of %d", length, caseFrameLimit)
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(conn, body); err != nil {
		return nil, err
	}
	var message any
	if err := json.Unmarshal(body, &message); err != nil {
		return nil, fmt.Errorf("host frame is not JSON: %w", err)
	}
	return message, nil
}

// caseClosed reports whether a read error is the close of the connection by the host at a frame boundary. io.ReadFull returns
// io.EOF only when no byte of the frame was read, so a frame cut short is not a close.
func caseClosed(err error) bool {
	return errors.Is(err, io.EOF) || errors.Is(err, syscall.ECONNRESET)
}

// replayEndpointCase sends the client frames of kase to the endpoint at address in order and matches each frame of the host with
// the case. It returns the problems found, and an error when the case itself is not valid.
func replayEndpointCase(kase endpointCase, address string) ([]string, error) {
	conn, err := net.Dial("tcp", address)
	if err != nil {
		return nil, err
	}
	defer func() { _ = conn.Close() }()
	var problems []string
	bound := map[string]any{}
	for index, step := range kase.Steps {
		where := fmt.Sprintf("step %d", index)
		kind, err := stepKind(step)
		if err != nil {
			return nil, fmt.Errorf("%s: %s: %w", kase.Name, where, err)
		}
		switch kind {
		case "send":
			frame, err := caseSendFrame(step.Send)
			if err != nil {
				return nil, fmt.Errorf("%s: %s: %w", kase.Name, where, err)
			}
			if _, err := conn.Write(frame); err != nil {
				return append(problems, fmt.Sprintf("%s: the client cannot send: %v", where, err)), nil
			}
		case "reply", "notify":
			raw := step.Reply
			if kind == "notify" {
				raw = step.Notify
			}
			var expected any
			if err := json.Unmarshal(raw, &expected); err != nil {
				return nil, fmt.Errorf("%s: %s: %w", kase.Name, where, err)
			}
			message, err := readCaseFrame(conn)
			if err != nil {
				return append(problems, fmt.Sprintf("%s: no frame of the host (%v) where the case has %v", where, err, expected)), nil
			}
			if err := matchCaseValue(expected, message, kase.Variables, bound, where, &problems); err != nil {
				return nil, fmt.Errorf("%s: %s: %w", kase.Name, where, err)
			}
		case "close":
			if *step.Close == "client" {
				return problems, nil
			}
			if *step.Close != "host" {
				return nil, fmt.Errorf("%s: %s: close must be host or client, is %q", kase.Name, where, *step.Close)
			}
			message, err := readCaseFrame(conn)
			if err == nil {
				return append(problems, fmt.Sprintf("%s: the host sent %v where the case has its close", where, message)), nil
			}
			if !caseClosed(err) {
				return append(problems, fmt.Sprintf("%s: the host did not close the connection: %v", where, err)), nil
			}
			return problems, nil
		}
	}
	return problems, nil
}

// matchCaseValue compares a part of a host frame with the same part of the case. A variable binds the first value that it meets and
// must equal that value wherever it appears again. The first value must have the declared type, and the declared keys when it names them.
func matchCaseValue(expected, actual any, variables map[string]caseVariable, bound map[string]any, path string, problems *[]string) error {
	if text, ok := expected.(string); ok && caseVariablePattern.MatchString(text) {
		name := text[1:]
		spec, declared := variables[name]
		if !declared {
			*problems = append(*problems, fmt.Sprintf("%s: variable $%s is not declared", path, name))
			return nil
		}
		if value, found := bound[name]; found {
			if !reflect.DeepEqual(value, actual) {
				*problems = append(*problems, fmt.Sprintf("%s: %s is %v, bound earlier to %v", path, name, actual, value))
			}
			return nil
		}
		types, err := caseTypeNames(spec.Type)
		if err != nil {
			return fmt.Errorf("variable $%s: %w", name, err)
		}
		typed, err := caseHasType(types, actual)
		if err != nil {
			return fmt.Errorf("variable $%s: %w", name, err)
		}
		switch {
		case !typed:
			*problems = append(*problems, fmt.Sprintf("%s: %v is not of type %s", path, actual, strings.Join(types, " or ")))
		case spec.Keys != nil && !caseHasKeys(actual, spec.Keys):
			*problems = append(*problems, fmt.Sprintf("%s: %v does not have the keys %v", path, actual, spec.Keys))
		}
		bound[name] = actual
		return nil
	}
	switch want := expected.(type) {
	case []any:
		got, ok := actual.([]any)
		if !ok || len(got) != len(want) {
			*problems = append(*problems, fmt.Sprintf("%s: expected an array of %d, got %v", path, len(want), actual))
			return nil
		}
		for index := range want {
			if err := matchCaseValue(want[index], got[index], variables, bound, fmt.Sprintf("%s[%d]", path, index), problems); err != nil {
				return err
			}
		}
	case map[string]any:
		got, ok := actual.(map[string]any)
		if !ok {
			*problems = append(*problems, fmt.Sprintf("%s: expected an object, got %v", path, actual))
			return nil
		}
		keys := slices.Sorted(maps.Keys(want))
		actualKeys := slices.Sorted(maps.Keys(got))
		if !slices.Equal(keys, actualKeys) {
			*problems = append(*problems, fmt.Sprintf("%s: keys %v are not %v", path, actualKeys, keys))
			return nil
		}
		for _, key := range keys {
			if err := matchCaseValue(want[key], got[key], variables, bound, path+"."+key, problems); err != nil {
				return err
			}
		}
	default:
		if !reflect.DeepEqual(expected, actual) {
			*problems = append(*problems, fmt.Sprintf("%s: %v is not %v", path, actual, expected))
		}
	}
	return nil
}

// caseTypeNames reads the type of a variable, which is one name or a list of names.
func caseTypeNames(raw json.RawMessage) ([]string, error) {
	var one string
	if err := json.Unmarshal(raw, &one); err == nil {
		return []string{one}, nil
	}
	var many []string
	if err := json.Unmarshal(raw, &many); err != nil {
		return nil, fmt.Errorf("type %s is neither a name nor a list of names: %w", raw, err)
	}
	return many, nil
}

// caseHasType reports whether value has one of the types. An unknown type name is an error of the case.
func caseHasType(types []string, value any) (bool, error) {
	for _, name := range types {
		matched := false
		switch name {
		case "any":
			matched = true
		case "null":
			matched = value == nil
		case "string":
			_, matched = value.(string)
		case "boolean":
			_, matched = value.(bool)
		case "number":
			_, matched = value.(float64)
		case "integer":
			number, isNumber := value.(float64)
			matched = isNumber && number == math.Trunc(number)
		case "array":
			_, matched = value.([]any)
		case "object":
			_, matched = value.(map[string]any)
		default:
			return false, fmt.Errorf("type %q is not a JSON type", name)
		}
		if matched {
			return true, nil
		}
	}
	return false, nil
}

// caseHasKeys reports whether value is an object that has every key.
func caseHasKeys(value any, keys []string) bool {
	object, ok := value.(map[string]any)
	if !ok {
		return false
	}
	for _, key := range keys {
		if _, found := object[key]; !found {
			return false
		}
	}
	return true
}

// tierBackend is the window state of a host with no page attached: the endpoint reads it for windows.list and for the window lookup.
// A request that needs the page or a native window returns an error, so a frame that reaches the page does not match its case.
type tierBackend struct {
	windows []string
}

var errNoPage = errors.New("no page is attached in the endpoint tier")

func newTierBackend(windows []string) tierBackend { return tierBackend{windows: windows} }

func (b tierBackend) Windows() []host.WindowEntry {
	entries := make([]host.WindowEntry, 0, len(b.windows))
	for _, window := range b.windows {
		entries = append(entries, host.WindowEntry{Window: window})
	}
	return entries
}

func (b tierBackend) HasWindow(window string) bool { return slices.Contains(b.windows, window) }

func (b tierBackend) PageRequest(_ context.Context, _, method string, _ json.RawMessage) (json.RawMessage, error) {
	return nil, fmt.Errorf("%s: %w", method, errNoPage)
}

func (b tierBackend) HostStatus(_, name string) (any, error) {
	return nil, fmt.Errorf("%s: %w", name, errNoPage)
}

func (b tierBackend) HostCommand(_, name string, _ json.RawMessage, _ *host.ReplyScope) (any, error) {
	return nil, fmt.Errorf("%s: %w", name, errNoPage)
}

func (b tierBackend) Pointer(_ string, _ host.PointerInput) error { return errNoPage }

func (b tierBackend) Key(_ string, _ host.KeyInput) error { return errNoPage }

func (b tierBackend) Text(_ string, _ host.TextInput) error { return errNoPage }

// HostWatched receives no watch of a host status in the cases of the tier, so it records nothing.
func (b tierBackend) HostWatched(_, _ string, _ bool) {}

func (b tierBackend) DialogAnswer(_ string, _ host.DialogAnswer) error { return errNoPage }
