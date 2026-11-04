// A background session keeps the sidecar session of a tab that has no mounted surface (docs/spec/plugins.md). A tab whose surface
// stays mounted while another tab of its card is shown already owns its session with its image region, so a background open for it
// would be a second owner of the same surface. Each decision is the event workbench.background.session.
package workbench_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

type sentMessage struct {
	surface string
	body    string
}

// fakeSidecar records each send and keeps the listener of each surface. A held subscription finishes when finish runs.
type fakeSidecar struct {
	sends     []sentMessage
	listeners map[string]func(json.RawMessage)
	hold      bool
	finish    []func()
	refuseOn  error
	refuse    error
}

func (s *fakeSidecar) On(surface string, listener func(json.RawMessage), answer func(func(), error)) {
	if s.refuseOn != nil {
		answer(nil, s.refuseOn)
		return
	}
	s.listeners[surface] = listener
	done := func() { answer(func() { delete(s.listeners, surface) }, nil) }
	if s.hold {
		s.finish = append(s.finish, done)
		return
	}
	done()
}

func (s *fakeSidecar) Send(surface string, body any, answer func(error)) {
	if s.refuse != nil {
		answer(s.refuse)
		return
	}
	encoded, _ := json.Marshal(body)
	s.sends = append(s.sends, sentMessage{surface, string(encoded)})
	answer(nil)
}

func (s *fakeSidecar) deliver(surface, body string) {
	if listener := s.listeners[surface]; listener != nil {
		listener(json.RawMessage(body))
	}
}

const backgroundSidecar = "@scope/fixture-sidecar"

type backgroundHarness struct {
	sessions *workbench.BackgroundSessions
	sidecar  *fakeSidecar
	tabs     []workbench.BackgroundTab
	mounted  map[string]bool
	held     map[string]bool
	reports  []string
	events   *stateEvents
	ready    bool
	failed   bool
	wait     func(error)
	settings map[string]any
	missing  bool
}

func newBackground() *backgroundHarness {
	h := &backgroundHarness{sidecar: &fakeSidecar{listeners: map[string]func(json.RawMessage){}}, mounted: map[string]bool{}, held: map[string]bool{},
		events: &stateEvents{}, ready: true}
	h.sessions = workbench.NewBackgroundSessions(workbench.BackgroundPorts{
		Ready:  func() bool { return h.ready },
		Failed: func() bool { return h.failed },
		Wait:   func(answer func(error)) { h.wait = answer },
		Tabs:   func() []workbench.BackgroundTab { return h.tabs },
		Declaration: func(plugin string) *workbench.BackgroundDeclaration {
			if plugin != "session" {
				return nil
			}
			declaration := &workbench.BackgroundDeclaration{Sidecar: backgroundSidecar, Operation: "open"}
			if h.settings != nil {
				declaration.Settings = map[string]string{"shell": "program", "absent": "unset"}
			}
			return declaration
		},
		Held:    func(tab string) bool { return h.held[tab] },
		Mounted: func(tab string) bool { return h.mounted[tab] },
		Sidecar: func(name string) workbench.BackgroundSidecar {
			if h.missing {
				return nil
			}
			return h.sidecar
		},
		Settings: func(string) map[string]any { return h.settings },
		Report:   func(text string) { h.reports = append(h.reports, text) },
		Emit:     h.events.emit,
	})
	return h
}

func (h *backgroundHarness) sync(t *testing.T) {
	t.Helper()
	if err := h.sessions.Sync(); err != nil {
		t.Fatal(err)
	}
}

func (h *backgroundHarness) decisions(tab string) []string {
	var decisions []string
	for _, event := range h.events.events {
		if event.name == "workbench.background.session" && event.fields["tab"] == tab {
			decisions = append(decisions, event.fields["action"].(string)+":"+event.fields["surface"].(string))
		}
	}
	return decisions
}

func (h *backgroundHarness) opens(tab string) int {
	count := 0
	for _, send := range h.sidecar.sends {
		if send.surface == tab {
			count++
		}
	}
	return count
}

func twoTabs() []workbench.BackgroundTab {
	return []workbench.BackgroundTab{{ID: "shown", Plugin: "session", Active: true}, {ID: "hidden", Plugin: "session"}}
}

func TestABackgroundSessionOpensOnlyForATabWithoutAMountedSurfaceAndEndsWhenItsSurfaceMounts(t *testing.T) {
	h := newBackground()
	h.ready = false
	h.tabs = twoTabs()
	h.mounted["shown"] = true
	h.sync(t)
	equal(t, len(h.sidecar.sends), 0)
	h.sync(t)
	// A sync before the project context is committed waits once, and the commit syncs.
	h.ready = true
	h.wait(nil)
	equal(t, h.opens("hidden"), 1)
	equal(t, h.sidecar.sends[0], sentMessage{"hidden", `{"operation":"open"}`})
	equal(t, h.decisions("hidden"), []string{"open:absent"})
	equal(t, h.events.events[0], savedEvent{"info", "workbench.background.session",
		map[string]any{"tab": "hidden", "plugin": "session", "sidecar": backgroundSidecar, "action": "open", "surface": "absent"}})

	// A tab of another plugin is shown in the card. The surface of the first tab stays mounted and keeps its session.
	h.tabs = []workbench.BackgroundTab{{ID: "shown", Plugin: "session"}, {ID: "hidden", Plugin: "session"}, {ID: "doc", Plugin: "document", Active: true}}
	h.sync(t)
	h.sync(t)
	equal(t, h.opens("shown"), 0)
	equal(t, h.decisions("shown"), []string{"skip:mounted"})
	equal(t, len(h.decisions("doc")), 0)

	// The tab that had a background session is shown: its surface mounts and owns the session from then on.
	h.tabs[1].Active, h.tabs[2].Active = true, false
	h.mounted["hidden"] = true
	h.sync(t)
	equal(t, h.decisions("hidden"), []string{"open:absent", "stop:mounted"})
	// A respawned service announces the new connection; only a background session reopens, and this tab has none any more.
	h.sidecar.deliver("hidden", `{"event":"connection","connected":true}`)
	equal(t, h.opens("hidden"), 1)
	equal(t, len(h.reports), 0)
}

func TestAFailedProjectContextStartsNoSessionAndReportsNothing(t *testing.T) {
	h := newBackground()
	h.ready = false
	h.tabs = twoTabs()
	h.sync(t)
	h.failed = true
	h.wait(errors.New("initial project context failed"))
	h.sync(t)
	equal(t, len(h.sidecar.sends), 0)
	equal(t, len(h.reports), 0)
}

func TestATabWithoutADeclarationOrWithAHeldImageDetachOpensNoSession(t *testing.T) {
	h := newBackground()
	h.tabs = []workbench.BackgroundTab{{ID: "held", Plugin: "session"}, {ID: "doc", Plugin: "document"}}
	h.held["held"] = true
	h.sync(t)
	equal(t, len(h.sidecar.sends), 0)
	equal(t, len(h.events.events), 0)
	h.held["held"] = false
	h.sync(t)
	equal(t, h.opens("held"), 1)
}

func TestAnUnavailableSidecarIsRefused(t *testing.T) {
	h := newBackground()
	h.tabs = []workbench.BackgroundTab{{ID: "a", Plugin: "session"}}
	h.missing = true
	equal(t, message(h.sessions.Sync()), "background sidecar unavailable: "+backgroundSidecar)
}

func TestTheDeclaredSettingsFillTheirRequestFields(t *testing.T) {
	h := newBackground()
	h.settings = map[string]any{"program": "zsh"}
	h.tabs = []workbench.BackgroundTab{{ID: "a", Plugin: "session"}}
	h.sync(t)
	equal(t, h.sidecar.sends[0].body, `{"operation":"open","shell":"zsh"}`)
}

func TestAReconnectionOpensAgainWithTheCurrentSettingsAndIsRecordedEachTime(t *testing.T) {
	h := newBackground()
	h.settings = map[string]any{"program": "zsh"}
	h.tabs = []workbench.BackgroundTab{{ID: "a", Plugin: "session"}}
	h.sync(t)
	h.settings["program"] = "fish"
	h.sidecar.deliver("a", `{"event":"connection","connected":true}`)
	h.sidecar.deliver("a", `{"event":"connection","connected":true}`)
	equal(t, h.sidecar.sends[1].body, `{"operation":"open","shell":"fish"}`)
	equal(t, h.decisions("a"), []string{"open:absent", "reopen:absent", "reopen:absent"})
}

func TestTheFailuresOfASessionAreReported(t *testing.T) {
	h := newBackground()
	h.tabs = []workbench.BackgroundTab{{ID: "a", Plugin: "session"}}
	h.sync(t)
	h.sidecar.deliver("a", `{"event":"connection","connected":false}`)
	h.sidecar.deliver("a", `{"event":"connection","connected":false,"reason":"spawn failed"}`)
	h.sidecar.deliver("a", `{"error":"bad"}`)
	h.sidecar.deliver("a", `{"error":"bad","reason":"why"}`)
	h.sidecar.deliver("a", `{"body":{"error":"inner","reason":"deep"}}`)
	h.sidecar.deliver("a", `{"ok":true}`)
	h.sidecar.deliver("a", `{"error":""}`)
	h.sidecar.deliver("a", `null`)
	equal(t, h.reports, []string{
		"background session a: sidecar connection failed",
		"background session a: sidecar connection failed: spawn failed",
		"background session a: bad",
		"background session a: bad: why",
		"background session a: inner: deep",
	})
	h.sidecar.refuse = errors.New("closed")
	h.sidecar.deliver("a", `{"event":"connection","connected":true}`)
	equal(t, h.reports[len(h.reports)-1], "background session a reopen failed: closed")
}

func TestAFailedOpenEndsTheSessionSoTheNextSyncOpensAgain(t *testing.T) {
	h := newBackground()
	h.tabs = []workbench.BackgroundTab{{ID: "a", Plugin: "session"}}
	h.sidecar.refuse = errors.New("closed")
	h.sync(t)
	equal(t, h.reports, []string{"background session a open failed: closed"})
	h.sidecar.refuse = nil
	h.sync(t)
	equal(t, h.opens("a"), 1)
}

func TestAFailedSubscriptionIsReportedAndSendsNothing(t *testing.T) {
	h := newBackground()
	h.tabs = []workbench.BackgroundTab{{ID: "a", Plugin: "session"}}
	h.sidecar.refuseOn = errors.New("refused")
	h.sync(t)
	equal(t, h.reports, []string{"background session a listener failed: refused"})
	equal(t, len(h.sidecar.sends), 0)
}

func TestTheOpenFollowsTheSubscription(t *testing.T) {
	h := newBackground()
	h.sidecar.hold = true
	h.tabs = []workbench.BackgroundTab{{ID: "a", Plugin: "session"}}
	h.sync(t)
	equal(t, len(h.sidecar.sends), 0)
	h.sidecar.finish[0]()
	equal(t, h.opens("a"), 1)
}

func TestABackgroundSessionWhoseTabClosesBeforeItsSubscriptionFinishedEndsTheSubscription(t *testing.T) {
	h := newBackground()
	h.sidecar.hold = true
	h.tabs = []workbench.BackgroundTab{{ID: "a", Plugin: "session"}}
	h.sync(t)
	if h.sidecar.listeners["a"] == nil {
		t.Fatal("no listener")
	}
	h.tabs = nil
	h.sync(t)
	h.sidecar.finish[0]()
	equal(t, len(h.sidecar.listeners), 0)
	equal(t, len(h.sidecar.sends), 0)
	equal(t, len(h.reports), 0)
}

func TestClosingATabEndsItsSessionAndForgetsItsDecision(t *testing.T) {
	h := newBackground()
	h.tabs = []workbench.BackgroundTab{{ID: "a", Plugin: "session"}}
	h.sync(t)
	h.tabs = nil
	h.sync(t)
	equal(t, len(h.sidecar.listeners), 0)
	h.tabs = []workbench.BackgroundTab{{ID: "a", Plugin: "session"}}
	h.sync(t)
	equal(t, h.decisions("a"), []string{"open:absent", "open:absent"})
}

func TestTheHostSidecarsShareOneOrderAndOneRegistrationOfAPair(t *testing.T) {
	var calls []string
	queue := make(chan struct{}, 8)
	host := workbench.NewCalls(map[string]workbench.HostCall{
		"sidecarListen": recordCall(&calls, "listen", queue),
		"sidecarSend":   recordCall(&calls, "send", queue),
	}, func(task func()) { task() })
	sidecars := workbench.NewHostSidecars(host, func(text string) { calls = append(calls, "report "+text) })
	port := sidecars.Port("files")
	var messages []string
	var stops []func()
	listen := func() {
		done := make(chan struct{})
		port.On("a", func(body json.RawMessage) { messages = append(messages, string(body)) }, func(stop func(), err error) {
			if err != nil {
				t.Error(err)
			}
			stops = append(stops, stop)
			close(done)
		})
		<-done
	}
	listen()
	listen()
	sidecars.Message("files", "a", json.RawMessage(`{"n":1}`))
	sidecars.Message("files", "b", json.RawMessage(`{"n":2}`))
	sidecars.Message("other", "a", json.RawMessage(`{"n":3}`))
	equal(t, messages, []string{`{"n":1}`, `{"n":1}`})
	sent := make(chan struct{})
	port.Send("a", map[string]any{"operation": "open"}, func(err error) {
		if err != nil {
			t.Error(err)
		}
		close(sent)
	})
	<-sent
	stops[0]()
	equal(t, len(messages), 2)
	sidecars.Message("files", "a", json.RawMessage(`{"n":4}`))
	equal(t, len(messages), 3)
	stops[1]()
	<-queue
	<-queue
	<-queue
	equal(t, calls, []string{
		`listen {"id":"a","on":true,"sidecar":"files"}`,
		`send {"body":{"operation":"open"},"cids":[],"sidecar":"files","surface":"a"}`,
		`listen {"id":"a","on":false,"sidecar":"files"}`,
	})
}

func recordCall(calls *[]string, name string, done chan struct{}) workbench.HostCall {
	return func(_ context.Context, argument json.RawMessage) (any, error) {
		*calls = append(*calls, name+" "+string(argument))
		done <- struct{}{}
		return nil, nil
	}
}
