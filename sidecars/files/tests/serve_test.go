package files_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/min-median-max/soksak/sidecars/files/src/files"
)

// serve 는 요청 줄들을 처리하고 받은 이벤트를 반환한다.
func serve(t *testing.T, lines ...string) []files.Event {
	t.Helper()
	var out bytes.Buffer
	if err := files.Serve(strings.NewReader(strings.Join(lines, "\n")+"\n"), &out); err != nil {
		t.Fatalf("serve: %v", err)
	}
	var events []files.Event
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var event files.Event
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("invalid event %q: %v", line, err)
		}
		events = append(events, event)
	}
	return events
}

func request(t *testing.T, root, id, path string) string {
	t.Helper()
	line, err := json.Marshal(map[string]any{"surface": "state:files:p1", "root": root,
		"body": map[string]any{"operation": "list", "id": id, "path": path}})
	if err != nil {
		t.Fatal(err)
	}
	return string(line)
}

func TestListReturnsDirectoriesFirstThenFilesByName(t *testing.T) {
	root := t.TempDir()
	for _, dir := range []string{"src", "b-dir"} {
		if err := os.Mkdir(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, file := range []string{"z.txt", "a.txt", "src/main.go"} {
		if err := os.WriteFile(filepath.Join(root, file), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(root, "b-dir", "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	events := serve(t, request(t, root, "1", ""), request(t, root, "2", "src"), request(t, root, "3", "b-dir/empty"))
	if got, _ := json.Marshal(events[2].Body); string(got) != `{"id":"3","entries":[]}` {
		t.Fatalf("empty listing = %s", got)
	}
	events = events[:2]
	if len(events) != 2 {
		t.Fatalf("events = %+v", events)
	}
	got, _ := json.Marshal(events[0].Body)
	want := `{"id":"1","entries":[{"directory":true,"name":"b-dir"},{"directory":true,"name":"src"},{"directory":false,"name":"a.txt"},{"directory":false,"name":"z.txt"}]}`
	if string(got) != want {
		t.Fatalf("root listing = %s, want %s", got, want)
	}
	if events[0].Surface != "state:files:p1" {
		t.Fatalf("surface = %q", events[0].Surface)
	}
	if got, _ := json.Marshal(events[1].Body); string(got) != `{"id":"2","entries":[{"directory":false,"name":"main.go"}]}` {
		t.Fatalf("src listing = %s", got)
	}
}

func TestListRejectsPathsOutsideTheRootAndReportsFailuresWithTheRequestID(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	cases := map[string]string{"..": "leaves the root", "/etc": "must be relative", "link": "leaves the root", "missing": "no such file"}
	for path, message := range cases {
		events := serve(t, request(t, root, "r", path))
		if len(events) != 1 || events[0].Body.ID != "r" || !strings.Contains(events[0].Body.Error, message) {
			t.Fatalf("path %q: events = %+v, want an error containing %q", path, events, message)
		}
	}
	events := serve(t, request(t, "", "r", ""))
	if len(events) != 1 || !strings.Contains(events[0].Body.Error, "requires a root") {
		t.Fatalf("missing root: %+v", events)
	}
}
