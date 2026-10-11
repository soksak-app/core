package host_test

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/tests/support"
)

const echoSidecar = "@fixture/sidecar-echo"

// stall is the upper bound that ends a hung check. Success is decided by the received events and the ended processes and not by this time.
// Even on a heavily loaded machine, the reply and the exit of the sidecar arrive within it.
const stall = 120 * time.Second

// declare is the declaration of one sidecar installed in directory.
func declare(directory, sidecar string) []host.SidecarDeclaration {
	return []host.SidecarDeclaration{{Name: echoSidecar, Folder: directory, Data: []byte(sidecar)}}
}

// fakeOwner is a window that records the sidecar events and the failure events it received.
type fakeOwner struct {
	root     string
	mu       sync.Mutex
	events   []host.SidecarMessage
	seen     chan struct{}
	failures chan any
}

func newFakeOwner(root string) *fakeOwner {
	return &fakeOwner{root: root, seen: make(chan struct{}, 16), failures: make(chan any, 16)}
}

func (o *fakeOwner) ProjectRoot() string { return o.root }

func (o *fakeOwner) Emit(name string, data ...any) {
	if name == "sidecar-failure" && len(data) == 1 {
		o.failures <- data[0]
		return
	}
	if name != "sidecar-message" || len(data) != 1 {
		return
	}
	o.mu.Lock()
	o.events = append(o.events, data[0].(host.SidecarMessage))
	o.mu.Unlock()
	o.seen <- struct{}{}
}

func (o *fakeOwner) next(t *testing.T) host.SidecarMessage {
	t.Helper()
	select {
	case <-o.seen:
	case <-time.After(stall):
		t.Fatalf("no sidecar event within %v; the test stalled", stall)
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.events[len(o.events)-1]
}

// sidecarFailure is the JSON form of the sidecar-failure event value (docs/spec/sidecars.md#failure).
type sidecarFailure struct {
	Sidecar string `json:"sidecar"`
	Surface string `json:"surface"`
	Reason  string `json:"reason"`
}

// failure waits for the next failure event and returns it in the JSON form.
func (o *fakeOwner) failure(t *testing.T) sidecarFailure {
	t.Helper()
	var value any
	select {
	case value = <-o.failures:
	case <-time.After(stall):
		t.Fatalf("no sidecar failure within %v; the test stalled", stall)
	}
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var failure sidecarFailure
	if err := json.Unmarshal(data, &failure); err != nil {
		t.Fatal(err)
	}
	return failure
}

// messageLimit is the maximum size before the line break in one line of a sidecar message (docs/spec/sidecars.md#messages).
const messageLimit = 64 << 20

// scriptSidecars creates a channel that declares a fake sidecar that runs script, and its directory.
// DIR in script is replaced by that directory.
func scriptSidecars(t *testing.T, script string) (*host.Sidecars, string) {
	t.Helper()
	directory := t.TempDir()
	script = strings.ReplaceAll(script, "DIR", directory)
	if err := os.WriteFile(filepath.Join(directory, "fake"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	sidecars, err := host.NewSidecars(declare(directory, `{"executable":"fake","protocol":1}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	// Even when the check fails, no fake sidecar process is left.
	t.Cleanup(sidecars.Stop)
	return sidecars, directory
}

// paddedMessageScript is a script that reads one request, sends an s1 message of size bytes before the line break, and then runs then.
// The body is one string and a shell pipeline writes it, so the script process waits until the write ends.
func paddedMessageScript(size int, then string) (string, int) {
	prefix, suffix := `{"surface":"s1","body":"`, `"}`
	padding := size - len(prefix) - len(suffix)
	return fmt.Sprintf("#!/bin/sh\necho $$ > DIR/pid\nread request\nprintf '%%s' '%s'\nhead -c %d /dev/zero | tr '\\0' x\nprintf '%%s\\n' '%s'\n%s\n",
		prefix, padding, suffix, then), padding
}

// processID is the process id that the fake sidecar recorded.
func processID(t *testing.T, directory string) int {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(directory, "pid"))
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatal(err)
	}
	return pid
}

// requireEnded checks that the process pid ended and was reaped.
func requireEnded(t *testing.T, pid int) {
	t.Helper()
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("sidecar process %d still exists after its failure: kill(0) = %v", pid, err)
	}
}

// contract: sidecars.protocol.message-at-limit-is-delivered
func TestSidecarMessageAtTheLimitIsDelivered(t *testing.T) {
	script, padding := paddedMessageScript(messageLimit, "exec cat")
	sidecars, _ := scriptSidecars(t, script)
	owner := newFakeOwner("/projects/a")
	if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	event := owner.next(t)
	body := string(event.Body)
	if event.Surface != "s1" || len(body) != padding+2 || strings.Trim(body[1:len(body)-1], "x") != "" || body[0] != '"' || body[len(body)-1] != '"' {
		t.Fatalf("message at the limit: surface %q, body length %d, want %d", event.Surface, len(body), padding+2)
	}
	select {
	case value := <-owner.failures:
		t.Fatalf("message at the limit produced a failure: %+v", value)
	default:
	}
}

// contract: sidecars.failure.oversize-message-terminates-and-notifies
func TestOversizeSidecarMessageTerminatesAndNotifies(t *testing.T) {
	script, _ := paddedMessageScript(messageLimit+1, "exec sleep 600")
	sidecars, directory := scriptSidecars(t, script)
	owner := newFakeOwner("/projects/a")
	if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	failure := owner.failure(t)
	if failure.Sidecar != echoSidecar || failure.Surface != "s1" || !strings.Contains(failure.Reason, "exceeds 67108864 bytes") {
		t.Fatalf("oversize failure = %+v", failure)
	}
	requireEnded(t, processID(t, directory))
}

// contract: sidecars.failure.invalid-message-terminates-and-notifies
func TestInvalidSidecarMessageTerminatesAndNotifies(t *testing.T) {
	for _, line := range []string{`not json`, `{"surface":"s1"}`} {
		sidecars, directory := scriptSidecars(t, "#!/bin/sh\necho $$ > DIR/pid\nread request\nprintf '%s\\n' '"+line+"'\nexec sleep 600\n")
		owner := newFakeOwner("/projects/a")
		if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
			t.Fatal(err)
		}
		failure := owner.failure(t)
		if failure.Sidecar != echoSidecar || failure.Surface != "s1" || !strings.Contains(failure.Reason, "invalid message") {
			t.Fatalf("%s: failure = %+v", line, failure)
		}
		requireEnded(t, processID(t, directory))
	}
}

// contract: sidecars.failure.output-close-notifies-each-surface
func TestSidecarOutputCloseNotifiesEachSurface(t *testing.T) {
	sidecars, directory := scriptSidecars(t, "#!/bin/sh\necho $$ >> DIR/pids\nread first\nread second\nexit 3\n")
	first, second := newFakeOwner("/projects/a"), newFakeOwner("/projects/b")
	if err := sidecars.Send(first, echoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	if err := sidecars.Send(second, echoSidecar, "s2", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	for surface, owner := range map[string]*fakeOwner{"s1": first, "s2": second} {
		failure := owner.failure(t)
		if failure.Sidecar != echoSidecar || failure.Surface != surface || failure.Reason != "output closed: exit status 3" {
			t.Fatalf("%s: failure = %+v", surface, failure)
		}
	}
	// A send after the failure starts a new process.
	if err := sidecars.Send(first, echoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatalf("send after failure: %v", err)
	}
	sidecars.Stop()
	select {
	case value := <-first.failures:
		t.Fatalf("output end while stopping produced a failure: %+v", value)
	default:
	}
	data, err := os.ReadFile(filepath.Join(directory, "pids"))
	if err != nil {
		t.Fatal(err)
	}
	if pids := strings.Fields(string(data)); len(pids) != 2 || pids[0] == pids[1] {
		t.Fatalf("sidecar processes = %q, want two distinct processes", pids)
	}
}

// echoSidecars creates a channel that declares a fake sidecar that outputs the lines it received as they are.
// The surface and body of the request come back as an event as they are, and every request remains in the request record file.
func echoSidecars(t *testing.T) (*host.Sidecars, string) {
	t.Helper()
	directory := t.TempDir()
	record := filepath.Join(directory, "requests")
	script := "#!/bin/sh\ntee " + record + "\n"
	if err := os.WriteFile(filepath.Join(directory, "echo"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	sidecars, err := host.NewSidecars(declare(directory, `{"executable":"echo","protocol":1}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	// Stop closes stdin and waits for echo to record the remaining lines and end. With a short deadline, under load it would force the end before the record,
	// so the deadline is stall. echo ends soon at EOF, so the check does not become slow.
	sidecars.StopTimeout = stall
	return sidecars, record
}

// contract: sidecars.send.delivers-only-to-owning-window, sidecars.send.rejects-surface-owned-by-another-window, sidecars.protocol.request-lines-carry-surface-root-body, sidecars.close-owner.sends-closed-per-surface
func TestSidecarMessagesReachTheOwningWindowOnly(t *testing.T) {
	sidecars, record := echoSidecars(t)
	first, second := newFakeOwner("/projects/a"), newFakeOwner("/projects/b")
	if err := sidecars.Send(first, echoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	if err := sidecars.Send(second, echoSidecar, "s2", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	if event := first.next(t); event.Sidecar != echoSidecar || event.Surface != "s1" || string(event.Body) != `{"operation":"open"}` {
		t.Fatalf("first window event = %+v", event)
	}
	if event := second.next(t); event.Surface != "s2" {
		t.Fatalf("second window event = %+v", event)
	}
	if err := sidecars.Send(second, echoSidecar, "s1", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "another window") {
		t.Fatalf("send to another window's surface = %v", err)
	}
	sidecars.CloseOwner(first)
	sidecars.Stop()
	requests, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"surface":"s1","root":"/projects/a","body":{"operation":"open"}}
{"surface":"s2","root":"/projects/b","body":{"operation":"open"}}
{"surface":"s1","root":"/projects/a","closed":true}
`
	if string(requests) != want {
		t.Fatalf("requests =\n%s\nwant\n%s", requests, want)
	}
}

// contract: sidecars.protocol.surface-keeps-its-first-root
func TestSurfaceKeepsTheRootItWasOpenedWith(t *testing.T) {
	sidecars, record := echoSidecars(t)
	owner := newFakeOwner("/projects/a")
	if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	// Even after the same window changed to another project, a surface that is already open sends with the first root.
	owner.root = "/projects/b"
	if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{"operation":"input"}`)); err != nil {
		t.Fatal(err)
	}
	sidecars.CloseOwner(owner)
	sidecars.Stop()
	requests, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"surface":"s1","root":"/projects/a","body":{"operation":"open"}}
{"surface":"s1","root":"/projects/a","body":{"operation":"input"}}
{"surface":"s1","root":"/projects/a","closed":true}
`
	if string(requests) != want {
		t.Fatalf("requests =\n%s\nwant\n%s", requests, want)
	}
}

// contract: sidecars.send.rejects-undeclared-sidecar, sidecars.send.rejects-after-stop
func TestUndeclaredAndStoppedSidecarsAreRejected(t *testing.T) {
	sidecars, _ := echoSidecars(t)
	owner := newFakeOwner("/projects/a")
	if err := sidecars.Send(owner, "other", "s1", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "not declared") {
		t.Fatalf("undeclared sidecar = %v", err)
	}
	sidecars.Stop()
	if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "stopped") {
		t.Fatalf("send after stop = %v", err)
	}
}

// contract: sidecars.start.fails-on-missing-executable
func TestMissingSidecarExecutableFails(t *testing.T) {
	directory := t.TempDir()
	sidecars, err := host.NewSidecars(declare(directory, `{"executable":"absent","protocol":1}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	if err := sidecars.Send(newFakeOwner("/"), echoSidecar, "s1", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "sidecar "+echoSidecar) {
		t.Fatalf("missing executable = %v", err)
	}
}

// contract: sidecars.start.passes-log-directory
func TestSidecarReceivesTheLogDirectory(t *testing.T) {
	sidecars, directory := scriptSidecars(t, "#!/bin/sh\nprintf '%s\\n' \"$@\" > DIR/argv\nread request\nprintf '%s\\n' '{\"surface\":\"s1\",\"body\":\"ok\"}'\nexec cat\n")
	owner := newFakeOwner("/projects/a")
	if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	owner.next(t)
	config, err := filepath.EvalSymlinks(directory)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(directory, "argv"))
	if err != nil {
		t.Fatal(err)
	}
	want := "--log-dir\n" + filepath.Join(config, "logs") + "\n"
	if string(data) != want {
		t.Fatalf("arguments of the sidecar = %q, want %q", data, want)
	}
}

// contract: sidecars.declaration.adds-sidecars-installed-after-start
func TestDeclaringAddsSidecarsInstalledAfterTheStart(t *testing.T) {
	directory := t.TempDir()
	record := filepath.Join(directory, "requests")
	if err := os.WriteFile(filepath.Join(directory, "echo"), []byte("#!/bin/sh\ntee "+record+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	sidecars, err := host.NewSidecars(nil, directory)
	if err != nil {
		t.Fatal(err)
	}
	sidecars.StopTimeout = stall
	owner := newFakeOwner("/projects/a")
	if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "is not declared by any plugin") {
		t.Fatalf("send before the declaration = %v", err)
	}
	if err := sidecars.Declare(declare(directory, `{"executable":"echo","protocol":1}`)); err != nil {
		t.Fatal(err)
	}
	if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	if event := owner.next(t); event.Surface != "s1" || string(event.Body) != `{"operation":"open"}` {
		t.Fatalf("event = %+v", event)
	}
	sidecars.Stop()
}

// contract: sidecars.declaration.rejects-executable-escaping-package, sidecars.declaration.rejects-absolute-executable, sidecars.declaration.rejects-unsupported-protocol, sidecars.declaration.rejects-unknown-transport, sidecars.declaration.persistent-requires-config-directory
func TestInvalidSidecarDeclarationsFail(t *testing.T) {
	cases := map[string]struct {
		sidecar string
		want    string
	}{
		"escaping executable":       {`{"executable":"../escape","protocol":1}`, "inside the package"},
		"absolute executable":       {`{"executable":"/bin/sh","protocol":1}`, "inside the package"},
		"unknown protocol":          {`{"executable":"echo","protocol":2}`, "protocol"},
		"persistent without config": {`{"executable":"echo","protocol":1,"transport":"persistent"}`, "persistent transport requires a config directory"},
		"unknown transport":         {`{"executable":"echo","protocol":1,"transport":"ptyd"}`, "transport ptyd is not supported"},
	}
	for name, c := range cases {
		directory := t.TempDir()
		configDirectory := directory
		if name == "persistent without config" {
			configDirectory = ""
		}
		if _, err := host.NewSidecars(declare(directory, c.sidecar), configDirectory); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: error = %v, want %q", name, err, c.want)
		}
	}
}

// contract: sidecars.declaration.persistent-requires-config-directory
func TestPersistentTransportRequiresConfigDirectory(t *testing.T) {
	if _, err := host.NewSidecars(declare(t.TempDir(), `{"executable":"echo","protocol":1,"transport":"persistent"}`), ""); err == nil || !strings.Contains(err.Error(), "persistent transport requires a config directory") {
		t.Fatalf("persistent transport without config = %v", err)
	}
}

// contract: sidecars.persistent.accepts-non-canonical-config-directory
func TestPersistentTransportAcceptsNonCanonicalConfigDirectory(t *testing.T) {
	// filepath.Join removes ".", so the path that is not normalized is built by string concatenation.
	configDirectory := t.TempDir()
	sidecars, err := host.NewSidecars(declare(t.TempDir(), `{"executable":"echo","protocol":1,"transport":"persistent"}`), configDirectory+string(os.PathSeparator)+".")
	if err != nil {
		t.Fatalf("non-canonical config directory was rejected: %v", err)
	}
	// There is no executable, so the service start fails, and before that the service directory is created under the configuration directory.
	err = sidecars.Send(newFakeOwner("/projects/test"), echoSidecar, "s1", json.RawMessage(`{}`))
	if err == nil || !strings.Contains(err.Error(), "sidecar") {
		t.Fatalf("send = %v, want a sidecar start error", err)
	}
	if info, err := os.Stat(filepath.Join(configDirectory, "services", "echo")); err != nil || !info.IsDir() {
		t.Fatalf("service directory under the config directory: %v", err)
	}
}

// contract: sidecars.send.rejects-when-no-plugin-declares-sidecars
func TestApplicationWithoutSidecarsRejectsSends(t *testing.T) {
	directory := t.TempDir()
	sidecars, err := host.NewSidecars(nil, directory)
	if err != nil {
		t.Fatal(err)
	}
	if err := sidecars.Send(newFakeOwner("/"), echoSidecar, "s1", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "not declared by any plugin") {
		t.Fatalf("send = %v", err)
	}
}

// contract: sidecars.send.fails-fast-when-sidecar-not-keeping-up, sidecars.send.slow-sidecar-does-not-block-others, sidecars.stop.honors-stop-timeout
func TestSlowSidecarDoesNotBlockOtherSends(t *testing.T) {
	// The slow sidecar does not read stdin, and the other sidecar works normally.
	// When 257 sends go to the slow sidecar, the 256th succeeds and the 257th fails with the "is not keeping up" error.
	// This test checks two properties:
	// 1. Even when the channel of the slow sidecar is full, Send() to the fast sidecar does not block.
	// 2. Stop() keeps StopTimeout.

	directory := t.TempDir()

	// The slow sidecar: it does not read stdin, so the pipe fills and Stop kills it after the deadline. A program that reads stdin, such as cat,
	// reads at a speed that depends on the load, so whether the channel fills is not determined.
	slowScript := "#!/bin/sh\nexec sleep 600\n"
	if err := os.WriteFile(filepath.Join(directory, "slow"), []byte(slowScript), 0o755); err != nil {
		t.Fatal(err)
	}

	// The fast sidecar: it outputs the lines it received as they are.
	fastScript := "#!/bin/sh\ntee /dev/null\n"
	if err := os.WriteFile(filepath.Join(directory, "fast"), []byte(fastScript), 0o755); err != nil {
		t.Fatal(err)
	}

	// Declares the two sidecars.
	sidecars, err := host.NewSidecars([]host.SidecarDeclaration{
		{Name: "@fixture/sidecar-slow", Folder: directory, Data: []byte(`{"executable":"slow","protocol":1}`)},
		{Name: "@fixture/sidecar-fast", Folder: directory, Data: []byte(`{"executable":"fast","protocol":1}`)},
	}, directory)
	if err != nil {
		t.Fatal(err)
	}
	// Sets the deadline to 100ms for the test.
	sidecars.StopTimeout = 100 * time.Millisecond

	owner := newFakeOwner("/projects/test")

	// The first Send to the fast sidecar launches that process. The start time is unrelated to property 1, so it is launched first and only recorded.
	started := time.Now()
	if err := sidecars.Send(owner, "@fixture/sidecar-fast", "s2", json.RawMessage(`{"data":"start"}`)); err != nil {
		t.Fatalf("fast start: %v", err)
	}
	t.Logf("the first fast send, which starts the process, took %v", time.Since(started))

	// Sends to the slow sidecar until the channel is full.
	// Each message is made large to fill the pipe buffer (64KB) quickly.
	largeBody := json.RawMessage(`{"data":"` + strings.Repeat("x", 20*1024) + `"}`)
	var lastErr error
	sentCount := 0
	for i := 0; i < 500; i++ { // At most 500 attempts
		err := sidecars.Send(owner, "@fixture/sidecar-slow", "s1", largeBody)
		if err != nil {
			lastErr = err
			if strings.Contains(err.Error(), "is not keeping up") {
				break // Confirmed that the channel is full
			}
			t.Fatalf("send %d: unexpected error: %v", i, err)
		}
		sentCount++
	}

	// Checks that the "is not keeping up" error was finally received.
	if lastErr == nil || !strings.Contains(lastErr.Error(), "is not keeping up") {
		t.Fatalf("after %d sends: want 'is not keeping up', got %v", sentCount, lastErr)
	}

	err = lastErr

	// Property 1: even when the channel of the slow sidecar is full, Send() to the fast sidecar does not block.
	// Send() only puts into the channel of the process that is already launched and returns immediately, so it must take less than 50ms.
	start := time.Now()

	// Sends to the fast sidecar (this is the ordinary case).
	if err := sidecars.Send(owner, "@fixture/sidecar-fast", "s2", json.RawMessage(`{"data":"test"}`)); err != nil {
		t.Fatalf("fast send: %v", err)
	}

	sendElapsed := time.Since(start)
	if sendElapsed > 50*time.Millisecond {
		t.Errorf("fast send took %v, want < 50ms", sendElapsed)
	}

	// Property 2: Stop() keeps StopTimeout (100ms).
	// Asserting with a deadline of 200ms clearly distinguishes it from the default of 5 seconds.
	// The earlier code measured send and stop together and asserted 110ms, which was
	// the unreasonable claim that "the OS kills and reaps the process in 10ms or less".
	start = time.Now()

	// Calls Stop().
	sidecars.Stop()

	stopElapsed := time.Since(start)
	if stopElapsed > 200*time.Millisecond {
		t.Errorf("Stop() took %v, want < 200ms (2 × StopTimeout)", stopElapsed)
	}
}

// TestStopGracefulShutdown verifies that, when the sidecar actually reads stdin, Stop() ends
// normally by stdin EOF. The measurement starts after the sidecar received the echo of Send, and it checks that the sidecar ends immediately without
// waiting until the deadline (1 second).
// contract: sidecars.stop.graceful-on-stdin-eof
func TestStopGracefulShutdown(t *testing.T) {
	directory := t.TempDir()

	// The sidecar: echoes the lines it received as they are and ends normally at stdin EOF.
	gracefulScript := "#!/bin/sh\nwhile read line; do echo \"$line\"; done\nexit 0\n"
	if err := os.WriteFile(filepath.Join(directory, "graceful"), []byte(gracefulScript), 0o755); err != nil {
		t.Fatal(err)
	}

	// Declares the sidecar.
	sidecars, err := host.NewSidecars(declare(directory, `{"executable":"graceful","protocol":1}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	// Stop() forces the end only after the deadline passes. If it returns before the deadline, the sidecar ended by itself at stdin EOF.
	// The deadline is set to stall, which is sufficiently longer than the process exit time on a loaded machine.
	sidecars.StopTimeout = stall

	owner := newFakeOwner("/projects/test")

	// Starts the sidecar.
	if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{"test":"data"}`)); err != nil {
		t.Fatalf("send: %v", err)
	}

	// Checks that the sidecar is actually reading stdin: waits for the echo event.
	// This keeps the start time of the shell process out of the measurement.
	if event := owner.next(t); event.Sidecar != echoSidecar || event.Surface != "s1" {
		t.Fatalf("echo event = %+v", event)
	}

	// Now measures the time of the Stop() call. It must end normally at stdin EOF.
	start := time.Now()
	sidecars.Stop()
	elapsed := time.Since(start)

	if elapsed >= sidecars.StopTimeout {
		t.Errorf("graceful stop took %v, which reached the %v deadline", elapsed, sidecars.StopTimeout)
	}
}

// TestCloseDuringStopSendsNothing verifies that a surface close and a window close after Stop ended the input and before the process ends send nothing.
// When the application ends, windows close together with Stop and call CloseOwner.
// contract: sidecars.stop.forgets-running-sidecars
func TestCloseDuringStopSendsNothing(t *testing.T) {
	directory := t.TempDir()
	// The sidecar: at start it opens ended and release for reading and writing. It echoes the lines it received, and when the input ends it writes one line to ended and
	// stays alive until one line arrives on release. The sidecar keeps both pipes open, so the line it wrote is not discarded and the opening side
	// does not block.
	ended := filepath.Join(directory, "ended")
	release := filepath.Join(directory, "release")
	for _, fifo := range []string{ended, release} {
		if err := syscall.Mkfifo(fifo, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	script := "#!/bin/sh\nexec 3<>" + release + " 4<>" + ended + "\nwhile read line; do echo \"$line\"; done\n" +
		"echo ended >&4\nread -r released <&3\nexit 0\n"
	if err := os.WriteFile(filepath.Join(directory, "lingering"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	// Writes one line to release so that no sidecar remains even if the check ends midway.
	var released sync.Once
	releaseSidecar := func() {
		released.Do(func() {
			fifo, err := os.OpenFile(release, os.O_RDWR, 0)
			if err != nil {
				t.Errorf("open release: %v", err)
				return
			}
			if _, err := fifo.Write([]byte("x\n")); err != nil {
				t.Errorf("write release: %v", err)
			}
			if err := fifo.Close(); err != nil {
				t.Errorf("close release: %v", err)
			}
		})
	}
	t.Cleanup(releaseSidecar)
	sidecars, err := host.NewSidecars(declare(directory, `{"executable":"lingering","protocol":1}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	sidecars.StopTimeout = stall
	owner := newFakeOwner("/projects/test")
	for _, surface := range []string{"s1", "s2"} {
		if err := sidecars.Send(owner, echoSidecar, surface, json.RawMessage(`{"test":"data"}`)); err != nil {
			t.Fatalf("send %s: %v", surface, err)
		}
		if event := owner.next(t); event.Surface != surface {
			t.Fatalf("echo event = %+v", event)
		}
	}

	stopped := make(chan struct{})
	go func() {
		sidecars.Stop()
		close(stopped)
	}()
	// When the sidecar writes to ended, Stop has ended the input and the process is still running.
	signal, err := os.Open(ended)
	if err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(signal).ReadString('\n')
	if closeErr := signal.Close(); closeErr != nil {
		t.Errorf("close ended: %v", closeErr)
	}
	if err != nil || line != "ended\n" {
		t.Fatalf("end of input signal = %q, %v", line, err)
	}
	sidecars.Close("s1")
	sidecars.CloseOwner(owner)
	if closing := sidecars.Closing(); len(closing) != 0 {
		t.Fatalf("closing during stop = %+v, want none", closing)
	}
	releaseSidecar()
	select {
	case <-stopped:
	case <-time.After(stall):
		t.Fatal("stop did not return after the sidecar ended")
	}
}

// TestStopClosesUnreadOutput verifies that a protocol failure while stopping is written to the log, the read end of the output that the host no longer reads is
// closed, and a sidecar that writes more than the pipe can hold afterward also ends without a forced termination. The output is
// the close reply of a surface that the host did not close. The exit of that process is not reported because it is caused by the closed pipe.
// contract: sidecars.stop.closes-unread-output
func TestStopClosesUnreadOutput(t *testing.T) {
	written := captureLog(t)
	directory := t.TempDir()
	script := "#!/bin/sh\nwhile read line; do echo \"$line\"; done\n" +
		"i=0\nwhile [ $i -lt 3000 ]; do echo '{\"surface\":\"s1\",\"closed\":true}'; i=$((i+1)); done\nexit 0\n"
	if err := os.WriteFile(filepath.Join(directory, "talkative"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	sidecars, err := host.NewSidecars(declare(directory, `{"executable":"talkative","protocol":1}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	// Stop forces the end only after the deadline passes. If it returns before the deadline, the sidecar wrote all its output and ended by itself.
	sidecars.StopTimeout = stall
	owner := newFakeOwner("/projects/test")
	if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{"test":"data"}`)); err != nil {
		t.Fatalf("send: %v", err)
	}
	if event := owner.next(t); event.Surface != "s1" {
		t.Fatalf("echo event = %+v", event)
	}
	start := time.Now()
	sidecars.Stop()
	if elapsed := time.Since(start); elapsed >= sidecars.StopTimeout {
		t.Errorf("stop took %v and reached the %v deadline: the host left the unread output open", elapsed, sidecars.StopTimeout)
	}
	logged := written()
	if want := "error host sidecar @fixture/sidecar-echo: failed: unexpected close answer for s1\n"; !strings.Contains(logged, want) {
		t.Errorf("log %q does not contain %q", logged, want)
	}
	if strings.Contains(logged, "exited while stopping") {
		t.Errorf("log %q reports the exit that the closed pipe caused", logged)
	}
}

// TestStopReadsOutputToItsEnd verifies that the host reads the output to the end while stopping. The sidecar answers the close it received before the stop
// only after the input ended, then writes more than the pipe can hold, and records finished only when all writes succeeded.
// This is the same order as the files sidecar answering the closed that a window close sent when the application ends.
// contract: sidecars.stop.reads-output-to-end
func TestStopReadsOutputToItsEnd(t *testing.T) {
	written := captureLog(t)
	script := "#!/bin/sh\nclosed=\nwhile read line; do case \"$line\" in *'\"closed\":true'*) closed=1;; *) echo \"$line\";; esac; done\n" +
		"[ -n \"$closed\" ] || exit 4\necho '{\"surface\":\"s1\",\"closed\":true}' || exit 5\n" +
		"i=0\nwhile [ $i -lt 3000 ]; do echo '{\"surface\":\"s1\",\"body\":\"late\"}' || exit 5; i=$((i+1)); done\n" +
		"echo finished > DIR/finished\nexit 0\n"
	sidecars, directory := scriptSidecars(t, script)
	sidecars.StopTimeout = stall
	owner := newFakeOwner("/projects/test")
	if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{"test":"data"}`)); err != nil {
		t.Fatalf("send: %v", err)
	}
	if event := owner.next(t); event.Surface != "s1" {
		t.Fatalf("echo event = %+v", event)
	}
	sidecars.Close("s1")
	start := time.Now()
	sidecars.Stop()
	if elapsed := time.Since(start); elapsed >= sidecars.StopTimeout {
		t.Errorf("stop took %v and reached the %v deadline", elapsed, sidecars.StopTimeout)
	}
	if data, err := os.ReadFile(filepath.Join(directory, "finished")); err != nil || string(data) != "finished\n" {
		t.Errorf("the sidecar did not complete its writes on its way out: finished = %q, %v", data, err)
	}
	if logged := written(); strings.Contains(logged, "error host ") {
		t.Errorf("stop logged an error: %q", logged)
	}
}

// TestStopReportsExitStatus verifies that, while stopping, a sidecar that ended with a non-zero exit status or a signal is written to the log in the same form on both
// hosts.
// contract: sidecars.stop.reports-exit-status
func TestStopReportsExitStatus(t *testing.T) {
	written := captureLog(t)
	for ending, want := range map[string]string{
		"exit 3":        "error host sidecar @fixture/sidecar-echo: exited while stopping: exit status 3\n",
		"kill -TERM $$": "error host sidecar @fixture/sidecar-echo: exited while stopping: signal 15\n",
	} {
		sidecars, _ := scriptSidecars(t, "#!/bin/sh\nwhile read line; do echo \"$line\"; done\n"+ending+"\n")
		sidecars.StopTimeout = stall
		owner := newFakeOwner("/projects/test")
		if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{"test":"data"}`)); err != nil {
			t.Fatalf("send: %v", err)
		}
		if event := owner.next(t); event.Surface != "s1" {
			t.Fatalf("echo event = %+v", event)
		}
		sidecars.Stop()
		if logged := written(); !strings.Contains(logged, want) {
			t.Errorf("%s: log %q does not contain %q", ending, logged, want)
		}
	}
}

// TestStopForcedKill verifies that a sidecar that does not end after the deadline is killed.
// contract: sidecars.stop.kills-after-timeout
func TestStopForcedKill(t *testing.T) {
	written := captureLog(t)
	directory := t.TempDir()

	// The sidecar: it does not read stdin, so it keeps running after stdin EOF. The stdin of a background command can become /dev/null depending on the shell and
	// end immediately, so it is not used.
	stubborn := "#!/bin/sh\nexec sleep 600\n"
	if err := os.WriteFile(filepath.Join(directory, "stubborn"), []byte(stubborn), 0o755); err != nil {
		t.Fatal(err)
	}

	// Declares the sidecar.
	sidecars, err := host.NewSidecars(declare(directory, `{"executable":"stubborn","protocol":1}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	// Sets the deadline to 100ms for the test.
	sidecars.StopTimeout = 100 * time.Millisecond

	owner := newFakeOwner("/projects/test")

	// Starts the sidecar.
	if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{"test":"data"}`)); err != nil {
		t.Fatalf("send: %v", err)
	}

	// Calls Stop(). It must be killed after the deadline.
	start := time.Now()
	sidecars.Stop()
	elapsed := time.Since(start)

	// Stop() kills after it waits for the deadline. If it returns before the deadline, it did not wait, and the upper bound catches only a hang.
	// The time until the process ends after the kill grows with the load, so success is not decided by the upper bound.
	if elapsed < sidecars.StopTimeout || elapsed > stall {
		t.Errorf("forced kill stop took %v, want at least the %v deadline", elapsed, sidecars.StopTimeout)
	}
	logged := written()
	if want := "error host sidecar @fixture/sidecar-echo: did not end within the stop timeout and was killed\n"; !strings.Contains(logged, want) {
		t.Errorf("log %q does not contain %q", logged, want)
	}
	if strings.Contains(logged, "exited while stopping") {
		t.Errorf("log %q reports the exit that the kill caused", logged)
	}
}

// contract: sidecars.close.keeps-other-sessions
func TestClosingASurfaceKeepsOtherSessions(t *testing.T) {
	sidecars, record := echoSidecars(t)
	owner := newFakeOwner("/projects/a")
	for _, surface := range []string{"s1", "state:files:p1"} {
		if err := sidecars.Send(owner, echoSidecar, surface, json.RawMessage(`{"operation":"open"}`)); err != nil {
			t.Fatal(err)
		}
	}
	sidecars.Close("s1")
	// Even after the project of the window left, a session that was not closed sends with the first root.
	owner.root = ""
	if err := sidecars.Send(owner, echoSidecar, "state:files:p1", json.RawMessage(`{"operation":"watch"}`)); err != nil {
		t.Fatal(err)
	}
	sidecars.Stop()
	requests, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"surface":"s1","root":"/projects/a","body":{"operation":"open"}}
{"surface":"state:files:p1","root":"/projects/a","body":{"operation":"open"}}
{"surface":"s1","root":"/projects/a","closed":true}
{"surface":"state:files:p1","root":"/projects/a","body":{"operation":"watch"}}
`
	if string(requests) != want {
		t.Fatalf("requests =\n%s\nwant\n%s", requests, want)
	}
}

// contract: sidecars.protocol.closed-surface-messages-are-discarded-and-unknown-ones-fail, sidecars.protocol.dropped-message-is-recorded
func TestClosedSurfaceMessagesAreDiscardedAndUnknownOnesFail(t *testing.T) {
	written := captureLog(t)
	sidecars, directory := scriptSidecars(t, "#!/bin/sh\necho $$ > DIR/pid\nread open1\nread open2\nread closed2\n"+
		"printf '%s\\n' '{\"surface\":\"s2\",\"body\":\"late\"}' '{\"surface\":\"s1\",\"body\":\"after\"}' '{\"surface\":\"ghost\",\"body\":\"x\"}'\nexec sleep 600\n")
	owner := newFakeOwner("/projects/a")
	for _, surface := range []string{"s1", "s2"} {
		if err := sidecars.Send(owner, echoSidecar, surface, json.RawMessage(`{"operation":"open"}`)); err != nil {
			t.Fatal(err)
		}
	}
	sidecars.Close("s2")
	// The late message of s2 is discarded, and the s1 message after it is the first event.
	if event := owner.next(t); event.Surface != "s1" || string(event.Body) != `"after"` {
		t.Fatalf("first event = %+v", event)
	}
	failure := owner.failure(t)
	if failure.Sidecar != echoSidecar || failure.Surface != "s1" || failure.Reason != "unknown surface ghost" {
		t.Fatalf("failure = %+v", failure)
	}
	requireEnded(t, processID(t, directory))
	// The discarded message of s2 is recorded with its body.
	if want := ` info host sidecar @fixture/sidecar-echo: message for surface s2 dropped: no window owns the surface: "late"`; !strings.Contains(written(), want) {
		t.Fatalf("the log has no %q:\n%s", want, written())
	}
}

// closingSnapshots is a channel that receives the value of closing every time closing changes.
func closingSnapshots(sidecars *host.Sidecars) chan []host.ClosingSurface {
	snapshots := make(chan []host.ClosingSurface, 64)
	sidecars.ClosingChanged = func() { snapshots <- sidecars.Closing() }
	return snapshots
}

// nextClosing receives the next closing value. If none arrives, the check fails.
func nextClosing(t *testing.T, snapshots chan []host.ClosingSurface) []host.ClosingSurface {
	t.Helper()
	select {
	case value := <-snapshots:
		return value
	case <-time.After(stall):
		t.Fatal("closing did not change")
		return nil
	}
}

// closingScript writes a sidecar executable in directory and builds its declaration.
func closingSidecars(t *testing.T, script string) *host.Sidecars {
	t.Helper()
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "closing"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	sidecars, err := host.NewSidecars(declare(directory, `{"executable":"closing","protocol":1}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sidecars.Stop)
	return sidecars
}

// contract: sidecars.close.answer-ends-closing
func TestClosedSurfaceStaysClosingUntilTheSidecarAnswers(t *testing.T) {
	// Returns the line it received as it is. Returning a closed line is the reply to closed.
	sidecars := closingSidecars(t, "#!/bin/sh\ntee /dev/null\n")
	snapshots := closingSnapshots(sidecars)
	owner := newFakeOwner("/projects/closing")
	if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{"data":1}`)); err != nil {
		t.Fatal(err)
	}
	sidecars.Close("s1")
	want := []host.ClosingSurface{{Sidecar: echoSidecar, Surface: "s1"}}
	if got := nextClosing(t, snapshots); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("closing after close = %v, want %v", got, want)
	}
	if got := nextClosing(t, snapshots); len(got) != 0 {
		t.Fatalf("closing after the answer = %v, want none", got)
	}
}

// contract: sidecars.close.failed-answer-is-logged
func TestFailedCloseAnswerIsLogged(t *testing.T) {
	script := "#!/bin/sh\nwhile read line; do case \"$line\" in *closed*) printf '{\"surface\":\"s1\",\"closed\":true,\"error\":\"busy\"}\\n';; *) echo \"$line\";; esac; done\n"
	sidecars := closingSidecars(t, script)
	snapshots := closingSnapshots(sidecars)
	written := captureLog(t)
	owner := newFakeOwner("/projects/closing")
	if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{"data":1}`)); err != nil {
		t.Fatal(err)
	}
	sidecars.Close("s1")
	nextClosing(t, snapshots)
	if got := nextClosing(t, snapshots); len(got) != 0 {
		t.Fatalf("closing after the failed answer = %v, want none", got)
	}
	if want := "error host sidecar @fixture/sidecar-echo: close s1: busy\n"; !strings.Contains(written(), want) {
		t.Fatalf("log %q does not contain %q", written(), want)
	}
}

// contract: sidecars.close.unexpected-answer-fails
func TestCloseAnswerForAnOpenSurfaceFailsTheSidecar(t *testing.T) {
	sidecars := closingSidecars(t, "#!/bin/sh\nread line\nprintf '{\"surface\":\"s1\",\"closed\":true}\\n'\nexec cat >/dev/null\n")
	owner := newFakeOwner("/projects/closing")
	if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{"data":1}`)); err != nil {
		t.Fatal(err)
	}
	select {
	case failure := <-owner.failures:
		if got := failure.(host.SidecarFailure).Reason; got != "unexpected close answer for s1" {
			t.Fatalf("failure reason = %q", got)
		}
	case <-time.After(stall):
		t.Fatal("the unexpected close answer did not fail the sidecar")
	}
}

// contract: sidecars.declaration.replaces-changed-folder
func TestDeclarationReplacesASidecarWhoseFolderChanged(t *testing.T) {
	// Each folder holds a sidecar that answers every request with the name of its folder.
	folder := func(name string) string {
		directory := filepath.Join(t.TempDir(), name)
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal(err)
		}
		script := "#!/bin/sh\nwhile read line; do printf '{\"surface\":\"s1\",\"body\":{\"from\":\"" + name + "\"}}\\n'; done\n"
		if err := os.WriteFile(filepath.Join(directory, "answer"), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
		return directory
	}
	data := `{"executable":"answer","protocol":1}`
	first, second := folder("first"), folder("second")
	sidecars, err := host.NewSidecars(declare(first, data), "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sidecars.Stop)
	owner := newFakeOwner("/projects/replace")
	if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{"data":1}`)); err != nil {
		t.Fatal(err)
	}
	if got := string(owner.next(t).Body); got != `{"from":"first"}` {
		t.Fatalf("the first answer = %s", got)
	}
	if err := sidecars.Declare(declare(second, data)); err != nil {
		t.Fatal(err)
	}
	if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{"data":2}`)); err != nil {
		t.Fatal(err)
	}
	if got := string(owner.next(t).Body); got != `{"from":"second"}` {
		t.Fatalf("the answer after the folder changed = %s, want the sidecar of the new folder", got)
	}
	select {
	case failure := <-owner.failures:
		t.Fatalf("replacing the sidecar reported a failure: %v", failure)
	default:
	}
}

// contract: sidecars.close.repeated-close-awaits-each-answer
func TestRepeatedCloseAwaitsEachAnswer(t *testing.T) {
	// The sidecar echoes requests and answers both closes of s1 after it has received the second one.
	script := "#!/bin/sh\nn=0\nwhile read line; do case \"$line\" in *closed*) n=$((n+1)); if [ $n -eq 2 ]; then " +
		"printf '{\"surface\":\"s1\",\"closed\":true}\\n{\"surface\":\"s1\",\"closed\":true}\\n'; fi;; *) echo \"$line\";; esac; done\n"
	sidecars := closingSidecars(t, script)
	snapshots := closingSnapshots(sidecars)
	var written strings.Builder
	var mu sync.Mutex
	log.SetOutput(writerFunc(func(p []byte) (int, error) {
		mu.Lock()
		defer mu.Unlock()
		return written.Write(p)
	}))
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	owner := newFakeOwner("/projects/closing")
	for round := 0; round < 2; round++ {
		if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{"data":1}`)); err != nil {
			t.Fatal(err)
		}
		owner.next(t)
		sidecars.Close("s1")
		nextClosing(t, snapshots)
	}
	for len(nextClosing(t, snapshots)) != 0 {
	}
	// The echo of a later request follows both answers in the output, so a failure of either answer arrives first.
	if err := sidecars.Send(owner, echoSidecar, "s2", json.RawMessage(`{"data":2}`)); err != nil {
		t.Fatal(err)
	}
	owner.next(t)
	mu.Lock()
	defer mu.Unlock()
	if strings.Contains(written.String(), "failed") {
		t.Fatalf("the second answer of a repeated close failed the sidecar: %q", written.String())
	}
}

// contract: sidecars.close.process-end-clears-closing
func TestEndedSidecarLeavesNoClosingSurface(t *testing.T) {
	// Replies to the first request, and when it receives closed, it ends without a reply.
	sidecars := closingSidecars(t, "#!/bin/sh\nread line\necho \"$line\"\nread line\nexit 0\n")
	snapshots := closingSnapshots(sidecars)
	owner := newFakeOwner("/projects/closing")
	if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{"data":1}`)); err != nil {
		t.Fatal(err)
	}
	sidecars.Close("s1")
	if got := nextClosing(t, snapshots); len(got) != 1 {
		t.Fatalf("closing after close = %v, want s1", got)
	}
	if got := nextClosing(t, snapshots); len(got) != 0 {
		t.Fatalf("closing after the sidecar ended = %v, want none", got)
	}
}

// captureLog attaches a writer of events to the records of the host until the test ends and returns a function that gives
// the records written so far, one line each in the text form `<time> <level> <layer> <where>: <text>`.
func captureLog(t *testing.T) func() string {
	log := useEventLog(t)
	return func() string {
		if err := log.Flush(5 * time.Second); err != nil {
			t.Fatal(err)
		}
		return support.TextOf(readEventLog(t, log.Path()))
	}
}

// writerFunc uses a function as an io.Writer.
type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

// A sidecar of standard input and output may write any text to its standard error: the host writes each line as a
// record of level info, layer sidecar and the name of the sidecar, and the last text without a line feed too.
// contract: sidecars.stderr.lines-are-written-as-records
func TestTheStandardErrorOfASidecarIsWrittenAsRecords(t *testing.T) {
	written := captureLog(t)
	script := "#!/bin/sh\necho 'first line' >&2\nprintf 'no line feed' >&2\nwhile read line; do echo \"$line\"; done\n"
	sidecars, _ := scriptSidecars(t, script)
	sidecars.StopTimeout = stall
	owner := newFakeOwner("/projects/test")
	if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{"test":"data"}`)); err != nil {
		t.Fatalf("send: %v", err)
	}
	if event := owner.next(t); event.Surface != "s1" {
		t.Fatalf("echo event = %+v", event)
	}
	sidecars.Stop()
	logged := written()
	for _, want := range []string{" info sidecar @fixture/sidecar-echo: first line\n", " info sidecar @fixture/sidecar-echo: no line feed\n"} {
		if !strings.Contains(logged, want) {
			t.Errorf("log %q does not contain %q", logged, want)
		}
	}
}

// Every request that the host sends to a sidecar and every message that it receives is a trace event with its whole body,
// in the order of the relay (docs/spec/diagnostics.md).
// contract: sidecars.trace.relay-records-every-message-with-its-body
func TestTheRelayRecordsEveryMessageWithItsWholeBody(t *testing.T) {
	script := "#!/bin/sh\nread request\necho '{\"surface\":\"s1\",\"body\":{\"event\":\"state\",\"text\":\"\\ud55c\"}}'\nwhile read line; do :; done\n"
	sidecars, directory := scriptSidecars(t, script)
	sidecars.StopTimeout = stall
	log := useEventLog(t)
	_ = directory
	if _, err := host.PerformanceCommand(map[string]any{"action": "on"}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = host.PerformanceCommand(map[string]any{"action": "off"}) })
	owner := newFakeOwner("/projects/test")
	if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{"operation":"input","bytes":"7ZWc"}`)); err != nil {
		t.Fatalf("send: %v", err)
	}
	if event := owner.next(t); event.Surface != "s1" {
		t.Fatalf("event = %+v", event)
	}
	sidecars.Stop()
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var sent, received map[string]any
	for _, record := range readEventLog(t, log.Path()) {
		switch record["event"] {
		case "host.trace.sidecar.send":
			sent = record
		case "host.trace.sidecar.receive":
			received = record
		}
	}
	if sent == nil || sent["layer"] != "host" || sent["fields"].(map[string]any)["sidecar"] != echoSidecar || sent["fields"].(map[string]any)["surface"] != "s1" {
		t.Fatalf("the request was not recorded: %v", sent)
	}
	if body, _ := sent["fields"].(map[string]any)["body"].(map[string]any); body["operation"] != "input" || body["bytes"] != "7ZWc" {
		t.Fatalf("the request body was not recorded whole: %v", sent["fields"])
	}
	if received == nil || received["fields"].(map[string]any)["surface"] != "s1" {
		t.Fatalf("the message was not recorded: %v", received)
	}
	if body, _ := received["fields"].(map[string]any)["body"].(map[string]any); body["event"] != "state" || body["text"] != "한" {
		t.Fatalf("the message body was not recorded whole: %v", received["fields"])
	}
}

// contract: sidecars.protocol.request-with-cids-is-recorded
func TestSidecarRequestWithCorrelationIdentifiersIsRecordedAsAnEvent(t *testing.T) {
	config := t.TempDir()
	log := support.StartWriter(t, config)
	sidecars, _ := echoSidecars(t)
	owner := newFakeOwner("/projects/a")
	body := json.RawMessage(`{"operation":"input"}`)
	if err := sidecars.SendWithCids(owner, echoSidecar, "s1", body, []string{"b1.7", "b1.8"}); err != nil {
		t.Fatal(err)
	}
	if err := sidecars.Send(owner, echoSidecar, "s1", body); err != nil {
		t.Fatal(err)
	}
	owner.next(t)
	owner.next(t)
	sidecars.Stop()
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var requests []map[string]any
	for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		if event["event"] == "host.sidecar.request" {
			requests = append(requests, event)
		}
	}
	if len(requests) != 1 {
		t.Fatalf("a request with identifiers and one without stored %d requests, want 1: %v", len(requests), requests)
	}
	request := requests[0]
	cids, ok := request["cids"].([]any)
	fields := request["fields"].(map[string]any)
	if request["level"] != "info" || !ok || len(cids) != 2 || cids[0] != "b1.7" || cids[1] != "b1.8" ||
		fields["name"] != echoSidecar || fields["surface"] != "s1" || fields["bytes"] != float64(len(body)) {
		t.Fatalf("the request record: %v", request)
	}
}

// sidecarReplies flushes the writer and returns the events `host.sidecar.reply` that it stored.
func sidecarReplies(t *testing.T, log *host.EventLog, config string) []map[string]any {
	t.Helper()
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var replies []map[string]any
	for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		if event["event"] == "host.sidecar.reply" {
			replies = append(replies, event)
		}
	}
	return replies
}

const replyScript = `#!/bin/sh
read a
printf '%s\n' '{"surface":"s1","cids":["b1.7","b1.8"],"body":{"id":1,"error":"unsupported operation"}}'
read b
printf '%s\n' '{"surface":"s1","cids":["b1.9"],"body":{"id":2,"ok":true}}'
read c
printf '%s\n' '{"surface":"s1","body":{"id":3,"error":{"reason":"no request"}}}'
printf '%s\n' '{"surface":"s1","body":{"event":"state"}}'
cat >/dev/null
`

// contract: sidecars.protocol.reply-with-cids-is-recorded
func TestAReplyOfASidecarIsRecordedWithTheIdentifiersOfItsRequest(t *testing.T) {
	config := t.TempDir()
	log := support.StartWriter(t, config)
	sidecars, _ := scriptSidecars(t, replyScript)
	owner := newFakeOwner("/projects/a")
	body := json.RawMessage(`{"operation":"input"}`)
	if err := sidecars.SendWithCids(owner, echoSidecar, "s1", body, []string{"b1.7", "b1.8"}); err != nil {
		t.Fatal(err)
	}
	owner.next(t)
	if err := sidecars.SendWithCids(owner, echoSidecar, "s1", body, []string{"b1.9"}); err != nil {
		t.Fatal(err)
	}
	owner.next(t)
	if err := sidecars.Send(owner, echoSidecar, "s1", body); err != nil {
		t.Fatal(err)
	}
	owner.next(t)
	owner.next(t)
	replies := sidecarReplies(t, log, config)
	if len(replies) != 3 {
		t.Fatalf("%d events host.sidecar.reply, want 3 (an error with identifiers, an answer with identifiers, an error without): %v", len(replies), replies)
	}
	want := []struct {
		level, error string
		ok           bool
		cids         []any
		micros       bool
	}{
		{"warn", "-32603: unsupported operation", false, []any{"b1.7", "b1.8"}, true},
		{"info", "", true, []any{"b1.9"}, true},
		{"warn", `-32603: {"reason":"no request"}`, false, nil, false},
	}
	for i, w := range want {
		fields := replies[i]["fields"].(map[string]any)
		cids, _ := replies[i]["cids"].([]any)
		_, hasMicros := fields["micros"]
		errorText, _ := fields["error"].(string)
		if replies[i]["level"] != w.level || fields["name"] != echoSidecar || fields["surface"] != "s1" || fields["ok"] != w.ok ||
			errorText != w.error || fmt.Sprint(cids) != fmt.Sprint(w.cids) || hasMicros != w.micros {
			t.Fatalf("reply %d is %v, want level %s ok %v error %q cids %v micros %v", i, replies[i], w.level, w.ok, w.error, w.cids, w.micros)
		}
		if hasMicros && fields["micros"].(float64) < 0 {
			t.Fatalf("reply %d has micros %v", i, fields["micros"])
		}
	}
}

// contract: sidecars.protocol.failure-fails-the-pending-requests
func TestTheFailureOfASidecarIsTheFailedReplyOfItsPendingRequests(t *testing.T) {
	config := t.TempDir()
	log := support.StartWriter(t, config)
	sidecars, _ := scriptSidecars(t, "#!/bin/sh\nread first\nread second\nexit 3\n")
	owner := newFakeOwner("/projects/a")
	body := json.RawMessage(`{"operation":"input"}`)
	if err := sidecars.SendWithCids(owner, echoSidecar, "s1", body, []string{"b1.7"}); err != nil {
		t.Fatal(err)
	}
	if err := sidecars.SendWithCids(owner, echoSidecar, "s1", body, []string{"b1.8"}); err != nil {
		t.Fatal(err)
	}
	failure := owner.failure(t)
	replies := sidecarReplies(t, log, config)
	if len(replies) != 1 {
		t.Fatalf("%d events host.sidecar.reply, want 1: %v", len(replies), replies)
	}
	fields := replies[0]["fields"].(map[string]any)
	cids, _ := replies[0]["cids"].([]any)
	if replies[0]["level"] != "warn" || fields["ok"] != false || fields["error"] != "-32603: "+failure.Reason || fields["surface"] != "s1" ||
		fields["bytes"] != float64(0) || fmt.Sprint(cids) != "[b1.7 b1.8]" {
		t.Fatalf("reply %v, failure %+v", replies[0], failure)
	}
}

// contract: sidecars.lifetime.start-and-exit-events
func TestSidecarLifetimeIsRecordedAsEvents(t *testing.T) {
	config := t.TempDir()
	log := support.StartWriter(t, config)
	// The first process ends by itself with a status; the second ends when the host stops it.
	sidecars, _ := scriptSidecars(t, "#!/bin/sh\nif [ ! -f DIR/ran ]; then touch DIR/ran; read first; exit 3; fi\ncat >/dev/null\n")
	owner := newFakeOwner("/projects/a")
	if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	owner.failure(t)
	if err := sidecars.Send(owner, echoSidecar, "s2", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	sidecars.Stop()
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var seen []string
	pids := map[string]bool{}
	for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		name, _ := event["event"].(string)
		if name != "host.sidecar.start" && name != "host.sidecar.exit" {
			continue
		}
		fields := event["fields"].(map[string]any)
		if fields["name"] != echoSidecar {
			t.Fatalf("%s fields = %v", name, fields)
		}
		pid, ok := fields["pid"].(float64)
		if !ok || pid <= 0 {
			t.Fatalf("%s pid = %v", name, fields["pid"])
		}
		pids[fmt.Sprint(pid)] = true
		status, _ := fields["status"].(string)
		seen = append(seen, name+" "+status)
	}
	want := []string{"host.sidecar.start ", "host.sidecar.exit exit status 3", "host.sidecar.start ", "host.sidecar.exit exit status 0"}
	if strings.Join(seen, "|") != strings.Join(want, "|") || len(pids) != 2 {
		t.Fatalf("lifetime events = %q (%d processes), want %q (2 processes)", seen, len(pids), want)
	}
}

// contract: performance.sampler.names-the-sidecar-processes
func TestTheSamplerNamesARunningSidecarUntilItEnds(t *testing.T) {
	config := t.TempDir()
	log := support.StartWriter(t, config)
	t.Cleanup(func() { _, _ = host.PerformanceCommand(map[string]any{"action": "off"}) })
	if _, err := host.PerformanceCommand(map[string]any{"action": "on"}); err != nil {
		t.Fatal(err)
	}
	samples := func(named bool) int {
		if err := log.Flush(5 * time.Second); err != nil {
			t.Fatal(err)
		}
		count := 0
		for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
			if event["event"] != "host.sampler.memory" {
				continue
			}
			if _, has := event["fields"].(map[string]any)["name"]; has == named {
				count++
			}
		}
		return count
	}
	// The sampler stores a first sample of the host when it starts; wait for it so that it does not run among the samples below.
	for deadline := time.Now().Add(5 * time.Second); samples(false) == 0; {
		if time.Now().After(deadline) {
			t.Fatal("the sampler stored no sample of the host")
		}
		time.Sleep(10 * time.Millisecond)
	}
	sidecars, _ := scriptSidecars(t, "#!/bin/sh\ncat >/dev/null\n")
	owner := newFakeOwner("/projects/a")
	if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	host.PerformanceSample()
	// The periodic sampler of the trace runs besides the two samples of this test, so under load a further sample can fall while the
	// sidecar runs. The order of the records states the contract: a sample names the sidecar while it runs, and none names it after
	// its exit record.
	if got := samples(true); got < 1 {
		t.Fatalf("a running sidecar was named by %d samples, want at least 1", got)
	}
	sidecars.Stop()
	host.PerformanceSample()
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	exit, named := -1, []int{}
	for index, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		fields, _ := event["fields"].(map[string]any)
		if event["event"] == "host.sidecar.exit" && fields["name"] == echoSidecar {
			exit = index
		}
		if event["event"] == "host.sampler.memory" && fields["name"] == echoSidecar {
			named = append(named, index)
		}
	}
	if exit < 0 || len(named) == 0 {
		t.Fatalf("the sidecar has an exit record at %d and %d samples that name it", exit, len(named))
	}
	for _, index := range named {
		if index > exit {
			t.Fatalf("a sample names the sidecar after it ended: samples at %v, exit at %d", named, exit)
		}
	}
}

// contract: sidecars.protocol.request-line-carries-cids
func TestSidecarRequestCarriesTheCorrelationIdentifiers(t *testing.T) {
	sidecars, record := echoSidecars(t)
	owner := newFakeOwner("/projects/a")
	if err := sidecars.SendWithCids(owner, echoSidecar, "s1", json.RawMessage(`{"operation":"input"}`), []string{"b1.7", "b1.8"}); err != nil {
		t.Fatal(err)
	}
	if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{"operation":"input"}`)); err != nil {
		t.Fatal(err)
	}
	owner.next(t)
	owner.next(t)
	sidecars.Stop()
	requests, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"surface":"s1","root":"/projects/a","cids":["b1.7","b1.8"],"body":{"operation":"input"}}
{"surface":"s1","root":"/projects/a","body":{"operation":"input"}}
`
	if string(requests) != want {
		t.Fatalf("requests =\n%s\nwant\n%s", requests, want)
	}
}
