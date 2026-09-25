package files_test

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/min-median-max/soksak/sidecars/files/src/files"
)

// session 은 Serve 를 실행하고 요청 전송과 이벤트 수신을 제공한다.
type session struct {
	t      *testing.T
	input  *io.PipeWriter
	events chan files.Event
}

func startSession(t *testing.T) *session {
	t.Helper()
	inRead, inWrite := io.Pipe()
	outRead, outWrite := io.Pipe()
	s := &session{t: t, input: inWrite, events: make(chan files.Event, 64)}
	done := make(chan error, 1)
	go func() {
		err := files.Serve(inRead, outWrite)
		outWrite.Close()
		done <- err
	}()
	go func() {
		scanner := bufio.NewScanner(outRead)
		for scanner.Scan() {
			var event files.Event
			if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
				t.Errorf("invalid event %q: %v", scanner.Text(), err)
				continue
			}
			s.events <- event
		}
		close(s.events)
	}()
	t.Cleanup(func() {
		inWrite.Close()
		if err := <-done; err != nil {
			t.Errorf("serve: %v", err)
		}
	})
	return s
}

func (s *session) send(root string, body map[string]any) {
	s.t.Helper()
	line, err := json.Marshal(map[string]any{"surface": "state:files:p1", "root": root, "body": body})
	if err != nil {
		s.t.Fatal(err)
	}
	if _, err := s.input.Write(append(line, '\n')); err != nil {
		s.t.Fatal(err)
	}
}

// next 는 다음 이벤트를 반환한다. 5 초 안에 오지 않으면 실패한다.
func (s *session) next(what string) files.Event {
	s.t.Helper()
	select {
	case event := <-s.events:
		return event
	case <-time.After(5 * time.Second):
		s.t.Fatalf("no event: %s", what)
		return files.Event{}
	}
}

func TestWatchReportsAChangedDirectory(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	s := startSession(t)
	s.send(root, map[string]any{"operation": "watch", "id": "w", "paths": []string{"", "src"}})
	if reply := s.next("watch reply"); reply.Body.ID != "w" || reply.Body.Error != "" {
		t.Fatalf("watch reply = %+v", reply)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "new.txt"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if event := s.next("change in src"); event.Body.Changed == nil || *event.Body.Changed != "src" {
		t.Fatalf("event = %+v, want changed src", event)
	}
	if err := os.WriteFile(filepath.Join(root, "top.txt"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if event := s.next("change in root"); event.Body.Changed == nil || *event.Body.Changed != "" {
		t.Fatalf("event = %+v, want changed root", event)
	}
}

func TestWatchRejectsPathsOutsideTheRoot(t *testing.T) {
	root := t.TempDir()
	s := startSession(t)
	s.send(root, map[string]any{"operation": "watch", "id": "w", "paths": []string{".."}})
	if reply := s.next("watch reply"); reply.Body.ID != "w" || !strings.Contains(reply.Body.Error, "leaves the root") {
		t.Fatalf("reply = %+v", reply)
	}
}
