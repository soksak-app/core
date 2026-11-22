package workbench

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// viewSource is the source of a view that the host mounted on a surface: its generation and the context that carries the source, which
// ends with the source.
type viewSource struct {
	generation uint64
	ctx        context.Context
	cancel     context.CancelFunc
}

// viewSourceEvent is the value of the events view-source-registered and view-source-ended.
type viewSourceEvent struct {
	Plugin     string `json:"plugin"`
	Surface    string `json:"surface"`
	Generation uint64 `json:"generation"`
}

// viewSourceRegistered records the source of the view that the host mounted on a surface and answers the requests that wait for it.
func (s *Shell) viewSourceRegistered(data []any) {
	event, err := s.viewSourceOf("view source registered", data)
	if err != nil {
		s.fail(err)
		return
	}
	if earlier, ok := s.surfaces.sources[event.Surface]; ok {
		earlier.cancel()
	}
	ctx, cancel := context.WithCancel(host.WithViewSource(s.calls.ctx, event.Surface, event.Generation))
	s.surfaces.sources[event.Surface] = viewSource{generation: event.Generation, ctx: ctx, cancel: cancel}
	s.answerMounts(event.Surface, nil)
}

// viewSourceEnded removes the source of a view that ended. An end of an earlier generation than the recorded one changes nothing.
func (s *Shell) viewSourceEnded(data []any) {
	event, err := s.viewSourceOf("view source ended", data)
	if err != nil {
		s.fail(err)
		return
	}
	if current, ok := s.surfaces.sources[event.Surface]; ok && current.generation == event.Generation {
		current.cancel()
		delete(s.surfaces.sources, event.Surface)
	}
}

func (s *Shell) viewSourceOf(place string, data []any) (viewSourceEvent, error) {
	if len(data) != 1 {
		return viewSourceEvent{}, fmt.Errorf("%s: the event carries %d values, want one", place, len(data))
	}
	event, err := decode[viewSourceEvent](data[0])
	if err != nil {
		return viewSourceEvent{}, fmt.Errorf("%s: %w", place, err)
	}
	if event.Surface == "" || event.Generation == 0 {
		return viewSourceEvent{}, fmt.Errorf("%s: the event names no surface and generation", place)
	}
	return event, nil
}

// mountedView answers with the view source of surface. A held surface whose placement has not finished may still mount a view, so its
// answer waits for the mount or the end of the placement; every other surface answers at once.
func (s *Shell) mountedView(surface string, answer func(MountedView, bool, error)) {
	if source, ok := s.surfaces.sources[surface]; ok {
		answer(MountedView{Generation: source.generation, Context: source.ctx}, true, nil)
		return
	}
	if held := s.surfaces.held[surface]; held != nil && !held.hosted {
		s.surfaces.mounts[surface] = append(s.surfaces.mounts[surface], answer)
		return
	}
	answer(MountedView{}, false, nil)
}

// answerMounts answers the requests that wait for the mount of surface: with err when it is not nil, and else with the current source.
func (s *Shell) answerMounts(surface string, err error) {
	waiting := s.surfaces.mounts[surface]
	delete(s.surfaces.mounts, surface)
	for _, answer := range waiting {
		if err != nil {
			answer(MountedView{}, false, err)
			continue
		}
		s.mountedView(surface, answer)
	}
}

// ownedPorts returns the ports of the owned sessions of the window: the sidecars of the plugins that declare sessions, the layout and the
// status and event writers of the window.
func (s *Shell) ownedPorts() OwnedPorts {
	return OwnedPorts{
		Sidecar: func(plugin string) (string, bool) {
			unit := s.units[plugin]
			if unit == nil || !unit.Sessions {
				return "", false
			}
			if len(unit.Sidecars) != 1 {
				return "", true
			}
			return unit.Sidecars[0], true
		},
		Sidecars: func() []string {
			var names []string
			for _, unit := range s.units {
				if unit.Sessions && len(unit.Sidecars) == 1 {
					names = append(names, unit.Sidecars[0])
				}
			}
			slices.Sort(names)
			return slices.Compact(names)
		},
		Port:    func(name string) OwnedSidecar { return s.tabs.sidecars.OwnedPort(name) },
		Plugin:  s.layoutPluginOf,
		Mounted: s.mountedView,
		Shown:   s.layoutShownSessions,
		Random:  func() string { return issueID(s.options.Random, "os-", func(string) bool { return false }) },
		Emit:    s.emitTabEvent,
		Listen: func(name, surface string, listener func(json.RawMessage), answer func(func(), error)) {
			s.tabs.sidecars.Port(name).On(surface, listener, answer)
		},
		Fail: func(place, text string) {
			s.errors.Show(place, text, "")
			s.options.Invalidate()
		},
		Changed: func() {
			if err := s.registry.Changed(); err != nil {
				s.fail(err)
			}
		},
	}
}

// registerOwnedSessions registers the owned-session commands and the status core.sessions (docs/spec/plugins.md#owned-sessions).
func (s *Shell) registerOwnedSessions() {
	type sessionParam struct {
		Plugin string          `json:"plugin"`
		Params json.RawMessage `json:"params"`
		Size   Size            `json:"size"`
	}
	s.registry.CommandLaterOnSurface("core.session.open", func(raw json.RawMessage, surface string, answer func(any, error)) {
		value, err := params[sessionParam](raw)
		if err != nil {
			answer(nil, fmt.Errorf("core.session.open: %w", err))
			return
		}
		if surface == "" {
			answer(nil, fmt.Errorf("core.session.open needs the surface of its caller"))
			return
		}
		s.owned.Open(surface, value.Plugin, value.Params, value.Size, func(session string, err error) {
			if err != nil {
				answer(nil, err)
				return
			}
			answer(map[string]string{"session": session}, nil)
		})
	})
	type resizeParam struct {
		Session string `json:"session"`
		Size    Size   `json:"size"`
	}
	s.registry.CommandLaterOnSurface("core.session.resize", func(raw json.RawMessage, surface string, answer func(any, error)) {
		value, err := params[resizeParam](raw)
		if err != nil {
			answer(nil, fmt.Errorf("core.session.resize: %w", err))
			return
		}
		s.owned.Resize(surface, value.Session, value.Size, func(err error) { answer(nil, err) })
	})
	type endParam struct {
		Session string `json:"session"`
	}
	s.registry.CommandLaterOnSurface("core.session.end", func(raw json.RawMessage, surface string, answer func(any, error)) {
		value, err := params[endParam](raw)
		if err != nil {
			answer(nil, fmt.Errorf("core.session.end: %w", err))
			return
		}
		s.owned.End(surface, value.Session, func(err error) { answer(nil, err) })
	})
	type textParam struct {
		Session string  `json:"session"`
		Text    *string `json:"text"`
	}
	s.registry.CommandLaterOnSurface("core.session.input", func(raw json.RawMessage, surface string, answer func(any, error)) {
		value, err := params[textParam](raw)
		if err != nil {
			answer(nil, fmt.Errorf("core.session.input: %w", err))
			return
		}
		if surface == "" {
			answer(nil, fmt.Errorf("core.session.input requires the surface of its caller"))
			return
		}
		if value.Text == nil {
			answer(nil, fmt.Errorf("core.session.input text must be a string"))
			return
		}
		s.owned.Input(surface, value.Session, *value.Text, func(err error) {
			if err != nil {
				answer(nil, err)
				return
			}
			answer(map[string]any{}, nil)
		})
	})
	s.registry.CommandLaterOnSurface("core.session.submit", func(raw json.RawMessage, surface string, answer func(any, error)) {
		value, err := params[textParam](raw)
		if err != nil {
			answer(nil, fmt.Errorf("core.session.submit: %w", err))
			return
		}
		if surface == "" {
			answer(nil, fmt.Errorf("core.session.submit requires the surface of its caller"))
			return
		}
		if value.Text == nil {
			answer(nil, fmt.Errorf("core.session.submit text must be a string"))
			return
		}
		s.owned.Submit(surface, value.Session, *value.Text, func(err error) {
			if err != nil {
				answer(nil, err)
				return
			}
			answer(map[string]any{}, nil)
		})
	})
	type readParam struct {
		Session string          `json:"session"`
		From    json.RawMessage `json:"from"`
		Count   json.RawMessage `json:"count"`
	}
	s.registry.CommandLaterOnSurface("core.session.read", func(raw json.RawMessage, surface string, answer func(any, error)) {
		value, err := params[readParam](raw)
		if err != nil {
			answer(nil, fmt.Errorf("core.session.read: %w", err))
			return
		}
		if surface == "" {
			answer(nil, fmt.Errorf("core.session.read requires the surface of its caller"))
			return
		}
		s.owned.Read(surface, value.Session, value.From, value.Count, func(screen json.RawMessage, err error) {
			if err != nil {
				answer(nil, err)
				return
			}
			answer(screen, nil)
		})
	})
	s.registry.Status("core.sessions", func() any { return s.owned.Status() })
}

// layoutOpenWithSession opens the tab of core.layout.open. When its params name a session, the session must be open, and the tab shows it
// (docs/spec/plugins.md#owned-sessions).
func (s *Shell) layoutOpenWithSession(value layoutOpenParam) (map[string]string, error) {
	session, err := sessionOfParams(value.Params)
	if err != nil {
		return nil, err
	}
	if session != "" && !s.owned.IsOpen(session) {
		return nil, fmt.Errorf("session %s is not open", session)
	}
	result, err := s.openLayoutTab(value)
	if err != nil {
		return nil, err
	}
	if session != "" {
		s.owned.Show(result["tab"], session, s.cardSizeOf(result["tab"]), func(err error) {
			if err != nil {
				s.fail(err)
			}
		})
	}
	return result, nil
}

// sessionOfParams returns the session that the params name, or "" when they name none.
func sessionOfParams(raw json.RawMessage) (string, error) {
	if len(raw) == 0 {
		return "", nil
	}
	var named struct {
		Session *string `json:"session"`
	}
	if err := json.Unmarshal(raw, &named); err != nil {
		return "", fmt.Errorf("core.layout.open params: %w", err)
	}
	if named.Session == nil {
		return "", nil
	}
	return *named.Session, nil
}

// adoptSessions adopts the owned sessions of the restored layout and then runs then (docs/spec/persistent-services.md#owned-sessions).
func (s *Shell) adoptSessions(then func()) {
	surfaces, err := s.layoutSurfaces()
	if err != nil {
		s.fail(err)
		then()
		return
	}
	s.owned.Adopt(liveSurfaces(surfaces), func(err error) {
		if err != nil {
			s.fail(err)
		}
		then()
	})
}

// liveSurfaces returns the test of the surfaces that the list holds.
func liveSurfaces(surfaces []retainedSurface) func(string) bool {
	live := map[string]bool{}
	for _, item := range surfaces {
		live[item.Surface] = true
	}
	return func(surface string) bool { return live[surface] }
}

// cardSizeOf returns the size of the card of tab in points at the backing scale of the window, or the zero size when the card has no
// rectangle yet.
func (s *Shell) cardSizeOf(tab string) Size {
	card := s.cardOfTab(tab)
	rect, ok := s.cardRect(card)
	if !ok {
		return Size{}
	}
	window, err := s.windowView()
	if err != nil {
		s.failWindowRead(err)
		return Size{}
	}
	return Size{Width: float64(rect.W), Height: float64(rect.H), Scale: float64(window.Scale)}
}

// sizeChangedCards sends the size of each card whose frame changed since the last layout to the sessions that its tabs show. A frame
// that did not change and a card without a measured frame send nothing (docs/spec/plugins.md#owned-sessions).
func (s *Shell) sizeChangedCards(scale float64) {
	if s.cardFrames == nil {
		s.cardFrames = map[string]layout.Rect{}
	}
	shown := s.owned.ShownTabs()
	for _, id := range s.planes.Cards() {
		rect, ok := s.cardRect(id)
		if !ok {
			continue
		}
		size := Size{Width: float64(rect.W), Height: float64(rect.H), Scale: scale}
		// A card without a measured frame, such as a card that a fullscreen card hides, gives no size: its frame is not recorded, so the
		// next layout that measures the card sends its size.
		if !size.positive() {
			delete(s.cardFrames, id)
			continue
		}
		if last, seen := s.cardFrames[id]; seen && last == rect {
			continue
		}
		s.cardFrames[id] = rect
		for _, tab := range shown {
			if s.cardOfTab(tab) != id {
				continue
			}
			s.owned.CardFrame(tab, size, func(err error) {
				if err != nil {
					s.fail(err)
				}
			})
		}
	}
}

// layoutShownSessions returns the sessions that the tabs of the layouts name in their params, as tab identifier to session identifier.
func (s *Shell) layoutShownSessions() map[string]string {
	shown := map[string]string{}
	for i := range s.projects {
		for _, space := range s.projects[i].Spaces {
			var stored storedLayout
			if err := json.Unmarshal(space.Layout, &stored); err != nil {
				s.fail(fmt.Errorf("space %s: %w", space.ID, err))
				return shown
			}
			cards, err := stored.State.Cards()
			if err != nil {
				s.fail(fmt.Errorf("space %s: %w", space.ID, err))
				return shown
			}
			eachTab(cards, func(tab layout.Tab, _ bool) {
				session, err := sessionOfParams(tab.Rest["params"])
				if err != nil {
					s.fail(fmt.Errorf("tab %s: %w", tab.ID, err))
					return
				}
				if session != "" {
					shown[tab.ID] = session
				}
			})
		}
	}
	return shown
}

// layoutPluginOf returns the plugin of the surface in the layouts of the window, or "".
func (s *Shell) layoutPluginOf(surface string) string {
	surfaces, err := s.layoutSurfaces()
	if err != nil {
		s.fail(err)
		return ""
	}
	for _, item := range surfaces {
		if item.Surface == surface {
			return item.Plugin
		}
	}
	return ""
}
