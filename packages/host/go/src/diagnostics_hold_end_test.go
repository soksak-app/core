//go:build diagnostics

package host

import (
	"encoding/json"
	"errors"
	"net"
	"reflect"
	"sync"
	"testing"
	"time"
)

// settleWithin is how long a check looks for an end that the code under test makes at once. It bounds the observation of
// the test, not the code: a hold that never ends fails the check instead of stopping the run.
const settleWithin = 2 * time.Second

// emittedEvent is an event that a window received.
type emittedEvent struct {
	name string
	data []any
}

// exposureWindow is the main page of a window: it records each event and answers each exposure request through answer.
type exposureWindow struct {
	frontendRecord
	mu     sync.Mutex
	events []emittedEvent
	answer func(id uint64, method string)
}

func (w *exposureWindow) Emit(name string, data ...any) {
	w.mu.Lock()
	w.events = append(w.events, emittedEvent{name: name, data: data})
	answer := w.answer
	w.mu.Unlock()
	if name == "exposure-request" && answer != nil {
		request := data[0].(map[string]any)
		go answer(request["id"].(uint64), request["method"].(string))
	}
}

// named returns the data of each event called name, as JSON.
func (w *exposureWindow) named(name string) []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	var found []string
	for _, event := range w.events {
		if event.name != name {
			continue
		}
		encoded, _ := json.Marshal(event.data)
		found = append(found, string(encoded))
	}
	return found
}

// heldEndpoint is the endpoint of a host with one ready window, window-a, whose main page answers every request with null.
func heldEndpoint(t *testing.T) (*Endpoint, *Surfaces, *exposureWindow) {
	t.Helper()
	previous := framework
	framework = frameworkRecord{}
	t.Cleanup(func() { framework = previous })
	h := &Host{windows: map[uint]*Surfaces{}, owners: map[string]*Surfaces{}, relay: NewRelay[relayTarget]()}
	window := &exposureWindow{}
	s := &Surfaces{name: "window-a", window: window, ready: true, host: h}
	window.answer = func(id uint64, _ string) {
		// A reply that comes after its request ended is refused by the relay, which the checks do not read.
		_ = h.relay.Resolve(id, relayTarget{owner: s}, ExposureResult{Result: json.RawMessage("null")})
	}
	h.windows[1] = s
	return &Endpoint{backend: hostBackend{h: h}}, s, window
}

// endpointConnection is an open endpoint connection that the test closes.
func endpointConnection(t *testing.T) *endpointConn {
	t.Helper()
	local, remote := net.Pipe()
	t.Cleanup(func() { _ = remote.Close() })
	c := &endpointConn{conn: local, topics: map[topic]bool{}, out: make(chan endpointFrame, 1), done: make(chan struct{})}
	t.Cleanup(func() { c.close("the test ended") })
	return c
}

// call answers the endpoint method name with params on connection c.
func call(t *testing.T, e *Endpoint, c *endpointConn, name, params string) error {
	t.Helper()
	method, ok := e.method(name)
	if !ok {
		t.Fatalf("%s is not registered", name)
	}
	_, err := method(e, c, json.RawMessage(params), nil)
	return err
}

// ended reports whether done closes within settleWithin.
func ended(done <-chan struct{}) bool {
	select {
	case <-done:
		return true
	case <-time.After(settleWithin):
		return false
	}
}

// endModalHoldsAfter turns the modal content hold of window-a off when the test ends, so a hold that the code under test
// kept does not reach the next test.
func endModalHoldsAfter(t *testing.T, e *Endpoint) {
	t.Cleanup(func() { _ = call(t, e, nil, "diagnostics.modal.hold", `{"window":"window-a","on":false}`) })
}

// contract: diagnostics.modal-hold.ends-with-window-or-connection
func TestAModalHoldEndsWithTheConnectionThatTurnedItOn(t *testing.T) {
	e, s, _ := heldEndpoint(t)
	endModalHoldsAfter(t, e)
	c := endpointConnection(t)
	if err := call(t, e, c, "diagnostics.modal.hold", `{"window":"window-a","on":true}`); err != nil {
		t.Fatal(err)
	}
	waited := make(chan struct{})
	go func() {
		holdModalContent(s)
		close(waited)
	}()
	c.close("the requester closed")
	if !ended(waited) {
		t.Fatal("the held modal content answer was not sent when the connection that turned the hold on closed")
	}
	later := make(chan struct{})
	go func() {
		holdModalContent(s)
		close(later)
	}()
	if !ended(later) {
		t.Fatal("a modal content answer after the end of the hold was held")
	}
}

// contract: diagnostics.modal-hold.ends-with-window-or-connection
func TestModalHeldAnswersWhenTheConnectionOfTheHoldCloses(t *testing.T) {
	e, _, _ := heldEndpoint(t)
	endModalHoldsAfter(t, e)
	c := endpointConnection(t)
	if err := call(t, e, c, "diagnostics.modal.hold", `{"window":"window-a","on":true}`); err != nil {
		t.Fatal(err)
	}
	answered := make(chan struct{})
	go func() {
		_ = call(t, e, nil, "diagnostics.modal.held", `{"window":"window-a"}`)
		close(answered)
	}()
	c.close("the requester closed")
	if !ended(answered) {
		t.Fatal("diagnostics.modal.held did not answer at the end of the hold by its connection")
	}
}

// contract: diagnostics.modal-hold.ends-with-window-or-connection
func TestTheCloseOfAnotherConnectionKeepsTheModalHold(t *testing.T) {
	e, s, _ := heldEndpoint(t)
	endModalHoldsAfter(t, e)
	holder, other := endpointConnection(t), endpointConnection(t)
	if err := call(t, e, holder, "diagnostics.modal.hold", `{"window":"window-a","on":true}`); err != nil {
		t.Fatal(err)
	}
	waited := make(chan struct{})
	go func() {
		holdModalContent(s)
		close(waited)
	}()
	other.close("another requester closed")
	select {
	case <-waited:
		t.Fatal("the close of a connection that did not turn the hold on sent the held answer")
	case <-time.After(100 * time.Millisecond):
	}
	if err := call(t, e, other, "diagnostics.modal.hold", `{"window":"window-a","on":false}`); err != nil {
		t.Fatal(err)
	}
	if !ended(waited) {
		t.Fatal("turning the hold off did not send the held answer")
	}
}

// contract: diagnostics.surface-hold.released-at-connection-close
func TestTheCloseOfTheConnectionOfASurfaceHoldReleasesTheSurface(t *testing.T) {
	e, _, window := heldEndpoint(t)
	c := endpointConnection(t)
	if err := call(t, e, c, "diagnostics.surface.hold", `{"window":"window-a","surface":"tab-1"}`); err != nil {
		t.Fatal(err)
	}
	if released := window.named("diagnostics-surface-released"); len(released) != 0 {
		t.Fatalf("the surface was released while its connection was open: %v", released)
	}
	c.close("the requester closed")
	deadline := time.Now().Add(settleWithin)
	for len(window.named("diagnostics-surface-released")) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if released := window.named("diagnostics-surface-released"); !reflect.DeepEqual(released, []string{`[{"surface":"tab-1"}]`}) {
		t.Fatalf("the close of the connection of the hold sent %v, want one diagnostics-surface-released {surface: tab-1}", released)
	}
}

// contract: diagnostics.surface-hold.released-at-connection-close
func TestALaterHoldOfTheSurfaceKeepsItAtTheCloseOfTheEarlierConnection(t *testing.T) {
	e, _, window := heldEndpoint(t)
	earlier, later := endpointConnection(t), endpointConnection(t)
	if err := call(t, e, earlier, "diagnostics.surface.hold", `{"window":"window-a","surface":"tab-1"}`); err != nil {
		t.Fatal(err)
	}
	// The page answered the first hold, and the surface closed and opened again in between: the later hold takes the surface.
	if err := call(t, e, later, "diagnostics.surface.hold", `{"window":"window-a","surface":"tab-1"}`); err != nil {
		t.Fatal(err)
	}
	earlier.close("the earlier requester closed")
	later.close("the later requester closed")
	deadline := time.Now().Add(settleWithin)
	for len(window.named("diagnostics-surface-released")) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	if released := window.named("diagnostics-surface-released"); !reflect.DeepEqual(released, []string{`[{"surface":"tab-1"}]`}) {
		t.Fatalf("the closes sent %v, want one release by the connection of the later hold", released)
	}
}

// contract: diagnostics.surface-hold.released-at-connection-close
func TestARefusedSurfaceHoldReleasesNothing(t *testing.T) {
	e, s, window := heldEndpoint(t)
	window.answer = func(id uint64, _ string) {
		_ = s.host.relay.Resolve(id, relayTarget{owner: s}, ExposureResult{Error: rpcError(codeInvalidParams, "surface tab-1 is not mounted")})
	}
	c := endpointConnection(t)
	if err := call(t, e, c, "diagnostics.surface.hold", `{"window":"window-a","surface":"tab-1"}`); err == nil {
		t.Fatal("the refusal of the page was not answered")
	}
	c.close("the requester closed")
	time.Sleep(100 * time.Millisecond)
	if released := window.named("diagnostics-surface-released"); len(released) != 0 {
		t.Fatalf("a hold that the page refused released the surface: %v", released)
	}
}

// contract: diagnostics.drag.page-receives-every-step
func TestAPageDragReceivesEveryStepAfterItsRequestEnded(t *testing.T) {
	_, s, window := heldEndpoint(t)
	// The page ends the request at once, before the first step.
	window.answer = func(id uint64, _ string) {
		_ = s.host.relay.Resolve(id, relayTarget{owner: s}, ExposureResult{Error: rpcError(codeInvalidParams, "the drag ended")})
	}
	const ticks = 8
	var sentMu sync.Mutex
	sent := 0
	if _, err := pageDrag(s.host, s, dragPlan{Axis: "x", Line: 1, DX: 10, MS: 16, Times: 1}, ticks, func() {
		sentMu.Lock()
		sent++
		sentMu.Unlock()
	}); err == nil {
		t.Fatal("the end of the request by the page was not answered")
	}
	deadline := time.Now().Add(settleWithin)
	for len(window.named("diagnostics-tick")) < ticks && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := len(window.named("diagnostics-tick")); got != ticks {
		t.Fatalf("the page received %d of the %d steps of its drag", got, ticks)
	}
	sentMu.Lock()
	defer sentMu.Unlock()
	if sent != ticks {
		t.Fatalf("sent was called for %d of the %d steps", sent, ticks)
	}
}

// contract: diagnostics.drag.no-main-page-delivers-native
func TestAFailedDragRequestStillEndsTheWorkbenchRecord(t *testing.T) {
	plan := dragPlan{Axis: "x", Line: 2, DX: -30, MS: 16, Times: 1}
	var asked []string
	refused := errors.New("the workbench did not answer diagnostics.drag")
	delivered := false
	_, err := workbenchDrag(plan, func(method string, _ any) (json.RawMessage, error) {
		asked = append(asked, method)
		if method == "diagnostics.drag" {
			return nil, refused
		}
		return json.RawMessage(`{"boundary":[]}`), nil
	}, func(func(StepRecord)) func() { return func() {} }, func() (map[string]any, error) {
		delivered = true
		return map[string]any{}, nil
	})
	if !errors.Is(err, refused) {
		t.Fatalf("the failed drag request answered %v", err)
	}
	if delivered {
		t.Fatal("the gesture was delivered after a failed drag request")
	}
	if !reflect.DeepEqual(asked, []string{"diagnostics.drag", "diagnostics.drag.end"}) {
		t.Fatalf("the workbench was asked %v, want diagnostics.drag and then diagnostics.drag.end", asked)
	}
}
