package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
)

// registerFixture answers diagnostics.fixture, which the host asks of the window that a check starts from (docs/spec/diagnostics.md).
func (s *Shell) registerFixture() { s.registry.Method("diagnostics.fixture", s.prepareFixture) }

// prepareFixture leaves the window with every project closed, the common settings at the defaults with the values of the request,
// and one project of the root open on a fresh layout.
func (s *Shell) prepareFixture(raw json.RawMessage, answer func(any, error)) {
	value, err := params[struct {
		Root     string         `json:"root"`
		Settings map[string]any `json:"settings"`
	}](raw)
	if err != nil {
		answer(nil, Refuse(InvalidParams, "diagnostics.fixture: %s", err))
		return
	}
	if value.Root == "" {
		answer(nil, errors.New("diagnostics.fixture requires root"))
		return
	}
	s.flushProjects(func() {
		s.closeProjects(func(err error) {
			if err != nil {
				answer(nil, err)
				return
			}
			settings := s.settings.Defaults()
			maps.Copy(settings, value.Settings)
			if err := s.changing(func() error { return s.settings.Set(settings, "common") }); err != nil {
				answer(nil, err)
				return
			}
			s.openRoot(value.Root, projectOpenColor, func(_ json.RawMessage, err error) {
				if err != nil {
					answer(nil, err)
					return
				}
				s.flushProjects(func() { answer(map[string]any{"root": value.Root}, nil) })
			})
		})
	})
}

// flushProjects writes the layout of the shown project, the tab sessions and the tab states, and runs done after the writes.
func (s *Shell) flushProjects(done func()) {
	tabs := func() {
		if s.tabs == nil {
			done()
			return
		}
		s.tabs.sessions.Flush(func() {
			if s.tabs.states == nil {
				done()
				return
			}
			s.tabs.states.Flush(done)
		})
	}
	if s.opened() == nil || s.plane == nil {
		tabs()
		return
	}
	s.keepThen(tabs)
}

// closeProjects removes the projects of the window one after the other.
func (s *Shell) closeProjects(done func(err error)) {
	if len(s.projects) == 0 {
		done(nil)
		return
	}
	id := s.projects[0].ID
	s.removeProjectThen(id, func(removed bool, err error) {
		switch {
		case err != nil:
			done(err)
		case !removed:
			done(fmt.Errorf("a kept tab keeps the project %s", id))
		default:
			s.closeProjects(done)
		}
	})
}
