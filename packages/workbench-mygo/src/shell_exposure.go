package workbench

import (
	"fmt"
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
			if held == nil {
				return 0, 0, false
			}
			return held.box.X, held.box.Y, true
		},
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
	if err := s.registry.Registered(event); err != nil {
		s.fail(fmt.Errorf("exposure: %w", err))
	}
	s.pushStatuses()
}
