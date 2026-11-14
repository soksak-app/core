package host_test

// Replays the endpoint contract cases (docs/spec/endpoint.md#checks, docs/spec/cases/endpoint/README.md) that the endpoint answers without a
// window with a page, and the cases whose page is a script of the case. Each case runs on a loopback listener of the real endpoint. Its
// client frames are sent in order, and each frame of the host must equal the frame of the case: a variable binds the value of the
// host and must have its declared type and keys, as e2e/endpoint-contract.test.mjs checks a running application.

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
	"sync"
	"syscall"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/support"
)

// endpointCase is one case file of docs/spec/cases/endpoint.
type endpointCase struct {
	Name        string                  `json:"name"`
	Description string                  `json:"description"`
	Replay      bool                    `json:"replay"`
	Reason      string                  `json:"reason"`
	Page        string                  `json:"page"`
	Windows     []string                `json:"windows"`
	Variables   map[string]caseVariable `json:"variables"`
	Steps       []caseStep              `json:"steps"`
}

// casePageScripted is the value of the member page of a case whose page is a script.
const casePageScripted = "scripted"

// caseVariable is a variable of a case: the types that its value has and the keys that an object value has.
type caseVariable struct {
	Type json.RawMessage `json:"type"`
	Keys []string        `json:"keys"`
}

// caseStep is one step of a case. Exactly one of its members other than Connection is present.
type caseStep struct {
	// Connection names the connection of the client that the step uses. A step without it uses the connection "client".
	Connection string          `json:"connection"`
	Send       json.RawMessage `json:"send"`
	Reply      json.RawMessage `json:"reply"`
	Notify     json.RawMessage `json:"notify"`
	Close      *string         `json:"close"`
	Page       json.RawMessage `json:"page"`
	Log        json.RawMessage `json:"log"`
	Watching   json.RawMessage `json:"watching"`
	Watched    *[]string       `json:"watched"`
}

// casePageStep is the content of a step with the member page: a call that the endpoint relays to the page, the reply of the page
// to it, the release of a held reply, or a notice of the page.
type casePageStep struct {
	Call    *casePageCall   `json:"call"`
	Reply   *casePageReply  `json:"reply"`
	Release bool            `json:"release"`
	Notice  *casePageNotice `json:"notice"`
}

// casePageCall is a request that the endpoint sends to the page: the method and its params, which are absent when it sends none.
type casePageCall struct {
	Name    string          `json:"name"`
	Payload json.RawMessage `json:"payload"`
}

// casePageReply is the reply of the page to the call before it: a result or an error, and Held when the page answers only at the
// next release step.
type casePageReply struct {
	Result json.RawMessage `json:"result"`
	Error  *host.RPCError  `json:"error"`
	Held   bool            `json:"held"`
}

// casePageNotice is a notice of the page: the status change of event "status.changed" with its payload.
type casePageNotice struct {
	Event   string `json:"event"`
	Payload struct {
		Window  string `json:"window"`
		Name    string `json:"name"`
		Surface string `json:"surface"`
		Value   any    `json:"value"`
	} `json:"payload"`
}

// caseLogStep is the content of a step with the member log: Line is a record that the application log holds, as its text after
// the time, and Absent is a text that no record holds.
type caseLogStep struct {
	Line   string `json:"line"`
	Absent string `json:"absent"`
}

// caseWatchingStep is the content of a step with the member watching: whether a connection watches the status of the window.
type caseWatchingStep struct {
	Window string `json:"window"`
	Name   string `json:"name"`
	Value  bool   `json:"value"`
}

// endpointTierCase is a case that the endpoint answers alone. windows are the windows that exist when the case runs.
type endpointTierCase struct {
	name    string
	windows []string
}

// endpointTierCases are the cases with replay true that this runner plays. Each one has its contract declared in the host contract (docs/spec/host-contract.md).
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
			if kase.Page == casePageScripted && kase.Replay {
				t.Errorf("%s has a scripted page but its case has replay true: a running application has a page of its own", name)
			}
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
			kase.Windows = tc.windows
			if _, err := playEndpointCase(t, kase); err != nil {
				t.Fatal(err)
			}
		})
	}
}

// TestEndpointScriptedCases plays each case with a scripted page of docs/spec/cases/endpoint: the endpoint relays its requests to a
// page that follows the page steps of the case, and every frame, page call, log record and watch of the case must be as the case
// has it (docs/spec/cases/endpoint/README.md).
// contract: endpoint.transport.undeclared-method-closes, endpoint.rpc.unknown-window-1003, endpoint.rpc.missing-window-param-invalid, endpoint.rpc.round-trip-by-id, endpoint.rpc.page-params-omit-window, endpoint.rpc.element-rect-role, endpoint.rpc.target-params-are-checked-in-order, endpoint.names.unknown-host-name-1001, endpoint.errors.unknown-name-text, endpoint.names.missing-name-invalid, endpoint.names.owner-form-required, endpoint.names.valid-name-examples, endpoint.input.pointer-invalid-phase, endpoint.transport.close-reason-is-recorded, endpoint.close.reply-after-peer-close, endpoint.no-result.is-recorded, exposure.command.ends-by-reply-or-peer-end, exposure.relay.connection-end-ends-its-requests, endpoint.watch.notifies-watching-connection, endpoint.watch.non-watching-connection-not-notified, endpoint.watch.unwatch-is-per-connection, endpoint.watch.page-watch-deduplicated, endpoint.watch.no-page-unwatch-while-watched, endpoint.watch.last-watcher-close-unwatches-page, endpoint.watch.registry-reflects-watches, endpoint.watch.surface-and-plain-forwarded-separately, endpoint.watch.empty-surface-invalid, endpoint.watch.surface-change-names-surface, endpoint.watch.surface-unwatch-forwarded-with-surface, endpoint.watch.surface-unwatch-keeps-plain-watch, endpoint.watch.subscription-arrival-order, endpoint.watch.unwatch-enters-the-queue-only-after-a-watch, endpoint.watch.other-requests-not-blocked-by-pending-subscription, endpoint.dialog.watch-reaches-the-host, exposure.list.host-owner-without-page, exposure.list.non-object-list-rejected, endpoint.input.dialog-answer
func TestEndpointScriptedCases(t *testing.T) {
	directory := endpointCaseDirectory(t)
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(directory, entry.Name())
		kase, err := loadEndpointCase(path)
		if err != nil {
			t.Errorf("%v", err)
			continue
		}
		if kase.Page != casePageScripted {
			continue
		}
		t.Run(kase.Name, func(t *testing.T) {
			if _, err := playEndpointCase(t, kase); err != nil {
				t.Fatal(err)
			}
		})
	}
}

// playEndpointCase serves the endpoint with a page that plays the case, replays the case on it and fails the test on each problem
// that the replay finds. It returns the values that the variables of the case were bound to, so a test can judge a value that the
// case only types.
func playEndpointCase(t *testing.T, kase endpointCase) (map[string]any, error) {
	t.Helper()
	page, err := newCasePage(kase.Windows, kase.Steps)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", kase.Name, err)
	}
	log := support.UseEventLog(t)
	wrote := make(chan struct{}, 1)
	log.SetOnWrite(func(string, int64) {
		select {
		case wrote <- struct{}{}:
		default:
		}
	})
	endpoint, address, _ := serve(t, page)
	run := &caseRun{t: t, address: address, endpoint: endpoint, page: page, log: log, wrote: wrote, conns: map[string]net.Conn{}}
	defer run.closeConnections()
	problems, bound, err := run.replay(kase)
	problems = append(problems, page.finish()...)
	if err != nil {
		return nil, err
	}
	if len(problems) > 0 {
		t.Fatal(strings.Join(problems, "\n"))
	}
	return bound, nil
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
	if kase.Page != "" && kase.Page != casePageScripted {
		return endpointCase{}, fmt.Errorf("%s: page must be %q, is %q", path, casePageScripted, kase.Page)
	}
	if !kase.Replay && kase.Reason == "" {
		return endpointCase{}, fmt.Errorf("%s: a case with replay false must give its reason", path)
	}
	return kase, nil
}

// stepKind returns the member of a step: send, reply, notify, close, page, log, watching or watched.
func stepKind(step caseStep) (string, error) {
	var kinds []string
	for kind, present := range map[string]bool{
		"send": step.Send != nil, "reply": step.Reply != nil, "notify": step.Notify != nil, "close": step.Close != nil,
		"page": step.Page != nil, "log": step.Log != nil, "watching": step.Watching != nil, "watched": step.Watched != nil,
	} {
		if present {
			kinds = append(kinds, kind)
		}
	}
	if len(kinds) != 1 {
		return "", fmt.Errorf("a step must have exactly one of send, reply, notify, close, page, log, watching and watched, has %d", len(kinds))
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

// caseRun is the replay of one case on a running endpoint.
type caseRun struct {
	t        *testing.T
	address  string
	endpoint *host.Endpoint
	page     *casePage
	log      *host.EventLog
	// wrote receives a signal each time the writer of the application log wrote a batch.
	wrote chan struct{}
	// conns are the connections of the client that the steps opened, by name.
	conns map[string]net.Conn
}

// caseDefaultConnection is the connection of a step that names none.
const caseDefaultConnection = "client"

// connection returns the connection that a step uses, opened at its first use.
func (r *caseRun) connection(step caseStep) (net.Conn, error) {
	name := step.Connection
	if name == "" {
		name = caseDefaultConnection
	}
	if conn, open := r.conns[name]; open {
		return conn, nil
	}
	conn, err := net.Dial("tcp", r.address)
	if err != nil {
		return nil, err
	}
	r.conns[name] = conn
	return conn, nil
}

// forget removes the connection of a step after its close.
func (r *caseRun) forget(step caseStep) {
	name := step.Connection
	if name == "" {
		name = caseDefaultConnection
	}
	_ = r.conns[name].Close()
	delete(r.conns, name)
}

func (r *caseRun) closeConnections() {
	for _, conn := range r.conns {
		_ = conn.Close()
	}
}

// records returns the records that the application log holds now, one line each.
func (r *caseRun) records() string {
	r.t.Helper()
	if err := r.log.Flush(); err != nil {
		r.t.Fatal(err)
	}
	return support.TextOf(support.ReadEvents(r.t, r.log.Path()))
}

// caseLogHas reports whether a record of records has the text line after its time.
func caseLogHas(records, line string) bool {
	for _, record := range strings.Split(records, "\n") {
		if _, text, found := strings.Cut(record, " "); found && text == line {
			return true
		}
	}
	return false
}

// awaitLine waits until the application log holds the record line, which the writer announces with each batch that it writes, and
// returns false when the record does not come within caseReadLimit.
func (r *caseRun) awaitLine(line string) bool {
	r.t.Helper()
	limit := time.After(caseReadLimit)
	for {
		if caseLogHas(r.records(), line) {
			return true
		}
		select {
		case <-r.wrote:
		case <-limit:
			return false
		}
	}
}

// replay plays the steps of kase in order and returns the problems found, the values that the variables were bound to, and an error
// when the case itself is not valid.
func (r *caseRun) replay(kase endpointCase) ([]string, map[string]any, error) {
	var problems []string
	bound := map[string]any{}
	for index, step := range kase.Steps {
		where := fmt.Sprintf("step %d", index)
		invalid := func(err error) ([]string, map[string]any, error) {
			return nil, nil, fmt.Errorf("%s: %s: %w", kase.Name, where, err)
		}
		kind, err := stepKind(step)
		if err != nil {
			return invalid(err)
		}
		switch kind {
		case "send":
			frame, err := caseSendFrame(step.Send)
			if err != nil {
				return invalid(err)
			}
			conn, err := r.connection(step)
			if err != nil {
				return append(problems, fmt.Sprintf("%s: the client cannot connect: %v", where, err)), bound, nil
			}
			if _, err := conn.Write(frame); err != nil {
				return append(problems, fmt.Sprintf("%s: the client cannot send: %v", where, err)), bound, nil
			}
		case "reply", "notify":
			raw := step.Reply
			if kind == "notify" {
				raw = step.Notify
			}
			var expected any
			if err := json.Unmarshal(raw, &expected); err != nil {
				return invalid(err)
			}
			conn, err := r.connection(step)
			if err != nil {
				return append(problems, fmt.Sprintf("%s: the client cannot connect: %v", where, err)), bound, nil
			}
			message, err := readCaseFrame(conn)
			if err != nil {
				return append(problems, fmt.Sprintf("%s: no frame of the host (%v) where the case has %v", where, err, expected)), bound, nil
			}
			if err := matchCaseValue(expected, message, kase.Variables, bound, where, &problems); err != nil {
				return invalid(err)
			}
		case "close":
			switch *step.Close {
			case "client":
				if _, err := r.connection(step); err != nil {
					return append(problems, fmt.Sprintf("%s: the client cannot connect: %v", where, err)), bound, nil
				}
				r.forget(step)
			case "host":
				conn, err := r.connection(step)
				if err != nil {
					return append(problems, fmt.Sprintf("%s: the client cannot connect: %v", where, err)), bound, nil
				}
				message, err := readCaseFrame(conn)
				if err == nil {
					return append(problems, fmt.Sprintf("%s: the host sent %v where the case has its close", where, message)), bound, nil
				}
				if !caseClosed(err) {
					return append(problems, fmt.Sprintf("%s: the host did not close the connection: %v", where, err)), bound, nil
				}
				r.forget(step)
			default:
				return invalid(fmt.Errorf("close must be host or client, is %q", *step.Close))
			}
		case "page":
			var page casePageStep
			if err := json.Unmarshal(step.Page, &page); err != nil {
				return invalid(err)
			}
			problems = append(problems, r.playPage(where, page)...)
		case "log":
			var entry caseLogStep
			if err := json.Unmarshal(step.Log, &entry); err != nil {
				return invalid(err)
			}
			switch {
			case entry.Line != "" && entry.Absent == "":
				if !r.awaitLine(entry.Line) {
					problems = append(problems, fmt.Sprintf("%s: the application log has no record %q", where, entry.Line))
				}
			case entry.Absent != "" && entry.Line == "":
				if records := r.records(); strings.Contains(records, entry.Absent) {
					problems = append(problems, fmt.Sprintf("%s: the application log holds %q:\n%s", where, entry.Absent, records))
				}
			default:
				return invalid(errors.New("a log step has exactly one of line and absent"))
			}
		case "watching":
			var entry caseWatchingStep
			if err := json.Unmarshal(step.Watching, &entry); err != nil {
				return invalid(err)
			}
			if got := r.endpoint.Watching(entry.Window, entry.Name); got != entry.Value {
				problems = append(problems, fmt.Sprintf("%s: the registry has the watch of %s of %s as %v, the case has %v", where, entry.Name, entry.Window, got, entry.Value))
			}
		case "watched":
			if got := r.page.hostWatches(); !slices.Equal(got, *step.Watched) {
				problems = append(problems, fmt.Sprintf("%s: the host was told %q, the case has %q", where, got, *step.Watched))
			}
		}
	}
	return problems, bound, nil
}

// playPage plays one page step: a call waits until the endpoint has relayed it, a reply was read with its call, a release answers
// the oldest held reply, and a notice announces a status change of the page.
func (r *caseRun) playPage(where string, step casePageStep) []string {
	switch {
	case step.Call != nil:
		if !r.page.awaitCall() {
			return []string{fmt.Sprintf("%s: the endpoint did not send %s to the page within %v", where, step.Call.Name, caseReadLimit)}
		}
	case step.Release:
		if err := r.page.release(); err != nil {
			return []string{fmt.Sprintf("%s: %v", where, err)}
		}
	case step.Notice != nil:
		payload := step.Notice.Payload
		r.endpoint.StatusChanged(payload.Window, payload.Name, payload.Surface, payload.Value)
	}
	return nil
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

// casePageExchange is one request that the endpoint relays to the page and the reply that the case has for it.
type casePageExchange struct {
	call  casePageCall
	reply casePageReply
}

// heldPageReply is a reply of the page that waits for a release step: the request id of the relay that it answers.
type heldPageReply struct {
	id     uint64
	window string
	reply  casePageReply
}

// casePage is the backend of the endpoint for a case: the windows of the case and a page that follows the page steps of the case.
// A request that the endpoint relays to the page goes through the relay of the host (host.Relay), which a reply of the page
// resolves, so the end of the connection of a request ends it as it does in the host. A request, a command or a status that the
// case has no step for is a problem of the case, and the endpoint receives an error for it.
type casePage struct {
	relay  *host.Relay[string]
	script []casePageExchange

	mu       sync.Mutex
	windows  []string
	next     int
	held     []heldPageReply
	watches  []string
	problems []string
	ended    bool

	// calls receives a signal for each request that the endpoint relayed to the page, after the request is waiting.
	calls chan struct{}
}

var errNoPage = errors.New("the case has no page step for this request")

// newCasePage reads the page steps of a case into the script of its page: each call is followed at once by its reply.
func newCasePage(windows []string, steps []caseStep) (*casePage, error) {
	page := &casePage{relay: host.NewRelay[string](), windows: slices.Clone(windows), calls: make(chan struct{}, len(steps)+1)}
	var pending *casePageCall
	for index, step := range steps {
		if step.Page == nil {
			if pending != nil {
				return nil, fmt.Errorf("step %d: the call of the page before it has no reply", index)
			}
			continue
		}
		var parsed casePageStep
		if err := json.Unmarshal(step.Page, &parsed); err != nil {
			return nil, fmt.Errorf("step %d: %w", index, err)
		}
		switch {
		case parsed.Call != nil:
			if pending != nil {
				return nil, fmt.Errorf("step %d: the call of the page before it has no reply", index)
			}
			pending = parsed.Call
		case parsed.Reply != nil:
			if pending == nil {
				return nil, fmt.Errorf("step %d: a reply of the page follows no call", index)
			}
			if (parsed.Reply.Result == nil) == (parsed.Reply.Error == nil) {
				return nil, fmt.Errorf("step %d: a reply of the page has exactly one of result and error", index)
			}
			page.script = append(page.script, casePageExchange{call: *pending, reply: *parsed.Reply})
			pending = nil
		case pending != nil:
			return nil, fmt.Errorf("step %d: the call of the page before it has no reply", index)
		}
	}
	if pending != nil {
		return nil, errors.New("the last call of the page has no reply")
	}
	return page, nil
}

// newTierBackend is a page without steps: each request for it is a problem of the case.
func newTierBackend(windows []string) *casePage {
	page, err := newCasePage(windows, nil)
	if err != nil {
		panic(err)
	}
	return page
}

// AddWindow adds a window, as the registration of a window does.
func (p *casePage) AddWindow(window string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.windows = append(p.windows, window)
}

func (p *casePage) Windows() []host.WindowEntry {
	p.mu.Lock()
	defer p.mu.Unlock()
	entries := make([]host.WindowEntry, 0, len(p.windows))
	for _, window := range p.windows {
		entries = append(entries, host.WindowEntry{Window: window})
	}
	return entries
}

func (p *casePage) HasWindow(window string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Contains(p.windows, window)
}

// problem records a deviation of the endpoint from the case. A deviation after the case ended is not recorded: the endpoint
// releases its watches when its connections close.
func (p *casePage) problem(format string, args ...any) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.ended {
		p.problems = append(p.problems, fmt.Sprintf(format, args...))
	}
}

func (p *casePage) PageRequest(ctx context.Context, window, method string, params json.RawMessage) (json.RawMessage, error) {
	p.mu.Lock()
	index := p.next
	p.next++
	ended := p.ended
	p.mu.Unlock()
	if ended || index >= len(p.script) {
		p.problem("the endpoint sent %s %s to the page, where the case has no further call", method, params)
		return nil, fmt.Errorf("%s: %w", method, errNoPage)
	}
	exchange := p.script[index]
	if method != exchange.call.Name || !caseSameParams(params, exchange.call.Payload) {
		p.problem("page call %d is %s %s, the case has %s %s", index, method, params, exchange.call.Name, exchange.call.Payload)
	}
	result := p.relay.RequestContext(ctx, window, func(id uint64) error {
		reply := exchange.reply
		if reply.Held {
			p.mu.Lock()
			p.held = append(p.held, heldPageReply{id: id, window: window, reply: reply})
			p.mu.Unlock()
		} else if err := p.relay.Resolve(id, window, caseResult(reply)); err != nil {
			return err
		}
		select {
		case p.calls <- struct{}{}:
		default:
		}
		return nil
	})
	if result.Error != nil {
		return nil, result.Error
	}
	if len(result.Result) == 0 {
		return json.RawMessage(`null`), nil
	}
	return result.Result, nil
}

// caseResult is the reply of the page as the relay holds it.
func caseResult(reply casePageReply) host.ExposureResult {
	if reply.Error != nil {
		return host.ExposureResult{Error: reply.Error}
	}
	return host.ExposureResult{Result: reply.Result}
}

// caseSameParams reports whether the params that the endpoint sent are the payload of the call of the case. An absent payload is
// no params.
func caseSameParams(sent, payload json.RawMessage) bool {
	if len(payload) == 0 || len(sent) == 0 {
		return len(payload) == 0 && len(sent) == 0
	}
	var a, b any
	if json.Unmarshal(sent, &a) != nil || json.Unmarshal(payload, &b) != nil {
		return false
	}
	return reflect.DeepEqual(a, b)
}

// awaitCall waits until the endpoint relayed the next request of the case to the page.
func (p *casePage) awaitCall() bool {
	select {
	case <-p.calls:
		return true
	case <-time.After(caseReadLimit):
		return false
	}
}

// release answers the oldest held reply of the page through the relay.
func (p *casePage) release() error {
	p.mu.Lock()
	if len(p.held) == 0 {
		p.mu.Unlock()
		return errors.New("the page holds no reply to release")
	}
	held := p.held[0]
	p.held = p.held[1:]
	p.mu.Unlock()
	return p.relay.Resolve(held.id, held.window, caseResult(held.reply))
}

// finish ends the page and returns the problems of the case: the deviations that the endpoint made and the calls of the case that
// it did not send.
func (p *casePage) finish() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ended = true
	problems := slices.Clone(p.problems)
	if p.next < len(p.script) {
		problems = append(problems, fmt.Sprintf("the endpoint sent %d of the %d calls of the page that the case has", p.next, len(p.script)))
	}
	if len(p.held) > 0 {
		problems = append(problems, fmt.Sprintf("%d replies of the page were held and never released", len(p.held)))
	}
	return problems
}

// hostWatches are the starts and the ends of the watches of host statuses that reached the host, "<window> <name> on|off".
func (p *casePage) hostWatches() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.watches)
}

func (p *casePage) HostWatched(window, name string, on bool) {
	state := "off"
	if on {
		state = "on"
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.watches = append(p.watches, window+" "+name+" "+state)
}

// HostStatus answers host.windows, which the host reads from its windows. Another host status is a problem of the case.
func (p *casePage) HostStatus(_, name string) (any, error) {
	if name == "host.windows" {
		return p.Windows(), nil
	}
	p.problem("the endpoint read the host status %s, where the case has no step for it", name)
	return nil, fmt.Errorf("%s: %w", name, errNoPage)
}

func (p *casePage) HostCommand(_, name string, _ json.RawMessage, _ *host.ReplyScope) (any, error) {
	p.problem("the endpoint ran the host command %s, where the case has no step for it", name)
	return nil, fmt.Errorf("%s: %w", name, errNoPage)
}

// Pointer, Key, Text and DialogAnswer deliver the input that the endpoint read. The value of that input is judged by the tables of
// the functions that read it (pointerInput, keyInput, textInput and dialogAnswerInput of the host).
func (p *casePage) Pointer(_ string, _ host.PointerInput) error { return nil }

func (p *casePage) Key(_ string, _ host.KeyInput) error { return nil }

func (p *casePage) Text(_ string, _ host.TextInput) error { return nil }

func (p *casePage) DialogAnswer(_ string, _ host.DialogAnswer) error { return nil }
