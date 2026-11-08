package workbench

import (
	"fmt"
	"slices"
	"sort"
)

// The surfaces of a window as the registry sees them: the declarations of its plugins, the order of the surfaces that answer a
// request, and the events of the host that change them (docs/spec/exposure.md#relay).

// linkSurfaces gives the registry the declarations of the plugins and the surfaces of the window. A plugin whose declarations are
// refused is shown, and its names stay unknown.
func (s *Shell) linkSurfaces() {
	ids := make([]string, 0, len(s.units))
	for id := range s.units {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if err := s.registry.Declare(id, s.units[id].Exposes); err != nil {
			s.fail(err)
		}
	}
	s.registry.Link(SurfaceLinks{
		Plugin:    s.surfacePlugin,
		Preferred: s.preferredSurfaces,
		Unloaded: func(surface string) bool {
			return s.tabs != nil && s.tabs.saver != nil && s.tabs.saver.Unloaded(surface)
		},
		Frame: func(surface string) (float64, float64, bool) {
			held := s.surfaces.held[surface]
			// The library covers the plane, so a surface of a project that it covers stands in no place.
			if held == nil || s.inLibrary() {
				return 0, 0, false
			}
			return held.box.X, held.box.Y, true
		},
		BehindDialog: s.dialogOpen,
		Forward: func(request map[string]any, answer func(value any, err error)) {
			s.calls.Call("exposureForward", request, answer)
		},
		Changed: s.requests.surfaceChanged,
		Failed:  s.fail,
	})
}

// surfacePlugin returns the plugin of a surface that the window holds.
func (s *Shell) surfacePlugin(surface string) string {
	if held := s.surfaces.held[surface]; held != nil {
		return held.tab.Plugin
	}
	return ""
}

// preferredSurfaces is the order of the surfaces that receive a request: the tab of the focused card, then the visible surfaces.
func (s *Shell) preferredSurfaces() []string {
	var order []string
	if s.plane != nil {
		if data, err := s.cardData(s.focused); err == nil {
			if tab := data.ActiveTab(); tab != nil {
				order = append(order, tab.ID)
			}
		}
	}
	for _, id := range s.surfaces.order {
		if _, visible := s.surfaces.drawn[id]; visible {
			order = append(order, id)
		}
	}
	return order
}

// surfaceRegistered receives the event exposure-registered.
func (s *Shell) surfaceRegistered(data []any) {
	if len(data) != 1 {
		s.fail(fmt.Errorf("exposure: the event exposure-registered carries %d values, want one", len(data)))
		return
	}
	event, err := decode[SurfaceRegistered](data[0])
	if err != nil {
		s.fail(fmt.Errorf("exposure: %w", err))
		return
	}
	if event.Closed {
		s.closeRegistrations(event.Surface)
	} else if err := s.registry.Registered(event); err != nil {
		s.fail(fmt.Errorf("exposure: %w", err))
	} else if s.events.Traced() {
		// A registration of a surface that the window no longer holds is not applied and is no registration.
		if entries := s.registry.EntriesOf(event.Surface); slices.Contains(entries, declarationKey(event.Kind, event.Name)) {
			s.traceRegistration("registered", event.Surface, entries, map[string]any{"kind": event.Kind, "name": event.Name})
		}
	}
	if event.Closed {
		s.replyHold.Closed(event.Surface)
	}
	s.pushStatuses()
}

// closeRegistrations removes what surface registered, at its close or at the end of the document of its view, whose next document
// registers its own (unregisterSurface of packages/workbench/exposure.js). The close names the entries that the surface held.
func (s *Shell) closeRegistrations(surface string) {
	var held []string
	if s.events.Traced() {
		held = s.registry.EntriesOf(surface)
	}
	if err := s.registry.Registered(SurfaceRegistered{Surface: surface, Closed: true}); err != nil {
		s.fail(fmt.Errorf("exposure: %w", err))
		return
	}
	s.traceRegistration("closed", surface, held, nil)
}

// traceRegistration stores the trace event surface.registration of a registration or a close of a surface that the registry applied,
// as registrationTrace of packages/workbench/exposure.js does: names are the entries that the surface holds at the event, and
// timeOrigin is the start of the workbench in milliseconds. The workbench reaches a surface through the host and holds no port of it,
// so the event has no hasPort (docs/spec/performance-trace.md#producers).
func (s *Shell) traceRegistration(phase, surface string, names []string, fields map[string]any) {
	s.events.Trace("surface.registration", func() map[string]any {
		event := map[string]any{"phase": phase, "surface": surface, "timeOrigin": float64(s.events.StartedAt().UnixMilli()), "names": names}
		for key, value := range fields {
			event[key] = value
		}
		return event
	})
}
