package tests

// `sok debug replay` (docs/spec/replay.md#command): the events of a session are replayed by the replay executable that an
// installed sidecar declares, and every stored hash of the sidecar and of the page is compared with the replayed one. The
// replay executable of these tests is a shell script that stands in for the engine of a sidecar: it counts the bytes of the
// inputs it reads and prints that count as the hash of each frame record.

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/sok/wailsv3/src"
)

const logOpen = `{"ts_us":%d,"mono_ns":%d,"seq":1,"level":"info","layer":"%s","event":"log.open","fields":{"schema":2,"pid":1,"role":"%s","boot":"b1"}}`

// fakeReplay prints, for each frame record it reads, the number of bytes of the inputs read so far as 64 decimal digits.
const fakeReplay = `#!/bin/sh
total=0
while IFS= read -r line; do
  case "$line" in
    *'"event":"sidecar.fake.input"'*)
      hex=${line#*'"hex":"'}; hex=${hex%%'"'*}
      total=$((total + ${#hex} / 2)) ;;
    *'"class":"frame"'*)
      sequence=${line#*'"sequence":'}; sequence=${sequence%%[,\}]*}
      printf '{"sequence":%s,"hash":"%064d"}\n' "$sequence" "$total" ;;
  esac
done
`

// replayInputs names the events of the fake sidecar of each kind of replay input.
const replayInputs = `{"output":"sidecar.fake.input","write":"sidecar.fake.write","resize":"sidecar.fake.resize","selection":"sidecar.fake.selection","viewport":"sidecar.fake.viewport","theme":"sidecar.fake.theme"}`

// digits is the hash that fakeReplay prints for a count of bytes.
func digits(n int) string { return fmt.Sprintf("%064d", n) }

// replayEvents holds the event lines of one session: two inputs, each followed by a frame record of the sidecar and of the page.
type replayEvents struct {
	sidecar []string
	page    []string
}

func input(ts, seq, sequence int, session, hex string) string {
	return fmt.Sprintf(`{"ts_us":%d,"mono_ns":%d,"seq":%d,"level":"debug","layer":"sidecar","class":"io","event":"sidecar.fake.input","session":"%s","fields":{"sequence":%d,"hex":"%s"}}`, ts, ts, seq, session, sequence, hex)
}

// frame is a frame record; the page frame record is the event of the plugin of the page (layer plugin), which names the segment
// b1 of the screen that it received.
func frame(layer string, ts, seq, sequence int, session, hash string) string {
	name, segment := "sidecar.fake.frame", ""
	if layer == "plugin" {
		name, segment = "plugin.fake.frame", `"segment":"b1",`
	}
	return fmt.Sprintf(`{"ts_us":%d,"mono_ns":%d,"seq":%d,"level":"debug","layer":"%s","class":"frame","event":"%s","session":"%s","fields":{"sequence":%d,%s"rows":2,"cols":3,"hash":"%s"}}`, ts, ts, seq, layer, name, session, sequence, segment, hash)
}

// theme is the first replay input of a segment (docs/spec/replay.md#view-state).
func theme(ts, seq int, session string) string {
	return fmt.Sprintf(`{"ts_us":%d,"mono_ns":%d,"seq":%d,"level":"debug","layer":"sidecar","class":"input","event":"sidecar.fake.theme","session":"%s","fields":{"sequence":1,"colors":{"foreground":"#c0c0c0","background":"#101010","selection":"#404080"}}}`, ts, ts, seq, session)
}

// standardEvents are a theme and the inputs "hi" (2 bytes) and "\r\n" (2 bytes) with a frame record after each, written consistently.
func standardEvents() replayEvents {
	return replayEvents{
		sidecar: []string{
			theme(1005, 1, "s1"),
			input(1010, 2, 2, "s1", "6869"),
			frame("sidecar", 1020, 3, 2, "s1", digits(2)),
			input(1030, 4, 3, "s1", "0d0a"),
			frame("sidecar", 1040, 5, 3, "s1", digits(4)),
		},
		page: []string{
			frame("plugin", 1025, 2, 2, "s1", digits(2)),
			frame("plugin", 1045, 3, 3, "s1", digits(4)),
		},
	}
}

func writeReplayFile(t *testing.T, path, text string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), mode); err != nil {
		t.Fatal(err)
	}
}

// replayConfig writes the event files of the sidecar role "fake" and of the host, and installs a sidecar that declares the
// replay executable with the given script and the given role.
func replayConfig(t *testing.T, events replayEvents, script, role string) string {
	t.Helper()
	config := t.TempDir()
	writeReplayFile(t, filepath.Join(config, "logs", "fake-b1.jsonl"), strings.Join(append([]string{fmt.Sprintf(logOpen, 1000, 1000, "sidecar", "fake")}, events.sidecar...), "\n")+"\n", 0o600)
	writeReplayFile(t, filepath.Join(config, "logs", "host-b1.jsonl"), strings.Join(append([]string{fmt.Sprintf(logOpen, 1001, 1001, "host", "host")}, events.page...), "\n")+"\n", 0o600)
	folder := "sidecars/probe-worker/1.0.0/darwin-arm64"
	writeReplayFile(t, filepath.Join(config, "plugins", "installed.json"), `{"format":3,"plugins":{"probe":{"version":"1.0.0","path":"plugins/probe/1.0.0","enabled":true,"sidecars":{"@probe/worker":"^1.0.0"}}},"sidecars":{"@probe/worker":{"version":"1.0.0","path":"`+folder+`"}}}`, 0o644)
	writeReplayFile(t, filepath.Join(config, folder, "sidecar.json"), `{"executable":"worker","protocol":1,"replay":{"role":"`+role+`","executable":"replay.sh","inputs":`+replayInputs+`}}`, 0o644)
	writeReplayFile(t, filepath.Join(config, folder, "replay.sh"), script, 0o755)
	return config
}

func runReplay(t *testing.T, config string, args ...string) (string, string, int) {
	t.Helper()
	return runReplayWith(t, sok.Run, config, args...)
}

// runReplayWith runs the command with the entrance run: sok.Run, or sok.Main, which also writes the event file of the run. The
// name of that file holds the second and the process, so one configuration directory takes one run of sok.Main.
func runReplayWith(t *testing.T, run func([]string, io.Writer, io.Writer, sok.Options) int, config string, args ...string) (string, string, int) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	all := append([]string{"debug", "replay", "--config-dir", config}, args...)
	code := run(all, &stdout, &stderr, sok.Options{Identifier: "app.soksak.wails"})
	return stdout.String(), stderr.String(), code
}

// contract: cli.debug.replay-equal
func TestReplayReportsEqualWhenEveryStoredHashIsTheReplayedOne(t *testing.T) {
	config := replayConfig(t, standardEvents(), fakeReplay, "fake")
	stdout, stderr, code := runReplay(t, config, "s1")
	if code != 0 || stdout != "replay session s1: 2 sidecar frames and 2 page frames equal in 1 segments\n" || stderr != "" {
		t.Errorf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: cli.debug.replay-until
func TestReplayStopsAtTheSequenceOfUntil(t *testing.T) {
	events := standardEvents()
	events.sidecar[3] = input(1030, 4, 3, "s1", "0d0a0a")
	config := replayConfig(t, events, fakeReplay, "fake")
	stdout, stderr, code := runReplay(t, config, "s1", "--until", "2")
	if code != 0 || stdout != "replay session s1: 1 sidecar frames and 1 page frames equal in 1 segments\n" || stderr != "" {
		t.Errorf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
	if _, stderr, code := runReplay(t, config, "s1", "--until", "3"); code != 1 || !strings.Contains(stderr, "sok: replay divergence: session s1 segment b1 sequence 3 layer sidecar expected "+digits(5)+" found "+digits(4)+"\n") {
		t.Errorf("until 3: code %d stderr %q", code, stderr)
	}
	if _, stderr, code := runReplay(t, config, "s1", "--until", "x"); code != 2 || !strings.Contains(stderr, "sok: --until must be a non-negative integer, found \"x\"") {
		t.Errorf("until x: code %d stderr %q", code, stderr)
	}
}

// divergence is the stored event of the tool that names the first divergence.
func divergence(t *testing.T, config string) string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(config, "logs", "sok-*.jsonl"))
	if err != nil || len(files) != 1 {
		t.Fatalf("event files of the tool %v %v", files, err)
	}
	data, err := os.ReadFile(files[0])
	if err != nil {
		t.Fatal(err)
	}
	var found []string
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if strings.Contains(line, `"event":"sok.replay.divergence"`) {
			found = append(found, line)
		}
	}
	if len(found) != 1 {
		t.Fatalf("%d divergence events in %s", len(found), data)
	}
	return found[0]
}

// contract: cli.debug.replay-divergence
func TestReplayReportsTheFirstDivergenceWithItsLayer(t *testing.T) {
	cases := []struct {
		name   string
		change func(*replayEvents)
		layer  string
		seq    int
		want   string
		found  string
	}{
		{"an input of the sidecar was altered", func(e *replayEvents) { e.sidecar[1] = input(1010, 2, 2, "s1", "686921") }, "sidecar", 2, digits(3), digits(2)},
		{"the hash of a frame of the sidecar was altered", func(e *replayEvents) { e.sidecar[4] = frame("sidecar", 1040, 5, 3, "s1", digits(9)) }, "sidecar", 3, digits(4), digits(9)},
		{"the hash of a drawn frame was altered", func(e *replayEvents) { e.page[1] = frame("plugin", 1045, 3, 3, "s1", digits(8)) }, "plugin", 3, digits(4), digits(8)},
		{"a page frame has no frame of the sidecar", func(e *replayEvents) { e.page = append(e.page, frame("plugin", 1050, 4, 4, "s1", digits(4))) }, "plugin", 4, "none", digits(4)},
	}
	for _, c := range cases {
		events := standardEvents()
		c.change(&events)
		config := replayConfig(t, events, fakeReplay, "fake")
		stdout, stderr, code := runReplayWith(t, sok.Main, config, "s1")
		message := fmt.Sprintf("replay divergence: session s1 segment b1 sequence %d layer %s expected %s found %s", c.seq, c.layer, c.want, c.found)
		if code != 1 || stdout != "" || stderr != "sok: "+message+"\n" {
			t.Errorf("%s: code %d stdout %q stderr %q, want %q", c.name, code, stdout, stderr, message)
		}
		fields := fmt.Sprintf(`"fields":{"expected":"%s","found":"%s","layer":"%s","segment":"b1","sequence":%d,"session":"s1"}`, c.want, c.found, c.layer, c.seq)
		if line := divergence(t, config); !strings.Contains(line, `"level":"error"`) || !strings.Contains(line, fields) {
			t.Errorf("%s: event %s, want the level error and %s", c.name, line, fields)
		}
	}
}

// contract: cli.debug.replay-errors
func TestReplayRefusesWhatItCannotCompare(t *testing.T) {
	noFrame := replayEvents{sidecar: standardEvents().sidecar[:2]}
	badStored := standardEvents()
	badStored.sidecar[2] = frame("sidecar", 1020, 3, 2, "s1", "ABC")
	cases := []struct {
		name   string
		events replayEvents
		script string
		role   string
		args   []string
		want   string
	}{
		{"no session", standardEvents(), fakeReplay, "fake", nil, "sok: session is required\n"},
		{"unknown session", standardEvents(), fakeReplay, "fake", []string{"s9"}, "sok: replay session s9: the event files hold no event of the layer sidecar for it\n"},
		{"no sidecar declares the role", standardEvents(), fakeReplay, "other", []string{"s1"}, "sok: replay session s1: no installed sidecar declares the replay role fake\n"},
		{"no frame record", noFrame, fakeReplay, "fake", []string{"s1"}, "sok: replay session s1: no frame record to compare\n"},
		{"a stored hash is not a hash", badStored, fakeReplay, "fake", []string{"s1"}, "sok: replay session s1: sequence 2 layer sidecar: the stored hash is not 64 lowercase hexadecimal characters: \"ABC\"\n"},
		{"the executable fails", standardEvents(), "#!/bin/sh\necho engine broke >&2\nexit 3\n", "fake", []string{"s1"}, "sok: replay session s1: replay.sh exited with status 3: engine broke\n"},
		{"the executable prints a line that is not a hash", standardEvents(), "#!/bin/sh\necho nope\n", "fake", []string{"s1"}, "sok: replay session s1: replay output line 1 is not {\"sequence\": <integer>, \"hash\": <64 lowercase hexadecimal characters>}: nope\n"},
		{"the executable prints no hash for a frame record", standardEvents(), "#!/bin/sh\ncat >/dev/null\n", "fake", []string{"s1"}, "sok: replay session s1: the replay executable reported no hash for the frame record at sequence 2\n"},
	}
	for _, c := range cases {
		config := replayConfig(t, c.events, c.script, c.role)
		_, stderr, code := runReplay(t, config, c.args...)
		if code == 0 || !strings.HasPrefix(stderr, c.want) {
			t.Errorf("%s: code %d stderr %q, want it to start with %q", c.name, code, stderr, c.want)
		}
	}
	// A session whose sidecar events come from two roles has no single replay executable.
	config := replayConfig(t, standardEvents(), fakeReplay, "fake")
	other := fmt.Sprintf(logOpen, 1002, 1002, "sidecar", "other") + "\n" + input(1050, 2, 4, "s1", "00") + "\n"
	writeReplayFile(t, filepath.Join(config, "logs", "other-b1.jsonl"), other, 0o600)
	want := "sok: replay session s1: sidecar events of more than one role: fake, other\n"
	if _, stderr, code := runReplay(t, config, "s1"); code != 1 || stderr != want {
		t.Errorf("two roles: code %d stderr %q, want %q", code, stderr, want)
	}
}

// segmentEvents is a second run of the sidecar (boot b2) whose sequence restarts at 1: three inputs of 3, 1 and 1 bytes, each
// followed by a frame record of the sidecar and of the page; the page frames name the segment they received.
func segmentEvents(session string) replayEvents {
	pageFrame := func(ts, seq, sequence int, hash string) string {
		return strings.Replace(frame("plugin", ts, seq, sequence, session, hash), `"segment":"b1"`, `"segment":"b2"`, 1)
	}
	return replayEvents{
		sidecar: []string{
			theme(2005, 1, session),
			input(2010, 2, 2, session, "00ff10"),
			frame("sidecar", 2020, 3, 2, session, digits(3)),
			input(2030, 4, 3, session, "aa"),
			frame("sidecar", 2040, 5, 3, session, digits(4)),
			input(2050, 6, 4, session, "bb"),
			frame("sidecar", 2060, 7, 4, session, digits(5)),
		},
		page: []string{pageFrame(2025, 4, 2, digits(3)), pageFrame(2045, 5, 3, digits(4)), pageFrame(2065, 6, 4, digits(5))},
	}
}

// segmentedConfig is the session of standardEvents (boot b1, its page frames naming b1) followed by segmentEvents (boot b2).
func segmentedConfig(t *testing.T, change func(first, second *replayEvents)) string {
	t.Helper()
	first, second := standardEvents(), segmentEvents("s1")
	if change != nil {
		change(&first, &second)
	}
	config := replayConfig(t, replayEvents{sidecar: first.sidecar, page: append(first.page, second.page...)}, fakeReplay, "fake")
	open := `{"ts_us":2000,"mono_ns":2000,"seq":1,"level":"info","layer":"sidecar","event":"log.open","fields":{"schema":2,"pid":2,"role":"fake","boot":"b2"}}`
	writeReplayFile(t, filepath.Join(config, "logs", "fake-b2.jsonl"), strings.Join(append([]string{open}, second.sidecar...), "\n")+"\n", 0o600)
	return config
}

// contract: cli.debug.replay-segments
func TestReplayComparesEachSegmentOfASessionWhoseSequenceRestarts(t *testing.T) {
	config := segmentedConfig(t, nil)
	stdout, stderr, code := runReplay(t, config, "s1")
	if code != 0 || stdout != "replay session s1: 5 sidecar frames and 5 page frames equal in 2 segments\n" || stderr != "" {
		t.Errorf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
	// A divergence in the second segment names the segment, which the sequence alone does not.
	altered := segmentedConfig(t, func(_, second *replayEvents) {
		second.sidecar[4] = frame("sidecar", 2040, 5, 3, "s1", digits(9))
	})
	stdout, stderr, code = runReplayWith(t, sok.Main, altered, "s1")
	want := "sok: replay divergence: session s1 segment b2 sequence 3 layer sidecar expected " + digits(4) + " found " + digits(9) + "\n"
	if code != 1 || stdout != "" || stderr != want {
		t.Errorf("code %d stdout %q stderr %q, want %q", code, stdout, stderr, want)
	}
	fields := `"fields":{"expected":"` + digits(4) + `","found":"` + digits(9) + `","layer":"sidecar","segment":"b2","sequence":3,"session":"s1"}`
	if line := divergence(t, altered); !strings.Contains(line, fields) {
		t.Errorf("event %s, want %s", line, fields)
	}
	// --until applies to the sequence of each segment.
	stdout, stderr, code = runReplay(t, config, "s1", "--until", "2")
	if code != 0 || stdout != "replay session s1: 2 sidecar frames and 2 page frames equal in 2 segments\n" || stderr != "" {
		t.Errorf("until 2: code %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: cli.debug.replay-holds-one-segment
func TestReplayHoldsTheEventLinesOfOneSegmentAtATime(t *testing.T) {
	config := segmentedConfig(t, nil)
	result, err := sok.ReplayLogs(config, "s1", nil)
	if err != nil {
		t.Fatal(err)
	}
	// The segments hold 5 and 7 event lines; the session holds 12.
	if result.Segments != 2 || result.HeldLines != 7 {
		t.Errorf("segments %d held lines %d, want 2 and 7", result.Segments, result.HeldLines)
	}
}

// contract: cli.debug.replay-segment-errors
func TestReplayRefusesAPageFrameThatNamesNoSegmentOfTheSession(t *testing.T) {
	cases := []struct {
		name   string
		change func(first, second *replayEvents)
		want   string
	}{
		{"a page frame without a segment", func(first, _ *replayEvents) {
			first.page[0] = strings.Replace(first.page[0], `"segment":"b1",`, "", 1)
		}, "sok: replay session s1: the page frame record at sequence 2 has no fields.segment\n"},
		{"a page frame of a segment the session does not have", func(first, _ *replayEvents) {
			first.page[0] = strings.Replace(first.page[0], `"segment":"b1"`, `"segment":"b9"`, 1)
		}, "sok: replay session s1: the page frame record at sequence 2 names the segment b9, which the session does not have\n"},
		{"a page frame whose segment is not text", func(first, _ *replayEvents) {
			first.page[0] = strings.Replace(first.page[0], `"segment":"b1"`, `"segment":7`, 1)
		}, "sok: replay session s1: the page frame record at sequence 2 has a fields.segment that is not text\n"},
	}
	for _, c := range cases {
		config := segmentedConfig(t, c.change)
		if _, stderr, code := runReplay(t, config, "s1"); code != 1 || stderr != c.want {
			t.Errorf("%s: code %d stderr %q, want %q", c.name, code, stderr, c.want)
		}
	}
	// The screen message carries the segment, so a page frame without it is refused in a session with one segment too.
	events := standardEvents()
	events.page[0] = strings.Replace(events.page[0], `"segment":"b1",`, "", 1)
	single := "sok: replay session s1: the page frame record at sequence 2 has no fields.segment\n"
	if _, stderr, code := runReplay(t, replayConfig(t, events, fakeReplay, "fake"), "s1"); code != 1 || stderr != single {
		t.Errorf("one segment: code %d stderr %q, want %q", code, stderr, single)
	}
	// The events of two runs of the sidecar that alternate in time are not segments.
	config := segmentedConfig(t, func(first, _ *replayEvents) {
		first.sidecar = append(first.sidecar, input(3000, 6, 4, "s1", "00"))
	})
	want := "sok: replay session s1: the sidecar events of the segments b1 and b2 are interleaved\n"
	if _, stderr, code := runReplay(t, config, "s1"); code != 1 || stderr != want {
		t.Errorf("interleaved: code %d stderr %q, want %q", code, stderr, want)
	}
}
