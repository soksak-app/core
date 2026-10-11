//go:build !diagnostics

package tests

// The query on a log of 1,000,000 events (docs/spec/logging.md#query). The test builds the log, builds its index, and times a query
// of each kind and the first page, with the limit that each time must keep. It prints each time, so a run records the numbers that
// docs/features.md (F160.24.7) states. The diagnostics configurations skip it by the build tag: the numbers do not depend on them.

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/soksak-app/core/packages/sok/wailsv3/src"
)

const millionEvents = 1_000_000

// millionLimits are the limits of the times: the build of the index, a page without a filter (first page), a query of one cid, one
// event name or a short time range (selective), a query that fills a page of 5,000 rows from many segments (filtered), and a text
// that every segment must be searched for (text).
var millionLimits = struct {
	build, firstPage, selective, filtered, text time.Duration
}{build: 30 * time.Second, firstPage: 500 * time.Millisecond, selective: time.Second, filtered: 5 * time.Second, text: 10 * time.Second}

// contract: log.query.answers-a-million-events-within-the-limit
func TestLogQueryAnswersAMillionEventsWithinTheLimit(t *testing.T) {
	config := t.TempDir()
	logs := filepath.Join(config, "logs")
	if err := os.MkdirAll(logs, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(logs, "host-big.jsonl")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := bufio.NewWriterSize(file, 1<<20)
	var surfaceSeven, errorNative, runLines, timeRange int
	runStart, runEnd := int64(0), int64(0)
	var events []bigEvent
	generateEach(millionEvents, func(e bigEvent) {
		if e.surface == "s7" {
			surfaceSeven++
		}
		if e.level == "error" && e.layer == "native" {
			errorNative++
		}
		if e.tsUs >= bigBase+500_000_000 && e.tsUs <= bigBase+500_100_000 {
			timeRange++
		}
		switch e.seq {
		case 2001:
			runStart = e.tsUs
		case 6001:
			runEnd = e.tsUs
		}
		if e.seq <= 6001 {
			events = append(events, e)
		}
		writer.WriteString(e.line)
		writer.WriteByte('\n')
	})
	if err := writer.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	for _, e := range events {
		if e.tsUs >= runStart && e.tsUs <= runEnd {
			runLines++
		}
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("log: %d events, %.1f MB", millionEvents, float64(info.Size())/1e6)

	started := time.Now()
	update, err := sok.UpdateLogIndex(path)
	elapsed := time.Since(started)
	if err != nil || !update.Rebuilt || update.Lines != millionEvents {
		t.Fatalf("index build: %+v err %v", update, err)
	}
	t.Logf("index build: %v", elapsed)
	if elapsed > millionLimits.build {
		t.Errorf("the build of the index took %v, over %v", elapsed, millionLimits.build)
	}
	idx, err := os.Stat(path + ".idx")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("index size: %.1f MB", float64(idx.Size())/1e6)

	cases := []struct {
		name, params string
		limit        time.Duration
		rows         int
		lines        int
	}{
		{"first page", `{}`, millionLimits.firstPage, 500, 0},
		{"newest page", `{"order": "desc"}`, millionLimits.firstPage, 500, 0},
		{"cid", `{"cid": "c50000"}`, millionLimits.selective, 1, 0},
		{"exact event", `{"event": "host.test.end"}`, millionLimits.selective, 1, 0},
		{"event prefix", `{"event_prefix": "native.input", "limit": 5000}`, millionLimits.filtered, 5000, 0},
		{"surface", `{"surface": "s7", "limit": 5000}`, millionLimits.filtered, min(surfaceSeven, 5000), 0},
		{"time range", fmt.Sprintf(`{"from_us": %d, "to_us": %d}`, bigBase+500_000_000, bigBase+500_100_000), millionLimits.selective, timeRange, 0},
		{"level and layer", `{"level": "error", "layer": "native", "limit": 5000}`, millionLimits.filtered, min(errorNative, 5000), 0},
		{"run", `{"run": "r-big", "limit": 5000}`, millionLimits.filtered, min(runLines, 5000), 0},
		{"text", `{"text": "line 999999"}`, millionLimits.text, 1, 0},
	}
	for _, c := range cases {
		query, err := sok.ParseLogQuery([]byte(c.params))
		if err != nil {
			t.Fatal(err)
		}
		started := time.Now()
		page, err := sok.QueryLogs(config, query, nil)
		elapsed := time.Since(started)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		t.Logf("%-16s %9v  rows %-5d segments read %d of %d, lines %d", c.name, elapsed.Round(time.Microsecond), len(page.Rows), page.Scanned.Read, page.Scanned.Segments, page.Scanned.Lines)
		if len(page.Rows) != c.rows {
			t.Errorf("%s: %d rows, want %d", c.name, len(page.Rows), c.rows)
		}
		if elapsed > c.limit {
			t.Errorf("%s: %v is over the limit %v", c.name, elapsed, c.limit)
		}
	}
}
