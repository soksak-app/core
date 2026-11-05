package workbench

// The text scale, the settings and the log levels that a view follows (docs/spec/native-surfaces.md#view-calls).

// followScale sends each view that follows its text scale the scale that changed.
func (s *Shell) followScale() {
	for surface, view := range s.surfaces.views {
		if !view.textSize {
			continue
		}
		scale, shown := s.surfaceTextSize(surface)
		if !shown {
			continue
		}
		if scale != view.scale {
			view.scale = scale
			s.pushView(surface, view, "textSize", scale)
		}
	}
}

// followSettings sends each view that follows the settings of its plugin their values after a change of one of them.
func (s *Shell) followSettings() {
	for surface, view := range s.surfaces.views {
		held := s.surfaces.held[surface]
		if !view.settings || held == nil || s.units[held.tab.Plugin] == nil {
			continue
		}
		values := s.viewSettings(s.units[held.tab.Plugin])
		if text := jsonText(values); text != view.settingValues {
			view.settingValues = text
			s.pushView(surface, view, "settings", values)
		}
	}
}

// followLogLevels sends each view that follows the log levels the stored level of each class of the event log-policy.
func (s *Shell) followLogLevels(data []any) {
	policy, err := eventBody[struct {
		Classes map[string]string `json:"classes"`
	}]("log-policy", data)
	if err != nil {
		s.fail(err)
		return
	}
	for surface, view := range s.surfaces.views {
		if view.levels {
			s.pushView(surface, view, "log.levels", policy.Classes)
		}
	}
}
