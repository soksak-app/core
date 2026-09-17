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
	sidecars, err := host.NewSidecars(frontend(`{"executable":"build/echo","protocol":1}`), directory)
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
	sidecars, err := host.NewSidecars(frontend(`{"executable":"build/absent","protocol":1}`), t.TempDir())
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
		"escaping executable": {frontend(`{"executable":"../escape","protocol":1}`), "inside the package"},
		"absolute executable": {frontend(`{"executable":"/bin/sh","protocol":1}`), "inside the package"},
		"unknown protocol":    {frontend(`{"executable":"build/echo","protocol":2}`), "protocol"},
		"missing environment": {fstest.MapFS{}, "environment.json"},
	}
	for name, c := range cases {
		if _, err := host.NewSidecars(c.files, t.TempDir()); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: error = %v, want %q", name, err, c.want)
		}
	}
}

func TestApplicationWithoutSidecarsRejectsSends(t *testing.T) {
	files := fstest.MapFS{
		"environment.json":                    {Data: []byte(`{"plugins":["@fixture/plugin"]}`)},
		"modules/@fixture/plugin/plugin.json": {Data: []byte(`{"id":"plugin"}`)},
	}
	sidecars, err := host.NewSidecars(files, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := sidecars.Send(newFakeOwner("/"), echoSidecar, "s1", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "not declared by any plugin") {
		t.Fatalf("send = %v", err)
	}
}
