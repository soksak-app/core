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
	"regexp"
	"runtime/debug"
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
	first, _, config := serve(t, newTierBackend([]string{"main"}))
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	second := host.NewEndpoint(newTierBackend([]string{"main"}))
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
	_, _, config := serve(t, newTierBackend([]string{"main"}))
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

// contract: endpoint.transport.invalid-json-closes
func TestEndpointClosesOnInvalidJSON(t *testing.T) {
	_, address, _ := serve(t, newTierBackend([]string{"main"}))
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
	_, address, _ := serve(t, newTierBackend([]string{"main"}))
	conn := dial(t, address)
	send(t, conn, []int{1, 2})
	expectClosed(t, conn)
	conn = dial(t, address)
	send(t, conn, map[string]any{"jsonrpc": "1.0", "id": 1, "method": "windows.list"})
	expectClosed(t, conn)
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

// contract: endpoint.discovery.writes-endpoint-json, endpoint.discovery.endpoint-json-mode-0600, endpoint.discovery.removes-endpoint-json-on-close
func TestEndpointFileIsWrittenAndRemoved(t *testing.T) {
	endpoint, address, config := serve(t, newTierBackend([]string{"main"}))
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
	endpoint, _, config := serve(t, newTierBackend([]string{"main"}))
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

// contract: endpoint.discovery.removes-socket-on-close
func TestEndpointSocketIsRemovedOnClose(t *testing.T) {
	listener, address, err := listen(t, filepath.Join(support.SocketParent(t), "sockets"), "test-close")
	if err != nil {
		t.Fatal(err)
	}
	endpoint := host.NewEndpoint(newTierBackend([]string{"main"}))
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

// contract: endpoint.discovery.written-after-first-window
func TestEndpointFileIsWrittenOnlyAfterTheFirstWindowExists(t *testing.T) {
	backend := newTierBackend(nil)
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
	backend.AddWindow("main")
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
		endpoint := host.NewEndpoint(newTierBackend([]string{"main"}))
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
		second = host.NewEndpoint(newTierBackend([]string{"main"}))
		info := host.EndpointInfo{Transport: "tcp", Address: listener.Addr().String(), PID: os.Getpid(),
			Application: "fixture", Version: "0.0.20", Started: time.Now()}
		secondErr = second.Serve(listener, info, config)
		ran = true
		if secondErr != nil {
			_ = listener.Close()
		}
	})
	defer host.SetProcessLockHook(nil)
	first := host.NewEndpoint(newTierBackend([]string{"main"}))
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
	endpoint := host.NewEndpoint(newTierBackend([]string{"main"}))
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
	endpoint := host.NewEndpoint(newTierBackend([]string{"main"}))
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

// A connection that ends inside a frame closes with the reason of the read, not with peer closed.
// contract: endpoint.close.reason-of-read-error
func TestEndpointRecordsAReadErrorInsideAFrame(t *testing.T) {
	_, await := support.CaptureLogAwait(t)
	_, address, _ := serve(t, newTierBackend([]string{"main"}))

	conn := dial(t, address)
	frame := binary.BigEndian.AppendUint32(nil, 10)
	if _, err := conn.Write(append(frame, []byte("{\"j")...)); err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
	await("connection closed: connection closed inside a frame body")
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
	endpoint := host.NewEndpoint(newTierBackend([]string{"main"}))
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
	endpoint := host.NewEndpoint(newTierBackend([]string{"main"}))
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
