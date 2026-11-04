package workbench

// The text scale and the log levels that a view follows (docs/spec/native-surfaces.md#view-calls).

// followScale sends each view that follows its text scale the scale that changed.
func (s *Shell) followScale() {
	for surface, view := range s.surfaces.views {
		if !view.textSize {
			continue
		}
		scale, err := s.surfaceTextSize(surface)
		if err != nil {
			s.fail(err)
			continue
		}
		if scale != view.scale {
			view.scale = scale
			s.pushView(surface, view, "textSize", scale)
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
