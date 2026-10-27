package host

import "testing"

// contract: view.call.peer-lost
// A view process that ends with a call open ends that call with the reason process-ended, and the host writes
// host.call.peer-lost {plugin, command, reason} for it (docs/spec/native-surfaces.md#view-surfaces).
func TestViewProcessEndWritesPeerLostForEachOpenViewCall(t *testing.T) {
	isolateTraceRecords(t)
	clock := &fakeClock{}
	s, fake, _ := newLifecycleSurfaces(t, clock)
	s.views = map[string]*nativeWebview{"probe-surface": {}}
	events := recordWindowEvents(s)
	if err := s.viewMessage("probe-surface", `{"message":{"sok":1,"id":7,"command":"probe.run","params":{"a":1}}}`); err != nil {
		t.Fatalf("view call: %v", err)
	}
	if len(*events) != 1 || (*events)[0].name != "view-call" {
		t.Fatalf("events after the view call: %+v, want one view-call event", *events)
	}
	endView(t, s, fake)
	got := bufferedTraces(t, "host.call.peer-lost")
	want := map[string]any{"plugin": "probe", "command": "probe.run", "reason": "process-ended"}
	if len(got) != 1 || got[0]["plugin"] != want["plugin"] || got[0]["command"] != want["command"] || got[0]["reason"] != want["reason"] {
		t.Fatalf("host.call.peer-lost records: %v, want one %v", got, want)
	}
}

// contract: view.call.peer-lost
// A reply that the main page sends for a view call ends the call, so a later process end writes no peer-lost for it.
func TestViewCallAnsweredBeforeTheProcessEndWritesNoPeerLost(t *testing.T) {
	isolateTraceRecords(t)
	clock := &fakeClock{}
	s, fake, _ := newLifecycleSurfaces(t, clock)
	s.views = map[string]*nativeWebview{"probe-surface": {}}
	recordWindowEvents(s)
	generation := viewGeneration(s, "probe-surface")
	s.documents.setReadyDocument("probe-surface", generation, "doc-1", "1234.5")
	if err := s.viewMessage("probe-surface", `{"message":{"sok":1,"id":8,"command":"probe.run","params":{}}}`); err != nil {
		t.Fatalf("view call: %v", err)
	}
	if err := s.replyView(ViewReplyRequest{Page: "page-1", Surface: "probe-surface", Generation: generation, ID: 8, Result: []byte(`null`)}); err != nil {
		t.Fatalf("reply: %v", err)
	}
	endView(t, s, fake)
	if got := bufferedTraces(t, "host.call.peer-lost"); len(got) != 0 {
		t.Fatalf("host.call.peer-lost after the reply: %v, want none", got)
	}
}

// contract: view.call.reply
func TestSuccessfulViewDeliveryKeepsTheViewAlive(t *testing.T) {
	for _, kind := range []string{"reply", "event", "request"} {
		t.Run(kind, func(t *testing.T) {
			s, _ := newViewChannelSurfaces(t)
			if err := s.viewMessage("probe-surface", `{"message":{"event":"view.ready","plugin":"probe","document":"doc-1","page":"1234.5"}}`); err != nil {
				t.Fatal(err)
			}
			lifecycle := s.viewRecords()
			lifecycle.track("probe-surface", nil, "probe", "ui/page.html", true)
			generation := viewGeneration(s, "probe-surface")
			var err error
			switch kind {
			case "reply":
				err = s.replyView(ViewReplyRequest{Page: "page-1", Surface: "probe-surface", Generation: generation, ID: 7, Result: []byte(`null`)})
			case "event":
				_, err = s.pushViewEvent(ViewEventRequest{Surface: "probe-surface", Generation: generation, Event: "probe.changed", Data: []byte(`null`)})
			case "request":
				_, err = s.pushViewRequest(ViewRequestRequest{Surface: "probe-surface", Generation: generation, ID: 7, Command: "probe.read"})
			}
			if err != nil {
				t.Fatal(err)
			}
			if !lifecycle.live["probe-surface"] {
				t.Fatal("successful message delivery ended the live view")
			}
		})
	}
}
