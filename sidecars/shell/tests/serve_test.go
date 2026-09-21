package shell_test

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"os/signal"
	"path/filepath"
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

// until 은 match 가 참인 이벤트까지 읽고 그 이벤트를 반환한다. 그 사이의 이벤트는 seen 에 모은다.
func (s *harness) until(match func(shell.Event) bool) (shell.Event, []shell.Event) {
	s.t.Helper()
	var seen []shell.Event
	for {
		event := s.next()
		if match(event) {
			return event, seen
		}
		seen = append(seen, event)
	}
}

func (s *harness) open(surface string) string {
	s.t.Helper()
	root := s.t.TempDir()
	s.send(`{"surface":"` + surface + `","root":"` + root + `","body":{"op":"open"}}`)
	event, _ := s.until(func(e shell.Event) bool { return e.Surface == surface && e.Body.Cwd != "" })
	if !sameDir(event.Body.Cwd, root) {
		s.t.Fatalf("first directory report = %q, want %q", event.Body.Cwd, root)
	}
	return root
}

// sameDir 는 macOS 의 /private 접두어를 무시하고 비교한다.
func sameDir(a, b string) bool {
	return strings.TrimPrefix(a, "/private") == strings.TrimPrefix(b, "/private")
}

func TestOpenWriteReturnsShellOutputForTheSurface(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	s := start(t)
	root := s.open("t1")
	s.send(`{"surface":"t1","body":{"op":"write","data":"pwd\n"}}`)
	event := s.next()
	if event.Surface != "t1" || !sameDir(strings.TrimSpace(event.Body.Text), root) {
		t.Fatalf("event = %+v, want pwd output for %s", event, root)
	}
	s.send(`{"surface":"t1","closed":true}`)
	s.send(`{"surface":"t1","body":{"op":"write","data":"pwd\n"}}`)
	if event, _ := s.until(func(e shell.Event) bool { return e.Body.Error != "" }); event.Surface != "t1" || event.Body.Error != "shell t1 is not running" {
		t.Fatalf("event after close = %+v", event)
	}
	if err := s.finish(); err != nil {
		t.Fatal(err)
	}
}

func TestReopenReportsTheLiveDirectoryToARemountedSurface(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	s := start(t)
	root := s.open("reattach")
	s.send(`{"surface":"reattach","root":"` + root + `","body":{"op":"open"}}`)
	event, _ := s.until(func(e shell.Event) bool { return e.Surface == "reattach" && e.Body.Cwd != "" })
	if !sameDir(event.Body.Cwd, root) {
		t.Fatalf("reopened directory = %q, want %q", event.Body.Cwd, root)
	}
	if err := s.finish(); err != nil {
		t.Fatal(err)
	}
}

func TestStandardErrorKeepsItsOrderWithStandardOutput(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	s := start(t)
	s.open("order")
	s.send(`{"surface":"order","body":{"op":"write","data":"echo one; echo two >&2; echo three\n"}}`)
	var lines []string
	for len(lines) < 3 {
		event := s.next()
		if event.Body.Text != "" {
			lines = append(lines, strings.TrimSpace(event.Body.Text))
		}
	}
	if strings.Join(lines, ",") != "one,two,three" {
		t.Fatalf("lines = %v, want one,two,three", lines)
	}
	if err := s.finish(); err != nil {
		t.Fatal(err)
	}
}

func TestADirectoryChangeIsReportedAndNotShownAsOutput(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	s := start(t)
	root := s.open("cd")
	if err := os.Mkdir(filepath.Join(root, "inner"), 0o755); err != nil {
		t.Fatal(err)
	}
	s.send(`{"surface":"cd","body":{"op":"write","data":"cd inner\n"}}`)
	event, seen := s.until(func(e shell.Event) bool { return e.Body.Cwd != "" })
	if !sameDir(event.Body.Cwd, filepath.Join(root, "inner")) {
		t.Fatalf("directory = %q, want %s/inner", event.Body.Cwd, root)
	}
	for _, other := range seen {
		if strings.Contains(other.Body.Text, "cwd") || strings.Contains(other.Body.Text, "printf") {
			t.Fatalf("the directory report leaked into the output: %+v", other)
		}
	}
	if err := s.finish(); err != nil {
		t.Fatal(err)
	}
}

func TestALineReadByARunningCommandIsPassedUnchanged(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	s := start(t)
	s.open("read")
	// 자식 셸이 표시 줄을 출력한 뒤 head 가 되므로, 표시 줄을 받은 때에는 명령이 실행 중이다.
	s.send(`{"surface":"read","body":{"op":"write","data":"sh -c 'echo started; exec head -n 1'\n"}}`)
	s.until(func(e shell.Event) bool { return e.Body.Text == "started\n" })
	s.send(`{"surface":"read","body":{"op":"write","data":"typed\n"}}`)
	event, _ := s.until(func(e shell.Event) bool { return e.Body.Text != "" })
	if event.Body.Text != "typed\n" {
		t.Fatalf("head printed %q, want the typed line only", event.Body.Text)
	}
	// head 가 끝나면 셸이 디렉터리를 보고하고, 그 뒤에 쓴 줄은 다시 명령이다.
	s.until(func(e shell.Event) bool { return e.Body.Cwd != "" })
	s.send(`{"surface":"read","body":{"op":"write","data":"echo next\n"}}`)
	if event, _ := s.until(func(e shell.Event) bool { return e.Body.Text != "" }); event.Body.Text != "next\n" {
		t.Fatalf("after head the shell printed %q", event.Body.Text)
	}
	if err := s.finish(); err != nil {
		t.Fatal(err)
	}
}

func TestRunReturnsOutputAndExitCodeInTheReportedDirectory(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	s := start(t)
	root := s.open("run")
	s.send(`{"surface":"run","body":{"op":"run","id":"r1","command":"pwd; echo err >&2; exit 3"}}`)
	event, _ := s.until(func(e shell.Event) bool { return e.Body.ID == "r1" })
	if event.Body.Exit == nil || *event.Body.Exit != 3 || event.Body.Output == nil {
		t.Fatalf("run result = %+v, want exit 3 with output", event.Body)
	}
	lines := strings.Split(strings.TrimSpace(*event.Body.Output), "\n")
	if len(lines) != 2 || !sameDir(lines[0], root) || lines[1] != "err" {
		t.Fatalf("run output = %q", *event.Body.Output)
	}
	s.send(`{"surface":"run","body":{"op":"run","id":"r2","command":"true"}}`)
	if event, _ := s.until(func(e shell.Event) bool { return e.Body.ID == "r2" }); event.Body.Exit == nil || *event.Body.Exit != 0 {
		t.Fatalf("run true = %+v", event.Body)
	}
	gone := filepath.Join(root, "gone")
	if err := os.Mkdir(gone, 0o755); err != nil {
		t.Fatal(err)
	}
	s.send(`{"surface":"run","body":{"op":"write","data":"cd gone\n"}}`)
	s.until(func(e shell.Event) bool { return e.Body.Cwd != "" })
	if err := os.Remove(gone); err != nil {
		t.Fatal(err)
	}
	s.send(`{"surface":"run","body":{"op":"run","id":"r3","command":"true"}}`)
	if event, _ := s.until(func(e shell.Event) bool { return e.Body.ID == "r3" }); !strings.Contains(event.Body.Error, "does not exist") {
		t.Fatalf("run in a removed directory = %+v", event.Body)
	}
	s.send(`{"surface":"run","body":{"op":"run","command":"true"}}`)
	if event, _ := s.until(func(e shell.Event) bool { return e.Body.Error != "" }); event.Body.Error != "run requires an id and a command" {
		t.Fatalf("run without id = %+v", event.Body)
	}
	if err := s.finish(); err != nil {
		t.Fatal(err)
	}
}

func TestInterruptStopsTheRunningCommandAndKeepsTheShell(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	// 부모가 중단 신호를 무시한 채 사이드카를 시작한 경우와 같게 한다.
	signal.Ignore(os.Interrupt)
	t.Cleanup(func() { signal.Reset(os.Interrupt) })
	s := start(t)
	s.open("int")
	s.send(`{"surface":"int","body":{"op":"write","data":"sh -c 'echo started; exec sleep 30'\n"}}`)
	s.until(func(e shell.Event) bool { return e.Body.Text == "started\n" })
	s.send(`{"surface":"int","body":{"op":"run","id":"long","command":"sleep 30"}}`)
	started := time.Now()
	s.send(`{"surface":"int","body":{"op":"interrupt"}}`)
	// 중단된 Run 의 결과와, 중단된 세션 명령이 끝난 뒤의 디렉터리 보고는 순서 없이 도착한다.
	var result *shell.Event
	reported := false
	for result == nil || !reported {
		event := s.next()
		if event.Body.ID == "long" {
			result = &event
		}
		reported = reported || event.Body.Cwd != ""
	}
	if result.Body.Exit == nil || *result.Body.Exit == 0 {
		t.Fatalf("interrupted run = %+v, want a non-zero exit", result.Body)
	}
	if time.Since(started) > 5*time.Second {
		t.Fatalf("the interrupt took %s", time.Since(started))
	}
	// 셸이 살아 있으면 다음 명령을 실행한다.
	s.send(`{"surface":"int","body":{"op":"write","data":"echo alive\n"}}`)
	if event, _ := s.until(func(e shell.Event) bool { return strings.TrimSpace(e.Body.Text) == "alive" }); event.Surface != "int" {
		t.Fatalf("event = %+v", event)
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
