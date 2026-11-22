package host

import (
	"encoding/json"
	"reflect"
	"testing"
)

// pageStartRecords returns the fields of the host.page.started records that the test stored.
func pageStartRecords(t *testing.T) []map[string]any {
	t.Helper()
	var got []map[string]any
	records.Lock()
	defer records.Unlock()
	for _, record := range records.buffer {
		if record.event != "host.page.started" {
			continue
		}
		var fields map[string]any
		if err := json.Unmarshal(record.fields, &fields); err != nil {
			t.Fatal(err)
		}
		got = append(got, fields)
	}
	return got
}

// A start of a page records its cause and the number of views that it ends: the host operation that started the workbench once, and
// page for a start that no host operation asked for.
// contract: host.page.started.names-its-cause
func TestAPageStartRecordsItsCauseAndTheViewsThatItEnds(t *testing.T) {
	isolateTraceRecords(t)
	s := &Surfaces{views: map[string]*nativeWebview{"a": nil, "b": nil}, startCause: "host.window.reload"}
	recordPageStart(s.takeStartCause(), len(s.views))
	recordPageStart(s.takeStartCause(), len(s.views))
	want := []map[string]any{{"cause": "host.window.reload", "views": 2.0}, {"cause": "page", "views": 2.0}}
	if got := pageStartRecords(t); !reflect.DeepEqual(got, want) {
		t.Fatalf("host.page.started records %v, want %v", got, want)
	}
}
