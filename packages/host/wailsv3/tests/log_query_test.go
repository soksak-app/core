// The index of the event files and the query over them (docs/spec/logging.md#index, docs/spec/logging.md#query): the endpoint method
// `log.query`, the host call `logQuery`, the index that follows the writer, and the event of an index that is built from the file.
package host_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// eventLines returns the lines of an event file of boot b1: log.open as seq 1 and then host.x.y events up to seq count.
func eventLines(count int) string {
	var b strings.Builder
	b.WriteString(`{"ts_us":1000,"mono_ns":1,"seq":1,"level":"info","layer":"host","event":"log.open","fields":{"schema":2,"pid":1,"role":"host","boot":"b1"}}` + "\n")
	for seq := 2; seq <= count; seq++ {
		fmt.Fprintf(&b, `{"ts_us":%d,"mono_ns":%d,"seq":%d,"level":"debug","layer":"host","event":"host.x.y","fields":{"n":%d}}`+"\n", 1000+seq, seq, seq, seq)
	}
	return b.String()
}

func writeEventFile(t *testing.T, config, name, text string) string {
	t.Helper()
	logs := filepath.Join(config, "logs")
	if err := os.MkdirAll(logs, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(logs, name)
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// contract: log.endpoint.query-answers-one-page
func TestTheEndpointMethodLogQueryAnswersOnePage(t *testing.T) {
	_, address, config := serve(t, newFakeBackend())
	path := writeEventFile(t, config, "host-b1.jsonl", eventLines(5))
	conn := dial(t, address)
	reply := call(t, conn, 1, "log.query", map[string]any{"channel": "all", "limit": 3})
	if reply.Error != nil {
		t.Fatalf("log.query failed: %+v", reply.Error)
	}
	var page struct {
		Rows []struct {
			Role, Boot, File string
			Offset           int64
			Event            struct{ Seq int64 }
		}
		Next    *struct{ Seq int64 }
		Tail    map[string]int64
		Scanned struct{ Logs, Segments, Read, Lines, Rebuilt int }
	}
	if err := json.Unmarshal(reply.Result, &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Rows) != 3 || page.Rows[0].Event.Seq != 1 || page.Rows[2].Event.Seq != 3 || page.Rows[0].File != "logs/host-b1.jsonl" || page.Rows[0].Role != "host" || page.Rows[0].Boot != "b1" {
		t.Fatalf("rows %+v", page.Rows)
	}
	if page.Next == nil || page.Next.Seq != 3 || page.Tail["host-b1"] != 5 || page.Scanned.Logs != 1 || page.Scanned.Rebuilt != 1 {
		t.Fatalf("next %+v tail %v scanned %+v", page.Next, page.Tail, page.Scanned)
	}

	refused := call(t, conn, 2, "log.query", map[string]any{"level": "loud"})
	if refused.Error == nil || refused.Error.Code != -32602 || refused.Error.Message != `log query level "loud" is not one of error, warn, info, debug, trace` {
		t.Fatalf("a refused parameter: %+v", refused.Error)
	}
	if none := call(t, conn, 3, "log.query", nil); none.Error == nil || none.Error.Code != -32602 || none.Error.Message != "params must be an object" {
		t.Fatalf("no params: %+v", none.Error)
	}
	appended, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := appended.WriteString("not json\n"); err != nil {
		t.Fatal(err)
	}
	appended.Close()
	broken := call(t, conn, 4, "log.query", map[string]any{})
	if broken.Error == nil || broken.Error.Code != -32000 || !strings.Contains(broken.Error.Message, "logs/host-b1.jsonl:6: not JSON: not json") {
		t.Fatalf("a broken line: %+v", broken.Error)
	}
}

// contract: debug.log-query.answers-the-query-of-the-endpoint
func TestTheHostCallLogQueryAnswersTheQueryOfTheEndpoint(t *testing.T) {
	_, address, config := serve(t, newFakeBackend())
	writeEventFile(t, config, "host-b1.jsonl", eventLines(8))
	conn := dial(t, address)
	request := map[string]any{"order": "desc", "limit": 4, "event_prefix": "host.x"}
	reply := call(t, conn, 1, "log.query", request)
	if reply.Error != nil {
		t.Fatalf("log.query failed: %+v", reply.Error)
	}
	text, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	page, invalid, err := host.QueryEventLogs(config, text)
	if err != nil || invalid {
		t.Fatalf("the query of the host call: invalid %v err %v", invalid, err)
	}
	encoded, err := json.Marshal(page)
	if err != nil {
		t.Fatal(err)
	}
	var fromCall, fromEndpoint any
	if err := json.Unmarshal(encoded, &fromCall); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(reply.Result, &fromEndpoint); err != nil {
		t.Fatal(err)
	}
	// The second query found the index built by the first one.
	if !reflect.DeepEqual(strip(fromCall), strip(fromEndpoint)) {
		t.Fatalf("the host call answered %s, the endpoint %s", encoded, reply.Result)
	}
	// The host call is a method that the call entrance finds by its name, and its error is the text of the query.
	bindings, err := host.NewBindings(&host.Host{})
	if err != nil {
		t.Fatal(err)
	}
	_, err = bindings.Call(context.Background(), "LogQuery", []json.RawMessage{json.RawMessage(`{"level":"loud"}`)}, nil)
	if err == nil || err.Error() != `log query level "loud" is not one of error, warn, info, debug, trace` {
		t.Fatalf("the error of the host call: %v", err)
	}
}

// strip removes the count of the indexes that the query built, which differs between a query that built them and one that found them.
func strip(page any) any {
	if m, ok := page.(map[string]any); ok {
		if scanned, ok := m["scanned"].(map[string]any); ok {
			delete(scanned, "rebuilt")
		}
	}
	return page
}

type indexResult struct {
	update sok.IndexUpdate
	err    error
}

// contract: log.writer.indexes-each-batch-it-wrote
func TestTheIndexCoversEachBatchTheWriterWrote(t *testing.T) {
	config := t.TempDir()
	logs := filepath.Join(config, "logs")
	options := eventLogOptions(logs)
	options.RotateBytes = 6 << 10
	options.Generations = 3
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(log.Close)
	results := make(chan indexResult, 256)
	observe, stop := host.StartLogIndexer(func(_ string, update sok.IndexUpdate, err error) { results <- indexResult{update, err} })
	t.Cleanup(stop)
	log.SetOnWrite(observe)
	for i := 0; i < 80; i++ {
		log.Emit(host.LevelInfo, "host.x.y", map[string]any{"n": i, "text": strings.Repeat("x", 120)})
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	// The index of the file covers the lines of the batches without a query: wait for the updates that the writes caused.
	lines := func(path string) int64 {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		return int64(strings.Count(string(data), "\n"))
	}
	covered := func() bool {
		info, err := sok.ReadLogIndex(log.Path())
		return err == nil && info.Events == lines(log.Path())
	}
	for !covered() {
		result := <-results
		if result.err != nil {
			t.Fatalf("an update of the index failed: %v", result.err)
		}
	}
	// The writer rotated at least once, and the index of each closed generation covers its whole file without a build.
	closed := 0
	for n := 1; n <= 3; n++ {
		path := fmt.Sprintf("%s.%d", log.Path(), n)
		if _, err := os.Stat(path); err != nil {
			continue
		}
		closed++
		info, err := sok.ReadLogIndex(path)
		if err != nil || info.Events != lines(path) {
			t.Fatalf("generation %d: index %+v (%v) for %d lines", n, info, err, lines(path))
		}
		if update, err := sok.UpdateLogIndex(path); err != nil || update.Changed {
			t.Fatalf("generation %d needed a build: %+v (%v)", n, update, err)
		}
	}
	if closed == 0 {
		t.Fatal("the writer did not rotate")
	}
}

// contract: log.writer.stores-an-event-for-each-index-built-from-the-file
func TestAnIndexBuiltFromTheFileIsAnEventAndAnAppendIsNot(t *testing.T) {
	log := useEventLog(t)
	config := t.TempDir()
	path := writeEventFile(t, config, "host-x1.jsonl", eventLines(6))
	rebuilt := func() []map[string]any {
		t.Helper()
		if err := log.Flush(5 * time.Second); err != nil {
			t.Fatal(err)
		}
		var found []map[string]any
		for _, event := range readEventLog(t, log.Path()) {
			if event["event"] == "host.log.index_rebuilt" {
				found = append(found, event)
			}
		}
		return found
	}
	if _, invalid, err := host.QueryEventLogs(config, []byte(`{}`)); err != nil || invalid {
		t.Fatalf("query: invalid %v err %v", invalid, err)
	}
	found := rebuilt()
	if len(found) != 1 {
		t.Fatalf("%d events host.log.index_rebuilt, want 1: %v", len(found), found)
	}
	fields := found[0]["fields"].(map[string]any)
	if found[0]["level"] != "info" || fields["file"] != "logs/host-x1.jsonl" || fields["reason"] != "the index did not exist" || fields["lines"] != float64(6) ||
		fields["bytes"].(float64) <= 0 || fields["micros"].(float64) < 0 {
		t.Fatalf("event %v", found[0])
	}
	appended, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := appended.WriteString(`{"ts_us":2000,"mono_ns":9,"seq":7,"level":"info","layer":"host","event":"host.x.y","fields":{}}` + "\n"); err != nil {
		t.Fatal(err)
	}
	appended.Close()
	if page, _, err := host.QueryEventLogs(config, []byte(`{}`)); err != nil || len(page.Rows) != 7 {
		t.Fatalf("query after the append: %d rows (%v)", len(page.Rows), err)
	}
	if again := rebuilt(); len(again) != 1 {
		t.Fatalf("an incremental update stored an event: %v", again)
	}

	// A failed update is shown once for each distinct text as an error record of the place `log index`.
	report := host.NewIndexReporter()
	report(path, sok.IndexUpdate{}, errors.New("first"))
	report(path, sok.IndexUpdate{}, errors.New("first"))
	report(path, sok.IndexUpdate{}, errors.New("second"))
	report(path, sok.IndexUpdate{File: "logs/host-x1.jsonl"}, nil)
	report(path, sok.IndexUpdate{}, errors.New("first"))
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var texts []string
	for _, event := range readEventLog(t, log.Path()) {
		fields, _ := event["fields"].(map[string]any)
		if event["event"] == "host.record.error" && fields["where"] == "log index" {
			texts = append(texts, fields["text"].(string))
		}
	}
	if !reflect.DeepEqual(texts, []string{"first", "second", "first"}) {
		t.Fatalf("the records of the place log index are %v", texts)
	}
}
