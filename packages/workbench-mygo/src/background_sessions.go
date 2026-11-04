package workbench

import (
	"encoding/json"
	"fmt"
)

// BackgroundTab is a tab of the layout as the background sessions read it. Active tells whether it is the active tab of its card.
type BackgroundTab struct {
	ID     string
	Plugin string
	Active bool
}

// BackgroundDeclaration is the background declaration of a plugin: the operation that the tabs of the plugin keep a session of, and
// the request fields that take the values of its settings.
type BackgroundDeclaration struct {
	Sidecar   string
	Operation string
	// Settings maps a request field to a declared setting.
	Settings map[string]string
}

// BackgroundSidecar is the port of one sidecar of the window.
type BackgroundSidecar interface {
	// On calls listener for each message of surface, and answers with what stops it after the host applied the registration.
	On(surface string, listener func(body json.RawMessage), answer func(stop func(), err error))
	// Send sends body after the earlier sends to the sidecar finished.
	Send(surface string, body any, answer func(err error))
}

// BackgroundPorts is what the background sessions use. Every port and every answer runs in a step of the main thread.
type BackgroundPorts struct {
	// Ready and Failed tell whether the initial project context is committed or failed, and Wait answers when it settled. The owner
	// of the start reports its failure.
	Ready  func() bool
	Failed func() bool
	Wait   func(answer func(err error))
	// Tabs returns each tab of the layout once.
	Tabs func() []BackgroundTab
	// Declaration returns the background declaration of plugin, or nil for a plugin without one or that is not loaded.
	Declaration func(plugin string) *BackgroundDeclaration
	// Held tells whether an image detach of tab is pending or failed.
	Held func(tab string) bool
	// Mounted tells whether the surface of tab is mounted.
	Mounted func(tab string) bool
	// Sidecar returns the port of the sidecar name, or nil.
	Sidecar func(name string) BackgroundSidecar
	// Settings returns the current values of the settings of plugin.
	Settings func(plugin string) map[string]any
	// Report writes a failure of a session to the application log.
	Report func(text string)
	Emit   func(level, name string, fields map[string]any)
}

type backgroundSession struct {
	stop    func()
	stopped bool
}

func (s *backgroundSession) end() {
	s.stopped = true
	// The subscription of a session that stopped before it finished stops itself when it finishes.
	if s.stop != nil {
		s.stop()
	}
}

// BackgroundSessions keeps one declared sidecar session for each non-active tab whose surface is not mounted, without a native surface
// (docs/spec/plugins.md). A tab whose surface is mounted owns its session through that surface.
type BackgroundSessions struct {
	ports    BackgroundPorts
	sessions map[string]*backgroundSession
	// decisions holds the last decision recorded for each tab with a declaration, so a sync that changes nothing records nothing.
	decisions map[string]string
	waiting   bool
}

// NewBackgroundSessions returns the background sessions over ports.
func NewBackgroundSessions(ports BackgroundPorts) *BackgroundSessions {
	return &BackgroundSessions{ports: ports, sessions: map[string]*backgroundSession{}, decisions: map[string]string{}}
}

// record records a decision of the background session of tab: open and reopen send the declared operation, skip sends nothing for a
// tab whose surface is mounted, and stop ends the session of a tab whose surface mounted. A reopen is recorded each time, because
// each one sends.
func (s *BackgroundSessions) record(tab BackgroundTab, declaration *BackgroundDeclaration, action, surface string) {
	decision := action + ":" + surface
	if action != "reopen" && s.decisions[tab.ID] == decision {
		return
	}
	s.decisions[tab.ID] = decision
	s.ports.Emit("info", "workbench.background.session", map[string]any{"tab": tab.ID, "plugin": tab.Plugin, "sidecar": declaration.Sidecar, "action": action, "surface": surface})
}

func (s *BackgroundSessions) surfaceOf(tab string) string {
	if s.ports.Mounted(tab) {
		return "mounted"
	}
	return "absent"
}

// open sends the declared operation with the current values of the declared settings.
func (s *BackgroundSessions) open(tab BackgroundTab, declaration *BackgroundDeclaration, port BackgroundSidecar, answer func(err error)) {
	values := s.ports.Settings(tab.Plugin)
	fields := map[string]any{}
	for field, setting := range declaration.Settings {
		if value, found := values[setting]; found {
			fields[field] = value
		}
	}
	fields["operation"] = declaration.Operation
	port.Send(tab.ID, fields, answer)
}

// reportText returns the text after the failure in a report: the reason when it is a text.
func reportText(failure string, reason json.RawMessage) string {
	var text string
	if len(reason) > 0 && json.Unmarshal(reason, &text) == nil && string(reason) != "null" {
		return failure + ": " + text
	}
	return failure
}

// present tells whether a member holds a value that is not null, false, zero or an empty text.
func present(value json.RawMessage) bool {
	switch string(value) {
	case "", "null", "false", "0", `""`:
		return false
	}
	return true
}

// errorText returns the text of a reply error.
func errorText(value json.RawMessage) string {
	var text string
	if json.Unmarshal(value, &text) == nil {
		return text
	}
	return string(value)
}

type backgroundReply struct {
	Error  json.RawMessage `json:"error"`
	Reason json.RawMessage `json:"reason"`
}

// listen handles a message of the sidecar for a session.
func (s *BackgroundSessions) listen(session *backgroundSession, tab BackgroundTab, declaration *BackgroundDeclaration, port BackgroundSidecar, body json.RawMessage) {
	if session.stopped {
		return
	}
	var message struct {
		backgroundReply
		Event     string          `json:"event"`
		Connected json.RawMessage `json:"connected"`
		Body      backgroundReply `json:"body"`
	}
	if err := json.Unmarshal(body, &message); err != nil {
		s.ports.Report(fmt.Sprintf("background session %s: %s", tab.ID, err))
		return
	}
	if message.Event == "connection" {
		// When the connection of a persistent sidecar is made again, the session is opened again, because the respawned service does
		// not have it. A failure notification is left as a session error.
		if string(message.Connected) != "true" {
			s.ports.Report(reportText(fmt.Sprintf("background session %s: sidecar connection failed", tab.ID), message.Reason))
			return
		}
		s.record(tab, declaration, "reopen", s.surfaceOf(tab.ID))
		s.open(tab, declaration, port, func(err error) {
			if err != nil {
				s.ports.Report(fmt.Sprintf("background session %s reopen failed: %s", tab.ID, err))
			}
		})
		return
	}
	reply := message.Body
	if present(message.Error) {
		reply = message.backgroundReply
	}
	if present(reply.Error) {
		s.ports.Report(reportText(fmt.Sprintf("background session %s: %s", tab.ID, errorText(reply.Error)), reply.Reason))
	}
}

// start opens the session of tab. The open follows the subscription, because the host delivers its reply only to a registered
// listener (docs/spec/sidecars.md#page-interface).
func (s *BackgroundSessions) start(tab BackgroundTab, declaration *BackgroundDeclaration, port BackgroundSidecar) {
	session := &backgroundSession{}
	s.sessions[tab.ID] = session
	forget := func() {
		if s.sessions[tab.ID] == session {
			delete(s.sessions, tab.ID)
		}
	}
	port.On(tab.ID, func(body json.RawMessage) { s.listen(session, tab, declaration, port, body) }, func(stop func(), err error) {
		if err != nil {
			forget()
			s.ports.Report(fmt.Sprintf("background session %s listener failed: %s", tab.ID, err))
			return
		}
		// A session that stopped before its subscription finished ends the subscription as soon as it exists.
		if session.stopped {
			stop()
			return
		}
		session.stop = stop
		s.open(tab, declaration, port, func(err error) {
			if err != nil {
				forget()
				s.ports.Report(fmt.Sprintf("background session %s open failed: %s", tab.ID, err))
			}
		})
	})
}

// Sync brings the sessions to the current layout. It runs after each change of the layout, and waits for the initial project context,
// because a preview opens no session.
func (s *BackgroundSessions) Sync() error {
	if s.ports.Failed() {
		return nil
	}
	if !s.ports.Ready() {
		if !s.waiting {
			s.waiting = true
			s.ports.Wait(func(err error) {
				s.waiting = false
				// The owner of the start reports the failure, so this subscriber only stops.
				if err != nil {
					return
				}
				if err := s.Sync(); err != nil {
					s.ports.Report(err.Error())
				}
			})
		}
		return nil
	}
	tabs := s.ports.Tabs()
	listed := make(map[string]bool, len(tabs))
	for _, tab := range tabs {
		listed[tab.ID] = true
	}
	for _, tab := range tabs {
		declaration := s.ports.Declaration(tab.Plugin)
		// A tab whose image detach is pending or failed opens no session until its supplier released the previous owner.
		if declaration == nil || s.ports.Held(tab.ID) {
			continue
		}
		surface := s.surfaceOf(tab.ID)
		session := s.sessions[tab.ID]
		// A shown tab and a tab whose surface stays mounted while another tab of its card is shown own their session through the surface,
		// so a background open would be a second owner of it.
		if tab.Active || surface == "mounted" {
			if session != nil {
				session.end()
				delete(s.sessions, tab.ID)
				s.record(tab, declaration, "stop", surface)
			} else if !tab.Active {
				s.record(tab, declaration, "skip", surface)
			}
			continue
		}
		if session != nil {
			continue
		}
		s.record(tab, declaration, "open", surface)
		port := s.ports.Sidecar(declaration.Sidecar)
		if port == nil {
			return fmt.Errorf("background sidecar unavailable: %s", declaration.Sidecar)
		}
		s.start(tab, declaration, port)
	}
	for id, session := range s.sessions {
		if !listed[id] {
			session.end()
			delete(s.sessions, id)
		}
	}
	for id := range s.decisions {
		if !listed[id] {
			delete(s.decisions, id)
		}
	}
	return nil
}

// sidecarPair is a pair of a sidecar and a session id.
type sidecarPair struct{ sidecar, id string }

type sidecarListener struct {
	run func(body json.RawMessage)
}

// HostSidecars is the sidecar ports of a window over the host calls. A host call of a sidecar starts after the previous one finished,
// so the sidecar receives the messages in the order they were sent, and every surface and background session of it shares this order.
type HostSidecars struct {
	calls   *Calls
	report  func(text string)
	listens map[sidecarPair][]*sidecarListener
	// applied holds the waiters for the host registration of a pair while it runs.
	applied map[sidecarPair][]func(err error)
}

// NewHostSidecars returns the ports of the window of calls. report writes a failed send or a failed end of a registration to the log.
func NewHostSidecars(calls *Calls, report func(text string)) *HostSidecars {
	return &HostSidecars{calls: calls, report: report, listens: map[sidecarPair][]*sidecarListener{}, applied: map[sidecarPair][]func(error){}}
}

// Port returns the port of the sidecar name.
func (s *HostSidecars) Port(name string) BackgroundSidecar { return hostSidecar{s, name} }

// Message delivers the event sidecar-message to the listeners of the pair.
func (s *HostSidecars) Message(sidecar, surface string, body json.RawMessage) {
	for _, listener := range s.listens[sidecarPair{sidecar, surface}] {
		listener.run(body)
	}
}

// listen tells the host to send the messages of pair to this window. The calls run one after another, so a removal and a later
// registration of the same pair reach the host in that order.
func (s *HostSidecars) listen(pair sidecarPair, on bool, answer func(err error)) {
	s.calls.CallInOrder("sidecar listen", "sidecarListen", map[string]any{"sidecar": pair.sidecar, "id": pair.id, "on": on},
		func(_ any, err error) { answer(err) })
}

type hostSidecar struct {
	sidecars *HostSidecars
	name     string
}

// On implements BackgroundSidecar. The first listener of a pair registers the window, and the last one removes it.
func (p hostSidecar) On(surface string, listener func(json.RawMessage), answer func(func(), error)) {
	s := p.sidecars
	pair := sidecarPair{p.name, surface}
	entry := &sidecarListener{listener}
	first := len(s.listens[pair]) == 0
	s.listens[pair] = append(s.listens[pair], entry)
	stop := func() {
		listeners := s.listens[pair]
		for index, candidate := range listeners {
			if candidate == entry {
				s.listens[pair] = append(listeners[:index:index], listeners[index+1:]...)
				break
			}
		}
		if len(s.listens[pair]) > 0 {
			return
		}
		delete(s.listens, pair)
		s.listen(pair, false, func(err error) {
			if err != nil {
				s.report(fmt.Sprintf("sidecar %s: listen end failed: %s", p.name, err))
			}
		})
	}
	waiters, applying := s.applied[pair]
	if !first && !applying {
		answer(stop, nil)
		return
	}
	finish := func(err error) {
		if err != nil {
			answer(nil, err)
			return
		}
		answer(stop, nil)
	}
	if applying {
		s.applied[pair] = append(waiters, finish)
		return
	}
	s.applied[pair] = []func(error){finish}
	s.listen(pair, true, func(err error) {
		done := s.applied[pair]
		delete(s.applied, pair)
		for _, waiter := range done {
			waiter(err)
		}
	})
}

// Send implements BackgroundSidecar.
func (p hostSidecar) Send(surface string, body any, answer func(error)) {
	p.sidecars.calls.CallInOrder("sidecar "+p.name, "sidecarSend", map[string]any{"sidecar": p.name, "surface": surface, "body": body, "cids": []string{}}, func(_ any, err error) {
		if err != nil {
			p.sidecars.report(fmt.Sprintf("sidecar %s: send failed: %s", p.name, err))
		}
		answer(err)
	})
}
