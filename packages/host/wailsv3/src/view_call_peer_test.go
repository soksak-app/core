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
	s.documents.setReadyDocument("probe-surface", "doc-1")
	if err := s.viewMessage("probe-surface", `{"message":{"sok":1,"id":8,"command":"probe.run","params":{}}}`); err != nil {
		t.Fatalf("view call: %v", err)
	}
	if err := s.replyView(ViewReplyRequest{Surface: "probe-surface", ID: 8, Result: []byte(`null`)}); err != nil {
		t.Fatalf("reply: %v", err)
	}
	endView(t, s, fake)
	if got := bufferedTraces(t, "host.call.peer-lost"); len(got) != 0 {
		t.Fatalf("host.call.peer-lost after the reply: %v, want none", got)
	}
}
