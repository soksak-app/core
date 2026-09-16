package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeOwner 는 받은 사이드카 이벤트를 기록하는 창이다.
type fakeOwner struct {
	root   string
	mu     sync.Mutex
	events []SidecarMessage
	seen   chan struct{}
}

func newFakeOwner(root string) *fakeOwner {
	return &fakeOwner{root: root, seen: make(chan struct{}, 16)}
}

func (o *fakeOwner) projectRoot() string { return o.root }

func (o *fakeOwner) emit(name string, data ...any) {
	if name != "sidecar-message" || len(data) != 1 {
		return
	}
	o.mu.Lock()
	o.events = append(o.events, data[0].(SidecarMessage))
	o.mu.Unlock()
	o.seen <- struct{}{}
}

func (o *fakeOwner) next(t *testing.T) SidecarMessage {
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

// echoSidecars 는 받은 줄을 그대로 출력하는 fake 사이드카 "echo" 를 선언한 채널을 만든다.
// 요청의 surface 와 body 가 그대로 이벤트로 돌아오고, 요청 기록 파일에 모든 요청이 남는다.
func echoSidecars(t *testing.T) (*Sidecars, string) {
	t.Helper()
	directory := t.TempDir()
	record := filepath.Join(directory, "requests")
	script := "#!/bin/sh\ntee " + record + "\n"
	if err := os.WriteFile(filepath.Join(directory, "soksak-echo"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	sidecars, err := NewSidecars([]byte(`{"sidecars":["echo"]}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	return sidecars, record
}

func TestSidecarMessagesReachTheOwningWindowOnly(t *testing.T) {
	sidecars, record := echoSidecars(t)
	first, second := newFakeOwner("/projects/a"), newFakeOwner("/projects/b")
	if err := sidecars.Send(first, "echo", "s1", json.RawMessage(`{"op":"open"}`)); err != nil {
		t.Fatal(err)
	}
	if err := sidecars.Send(second, "echo", "s2", json.RawMessage(`{"op":"open"}`)); err != nil {
		t.Fatal(err)
	}
	if event := first.next(t); event.Sidecar != "echo" || event.Surface != "s1" || string(event.Body) != `{"op":"open"}` {
		t.Fatalf("first window event = %+v", event)
	}
	if event := second.next(t); event.Surface != "s2" {
		t.Fatalf("second window event = %+v", event)
	}
	if err := sidecars.Send(second, "echo", "s1", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "another window") {
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
	if err := sidecars.Send(owner, "echo", "s1", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "stopped") {
		t.Fatalf("send after stop = %v", err)
	}
}

func TestMissingSidecarExecutableFails(t *testing.T) {
	sidecars, err := NewSidecars([]byte(`{"sidecars":["absent"]}`), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := sidecars.Send(newFakeOwner("/"), "absent", "s1", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "sidecar absent") {
		t.Fatalf("missing executable = %v", err)
	}
}
