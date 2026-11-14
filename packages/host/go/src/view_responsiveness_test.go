package host

import (
	"encoding/json"
	"testing"
)

// isolateTraceRecords empties the start buffer of the records for the test and turns the performance trace on, whose switch
// controls the host.trace events; it restores both when the test ends.
func isolateTraceRecords(t *testing.T) {
	t.Helper()
	records.Lock()
	saved := records.buffer
	records.buffer = nil
	records.Unlock()
	wasOn := performanceOn.Swap(true)
	t.Cleanup(func() {
		performanceOn.Store(wasOn)
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
	return tracesOf(t, event)
}

// awaitTraces returns the fields of the buffered records of event once the start buffer holds at least count of them. Each
// record that the buffer takes wakes the wait (records.appended); a record that never comes leaves the check to the limit of
// its runner.
func awaitTraces(t *testing.T, event string, count int) []map[string]any {
	t.Helper()
	for {
		found, appended := func() ([]map[string]any, chan struct{}) {
			records.Lock()
			defer records.Unlock()
			found := tracesOf(t, event)
			if len(found) >= count {
				return found, nil
			}
			if records.appended == nil {
				records.appended = make(chan struct{})
			}
			return nil, records.appended
		}()
		if appended == nil {
			return found
		}
		<-appended
	}
}

// tracesOf returns the fields of each buffered record of event; the caller holds the lock of the records.
func tracesOf(t *testing.T, event string) []map[string]any {
	t.Helper()
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
	s, views, _ := newLifecycleSurfaces(t)
	s.views = map[string]*nativeWebview{"probe-surface": {}}
	events := recordWindowEvents(s)
	channel, ok := s.documents.view("probe-surface")
	if !ok {
		t.Fatal("the created view has no channel")
	}
	s.viewResponsiveness("probe-surface", "probe", channel.generation, false)
	s.viewResponsiveness("probe-surface", "probe", channel.generation, true)
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
	current, ok := s.documents.view("probe-surface")
	if !ok || current.generation != channel.generation || !s.viewRecords().live["probe-surface"] || len(views.closed) != 0 || len(views.created) != 1 {
		t.Fatalf("a responsiveness notice changed the view: channel %+v, live %v, closed %d, created %d; want no change", current, s.viewRecords().live["probe-surface"], len(views.closed), len(views.created))
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
	// The trace of the request is written by the step that records the created view (viewLoaded), which the first mount runs.
	s, _, _ := newLifecycleSurfaces(t)
	requests := bufferedTraces(t, "host.trace.view.process-request")
	if len(requests) != 1 || requests[0]["surface"] != "probe-surface" || requests[0]["plugin"] != "probe" {
		t.Fatalf("host.trace.view.process-request records: %v, want one for probe-surface", requests)
	}
	generation := probeGeneration(s)
	timeOrigin := 1234.5
	for i := 0; i < 2; i++ {
		if accepted, err := s.viewReady("probe-surface", "probe", generation, "probe", "doc-1", &timeOrigin); !accepted || err != nil {
			t.Fatalf("ready message %d: accepted %v, error %v", i, accepted, err)
		}
	}
	readies := bufferedTraces(t, "host.trace.view.process-ready")
	if len(readies) != 1 || readies[0]["surface"] != "probe-surface" || readies[0]["plugin"] != "probe" {
		t.Fatalf("host.trace.view.process-ready records after two ready messages: %v, want one for probe-surface", readies)
	}
}
