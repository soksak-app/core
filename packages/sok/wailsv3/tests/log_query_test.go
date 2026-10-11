package tests

// The query over the event files (docs/spec/logging.md#query): the golden pages, the cursor, the tail, the run, the refusals and the
// segments that a query reads. The generated log is checked against a reference that filters every event of the log.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/sok/wailsv3/src"
)

func runQuery(t *testing.T, config, params string) sok.LogPage {
	t.Helper()
	query, err := sok.ParseLogQuery([]byte(params))
	if err != nil {
		t.Fatalf("%s: %v", params, err)
	}
	page, err := sok.QueryLogs(config, query, nil)
	if err != nil {
		t.Fatalf("%s: %v", params, err)
	}
	return page
}

func rowIDs(t *testing.T, page sok.LogPage) []string {
	t.Helper()
	ids := make([]string, 0, len(page.Rows))
	for _, row := range page.Rows {
		id, err := idOf(row.Role, row.Boot, row.Event)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	return ids
}

// contract: log.query.answers-the-golden-pages
func TestLogQueryAnswersTheGoldenPages(t *testing.T) {
	for _, c := range readCases(t) {
		config := fixtureConfig(t)
		page := runQuery(t, config, string(c.Params))
		if got := rowIDs(t, page); !reflect.DeepEqual(got, append([]string{}, c.Rows...)) {
			t.Errorf("%s: rows %v, want %v", c.Name, got, c.Rows)
		}
		var next *cursorJSON
		if page.Next != nil {
			next = &cursorJSON{page.Next.TsUs, page.Next.Role, page.Next.Boot, page.Next.Seq}
		}
		if !reflect.DeepEqual(next, c.Next) {
			t.Errorf("%s: next %+v, want %+v", c.Name, next, c.Next)
		}
		if !reflect.DeepEqual(page.Tail, c.Tail) {
			t.Errorf("%s: tail %v, want %v", c.Name, page.Tail, c.Tail)
		}
		if c.Scanned != nil {
			got := scannedJSON{page.Scanned.Logs, page.Scanned.Segments, page.Scanned.Read, page.Scanned.Lines, 0}
			if got != *c.Scanned {
				t.Errorf("%s: scanned %+v, want %+v", c.Name, got, *c.Scanned)
			}
		}
		if page.Scanned.Rebuilt != page.Scanned.Logs {
			t.Errorf("%s: %d indexes were built for %d files that had none", c.Name, page.Scanned.Rebuilt, page.Scanned.Logs)
		}
		for i, row := range page.Rows {
			line, err := sok.LogLine(row.Event)
			if err != nil || line != c.Lines[i] {
				t.Errorf("%s: line %d is %q (%v), want %q", c.Name, i, line, err, c.Lines[i])
			}
		}
	}
}

// bigKey orders the events of the generated log by the key of a row.
func sortedBig(events []bigEvent) []bigEvent {
	sorted := append([]bigEvent(nil), events...)
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i].tsUs != sorted[j].tsUs {
			return sorted[i].tsUs < sorted[j].tsUs
		}
		return sorted[i].seq < sorted[j].seq
	})
	return sorted
}

func seqsOf(t *testing.T, page sok.LogPage) []int64 {
	t.Helper()
	seqs := make([]int64, 0, len(page.Rows))
	for _, row := range page.Rows {
		var parsed struct {
			Seq int64 `json:"seq"`
		}
		if err := json.Unmarshal(row.Event, &parsed); err != nil {
			t.Fatal(err)
		}
		seqs = append(seqs, parsed.Seq)
	}
	return seqs
}

func pageThrough(t *testing.T, config string, params map[string]any) []int64 {
	t.Helper()
	var seqs []int64
	for pages := 0; ; pages++ {
		if pages > 100 {
			t.Fatal("the pages do not end")
		}
		text, err := json.Marshal(params)
		if err != nil {
			t.Fatal(err)
		}
		page := runQuery(t, config, string(text))
		seqs = append(seqs, seqsOf(t, page)...)
		if page.Next == nil {
			return seqs
		}
		params["after"] = page.Next
	}
}

// contract: log.query.pages-through-the-cursor
func TestLogQueryPagesThroughTheCursor(t *testing.T) {
	config, _, events := writeBig(t)
	sorted := sortedBig(events)
	for _, order := range []string{"asc", "desc"} {
		for _, limit := range []int{1000, 4096, 5000} {
			got := pageThrough(t, config, map[string]any{"order": order, "limit": limit})
			if len(got) != len(sorted) {
				t.Fatalf("%s %d: %d rows in the pages, %d in the log", order, limit, len(got), len(sorted))
			}
			for i, e := range sorted {
				want := e.seq
				if order == "desc" {
					want = sorted[len(sorted)-1-i].seq
				}
				if got[i] != want {
					t.Fatalf("%s %d: row %d is seq %d, want %d", order, limit, i, got[i], want)
				}
			}
		}
	}

	// The page ends before the byte bound of 8,388,608 bytes of lines and always holds one row.
	heavy := t.TempDir()
	logs := filepath.Join(heavy, "logs")
	if err := os.MkdirAll(logs, 0o755); err != nil {
		t.Fatal(err)
	}
	var b strings.Builder
	b.WriteString(eventLineOf(1) + "\n")
	for seq := 2; seq <= 12; seq++ {
		fmt.Fprintf(&b, `{"ts_us":%d,"mono_ns":%d,"seq":%d,"level":"info","layer":"host","event":"host.x.y","fields":{"text":"%s"}}`+"\n", 1000+seq, seq, seq, strings.Repeat("x", 1_000_000))
	}
	if err := os.WriteFile(filepath.Join(logs, "host-h.jsonl"), []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	page := runQuery(t, heavy, `{"limit": 500}`)
	if len(page.Rows) != 9 || page.Next == nil || page.Next.Seq != 9 {
		t.Fatalf("a page of lines of about 1,000,000 bytes holds %d rows and next %+v, want the small first line and 8 of them, and the cursor of seq 9", len(page.Rows), page.Next)
	}
	rest := runQuery(t, heavy, fmt.Sprintf(`{"limit": 500, "after": {"ts_us": %d, "role": "host", "boot": "h", "seq": 9}}`, 1009))
	if len(rest.Rows) != 3 || rest.Next != nil {
		t.Fatalf("the page after it holds %d rows and next %+v, want the 3 rows that remain", len(rest.Rows), rest.Next)
	}
	// A line over the bound still makes a page of its own.
	one := t.TempDir()
	if err := os.MkdirAll(filepath.Join(one, "logs"), 0o755); err != nil {
		t.Fatal(err)
	}
	huge := eventLineOf(1) + "\n" + fmt.Sprintf(`{"ts_us":2000,"mono_ns":2,"seq":2,"level":"info","layer":"host","event":"host.x.y","fields":{"text":"%s"}}`+"\n", strings.Repeat("y", 9_000_000))
	if err := os.WriteFile(filepath.Join(one, "logs", "host-h.jsonl"), []byte(huge), 0o644); err != nil {
		t.Fatal(err)
	}
	if page := runQuery(t, one, `{"order": "desc", "limit": 5}`); len(page.Rows) != 1 || page.Next == nil {
		t.Fatalf("a line over the byte bound: %d rows, next %+v", len(page.Rows), page.Next)
	}
}

// contract: log.query.follows-the-tail-with-since
func TestLogQueryFollowsTheTailWithSince(t *testing.T) {
	config := fixtureConfig(t)
	first := runQuery(t, config, `{"channel": "all"}`)
	if len(first.Rows) != 18 {
		t.Fatalf("the first answer holds %d rows", len(first.Rows))
	}
	// Two lines are appended; the first has a clock that is earlier than rows the first answer held.
	path := filepath.Join(config, "logs", "host-b1.jsonl")
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	extra := `{"ts_us":1791500000500000,"mono_ns":10,"seq":23,"level":"info","layer":"host","event":"host.late","fields":{}}` + "\n" +
		`{"ts_us":1791500009000000,"mono_ns":11,"seq":24,"level":"info","layer":"host","event":"host.last","fields":{}}` + "\n"
	if _, err := file.WriteString(extra); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	text, err := json.Marshal(map[string]any{"channel": "all", "since": first.Tail})
	if err != nil {
		t.Fatal(err)
	}
	followed := runQuery(t, config, string(text))
	if got := seqsOf(t, followed); !reflect.DeepEqual(got, []int64{23, 24}) {
		t.Fatalf("the rows after the tail are %v, want [23 24]", got)
	}
	if followed.Tail["host-b1"] != 24 || followed.Tail["vt-v1"] != 4 {
		t.Errorf("the new tail is %v: host-b1 covers the file and the debug file", followed.Tail)
	}
	// The row with the earlier clock is not behind the cursor of the rows the first answer held, so only `since` finds it.
	cursor := first.Rows[len(first.Rows)-1]
	after, err := json.Marshal(map[string]any{"channel": "all", "after": map[string]any{"ts_us": 1791500002000100, "role": cursor.Role, "boot": cursor.Boot, "seq": 2}})
	if err != nil {
		t.Fatal(err)
	}
	if got := seqsOf(t, runQuery(t, config, string(after))); !reflect.DeepEqual(got, []int64{24}) {
		t.Fatalf("the rows after the cursor of the newest row are %v, want only the row with the later clock", got)
	}
}

// contract: log.query.resolves-a-run-to-the-range-of-its-marks
func TestLogQueryResolvesARunToTheRangeOfItsMarks(t *testing.T) {
	config, _, events := writeBig(t)
	start, end := events[2000].tsUs, events[6000].tsUs
	var want []int64
	for _, e := range sortedBig(events) {
		if e.tsUs >= start && e.tsUs <= end {
			want = append(want, e.seq)
		}
	}
	if got := pageThrough(t, config, map[string]any{"run": "r-big", "limit": 5000}); !reflect.DeepEqual(got, want) {
		t.Fatalf("run r-big has %d rows, the marks bound %d", len(got), len(want))
	}
	// The run combines with the bounds by intersection.
	bounded := pageThrough(t, config, map[string]any{"run": "r-big", "from_us": start + 1000000, "to_us": start + 1500000, "limit": 5000})
	var wantBounded []int64
	for _, e := range sortedBig(events) {
		if e.tsUs >= start+1000000 && e.tsUs <= start+1500000 {
			wantBounded = append(wantBounded, e.seq)
		}
	}
	if !reflect.DeepEqual(bounded, wantBounded) {
		t.Fatalf("run with bounds has %d rows, want %d", len(bounded), len(wantBounded))
	}

	// A start without an end bounds the run to the end of the files.
	open := t.TempDir()
	if err := os.MkdirAll(filepath.Join(open, "logs"), 0o755); err != nil {
		t.Fatal(err)
	}
	text := eventLineOf(1) + "\n" + eventLineOf(2) + "\n" +
		`{"ts_us":5000,"mono_ns":3,"seq":3,"level":"info","layer":"host","event":"host.test.start","fields":{"name":"a","run":"r-open"}}` + "\n" +
		`{"ts_us":6000,"mono_ns":4,"seq":4,"level":"debug","layer":"host","event":"host.x.y","fields":{}}` + "\n" +
		`{"ts_us":7000,"mono_ns":5,"seq":5,"level":"debug","layer":"host","event":"host.x.y","fields":{}}` + "\n"
	if err := os.WriteFile(filepath.Join(open, "logs", "host-o.jsonl"), []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := seqsOf(t, runQuery(t, open, `{"run": "r-open"}`)); !reflect.DeepEqual(got, []int64{3, 4, 5}) {
		t.Fatalf("an open run holds %v, want [3 4 5]", got)
	}

	query, err := sok.ParseLogQuery([]byte(`{"run": "r1", "channel": "debug"}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sok.QueryLogs(fixtureConfig(t), query, nil); err == nil || err.Error() != `log query run "r1" has no host.test.start in the channel` {
		t.Fatalf("a run without a start: %v", err)
	}
}

// contract: log.query.refuses-invalid-parameters
func TestLogQueryRefusesInvalidParameters(t *testing.T) {
	cases := []struct{ params, want string }{
		{`{"nope": 1}`, `log query has no parameter nope`},
		{`{"channel": "x"}`, `log query channel "x" is not one of other, debug, all`},
		{`{"channel": 3}`, `log query channel 3 is not one of other, debug, all`},
		{`{"level": "loud"}`, `log query level "loud" is not one of error, warn, info, debug, trace`},
		{`{"class": "x"}`, `log query class "x" is not one of lifecycle, input, call, io, frame`},
		{`{"layer": "x"}`, `log query layer "x" is not one of native, host, page, plugin, sidecar, sok`},
		{`{"event": ""}`, `log query event must be a non-empty string, found ""`},
		{`{"surface": 7}`, `log query surface must be a non-empty string, found 7`},
		{`{"text": null}`, `log query text must be a non-empty string, found null`},
		{`{"from_us": -1}`, `log query from_us must be a non-negative integer, found -1`},
		{`{"to_us": 1.5}`, `log query to_us must be a non-negative integer, found 1.5`},
		{`{"from_us": 5, "to_us": 4}`, `log query from_us is later than to_us: 5 4`},
		{`{"limit": 0}`, `log query limit must be an integer from 1 to 5000, found 0`},
		{`{"limit": 5001}`, `log query limit must be an integer from 1 to 5000, found 5001`},
		{`{"limit": "9"}`, `log query limit must be an integer from 1 to 5000, found "9"`},
		{`{"order": "up"}`, `log query order "up" is not one of asc, desc`},
		{`{"after": {"ts_us": 1}}`, `log query after must be {ts_us, role, boot, seq}, found {"ts_us":1}`},
		{`{"after": 3}`, `log query after must be {ts_us, role, boot, seq}, found 3`},
		{`{"since": {"host-a": "x"}}`, `log query since must map process names to integers, found {"host-a":"x"}`},
		{`{"event": "a.b", "event_prefix": "a"}`, `log query takes event or event_prefix, not both`},
		{`{"event_prefix": "a."}`, `log query event_prefix "a." must not end with a dot`},
	}
	for _, c := range cases {
		if _, err := sok.ParseLogQuery([]byte(c.params)); err == nil || err.Error() != c.want {
			t.Errorf("%s: error %v, want %q", c.params, err, c.want)
		}
	}
	if query, err := sok.ParseLogQuery([]byte(`{}`)); err != nil || query.Limit != 500 || query.Channel != "other" || query.Order != "asc" || query.Level != "trace" {
		t.Errorf("the defaults are %+v (%v)", query, err)
	}

	// A file that breaks the event structure fails the query with the file and the line.
	config := fixtureConfig(t)
	file, err := os.OpenFile(filepath.Join(config, "logs", "vt-v1.jsonl"), os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString("not json\n"); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	query, err := sok.ParseLogQuery([]byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sok.QueryLogs(config, query, nil); err == nil || !strings.Contains(err.Error(), "logs/vt-v1.jsonl:5: not JSON: not json") {
		t.Errorf("broken line: %v", err)
	}
	if _, err := sok.QueryLogs(t.TempDir(), query, nil); err == nil || !strings.Contains(err.Error(), "logs") {
		t.Errorf("no logs folder: %v", err)
	}
}

// matches is the reference of the query: it tests one generated event against the parameters of a query.
func matches(e bigEvent, p map[string]any) bool {
	levelRank := map[string]int{"error": 0, "warn": 1, "info": 2, "debug": 3, "trace": 4}
	if v, ok := p["level"]; ok && levelRank[e.level] > levelRank[v.(string)] {
		return false
	}
	if v, ok := p["layer"]; ok && e.layer != v {
		return false
	}
	if v, ok := p["event"]; ok && e.event != v {
		return false
	}
	if v, ok := p["event_prefix"]; ok && e.event != v && !strings.HasPrefix(e.event, v.(string)+".") {
		return false
	}
	if v, ok := p["surface"]; ok && e.surface != v {
		return false
	}
	if v, ok := p["session"]; ok && e.session != v {
		return false
	}
	if v, ok := p["cid"]; ok && e.cid != v {
		return false
	}
	if v, ok := p["from_us"]; ok && e.tsUs < int64(v.(int)) {
		return false
	}
	if v, ok := p["to_us"]; ok && e.tsUs > int64(v.(int)) {
		return false
	}
	if v, ok := p["text"]; ok && !strings.Contains(asciiLower(e.line), asciiLower(v.(string))) {
		return false
	}
	return true
}

func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

// contract: log.query.pages-through-the-cursor
func TestLogQueryAgreesWithTheReferenceOnTheGeneratedLog(t *testing.T) {
	config, _, events := writeBig(t)
	sorted := sortedBig(events)
	base := int(bigBase)
	queries := []map[string]any{
		{"level": "warn"},
		{"level": "error", "layer": "native"},
		{"layer": "page", "level": "info"},
		{"event": "host.call.b"},
		{"event_prefix": "native.input"},
		{"event_prefix": "sidecar"},
		{"surface": "s7"},
		{"surface": "s49", "level": "debug"},
		{"session": "x7"},
		{"cid": "c500"},
		{"cid": "c899"},
		{"from_us": base + 4_000_000, "to_us": base + 4_100_000},
		{"text": "LINE 77"},
		{"text": "line 8999"},
		{"layer": "sok", "event_prefix": "sok.window", "from_us": base + 1_000_000},
	}
	for _, q := range queries {
		var want []int64
		for _, e := range sorted {
			if matches(e, q) {
				want = append(want, e.seq)
			}
		}
		params := map[string]any{"limit": 5000}
		for k, v := range q {
			params[k] = v
		}
		got := pageThrough(t, config, params)
		if !reflect.DeepEqual(got, append([]int64(nil), want...)) && !(len(got) == 0 && len(want) == 0) {
			t.Errorf("%v: %d rows, the reference finds %d", q, len(got), len(want))
		}
	}
}

// contract: log.query.reads-only-the-segments-that-can-hold-a-row
func TestLogQueryReadsOnlyTheSegmentsThatCanHoldARow(t *testing.T) {
	config, _, events := writeBig(t)
	cases := []struct {
		name, params string
		reads        int
		rows         int
	}{
		{"cid", `{"cid": "c500"}`, 1, 1},
		{"exact event", `{"event": "host.test.end"}`, 1, 1},
		{"time range", fmt.Sprintf(`{"from_us": %d, "to_us": %d}`, bigBase+5_000_000, bigBase+5_010_000), 1, 10},
		{"first page", `{"limit": 10}`, 1, 10},
		{"last page", `{"order": "desc", "limit": 10}`, 1, 10},
		{"text", `{"text": "line 8999"}`, 3, 1},
	}
	for _, c := range cases {
		page := runQuery(t, config, c.params)
		if page.Scanned.Segments != 3 || page.Scanned.Read > c.reads || (c.name == "text" && page.Scanned.Read != 3) || len(page.Rows) != c.rows {
			t.Errorf("%s: scanned %+v with %d rows, want at most %d segments of 3 read and %d rows", c.name, page.Scanned, len(page.Rows), c.reads, c.rows)
		}
	}
	// The time range holds the lines whose clocks are in it, among them lines of the next segment boundary.
	var want int
	for _, e := range events {
		if e.tsUs >= bigBase+5_000_000 && e.tsUs <= bigBase+5_010_000 {
			want++
		}
	}
	if want != 10 {
		t.Fatalf("the reference counts %d lines in the range, and the query answered 10", want)
	}
}
