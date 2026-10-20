package host

import (
	"encoding/json"
	"reflect"
	"testing"
)

// contract: modal.ready-visible
func TestAStaleModalReadyChangesNothingAndWritesTheTrace(t *testing.T) {
	records.Lock()
	saved := records.buffer
	records.buffer = nil
	records.Unlock()
	defer func() {
		records.Lock()
		records.buffer = saved
		records.Unlock()
	}()

	s := &Surfaces{}
	if err := s.ModalReady("debug", 7); err != nil {
		t.Fatalf("a ready request of a modal that is not open answered %v, want nil", err)
	}
	if s.modal != nil {
		t.Fatalf("a stale ready request opened a modal record %+v", s.modal)
	}

	records.Lock()
	defer records.Unlock()
	for _, record := range records.buffer {
		if record.event != "host.trace.modal.stale-ready" {
			continue
		}
		var fields map[string]any
		if err := json.Unmarshal(record.fields, &fields); err != nil {
			t.Fatalf("the fields of the stale ready trace cannot be read: %v", err)
		}
		want := map[string]any{"modal": "debug", "instance": float64(7)}
		if !reflect.DeepEqual(fields, want) {
			t.Fatalf("the stale ready trace has fields %v, want %v", fields, want)
		}
		return
	}
	t.Fatalf("no host.trace.modal.stale-ready record was written; the buffered records are %d", len(records.buffer))
}
