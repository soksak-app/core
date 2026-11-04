package workbench

import (
	"encoding/json"
	"fmt"
	"slices"
	"sort"
)

// The surfaces of a window as the registry sees them: the declarations of its plugins, the order of the surfaces that answer a
// request, and the events of the host that change them (docs/spec/exposure.md#relay).

// declaredExposes returns the declarations of the plugin: those of plugin.json, with the diagnostic declaration of a diagnostic
// build (docs/spec/plugins.md#diagnostic-declarations).
func (u *installedUnit) declaredExposes() (Exposes, error) {
	exposes := u.Exposes
	if len(u.Diagnostics) == 0 || string(u.Diagnostics) == "null" {
		return exposes, nil
	}
	var diagnostics struct {
		Exposes Exposes `json:"exposes"`
	}
	if err := json.Unmarshal(u.Diagnostics, &diagnostics); err != nil {
		return exposes, fmt.Errorf("plugin %s diagnostics: %w", u.ID, err)
	}
	exposes.Status = slices.Concat(exposes.Status, diagnostics.Exposes.Status)
	exposes.Commands = slices.Concat(exposes.Commands, diagnostics.Exposes.Commands)
	exposes.Dom = slices.Concat(exposes.Dom, diagnostics.Exposes.Dom)
	return exposes, nil
}

// linkSurfaces gives the registry the declarations of the plugins and the surfaces of the window. A plugin whose declarations are
// refused is shown, and its names stay unknown.
func (s *Shell) linkSurfaces() {
	ids := make([]string, 0, len(s.plugins))
	for id := range s.plugins {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		exposes, err := s.plugins[id].declaredExposes()
		if err == nil {
			err = s.registry.Declare(id, exposes)
		}
		if err != nil {
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
			if held == nil {
				return 0, 0, false
			}
			return held.box.X, held.box.Y, true
		},
		Forward: func(request map[string]any, answer func(value any, err error)) {
			s.calls.Call("exposureForward", request, answer)
		},
		Changed: s.requests.surfaceChanged,
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
	if err := s.registry.Registered(event); err != nil {
		s.fail(fmt.Errorf("exposure: %w", err))
	}
}
