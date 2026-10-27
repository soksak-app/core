package host

import (
	"encoding/json"
	"testing"
)

// isolateTraceRecords empties the start buffer of the records for the test, and restores it when the test ends.
func isolateTraceRecords(t *testing.T) {
	t.Helper()
	records.Lock()
	saved := records.buffer
	records.buffer = nil
	records.Unlock()
	t.Cleanup(func() {
		records.Lock()
		records.buffer = saved
		records.Unlock()
	})
}

// bufferedTraces returns the fields of each buffered record of event, in the order of the records.
func bufferedTraces(t *testing.T, event string) []map[string]any {
	t.Helper()
	records.Lock()
	defer records.Unlock()
	var found []map[string]any
	for _, record := range records.buffer {
		if record.event != event {
			continue
		}
		var fields map[string]any
		if err := json.Unmarshal(record.fields, &fields); err != nil {
			t.Fatalf("the fields of %s cannot be read: %v", event, err)
		}
		found = append(found, fields)
	}
	return found
}

// contract: view.responsiveness.relay
// An unresponsive notice of a view writes its trace and sends the view-responsiveness event to the surface, and a responsive notice
// does the same with responsive true. Neither notice closes or creates a view, because no call of the view ends.
func TestViewResponsivenessNoticeIsRelayedWithoutEndingTheView(t *testing.T) {
	isolateTraceRecords(t)
	clock := &fakeClock{}
	s, fake, _ := newLifecycleSurfaces(t, clock)
	s.views = map[string]*nativeWebview{"probe-surface": {}}
	events := recordWindowEvents(s)
	receive := fake.responsiveness[fake.created[0]]
	if receive == nil {
		t.Fatalf("the view has no responsiveness receiver")
	}
	receive(false)
	receive(true)
	if len(*events) != 2 {
		t.Fatalf("events after the two notices: %d, want one view-responsiveness event for each", len(*events))
	}
	for i, want := range []bool{false, true} {
		if (*events)[i].name != "view-responsiveness" {
			t.Fatalf("event %d is %q, want view-responsiveness", i, (*events)[i].name)
		}
		payload, ok := (*events)[i].data.(map[string]any)
		if !ok || payload["surface"] != "probe-surface" || payload["plugin"] != "probe" || payload["generation"] != uint64(1) || payload["responsive"] != want {
			t.Fatalf("event %d payload %v, want surface probe-surface, plugin probe, generation 1 and responsive %v", i, (*events)[i].data, want)
		}
	}
	if len(fake.closed) != 0 || len(fake.created) != 1 {
		t.Fatalf("a responsiveness notice closed %d views and created %d, want no change", len(fake.closed), len(fake.created))
	}
	if got := bufferedTraces(t, "host.trace.view.unresponsive"); len(got) != 1 || got[0]["surface"] != "probe-surface" || got[0]["plugin"] != "probe" {
		t.Fatalf("host.trace.view.unresponsive records: %v, want one for probe-surface", got)
	}
	if got := bufferedTraces(t, "host.trace.view.responsive"); len(got) != 1 || got[0]["surface"] != "probe-surface" {
		t.Fatalf("host.trace.view.responsive records: %v, want one for probe-surface", got)
	}
}

// contract: view.process.events
// Creating a view writes host.trace.view.process-request, and only the first ready message of that view writes
// host.trace.view.process-ready.
func TestViewProcessEventsMarkTheRequestAndTheFirstReadyMessage(t *testing.T) {
	isolateTraceRecords(t)
	clock := &fakeClock{}
	s, _, _ := newLifecycleSurfaces(t, clock)
	requests := bufferedTraces(t, "host.trace.view.process-request")
	if len(requests) != 1 || requests[0]["surface"] != "probe-surface" || requests[0]["plugin"] != "probe" {
		t.Fatalf("host.trace.view.process-request records: %v, want one for probe-surface", requests)
	}
	ready := `{"message":{"sok":1,"event":"view.ready","plugin":"probe","document":"doc-1","page":"1234.5"}}`
	for i := 0; i < 2; i++ {
		if err := s.viewMessage("probe-surface", ready); err != nil {
			t.Fatalf("ready message %d: %v", i, err)
		}
	}
	readies := bufferedTraces(t, "host.trace.view.process-ready")
	if len(readies) != 1 || readies[0]["surface"] != "probe-surface" || readies[0]["plugin"] != "probe" {
		t.Fatalf("host.trace.view.process-ready records after two ready messages: %v, want one for probe-surface", readies)
	}
}
