package host

import (
	"encoding/json"
	"sync"
	"testing"
	"unsafe"
)

// A connection that starts watching host.window after its earlier watch ended receives the next status of the window,
// even when the status equals the status sent before the earlier watch ended. The endpoint keeps no record of sent
// values, so the value is announced to every connection that watches the status.
// contract: status.window.rewatch-notifies
func TestAWatchStartedAfterAnUnwatchReceivesTheNextWindowStatus(t *testing.T) {
	endpoint := NewEndpoint(nil)
	conn := &endpointConn{topics: map[topic]bool{}, out: make(chan endpointFrame, 4), done: make(chan struct{})}
	endpoint.conns[conn] = true
	window := topic{"main", "host.window", ""}
	open := map[string]any{"modal": "open"}

	endpoint.subscribe(conn, window, true)
	endpoint.StatusChanged("main", "host.window", "", open)
	endpoint.subscribe(conn, window, false)
	endpoint.subscribe(conn, window, true)
	endpoint.StatusChanged("main", "host.window", "", open)

	for n := 1; n <= 2; n++ {
		<-conn.out
	}
}

// contract: view.exposure.register
// A relayed registration is recorded with the window and announced to the main page, and a repeated relay records it once.
func TestRelayedViewRegistrationIsRecordedAndAnnounced(t *testing.T) {
	s := NewSurfaces(nil, nil)
	announced := []any{}
	s.events = func(name string, data any) {
		announced = append(announced, map[string]any{"name": name, "data": data})
	}
	req := SurfaceRegistration{Surface: "probe-surface", Kind: "status", Name: "probe.lines"}
	if err := s.recordRegistration(req); err != nil {
		t.Fatalf("record: %v", err)
	}
	if len(s.registrations["probe-surface"]) != 1 || s.registrations["probe-surface"][0] != req {
		t.Fatalf("recorded registrations %v, want one entry for probe-surface", s.registrations)
	}
	if len(announced) != 1 {
		t.Fatalf("announced events %v, want one exposure-registered event", announced)
	}
	// A repeated relay records nothing again.
	if err := s.recordRegistration(req); err != nil {
		t.Fatalf("re-record: %v", err)
	}
	if len(s.registrations["probe-surface"]) != 1 || len(announced) != 2 {
		t.Fatalf("repeat: registrations %d, announcements %d, want the entry kept once and the event announced again",
			len(s.registrations["probe-surface"]), len(announced))
	}
}

// contract: view.exposure.register
// A registration of an unknown kind, of a host name, of a core name or of an invalid name is refused and records nothing.
func TestRelayedViewRegistrationRefusalsRecordNothing(t *testing.T) {
	for _, test := range []struct{ name, kind, want string }{
		{"probe.lines", "entry", `unknown exposure kind "entry"`},
		{"probe.card", "dom", `unknown exposure kind "dom"`},
		{"probe.card", "element", ""},
		{"host.buttons", "status", `a surface cannot register "host.buttons"`},
		{"core.grid", "status", `a surface cannot register "core.grid"`},
		{"core.surface.document", "status", ""},
		{"Probe Lines", "status", `a surface cannot register "Probe Lines"`},
	} {
		s := NewSurfaces(nil, nil)
		s.events = func(string, any) {}
		err := s.recordRegistration(SurfaceRegistration{Surface: "probe-surface", Kind: test.kind, Name: test.name})
		if test.want == "" {
			if err != nil {
				t.Fatalf("%s %s: %v, want accepted", test.kind, test.name, err)
			}
			continue
		}
		if err == nil || err.Error() != test.want {
			t.Fatalf("%s %s: %v, want %s", test.kind, test.name, err, test.want)
		}
		if len(s.registrations["probe-surface"]) != 0 {
			t.Fatalf("%s %s recorded %v, want nothing", test.kind, test.name, s.registrations["probe-surface"])
		}
	}
}

// contract: sidecars.close.answer-ends-closing
func TestSidecarStatusNotificationDoesNotWaitForWindowRegistry(t *testing.T) {
	endpoint := NewEndpoint(nil)
	conn := &endpointConn{topics: map[topic]bool{}, out: make(chan endpointFrame, 4), done: make(chan struct{})}
	endpoint.conns[conn] = true
	endpoint.subscribe(conn, topic{"main", "host.sidecars", ""}, true)
	c := sidecarSessionSurfaces(t).sidecars
	c.closing["fixture-sidecar"] = map[string]int{"s1": 1}
	h := &Host{endpoint: endpoint, sidecars: c}
	// Window registry work must not defer the application-wide state notification.
	h.mu.Lock()
	done := make(chan struct{})
	go func() {
		h.sidecarsChanged(c.Status())
		close(done)
	}()
	t.Cleanup(func() {
		h.mu.Unlock()
		<-done
	})
	frame := <-conn.out
	data := frame.body
	var got struct {
		Method string
		Params struct {
			Name  string
			Value struct{ Closing []ClosingSurface }
		}
	}
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if got.Method != "status.changed" || got.Params.Name != "host.sidecars" ||
		len(got.Params.Value.Closing) != 1 || got.Params.Value.Closing[0].Surface != "s1" {
		t.Fatalf("closing transition notification = %s", data)
	}
}

// reloadFixture returns a window whose host holds a relay, and a second window of the same host.
func reloadFixture() (*Surfaces, *Surfaces) {
	h := &Host{relay: NewRelay[relayTarget]()}
	return &Surfaces{host: h}, &Surfaces{host: h}
}

// pendingSurface sends a request to surface and returns the channel of its reply after the relay holds it.
func pendingSurface(t *testing.T, s *Surfaces, surface string) <-chan ExposureResult {
	t.Helper()
	reply := make(chan ExposureResult, 1)
	sent := make(chan struct{})
	go func() {
		reply <- s.requestSurface(surface, func(uint64) error {
			close(sent)
			return nil
		})
	}()
	<-sent
	return reply
}

// contract: exposure.relay.page-reload-ends-surface-requests
func TestReloadAskedOfAPageEndsTheRequestsToItsSurfaces(t *testing.T) {
	reloading, other := reloadFixture()
	mine := pendingSurface(t, reloading, "tab")
	theirs := pendingSurface(t, other, "tab")
	emitted := false
	reloading.askPageToReload(func() {
		emitted = true
		select {
		case reply := <-mine:
			t.Errorf("the request ended before the page received the reload request: %+v", reply)
		default:
		}
	})
	if !emitted {
		t.Fatal("the reload request was not sent")
	}
	select {
	case reply := <-mine:
		if reply.Error == nil || reply.Error.Code != codeNoWindow {
			t.Fatalf("reply %+v, want %d", reply, codeNoWindow)
		}
	}
	// The reload ends the requests that it ends before it returns, so the relay still holds the request of the other window.
	other.host.relay.mu.Lock()
	held := len(other.host.relay.waiting)
	other.host.relay.mu.Unlock()
	if held != 1 {
		t.Fatalf("the relay holds %d requests after the reload, want the request to a surface of another window", held)
	}
	other.host.relay.Abandon(func(relayTarget) bool { return true })
	<-theirs
}

// contract: exposure.relay.page-reload-ends-surface-requests
func TestARequestAfterTheReloadIsRefusedUntilTheNewPageStarts(t *testing.T) {
	s, _ := reloadFixture()
	s.askPageToReload(func() {})
	sent := false
	reply := s.requestSurface("tab", func(uint64) error {
		sent = true
		return nil
	})
	if sent {
		t.Fatal("a request sent after the reload request reached the document")
	}
	if reply.Error == nil || reply.Error.Code != codeNoWindow {
		t.Fatalf("reply %+v, want %d", reply, codeNoWindow)
	}
	s.pageStarted()
	if reply := s.requestSurface("tab", func(id uint64) error {
		sent = true
		return s.host.relay.Resolve(id, relayTarget{owner: s, surface: "tab"}, ExposureResult{})
	}); !sent || reply.Error != nil {
		t.Fatalf("after the new page started: sent %v, reply %+v", sent, reply)
	}
}

// The changes that arrive during a reading join into one further reading, which begins after the last of them. A reading that
// began earlier therefore cannot send its older value after a newer one.
// contract: status.window.latest-value-last
func TestABurstOfWindowChangesIsOneMoreReadingAfterTheLastChange(t *testing.T) {
	var reads latestRead
	var mu sync.Mutex
	var seen []int
	began := make(chan struct{}, 256)
	release := make(chan struct{})
	current := 0
	read := func() {
		mu.Lock()
		seen = append(seen, current)
		mu.Unlock()
		began <- struct{}{}
		<-release
	}
	reads.ask("window-status", read)
	<-began
	for n := 1; n <= 100; n++ {
		mu.Lock()
		current = n
		mu.Unlock()
		reads.ask("window-status", read)
	}
	// The first reading ends, and the changes of the burst begin one further reading.
	release <- struct{}{}
	<-began
	// While that reading is held no change waits, so it is the last reading: none begins after it until a new change.
	reads.mu.Lock()
	running, again := reads.running, reads.again
	reads.mu.Unlock()
	close(release)
	if !running || again {
		t.Fatalf("during the reading after the burst: running %v, another reading asked %v", running, again)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 2 || seen[0] != 0 || seen[1] != 100 {
		t.Fatalf("the readings of the burst saw %v, want [0 100]", seen)
	}
}

// contract: exposure.relay.surface-process-end-ends-its-requests
func TestTheEndOfTheProcessOfASurfacePageEndsTheRequestsToThatSurface(t *testing.T) {
	// The end of the process of a surface page steps on the main thread (surfaceTerminated).
	useStepFramework(t)
	s, other := reloadFixture()
	s.streams = NewDocumentStreams()
	handle := unsafe.Pointer(new(int))
	s.named = map[uintptr]string{uintptr(handle): "tab"}
	const viewID = 987654
	nativeViews[viewID] = &nativeWebview{owner: s, id: viewID, handle: handle}
	t.Cleanup(func() { delete(nativeViews, viewID) })
	mine := pendingSurface(t, s, "tab")
	sibling := pendingSurface(t, s, "other-tab")
	theirs := pendingSurface(t, other, "tab")
	s.surfaceTerminated(viewID)
	if reply := <-mine; reply.Error == nil || reply.Error.Code != codeNoWindow {
		t.Fatalf("reply %+v, want %d", reply, codeNoWindow)
	}
	for name, reply := range map[string]<-chan ExposureResult{"another surface": sibling, "another window": theirs} {
		select {
		case got := <-reply:
			t.Fatalf("the request to %s ended: %+v", name, got)
		default:
		}
	}
	s.host.relay.Abandon(func(relayTarget) bool { return true })
	<-sibling
	<-theirs
}
