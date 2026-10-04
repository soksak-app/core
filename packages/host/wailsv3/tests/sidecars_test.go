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
)

const echoSidecar = "@fixture/sidecar-echo"

// stall 은 멈춘 검사를 끝내는 상한이다. 성공은 받은 event 와 끝난 process 로 판정하며 이 시간으로 판정하지 않는다.
// 부하가 큰 기계에서도 sidecar 의 답과 종료는 이 안에 온다.
const stall = 120 * time.Second

// declare 는 directory 에 설치된 사이드카 하나의 선언이다.
func declare(directory, sidecar string) []host.SidecarDeclaration {
	return []host.SidecarDeclaration{{Name: echoSidecar, Folder: directory, Data: []byte(sidecar)}}
}

// fakeOwner 는 받은 사이드카 이벤트와 실패 이벤트를 기록하는 창이다.
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

// sidecarFailure 는 sidecar-failure 이벤트 값의 JSON 형태다(docs/spec/sidecars.md#failure).
type sidecarFailure struct {
	Sidecar string `json:"sidecar"`
	Surface string `json:"surface"`
	Reason  string `json:"reason"`
}

// failure 는 다음 실패 이벤트를 기다려 JSON 형태로 반환한다.
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

// messageLimit 은 사이드카 메시지 한 줄의 줄바꿈 앞 최대 크기다(docs/spec/sidecars.md#messages).
const messageLimit = 64 << 20

// scriptSidecars 는 script 를 실행하는 fake 사이드카를 선언한 채널과 그 디렉터리를 만든다.
// script 안의 DIR 은 그 디렉터리로 바뀐다.
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
	// 검사가 실패해도 fake 사이드카 프로세스를 남기지 않는다.
	t.Cleanup(sidecars.Stop)
	return sidecars, directory
}

// paddedMessageScript 는 요청 하나를 읽은 뒤 줄바꿈 앞이 size byte 인 s1 메시지를 보내고 then 을 실행하는 스크립트다.
// 본문은 문자열 하나이고 셸 파이프라인이 쓰므로 스크립트 프로세스는 쓰기가 끝날 때까지 기다린다.
func paddedMessageScript(size int, then string) (string, int) {
	prefix, suffix := `{"surface":"s1","body":"`, `"}`
	padding := size - len(prefix) - len(suffix)
	return fmt.Sprintf("#!/bin/sh\necho $$ > DIR/pid\nread request\nprintf '%%s' '%s'\nhead -c %d /dev/zero | tr '\\0' x\nprintf '%%s\\n' '%s'\n%s\n",
		prefix, padding, suffix, then), padding
}

// processID 는 fake 사이드카가 기록한 프로세스 id 다.
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

// requireEnded 는 프로세스 pid 가 끝나고 회수되었는지 검사한다.
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
		if failure.Sidecar != echoSidecar || failure.Surface != surface || !strings.Contains(failure.Reason, "output closed") {
			t.Fatalf("%s: failure = %+v", surface, failure)
		}
	}
	// 실패 뒤의 전송은 새 프로세스를 시작한다.
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

// echoSidecars 는 받은 줄을 그대로 출력하는 fake 사이드카를 선언한 채널을 만든다.
// 요청의 surface 와 body 가 그대로 이벤트로 돌아오고, 요청 기록 파일에 모든 요청이 남는다.
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
	// Stop 은 stdin 을 닫고 echo 가 남은 줄을 기록하고 끝나기를 기다린다. 기한이 짧으면 부하 속에서 기록 전에
	// 강제로 끝내므로 기한을 stall 로 둔다. echo 는 EOF 에 곧 끝나므로 검사가 느려지지 않는다.
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
	// 같은 창이 다른 프로젝트로 바뀐 뒤에도 이미 열린 표면은 처음 root 로 보낸다.
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
	// filepath.Join 은 "." 를 지우므로 문자열로 이어 정규화되지 않은 경로를 만든다.
	configDirectory := t.TempDir()
	sidecars, err := host.NewSidecars(declare(t.TempDir(), `{"executable":"echo","protocol":1,"transport":"persistent"}`), configDirectory+string(os.PathSeparator)+".")
	if err != nil {
		t.Fatalf("non-canonical config directory was rejected: %v", err)
	}
	// 실행 파일이 없으므로 서비스 시작에서 실패하고, 그 전에 서비스 디렉터리를 설정 디렉터리 아래에 만든다.
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
	// 느린 사이드카는 stdin 을 읽지 않고, 다른 사이드카는 정상적으로 동작한다.
	// 느린 사이드카에 257번 보내면 256번째는 성공하고 257번째는 "is not keeping up" 오류로 실패한다.
	// 이 테스트는 두 가지 성질을 확인한다:
	// 1. 느린 사이드카 채널이 가득 찼을 때도, 빠른 사이드카로의 Send() 는 블로킹되지 않는다.
	// 2. Stop() 이 StopTimeout 을 지키고 있다.

	directory := t.TempDir()

	// 느린 사이드카: stdin 을 읽지 않지만 stdin EOF에 정상 종료한다.
	slowScript := "#!/bin/sh\nexec cat >/dev/null\n"
	if err := os.WriteFile(filepath.Join(directory, "slow"), []byte(slowScript), 0o755); err != nil {
		t.Fatal(err)
	}

	// 빠른 사이드카: 받은 줄을 그대로 출력한다.
	fastScript := "#!/bin/sh\ntee /dev/null\n"
	if err := os.WriteFile(filepath.Join(directory, "fast"), []byte(fastScript), 0o755); err != nil {
		t.Fatal(err)
	}

	// 두 사이드카를 선언한다.
	sidecars, err := host.NewSidecars([]host.SidecarDeclaration{
		{Name: "@fixture/sidecar-slow", Folder: directory, Data: []byte(`{"executable":"slow","protocol":1}`)},
		{Name: "@fixture/sidecar-fast", Folder: directory, Data: []byte(`{"executable":"fast","protocol":1}`)},
	}, directory)
	if err != nil {
		t.Fatal(err)
	}
	// 테스트를 위해 기한을 100ms로 설정한다.
	sidecars.StopTimeout = 100 * time.Millisecond

	owner := newFakeOwner("/projects/test")

	// 빠른 사이드카의 첫 Send 는 그 프로세스를 띄운다. 기동 시간은 성질 1 과 무관하므로 먼저 띄우고 기록만 한다.
	started := time.Now()
	if err := sidecars.Send(owner, "@fixture/sidecar-fast", "s2", json.RawMessage(`{"data":"start"}`)); err != nil {
		t.Fatalf("fast start: %v", err)
	}
	t.Logf("the first fast send, which starts the process, took %v", time.Since(started))

	// 느린 사이드카에 채널이 가득 찰 때까지 보낸다.
	// 파이프 버퍼(64KB)를 빠르게 채우기 위해 각 메시지를 크게 만든다.
	largeBody := json.RawMessage(`{"data":"` + strings.Repeat("x", 20*1024) + `"}`)
	var lastErr error
	sentCount := 0
	for i := 0; i < 500; i++ { // 최대 500번 시도
		err := sidecars.Send(owner, "@fixture/sidecar-slow", "s1", largeBody)
		if err != nil {
			lastErr = err
			if strings.Contains(err.Error(), "is not keeping up") {
				break // 채널이 가득 찬 것을 확인했다
			}
			t.Fatalf("send %d: unexpected error: %v", i, err)
		}
		sentCount++
	}

	// 마침내 "is not keeping up" 오류를 받았는지 확인한다.
	if lastErr == nil || !strings.Contains(lastErr.Error(), "is not keeping up") {
		t.Fatalf("after %d sends: want 'is not keeping up', got %v", sentCount, lastErr)
	}

	err = lastErr

	// 성질 1: 느린 사이드카 채널이 가득 찼을 때도 빠른 사이드카 Send() 는 블로킹되지 않는다.
	// Send() 는 이미 띄운 프로세스의 채널에 넣고 즉시 돌아올 뿐이므로 50ms 미만이어야 한다.
	start := time.Now()

	// 빠른 사이드카로 보낸다 (이것이 일반적인 경우다).
	if err := sidecars.Send(owner, "@fixture/sidecar-fast", "s2", json.RawMessage(`{"data":"test"}`)); err != nil {
		t.Fatalf("fast send: %v", err)
	}

	sendElapsed := time.Since(start)
	if sendElapsed > 50*time.Millisecond {
		t.Errorf("fast send took %v, want < 50ms", sendElapsed)
	}

	// 성질 2: Stop() 이 StopTimeout(100ms) 을 지키고 있다.
	// 200ms 기한으로 단언하면, 기본 5초와 명확히 구별된다.
	// 이전 코드는 send 와 stop 을 함께 재서 110ms 단언했는데, 이는
	// "OS 가 프로세스를 죽이고 수거하는 데 10ms 이하" 라는 불합리한 주장이었다.
	start = time.Now()

	// Stop() 호출.
	sidecars.Stop()

	stopElapsed := time.Since(start)
	if stopElapsed > 200*time.Millisecond {
		t.Errorf("Stop() took %v, want < 200ms (2 × StopTimeout)", stopElapsed)
	}
}

// TestStopGracefulShutdown 은 사이드카가 실제로 stdin 을 읽고 있을 때 Stop() 이 stdin EOF 에 의해
// 정상 종료되는지 검증한다. 측정은 사이드카가 Send 의 에코를 받은 뒤 시작해서, 기한(1초)까지
// 기다리지 않고 즉시 종료되는지 확인한다.
// contract: sidecars.stop.graceful-on-stdin-eof
func TestStopGracefulShutdown(t *testing.T) {
	directory := t.TempDir()

	// 사이드카: 받은 줄을 그대로 에코하고 stdin EOF 에 정상 종료한다.
	gracefulScript := "#!/bin/sh\nwhile read line; do echo \"$line\"; done\nexit 0\n"
	if err := os.WriteFile(filepath.Join(directory, "graceful"), []byte(gracefulScript), 0o755); err != nil {
		t.Fatal(err)
	}

	// 사이드카를 선언한다.
	sidecars, err := host.NewSidecars(declare(directory, `{"executable":"graceful","protocol":1}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	// Stop() 은 기한이 지나야만 강제로 끝낸다. 기한보다 먼저 돌아오면 사이드카가 stdin EOF 로 스스로 끝난 것이다.
	// 기한은 기계 부하 속의 프로세스 종료 시간보다 충분히 길게 stall 로 둔다.
	sidecars.StopTimeout = stall

	owner := newFakeOwner("/projects/test")

	// 사이드카를 시작한다.
	if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{"test":"data"}`)); err != nil {
		t.Fatalf("send: %v", err)
	}

	// 사이드카가 실제로 stdin 을 읽고 있음을 확인한다: 에코 이벤트를 기다린다.
	// 이렇게 하면 shell 프로세스 기동 시간이 측정에 포함되지 않는다.
	if event := owner.next(t); event.Sidecar != echoSidecar || event.Surface != "s1" {
		t.Fatalf("echo event = %+v", event)
	}

	// 이제 Stop() 호출을 시간 측정한다. stdin EOF 에 정상 종료되어야 한다.
	start := time.Now()
	sidecars.Stop()
	elapsed := time.Since(start)

	if elapsed >= sidecars.StopTimeout {
		t.Errorf("graceful stop took %v, which reached the %v deadline", elapsed, sidecars.StopTimeout)
	}
}

// TestCloseDuringStopSendsNothing 은 Stop 이 입력을 끝낸 뒤 프로세스가 끝나기 전의 표면 닫기와 창 닫기가 아무것도
// 보내지 않는지 검증한다. 애플리케이션이 끝날 때 Stop 과 함께 창이 닫히며 CloseOwner 를 부른다.
// contract: sidecars.stop.forgets-running-sidecars
func TestCloseDuringStopSendsNothing(t *testing.T) {
	directory := t.TempDir()
	// 사이드카: 시작할 때 ended 와 release 를 읽고 쓰기로 열어 둔다. 받은 줄을 에코하고, 입력이 끝나면 ended 에 한 줄을
	// 쓰고 release 에 한 줄이 올 때까지 살아 있다. 사이드카가 두 파이프를 열어 두므로 쓴 줄은 버려지지 않고 여는 쪽은
	// 막히지 않는다.
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
	// 검사가 도중에 끝나도 사이드카가 남지 않게 release 에 한 줄을 쓴다.
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
	// 사이드카가 ended 에 쓰면 Stop 은 입력을 끝냈고 프로세스는 아직 실행 중이다.
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

// TestStopClosesUnreadOutput 은 멈추는 동안 호스트가 더 읽지 않는 출력의 읽기 끝을 닫아, 끝나면서 파이프가 담는
// 것보다 많이 쓰는 사이드카도 강제 종료 없이 끝나는지 검증한다. 출력은 호스트가 기다리지 않는 닫기 응답이다.
// contract: sidecars.stop.closes-unread-output
func TestStopClosesUnreadOutput(t *testing.T) {
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
	// Stop 은 기한이 지나야만 강제로 끝낸다. 기한보다 먼저 돌아오면 사이드카가 출력을 다 쓰고 스스로 끝난 것이다.
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
}

// TestStopForcedKill 은 기한을 초과해도 종료하지 않는 사이드카를 kill 하는지 검증한다.
// contract: sidecars.stop.kills-after-timeout
func TestStopForcedKill(t *testing.T) {
	directory := t.TempDir()

	// 사이드카: stdin EOF 를 무시하고 계속 실행한다.
	stubborn := "#!/bin/sh\ncat >/dev/null &\nwait\n"
	if err := os.WriteFile(filepath.Join(directory, "stubborn"), []byte(stubborn), 0o755); err != nil {
		t.Fatal(err)
	}

	// 사이드카를 선언한다.
	sidecars, err := host.NewSidecars(declare(directory, `{"executable":"stubborn","protocol":1}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	// 테스트를 위해 기한을 100ms로 설정한다.
	sidecars.StopTimeout = 100 * time.Millisecond

	owner := newFakeOwner("/projects/test")

	// 사이드카를 시작한다.
	if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{"test":"data"}`)); err != nil {
		t.Fatalf("send: %v", err)
	}

	// Stop() 호출. 기한 후 kill 되어야 한다.
	start := time.Now()
	sidecars.Stop()
	elapsed := time.Since(start)

	// Stop() 은 기한까지 기다린 뒤 kill 한다. 기한보다 먼저 돌아오면 기다리지 않은 것이고, 상한은 멈춤만 잡는다.
	// kill 뒤 process 가 끝나는 시간은 부하에 따라 늘어나므로 상한으로 성공을 판정하지 않는다.
	if elapsed < sidecars.StopTimeout || elapsed > stall {
		t.Errorf("forced kill stop took %v, want at least the %v deadline", elapsed, sidecars.StopTimeout)
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
	// 창의 프로젝트가 빠진 뒤에도 닫히지 않은 세션은 처음 root 로 보낸다.
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

// contract: sidecars.protocol.closed-surface-messages-are-discarded-and-unknown-ones-fail
func TestClosedSurfaceMessagesAreDiscardedAndUnknownOnesFail(t *testing.T) {
	sidecars, directory := scriptSidecars(t, "#!/bin/sh\necho $$ > DIR/pid\nread open1\nread open2\nread closed2\n"+
		"printf '%s\\n' '{\"surface\":\"s2\",\"body\":\"late\"}' '{\"surface\":\"s1\",\"body\":\"after\"}' '{\"surface\":\"ghost\",\"body\":\"x\"}'\nexec sleep 600\n")
	owner := newFakeOwner("/projects/a")
	for _, surface := range []string{"s1", "s2"} {
		if err := sidecars.Send(owner, echoSidecar, surface, json.RawMessage(`{"operation":"open"}`)); err != nil {
			t.Fatal(err)
		}
	}
	sidecars.Close("s2")
	// s2 의 늦은 메시지는 버려지고, 그 뒤의 s1 메시지가 첫 이벤트다.
	if event := owner.next(t); event.Surface != "s1" || string(event.Body) != `"after"` {
		t.Fatalf("first event = %+v", event)
	}
	failure := owner.failure(t)
	if failure.Sidecar != echoSidecar || failure.Surface != "s1" || failure.Reason != "unknown surface ghost" {
		t.Fatalf("failure = %+v", failure)
	}
	requireEnded(t, processID(t, directory))
}

// closingSnapshots 는 closing 이 바뀔 때마다 그 값을 받는 채널이다.
func closingSnapshots(sidecars *host.Sidecars) chan []host.ClosingSurface {
	snapshots := make(chan []host.ClosingSurface, 64)
	sidecars.ClosingChanged = func() { snapshots <- sidecars.Closing() }
	return snapshots
}

// nextClosing 은 다음 closing 값을 받는다. 오지 않으면 검사가 실패한다.
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

// closingScript 는 sidecar 실행 파일을 directory 에 쓰고 그 선언을 만든다.
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
	// 받은 줄을 그대로 돌려준다. closed 줄을 돌려주면 그것이 closed 의 답이다.
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
	var written strings.Builder
	var mu sync.Mutex
	log.SetOutput(writerFunc(func(p []byte) (int, error) {
		mu.Lock()
		defer mu.Unlock()
		return written.Write(p)
	}))
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	owner := newFakeOwner("/projects/closing")
	if err := sidecars.Send(owner, echoSidecar, "s1", json.RawMessage(`{"data":1}`)); err != nil {
		t.Fatal(err)
	}
	sidecars.Close("s1")
	nextClosing(t, snapshots)
	if got := nextClosing(t, snapshots); len(got) != 0 {
		t.Fatalf("closing after the failed answer = %v, want none", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if want := "sidecar @fixture/sidecar-echo: close s1: busy"; !strings.Contains(written.String(), want) {
		t.Fatalf("log %q does not contain %q", written.String(), want)
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

// contract: sidecars.close.process-end-clears-closing
func TestEndedSidecarLeavesNoClosingSurface(t *testing.T) {
	// 첫 요청에 답하고, closed 를 받으면 답하지 않고 끝난다.
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

// writerFunc 는 함수를 io.Writer 로 쓴다.
type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }
