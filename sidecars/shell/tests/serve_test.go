package shell_test

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/min-median-max/soksak/sidecars/shell/src/shell"
)

// harness 는 Serve 를 실행하고 요청 전송과 이벤트 수신을 제공한다.
type harness struct {
	t      *testing.T
	input  *io.PipeWriter
	events chan shell.Event
	done   chan error
}

func start(t *testing.T) *harness {
	t.Helper()
	inRead, inWrite := io.Pipe()
	outRead, outWrite := io.Pipe()
	s := &harness{t: t, input: inWrite, events: make(chan shell.Event, 64), done: make(chan error, 1)}
	go func() {
		err := shell.Serve(inRead, outWrite)
		outWrite.Close()
		s.done <- err
	}()
	go func() {
		scanner := bufio.NewScanner(outRead)
		for scanner.Scan() {
			var event shell.Event
			if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
				t.Errorf("invalid event %q: %v", scanner.Text(), err)
				continue
			}
			s.events <- event
		}
		close(s.events)
	}()
	return s
}

func (s *harness) send(line string) {
	s.t.Helper()
	if _, err := io.WriteString(s.input, line+"\n"); err != nil {
		s.t.Fatalf("send %s: %v", line, err)
	}
}

// next 는 다음 이벤트를 반환한다. 이벤트가 오지 않으면 테스트를 실패시킨다.
func (s *harness) next() shell.Event {
	s.t.Helper()
	select {
	case event, ok := <-s.events:
		if !ok {
			s.t.Fatal("event stream closed")
		}
		return event
	case <-time.After(10 * time.Second):
		s.t.Fatal("no event within 10s")
	}
	return shell.Event{}
}

func (s *harness) finish() error {
	s.input.Close()
	return <-s.done
}

func TestOpenWriteReturnsShellOutputForTheSurface(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	s := start(t)
	root := t.TempDir()
	s.send(`{"surface":"t1","root":"` + root + `","body":{"op":"open"}}`)
	s.send(`{"surface":"t1","body":{"op":"write","data":"pwd\n"}}`)
	event := s.next()
	if event.Surface != "t1" || !strings.HasSuffix(strings.TrimSpace(event.Body.Text), strings.TrimPrefix(root, "/private")) {
		t.Fatalf("event = %+v, want pwd output for %s", event, root)
	}
	s.send(`{"surface":"t1","closed":true}`)
	s.send(`{"surface":"t1","body":{"op":"write","data":"pwd\n"}}`)
	if event := s.next(); event.Surface != "t1" || event.Body.Error != "shell t1 is not running" {
		t.Fatalf("event after close = %+v", event)
	}
	if err := s.finish(); err != nil {
		t.Fatal(err)
	}
}

func TestRequestFailuresReturnErrorEvents(t *testing.T) {
	s := start(t)
	s.send(`{"surface":"t2","body":{"op":"open"}}`)
	if event := s.next(); event.Body.Error != "open requires a root" {
		t.Fatalf("open without root = %+v", event)
	}
	s.send(`{"surface":"t2","body":{"op":"resize"}}`)
	if event := s.next(); event.Body.Error != `unknown op: "resize"` {
		t.Fatalf("unknown op = %+v", event)
	}
	if err := s.finish(); err != nil {
		t.Fatal(err)
	}
}

func TestMalformedInputStopsTheSidecar(t *testing.T) {
	s := start(t)
	s.send(`{"body":{"op":"open"}}`)
	if err := <-s.done; err == nil || !strings.Contains(err.Error(), "request without surface") {
		t.Fatalf("error = %v", err)
	}
}
