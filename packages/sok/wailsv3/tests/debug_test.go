package tests

// `sok debug timeline` (docs/spec/debug.md#timeline-command) prints the same lines as the debug view for the golden files of
// packages/log-contract/fixtures/timeline, and rejects a file or a value that breaks the contract with an error that names it.

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/sok/wailsv3/src"
)

const timelineFixtures = "../../../log-contract/fixtures/timeline"

func runTimeline(t *testing.T, configDir string, args ...string) (string, string, int) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	all := append([]string{"debug", "timeline", "--config-dir", configDir}, args...)
	code := sok.Run(all, &stdout, &stderr, sok.Options{Identifier: "app.soksak.wails"})
	return stdout.String(), stderr.String(), code
}

// contract: cli.debug.timeline-golden-lines
func TestTimelinePrintsTheGoldenLinesOfEveryFilter(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(timelineFixtures, "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name  string
		Args  []string
		Lines []string
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 7 {
		t.Fatalf("the golden file holds %d cases", len(cases))
	}
	for _, c := range cases {
		stdout, stderr, code := runTimeline(t, timelineFixtures, c.Args...)
		want := strings.Join(c.Lines, "\n") + "\n"
		if code != 0 || stdout != want {
			t.Errorf("%s: code %d stderr %q\n got %q\nwant %q", c.Name, code, stderr, stdout, want)
		}
	}
}

// contract: cli.debug.timeline-errors
func TestTimelineRefusesWhatBreaksTheContract(t *testing.T) {
	empty := t.TempDir()
	if err := os.MkdirAll(filepath.Join(empty, "logs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, stderr, code := runTimeline(t, empty); code != 1 || !strings.Contains(stderr, "no event file logs/host-<boot>.jsonl in "+filepath.Join(empty, "logs")) {
		t.Errorf("no file: code %d stderr %q", code, stderr)
	}
	broken := t.TempDir()
	logs := filepath.Join(broken, "logs")
	if err := os.MkdirAll(logs, 0o755); err != nil {
		t.Fatal(err)
	}
	open := `{"ts_us":1,"seq":0,"level":"info","layer":"host","event":"log.open","fields":{"schema":2}}` + "\n"
	cases := []struct{ name, text, want string }{
		{"first line", `{"ts_us":1,"seq":0,"level":"info","layer":"host","event":"host.x"}` + "\n", `logs/host-b1.jsonl: the first line is not log.open: "host.x"`},
		{"schema", `{"ts_us":1,"seq":0,"level":"info","layer":"host","event":"log.open","fields":{"schema":1}}` + "\n", "logs/host-b1.jsonl: schema 1 is not 2"},
		{"not json", open + "not json\n", "logs/host-b1.jsonl:2: not JSON: not json"},
		{"not object", open + "[1]\n", "logs/host-b1.jsonl:2: not an event object: [1]"},
		{"seq", open + `{"ts_us":1,"seq":"x","level":"info","layer":"host","event":"a"}` + "\n", `logs/host-b1.jsonl:2: seq must be an integer, found "x"`},
		{"level", open + `{"ts_us":1,"seq":1,"level":"loud","layer":"host","event":"a"}` + "\n", `logs/host-b1.jsonl:2: level "loud" is not one of error, warn, info, debug, trace`},
		{"layer", open + `{"ts_us":1,"seq":1,"level":"info","layer":"x","event":"a"}` + "\n", `logs/host-b1.jsonl:2: layer "x" is not one of native, host, page, plugin, sidecar`},
		{"event", open + `{"ts_us":1,"seq":1,"level":"info","layer":"host","event":3}` + "\n", "logs/host-b1.jsonl:2: event must be a string, found 3"},
		{"fields", open + `{"ts_us":1,"seq":1,"level":"info","layer":"host","event":"a","fields":[1]}` + "\n", "logs/host-b1.jsonl:2: fields must be an object, found [1]"},
		{"cids", open + `{"ts_us":1,"seq":1,"level":"info","layer":"host","event":"a","cids":[1]}` + "\n", "logs/host-b1.jsonl:2: cids must be an array of strings, found [1]"},
		{"surface", open + `{"ts_us":1,"seq":1,"level":"info","layer":"host","event":"a","surface":7}` + "\n", "logs/host-b1.jsonl:2: surface must be a string, found 7"},
	}
	for _, c := range cases {
		if err := os.WriteFile(filepath.Join(logs, "host-b1.jsonl"), []byte(c.text), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, stderr, code := runTimeline(t, broken); code != 1 || !strings.Contains(stderr, c.want) {
			t.Errorf("%s: code %d stderr %q want %q", c.name, code, stderr, c.want)
		}
	}
	// A line that is not ended by a line feed is not read yet, as in the view.
	if err := os.WriteFile(filepath.Join(logs, "host-b1.jsonl"), []byte(open+`{"ts_us":2,"seq":1,"lev`), 0o644); err != nil {
		t.Fatal(err)
	}
	if stdout, stderr, code := runTimeline(t, broken); code != 0 || strings.Count(stdout, "\n") != 1 {
		t.Errorf("unfinished line: code %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: cli.debug.timeline-filter-values
func TestTimelineRefusesAnInvalidFilterValueAsAUsageError(t *testing.T) {
	cases := []struct {
		args []string
		want string
	}{
		{[]string{"--level", "loud"}, `timeline level "loud" is not one of error, warn, info, debug, trace`},
		{[]string{"--layer", "x"}, `timeline layer "x" is not one of all, native, host, page, plugin, sidecar`},
		{[]string{"--from", "yesterday"}, `timeline from "yesterday" is not a UTC time like 2026-10-08T22:53:20.123456Z or empty`},
		{[]string{"--from", "2026-02-30T00:00:00Z"}, `timeline from "2026-02-30T00:00:00Z" is not a UTC time like 2026-10-08T22:53:20.123456Z or empty`},
		{[]string{"--from", "2026-10-08T00:00:02Z", "--to", "2026-10-08T00:00:01Z"}, `timeline from is later than to: "2026-10-08T00:00:02Z" "2026-10-08T00:00:01Z"`},
		{[]string{"--context", "x"}, `timeline context must be decimal digits, found "x"`},
		{[]string{"--context", "12345"}, `timeline context must be decimal digits, found "12345"`},
	}
	for _, c := range cases {
		if stdout, stderr, code := runTimeline(t, timelineFixtures, c.args...); code != 2 || stdout != "" || !strings.Contains(stderr, c.want) {
			t.Errorf("%v: code %d stdout %q stderr %q want %q", c.args, code, stdout, stderr, c.want)
		}
	}
}

// contract: cli.debug.timeline-errors
func TestTimelineReadsAFileWithoutALineAsNoRows(t *testing.T) {
	dir := t.TempDir()
	logs := filepath.Join(dir, "logs")
	if err := os.MkdirAll(logs, 0o755); err != nil {
		t.Fatal(err)
	}
	open := `{"ts_us":1,"seq":0,"level":"info","layer":"host","event":"log.open","fields":{"schema":2}}` + "\n"
	for name, text := range map[string]string{"host-a.jsonl": "", "host-b.jsonl": open} {
		if err := os.WriteFile(filepath.Join(logs, name), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if stdout, stderr, code := runTimeline(t, dir); code != 0 || strings.Count(stdout, "\n") != 1 {
		t.Errorf("code %d stdout %q stderr %q: the empty file must have no row and the other file one", code, stdout, stderr)
	}
}
