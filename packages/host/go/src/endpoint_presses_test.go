package host

import (
	"encoding/json"
	"net"
	"sync"
	"testing"
)

// pressBackend records the pointer inputs that the endpoint delivers and answers each with the next refusal of refusals, or
// with success when none is left.
type pressBackend struct {
	diagnosticsClockBackend
	mu        sync.Mutex
	refusals  []error
	delivered chan PointerInput
}

func newPressBackend(refusals ...error) *pressBackend {
	return &pressBackend{refusals: refusals, delivered: make(chan PointerInput, 16)}
}

func (b *pressBackend) Pointer(_ string, input PointerInput) error {
	b.mu.Lock()
	var err error
	if input.Phase == "up" && len(b.refusals) > 0 {
		err, b.refusals = b.refusals[0], b.refusals[1:]
	}
	b.mu.Unlock()
	b.delivered <- input
	return err
}

// next is the input that the call the test made last delivered. The endpoint delivers an input and a release of a closing
// connection inside the call that causes it (inputPointer, drop), so the input is there when that call returns.
func (b *pressBackend) next(t *testing.T, what string) PointerInput {
	t.Helper()
	select {
	case input := <-b.delivered:
		return input
	default:
		t.Fatalf("%s: no pointer input was delivered by the return of the call", what)
		return PointerInput{}
	}
}

// later is the next input that a routine of the endpoint delivers after the call of the test returned. A routine that never
// delivers it leaves the test to the limit of its runner, which reports the stall.
func (b *pressBackend) later() PointerInput {
	return <-b.delivered
}

// none checks that no input was delivered by the time every routine of the endpoint that the test started ran.
func (b *pressBackend) none(t *testing.T, what string) {
	t.Helper()
	select {
	case input := <-b.delivered:
		t.Fatalf("%s: %+v was delivered", what, input)
	default:
	}
}

func pressConnection(t *testing.T, e *Endpoint) *endpointConn {
	t.Helper()
	local, peer := net.Pipe()
	t.Cleanup(func() { peer.Close() })
	c := &endpointConn{conn: local, topics: map[topic]bool{}, out: make(chan endpointFrame, 8), done: make(chan struct{})}
	e.mu.Lock()
	e.conns[c] = true
	e.mu.Unlock()
	return c
}

func pointer(t *testing.T, e *Endpoint, c *endpointConn, phase string, x, y float64) error {
	t.Helper()
	params, _ := json.Marshal(map[string]any{"window": "main", "x": x, "y": y, "phase": phase})
	_, err := inputPointer(e, c, params, nil)
	return err
}

// The close of a connection releases its open press at the point of its last delivered input, so the gesture ends.
// contract: endpoint.input.close-releases-presses
func TestTheCloseOfAConnectionReleasesItsPressAtItsLastPoint(t *testing.T) {
	backend := newPressBackend()
	e := NewEndpoint(backend)
	owner := pressConnection(t, e)
	if err := pointer(t, e, owner, "down", 10, 20); err != nil {
		t.Fatal(err)
	}
	if err := pointer(t, e, owner, "drag", 30, 40); err != nil {
		t.Fatal(err)
	}
	backend.next(t, "down")
	backend.next(t, "drag")
	e.drop(owner, "peer closed")
	up := backend.next(t, "the close of the connection that owns the press")
	if up.Phase != "up" || up.X != 30 || up.Y != 40 || up.Pointer != mainPointer || up.Button != "left" {
		t.Fatalf("the close delivered %+v, want the up of pointer main button left at 30,40", up)
	}
	// The press ended, so a later close releases nothing again.
	e.drop(owner, "again")
	backend.none(t, "a second close")
}

// A delivered up of another connection ends the press, so the close of its owner releases nothing.
// contract: endpoint.input.close-releases-presses
func TestAPressThatAnUpEndedIsNotReleasedAgain(t *testing.T) {
	backend := newPressBackend()
	e := NewEndpoint(backend)
	owner, other := pressConnection(t, e), pressConnection(t, e)
	if err := pointer(t, e, owner, "down", 1, 2); err != nil {
		t.Fatal(err)
	}
	if err := pointer(t, e, other, "up", 3, 4); err != nil {
		t.Fatal(err)
	}
	backend.next(t, "down")
	backend.next(t, "up")
	e.drop(owner, "peer closed")
	backend.none(t, "the close of a connection whose press an up ended")
}

// A release refused with 1007 is delivered at the next change of host.buttons to mask 0, and not at another value.
// contract: endpoint.input.close-releases-presses
func TestAReleaseRefusedWhileAButtonIsHeldIsDeliveredWhenTheButtonsRise(t *testing.T) {
	backend := newPressBackend(rpcError(codeButtonHeld, "held"))
	e := NewEndpoint(backend)
	owner := pressConnection(t, e)
	if err := pointer(t, e, owner, "down", 5, 6); err != nil {
		t.Fatal(err)
	}
	backend.next(t, "down")
	e.drop(owner, "peer closed")
	if up := backend.next(t, "the close"); up.Phase != "up" {
		t.Fatalf("the close delivered %+v, want an up", up)
	}
	e.NotifyWatchers("host.buttons", map[string]any{"mask": uint64(1)})
	e.NotifyWatchers("host.buttons", map[string]any{"mask": uint64(0)})
	// NotifyWatchers must not block its caller, so the retry runs in a routine of the endpoint.
	up := backend.later()
	if up.Phase != "up" || up.X != 5 || up.Y != 6 {
		t.Fatalf("the retry delivered %+v, want the up at 5,6", up)
	}
	backend.none(t, "after the delivered retry")
}

// A release refused with 1011 is delivered at the next end of a press.
// contract: endpoint.input.close-releases-presses
func TestAReleaseRefusedForAnotherPointerIsDeliveredAtTheEndOfAPress(t *testing.T) {
	backend := newPressBackend(rpcError(codePointerHeld, "shared"))
	e := NewEndpoint(backend)
	owner, other := pressConnection(t, e), pressConnection(t, e)
	if err := pointer(t, e, owner, "down", 7, 8); err != nil {
		t.Fatal(err)
	}
	backend.next(t, "down")
	e.drop(owner, "peer closed")
	backend.next(t, "the refused release")
	params, _ := json.Marshal(map[string]any{"window": "main", "pointer": "second", "x": 0, "y": 0, "phase": "up"})
	if _, err := inputPointer(e, other, params, nil); err != nil {
		t.Fatal(err)
	}
	backend.next(t, "the up of the other pointer")
	up := backend.next(t, "the end of a press after a release refused with 1011")
	if up.Phase != "up" || up.Pointer != mainPointer || up.X != 7 || up.Y != 8 {
		t.Fatalf("the retry delivered %+v, want the up of pointer main at 7,8", up)
	}
}

// settled returns after every job that the queue of topic t held when it was called ran: the queue runs its jobs in order.
func settled(e *Endpoint, t topic) {
	done := make(chan struct{})
	e.enqueue(t, false, func() { close(done) })
	<-done
}

// endedFrame is the next frame that c holds, read after the jobs that send it ran (settled).
func endedFrame(t *testing.T, c *endpointConn, what string) map[string]any {
	t.Helper()
	select {
	case frame := <-c.out:
		var got map[string]any
		if err := json.Unmarshal(frame.body, &got); err != nil {
			t.Fatal(err)
		}
		return got
	default:
		t.Fatalf("%s: no notification reached the connection", what)
		return nil
	}
}

// The close of a surface ends the watches of that surface with status.ended after the status.changed sent before, sends
// nothing after it, keeps the watches of other surfaces and asks nothing of the page (the backend is nil).
// contract: endpoint.status.ended-ends-a-watch
func TestTheCloseOfASurfaceEndsItsWatches(t *testing.T) {
	e := NewEndpoint(nil)
	watcher := &endpointConn{topics: map[topic]bool{}, out: make(chan endpointFrame, 8), done: make(chan struct{})}
	e.conns[watcher] = true
	closing, staying := topic{"main", "fixture.value", "tab"}, topic{"main", "fixture.value", "other"}
	e.subscribe(watcher, closing, true)
	e.subscribe(watcher, staying, true)
	s := &Surfaces{host: &Host{relay: NewRelay[relayTarget](), endpoint: e}, name: "main", events: func(string, any) {}}
	e.StatusChanged("main", "fixture.value", "tab", 1)
	s.surfacesClosed([]string{"tab"})
	settled(e, closing)
	if got := endedFrame(t, watcher, "status.changed"); got["method"] != "status.changed" {
		t.Fatalf("first frame %v, want the status.changed sent before", got)
	}
	got := endedFrame(t, watcher, "the close of the surface")
	params, _ := got["params"].(map[string]any)
	if got["method"] != "status.ended" || params["window"] != "main" || params["name"] != "fixture.value" ||
		params["surface"] != "tab" || params["reason"] != "surface-closed" {
		t.Fatalf("frame %v, want status.ended of fixture.value of surface tab with reason surface-closed", got)
	}
	e.StatusChanged("main", "fixture.value", "tab", 2)
	select {
	case frame := <-watcher.out:
		t.Fatalf("a change after the end reached the connection: %s", frame.body)
	default:
	}
	for _, held := range e.topics("main") {
		if held == closing {
			t.Fatal("the ended watch is still counted, so a later watch would not start anew")
		}
	}
	e.mu.Lock()
	kept := watcher.topics[staying] && e.counts[staying] == 1
	e.mu.Unlock()
	if !kept {
		t.Fatal("the watch of another surface ended")
	}
}
