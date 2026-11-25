package workbench

import (
	"encoding/json"
	"fmt"
	"slices"
	"sort"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
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
		BehindDialog: s.surfaceBehindDialog,
		Forward: func(request map[string]any, answer func(value any, err error)) {
			s.calls.Call("exposureForward", request, answer)
		},
		Changed: s.requests.surfaceChanged,
		Failed:  s.fail,
	})
	s.registry.SnapshotPartsOf(s.snapshotParts)
}

// snapshotParts are the layout of the shown space, the loaded plugins and the surfaces of the window for a window snapshot
// (docs/spec/exposure.md#window-snapshot), as snapshotParts of packages/workbench/core-exposure.js gives them.
func (s *Shell) snapshotParts() (SnapshotParts, error) {
	description, err := s.LayoutDescription()
	if err != nil {
		return SnapshotParts{}, err
	}
	parts := SnapshotParts{Plugins: []PluginDescription{}, Surfaces: []SnapshotSurface{}}
	if description != nil {
		parts.Layout = description
	}
	for _, plugin := range s.plugins {
		described := PluginDescription{Plugin: plugin.ID, Name: plugin.Name, Description: plugin.Description}
		if plugin.Surface {
			// default: a plugin without surface.opens opens no file, which the snapshot lists as no extension.
			opens := []string{}
			if unit := s.units[plugin.ID]; unit != nil && unit.Opens != nil {
				opens = unit.Opens
			}
			described.Surface = &PluginSurface{Params: plugin.Params, Opens: opens}
		}
		parts.Plugins = append(parts.Plugins, described)
	}
	rows, err := s.surfacesState()
	if err != nil {
		return SnapshotParts{}, err
	}
	for _, row := range rows {
		var surface SnapshotSurface
		switch entry := row.(type) {
		case surfaceStatus:
			surface = SnapshotSurface{Surface: entry.Surface, Plugin: entry.Plugin, Kind: entry.Kind, Visible: entry.Visible}
		case placeholderStatus:
			surface = SnapshotSurface{Surface: entry.Surface, Plugin: entry.Plugin, Kind: entry.Kind, Visible: entry.Visible}
		default:
			return SnapshotParts{}, fmt.Errorf("core.surfaces holds the row %T", row)
		}
		surface.State = "loaded"
		if s.tabs != nil && s.tabs.saver != nil && s.tabs.saver.Unloaded(surface.Surface) {
			surface.State = "unloaded"
		}
		parts.Surfaces = append(parts.Surfaces, surface)
	}
	return parts, nil
}

// surfacePlugin returns the plugin of a surface that the window holds.
// dependsOn tells whether the plugin lists the loaded plugin owner in its dependencies, which lets a view of the plugin follow the
// statuses that owner declares (docs/spec/plugins.md#pluginjson).
func (s *Shell) dependsOn(plugin, owner string) bool {
	unit := s.units[plugin]
	return unit != nil && slices.Contains(unit.Plugins, owner)
}

func (s *Shell) surfacePlugin(surface string) string {
	if held := s.surfaces.held[surface]; held != nil {
		return held.tab.Plugin
	}
	return ""
}

// surfaceSpace answers surface.window of the window (docs/spec/exposure.md#methods): {space} of the space whose layout holds the tab
// surface among the spaces of the projects that the window opened, with the plane in the place of the shown space, {space: null} for a
// section surface that a sidebar of the window seats, or null, as the page answers it (surface.window of packages/workbench/
// core-exposure.js). The host asks each ready window and answers {window, space}.
func (s *Shell) surfaceSpace(raw json.RawMessage, answer func(any, error)) {
	var params struct {
		Surface *string `json:"surface"`
	}
	if json.Unmarshal(raw, &params) != nil || params.Surface == nil || *params.Surface == "" {
		answer(nil, Refuse(InvalidParams, "surface must be a non-empty string"))
		return
	}
	var held *string
	err := s.eachLayoutTab(func(_, space string, tab layout.Tab, _ bool) {
		if held == nil && tab.ID == *params.Surface {
			held = &space
		}
	})
	switch {
	case err != nil:
		answer(nil, err)
	case held == nil:
		// A section surface belongs to a sidebar of the window and to no layout of a space, so a seated section answers the space null.
		if _, seated := s.surfaces.seated[*params.Surface]; seated {
			answer(map[string]any{"space": nil}, nil)
			return
		}
		answer(nil, nil)
	default:
		answer(map[string]string{"space": *held}, nil)
	}
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

// surfaceReleased receives the event diagnostics-surface-released: the endpoint connection that asked for the reply hold of the
// surface closed, so the hold ends (docs/spec/endpoint.md).
func (s *Shell) surfaceReleased(data []any) {
	if len(data) != 1 {
		s.fail(fmt.Errorf("diagnostics: the event diagnostics-surface-released carries %d values, want one", len(data)))
		return
	}
	event, err := decode[struct {
		Surface string `json:"surface"`
	}](data[0])
	if err != nil {
		s.fail(fmt.Errorf("diagnostics: %w", err))
		return
	}
	s.replyHold.Released(event.Surface)
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
