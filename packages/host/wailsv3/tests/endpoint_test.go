package host_test

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	host "github.com/min-median-max/soksak/packages/host/wailsv3/src"
	"github.com/min-median-max/soksak/packages/host/wailsv3/src/platform"
)

// fakeBackend 는 창 하나("main")와 그 페이지를 흉내 낸다. 페이지 요청은 기록하고 null 로 답한다.
type fakeBackend struct {
	mu       sync.Mutex
	requests []string
	// bodies 는 페이지 요청의 params 다. requests 와 같은 순서다.
	bodies   []string
	commands []string
	keys     []host.KeyInput
	pointers []host.PointerInput
	// held 가 있으면 첫 status.watch 는 entered 에 신호를 보내고 held 가 닫힐 때까지 답하지 않는다.
	held    chan struct{}
	entered chan struct{}
	holding bool
	// unwatched 는 페이지가 status.unwatch 를 받을 때마다 신호를 받는다.
	unwatched chan struct{}
}

func newFakeBackend() *fakeBackend { return &fakeBackend{unwatched: make(chan struct{}, 8)} }

func (b *fakeBackend) Windows() []host.WindowEntry {
	return []host.WindowEntry{{Window: "main", Title: "Main", Key: true}}
}

func (b *fakeBackend) HasWindow(window string) bool { return window == "main" }

func (b *fakeBackend) PageRequest(window, method string, params json.RawMessage) (json.RawMessage, error) {
	b.mu.Lock()
	b.requests = append(b.requests, method)
	b.bodies = append(b.bodies, string(params))
	hold := method == "status.watch" && b.held != nil && !b.holding
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
	if method == "exposure.list" {
		return json.RawMessage(`{"status":[{"name":"core.layout","registered":true}],"commands":[],"dom":[]}`), nil
	}
	return json.RawMessage(`null`), nil
}

func (b *fakeBackend) HostStatus(window, name string) (any, error) {
	return map[string]any{"key": true}, nil
}

func (b *fakeBackend) HostCommand(window, name string, params json.RawMessage) (any, error) {
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

// serve 는 루프백 리스너로 엔드포인트를 시작한다. 엔드포인트의 전송은 운영체제 구현이
// 만들고, 이 검사는 전송과 무관한 요청 처리를 확인한다.
func serve(t *testing.T, backend host.Backend) (*host.Endpoint, string, string) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	config := t.TempDir()
	endpoint := host.NewEndpoint(backend)
	info := host.EndpointInfo{Transport: "unix", Address: listener.Addr().String(), PID: os.Getpid(),
		Application: "wailsv3", Version: "0.0.1", Started: time.Now()}
	if err := endpoint.Serve(listener, info, config); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = endpoint.Close() })
	return endpoint, listener.Addr().String(), config
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

// expectClosed 는 서버가 답하지 않고 연결을 닫았는지 확인한다. 읽지 않은 바이트가 남은 연결을
// 닫으면 운영체제가 재설정을 보내므로 그것도 닫힘이다.
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

func TestEndpointClosesOnNonRPCObject(t *testing.T) {
	_, address, _ := serve(t, newFakeBackend())
	conn := dial(t, address)
	send(t, conn, []int{1, 2})
	expectClosed(t, conn)
	conn = dial(t, address)
	send(t, conn, map[string]any{"jsonrpc": "1.0", "id": 1, "method": "windows.list"})
	expectClosed(t, conn)
}

func TestEndpointClosesOnUndeclaredMethod(t *testing.T) {
	backend := newFakeBackend()
	_, address, _ := serve(t, backend)
	conn := dial(t, address)
	send(t, conn, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "page.eval", "params": map[string]any{"window": "main"}})
	expectClosed(t, conn)
	if requests, _ := backend.seen(); len(requests) != 0 {
		t.Fatalf("an undeclared method reached the page: %v", requests)
	}
}

// builtWith 은 이 검사 바이너리가 빌드 태그 tag 로 빌드되었는지 반환한다.
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

func TestDiagnosticMethodsExistOnlyInDiagnosticBuilds(t *testing.T) {
	backend := newFakeBackend()
	_, address, _ := serve(t, backend)
	conn := dial(t, address)
	params := map[string]any{"window": "main", "name": "latency", "value": 0}
	if builtWith("diagnostics") {
		reply := call(t, conn, 1, "diagnostics.knob", params)
		if reply.Error != nil {
			t.Fatalf("diagnostics.knob failed in a diagnostic build: %+v", reply.Error)
		}
		if requests, _ := backend.seen(); len(requests) != 1 || requests[0] != "diagnostics.knob" {
			t.Fatalf("page requests %v, want diagnostics.knob", requests)
		}
		return
	}
	send(t, conn, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "diagnostics.knob", "params": params})
	expectClosed(t, conn)
	if requests, _ := backend.seen(); len(requests) != 0 {
		t.Fatalf("a diagnostic method reached the page in a release build: %v", requests)
	}
}

func TestEndpointRoundTrip(t *testing.T) {
	_, address, _ := serve(t, newFakeBackend())
	conn := dial(t, address)
	got := call(t, conn, 7, "windows.list", nil)
	if got.JSONRPC != "2.0" || got.Error != nil {
		t.Fatalf("windows.list failed: %+v", got)
	}
	var windows []host.WindowEntry
	if err := json.Unmarshal(got.Result, &windows); err != nil || len(windows) != 1 || windows[0].Window != "main" {
		t.Fatalf("windows.list result %s (%v)", got.Result, err)
	}
	// 한 연결이 여러 요청을 보낸다.
	got = call(t, conn, 8, "status.get", map[string]any{"window": "main", "name": "core.layout"})
	if got.Error != nil || string(got.Result) != "null" {
		t.Fatalf("status.get failed: %+v", got)
	}
}

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
}

func TestEndpointNameErrors(t *testing.T) {
	_, address, _ := serve(t, newFakeBackend())
	conn := dial(t, address)
	got := call(t, conn, 1, "command.run", map[string]any{"window": "main", "name": "host.window.unknown"})
	if got.Error == nil || got.Error.Code != 1001 {
		t.Fatalf("unknown host name: %+v", got)
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
	got = call(t, conn, 3, "input.pointer", map[string]any{"window": "main", "x": 1, "y": 2, "phase": "hover"})
	if got.Error == nil || got.Error.Code != -32602 {
		t.Fatalf("invalid pointer phase: %+v", got)
	}
}

func TestEndpointPointerParams(t *testing.T) {
	backend := newFakeBackend()
	_, address, _ := serve(t, backend)
	conn := dial(t, address)
	rejected := []map[string]any{
		{"window": "main", "x": 1, "y": 2, "phase": "down", "button": 0},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "button": "middle"},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "activate": true},
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
	}
	for i, params := range accepted {
		if got := call(t, conn, 10+i, "input.pointer", params); got.Error != nil {
			t.Fatalf("%v: %+v", params, got)
		}
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	want := []host.PointerInput{
		{X: 1, Y: 2, Phase: "move", Button: "left", Activate: true},
		{X: 3, Y: 4, Phase: "up", Button: "right"},
	}
	if len(backend.pointers) != len(want) || backend.pointers[0] != want[0] || backend.pointers[1] != want[1] {
		t.Fatalf("pointer input %+v", backend.pointers)
	}
}

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
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if len(backend.keys) != 1 || backend.keys[0].Modifiers != 9 || backend.keys[0].Down || backend.keys[0].Key != "a" {
		t.Fatalf("key input %+v", backend.keys)
	}
}

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
		info["application"] != "wailsv3" || info["version"] != "0.0.1" {
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

func TestWatchersBelongToTheirConnection(t *testing.T) {
	backend := newFakeBackend()
	endpoint, address, _ := serve(t, backend)
	first := dial(t, address)
	second := dial(t, address)
	watch := map[string]any{"window": "main", "name": "core.layout"}
	if got := call(t, first, 1, "status.watch", watch); got.Error != nil {
		t.Fatalf("status.watch: %+v", got)
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
	// 두 번째 연결은 감시하지 않았으므로 알림 대신 자기 요청의 답을 먼저 받는다.
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
	// 페이지는 첫 감시와 마지막 해제만 받는다.
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
	// 연결이 닫히면 그 연결의 감시가 사라지고 페이지가 해제를 받는다.
	_ = second.Close()
	select {
	case <-backend.unwatched:
	case <-time.After(2 * time.Second):
		t.Fatalf("page did not receive status.unwatch after the last watcher closed")
	}
}

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
	select {
	case <-backend.unwatched:
	case <-time.After(2 * time.Second):
		t.Fatal("page did not receive status.unwatch")
	}
	backend.mu.Lock()
	last := backend.bodies[len(backend.bodies)-1]
	backend.mu.Unlock()
	if last != `{"name":"probe.lines","surface":"tab-a"}` {
		t.Fatalf("unwatch params %s", last)
	}
}

func TestSubscriptionChangesKeepArrivalOrder(t *testing.T) {
	backend := newFakeBackend()
	backend.held = make(chan struct{})
	backend.entered = make(chan struct{}, 1)
	endpoint, address, _ := serve(t, backend)
	conn := dial(t, address)
	watch := map[string]any{"window": "main", "name": "core.layout"}
	request := func(id int, method string) {
		send(t, conn, map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": watch})
	}
	request(1, "status.watch")
	<-backend.entered
	// 첫 감시의 페이지 답이 오기 전에 해제와 감시를 연달아 보낸다.
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

// socketParent 는 소켓 경로 길이 제한 안에 드는 짧은 임시 디렉터리다.
func socketParent(t *testing.T) string {
	t.Helper()
	parent, err := os.MkdirTemp("", "sp")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(parent) })
	return parent
}

func listen(t *testing.T, directory, name string) (net.Listener, platform.Endpoint, error) {
	t.Helper()
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	return system.Listen(directory, name)
}

func TestEndpointFilesArePrivateToTheUser(t *testing.T) {
	sockets := filepath.Join(socketParent(t), "sockets")
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

func TestSocketDirectoryOpenToOthersIsRefused(t *testing.T) {
	sockets := filepath.Join(socketParent(t), "sockets")
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

func TestSocketDirectoryOfAnotherUserIsRefused(t *testing.T) {
	// /usr 는 root 소유다. 검사는 권한보다 소유자를 먼저 본다.
	_, _, err := listen(t, "/usr", "test-owner")
	if err == nil || !strings.Contains(err.Error(), "belongs to another user") {
		t.Fatalf("got %v, want an owner error", err)
	}
}

func TestSocketPathThatIsNotADirectoryIsRefused(t *testing.T) {
	parent := socketParent(t)
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
