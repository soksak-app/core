package tests

// Shared helpers of the tests of the log index and the log query (docs/spec/logging.md#index, docs/spec/logging.md#query):
// the golden fixtures of packages/log-contract/fixtures/query and the generated log that has more than one segment.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const queryFixtures = "../../../log-contract/fixtures/query"

// fixedModified is the modification time that the golden digests of the index assume for the source (docs/spec/logging.md#index).
var fixedModified = time.Unix(1_000_000_000, 0)

// setModified gives a source the modification time of the golden digests.
func setModified(t *testing.T, path string) {
	t.Helper()
	if err := os.Chtimes(path, fixedModified, fixedModified); err != nil {
		t.Fatal(err)
	}
}

// fixtureConfig copies the event files of the golden fixtures into the logs folder of a new configuration directory.
func fixtureConfig(t *testing.T) string {
	t.Helper()
	config := t.TempDir()
	logs := filepath.Join(config, "logs")
	if err := os.MkdirAll(logs, 0o755); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Join(queryFixtures, "logs"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		data, err := os.ReadFile(filepath.Join(queryFixtures, "logs", entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		target := filepath.Join(logs, entry.Name())
		if err := os.WriteFile(target, data, 0o644); err != nil {
			t.Fatal(err)
		}
		setModified(t, target)
	}
	return config
}

// queryCase is one case of cases.json: the parameters of the query, the flags of `sok debug query`, and the expected page.
type queryCase struct {
	Name    string           `json:"name"`
	Params  json.RawMessage  `json:"params"`
	Args    []string         `json:"args"`
	Rows    []string         `json:"rows"`
	Next    *cursorJSON      `json:"next"`
	Tail    map[string]int64 `json:"tail"`
	Scanned *scannedJSON     `json:"scanned"`
	Lines   []string         `json:"lines"`
}

type cursorJSON struct {
	TsUs int64  `json:"ts_us"`
	Role string `json:"role"`
	Boot string `json:"boot"`
	Seq  int64  `json:"seq"`
}

type scannedJSON struct {
	Logs     int `json:"logs"`
	Segments int `json:"segments"`
	Read     int `json:"read"`
	Lines    int `json:"lines"`
	Rebuilt  int `json:"rebuilt"`
}

func readCases(t *testing.T) []queryCase {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(queryFixtures, "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []queryCase
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 25 {
		t.Fatalf("the golden file holds %d cases", len(cases))
	}
	return cases
}

// bigEvent is one line of the generated log (the generator of packages/log-contract/fixtures/query/cases.json is the same in the Rust tests).
type bigEvent struct {
	line                  string
	tsUs, seq             int64
	level, layer, event   string
	session, surface, cid string
	text                  string
}

const (
	bigBase  = int64(1791500000000000)
	bigCount = 9000
)

var (
	bigLevels = []string{"error", "warn", "info", "debug", "trace"}
	bigLayers = []string{"native", "host", "page", "plugin", "sidecar", "sok"}
	bigGroups = []string{"input", "window", "sidecar", "call"}
	bigVerbs  = []string{"a", "b", "c"}
)

// generateEach calls emit for each of the n lines of the generated log in the order of seq: line 0 is log.open, line 2000 is host.test.start of run r-big, line 6000 is its
// host.test.end, and the clocks of every third line are 1,500 microseconds early, so the order of seq is not the order of time.
func generateEach(n int, emit func(bigEvent)) {
	for i := 0; i < n; i++ {
		e := bigEvent{seq: int64(i + 1), tsUs: bigBase + int64(i)*1000}
		if i%3 == 0 && i != 0 {
			e.tsUs -= 1500
		}
		mono := 9_000_000_000 + int64(i)*1000
		head := fmt.Sprintf(`{"ts_us":%d,"mono_ns":%d,"seq":%d,`, e.tsUs, mono, e.seq)
		switch i {
		case 0:
			e.level, e.layer, e.event = "info", "host", "log.open"
			e.line = head + `"level":"info","layer":"host","event":"log.open","fields":{"schema":2,"pid":1,"role":"host","boot":"big"}}`
		case 2000:
			e.level, e.layer, e.event = "info", "host", "host.test.start"
			e.line = head + `"level":"info","layer":"host","event":"host.test.start","fields":{"name":"a","run":"r-big"}}`
		case 6000:
			e.level, e.layer, e.event = "info", "host", "host.test.end"
			e.line = head + `"level":"info","layer":"host","event":"host.test.end","fields":{"name":"a","run":"r-big","result":"pass"}}`
		default:
			e.level, e.layer = bigLevels[i%5], bigLayers[i%6]
			e.event = e.layer + "." + bigGroups[i%4] + "." + bigVerbs[i%3]
			e.text = fmt.Sprintf("line %d", i)
			var b strings.Builder
			b.WriteString(head)
			fmt.Fprintf(&b, `"level":%q,"layer":%q,"event":%q,`, e.level, e.layer, e.event)
			if i%7 == 0 {
				e.session = fmt.Sprintf("x%d", i%20)
				fmt.Fprintf(&b, `"session":%q,`, e.session)
			}
			if i%10 == 0 {
				e.cid = fmt.Sprintf("c%d", i/10)
				fmt.Fprintf(&b, `"cids":[%q],`, e.cid)
			}
			fmt.Fprintf(&b, `"fields":{"n":%d,"text":%q`, i, e.text)
			if i%3 == 0 {
				e.surface = fmt.Sprintf("s%d", (i/3)%50)
				fmt.Fprintf(&b, `,"surface":%q`, e.surface)
			}
			b.WriteString("}}")
			e.line = b.String()
		}
		emit(e)
	}
}

func generateBig() []bigEvent {
	events := make([]bigEvent, 0, bigCount)
	generateEach(bigCount, func(e bigEvent) { events = append(events, e) })
	return events
}

// writeBig writes the generated log as host-big.jsonl in the logs folder of a new configuration directory and returns the folder and the path.
func writeBig(t *testing.T) (string, string, []bigEvent) {
	t.Helper()
	config := t.TempDir()
	logs := filepath.Join(config, "logs")
	if err := os.MkdirAll(logs, 0o755); err != nil {
		t.Fatal(err)
	}
	events := generateBig()
	var b strings.Builder
	for _, e := range events {
		b.WriteString(e.line)
		b.WriteByte('\n')
	}
	path := filepath.Join(logs, "host-big.jsonl")
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	setModified(t, path)
	return config, path, events
}

// idOf is the identity `<role>-<boot>:<seq>` that cases.json uses for a row.
func idOf(role, boot string, event json.RawMessage) (string, error) {
	var parsed struct {
		Seq int64 `json:"seq"`
	}
	if err := json.Unmarshal(event, &parsed); err != nil {
		return "", err
	}
	return fmt.Sprintf("%s-%s:%d", role, boot, parsed.Seq), nil
}
