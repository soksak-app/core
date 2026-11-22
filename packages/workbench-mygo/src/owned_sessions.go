package workbench

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
)

// OwnedSidecar is the port of the persistent sidecar of owned sessions.
type OwnedSidecar interface {
	// Request sends body for surface with the correlation identifier cid and answers with the body of its reply.
	Request(surface string, body any, cid string, answer func(body json.RawMessage, err error))
	// RequestMounted sends body for the surface of a mounted view through the view, with its source generation, and answers as Request does.
	RequestMounted(view MountedView, surface string, body any, cid string, answer func(body json.RawMessage, err error))
	// Sessions answers with the owned sessions that the service holds for the client, as a JSON array.
	Sessions(answer func(sessions json.RawMessage, err error))
}

// MountedView is the view that a surface has mounted: its source generation and the context that carries the view source.
type MountedView struct {
	Generation uint64
	Context    context.Context
}

// OwnedPorts is what the owned sessions use. Every port and every answer runs in a step of the main thread.
type OwnedPorts struct {
	// Sidecar returns the name of the persistent sidecar of plugin, and whether the plugin declares sessions. The name is empty when the
	// plugin does not declare exactly one sidecar.
	Sidecar func(plugin string) (string, bool)
	// Sidecars returns the names of the persistent sidecars of the plugins that declare sessions.
	Sidecars func() []string
	// Port returns the port of the sidecar name.
	Port func(name string) OwnedSidecar
	// Plugin returns the plugin of a surface of the layout, or "" when no layout holds the surface.
	Plugin func(surface string) string
	// Mounted returns the view of a surface that a view mounts; a surface without a mounted view is false.
	Mounted func(surface string) (MountedView, bool)
	// Shown returns the sessions that the restored tabs name in their params, as tab identifier to session identifier.
	Shown func() map[string]string
	// Random returns a new identifier for a creation or a correlation identifier.
	Random  func() string
	Emit    func(level, name string, fields map[string]any)
	Changed func()
	// Listen registers listener for each message of surface of the sidecar name, and answers with the function that stops it.
	Listen func(name, surface string, listener func(body json.RawMessage), answer func(stop func(), err error))
	// Fail shows an error of place with its text through the error display of the window.
	Fail func(place, text string)
}

// Size is the size of a session: the width and height of its card in points and the backing scale of the window. The sidecar converts
// it to its own units (docs/spec/persistent-services.md#owned-session-messages).
type Size struct {
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
	Scale  float64 `json:"scale"`
}

// positive tells whether every member of the size is a positive number.
func (z Size) positive() bool { return z.Width > 0 && z.Height > 0 && z.Scale > 0 }

// body returns the size as the members of a request body.
func (z Size) body() map[string]any {
	return map[string]any{"width": z.Width, "height": z.Height, "scale": z.Scale}
}

// OwnedSession is an open owned session: its owner surface, the plugin that opened it, its size and the tab that shows it.
type OwnedSession struct {
	Session, Plugin, Owner string
	Size                   Size
	ShownBy                string
	// Program is the program state reported by the sidecar (idle, working or blocked), or "" while none is reported.
	Program string
}

// OwnedSessions holds the owned sessions of a window (docs/spec/plugins.md#owned-sessions). A session is open from its open reply until
// its end, which the owner, the end of the owner surface or the restart ends (docs/spec/persistent-services.md#owned-sessions).
type OwnedSessions struct {
	ports    OwnedPorts
	sessions map[string]*OwnedSession
	// order lists the open sessions in the order that they opened.
	order []string
	// pending holds the size of each session whose resize request has no reply yet.
	pending map[string]Size
	// listens holds the listener of each owner surface that has an open session, while the window listens to the surface.
	listens map[string]*ownedListen
}

// ownedListen is the listener of an owner surface: its stop function, which is nil until the host answers the registration, and
// whether the owner has no session left, so that the stop runs when the registration is answered.
type ownedListen struct {
	stop    func()
	dropped bool
}

// NewOwnedSessions returns the owned sessions over ports.
func NewOwnedSessions(ports OwnedPorts) *OwnedSessions {
	return &OwnedSessions{ports: ports, sessions: map[string]*OwnedSession{}, pending: map[string]Size{}, listens: map[string]*ownedListen{}}
}

// Open opens a session of plugin that owner owns, with the size and the parameters params. It answers with the session
// identifier that the service allocated (docs/spec/persistent-services.md#owned-session-messages).
func (o *OwnedSessions) Open(owner, plugin string, params json.RawMessage, size Size, answer func(session string, err error)) {
	name, declared := o.ports.Sidecar(plugin)
	if !declared {
		answer("", fmt.Errorf("plugin %s declares no sessions", plugin))
		return
	}
	if name == "" {
		answer("", fmt.Errorf("plugin %s must declare one sidecar for its sessions", plugin))
		return
	}
	if !size.positive() {
		answer("", errors.New("size width, height and scale must be positive numbers"))
		return
	}
	if len(params) == 0 {
		params = json.RawMessage("{}")
	}
	creation := o.ports.Random()
	body := map[string]any{"operation": "open", "session": map[string]any{"creation": creation}, "size": size.body(), "params": params}
	o.request(o.ports.Port(name), owner, body, func(reply json.RawMessage, err error) {
		if err != nil {
			answer("", err)
			return
		}
		var answered struct {
			Session  string `json:"session"`
			Creation string `json:"creation"`
		}
		if err := ownedReplyOf(reply, &answered); err != nil {
			answer("", err)
			return
		}
		if answered.Session == "" || answered.Creation != creation {
			answer("", fmt.Errorf("the open reply of plugin %s names no session of creation %s", plugin, creation))
			return
		}
		o.add(&OwnedSession{Session: answered.Session, Plugin: plugin, Owner: owner, Size: size})
		o.ports.Emit("info", "workbench.session.open", map[string]any{"session": answered.Session, "plugin": plugin, "owner": owner, "size": size.body()})
		o.ports.Changed()
		answer(answered.Session, nil)
	})
}

// CardFrame sizes each session that the tab tab shows to the frame of its card, card being the width and height of the card in points
// and the scale of the window. The request is sent with the tab as the caller, which may resize the session it shows
// (docs/spec/plugins.md#owned-sessions).
func (o *OwnedSessions) CardFrame(tab string, card Size, answer func(error)) {
	if !card.positive() {
		answer(errors.New("size width, height and scale must be positive numbers"))
		return
	}
	var targets []string
	for _, session := range o.order {
		if current := o.sessions[session]; current.ShownBy == tab && current.Size != card && o.pending[session] != card {
			targets = append(targets, session)
		}
	}
	var next func(index int)
	next = func(index int) {
		if index == len(targets) {
			answer(nil)
			return
		}
		o.Resize(tab, targets[index], card, func(err error) {
			if err != nil {
				answer(err)
				return
			}
			next(index + 1)
		})
	}
	next(0)
}

// Resize sets the size of session. While no tab shows the session, only its owner may resize it.
func (o *OwnedSessions) Resize(caller, session string, size Size, answer func(error)) {
	current, err := o.authorized(caller, session, false)
	if err != nil {
		answer(err)
		return
	}
	if !size.positive() {
		answer(errors.New("size width, height and scale must be positive numbers"))
		return
	}
	body := map[string]any{"operation": "resize", "session": session, "size": size.body()}
	o.pending[session] = size
	o.request(o.ports.Port(o.sidecarOf(current.Plugin)), current.Owner, body, func(reply json.RawMessage, err error) {
		delete(o.pending, session)
		if err == nil {
			err = ownedReplyError(reply)
		}
		if err != nil {
			answer(err)
			return
		}
		if latest := o.sessions[session]; latest != nil {
			latest.Size = size
		}
		answer(nil)
	})
}

// Input types text into session as given. Only its owner may call it (docs/spec/plugins.md#owned-sessions).
func (o *OwnedSessions) Input(caller, session, text string, answer func(error)) {
	current, err := o.ownedBy(caller, session)
	if err != nil {
		answer(err)
		return
	}
	o.named(current, map[string]any{"operation": "input", "session": session, "text": text}, answer)
}

// Submit pastes text into session and then sends Enter as a separate input. A text with CR or LF is refused before any request, so
// that Enter is the only line end. Only its owner may call it.
func (o *OwnedSessions) Submit(caller, session, text string, answer func(error)) {
	current, err := o.ownedBy(caller, session)
	if err != nil {
		answer(err)
		return
	}
	if strings.ContainsAny(text, "\r\n") {
		answer(errors.New("core.session.submit text must not contain CR or LF"))
		return
	}
	o.named(current, map[string]any{"operation": "paste", "session": session, "text": text}, func(err error) {
		if err != nil {
			answer(err)
			return
		}
		o.named(current, map[string]any{"operation": "input", "session": session, "text": "\r"}, answer)
	})
}

// Read answers the screen of session as the sidecar replies it, unchanged when the reply states no error. Only its owner may call it.
func (o *OwnedSessions) Read(caller, session string, answer func(json.RawMessage, error)) {
	current, err := o.ownedBy(caller, session)
	if err != nil {
		answer(nil, err)
		return
	}
	o.request(o.ports.Port(o.sidecarOf(current.Plugin)), current.Owner, map[string]any{"operation": "read", "session": session}, func(reply json.RawMessage, err error) {
		if err == nil {
			err = ownedReplyError(reply)
		}
		if err != nil {
			answer(nil, err)
			return
		}
		answer(reply, nil)
	})
}

// ownedBy returns the open session of session when caller is its owner; any other caller is refused before a sidecar request.
func (o *OwnedSessions) ownedBy(caller, session string) (*OwnedSession, error) {
	current := o.sessions[session]
	if current == nil {
		return nil, fmt.Errorf("session %s is not open", session)
	}
	if caller != current.Owner {
		return nil, fmt.Errorf("session %s is owned by %s", session, current.Owner)
	}
	return current, nil
}

// named sends body to the owner of current and answers with its failure. The reply must name the session of current, and a reply that
// states an error fails with that error.
func (o *OwnedSessions) named(current *OwnedSession, body map[string]any, answer func(error)) {
	o.request(o.ports.Port(o.sidecarOf(current.Plugin)), current.Owner, body, func(reply json.RawMessage, err error) {
		var named struct {
			Session string `json:"session"`
		}
		if err == nil {
			err = ownedReplyOf(reply, &named)
		}
		if err == nil && named.Session != current.Session {
			err = fmt.Errorf("the sidecar reply names no session %s", current.Session)
		}
		answer(err)
	})
}

// End ends session. Only its owner may end it.
func (o *OwnedSessions) End(caller, session string, answer func(error)) {
	current, err := o.authorized(caller, session, true)
	if err != nil {
		answer(err)
		return
	}
	body := map[string]any{"operation": "end", "session": session}
	o.request(o.ports.Port(o.sidecarOf(current.Plugin)), current.Owner, body, func(reply json.RawMessage, err error) {
		if err == nil {
			err = ownedReplyError(reply)
		}
		if err != nil {
			answer(err)
			return
		}
		o.finish(session, "ended")
		answer(nil)
	})
}

// Show makes tab show session, which takes the tab that shows it. The tab that showed the session before no longer shows it.
// Show makes tab show session. When the size of the card of tab is known, the session takes it at once; a card whose size is not known
// yet sends no size, and its first frame sends it (docs/spec/plugins.md#owned-sessions).
func (o *OwnedSessions) Show(tab, session string, card Size, answer func(error)) {
	current := o.sessions[session]
	if current == nil {
		answer(fmt.Errorf("session %s is not open", session))
		return
	}
	current.ShownBy = tab
	o.ports.Changed()
	if !card.positive() {
		answer(nil)
		return
	}
	o.CardFrame(tab, card, answer)
}

// ShownTabs returns the tabs that show an open session, each once, in the order of the sessions.
func (o *OwnedSessions) ShownTabs() []string {
	var tabs []string
	for _, session := range o.order {
		if tab := o.sessions[session].ShownBy; tab != "" && !slices.Contains(tabs, tab) {
			tabs = append(tabs, tab)
		}
	}
	return tabs
}

// IsOpen tells whether session is open.
func (o *OwnedSessions) IsOpen(session string) bool {
	return o.sessions[session] != nil
}

// Status returns each open session as {session, plugin, owner, shownBy}, where shownBy is the tab that shows it or nil.
func (o *OwnedSessions) Status() []map[string]any {
	list := []map[string]any{}
	for _, id := range o.order {
		current := o.sessions[id]
		var shown any
		if current.ShownBy != "" {
			shown = current.ShownBy
		}
		var program any
		if current.Program != "" {
			program = map[string]any{"state": current.Program}
		}
		list = append(list, map[string]any{"session": current.Session, "plugin": current.Plugin, "owner": current.Owner, "shownBy": shown, "program": program})
	}
	return list
}

// Retire ends the sessions whose owner surface is not live with the reason owner-closed, and it clears the tab of each session that
// a tab which is not live shows. It runs after the retain that closed the sessions of surfaces no layout holds.
func (o *OwnedSessions) Retire(live func(surface string) bool) {
	for _, id := range append([]string(nil), o.order...) {
		if current := o.sessions[id]; current != nil && !live(current.Owner) {
			o.finish(id, "owner-closed")
		}
	}
	for _, current := range o.sessions {
		if current.ShownBy != "" && !live(current.ShownBy) {
			current.ShownBy = ""
		}
	}
	// A listener stays while its owner surface is live, so that a repeated session.ended of it is refused and logged; a dead owner has none.
	for owner := range o.listens {
		if !live(owner) {
			o.unlisten(owner)
		}
	}
	o.ports.Changed()
}

// Adopt takes the sessions that the persistent services hold after a restart: a session whose owner surface is live is adopted, and each
// other session is ended with the reason owner-absent. It answers when every service answered (docs/spec/persistent-services.md#owned-sessions).
func (o *OwnedSessions) Adopt(live func(surface string) bool, answer func(error)) {
	names := o.ports.Sidecars()
	var next func(index int)
	next = func(index int) {
		if index == len(names) {
			o.showRestored(live)
			answer(nil)
			return
		}
		port := o.ports.Port(names[index])
		port.Sessions(func(list json.RawMessage, err error) {
			if err != nil {
				answer(err)
				return
			}
			var listed []struct {
				Session string `json:"session"`
				Surface string `json:"surface"`
				Size    Size   `json:"size"`
			}
			if err := json.Unmarshal(list, &listed); err != nil {
				answer(fmt.Errorf("sessions of %s: %w", names[index], err))
				return
			}
			o.endAbsent(port, listed, 0, func(err error) {
				if err != nil {
					answer(err)
					return
				}
				next(index + 1)
			}, live)
		})
	}
	next(0)
}

// request sends body for the owner surface with a new correlation identifier. A surface that a view mounts sends through the view with its
// source generation, and any other surface through the window (docs/spec/persistent-services.md#owned-session-messages).
func (o *OwnedSessions) request(port OwnedSidecar, owner string, body any, answer func(json.RawMessage, error)) {
	cid := o.ports.Random()
	if view, ok := o.ports.Mounted(owner); ok {
		port.RequestMounted(view, owner, body, cid, answer)
		return
	}
	port.Request(owner, body, cid, answer)
}

// showRestored makes each restored tab that is live show the open session that its params name (docs/spec/plugins.md#owned-sessions).
// A session that did not survive the restart is not shown.
func (o *OwnedSessions) showRestored(live func(surface string) bool) {
	changed := false
	for tab, session := range o.ports.Shown() {
		current := o.sessions[session]
		if current == nil || !live(tab) {
			continue
		}
		current.ShownBy = tab
		changed = true
	}
	if changed {
		o.ports.Changed()
	}
}

// endAbsent adopts or ends listed[index:] in order and answers when all of them are done.
func (o *OwnedSessions) endAbsent(port OwnedSidecar, listed []struct {
	Session string `json:"session"`
	Surface string `json:"surface"`
	Size    Size   `json:"size"`
}, index int, answer func(error), live func(surface string) bool) {
	if index == len(listed) {
		o.ports.Changed()
		answer(nil)
		return
	}
	item := listed[index]
	if live(item.Surface) {
		o.add(&OwnedSession{Session: item.Session, Plugin: o.ports.Plugin(item.Surface), Owner: item.Surface, Size: item.Size})
		o.endAbsent(port, listed, index+1, answer, live)
		return
	}
	body := map[string]any{"operation": "end", "session": item.Session}
	o.request(port, item.Surface, body, func(reply json.RawMessage, err error) {
		if err == nil {
			err = ownedReplyError(reply)
		}
		if err != nil {
			answer(err)
			return
		}
		o.ports.Emit("info", "workbench.session.end", map[string]any{"session": item.Session, "reason": "owner-absent"})
		o.endAbsent(port, listed, index+1, answer, live)
	})
}

// authorized returns the open session of session when caller may act on it: its owner always may, and another surface only while a tab
// shows the session, unless ownerOnly is set, which allows the owner alone.
func (o *OwnedSessions) authorized(caller, session string, ownerOnly bool) (*OwnedSession, error) {
	current := o.sessions[session]
	if current == nil {
		return nil, fmt.Errorf("session %s is not open", session)
	}
	if caller == current.Owner || (!ownerOnly && current.ShownBy != "") {
		return current, nil
	}
	return nil, fmt.Errorf("surface %s does not own session %s", caller, session)
}

// sidecarOf returns the sidecar name of plugin for a request of an open session.
func (o *OwnedSessions) sidecarOf(plugin string) string {
	// silent: the port returns the empty name for a plugin without exactly one sidecar, and an open session always names its sidecar.
	name, _ := o.ports.Sidecar(plugin)
	return name
}

func (o *OwnedSessions) add(session *OwnedSession) {
	o.sessions[session.Session] = session
	o.order = append(o.order, session.Session)
	o.listen(session.Owner, session.Plugin)
}

// listen registers the window for the messages of owner, when no session of owner was listened to yet, so that the session.ended event
// of the owner reaches SurfaceMessage (docs/spec/persistent-services.md#owned-sessions).
func (o *OwnedSessions) listen(owner, plugin string) {
	if o.listens[owner] != nil {
		return
	}
	// silent: only a plugin that declares sessions gets an owned session, and the port names the sidecar of such a plugin.
	name, _ := o.ports.Sidecar(plugin)
	listen := &ownedListen{}
	o.listens[owner] = listen
	o.ports.Listen(name, owner, func(body json.RawMessage) {
		// A listener of a surface that no session holds any more receives no message.
		if o.listens[owner] == listen {
			o.SurfaceMessage(owner, body)
		}
	}, func(stop func(), err error) {
		if err != nil {
			if o.listens[owner] == listen {
				delete(o.listens, owner)
			}
			o.ports.Fail("core.session.ended", fmt.Sprintf("listen %s: %s", owner, err))
			return
		}
		listen.stop = stop
		if listen.dropped {
			stop()
		}
	})
}

// unlisten removes the listener of owner, which has no open session left. A registration that the host has not answered stops when it is answered.
func (o *OwnedSessions) unlisten(owner string) {
	listen := o.listens[owner]
	if listen == nil {
		return
	}
	delete(o.listens, owner)
	listen.dropped = true
	if listen.stop != nil {
		listen.stop()
	}
}

// SurfaceMessage handles a message of the owner surface. A body whose event is session.ended ends the session it names with reason
// ended; any other body is a reply or an event of the plugin and is not a session end (docs/spec/persistent-services.md#owned-sessions).
func (o *OwnedSessions) SurfaceMessage(owner string, body json.RawMessage) {
	var members map[string]json.RawMessage
	if err := json.Unmarshal(body, &members); err != nil {
		return // A body that is not an object is not a session.ended event.
	}
	var event string
	if err := json.Unmarshal(members["event"], &event); err != nil {
		return
	}
	if event == "session.program" {
		o.program(owner, members)
		return
	}
	if event != "session.ended" {
		return
	}
	var session string
	if err := json.Unmarshal(members["session"], &session); err != nil || session == "" {
		o.ports.Fail("core.session.ended", "invalid session.ended body: session")
		return
	}
	var reason string
	if err := json.Unmarshal(members["reason"], &reason); err != nil || reason != "ended" {
		o.ports.Fail("core.session.ended", "invalid session.ended body: reason")
		return
	}
	entry := o.sessions[session]
	if entry == nil {
		o.ports.Fail("core.session.ended "+session, fmt.Sprintf("session %s is not open", session))
		return
	}
	if entry.Owner != owner {
		o.ports.Fail("core.session.ended "+session, fmt.Sprintf("surface %s does not own session %s", owner, session))
		return
	}
	o.finish(session, "ended")
}

// program sets the program state of the session that the event session.program of owner names. An invalid, unknown or foreign event is
// failed and changes nothing (docs/spec/plugins.md#owned-sessions).
func (o *OwnedSessions) program(owner string, members map[string]json.RawMessage) {
	var session string
	if err := json.Unmarshal(members["session"], &session); err != nil || session == "" {
		o.ports.Fail("core.session.program", "invalid session.program body: session")
		return
	}
	var state string
	if err := json.Unmarshal(members["state"], &state); err != nil || !slices.Contains([]string{"idle", "working", "blocked"}, state) {
		o.ports.Fail("core.session.program", "invalid session.program body: state")
		return
	}
	entry := o.sessions[session]
	if entry == nil {
		o.ports.Fail("core.session.program "+session, fmt.Sprintf("session %s is not open", session))
		return
	}
	if entry.Owner != owner {
		o.ports.Fail("core.session.program "+session, fmt.Sprintf("surface %s does not own session %s", owner, session))
		return
	}
	// A report of the state that the session already has changes nothing and publishes nothing.
	if entry.Program == state {
		return
	}
	entry.Program = state
	o.ports.Emit("info", "workbench.session.program", map[string]any{"session": session, "state": state})
	o.ports.Changed()
}

// finish removes session from the open sessions and records its end with reason.
func (o *OwnedSessions) finish(session, reason string) {
	if o.sessions[session] == nil {
		return
	}
	delete(o.sessions, session)
	for index, id := range o.order {
		if id == session {
			o.order = append(o.order[:index:index], o.order[index+1:]...)
			break
		}
	}
	o.ports.Emit("info", "workbench.session.end", map[string]any{"session": session, "reason": reason})
	o.ports.Changed()
}

// ownedReplyError returns the failure that a reply body states in its member error, or nil.
func ownedReplyError(reply json.RawMessage) error {
	var failed struct {
		Error  json.RawMessage `json:"error"`
		Rule   string          `json:"rule"`
		Reason string          `json:"reason"`
	}
	if err := json.Unmarshal(reply, &failed); err != nil {
		return fmt.Errorf("the reply of a sidecar: %w", err)
	}
	if len(failed.Error) == 0 || string(failed.Error) == "null" {
		return nil
	}
	var text string
	if err := json.Unmarshal(failed.Error, &text); err != nil {
		return errors.New(string(failed.Error))
	}
	// A refusal that states its rule and reason, as the input guard of the sidecar does, keeps them in the text of the failure.
	for _, part := range []string{failed.Rule, failed.Reason} {
		if part != "" {
			text += ": " + part
		}
	}
	return errors.New(text)
}

// ownedReplyOf decodes the reply body into value and returns its failure when the body states one.
func ownedReplyOf(reply json.RawMessage, value any) error {
	if err := ownedReplyError(reply); err != nil {
		return err
	}
	if err := json.Unmarshal(reply, value); err != nil {
		return fmt.Errorf("the reply of a sidecar: %w", err)
	}
	return nil
}

// ownedHostSidecar is the port of a sidecar over the host calls of the window.
type ownedHostSidecar struct {
	sidecars *HostSidecars
	name     string
}

// OwnedPort returns the owned-session port of the sidecar name.
func (s *HostSidecars) OwnedPort(name string) OwnedSidecar { return ownedHostSidecar{s, name} }

// RequestMounted implements OwnedSidecar: it sends body through the mounted view with its source generation.
func (p ownedHostSidecar) RequestMounted(view MountedView, surface string, body any, cid string, answer func(json.RawMessage, error)) {
	p.sidecars.calls.withContext(view.Context).CallInOrder("sidecar "+p.name, "viewSidecarSend", map[string]any{"source": surface, "generation": view.Generation, "sidecar": p.name, "surface": surface, "body": body, "cids": []string{cid}, "answer": true},
		func(result any, err error) {
			if err != nil {
				p.sidecars.report(fmt.Sprintf("sidecar %s: request failed: %s", p.name, err))
				answer(nil, err)
				return
			}
			reply, merr := json.Marshal(result)
			if merr != nil {
				answer(nil, merr)
				return
			}
			answer(reply, nil)
		})
}

// Request implements OwnedSidecar: it sends body with the correlation identifier cid and answers with the body of the reply.
func (p ownedHostSidecar) Request(surface string, body any, cid string, answer func(json.RawMessage, error)) {
	p.sidecars.calls.CallInOrder("sidecar "+p.name, "sidecarSend", map[string]any{"sidecar": p.name, "surface": surface, "body": body, "cids": []string{cid}, "answer": true},
		func(result any, err error) {
			if err != nil {
				p.sidecars.report(fmt.Sprintf("sidecar %s: request failed: %s", p.name, err))
				answer(nil, err)
				return
			}
			reply, merr := json.Marshal(result)
			if merr != nil {
				answer(nil, merr)
				return
			}
			answer(reply, nil)
		})
}

// Sessions implements OwnedSidecar.
func (p ownedHostSidecar) Sessions(answer func(json.RawMessage, error)) {
	p.sidecars.calls.CallInOrder("sidecar "+p.name, "sidecarSessions", map[string]any{"sidecar": p.name}, func(result any, err error) {
		if err != nil {
			answer(nil, err)
			return
		}
		var listed struct {
			Sessions json.RawMessage `json:"sessions"`
		}
		raw, merr := json.Marshal(result)
		if merr == nil {
			merr = json.Unmarshal(raw, &listed)
		}
		if merr != nil {
			answer(nil, merr)
			return
		}
		answer(listed.Sessions, nil)
	})
}
