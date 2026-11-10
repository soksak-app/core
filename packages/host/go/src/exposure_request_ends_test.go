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

// commandAnswer is the answer of a page request of the endpoint.
type commandAnswer struct {
	result json.RawMessage
	err    error
}

// pageCommandRun sends the endpoint request command.run of the connection ctx to the main page of window-a and returns the
// channel of its answer.
func pageCommandRun(ctx context.Context, h *Host) <-chan commandAnswer {
	answer := make(chan commandAnswer, 1)
	go func() {
		result, err := hostBackend{h: h}.PageRequest(ctx, "window-a", "command.run", json.RawMessage(`{"name":"probe.run","params":{}}`))
		answer <- commandAnswer{result, err}
	}()
	return answer
}

// expectOpen fails when answer already holds the end of the request.
func expectOpen(t *testing.T, answer <-chan commandAnswer, what string) {
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
	answer := pageCommandRun(context.Background(), h)
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
	answer := pageCommandRun(context.Background(), h)
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
	answer := pageCommandRun(ctx, h)
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
	if got := <-pageCommandRun(ctx, h); got.err == nil {
		t.Fatalf("command.run of an ended connection answered %s, want no result", got.result)
	}
}

// forwardFixture returns the host of askFixture whose main page also calls the host: the window is the frontend of its calls,
// and the window shows the surface "tab". A forward sends its request in a step of the main thread, so the framework of the
// test runs each step at once.
func forwardFixture(t *testing.T) (*Host, *Surfaces, *askWindow, context.Context) {
	t.Helper()
	useStepFramework(t)
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
		if rpc, ok := err.(*RPCError); ok {
			got = ExposureResult{Error: rpc}
		} else if err != nil {
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

// forwardOf is the exposureForward request of the main page to the surface tab with origin.
func forwardOf(origin uint64) string {
	return fmt.Sprintf(`{"id":1,"origin":%d,"surface":"tab","method":"probe.run","params":{}}`, origin)
}

// expectForwardEndedWithoutResult receives the end of the forward and fails when it carries a result.
func expectForwardEndedWithoutResult(t *testing.T, reply <-chan ExposureResult, what string) {
	t.Helper()
	if got := <-reply; got.Error == nil {
		t.Fatalf("%s answered %s, want no result", what, got.Result)
	}
}

// expectLateForwardReplyObserved sends the reply of the surface tab to the ended forward and fails when the host does not accept
// it as the observation of an ended request.
func expectLateForwardReplyObserved(t *testing.T, h *Host, s *Surfaces, forwarded uint64) {
	t.Helper()
	if err := h.relay.Resolve(forwarded, relayTarget{owner: s, surface: "tab"}, ExposureResult{Result: json.RawMessage(`5`)}); err != nil {
		t.Fatalf("the reply of the surface after the end of the origin = %v, want it accepted as an observation", err)
	}
	expectEndedReplyObserved(t, forwarded)
}

// The main page forwards the command.run that it handles to the surface tab with origin, the id of that command.run. The end of
// the endpoint connection that sent the command.run ends the origin request and with it the forward; the host answers nothing,
// and the reply of the surface document after it is the observation of an ended request. The two ends are received in any
// order.
// contract: exposure.relay.forward-lives-while-its-origin-is-open
func TestTheEndOfTheConnectionOfItsOriginEndsAForward(t *testing.T) {
	isolateTraceRecords(t)
	h, s, window, page := forwardFixture(t)
	connection, end := context.WithCancel(context.Background())
	answer := pageCommandRun(connection, h)
	origin := <-window.requests
	reply := forward(page, h, forwardOf(origin))
	forwarded := <-window.requests
	expectForwardOpen(t, reply, "the forward that the surface received")
	end()
	if got := <-answer; got.err == nil {
		t.Fatalf("command.run whose connection ended answered %s, want no result", got.result)
	}
	expectForwardEndedWithoutResult(t, reply, "the forward whose origin connection ended")
	expectLateForwardReplyObserved(t, h, s, forwarded)
}

// The answer of the main page ends the origin request, and a forward of that origin that still waits ends then with no result.
// contract: exposure.relay.forward-lives-while-its-origin-is-open
func TestTheAnswerOfItsOriginEndsAWaitingForward(t *testing.T) {
	isolateTraceRecords(t)
	h, s, window, page := forwardFixture(t)
	answer := pageCommandRun(context.Background(), h)
	origin := <-window.requests
	reply := forward(page, h, forwardOf(origin))
	forwarded := <-window.requests
	expectForwardOpen(t, reply, "the forward that the surface received")
	if err := h.relay.Resolve(origin, relayTarget{owner: s}, ExposureResult{Result: json.RawMessage(`7`)}); err != nil {
		t.Fatalf("the answer of the main page: %v", err)
	}
	if got := <-answer; got.err != nil || string(got.result) != `7` {
		t.Fatalf("command.run answered %s %v, want the answer 7 of the main page", got.result, got.err)
	}
	expectForwardEndedWithoutResult(t, reply, "the forward whose origin the main page answered")
	expectLateForwardReplyObserved(t, h, s, forwarded)
}

// The end of the origin request with 1003, here by the end of the main page that runs it, ends its forward with no result.
// contract: exposure.relay.forward-lives-while-its-origin-is-open
func TestTheEndOfItsOriginWith1003EndsAWaitingForward(t *testing.T) {
	isolateTraceRecords(t)
	h, s, window, page := forwardFixture(t)
	answer := pageCommandRun(context.Background(), h)
	origin := <-window.requests
	reply := forward(page, h, forwardOf(origin))
	forwarded := <-window.requests
	expectForwardOpen(t, reply, "the forward that the surface received")
	h.relay.Abandon(func(target relayTarget) bool { return target.owner == s && target.surface == "" })
	if rpc, ok := (<-answer).err.(*RPCError); !ok || rpc.Code != codeNoWindow {
		t.Fatalf("command.run of an ended page answered %v, want 1003", rpc)
	}
	expectForwardEndedWithoutResult(t, reply, "the forward whose origin ended with 1003")
	expectLateForwardReplyObserved(t, h, s, forwarded)
}

// A forward without origin is the main page's own and belongs to no connection: the end of an endpoint connection leaves it
// waiting, checked once the command.run of that connection ended, and the reply of the surface ends it with that reply.
// contract: exposure.relay.forward-lives-while-its-origin-is-open
func TestAForwardWithoutOriginIsNotEndedByAConnectionEnd(t *testing.T) {
	h, s, window, page := forwardFixture(t)
	connection, end := context.WithCancel(context.Background())
	answer := pageCommandRun(connection, h)
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

// The end of one origin request ends only its own forwards: a forward of the request of another connection keeps waiting,
// checked once the command.run of the ended connection ended.
// contract: exposure.relay.forward-lives-while-its-origin-is-open
func TestTheEndOfAConnectionLeavesTheForwardsOfAnotherOrigin(t *testing.T) {
	h, s, window, page := forwardFixture(t)
	ending, end := context.WithCancel(context.Background())
	endedAnswer := pageCommandRun(ending, h)
	<-window.requests
	keptAnswer := pageCommandRun(context.Background(), h)
	kept := <-window.requests
	reply := forward(page, h, forwardOf(kept))
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

// A forward whose origin names no open request, one that ended by the end of its connection or an id that the host never sent,
// is not sent to the surface and is refused at once with 1003, so the result does not depend on the order of the end of the
// origin and the forward. That nothing reached the surface is checked when the refusal is received, because the forward sends
// before it waits.
// contract: exposure.relay.forward-lives-while-its-origin-is-open
func TestAForwardWhoseOriginIsNotOpenIsRefusedWithoutBeingSent(t *testing.T) {
	h, _, window, page := forwardFixture(t)
	connection, end := context.WithCancel(context.Background())
	answer := pageCommandRun(connection, h)
	ended := <-window.requests
	end()
	<-answer
	for _, origin := range []uint64{ended, ended + 100} {
		got := <-forward(page, h, forwardOf(origin))
		want := fmt.Sprintf("the origin request %d has ended", origin)
		if got.Error == nil || got.Error.Code != codeNoWindow || got.Error.Message != want {
			t.Fatalf("the forward of origin %d answered %+v, want 1003 %q", origin, got, want)
		}
		select {
		case sent := <-window.requests:
			t.Fatalf("the forward of origin %d was sent to the surface as request %d", origin, sent)
		default:
		}
	}
}
