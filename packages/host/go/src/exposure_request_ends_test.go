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
