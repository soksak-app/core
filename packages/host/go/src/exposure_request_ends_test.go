package host

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
)

// askWindow is the main page of a request test: requests receives the id of each exposure-request that the host emits to it.
type askWindow struct {
	frontendRecord
	requests chan uint64
}

func (w *askWindow) Emit(name string, data ...any) {
	if name != "exposure-request" {
		return
	}
	w.requests <- data[0].(map[string]any)["id"].(uint64)
}

// askFixture returns a host of one ready window "window-a" whose main page is window.
func askFixture() (*Host, *Surfaces, *askWindow) {
	window := &askWindow{requests: make(chan uint64, 4)}
	h := &Host{windows: map[uint]*Surfaces{}, relay: NewRelay[relayTarget]()}
	s := &Surfaces{name: "window-a", host: h, window: window, ready: true}
	h.windows[1] = s
	return h, s, window
}

// pageAnswer is the answer of a page request of the endpoint.
type pageAnswer struct {
	result json.RawMessage
	err    error
}

// commandRun sends the endpoint request command.run of the connection ctx to the main page of window-a and returns the
// channel of its answer.
func commandRun(ctx context.Context, h *Host) <-chan pageAnswer {
	answer := make(chan pageAnswer, 1)
	go func() {
		result, err := hostBackend{h: h}.PageRequest(ctx, "window-a", "command.run", json.RawMessage(`{"name":"probe.run","params":{}}`))
		answer <- pageAnswer{result, err}
	}()
	return answer
}

// expectOpen fails when answer already holds the end of the request.
func expectOpen(t *testing.T, answer <-chan pageAnswer, what string) {
	t.Helper()
	select {
	case got := <-answer:
		t.Fatalf("%s ended: %s %v", what, got.result, got.err)
	default:
	}
}

// command.run has no time limit: the main page received it, and its reply ends it with that reply.
// contract: exposure.command.ends-by-reply-or-peer-end
func TestACommandRunEndsByItsReply(t *testing.T) {
	h, s, window := askFixture()
	answer := commandRun(context.Background(), h)
	id := <-window.requests
	expectOpen(t, answer, "the command.run that its page received")
	if err := h.relay.Resolve(id, relayTarget{owner: s}, ExposureResult{Result: json.RawMessage(`7`)}); err != nil {
		t.Fatalf("the reply of the main page: %v", err)
	}
	if got := <-answer; got.err != nil || string(got.result) != `7` {
		t.Fatalf("command.run answered %s %v, want the reply 7", got.result, got.err)
	}
}

// The end of the main page that runs a command.run ends it with 1003.
// contract: exposure.command.ends-by-reply-or-peer-end
func TestACommandRunEndsByTheEndOfItsPage(t *testing.T) {
	h, s, window := askFixture()
	answer := commandRun(context.Background(), h)
	<-window.requests
	expectOpen(t, answer, "the command.run that its page received")
	h.relay.Abandon(func(target relayTarget) bool { return target.owner == s })
	got := <-answer
	if rpc, ok := got.err.(*RPCError); !ok || rpc.Code != codeNoWindow {
		t.Fatalf("command.run of an ended page answered %s %v, want 1003", got.result, got.err)
	}
}

// The end of the endpoint connection that sent a command.run ends it on the host. The reply that the main page sends after
// it is accepted and written as the observation of an ended request.
// contract: exposure.command.ends-by-reply-or-peer-end, exposure.relay.connection-end-ends-its-requests
func TestACommandRunEndsByTheEndOfItsEndpointConnection(t *testing.T) {
	isolateTraceRecords(t)
	h, s, window := askFixture()
	ctx, end := context.WithCancel(context.Background())
	answer := commandRun(ctx, h)
	id := <-window.requests
	expectOpen(t, answer, "the command.run that its page received")
	end()
	if got := <-answer; got.err == nil {
		t.Fatalf("command.run whose connection ended answered %s, want no result", got.result)
	}
	if err := h.relay.Resolve(id, relayTarget{owner: s}, ExposureResult{Result: json.RawMessage(`7`)}); err != nil {
		t.Fatalf("the reply after the end of the connection = %v, want it accepted as an observation", err)
	}
	want := fmt.Sprintf("exposure reply %d arrived after its request ended", id)
	found := false
	for _, record := range bufferedTraces(t, "host.record.info") {
		if record["where"] == "exposure" && record["text"] == want {
			found = true
		}
	}
	if !found {
		t.Fatalf("info records %v, want %q", bufferedTraces(t, "host.record.info"), want)
	}
}

// A connection that ended before its request reached the page ends the request the same way, so the end is
// order-insensitive.
// contract: exposure.relay.connection-end-ends-its-requests
func TestACommandRunOfAnEndedConnectionEnds(t *testing.T) {
	h, _, _ := askFixture()
	ctx, end := context.WithCancel(context.Background())
	end()
	if got := <-commandRun(ctx, h); got.err == nil {
		t.Fatalf("command.run of an ended connection answered %s, want no result", got.result)
	}
}

// forwardFixture returns the host of askFixture whose main page also calls the host: the window is the frontend of its calls,
// and the window shows the surface "tab".
func forwardFixture() (*Host, *Surfaces, *askWindow, context.Context) {
	h, s, window := askFixture()
	h.windows[window.ID()] = s
	s.views = map[string]*nativeWebview{"tab": {owner: s}}
	return h, s, window, WithFrontend(context.Background(), window)
}

// forward sends the exposureForward call request of the main page and returns the channel of its reply.
func forward(page context.Context, h *Host, request string) <-chan ExposureResult {
	reply := make(chan ExposureResult, 1)
	go func() {
		got, err := h.ExposureForward(page, json.RawMessage(request))
		if err != nil {
			got = ExposureResult{Error: &RPCError{Message: err.Error()}}
		}
		reply <- got
	}()
	return reply
}

// expectForwardOpen fails when reply already holds the end of the forward.
func expectForwardOpen(t *testing.T, reply <-chan ExposureResult, what string) {
	t.Helper()
	select {
	case got := <-reply:
		t.Fatalf("%s ended: %+v", what, got)
	default:
	}
}

// expectEndedReplyObserved fails when the info records hold no observation of the late reply id.
func expectEndedReplyObserved(t *testing.T, id uint64) {
	t.Helper()
	want := fmt.Sprintf("exposure reply %d arrived after its request ended", id)
	for _, record := range bufferedTraces(t, "host.record.info") {
		if record["where"] == "exposure" && record["text"] == want {
			return
		}
	}
	t.Fatalf("info records %v, want %q", bufferedTraces(t, "host.record.info"), want)
}

// The main page forwards the command.run that it handles to the surface tab with origin, the id of that command.run. The end of
// the endpoint connection that sent the command.run ends the forward on the host too; the host answers nothing, and the reply of
// the surface document after it is the observation of an ended request. The two ends are received in any order.
// contract: exposure.relay.connection-end-ends-its-requests
func TestTheEndOfTheConnectionOfItsOriginEndsAForward(t *testing.T) {
	isolateTraceRecords(t)
	h, s, window, page := forwardFixture()
	connection, end := context.WithCancel(context.Background())
	answer := commandRun(connection, h)
	origin := <-window.requests
	reply := forward(page, h, fmt.Sprintf(`{"id":1,"origin":%d,"surface":"tab","method":"probe.run","params":{}}`, origin))
	forwarded := <-window.requests
	expectForwardOpen(t, reply, "the forward that the surface received")
	end()
	if got := <-answer; got.err == nil {
		t.Fatalf("command.run whose connection ended answered %s, want no result", got.result)
	}
	if got := <-reply; got.Error == nil {
		t.Fatalf("the forward whose origin connection ended answered %s, want no result", got.Result)
	}
	if err := h.relay.Resolve(forwarded, relayTarget{owner: s, surface: "tab"}, ExposureResult{Result: json.RawMessage(`5`)}); err != nil {
		t.Fatalf("the reply of the surface after the end of the connection = %v, want it accepted as an observation", err)
	}
	expectEndedReplyObserved(t, forwarded)
}

// A forward without origin is the main page's own and belongs to no connection: the end of an endpoint connection leaves it
// waiting, checked once the command.run of that connection ended, and the reply of the surface ends it with that reply.
// contract: exposure.relay.connection-end-ends-its-requests
func TestAForwardWithoutOriginIsNotEndedByAConnectionEnd(t *testing.T) {
	h, s, window, page := forwardFixture()
	connection, end := context.WithCancel(context.Background())
	answer := commandRun(connection, h)
	<-window.requests
	reply := forward(page, h, `{"id":1,"surface":"tab","method":"probe.run","params":{}}`)
	forwarded := <-window.requests
	end()
	<-answer
	expectForwardOpen(t, reply, "the forward without origin after the end of a connection")
	if err := h.relay.Resolve(forwarded, relayTarget{owner: s, surface: "tab"}, ExposureResult{Result: json.RawMessage(`5`)}); err != nil {
		t.Fatalf("the reply of the surface: %v", err)
	}
	if got := <-reply; got.Error != nil || string(got.Result) != `5` {
		t.Fatalf("the forward without origin answered %+v, want the reply 5", got)
	}
}

// The end of one connection ends only the forwards whose origin is its own request: a forward of the request of another
// connection keeps waiting, checked once the command.run of the ended connection ended.
// contract: exposure.relay.connection-end-ends-its-requests
func TestTheEndOfAConnectionLeavesTheForwardsOfAnotherOrigin(t *testing.T) {
	h, s, window, page := forwardFixture()
	ending, end := context.WithCancel(context.Background())
	endedAnswer := commandRun(ending, h)
	<-window.requests
	keptAnswer := commandRun(context.Background(), h)
	kept := <-window.requests
	reply := forward(page, h, fmt.Sprintf(`{"id":1,"origin":%d,"surface":"tab","method":"probe.run","params":{}}`, kept))
	forwarded := <-window.requests
	end()
	<-endedAnswer
	expectForwardOpen(t, reply, "the forward of the request of another connection")
	expectOpen(t, keptAnswer, "the command.run of another connection")
	if err := h.relay.Resolve(forwarded, relayTarget{owner: s, surface: "tab"}, ExposureResult{Result: json.RawMessage(`5`)}); err != nil {
		t.Fatalf("the reply of the surface: %v", err)
	}
	if got := <-reply; got.Error != nil || string(got.Result) != `5` {
		t.Fatalf("the forward of another origin answered %+v, want the reply 5", got)
	}
}

// A forward whose origin connection ended before the forward reached the host ends the same way, so the end does not depend
// on the order of the connection end and the forward.
// contract: exposure.relay.connection-end-ends-its-requests
func TestAForwardOfAnOriginWhoseConnectionEndedEnds(t *testing.T) {
	h, _, window, page := forwardFixture()
	connection, end := context.WithCancel(context.Background())
	answer := commandRun(connection, h)
	origin := <-window.requests
	end()
	<-answer
	got := <-forward(page, h, fmt.Sprintf(`{"id":1,"origin":%d,"surface":"tab","method":"probe.run","params":{}}`, origin))
	if got.Error == nil {
		t.Fatalf("the forward of an origin whose connection ended answered %s, want no result", got.Result)
	}
}
