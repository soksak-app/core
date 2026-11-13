package host_test

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime/debug"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform"
	"github.com/soksak-app/core/packages/host/go/tests/support"
)

// fakeBackend imitates one window ("main") and its page. It records page requests and replies with null.
type fakeBackend struct {
	mu       sync.Mutex
	requests []string
	// bodies are the params of the page requests. They are in the same order as requests.
	bodies   []string
	commands []string
	keys     []host.KeyInput
	texts    []host.TextInput
	pointers []host.PointerInput
	// When held exists, the first request of holdMethod signals entered and does not reply until held closes.
	held       chan struct{}
	holdMethod string
	entered    chan struct{}
	holding    bool
	// unwatched receives a signal each time the page receives status.unwatch.
	unwatched chan struct{}
	// watched receives a signal each time the page receives status.watch.
	watched chan struct{}
	// failures are the errors that a page request returns for each method.
	failures map[string]error
	// replies are the results that a page request returns for each method.
	replies map[string]json.RawMessage
	// hostWatches are the starts and the ends of the watches of host statuses that reached the host, "<window> <name> on|off".
	hostWatches []string
	// dialogAnswers are the answers of input.dialog.answer that reached the host.
	dialogAnswers []host.DialogAnswer
}

func newFakeBackend() *fakeBackend {
	return &fakeBackend{unwatched: make(chan struct{}, 8), watched: make(chan struct{}, 8)}
}

func (b *fakeBackend) Windows() []host.WindowEntry {
	return []host.WindowEntry{{Window: "main", Title: "Main", Key: true}}
}

func (b *fakeBackend) HasWindow(window string) bool { return window == "main" }

func (b *fakeBackend) PageRequest(_ context.Context, window, method string, params json.RawMessage) (json.RawMessage, error) {
	b.mu.Lock()
	b.requests = append(b.requests, method)
	b.bodies = append(b.bodies, string(params))
	hold := method == b.holdMethod && b.held != nil && !b.holding
	if hold {
		b.holding = true
	}
	b.mu.Unlock()
	if hold {
		b.entered <- struct{}{}
		<-b.held
	}
	if method == "status.unwatch" {
		b.unwatched <- struct{}{}
	}
	// A test that does not read every signal must not block the page request, so a full channel drops the signal.
	if method == "status.watch" {
		select {
		case b.watched <- struct{}{}:
		default:
		}
	}
	b.mu.Lock()
	failure := b.failures[method]
	reply, replied := b.replies[method]
	b.mu.Unlock()
	if failure != nil {
		return nil, failure
	}
	if replied {
		return reply, nil
	}
	if method == "exposure.list" {
		return json.RawMessage(`{"status":[{"name":"core.layout","registered":true}],"commands":[],"element":[]}`), nil
	}
	return json.RawMessage(`null`), nil
}

func (b *fakeBackend) HostStatus(window, name string) (any, error) {
	return map[string]any{"key": true}, nil
}

func (b *fakeBackend) HostCommand(window, name string, params json.RawMessage, _ *host.ReplyScope) (any, error) {
	b.mu.Lock()
	b.commands = append(b.commands, name)
	b.mu.Unlock()
	return nil, nil
}

func (b *fakeBackend) Pointer(window string, input host.PointerInput) error {
	b.mu.Lock()
	b.pointers = append(b.pointers, input)
	b.mu.Unlock()
	return nil
}

func (b *fakeBackend) Text(window string, input host.TextInput) error {
	b.mu.Lock()
	b.texts = append(b.texts, input)
	b.mu.Unlock()
	return nil
}

func (b *fakeBackend) HostWatched(window, name string, on bool) {
	state := "off"
	if on {
		state = "on"
	}
	b.mu.Lock()
	b.hostWatches = append(b.hostWatches, window+" "+name+" "+state)
	b.mu.Unlock()
}

func (b *fakeBackend) DialogAnswer(window string, answer host.DialogAnswer) error {
	b.mu.Lock()
	b.dialogAnswers = append(b.dialogAnswers, answer)
	b.mu.Unlock()
	return nil
}

func (b *fakeBackend) Key(window string, input host.KeyInput) error {
	b.mu.Lock()
	b.keys = append(b.keys, input)
	b.mu.Unlock()
	return nil
}

func (b *fakeBackend) seen() ([]string, []string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.requests...), append([]string(nil), b.commands...)
}

// serve starts the endpoint with a loopback listener and, when the window main exists, writes endpoint.json. The transport of the endpoint is created by the operating system implementation,
// and this check verifies the request handling, which is independent of the transport.
func serve(t *testing.T, backend host.Backend) (*host.Endpoint, string, string) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	config := t.TempDir()
	endpoint := host.NewEndpoint(backend)
	info := host.EndpointInfo{Transport: "unix", Address: listener.Addr().String(), PID: os.Getpid(),
		Application: "fixture", Version: "0.0.2", Started: time.Now()}
	if err := endpoint.Serve(listener, info, config); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = endpoint.Close() })
	if backend.HasWindow("main") {
		if err := endpoint.Publish("main"); err != nil {
			t.Fatal(err)
		}
	}
	return endpoint, listener.Addr().String(), config
}

// contract: endpoint.lock.single-owner
func TestEndpointAllowsOneProcessPerConfigurationDirectory(t *testing.T) {
	first, _, config := serve(t, newFakeBackend())
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	second := host.NewEndpoint(newFakeBackend())
	info := host.EndpointInfo{Transport: "tcp", Address: listener.Addr().String(), PID: os.Getpid(),
		Application: "fixture", Version: "0.0.2", Started: time.Now()}
	err = second.Serve(listener, info, config)
	_ = listener.Close()
	if err == nil || !strings.Contains(err.Error(), "already owned by process") {
		t.Fatalf("second process was not refused: %v", err)
	}
	if _, err := os.Stat(filepath.Join(config, "process.lock")); err != nil {
		t.Fatalf("first process lock was lost: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(config, "process.lock")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("process lock remained after normal close: %v", err)
	}
}

// contract: endpoint.process.lock-mode-0600
func TestProcessLockIsOwnerOnly(t *testing.T) {
	_, _, config := serve(t, newFakeBackend())
	info, err := os.Stat(filepath.Join(config, "process.lock"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("process.lock mode %o, want 600", info.Mode().Perm())
	}
}

func dial(t *testing.T, address string) net.Conn {
	t.Helper()
	conn, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func send(t *testing.T, conn net.Conn, message any) {
	t.Helper()
	body, err := json.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	frame := make([]byte, 4, 4+len(body))
	binary.BigEndian.PutUint32(frame, uint32(len(body)))
	if _, err := conn.Write(append(frame, body...)); err != nil {
		t.Fatal(err)
	}
}

type message struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int            `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
	Result  json.RawMessage `json:"result"`
	Error   *host.RPCError  `json:"error"`
}

func receive(t *testing.T, conn net.Conn) (message, error) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	var size [4]byte
	if _, err := io.ReadFull(conn, size[:]); err != nil {
		return message{}, err
	}
	body := make([]byte, binary.BigEndian.Uint32(size[:]))
	if _, err := io.ReadFull(conn, body); err != nil {
		return message{}, err
	}
	var got message
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	return got, nil
}

func call(t *testing.T, conn net.Conn, id int, method string, params any) message {
	t.Helper()
	send(t, conn, map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	got, err := receive(t, conn)
	if err != nil {
		t.Fatalf("%s: %v", method, err)
	}
	if got.ID == nil || *got.ID != id {
		t.Fatalf("%s: reply id %v", method, got.ID)
	}
	return got
}

// expectClosed checks that the server closed the connection without replying. When a connection that has unread bytes is
// closed, the operating system sends a reset, and that also counts as closed.
func expectClosed(t *testing.T, conn net.Conn) {
	t.Helper()
	got, err := receive(t, conn)
	if err == nil {
		t.Fatalf("server replied instead of closing: %+v", got)
	}
	if !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, syscall.ECONNRESET) {
		t.Fatalf("connection was not closed by the server: %v", err)
	}
}

// contract: endpoint.transport.http-request-line-closes
func TestEndpointClosesOnHTTPRequestLine(t *testing.T) {
	backend := newFakeBackend()
	_, address, _ := serve(t, backend)
	conn := dial(t, address)
	if _, err := conn.Write([]byte("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	expectClosed(t, conn)
	if requests, commands := backend.seen(); len(requests) != 0 || len(commands) != 0 {
		t.Fatalf("a method ran: %v %v", requests, commands)
	}
}

// contract: endpoint.transport.invalid-json-closes
func TestEndpointClosesOnInvalidJSON(t *testing.T) {
	_, address, _ := serve(t, newFakeBackend())
	conn := dial(t, address)
	body := []byte("{not json")
	frame := binary.BigEndian.AppendUint32(nil, uint32(len(body)))
	if _, err := conn.Write(append(frame, body...)); err != nil {
		t.Fatal(err)
	}
	expectClosed(t, conn)
}

// contract: endpoint.transport.non-jsonrpc-object-closes
func TestEndpointClosesOnNonRPCObject(t *testing.T) {
	_, address, _ := serve(t, newFakeBackend())
	conn := dial(t, address)
	send(t, conn, []int{1, 2})
	expectClosed(t, conn)
	conn = dial(t, address)
	send(t, conn, map[string]any{"jsonrpc": "1.0", "id": 1, "method": "windows.list"})
	expectClosed(t, conn)
}

// contract: endpoint.transport.undeclared-method-closes
func TestEndpointClosesOnUndeclaredMethod(t *testing.T) {
	backend := newFakeBackend()
	_, address, _ := serve(t, backend)
	// dom.rect and dom.act are removed: an element is measured with element.rect and acted on with element.act.
	for _, method := range []string{"page.eval", "dom.rect", "dom.act"} {
		conn := dial(t, address)
		send(t, conn, map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": map[string]any{"window": "main", "name": "core.card"}})
		expectClosed(t, conn)
	}
	if requests, _ := backend.seen(); len(requests) != 0 {
		t.Fatalf("an undeclared method reached the page: %v", requests)
	}
}

// builtWith returns whether this check binary was built with the build tag tag.
func builtWith(tag string) bool {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return false
	}
	for _, setting := range info.Settings {
		if setting.Key == "-tags" {
			for _, value := range strings.Split(setting.Value, ",") {
				if value == tag {
					return true
				}
			}
		}
	}
	return false
}

// contract: endpoint.diagnostics.methods-exist-only-in-diagnostic-builds
func TestDiagnosticMethodsExistOnlyInDiagnosticBuilds(t *testing.T) {
	backend := newFakeBackend()
	_, address, _ := serve(t, backend)
	conn := dial(t, address)
	params := map[string]any{"window": "main", "on": false}
	if builtWith("diagnostics") {
		reply := call(t, conn, 1, "diagnostics.transcript", params)
		if reply.Error != nil {
			t.Fatalf("diagnostics.transcript failed in a diagnostic build: %+v", reply.Error)
		}
		return
	}
	send(t, conn, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "diagnostics.transcript", "params": params})
	expectClosed(t, conn)
	if requests, _ := backend.seen(); len(requests) != 0 {
		t.Fatalf("a diagnostic method reached the page in a release build: %v", requests)
	}
}

// contract: endpoint.rpc.round-trip-by-id, endpoint.rpc.page-params-omit-window
func TestEndpointRoundTrip(t *testing.T) {
	backend := newFakeBackend()
	_, address, _ := serve(t, backend)
	conn := dial(t, address)
	got := call(t, conn, 7, "windows.list", nil)
	if got.JSONRPC != "2.0" || got.Error != nil {
		t.Fatalf("windows.list failed: %+v", got)
	}
	var windows []host.WindowEntry
	if err := json.Unmarshal(got.Result, &windows); err != nil || len(windows) != 1 || windows[0].Window != "main" {
		t.Fatalf("windows.list result %s (%v)", got.Result, err)
	}
	// One connection sends several requests.
	got = call(t, conn, 8, "status.get", map[string]any{"window": "main", "name": "core.layout"})
	if got.Error != nil || string(got.Result) != "null" {
		t.Fatalf("status.get failed: %+v", got)
	}
	// The page receives params without window.
	backend.mu.Lock()
	bodies := append([]string(nil), backend.bodies...)
	backend.mu.Unlock()
	if len(bodies) != 1 || bodies[0] != `{"name":"core.layout"}` {
		t.Fatalf("page received params %v, want [{\"name\":\"core.layout\"}]", bodies)
	}
}

// contract: endpoint.rpc.unknown-window-1003, endpoint.rpc.missing-window-param-invalid
func TestEndpointMissingWindow(t *testing.T) {
	backend := newFakeBackend()
	_, address, _ := serve(t, backend)
	conn := dial(t, address)
	got := call(t, conn, 1, "command.run", map[string]any{"window": "gone", "name": "host.window.reload"})
	if got.Error == nil || got.Error.Code != 1003 {
		t.Fatalf("host command on a missing window: %+v", got)
	}
	if _, commands := backend.seen(); len(commands) != 0 {
		t.Fatalf("host command ran for a missing window: %v", commands)
	}
	got = call(t, conn, 2, "status.get", map[string]any{"name": "core.layout"})
	if got.Error == nil || got.Error.Code != -32602 {
		t.Fatalf("status.get without window: %+v", got)
	}
	if requests, _ := backend.seen(); len(requests) != 0 {
		t.Fatalf("a request without window reached the page: %v", requests)
	}
}

// contract: endpoint.rpc.element-rect-role
func TestEndpointElementRectKeepsRole(t *testing.T) {
	for _, role := range []string{`"button"`, `null`} {
		backend := newFakeBackend()
		backend.replies = map[string]json.RawMessage{"element.rect": json.RawMessage(`{"x":1,"y":2,"width":3,"height":4,"zoom":1,"role":` + role + `}`)}
		_, address, _ := serve(t, backend)
		got := call(t, dial(t, address), 1, "element.rect", map[string]any{"window": "main", "name": "core.save"})
		if got.Error != nil {
			t.Fatalf("element.rect: %+v", got.Error)
		}
		var result map[string]json.RawMessage
		if err := json.Unmarshal(got.Result, &result); err != nil {
			t.Fatalf("result %s: %v", got.Result, err)
		}
		if answered, has := result["role"]; !has || string(answered) != role {
			t.Fatalf("the reply %s, want the role %s", got.Result, role)
		}
	}
}

// contract: endpoint.rpc.target-params-are-checked-in-order
func TestEndpointTargetParamsOrder(t *testing.T) {
	backend := newFakeBackend()
	_, address, _ := serve(t, backend)
	conn := dial(t, address)
	const window = "window must be a non-empty string"
	const name = "name is required and must have the form <owner>.<name>"
	cases := []struct {
		params  map[string]any
		code    int
		message string
	}{
		{map[string]any{"name": "core.layout"}, -32602, window},
		{map[string]any{"window": 3, "name": "core.layout"}, -32602, window},
		{map[string]any{"window": "", "name": "core.layout"}, -32602, window},
		{map[string]any{"window": nil, "name": "core.layout"}, -32602, window},
		// The window is checked before the name, and the name before the existence of the window.
		{map[string]any{"window": 3, "name": 3}, -32602, window},
		{map[string]any{"window": "gone", "name": 3}, -32602, name},
		{map[string]any{"window": "gone", "name": "layout"}, -32602, name},
	}
	for m, method := range []string{"status.get", "element.rect", "element.act"} {
		for id, c := range cases {
			got := call(t, conn, 30+100*m+id, method, c.params)
			if got.Error == nil || got.Error.Code != c.code || got.Error.Message != c.message {
				t.Fatalf("%s %v: %+v, want %d %q", method, c.params, got.Error, c.code, c.message)
			}
		}
	}
	if requests, _ := backend.seen(); len(requests) != 0 {
		t.Fatalf("a request with invalid target params reached the page: %v", requests)
	}
}

// contract: endpoint.names.unknown-host-name-1001, endpoint.errors.unknown-name-text, endpoint.names.missing-name-invalid, endpoint.names.owner-form-required, endpoint.names.valid-name-examples, endpoint.input.pointer-invalid-phase
func TestEndpointNameErrors(t *testing.T) {
	_, address, _ := serve(t, newFakeBackend())
	conn := dial(t, address)
	got := call(t, conn, 1, "command.run", map[string]any{"window": "main", "name": "host.window.unknown"})
	if got.Error == nil || got.Error.Code != 1001 || got.Error.Message != "command host.window.unknown is not declared" {
		t.Fatalf("unknown host command: %+v", got)
	}
	got = call(t, conn, 4, "status.get", map[string]any{"window": "main", "name": "host.nope"})
	if got.Error == nil || got.Error.Code != 1001 || got.Error.Message != "status host.nope is not declared" {
		t.Fatalf("unknown host status get: %+v", got)
	}
	got = call(t, conn, 5, "status.watch", map[string]any{"window": "main", "name": "host.nope"})
	if got.Error == nil || got.Error.Code != 1001 || got.Error.Message != "status host.nope is not declared" {
		t.Fatalf("unknown host status watch: %+v", got)
	}
	got = call(t, conn, 2, "status.get", map[string]any{"window": "main"})
	if got.Error == nil || got.Error.Code != -32602 {
		t.Fatalf("missing name: %+v", got)
	}
	for id, name := range []any{"layout", "Core.layout", "core.", 3} {
		got = call(t, conn, 10+id, "status.get", map[string]any{"window": "main", "name": name})
		if got.Error == nil || got.Error.Code != -32602 {
			t.Fatalf("name %v: %+v", name, got)
		}
	}
	// The host declares no element entry, so an element request for a host name is an unknown name and reaches no page.
	for id, method := range []string{"element.rect", "element.act"} {
		got = call(t, conn, 40+id, method, map[string]any{"window": "main", "name": "host.buttons", "action": "click"})
		if got.Error == nil || got.Error.Code != 1001 || got.Error.Message != "the host declares no element entry host.buttons" {
			t.Fatalf("%s of a host name: %+v", method, got.Error)
		}
	}
	got = call(t, conn, 3, "input.pointer", map[string]any{"window": "main", "x": 1, "y": 2, "phase": "hover"})
	if got.Error == nil || got.Error.Code != -32602 {
		t.Fatalf("invalid pointer phase: %+v", got)
	}
	for id, name := range []string{"core.surface.document", "plugin-x.a-1"} {
		got = call(t, conn, 20+id, "status.get", map[string]any{"window": "main", "name": name})
		if got.Error != nil {
			t.Fatalf("valid name %s: %+v", name, got)
		}
	}
}

// contract: endpoint.input.pointer-missing-coordinate, endpoint.input.pointer-numeric-button-rejected, endpoint.input.pointer-middle-button-rejected, endpoint.input.pointer-clicks-range, endpoint.input.pointer-clicks-only-on-press-and-release, endpoint.input.pointer-clicks-default, endpoint.input.pointer-unknown-field-rejected, endpoint.input.pointer-activate-only-on-move, endpoint.input.pointer-activate-must-be-bool, endpoint.input.pointer-defaults, endpoint.input.pointer-right-button-accepted, endpoint.input.pointer-phase-and-scroll-decoding, endpoint.input.pointer-name
func TestEndpointPointerParams(t *testing.T) {
	backend := newFakeBackend()
	_, address, _ := serve(t, backend)
	conn := dial(t, address)
	rejected := []map[string]any{
		{"window": "main", "x": 1, "y": 2, "phase": "down", "button": 0},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "button": "middle"},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "activate": true},
		{"window": "main", "y": 2, "phase": "move"},
		{"window": "main", "x": 1, "y": 2, "phase": "move", "activate": "yes"},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "clicks": 0},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "clicks": -1},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "clicks": 4},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "clicks": 1.5},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "clicks": "2"},
		{"window": "main", "x": 1, "y": 2, "phase": "move", "clicks": 2},
		{"window": "main", "x": 1, "y": 2, "phase": "drag", "clicks": 2},
		{"window": "main", "x": 1, "y": 2, "phase": "scroll", "clicks": 2},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "clickCount": 2},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "Clicks": 2},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "pointer": ""},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "pointer": "Second"},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "pointer": "a b"},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "pointer": strings.Repeat("p", 33)},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "pointer": 2},
	}
	for i, params := range rejected {
		got := call(t, conn, i+1, "input.pointer", params)
		if got.Error == nil || got.Error.Code != -32602 {
			t.Fatalf("%v: %+v", params, got)
		}
	}
	accepted := []map[string]any{
		{"window": "main", "x": 1, "y": 2, "phase": "move", "activate": true},
		{"window": "main", "x": 3, "y": 4, "phase": "up", "button": "right"},
		{"window": "main", "x": 1.5, "y": 2, "phase": "drag"},
		{"window": "main", "x": 0, "y": 0, "phase": "scroll", "deltaY": -3, "button": "right"},
		{"window": "main", "x": 5, "y": 6, "phase": "down", "clicks": 2},
		{"window": "main", "x": 5, "y": 6, "phase": "up", "clicks": 3},
		{"window": "main", "x": 7, "y": 8, "phase": "down", "pointer": "second-1"},
		{"window": "main", "x": 7, "y": 8, "phase": "drag", "pointer": strings.Repeat("p", 32)},
	}
	for i, params := range accepted {
		if got := call(t, conn, 100+i, "input.pointer", params); got.Error != nil {
			t.Fatalf("%v: %+v", params, got)
		}
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	want := []host.PointerInput{
		{Pointer: "main", X: 1, Y: 2, Phase: "move", Button: "left", Activate: true, Clicks: 1},
		{Pointer: "main", X: 3, Y: 4, Phase: "up", Button: "right", Clicks: 1},
		{Pointer: "main", X: 1.5, Y: 2, Phase: "drag", Button: "left", Clicks: 1},
		{Pointer: "main", X: 0, Y: 0, Phase: "scroll", Button: "right", DeltaY: -3, Clicks: 1},
		{Pointer: "main", X: 5, Y: 6, Phase: "down", Button: "left", Clicks: 2},
		{Pointer: "main", X: 5, Y: 6, Phase: "up", Button: "left", Clicks: 3},
		{Pointer: "second-1", X: 7, Y: 8, Phase: "down", Button: "left", Clicks: 1},
		{Pointer: strings.Repeat("p", 32), X: 7, Y: 8, Phase: "drag", Button: "left", Clicks: 1},
	}
	if len(backend.pointers) != len(want) {
		t.Fatalf("pointer input %+v, want %+v", backend.pointers, want)
	}
	for i := range want {
		if backend.pointers[i] != want[i] {
			t.Fatalf("pointer input %d is %+v, want %+v", i, backend.pointers[i], want[i])
		}
	}
}

// contract: endpoint.input.pointer-button-held-message
func TestButtonHeldMessage(t *testing.T) {
	cases := []struct {
		held platform.ButtonHeld
		want string
	}{
		{platform.ButtonHeld{Mask: 0x1, Frontmost: &platform.FrontmostApplication{BundleIdentifier: "com.example.editor", PID: 412}},
			"AppKit reports NSEvent.pressedMouseButtons mask 0x1 while com.example.editor (pid 412) is frontmost; the synthetic press or release was not delivered"},
		{platform.ButtonHeld{Mask: 0x3, Frontmost: &platform.FrontmostApplication{PID: 77}},
			"AppKit reports NSEvent.pressedMouseButtons mask 0x3 while an application without a bundle identifier (pid 77) is frontmost; the synthetic press or release was not delivered"},
		{platform.ButtonHeld{Mask: 0x1a},
			"AppKit reports NSEvent.pressedMouseButtons mask 0x1a while no application is frontmost; the synthetic press or release was not delivered"},
	}
	for _, c := range cases {
		if got := host.ButtonHeldMessage(c.held); got != c.want {
			t.Errorf("ButtonHeldMessage(%+v) = %q, want %q", c.held, got, c.want)
		}
	}
}

// contract: endpoint.input.pointer-held-message
func TestPointerHeldMessage(t *testing.T) {
	held := platform.ButtonHeld{Pointer: "second", Reason: "the page at the point holds its press"}
	want := "pointer second holds a press that this input would share: the page at the point holds its press"
	if got := host.PointerHeldMessage(held); got != want {
		t.Errorf("PointerHeldMessage(%+v) = %q, want %q", held, got, want)
	}
}

// contract: endpoint.input.key-unknown-modifier-rejected, endpoint.input.key-shift-command-mask, endpoint.input.key-control-option-and-text, endpoint.input.key-invalid-phase-or-modifier-type
func TestEndpointKeyModifiers(t *testing.T) {
	backend := newFakeBackend()
	_, address, _ := serve(t, backend)
	conn := dial(t, address)
	got := call(t, conn, 1, "input.key", map[string]any{"window": "main", "key": "a", "phase": "down", "modifiers": []string{"hyper"}})
	if got.Error == nil || got.Error.Code != -32602 {
		t.Fatalf("unknown modifier: %+v", got)
	}
	got = call(t, conn, 2, "input.key", map[string]any{"window": "main", "key": "a", "phase": "up", "modifiers": []string{"shift", "command"}})
	if got.Error != nil {
		t.Fatalf("input.key: %+v", got)
	}
	got = call(t, conn, 3, "input.key", map[string]any{"window": "main", "key": "a", "text": "A", "phase": "up", "modifiers": []string{"control", "option"}})
	if got.Error != nil {
		t.Fatalf("input.key with text: %+v", got)
	}
	got = call(t, conn, 4, "input.key", map[string]any{"window": "main", "key": "a", "phase": "hold"})
	if got.Error == nil || got.Error.Code != -32602 {
		t.Fatalf("unknown key phase: %+v", got)
	}
	got = call(t, conn, 5, "input.key", map[string]any{"window": "main", "key": "a", "phase": "down", "modifiers": 2})
	if got.Error == nil || got.Error.Code != -32602 {
		t.Fatalf("modifiers that are not an array: %+v", got)
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	want := []host.KeyInput{
		{Key: "a", Modifiers: 9},
		{Key: "a", Text: "A", Modifiers: 6},
	}
	if len(backend.keys) != len(want) || backend.keys[0] != want[0] || backend.keys[1] != want[1] {
		t.Fatalf("key input %+v, want %+v", backend.keys, want)
	}
}

// contract: endpoint.input.key-empty-text-types-the-key
func TestEndpointKeyWithEmptyTextHasNoText(t *testing.T) {
	backend := newFakeBackend()
	_, address, _ := serve(t, backend)
	conn := dial(t, address)
	got := call(t, conn, 1, "input.key", map[string]any{"window": "main", "key": "Enter", "text": "", "phase": "down"})
	if got.Error != nil {
		t.Fatalf("input.key with empty text: %+v", got)
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	want := host.KeyInput{Key: "Enter", Down: true}
	if len(backend.keys) != 1 || backend.keys[0] != want {
		t.Fatalf("key input %+v, want %+v: InjectKey types the key name for an empty text", backend.keys, want)
	}
}

// contract: endpoint.input.text-phases, endpoint.input.text-ranges, endpoint.input.text-invalid
func TestEndpointTextSteps(t *testing.T) {
	backend := newFakeBackend()
	_, address, _ := serve(t, backend)
	conn := dial(t, address)
	steps := []map[string]any{
		{"window": "main", "phase": "mark", "text": "한😀"},
		{"window": "main", "phase": "mark", "text": "한글", "selection": map[string]any{"start": 0, "length": 1},
			"replacement": map[string]any{"start": 2, "length": 3}},
		{"window": "main", "phase": "insert", "text": "한"},
		{"window": "main", "phase": "unmark"},
	}
	for index, params := range steps {
		if got := call(t, conn, index+1, "input.text", params); got.Error != nil {
			t.Fatalf("input.text %v: %+v", params, got)
		}
	}
	invalid := []map[string]any{
		{"window": "main", "phase": "compose", "text": "a"},
		{"window": "main", "phase": "mark"},
		{"window": "main", "phase": "unmark", "text": "a"},
		{"window": "main", "phase": "mark", "text": "ab", "selection": map[string]any{"start": 1, "length": 2}},
		{"window": "main", "phase": "insert", "text": "a", "selection": map[string]any{"start": 0, "length": 0}},
		{"window": "main", "phase": "insert", "text": "a", "replacement": map[string]any{"start": -1, "length": 0}},
		{"window": "main", "phase": "mark", "text": "a", "selection": map[string]any{"start": 0}},
	}
	for index, params := range invalid {
		if got := call(t, conn, 10+index, "input.text", params); got.Error == nil || got.Error.Code != -32602 {
			t.Fatalf("input.text %v: %+v, want -32602", params, got)
		}
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	want := []host.TextInput{
		{Phase: host.TextMark, Text: "한😀", SelectionStart: 3, ReplacementStart: -1},
		{Phase: host.TextMark, Text: "한글", SelectionStart: 0, SelectionLength: 1, ReplacementStart: 2, ReplacementLength: 3},
		{Phase: host.TextInsert, Text: "한", ReplacementStart: -1},
		{Phase: host.TextUnmark, ReplacementStart: -1},
	}
	if len(backend.texts) != len(want) {
		t.Fatalf("text input %+v, want %+v", backend.texts, want)
	}
	for index := range want {
		if backend.texts[index] != want[index] {
			t.Fatalf("text input %d %+v, want %+v", index, backend.texts[index], want[index])
		}
	}
}

// contract: endpoint.discovery.writes-endpoint-json, endpoint.discovery.endpoint-json-mode-0600, endpoint.discovery.removes-endpoint-json-on-close
func TestEndpointFileIsWrittenAndRemoved(t *testing.T) {
	endpoint, address, config := serve(t, newFakeBackend())
	path := filepath.Join(config, "endpoint.json")
	var info map[string]any
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &info); err != nil {
		t.Fatal(err)
	}
	if info["transport"] != "unix" || info["address"] != address || info["pid"] != float64(os.Getpid()) ||
		info["application"] != "fixture" || info["version"] != "0.0.2" {
		t.Fatalf("endpoint.json: %v", info)
	}
	executable, _ := os.Executable()
	executable, _ = filepath.EvalSymlinks(executable)
	if info["executable"] != executable {
		t.Fatalf("executable %v, want %s", info["executable"], executable)
	}
	if _, err := time.Parse(time.RFC3339, info["started"].(string)); err != nil {
		t.Fatalf("started is not ISO 8601: %v", info["started"])
	}
	if stat, err := os.Stat(path); err != nil || stat.Mode().Perm() != 0600 {
		t.Fatalf("endpoint.json mode %v, want 0600: %v", stat.Mode(), err)
	}
	if err := endpoint.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("endpoint.json remains after close: %v", err)
	}
}

// contract: endpoint.discovery.close-keeps-replacement
func TestEndpointCloseDoesNotRemoveReplacement(t *testing.T) {
	endpoint, _, config := serve(t, newFakeBackend())
	path := filepath.Join(config, "endpoint.json")
	replacement := map[string]any{
		"transport": "unix", "address": "replacement.sock", "pid": os.Getpid() + 1,
		"application": "fixture", "version": "0.0.2", "executable": "/replacement",
		"started": time.Now().UTC().Format(time.RFC3339),
	}
	data, err := json.Marshal(replacement)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := endpoint.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("replacement endpoint was removed: %v", err)
	}
}

// contract: endpoint.watch.notifies-watching-connection, endpoint.watch.non-watching-connection-not-notified, endpoint.watch.unwatch-is-per-connection, endpoint.watch.page-watch-deduplicated, endpoint.watch.no-page-unwatch-while-watched, endpoint.watch.last-watcher-close-unwatches-page, endpoint.watch.registry-reflects-watches
func TestWatchersBelongToTheirConnection(t *testing.T) {
	backend := newFakeBackend()
	endpoint, address, _ := serve(t, backend)
	first := dial(t, address)
	second := dial(t, address)
	watch := map[string]any{"window": "main", "name": "core.layout"}
	if endpoint.Watching("main", "core.layout") {
		t.Fatal("the registry lists a watch before any status.watch")
	}
	if got := call(t, first, 1, "status.watch", watch); got.Error != nil {
		t.Fatalf("status.watch: %+v", got)
	}
	if !endpoint.Watching("main", "core.layout") || endpoint.Watching("main", "core.other") {
		t.Fatalf("registry after status.watch: core.layout %v, core.other %v",
			endpoint.Watching("main", "core.layout"), endpoint.Watching("main", "core.other"))
	}
	endpoint.StatusChanged("main", "core.layout", "", 1)
	got, err := receive(t, first)
	if err != nil || got.Method != "status.changed" || got.ID != nil {
		t.Fatalf("watching connection got %+v (%v)", got, err)
	}
	var change struct {
		Window string
		Name   string
		Value  int
	}
	if err := json.Unmarshal(got.Params, &change); err != nil || change.Window != "main" || change.Name != "core.layout" || change.Value != 1 {
		t.Fatalf("status.changed params %s", got.Params)
	}
	// The second connection did not watch, so it receives the reply to its own request first and not a notification.
	if got := call(t, second, 2, "status.watch", watch); got.Error != nil {
		t.Fatalf("second status.watch: %+v", got)
	}
	if got := call(t, first, 3, "status.unwatch", watch); got.Error != nil {
		t.Fatalf("status.unwatch: %+v", got)
	}
	endpoint.StatusChanged("main", "core.layout", "", 2)
	got, err = receive(t, second)
	if err != nil || got.Method != "status.changed" {
		t.Fatalf("second connection got %+v (%v)", got, err)
	}
	if got := call(t, first, 4, "windows.list", nil); got.Method != "" {
		t.Fatalf("unwatched connection received a notification: %+v", got)
	}
	// The page receives only the first watch and the last release.
	requests, _ := backend.seen()
	watches := 0
	for _, method := range requests {
		if method == "status.watch" || method == "status.unwatch" {
			watches++
		}
	}
	if watches != 1 {
		t.Fatalf("page received %v", requests)
	}
	// When a connection closes, the watches of that connection disappear and the page receives the release.
	_ = second.Close()
	<-backend.unwatched
	if endpoint.Watching("main", "core.layout") {
		t.Fatal("the registry lists a watch after the last watcher closed")
	}
}

// contract: endpoint.watch.surface-and-plain-forwarded-separately, endpoint.watch.empty-surface-invalid, endpoint.watch.surface-change-names-surface, endpoint.watch.surface-unwatch-forwarded-with-surface, endpoint.watch.surface-unwatch-keeps-plain-watch
func TestSurfaceWatchesAreSeparate(t *testing.T) {
	backend := newFakeBackend()
	endpoint, address, _ := serve(t, backend)
	conn := dial(t, address)
	named := map[string]any{"window": "main", "name": "probe.lines", "surface": "tab-a"}
	chosen := map[string]any{"window": "main", "name": "probe.lines"}
	if got := call(t, conn, 1, "status.watch", named); got.Error != nil {
		t.Fatalf("status.watch with surface: %+v", got)
	}
	if got := call(t, conn, 2, "status.watch", chosen); got.Error != nil {
		t.Fatalf("status.watch without surface: %+v", got)
	}
	if got := call(t, conn, 3, "status.watch", map[string]any{"window": "main", "name": "probe.lines", "surface": ""}); got.Error == nil || got.Error.Code != -32602 {
		t.Fatalf("empty surface: %+v", got)
	}
	backend.mu.Lock()
	bodies := append([]string(nil), backend.bodies...)
	backend.mu.Unlock()
	if len(bodies) != 2 || bodies[0] != `{"name":"probe.lines","surface":"tab-a"}` || bodies[1] != `{"name":"probe.lines"}` {
		t.Fatalf("page received %v", bodies)
	}
	endpoint.StatusChanged("main", "probe.lines", "tab-a", []string{"a"})
	got, err := receive(t, conn)
	if err != nil || got.Method != "status.changed" {
		t.Fatalf("notification %+v (%v)", got, err)
	}
	var change map[string]any
	if err := json.Unmarshal(got.Params, &change); err != nil || change["surface"] != "tab-a" {
		t.Fatalf("status.changed params %s", got.Params)
	}
	endpoint.StatusChanged("main", "probe.lines", "", []string{"b"})
	got, err = receive(t, conn)
	if err != nil {
		t.Fatal(err)
	}
	change = nil
	if err := json.Unmarshal(got.Params, &change); err != nil {
		t.Fatal(err)
	}
	if _, has := change["surface"]; has {
		t.Fatalf("a change of a watch without surface names one: %s", got.Params)
	}
	if got := call(t, conn, 4, "status.unwatch", named); got.Error != nil {
		t.Fatalf("status.unwatch: %+v", got)
	}
	// Releasing the watch of a surface leaves the watch of the same name without a surface.
	if !endpoint.Watching("main", "probe.lines") {
		t.Fatal("unwatching the surface watch removed the watch without surface")
	}
	endpoint.StatusChanged("main", "probe.lines", "", []string{"c"})
	got, err = receive(t, conn)
	if err != nil || got.Method != "status.changed" {
		t.Fatalf("the watch without surface got %+v (%v)", got, err)
	}
	<-backend.unwatched
	backend.mu.Lock()
	last := backend.bodies[len(backend.bodies)-1]
	backend.mu.Unlock()
	if last != `{"name":"probe.lines","surface":"tab-a"}` {
		t.Fatalf("unwatch params %s", last)
	}
}

// contract: endpoint.watch.subscription-arrival-order
func TestSubscriptionChangesKeepArrivalOrder(t *testing.T) {
	backend := newFakeBackend()
	backend.held = make(chan struct{})
	backend.holdMethod = "status.watch"
	backend.entered = make(chan struct{}, 1)
	endpoint, address, _ := serve(t, backend)
	conn := dial(t, address)
	watch := map[string]any{"window": "main", "name": "core.layout"}
	request := func(id int, method string) {
		send(t, conn, map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": watch})
	}
	request(1, "status.watch")
	<-backend.entered
	// Sends a release and a watch in succession before the page reply to the first watch arrives.
	request(2, "status.unwatch")
	request(3, "status.watch")
	close(backend.held)
	for range 3 {
		got, err := receive(t, conn)
		if err != nil || got.Error != nil || got.ID == nil {
			t.Fatalf("reply %+v (%v)", got, err)
		}
	}
	endpoint.StatusChanged("main", "core.layout", "", 5)
	got, err := receive(t, conn)
	if err != nil || got.Method != "status.changed" {
		t.Fatalf("the connection is not watching after unwatch and watch: %+v (%v)", got, err)
	}
	requests, _ := backend.seen()
	var order []string
	for _, method := range requests {
		if method == "status.watch" || method == "status.unwatch" {
			order = append(order, method)
		}
	}
	if len(order) != 3 || order[0] != "status.watch" || order[1] != "status.unwatch" || order[2] != "status.watch" {
		t.Fatalf("page received %v", order)
	}
}

// An unwatch enters the queue of its topic only when the last change of its connection for the topic is a watch. While the
// page holds the first watch of connection A, the second unwatch of A, whose last change is the queued unwatch, and the unwatch
// of connection B, which never watched, change nothing: each is answered null before the page answers, so neither waited in
// the queue. After the page answers, the watch and the first unwatch of A succeed and the page received one status.unwatch.
// contract: endpoint.watch.unwatch-enters-the-queue-only-after-a-watch
func TestAnUnwatchAfterNoWatchChangesNothingAndIsAnsweredWithoutTheQueue(t *testing.T) {
	backend := newFakeBackend()
	backend.held = make(chan struct{})
	backend.holdMethod = "status.watch"
	backend.entered = make(chan struct{}, 1)
	_, address, _ := serve(t, backend)
	a, b := dial(t, address), dial(t, address)
	watch := map[string]any{"window": "main", "name": "core.layout"}
	request := func(conn net.Conn, id int, method string) {
		send(t, conn, map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": watch})
	}
	request(a, 1, "status.watch")
	<-backend.entered
	request(a, 2, "status.unwatch")
	request(a, 3, "status.unwatch")
	request(b, 1, "status.unwatch")
	for _, unanswered := range []struct {
		conn net.Conn
		name string
		id   int
	}{{a, "the second unwatch of A", 3}, {b, "the unwatch of B", 1}} {
		got := receiveInTurn(t, unanswered.conn)
		if got.ID == nil || *got.ID != unanswered.id || got.Error != nil || string(got.Result) != "null" {
			t.Fatalf("%s answered %+v while the page holds the watch, want null", unanswered.name, got)
		}
	}
	close(backend.held)
	for _, id := range []int{1, 2} {
		if got := receiveInTurn(t, a); got.ID == nil || *got.ID != id || got.Error != nil {
			t.Fatalf("reply %+v, want the success of request %d of A", got, id)
		}
	}
	if got := len(backend.unwatched); got != 1 {
		t.Fatalf("the page received %d status.unwatch, want 1", got)
	}
}

// contract: endpoint.watch.other-requests-not-blocked-by-pending-subscription
func TestPendingSubscriptionDoesNotBlockOtherRequests(t *testing.T) {
	backend := newFakeBackend()
	backend.held = make(chan struct{})
	backend.holdMethod = "status.unwatch"
	backend.entered = make(chan struct{}, 1)
	endpoint, address, _ := serve(t, backend)
	conn := dial(t, address)
	watch := map[string]any{"window": "main", "name": "core.layout"}
	if got := call(t, conn, 1, "status.watch", watch); got.Error != nil {
		t.Fatalf("status.watch: %+v", got)
	}
	// Sends a watch and a status read before the page replies to the watch release.
	send(t, conn, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "status.unwatch", "params": watch})
	<-backend.entered
	send(t, conn, map[string]any{"jsonrpc": "2.0", "id": 3, "method": "status.watch", "params": watch})
	send(t, conn, map[string]any{"jsonrpc": "2.0", "id": 4, "method": "status.get", "params": watch})
	got, err := receive(t, conn)
	if err != nil || got.ID == nil || *got.ID != 4 {
		t.Fatalf("status.get was not answered while status.unwatch was pending: %+v (%v)", got, err)
	}
	close(backend.held)
	var replies []int
	for range 2 {
		got, err := receive(t, conn)
		if err != nil || got.Error != nil || got.ID == nil {
			t.Fatalf("reply %+v (%v)", got, err)
		}
		replies = append(replies, *got.ID)
	}
	if replies[0] != 2 || replies[1] != 3 {
		t.Fatalf("subscription replies %v, want [2 3]", replies)
	}
	if !endpoint.Watching("main", "core.layout") {
		t.Fatal("the connection is not watching after unwatch and watch")
	}
}

// contract: endpoint.discovery.removes-socket-on-close
func TestEndpointSocketIsRemovedOnClose(t *testing.T) {
	listener, address, err := listen(t, filepath.Join(support.SocketParent(t), "sockets"), "test-close")
	if err != nil {
		t.Fatal(err)
	}
	endpoint := host.NewEndpoint(newFakeBackend())
	info := host.EndpointInfo{Transport: address.Transport, Address: address.Address, PID: os.Getpid(),
		Application: "fixture", Version: "0.0.2", Started: time.Now()}
	if err := endpoint.Serve(listener, info, t.TempDir()); err != nil {
		_ = listener.Close()
		t.Fatal(err)
	}
	if _, err := os.Stat(address.Address); err != nil {
		t.Fatalf("socket is missing while serving: %v", err)
	}
	if err := endpoint.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(address.Address); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket remains after close: %v", err)
	}
}

func listen(t *testing.T, directory, name string) (net.Listener, platform.Endpoint, error) {
	t.Helper()
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	return system.Listen(directory, name)
}

// contract: endpoint.socket.private-modes
func TestEndpointFilesArePrivateToTheUser(t *testing.T) {
	sockets := filepath.Join(support.SocketParent(t), "sockets")
	listener, address, err := listen(t, sockets, "test-modes")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if stat, err := os.Stat(sockets); err != nil || stat.Mode().Perm() != 0700 {
		t.Fatalf("socket directory mode %v: %v", stat.Mode(), err)
	}
	if stat, err := os.Stat(address.Address); err != nil || stat.Mode().Perm() != 0600 {
		t.Fatalf("socket mode %v: %v", stat.Mode(), err)
	}
}

// endedProcess returns the number of an ended process.
func endedProcess(t *testing.T) int {
	t.Helper()
	command := exec.Command("/usr/bin/true")
	if err := command.Run(); err != nil {
		t.Fatal(err)
	}
	return command.Process.Pid
}

// contract: endpoint.socket.sweeps-ended-process-sockets
func TestSocketsOfEndedProcessesAreRemoved(t *testing.T) {
	sockets := filepath.Join(support.SocketParent(t), "sockets")
	if err := os.Mkdir(sockets, 0700); err != nil {
		t.Fatal(err)
	}
	ended := filepath.Join(sockets, fmt.Sprintf("test-sweep-%d.sock", endedProcess(t)))
	running := filepath.Join(sockets, fmt.Sprintf("test-sweep-%d.sock", os.Getppid()))
	other := filepath.Join(sockets, fmt.Sprintf("test-other-%d.sock", endedProcess(t)))
	for _, path := range []string{ended, running, other} {
		if err := os.WriteFile(path, nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	listener, _, err := listen(t, sockets, "test-sweep")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	present := func(path string) bool {
		_, err := os.Stat(path)
		return err == nil
	}
	if present(ended) || !present(running) || !present(other) {
		t.Fatalf("ended %v, running %v, other application %v", present(ended), present(running), present(other))
	}
}

// contract: endpoint.socket.refuses-open-directory
func TestSocketDirectoryOpenToOthersIsRefused(t *testing.T) {
	sockets := filepath.Join(support.SocketParent(t), "sockets")
	if err := os.Mkdir(sockets, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(sockets, 0755); err != nil {
		t.Fatal(err)
	}
	_, _, err := listen(t, sockets, "test-open")
	if err == nil || !strings.Contains(err.Error(), "mode 755") {
		t.Fatalf("got %v, want a mode error", err)
	}
}

// contract: endpoint.socket.refuses-foreign-owner
func TestSocketDirectoryOfAnotherUserIsRefused(t *testing.T) {
	// /usr is owned by root. The check looks at the owner before the permissions.
	_, _, err := listen(t, "/usr", "test-owner")
	if err == nil || !strings.Contains(err.Error(), "belongs to another user") {
		t.Fatalf("got %v, want an owner error", err)
	}
}

// contract: endpoint.socket.refuses-non-directory
func TestSocketPathThatIsNotADirectoryIsRefused(t *testing.T) {
	parent := support.SocketParent(t)
	target := filepath.Join(parent, "target")
	if err := os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
	sockets := filepath.Join(parent, "sockets")
	if err := os.Symlink(target, sockets); err != nil {
		t.Fatal(err)
	}
	_, _, err := listen(t, sockets, "test-link")
	if err == nil || !strings.Contains(err.Error(), "is not a directory") {
		t.Fatalf("got %v, want a kind error", err)
	}
}

// contract: endpoint.socket.path-over-limit
func TestSocketPathOverTheLimitIsRefused(t *testing.T) {
	sockets := filepath.Join(support.SocketParent(t), strings.Repeat("s", 120))
	address := filepath.Join(sockets, fmt.Sprintf("test-long-%d.sock", os.Getpid()))
	_, _, err := listen(t, sockets, "test-long")
	want := fmt.Sprintf("endpoint socket path %s is %d bytes, over the limit of 103 bytes of a unix socket address", address, len(address))
	if err == nil || err.Error() != want {
		t.Fatalf("got %v, want %q", err, want)
	}
}

// lateBackend has the window main only after that window is registered.
type lateBackend struct {
	*fakeBackend
	registered atomic.Bool
}

func (b *lateBackend) HasWindow(window string) bool { return window == "main" && b.registered.Load() }

// contract: endpoint.discovery.written-after-first-window
func TestEndpointFileIsWrittenOnlyAfterTheFirstWindowExists(t *testing.T) {
	backend := &lateBackend{fakeBackend: newFakeBackend()}
	endpoint, address, config := serve(t, backend)
	file := filepath.Join(config, "endpoint.json")
	if _, err := os.Stat(file); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("endpoint.json was written before the first window was registered: %v", err)
	}
	if err := endpoint.Publish("main"); err == nil || !strings.Contains(err.Error(), "window main does not exist") {
		t.Fatalf("endpoint.json was published for a window that does not exist: %v", err)
	}
	if _, err := os.Stat(file); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a refused publication wrote endpoint.json: %v", err)
	}
	backend.registered.Store(true)
	if err := endpoint.Publish("main"); err != nil {
		t.Fatal(err)
	}
	var info host.EndpointInfo
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &info); err != nil || info.Address != address {
		t.Fatalf("endpoint.json %s does not name the endpoint %s: %v", data, address, err)
	}
	conn := dial(t, address)
	reply := call(t, conn, 1, "status.get", map[string]any{"window": "main", "name": "host.windows"})
	if reply.Error != nil {
		t.Fatalf("a request after publication failed: %+v", reply.Error)
	}
}

// contract: endpoint.lock.unrecorded-end
func TestStaleLockOfAnotherFormIsTakenOverAndReported(t *testing.T) {
	for _, contents := range []string{"123", "abc"} {
		config := t.TempDir()
		if err := os.WriteFile(filepath.Join(config, "process.lock"), []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		endpoint := host.NewEndpoint(newFakeBackend())
		info := host.EndpointInfo{Transport: "tcp", Address: listener.Addr().String(), PID: os.Getpid(),
			Application: "fixture", Version: "0.0.20", Started: time.Now()}
		if err := endpoint.Serve(listener, info, config); err != nil {
			_ = listener.Close()
			t.Fatalf("a stale lock %q was refused: %v", contents, err)
		}
		end, ok := endpoint.UnrecordedEnd()
		if !ok || end.Boot != nil || end.PID != nil || end.Previous == nil || *end.Previous != contents {
			t.Fatalf("stale lock %q: unrecorded end %+v (%v)", contents, end, ok)
		}
		if err := endpoint.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

// contract: endpoint.lock.single-owner
func TestTwoStartersOfAStaleLockLeaveOneOwner(t *testing.T) {
	config := t.TempDir()
	stale := fmt.Sprintf(`{"pid":%d,"boot":"1700000000-4242"}`, endedProcess(t))
	ran, secondErr, firstErr := startBesideStaleLock(t, config, stale)
	if !ran {
		t.Fatal("the second start did not run at the stale lock")
	}
	if secondErr == nil || !strings.Contains(secondErr.Error(), "already owned by process") {
		t.Fatalf("the second start was not refused while the first start claims the lock: %v", secondErr)
	}
	if firstErr != nil {
		t.Fatalf("the first start failed: %v", firstErr)
	}
}

// contract: endpoint.lock.single-owner
func TestAStarterMeetsAnOwnerThatHasNotWrittenItsRecord(t *testing.T) {
	config := t.TempDir()
	ran, secondErr, firstErr := startBesideStaleLock(t, config, "")
	if !ran {
		t.Fatal("the second start did not run at the lock of the first start")
	}
	if secondErr == nil || !strings.Contains(secondErr.Error(), "already owned by a live process") {
		t.Fatalf("the second start was not refused while the owner has not written its record: %v", secondErr)
	}
	if firstErr != nil {
		t.Fatalf("the first start failed: %v", firstErr)
	}
}

// startBesideStaleLock starts an endpoint in config whose lock file has the content stale. A second start runs once, at the point where
// the first start has read the stale content and before it writes its record. It reports whether the second start ran, and the errors of
// the second and the first start.
func startBesideStaleLock(t *testing.T, config, stale string) (bool, error, error) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(config, "process.lock"), []byte(stale), 0o600); err != nil {
		t.Fatal(err)
	}
	var fired atomic.Bool
	var ran bool
	var secondErr error
	var second *host.Endpoint
	host.SetProcessLockHook(func(directory string) {
		// The hook is process-wide, so it acts only on the directory of this test and on its first call.
		if directory != config || fired.Swap(true) {
			return
		}
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		second = host.NewEndpoint(newFakeBackend())
		info := host.EndpointInfo{Transport: "tcp", Address: listener.Addr().String(), PID: os.Getpid(),
			Application: "fixture", Version: "0.0.20", Started: time.Now()}
		secondErr = second.Serve(listener, info, config)
		ran = true
		if secondErr != nil {
			_ = listener.Close()
		}
	})
	defer host.SetProcessLockHook(nil)
	first := host.NewEndpoint(newFakeBackend())
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	info := host.EndpointInfo{Transport: "tcp", Address: listener.Addr().String(), PID: os.Getpid(),
		Application: "fixture", Version: "0.0.20", Started: time.Now()}
	firstErr := first.Serve(listener, info, config)
	if firstErr == nil {
		t.Cleanup(func() { _ = first.Close() })
	}
	if second != nil {
		t.Cleanup(func() { _ = second.Close() })
	}
	return ran, secondErr, firstErr
}

// contract: endpoint.lock.unrecorded-end
// contract: endpoint.lock.empty-is-no-previous-run
func TestAnEmptyLockFileIsTakenOverWithoutAReport(t *testing.T) {
	// A starter creates process.lock before it locks the file, so an empty file that is not locked can be the file of a
	// starter that has not locked it yet. No owner wrote a record in it, so no earlier run is reported.
	config := t.TempDir()
	if err := os.WriteFile(filepath.Join(config, "process.lock"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	endpoint := host.NewEndpoint(newFakeBackend())
	info := host.EndpointInfo{Transport: "tcp", Address: listener.Addr().String(), PID: os.Getpid(),
		Application: "fixture", Version: "0.0.20", Started: time.Now()}
	if err := endpoint.Serve(listener, info, config); err != nil {
		_ = listener.Close()
		t.Fatalf("an empty lock file was refused: %v", err)
	}
	if end, ok := endpoint.UnrecordedEnd(); ok {
		t.Fatalf("an empty lock file was reported as an earlier run: %+v", end)
	}
	if err := endpoint.Close(); err != nil {
		t.Fatal(err)
	}
}

// contract: endpoint.lock.unrecorded-end
func TestStaleLockIsTakenOverAndNamesThePreviousRun(t *testing.T) {
	config := t.TempDir()
	dead := endedProcess(t)
	lock := filepath.Join(config, "process.lock")
	if err := os.WriteFile(lock, fmt.Appendf(nil, `{"pid":%d,"boot":"1700000000-4242"}`, dead), 0o600); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	endpoint := host.NewEndpoint(newFakeBackend())
	info := host.EndpointInfo{Transport: "tcp", Address: listener.Addr().String(), PID: os.Getpid(),
		Application: "fixture", Version: "0.0.20", Started: time.Now()}
	if err := endpoint.Serve(listener, info, config); err != nil {
		_ = listener.Close()
		t.Fatalf("a stale lock was refused: %v", err)
	}
	end, ok := endpoint.UnrecordedEnd()
	if !ok || end.Boot == nil || *end.Boot != "1700000000-4242" || end.PID == nil || *end.PID != dead || end.Previous != nil {
		t.Fatalf("unrecorded end %+v (%v), want pid %d boot 1700000000-4242", end, ok, dead)
	}
	data, err := os.ReadFile(lock)
	if err != nil {
		t.Fatal(err)
	}
	var written host.LockOwner
	if err := json.Unmarshal(data, &written); err != nil {
		t.Fatalf("process.lock %s is not the owner record: %v", data, err)
	}
	if written.PID != os.Getpid() || written.Boot == "1700000000-4242" {
		t.Fatalf("process.lock %s does not name this run", data)
	}
	if err := endpoint.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(lock); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("process lock remained after normal close: %v", err)
	}
}

// closeRecord reports whether the log holds exactly one close record that matches the text after the time.
func closeRecord(t *testing.T, written func() string, text string) {
	t.Helper()
	record := regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z info host endpoint: connection closed: ` + regexp.QuoteMeta(text) + `$`)
	for _, line := range strings.Split(strings.TrimSuffix(written(), "\n"), "\n") {
		if record.MatchString(line) {
			return
		}
	}
	t.Fatalf("no close record %q in %q", text, strings.Split(strings.TrimSuffix(written(), "\n"), "\n"))
}

// contract: endpoint.transport.close-reason-is-recorded
func TestEndpointRecordsWhyAConnectionCloses(t *testing.T) {
	written := support.CaptureLog(t)
	backend := newFakeBackend()
	_, address, _ := serve(t, backend)

	conn := dial(t, address)
	if _, err := conn.Write([]byte("GET / HTTP/1.1\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	expectClosed(t, conn)
	closeRecord(t, written, "frame of 1195725856 bytes exceeds the limit of 16777216")

	conn = dial(t, address)
	body := []byte("{not json")
	frame := binary.BigEndian.AppendUint32(nil, uint32(len(body)))
	if _, err := conn.Write(append(frame, body...)); err != nil {
		t.Fatal(err)
	}
	expectClosed(t, conn)
	closeRecord(t, written, "frame is not a JSON-RPC 2.0 request: {not json")

	conn = dial(t, address)
	send(t, conn, []int{1, 2})
	expectClosed(t, conn)
	closeRecord(t, written, "frame is not a JSON-RPC 2.0 request: [1,2]")

	conn = dial(t, address)
	send(t, conn, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "page.eval", "params": map[string]any{"window": "main"}})
	expectClosed(t, conn)
	closeRecord(t, written, `method "page.eval" is not declared`)

	// The record of a close by the peer is written before the page is told that the last watcher ended.
	conn = dial(t, address)
	if got := call(t, conn, 1, "status.watch", map[string]any{"window": "main", "name": "core.layout"}); got.Error != nil {
		t.Fatalf("status.watch: %+v", got)
	}
	_ = conn.Close()
	<-backend.unwatched
	closeRecord(t, written, "peer closed")
}

// A connection that ends inside a frame closes with the reason of the read, not with peer closed.
// contract: endpoint.close.reason-of-read-error
func TestEndpointRecordsAReadErrorInsideAFrame(t *testing.T) {
	_, await := support.CaptureLogAwait(t)
	backend := newFakeBackend()
	_, address, _ := serve(t, backend)

	conn := dial(t, address)
	frame := binary.BigEndian.AppendUint32(nil, 10)
	if _, err := conn.Write(append(frame, []byte("{\"j")...)); err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
	await("connection closed: connection closed inside a frame body")
}

// A reply to a connection that the peer closed before the reply is not an error: the host records the reply as not sent.
// contract: endpoint.close.reply-after-peer-close
func TestEndpointRecordsAReplyToAClosedConnectionAsNotSent(t *testing.T) {
	_, await := support.CaptureLogAwait(t)
	backend := newFakeBackend()
	backend.holdMethod = "status.get"
	backend.held = make(chan struct{})
	backend.entered = make(chan struct{}, 1)
	_, address, _ := serve(t, backend)

	conn := dial(t, address)
	send(t, conn, map[string]any{"jsonrpc": "2.0", "id": 9, "method": "status.get", "params": map[string]any{"window": "main", "name": "core.layout"}})
	<-backend.entered
	_ = conn.Close()
	await("connection closed: peer closed")
	close(backend.held)
	log := await("info host endpoint: reply to 9 not sent: peer closed")
	if strings.Contains(log, "error host endpoint") {
		t.Fatalf("the reply to a closed connection was an error:\n%s", log)
	}
}

// shutWriteListener accepts connections and shuts their write side down, so each write of the server fails with EPIPE as a write
// to a socket whose peer closed the connection does. The read side stays open.
type shutWriteListener struct{ net.Listener }

func (l shutWriteListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	if err := conn.(*net.TCPConn).CloseWrite(); err != nil {
		return nil, errors.Join(err, conn.Close())
	}
	return conn, nil
}

// A write that fails because the peer closed the connection closes it as a peer close and records the frame as not sent.
// contract: endpoint.close.reply-after-peer-close
func TestEndpointRecordsAWriteThatThePeerClosedAsNotSent(t *testing.T) {
	written, await := support.CaptureLogAwait(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	endpoint := host.NewEndpoint(newFakeBackend())
	info := host.EndpointInfo{Transport: "unix", Address: listener.Addr().String(), PID: os.Getpid(),
		Application: "fixture", Version: "0.0.2", Started: time.Now()}
	if err := endpoint.Serve(shutWriteListener{listener}, info, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = endpoint.Close() })
	conn := dial(t, listener.Addr().String())
	send(t, conn, map[string]any{"jsonrpc": "2.0", "id": 4, "method": "windows.list"})
	log := await("info host endpoint: reply to 4 not sent: peer closed")
	closeRecord(t, written, "peer closed")
	if strings.Contains(log, "error host endpoint") {
		t.Fatalf("a write to a connection that the peer closed was an error:\n%s", log)
	}
}

// An accept that fails while the endpoint serves ends the accept loop and writes the reason to the application log. The deadline
// of the listener in the past makes the operating system fail its accept with a timeout, which is a real accept error.
// contract: endpoint.accept.error-is-recorded
func TestEndpointRecordsAnAcceptError(t *testing.T) {
	_, await := support.CaptureLogAwait(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	if err := listener.(*net.TCPListener).SetDeadline(time.Now()); err != nil {
		t.Fatal(err)
	}
	endpoint := host.NewEndpoint(newFakeBackend())
	info := host.EndpointInfo{Transport: "unix", Address: listener.Addr().String(), PID: os.Getpid(),
		Application: "fixture", Version: "0.0.2", Started: time.Now()}
	if err := endpoint.Serve(listener, info, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = endpoint.Close() })
	// The record is written by the accept goroutine after Accept returns, and the wait ends at the batch that holds it.
	log := await(" error host endpoint accept: accept tcp ")
	if !strings.Contains(log, "i/o timeout") {
		t.Fatalf("the accept error was not the timeout of the listener deadline:\n%s", log)
	}
}

// A request that ends without its result, the error 1005, writes the method and the reason to the application log before
// the client receives the error.
// contract: endpoint.no-result.is-recorded
func TestEndpointRecordsARequestThatEndedWithoutItsResult(t *testing.T) {
	written := support.CaptureLog(t)
	backend := newFakeBackend()
	backend.failures = map[string]error{"status.get": &host.RPCError{Code: 1005, Message: "the document did not receive the input"}}
	_, address, _ := serve(t, backend)
	conn := dial(t, address)
	got := call(t, conn, 1, "status.get", map[string]any{"window": "main", "name": "core.layout"})
	if got.Error == nil || got.Error.Code != 1005 {
		t.Fatalf("status.get answered %+v", got)
	}
	log := written()
	if want := " error host endpoint no result: status.get: the document did not receive the input"; !strings.Contains(log, want) {
		t.Fatalf("the log has no %q:\n%s", want, log)
	}
	if strings.Contains(log, "endpoint timeout") {
		t.Fatalf("the log names a timeout:\n%s", log)
	}
}

// connectionEndBackend is a fakeBackend whose page holds each command.run until the request ends on the host: entered
// receives the context of the request when the page received it, and ended receives a signal when that context ended.
type connectionEndBackend struct {
	*fakeBackend
	entered chan context.Context
	ended   chan struct{}
}

func (b connectionEndBackend) PageRequest(ctx context.Context, window, method string, params json.RawMessage) (json.RawMessage, error) {
	if method != "command.run" {
		return b.fakeBackend.PageRequest(ctx, window, method, params)
	}
	b.entered <- ctx
	<-ctx.Done()
	b.ended <- struct{}{}
	return nil, ctx.Err()
}

// The end of the endpoint connection that sent a request ends the request on the host: the page request of a command.run
// that its page holds ends when the client closes the connection, with no time limit before it.
// contract: exposure.command.ends-by-reply-or-peer-end, exposure.relay.connection-end-ends-its-requests
func TestTheEndOfTheEndpointConnectionEndsItsPageRequests(t *testing.T) {
	backend := connectionEndBackend{fakeBackend: newFakeBackend(), entered: make(chan context.Context, 1), ended: make(chan struct{}, 1)}
	_, address, _ := serve(t, backend)
	conn := dial(t, address)
	send(t, conn, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "command.run",
		"params": map[string]any{"window": "main", "name": "probe.run", "params": map[string]any{}}})
	ctx := <-backend.entered
	select {
	case <-ctx.Done():
		t.Fatalf("the request ended while its connection is open: %v", ctx.Err())
	default:
	}
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}
	<-backend.ended
}

// The first watch of host.dialog of a window and the end of its last watch reach the host, which holds the dialogs of the window
// while it is watched; a watch of another connection while one stands and the end of a watch that is not the last do not.
// contract: endpoint.dialog.watch-reaches-the-host
func TestTheWatchOfHostDialogReachesTheHost(t *testing.T) {
	backend := newFakeBackend()
	_, address, _ := serve(t, backend)
	first, second := dial(t, address), dial(t, address)
	params := map[string]any{"window": "main", "name": "host.dialog"}
	for index, step := range []struct {
		conn   net.Conn
		method string
		want   []string
	}{
		{first, "status.watch", []string{"main host.dialog on"}},
		{second, "status.watch", []string{"main host.dialog on"}},
		{first, "status.unwatch", []string{"main host.dialog on"}},
		{second, "status.unwatch", []string{"main host.dialog on", "main host.dialog off"}},
	} {
		if got := call(t, step.conn, index+1, step.method, params); got.Error != nil {
			t.Fatalf("%s host.dialog: %+v", step.method, got.Error)
		}
		backend.mu.Lock()
		seen := append([]string(nil), backend.hostWatches...)
		backend.mu.Unlock()
		if !slices.Equal(seen, step.want) {
			t.Fatalf("after %s %d the host saw %v, want %v", step.method, index+1, seen, step.want)
		}
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	for _, request := range backend.requests {
		if request == "status.watch" || request == "status.unwatch" {
			t.Fatalf("the watch of host.dialog reached the page: %v", backend.requests)
		}
	}
}

// input.dialog.answer gives the host the answer {id, paths} or {id, cancel: true} of a dialog of the window, with replace for a
// save or a download, and refuses with -32602 an answer without id, with paths and cancel, with neither, with paths that are not
// strings or with replace on a cancel.
// contract: endpoint.input.dialog-answer
func TestEndpointDialogAnswer(t *testing.T) {
	backend := newFakeBackend()
	_, address, _ := serve(t, backend)
	conn := dial(t, address)
	valid := []map[string]any{
		{"window": "main", "id": "d1", "paths": []string{"/saved/host.jsonl"}},
		{"window": "main", "id": "d2", "paths": []string{"/saved/host.jsonl"}, "replace": true},
		{"window": "main", "id": "d3", "paths": []string{"/a", "/b"}},
		{"window": "main", "id": "d4", "cancel": true},
	}
	for index, params := range valid {
		if got := call(t, conn, index+1, "input.dialog.answer", params); got.Error != nil || string(got.Result) != "null" {
			t.Fatalf("input.dialog.answer %v: %+v", params, got)
		}
	}
	invalid := []map[string]any{
		{"window": "main", "paths": []string{"/a"}},
		{"window": "main", "id": "", "paths": []string{"/a"}},
		{"window": "main", "id": "d5", "paths": []string{"/a"}, "cancel": true},
		{"window": "main", "id": "d5"},
		{"window": "main", "id": "d5", "cancel": false},
		{"window": "main", "id": "d5", "paths": "/a"},
		{"window": "main", "id": "d5", "paths": []any{3}},
		{"window": "main", "id": "d5", "cancel": true, "replace": true},
	}
	for index, params := range invalid {
		if got := call(t, conn, 10+index, "input.dialog.answer", params); got.Error == nil || got.Error.Code != -32602 {
			t.Fatalf("input.dialog.answer %v: %+v, want -32602", params, got)
		}
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	want := []host.DialogAnswer{
		{ID: "d1", Paths: []string{"/saved/host.jsonl"}},
		{ID: "d2", Paths: []string{"/saved/host.jsonl"}, Replace: true},
		{ID: "d3", Paths: []string{"/a", "/b"}},
		{ID: "d4", Cancel: true},
	}
	if !reflect.DeepEqual(backend.dialogAnswers, want) {
		t.Fatalf("the host received %+v, want %+v", backend.dialogAnswers, want)
	}
}
