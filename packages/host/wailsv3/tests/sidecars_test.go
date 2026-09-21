package host_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	host "github.com/min-median-max/soksak/packages/host/wailsv3/src"
)

const echoSidecar = "@fixture/sidecar-echo"

// frontend 는 플러그인 하나와 그 플러그인이 의존하는 사이드카 하나를 선언한 스테이징 결과다.
func frontend(sidecar string) fstest.MapFS {
	return fstest.MapFS{
		"environment.json":                         {Data: []byte(`{"plugins":["@fixture/plugin"]}`)},
		"modules/@fixture/plugin/plugin.json":      {Data: []byte(`{"id":"plugin","sidecars":["` + echoSidecar + `"]}`)},
		"modules/" + echoSidecar + "/sidecar.json": {Data: []byte(sidecar)},
	}
}

// fakeOwner 는 받은 사이드카 이벤트를 기록하는 창이다.
type fakeOwner struct {
	root   string
	mu     sync.Mutex
	events []host.SidecarMessage
	seen   chan struct{}
}

func newFakeOwner(root string) *fakeOwner {
	return &fakeOwner{root: root, seen: make(chan struct{}, 16)}
}

func (o *fakeOwner) ProjectRoot() string { return o.root }

func (o *fakeOwner) Emit(name string, data ...any) {
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
	case <-time.After(10 * time.Second):
		t.Fatal("no sidecar event within 10s")
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.events[len(o.events)-1]
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
	sidecars, err := host.NewSidecars(frontend(`{"executable":"build/echo","protocol":1}`), directory, directory)
	if err != nil {
		t.Fatal(err)
	}
	return sidecars, record
}

func TestSidecarMessagesReachTheOwningWindowOnly(t *testing.T) {
	sidecars, record := echoSidecars(t)
	first, second := newFakeOwner("/projects/a"), newFakeOwner("/projects/b")
	if err := sidecars.Send(first, echoSidecar, "s1", json.RawMessage(`{"op":"open"}`)); err != nil {
		t.Fatal(err)
	}
	if err := sidecars.Send(second, echoSidecar, "s2", json.RawMessage(`{"op":"open"}`)); err != nil {
		t.Fatal(err)
	}
	if event := first.next(t); event.Sidecar != echoSidecar || event.Surface != "s1" || string(event.Body) != `{"op":"open"}` {
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
	want := `{"surface":"s1","root":"/projects/a","body":{"op":"open"}}
{"surface":"s2","root":"/projects/b","body":{"op":"open"}}
{"surface":"s1","closed":true}
`
	if string(requests) != want {
		t.Fatalf("requests =\n%s\nwant\n%s", requests, want)
	}
}

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

func TestMissingSidecarExecutableFails(t *testing.T) {
	directory := t.TempDir()
	sidecars, err := host.NewSidecars(frontend(`{"executable":"build/absent","protocol":1}`), directory, directory)
	if err != nil {
		t.Fatal(err)
	}
	if err := sidecars.Send(newFakeOwner("/"), echoSidecar, "s1", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "sidecar "+echoSidecar) {
		t.Fatalf("missing executable = %v", err)
	}
}

func TestInvalidSidecarDeclarationsFail(t *testing.T) {
	cases := map[string]struct {
		files fstest.MapFS
		want  string
	}{
		"missing sidecar.json": {fstest.MapFS{
			"environment.json":                    {Data: []byte(`{"plugins":["@fixture/plugin"]}`)},
			"modules/@fixture/plugin/plugin.json": {Data: []byte(`{"sidecars":["@fixture/sidecar-missing"]}`)},
		}, "modules/@fixture/sidecar-missing/sidecar.json"},
		"escaping executable":       {frontend(`{"executable":"../escape","protocol":1}`), "inside the package"},
		"absolute executable":       {frontend(`{"executable":"/bin/sh","protocol":1}`), "inside the package"},
		"unknown protocol":          {frontend(`{"executable":"build/echo","protocol":2}`), "protocol"},
		"persistent without config": {frontend(`{"executable":"build/echo","protocol":1,"transport":"persistent"}`), "persistent transport requires a config directory"},
		"unknown transport":         {frontend(`{"executable":"build/echo","protocol":1,"transport":"ptyd"}`), "transport ptyd is not supported"},
		"missing environment":       {fstest.MapFS{}, "environment.json"},
	}
	for name, c := range cases {
		directory := t.TempDir()
		configDirectory := directory
		if name == "persistent without config" {
			configDirectory = ""
		}
		if _, err := host.NewSidecars(c.files, directory, configDirectory); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: error = %v, want %q", name, err, c.want)
		}
	}
}

func TestPersistentTransportRequiresConfigDirectory(t *testing.T) {
	if _, err := host.NewSidecars(frontend(`{"executable":"build/echo","protocol":1,"transport":"persistent"}`), t.TempDir(), ""); err == nil || !strings.Contains(err.Error(), "persistent transport requires a config directory") {
		t.Fatalf("persistent transport without config = %v", err)
	}
}

func TestApplicationWithoutSidecarsRejectsSends(t *testing.T) {
	files := fstest.MapFS{
		"environment.json":                    {Data: []byte(`{"plugins":["@fixture/plugin"]}`)},
		"modules/@fixture/plugin/plugin.json": {Data: []byte(`{"id":"plugin"}`)},
	}
	directory := t.TempDir()
	sidecars, err := host.NewSidecars(files, directory, directory)
	if err != nil {
		t.Fatal(err)
	}
	if err := sidecars.Send(newFakeOwner("/"), echoSidecar, "s1", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "not declared by any plugin") {
		t.Fatalf("send = %v", err)
	}
}

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

	// 두 사이드카를 선언한 프런트엔드를 설정한다.
	frontend := fstest.MapFS{
		"environment.json": {Data: []byte(`{"plugins":["@fixture/plugin"]}`)},
		"modules/@fixture/plugin/plugin.json": {Data: []byte(`{
			"id":"plugin",
			"sidecars":["@fixture/sidecar-slow","@fixture/sidecar-fast"]
		}`)},
		"modules/@fixture/sidecar-slow/sidecar.json": {Data: []byte(`{"executable":"build/slow","protocol":1}`)},
		"modules/@fixture/sidecar-fast/sidecar.json": {Data: []byte(`{"executable":"build/fast","protocol":1}`)},
	}
	sidecars, err := host.NewSidecars(frontend, directory, directory)
	if err != nil {
		t.Fatal(err)
	}
	// 테스트를 위해 기한을 100ms로 설정한다.
	sidecars.StopTimeout = 100 * time.Millisecond

	owner := newFakeOwner("/projects/test")

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
	// Send() 는 채널에 넣고 즉시 돌아올 뿐이므로 50ms 미만이어야 한다.
	// (첫 Send 는 프로세스 기동을 포함할 수 있으므로, 미리 한 번 보내 프로세스를 띄운 후,
	// 두 번째 Send 를 시간 측정한다.)
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
func TestStopGracefulShutdown(t *testing.T) {
	directory := t.TempDir()

	// 사이드카: 받은 줄을 그대로 에코하고 stdin EOF 에 정상 종료한다.
	gracefulScript := "#!/bin/sh\nwhile read line; do echo \"$line\"; done\nexit 0\n"
	if err := os.WriteFile(filepath.Join(directory, "graceful"), []byte(gracefulScript), 0o755); err != nil {
		t.Fatal(err)
	}

	// 사이드카를 선언한 프런트엔드를 설정한다.
	fe := frontend(`{"executable":"build/graceful","protocol":1}`)
	sidecars, err := host.NewSidecars(fe, directory, directory)
	if err != nil {
		t.Fatal(err)
	}
	// 테스트를 위해 기한을 1초로 설정한다.
	sidecars.StopTimeout = 1 * time.Second

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

	// 정상 종료는 250ms 안에 일어나야 한다 (기한까지 기다리지 않음).
	if elapsed > 250*time.Millisecond {
		t.Errorf("graceful stop took %v, want < 250ms", elapsed)
	}
}

// TestStopForcedKill 은 기한을 초과해도 종료하지 않는 사이드카를 kill 하는지 검증한다.
func TestStopForcedKill(t *testing.T) {
	directory := t.TempDir()

	// 사이드카: stdin EOF 를 무시하고 계속 실행한다.
	stubborn := "#!/bin/sh\ncat >/dev/null &\nwait\n"
	if err := os.WriteFile(filepath.Join(directory, "stubborn"), []byte(stubborn), 0o755); err != nil {
		t.Fatal(err)
	}

	// 사이드카를 선언한 프런트엔드를 설정한다.
	fe := frontend(`{"executable":"build/stubborn","protocol":1}`)
	sidecars, err := host.NewSidecars(fe, directory, directory)
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

	// Stop() 은 기한만큼 기다렸다가 kill 해야 하므로 약 100ms 정도 걸려야 한다.
	// 범위: 80ms ~ 150ms (정확한 시간 측정에 여유를 둠).
	if elapsed < 80*time.Millisecond || elapsed > 150*time.Millisecond {
		t.Errorf("forced kill stop took %v, want ~100ms", elapsed)
	}
}
