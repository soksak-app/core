package tests

// `sok debug query` (docs/spec/debug.md#timeline-command) prints the same lines as the debug view for the golden files of
// docs/spec/cases/log-contract/query, and rejects a file or a value that breaks the contract with an error that names it.

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/sok/wailsv3/src"
)

func runQueryCommand(t *testing.T, configDir string, args ...string) (string, string, int) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	all := append([]string{"debug", "query", "--config-dir", configDir}, args...)
	code := sok.Run(all, &stdout, &stderr, sok.Options{Identifier: "app.soksak.wails"})
	return stdout.String(), stderr.String(), code
}

// contract: cli.debug.query-golden-lines
func TestQueryPrintsTheGoldenLinesOfEveryCase(t *testing.T) {
	for _, c := range readCases(t) {
		if c.Args == nil {
			continue
		}
		stdout, stderr, code := runQueryCommand(t, fixtureConfig(t), c.Args...)
		want := ""
		if len(c.Lines) > 0 {
			want = strings.Join(c.Lines, "\n") + "\n"
		}
		if code != 0 || stdout != want {
			t.Errorf("%s: code %d stderr %q\n got %q\nwant %q", c.Name, code, stderr, stdout, want)
		}
		wantMore := ""
		if c.Next != nil {
			wantMore = fmt.Sprintf("more: --after %d/%s/%s/%d\n", c.Next.TsUs, c.Next.Role, c.Next.Boot, c.Next.Seq)
		}
		if stderr != wantMore {
			t.Errorf("%s: stderr %q, want %q", c.Name, stderr, wantMore)
		}
	}
}

// contract: cli.debug.query-errors
func TestQueryRefusesWhatBreaksTheContract(t *testing.T) {
	if _, stderr, code := runQueryCommand(t, t.TempDir()); code != 1 || !strings.Contains(stderr, "logs: no such file or directory") {
		t.Errorf("no logs folder: code %d stderr %q", code, stderr)
	}
	broken := t.TempDir()
	logs := filepath.Join(broken, "logs")
	if err := os.MkdirAll(logs, 0o755); err != nil {
		t.Fatal(err)
	}
	open := `{"ts_us":1,"mono_ns":1,"seq":1,"level":"info","layer":"host","event":"log.open","fields":{"schema":2}}` + "\n"
	cases := []struct{ name, text, want string }{
		{"first line", `{"ts_us":1,"mono_ns":1,"seq":1,"level":"info","layer":"host","event":"host.x"}` + "\n", `logs/host-b1.jsonl: the first line is not log.open: "host.x"`},
		{"schema", `{"ts_us":1,"mono_ns":1,"seq":1,"level":"info","layer":"host","event":"log.open","fields":{"schema":1}}` + "\n", "logs/host-b1.jsonl: schema 1 is not 2"},
		{"not json", open + "not json\n", "logs/host-b1.jsonl:2: not JSON: not json"},
		{"not object", open + "[1]\n", "logs/host-b1.jsonl:2: not an event object: [1]"},
		{"seq", open + `{"ts_us":1,"seq":"x","level":"info","layer":"host","event":"a"}` + "\n", `logs/host-b1.jsonl:2: seq must be an integer, found "x"`},
		{"level", open + `{"ts_us":1,"seq":1,"level":"loud","layer":"host","event":"a"}` + "\n", `logs/host-b1.jsonl:2: level "loud" is not one of error, warn, info, debug, trace`},
		{"layer", open + `{"ts_us":1,"seq":1,"level":"info","layer":"x","event":"a"}` + "\n", `logs/host-b1.jsonl:2: layer "x" is not one of native, host, page, plugin, sidecar, sok`},
		{"event", open + `{"ts_us":1,"seq":1,"level":"info","layer":"host","event":3}` + "\n", "logs/host-b1.jsonl:2: event must be a string, found 3"},
		{"fields", open + `{"ts_us":1,"seq":1,"level":"info","layer":"host","event":"a","fields":[1]}` + "\n", "logs/host-b1.jsonl:2: fields must be an object, found [1]"},
		{"cids", open + `{"ts_us":1,"seq":1,"level":"info","layer":"host","event":"a","cids":[1]}` + "\n", "logs/host-b1.jsonl:2: cids must be an array of strings, found [1]"},
		{"surface", open + `{"ts_us":1,"seq":1,"level":"info","layer":"host","event":"a","surface":7}` + "\n", "logs/host-b1.jsonl:2: surface must be a string, found 7"},
	}
	for _, c := range cases {
		for _, name := range []string{"host-b1.jsonl.idx"} {
			if err := os.Remove(filepath.Join(logs, name)); err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
		}
		if err := os.WriteFile(filepath.Join(logs, "host-b1.jsonl"), []byte(c.text), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, stderr, code := runQueryCommand(t, broken); code != 1 || !strings.Contains(stderr, c.want) {
			t.Errorf("%s: code %d stderr %q want %q", c.name, code, stderr, c.want)
		}
	}
	// A line that is not ended by a line feed is not read yet.
	if err := os.Remove(filepath.Join(logs, "host-b1.jsonl.idx")); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(logs, "host-b1.jsonl"), []byte(open+`{"ts_us":2,"seq":1,"lev`), 0o644); err != nil {
		t.Fatal(err)
	}
	if stdout, stderr, code := runQueryCommand(t, broken); code != 0 || strings.Count(stdout, "\n") != 1 {
		t.Errorf("unfinished line: code %d stdout %q stderr %q", code, stdout, stderr)
	}
	// A file without a line has no row and does not hide the other files.
	if err := os.WriteFile(filepath.Join(logs, "host-a.jsonl"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if stdout, stderr, code := runQueryCommand(t, broken); code != 0 || strings.Count(stdout, "\n") != 1 {
		t.Errorf("empty file: code %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: cli.debug.query-flag-values
func TestQueryRefusesAnInvalidFlagValueAsAUsageError(t *testing.T) {
	config := fixtureConfig(t)
	cases := []struct {
		args []string
		want string
	}{
		{[]string{"--channel", "x"}, `log query channel "x" is not one of other, debug, all`},
		{[]string{"--level", "loud"}, `log query level "loud" is not one of error, warn, info, debug, trace`},
		{[]string{"--class", "x"}, `log query class "x" is not one of lifecycle, input, call, io, frame`},
		{[]string{"--layer", "x"}, `log query layer "x" is not one of native, host, page, plugin, sidecar, sok`},
		{[]string{"--event", ""}, `log query event must be a non-empty string, found ""`},
		{[]string{"--event", "a", "--event-prefix", "b"}, `log query takes event or event_prefix, not both`},
		{[]string{"--from", "yesterday"}, `log query from "yesterday" is not a UTC time like 2026-10-08T22:53:20.123456Z`},
		{[]string{"--to", "2026-02-30T00:00:00Z"}, `log query to "2026-02-30T00:00:00Z" is not a UTC time like 2026-10-08T22:53:20.123456Z`},
		{[]string{"--from", "2026-10-08T00:00:02Z", "--to", "2026-10-08T00:00:01Z"}, `log query from_us is later than to_us: 1791417602000000 1791417601000000`},
		{[]string{"--limit", "x"}, `log query limit must be an integer from 1 to 5000, found "x"`},
		{[]string{"--limit", "0"}, `log query limit must be an integer from 1 to 5000, found 0`},
		{[]string{"--order", "up"}, `log query order "up" is not one of asc, desc`},
		{[]string{"--after", "nonsense"}, `log query after must be {ts_us, role, boot, seq}, found "nonsense"`},
		{[]string{"--context", "1"}, `unknown option --context`},
		{[]string{"--around", "nonsense"}, `log query around must be {ts_us, role, boot, seq}, found "nonsense"`},
		{[]string{"--earlier", "2"}, `log query earlier needs around`},
		{[]string{"--around", "1/host/b1/2", "--later", "501"}, `log query later must be an integer from 0 to 500, found 501`},
		{[]string{"--around", "1/host/b1/2", "--level", "info"}, `log query around takes only channel, earlier and later, not level`},
	}
	for _, c := range cases {
		if stdout, stderr, code := runQueryCommand(t, config, c.args...); code != 2 || stdout != "" || !strings.Contains(stderr, c.want) {
			t.Errorf("%v: code %d stdout %q stderr %q want %q", c.args, code, stdout, stderr, c.want)
		}
	}
}
