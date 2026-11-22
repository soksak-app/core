// An owned session belongs to the surface that opened it, its owner (docs/spec/plugins.md#owned-sessions). The owner's messages go to the
// persistent sidecar of the plugin as the requests open, resize and end, and the reply of each request is the answer of the command. The
// status core.sessions lists the open sessions, and the events workbench.session.open and workbench.session.end record their changes.
package workbench_test

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

const sessionSidecar = "@scope/fixture-service"

// cardSize is the size of a card in points at the backing scale 2, and resizedSize the size that the resize tests send.
var (
	cardSize    = workbench.Size{Width: 640, Height: 384, Scale: 2}
	resizedSize = workbench.Size{Width: 1000, Height: 600, Scale: 2}
)

type ownedSend struct {
	surface string
	body    map[string]any
	cids    []string
	answer  bool
}

// ownedHost is the host side of the owned sessions of a window: it records each sidecarSend, answers it with the reply that the test
// sets for its operation, and answers sidecarSessions with the sessions that the service holds.
type ownedHost struct {
	mu    sync.Mutex
	sends []ownedSend
	// reply returns the reply body of a request, given its operation and its body; nil means an empty reply.
	reply func(op string, body map[string]any) map[string]any
	// sessions is the answer of sidecarSessions, and sessionsFailure its error.
	sessions        []map[string]any
	sessionsFailure error
	// viewSends are the requests that a mounted view sent through viewSidecarSend.
	viewSends []ownedViewSend
}

// ownedViewSend is a request of a mounted view with its source generation.
type ownedViewSend struct {
	ownedSend
	generation uint64
}

func (h *ownedHost) table() map[string]workbench.HostCall {
	return map[string]workbench.HostCall{
		"sidecarListen": func(_ context.Context, _ json.RawMessage) (any, error) { return nil, nil },
		"sidecarSend": func(_ context.Context, argument json.RawMessage) (any, error) {
			var request struct {
				Sidecar string
				Surface string
				Body    json.RawMessage
				Cids    []string
				Answer  bool
			}
			if err := json.Unmarshal(argument, &request); err != nil {
				return nil, err
			}
			var body map[string]any
			if err := json.Unmarshal(request.Body, &body); err != nil {
				return nil, err
			}
			h.mu.Lock()
			h.sends = append(h.sends, ownedSend{request.Surface, body, request.Cids, request.Answer})
			reply := h.reply
			h.mu.Unlock()
			if reply == nil {
				return map[string]any{}, nil
			}
			return reply(body["operation"].(string), body), nil
		},
		"viewSidecarSend": func(_ context.Context, argument json.RawMessage) (any, error) {
			var request struct {
				Source     string
				Generation uint64
				Surface    string
				Body       json.RawMessage
				Cids       []string
				Answer     bool
			}
			if err := json.Unmarshal(argument, &request); err != nil {
				return nil, err
			}
			var body map[string]any
			if err := json.Unmarshal(request.Body, &body); err != nil {
				return nil, err
			}
			h.mu.Lock()
			h.viewSends = append(h.viewSends, ownedViewSend{ownedSend{request.Surface, body, request.Cids, request.Answer}, request.Generation})
			reply := h.reply
			h.mu.Unlock()
			if reply == nil {
				return map[string]any{}, nil
			}
			return reply(body["operation"].(string), body), nil
		},
		"sidecarSessions": func(_ context.Context, argument json.RawMessage) (any, error) {
			h.mu.Lock()
			defer h.mu.Unlock()
			if h.sessionsFailure != nil {
				return nil, h.sessionsFailure
			}
			return map[string]any{"sessions": h.sessions}, nil
		},
	}
}

func (h *ownedHost) sent() []ownedSend {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]ownedSend(nil), h.sends...)
}

// ownedFixture is the owned sessions of a window over the real ports of its sidecars, with the plugin terminal declaring sessions, the
// plugin plain declaring none, and the surfaces of the layout that the test names with their plugins.
type ownedFixture struct {
	t        *testing.T
	host     *ownedHost
	ports    *workbench.HostSidecars
	sessions *workbench.OwnedSessions
	pending  steps
	events   *stateEvents
	layout   map[string]string
	// views are the mounted views of the fixture, and shown the sessions that its restored tabs name.
	views map[string]workbench.MountedView
	shown map[string]string
	ids   int
	// failures holds each error shown as "place: text".
	failures []string
}

// newSessions returns the owned sessions of a window over the ports of the fixture. A reopened window is a new value over the same
// service, so it holds no state of the window that it replaces.
func (f *ownedFixture) newSessions() *workbench.OwnedSessions {
	return workbench.NewOwnedSessions(workbench.OwnedPorts{
		Sidecar: func(plugin string) (string, bool) {
			if plugin == "terminal" {
				return sessionSidecar, true
			}
			return "", false
		},
		Sidecars: func() []string { return []string{sessionSidecar} },
		Port:     func(name string) workbench.OwnedSidecar { return f.ports.OwnedPort(name) },
		Plugin:   func(surface string) string { return f.layout[surface] },
		Mounted: func(surface string) (workbench.MountedView, bool) {
			view, ok := f.views[surface]
			return view, ok
		},
		Shown: func() map[string]string { return f.shown },
		Random: func() string {
			f.ids++
			return "c" + string(rune('0'+f.ids))
		},
		Emit:    f.events.emit,
		Changed: func() {},
		Listen: func(name, surface string, listener func(json.RawMessage), answer func(func(), error)) {
			f.ports.Port(name).On(surface, listener, answer)
		},
		Fail: func(place, text string) { f.failures = append(f.failures, place+": "+text) },
	})
}

func newOwnedFixture(t *testing.T) *ownedFixture {
	t.Helper()
	f := &ownedFixture{t: t, host: &ownedHost{}, pending: make(steps, 256), events: &stateEvents{}, layout: map[string]string{
		"owner-tab": "terminal", "other-tab": "terminal", "kept-tab": "terminal", "plain-tab": "plain",
	}, views: map[string]workbench.MountedView{}, shown: map[string]string{}}
	f.ports = workbench.NewHostSidecars(workbench.NewCalls(f.host.table(), f.pending.post), func(string) {})
	f.sessions = f.newSessions()
	return f
}

// run calls an owned-session operation, runs the steps it posted, and returns the error that the operation answered.
func (f *ownedFixture) run(call func(answer func(error))) error {
	f.t.Helper()
	var got error
	answered := false
	call(func(err error) { got, answered = err, true })
	f.pending.drain(f.t)
	if !answered {
		f.t.Fatal("the operation did not answer")
	}
	return got
}

func (f *ownedFixture) open(owner, plugin string, params string, size workbench.Size) (string, error) {
	f.t.Helper()
	var session string
	var got error
	answered := false
	f.sessions.Open(owner, plugin, json.RawMessage(params), size, func(id string, err error) {
		session, got, answered = id, err, true
	})
	f.pending.drain(f.t)
	if !answered {
		f.t.Fatal("open did not answer")
	}
	return session, got
}

// eventsNamed returns the fields of each event of name, in order.
func (f *ownedFixture) eventsNamed(name string) []map[string]any {
	var fields []map[string]any
	for _, event := range f.events.events {
		if event.name == name {
			fields = append(fields, event.fields)
		}
	}
	return fields
}

// openFixtureSession opens session of the owner tab and answers the open with the session identifier s-1.
func openFixtureSession(t *testing.T, f *ownedFixture) string {
	t.Helper()
	f.host.reply = func(op string, body map[string]any) map[string]any {
		creation := body["session"].(map[string]any)["creation"]
		return map[string]any{"session": "s-1", "creation": creation}
	}
	session, err := f.open("owner-tab", "terminal", `{"cwd":"/work"}`, cardSize)
	if err != nil || session != "s-1" {
		t.Fatalf("open = %q, %v; want s-1", session, err)
	}
	f.host.reply = nil
	f.host.mu.Lock()
	f.host.sends = nil
	f.host.mu.Unlock()
	return session
}

func TestOpenRefusesAPluginThatDeclaresNoSessions(t *testing.T) {
	f := newOwnedFixture(t)
	if _, err := f.open("plain-tab", "plain", `{}`, cardSize); err == nil || err.Error() != "plugin plain declares no sessions" {
		t.Fatalf("open error = %v", err)
	}
	equal(t, len(f.host.sent()), 0)
}

func TestOpenRefusesASizeThatIsNotPositive(t *testing.T) {
	f := newOwnedFixture(t)
	if _, err := f.open("owner-tab", "terminal", `{}`, workbench.Size{Width: 0, Height: 384, Scale: 2}); err == nil || err.Error() != "size width, height and scale must be positive numbers" {
		t.Fatalf("open error = %v", err)
	}
	equal(t, len(f.host.sent()), 0)
}

func TestOpenSendsTheOpenRequestToTheOwnerAndRecordsTheSession(t *testing.T) {
	f := newOwnedFixture(t)
	f.host.reply = func(op string, body map[string]any) map[string]any {
		return map[string]any{"session": "s-1", "creation": body["session"].(map[string]any)["creation"]}
	}
	session, err := f.open("owner-tab", "terminal", `{"cwd":"/work"}`, resizedSize)
	if err != nil || session != "s-1" {
		t.Fatalf("open = %q, %v", session, err)
	}
	sends := f.host.sent()
	equal(t, len(sends), 1)
	equal(t, sends[0].surface, "owner-tab")
	equal(t, len(sends[0].cids), 1)
	equal(t, sends[0].answer, true)
	equal(t, sends[0].body["operation"], "open")
	equal(t, sends[0].body["size"], map[string]any{"width": float64(1000), "height": float64(600), "scale": float64(2)})
	equal(t, sends[0].body["params"], map[string]any{"cwd": "/work"})
	equal(t, sends[0].body["session"], map[string]any{"creation": "c1"})
	opened := f.eventsNamed("workbench.session.open")
	equal(t, len(opened), 1)
	equal(t, opened[0]["session"], "s-1")
	equal(t, f.sessions.Status(), []map[string]any{{"session": "s-1", "plugin": "terminal", "owner": "owner-tab", "shownBy": nil}})
}

func TestOpenAnsweredWithAnErrorRecordsNoSession(t *testing.T) {
	f := newOwnedFixture(t)
	f.host.reply = func(string, map[string]any) map[string]any { return map[string]any{"error": "spawn failed"} }
	if _, err := f.open("owner-tab", "terminal", `{}`, cardSize); err == nil || err.Error() != "spawn failed" {
		t.Fatalf("open error = %v, want the reply error", err)
	}
	equal(t, len(f.sessions.Status()), 0)
	equal(t, len(f.eventsNamed("workbench.session.open")), 0)
}

func TestResizeOfASessionThatIsNotOpenIsRefused(t *testing.T) {
	f := newOwnedFixture(t)
	err := f.run(func(answer func(error)) { f.sessions.Resize("owner-tab", "s-9", cardSize, answer) })
	if err == nil || err.Error() != "session s-9 is not open" {
		t.Fatalf("resize error = %v", err)
	}
	equal(t, len(f.host.sent()), 0)
}

func TestResizeByAnotherSurfaceIsRefusedWhileNoTabShowsTheSession(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	err := f.run(func(answer func(error)) { f.sessions.Resize("other-tab", "s-1", cardSize, answer) })
	if err == nil || err.Error() != "surface other-tab does not own session s-1" {
		t.Fatalf("resize error = %v", err)
	}
	equal(t, len(f.host.sent()), 0)
}

func TestResizeByTheOwnerSendsTheNewSize(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	f.host.reply = func(op string, body map[string]any) map[string]any {
		return map[string]any{"session": body["session"], "size": body["size"]}
	}
	if err := f.run(func(answer func(error)) { f.sessions.Resize("owner-tab", "s-1", resizedSize, answer) }); err != nil {
		t.Fatalf("resize: %v", err)
	}
	sends := f.host.sent()
	equal(t, len(sends), 1)
	equal(t, sends[0].surface, "owner-tab")
	equal(t, sends[0].body, map[string]any{"operation": "resize", "session": "s-1", "size": map[string]any{"width": float64(1000), "height": float64(600), "scale": float64(2)}})
}

func TestAShowingTabMayResizeTheSessionItShows(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	f.show(t, "other-tab", "s-1")
	f.host.reply = func(op string, body map[string]any) map[string]any {
		return map[string]any{"session": body["session"], "size": body["size"]}
	}
	if err := f.run(func(answer func(error)) {
		f.sessions.Resize("other-tab", "s-1", workbench.Size{Width: 900, Height: 200, Scale: 2}, answer)
	}); err != nil {
		t.Fatalf("resize by the showing tab: %v", err)
	}
	equal(t, len(f.host.sent()), 1)
	equal(t, f.sessions.Status()[0]["shownBy"], "other-tab")
}

func TestEndByAnotherSurfaceIsRefusedEvenWhileATabShowsTheSession(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	f.show(t, "other-tab", "s-1")
	err := f.run(func(answer func(error)) { f.sessions.End("other-tab", "s-1", answer) })
	if err == nil || err.Error() != "surface other-tab does not own session s-1" {
		t.Fatalf("end error = %v", err)
	}
	equal(t, len(f.host.sent()), 0)
}

func TestEndByTheOwnerSendsTheEndAndRecordsTheSessionEnd(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	f.host.reply = func(op string, body map[string]any) map[string]any {
		return map[string]any{"session": body["session"], "ended": true}
	}
	if err := f.run(func(answer func(error)) { f.sessions.End("owner-tab", "s-1", answer) }); err != nil {
		t.Fatalf("end: %v", err)
	}
	sends := f.host.sent()
	equal(t, len(sends), 1)
	equal(t, sends[0].body, map[string]any{"operation": "end", "session": "s-1"})
	ends := f.eventsNamed("workbench.session.end")
	equal(t, len(ends), 1)
	equal(t, ends[0]["session"], "s-1")
	equal(t, ends[0]["reason"], "ended")
	equal(t, len(f.sessions.Status()), 0)
}

func TestRetireEndsTheSessionsOfOwnersThatLeftEveryLayout(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	f.host.reply = func(op string, body map[string]any) map[string]any {
		return map[string]any{"session": "s-2", "creation": body["session"].(map[string]any)["creation"]}
	}
	if _, err := f.open("other-tab", "terminal", `{}`, cardSize); err != nil {
		t.Fatalf("second open: %v", err)
	}
	f.show(t, "gone-tab", "s-2")
	f.sessions.Retire(func(surface string) bool { return surface == "other-tab" })
	ends := f.eventsNamed("workbench.session.end")
	equal(t, len(ends), 1)
	equal(t, ends[0]["session"], "s-1")
	equal(t, ends[0]["reason"], "owner-closed")
	equal(t, f.sessions.Status(), []map[string]any{{"session": "s-2", "plugin": "terminal", "owner": "other-tab", "shownBy": nil}})
}

func TestAdoptionKeepsTheSessionsOfRestoredOwnersAndEndsTheOthers(t *testing.T) {
	f := newOwnedFixture(t)
	f.host.sessions = []map[string]any{
		{"session": "s-3", "surface": "kept-tab", "root": "/work", "creation": "c3", "size": map[string]any{"width": 640, "height": 384, "scale": 2}},
		{"session": "s-4", "surface": "gone-tab", "root": "/work", "creation": "c4", "size": map[string]any{"width": 640, "height": 384, "scale": 2}},
	}
	var adopted error
	answered := false
	f.sessions.Adopt(func(surface string) bool { return surface == "kept-tab" }, func(err error) { adopted, answered = err, true })
	f.pending.drain(t)
	if !answered || adopted != nil {
		t.Fatalf("adopt = %v, answered %v", adopted, answered)
	}
	equal(t, f.sessions.Status(), []map[string]any{{"session": "s-3", "plugin": "terminal", "owner": "kept-tab", "shownBy": nil}})
	sends := f.host.sent()
	equal(t, len(sends), 1)
	equal(t, sends[0].surface, "gone-tab")
	equal(t, sends[0].body, map[string]any{"operation": "end", "session": "s-4"})
	ends := f.eventsNamed("workbench.session.end")
	equal(t, len(ends), 1)
	equal(t, ends[0]["reason"], "owner-absent")
}

func TestAdoptionFailsWhenTheServiceCannotList(t *testing.T) {
	f := newOwnedFixture(t)
	f.host.sessionsFailure = errors.New("owner list is unavailable")
	var got error
	f.sessions.Adopt(func(string) bool { return true }, func(err error) { got = err })
	f.pending.drain(t)
	if got == nil || got.Error() != "owner list is unavailable" {
		t.Fatalf("adopt error = %v, want the failure of the service", got)
	}
}

func TestMountedOwnerSendsItsRequestsThroughItsView(t *testing.T) {
	f := newOwnedFixture(t)
	f.views["owner-tab"] = workbench.MountedView{Generation: 7, Context: context.Background()}
	f.host.reply = func(op string, body map[string]any) map[string]any {
		return map[string]any{"session": "s-9", "creation": body["session"].(map[string]any)["creation"]}
	}
	var session string
	var got error
	answered := false
	f.sessions.Open("owner-tab", "terminal", json.RawMessage(`{}`), cardSize, func(id string, err error) { session, got, answered = id, err, true })
	f.pending.drain(f.t)
	if !answered || got != nil || session != "s-9" {
		t.Fatalf("open = %q, %v, answered %v", session, got, answered)
	}
	if len(f.host.sent()) != 0 {
		t.Fatalf("a mounted owner sent through the window: %+v", f.host.sent())
	}
	views := f.host.viewSends
	equal(t, len(views), 1)
	equal(t, views[0].generation, uint64(7))
	equal(t, views[0].surface, "owner-tab")
	equal(t, views[0].body["operation"], "open")
	equal(t, views[0].answer, true)
	equal(t, views[0].cids, []string{"c2"})
}

func TestRestoredTabShowsItsOpenSessionAfterAdoption(t *testing.T) {
	f := newOwnedFixture(t)
	f.host.sessions = []map[string]any{
		{"session": "s-3", "surface": "owner-tab", "root": "/work", "creation": "c3", "size": map[string]any{"width": 640, "height": 384, "scale": 2}},
	}
	f.shown = map[string]string{"kept-tab": "s-3", "gone-tab": "s-missing"}
	var adopted error
	answered := false
	f.sessions.Adopt(func(surface string) bool { return surface == "owner-tab" || surface == "kept-tab" }, func(err error) { adopted, answered = err, true })
	f.pending.drain(t)
	if !answered || adopted != nil {
		t.Fatalf("adopt = %v, answered %v", adopted, answered)
	}
	equal(t, f.sessions.Status(), []map[string]any{{"session": "s-3", "plugin": "terminal", "owner": "owner-tab", "shownBy": "kept-tab"}})
}

// A window close keeps its owned sessions: the close sends no end, and the reopened window reattaches the session that its restored
// layout shows (docs/spec/persistent-services.md#owned-sessions).
func TestWindowCloseKeepsTheSessionAndTheReopenedWindowReattachesIt(t *testing.T) {
	f := newOwnedFixture(t)
	f.host.reply = func(op string, body map[string]any) map[string]any {
		return map[string]any{"session": "s-7", "creation": body["session"].(map[string]any)["creation"]}
	}
	var session string
	answered := false
	f.sessions.Open("owner-tab", "terminal", json.RawMessage(`{}`), cardSize, func(id string, err error) { session, answered = id, true })
	f.pending.drain(t)
	if !answered || session != "s-7" {
		t.Fatalf("open = %q, answered %v", session, answered)
	}
	before := len(f.host.sent())
	// The window closes: its state is dropped without a request, and the service keeps the session.
	f.sessions = f.newSessions()
	f.host.sessions = []map[string]any{
		{"session": "s-7", "surface": "owner-tab", "root": "/work", "creation": "c1", "size": map[string]any{"width": 640, "height": 384, "scale": 2}},
	}
	f.shown = map[string]string{"kept-tab": "s-7"}
	var adopted error
	adoptAnswered := false
	f.sessions.Adopt(func(surface string) bool { return surface == "owner-tab" || surface == "kept-tab" }, func(err error) { adopted, adoptAnswered = err, true })
	f.pending.drain(t)
	if !adoptAnswered || adopted != nil {
		t.Fatalf("adopt = %v, answered %v", adopted, adoptAnswered)
	}
	equal(t, f.sessions.Status(), []map[string]any{{"session": "s-7", "plugin": "terminal", "owner": "owner-tab", "shownBy": "kept-tab"}})
	if sent := f.host.sent(); len(sent) != before {
		t.Fatalf("closing and reopening the window sent %d requests, want none: %+v", len(sent)-before, sent[before:])
	}
	if ends := f.eventsNamed("workbench.session.end"); len(ends) != 0 {
		t.Fatalf("the window close ended %d sessions", len(ends))
	}
}

// A tab that shows a session sizes it to its card: a frame change of the card sends the new size with the caller's tab as the sender
// (docs/spec/plugins.md#owned-sessions).
func TestCardFrameResizesTheSessionItsTabShows(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	f.show(t, "other-tab", "s-1")
	f.host.reply = func(op string, body map[string]any) map[string]any {
		return map[string]any{"session": body["session"], "size": body["size"]}
	}
	var got error
	answered := false
	f.sessions.CardFrame("other-tab", workbench.Size{Width: 800, Height: 500, Scale: 2}, func(err error) { got, answered = err, true })
	f.pending.drain(t)
	if !answered || got != nil {
		t.Fatalf("card frame = %v, answered %v", got, answered)
	}
	sends := f.host.sent()
	equal(t, len(sends), 1)
	equal(t, sends[0].surface, "owner-tab")
	equal(t, sends[0].body, map[string]any{"operation": "resize", "session": "s-1", "size": map[string]any{"width": float64(800), "height": float64(500), "scale": float64(2)}})
	equal(t, f.sessions.Status(), []map[string]any{{"session": "s-1", "plugin": "terminal", "owner": "owner-tab", "shownBy": "other-tab"}})
}

// The frame of a card that shows no session sends nothing.
func TestCardFrameOfATabThatShowsNoSessionSendsNothing(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	before := len(f.host.sent())
	answered := false
	f.sessions.CardFrame("plain-tab", workbench.Size{Width: 800, Height: 500, Scale: 2}, func(error) { answered = true })
	f.pending.drain(t)
	if !answered {
		t.Fatal("card frame did not answer")
	}
	equal(t, len(f.host.sent()), before)
}

// Frames that arrive before the reply of a resize send no second resize of the same size, because the first one is still pending.
func TestCardFramesDoNotRepeatAPendingResize(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	f.show(t, "other-tab", "s-1")
	f.host.reply = func(op string, body map[string]any) map[string]any {
		return map[string]any{"session": body["session"], "size": body["size"]}
	}
	card := workbench.Size{Width: 800, Height: 500, Scale: 2}
	f.sessions.CardFrame("other-tab", card, func(error) {})
	f.sessions.CardFrame("other-tab", card, func(error) {})
	f.pending.drain(t)
	equal(t, len(f.host.sent()), 1)
}

// show shows session in tab with the card size cardSize and waits for the answer of the show.
func (f *ownedFixture) show(t *testing.T, tab, session string) {
	t.Helper()
	var got error
	answered := false
	f.sessions.Show(tab, session, cardSize, func(err error) { got, answered = err, true })
	f.pending.drain(t)
	if !answered || got != nil {
		t.Fatalf("show %s in %s = %v, answered %v", session, tab, got, answered)
	}
}

// Showing a session sends its size to the service at once, when the size of the card is known (docs/spec/plugins.md#owned-sessions).
func TestShowSendsTheCardSizeAtOnce(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	f.host.reply = func(op string, body map[string]any) map[string]any {
		return map[string]any{"session": body["session"], "size": body["size"]}
	}
	card := workbench.Size{Width: 800, Height: 500, Scale: 2}
	var got error
	answered := false
	f.sessions.Show("other-tab", "s-1", card, func(err error) { got, answered = err, true })
	f.pending.drain(t)
	if !answered || got != nil {
		t.Fatalf("show = %v, answered %v", got, answered)
	}
	sends := f.host.sent()
	equal(t, len(sends), 1)
	equal(t, sends[0].surface, "owner-tab")
	equal(t, sends[0].body, map[string]any{"operation": "resize", "session": "s-1", "size": map[string]any{"width": float64(800), "height": float64(500), "scale": float64(2)}})
	equal(t, f.sessions.Status(), []map[string]any{{"session": "s-1", "plugin": "terminal", "owner": "owner-tab", "shownBy": "other-tab"}})
}

// A frame that does not change sends nothing, however many frames the window draws (docs/spec/plugins.md#owned-sessions).
func TestAnUnchangedCardFrameSendsNothingAcrossManyFrames(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	f.host.reply = func(op string, body map[string]any) map[string]any {
		return map[string]any{"session": body["session"], "size": body["size"]}
	}
	f.show(t, "other-tab", "s-1")
	card := workbench.Size{Width: 800, Height: 500, Scale: 2}
	for frame := 0; frame < 120; frame++ {
		f.sessions.CardFrame("other-tab", card, func(error) {})
		f.pending.drain(t)
	}
	equal(t, len(f.host.sent()), 1)
}

// surfaceMessage delivers body as a message of surface of the session sidecar, as the host does for a surface that the window listens to.
func (f *ownedFixture) surfaceMessage(surface, body string) {
	f.ports.Message(sessionSidecar, surface, json.RawMessage(body))
}

func TestSessionEndedFromTheOwnerEndsTheSessionWithoutARequest(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	f.surfaceMessage("owner-tab", `{"event":"session.ended","session":"s-1","reason":"ended"}`)
	equal(t, len(f.sessions.Status()), 0)
	equal(t, len(f.host.sent()), 0)
	equal(t, f.failures, []string(nil))
	ends := f.eventsNamed("workbench.session.end")
	equal(t, len(ends), 1)
	equal(t, ends[0]["session"], "s-1")
	equal(t, ends[0]["reason"], "ended")
}

func TestSessionEndedForAnUnknownSessionIsLoggedAndChangesNothing(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	f.surfaceMessage("owner-tab", `{"event":"session.ended","session":"s-9","reason":"ended"}`)
	equal(t, f.failures, []string{"core.session.ended s-9: session s-9 is not open"})
	equal(t, len(f.sessions.Status()), 1)
	equal(t, len(f.eventsNamed("workbench.session.end")), 0)
}

func TestRepeatedSessionEndedChangesNothingAfterTheFirst(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	f.surfaceMessage("owner-tab", `{"event":"session.ended","session":"s-1","reason":"ended"}`)
	f.surfaceMessage("owner-tab", `{"event":"session.ended","session":"s-1","reason":"ended"}`)
	equal(t, f.failures, []string{"core.session.ended s-1: session s-1 is not open"})
	equal(t, len(f.sessions.Status()), 0)
	equal(t, len(f.eventsNamed("workbench.session.end")), 1)
}

func TestSessionEndedNamingAnotherOwnersSessionIsRefused(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	f.host.reply = func(op string, body map[string]any) map[string]any {
		return map[string]any{"session": "s-2", "creation": body["session"].(map[string]any)["creation"]}
	}
	if _, err := f.open("other-tab", "terminal", `{}`, cardSize); err != nil {
		t.Fatalf("open of the other owner: %v", err)
	}
	f.surfaceMessage("owner-tab", `{"event":"session.ended","session":"s-2","reason":"ended"}`)
	equal(t, f.failures, []string{"core.session.ended s-2: surface owner-tab does not own session s-2"})
	equal(t, len(f.sessions.Status()), 2)
	equal(t, len(f.eventsNamed("workbench.session.end")), 0)
}

func TestSessionEndedWithAnotherReasonOrWithoutSessionIsRefused(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	f.surfaceMessage("owner-tab", `{"event":"session.ended","session":"s-1","reason":"owner-closed"}`)
	f.surfaceMessage("owner-tab", `{"event":"session.ended","reason":"ended"}`)
	equal(t, f.failures, []string{
		"core.session.ended: invalid session.ended body: reason",
		"core.session.ended: invalid session.ended body: session",
	})
	equal(t, len(f.sessions.Status()), 1)
}

func TestOtherBodiesOfTheOwnerAreNotSessionEnds(t *testing.T) {
	f := newOwnedFixture(t)
	openFixtureSession(t, f)
	f.surfaceMessage("owner-tab", `{"event":"output","text":"x"}`)
	f.surfaceMessage("owner-tab", `"plain text"`)
	f.surfaceMessage("owner-tab", `{"operation":"end","session":"s-1","ended":true}`)
	equal(t, f.failures, []string(nil))
	equal(t, len(f.sessions.Status()), 1)
}
