//go:build !diagnostics

package tests

// The query on a log of 1,000,000 events (docs/spec/logging.md#query). The test builds the log, builds its index, and runs a query of
// each kind and the first page. It judges the rows of each query and the segments and lines that it reads, which the index decides and
// the load of the machine does not; it prints each time, which the benchmark targets measure after development (F160.24.7). The
// diagnostics configurations skip it by the build tag: the reads do not depend on them.

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/soksak-app/core/packages/sok/go/src"
)

const millionEvents = 1_000_000

// millionSegments is the number of segments of the index of the log of the test.
const millionSegments = 245

// contract: log.query.reads-what-each-query-of-a-million-events-needs
func TestLogQueryReadsWhatEachQueryOfAMillionEventsNeeds(t *testing.T) {
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
	idx, err := os.Stat(path + ".idx")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("index size: %.1f MB", float64(idx.Size())/1e6)

	cases := []struct {
		name, params    string
		rows            int
		segments, lines int
	}{
		{"first page", `{}`, 500, 1, 4096},
		{"newest page", `{"order": "desc"}`, 500, 1, 576},
		{"cid", `{"cid": "c50000"}`, 1, 1, 4096},
		{"exact event", `{"event": "host.test.end"}`, 1, 1, 4096},
		{"event prefix", `{"event_prefix": "native.input", "limit": 5000}`, 5000, 35, 143360},
		{"surface", `{"surface": "s7", "limit": 5000}`, min(surfaceSeven, 5000), 184, 753664},
		{"time range", fmt.Sprintf(`{"from_us": %d, "to_us": %d}`, bigBase+500_000_000, bigBase+500_100_000), timeRange, 1, 4096},
		{"level and layer", `{"level": "error", "layer": "native", "limit": 5000}`, min(errorNative, 5000), 43, 176128},
		{"run", `{"run": "r-big", "limit": 5000}`, min(runLines, 5000), 4, 16384},
		{"text", `{"text": "line 999999"}`, 1, 245, 1000000},
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
		if page.Scanned.Read != c.segments || page.Scanned.Segments != millionSegments || page.Scanned.Lines != c.lines {
			t.Errorf("%s: read %d of %d segments and %d lines, want %d of %d and %d", c.name, page.Scanned.Read, page.Scanned.Segments,
				page.Scanned.Lines, c.segments, millionSegments, c.lines)
		}
	}
}
