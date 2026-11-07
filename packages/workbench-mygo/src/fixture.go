package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"strings"
)

// fixtureDebugEntries validates the complete diagnostic input before any
// fixture state changes. Missing is reset; an explicit empty array is a list.
func fixtureDebugEntries(raw json.RawMessage) ([]DebugEntry, bool, error) {
	if len(raw) == 0 {
		return nil, false, nil
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil || items == nil {
		return nil, false, errors.New("diagnostics.fixture debugEntries must be an array")
	}
	entries := make([]DebugEntry, 0, len(items))
	paths := make(map[string]bool)
	for _, item := range items {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(item, &fields); err != nil || len(fields) != 3 || fields["path"] == nil || fields["size"] == nil || fields["modified"] == nil || string(fields["size"]) == "null" || string(fields["modified"]) == "null" {
			return nil, false, errors.New("diagnostics.fixture debugEntries requires path, size and modified")
		}
		var entry DebugEntry
		if err := json.Unmarshal(item, &entry); err != nil || !strings.HasPrefix(entry.Path, "logs/") || strings.ContainsAny(entry.Path, "\\:\x00") ||
			entry.Size < 0 || entry.Modified < 0 || entry.Size > 9007199254740991 || entry.Modified > 9007199254740991 || paths[entry.Path] {
			return nil, false, errors.New("diagnostics.fixture debugEntries contains an invalid or duplicate file")
		}
		for _, part := range strings.Split(entry.Path, "/") {
			if part == "" || part == "." || part == ".." {
				return nil, false, errors.New("diagnostics.fixture debugEntries has an invalid path")
			}
		}
		paths[entry.Path] = true
		entries = append(entries, entry)
	}
	return entries, true, nil
}

// registerFixture answers diagnostics.fixture, which the host asks of the window that a check starts from (docs/spec/diagnostics.md).
func (s *Shell) registerFixture() {
	s.registry.Method("diagnostics.fixture", s.prepareFixture)
	s.registerDrag()
	s.registry.Method("diagnostics.layout.fail", func(_ json.RawMessage, answer func(any, error)) {
		s.surfaces.layoutFault = true
		answer(nil, nil)
	})
}

// layoutFaultText is the failure of the placement that diagnostics.layout.fail arms (docs/spec/endpoint.md).
const layoutFaultText = "diagnostic layout fault"

// prepareFixture leaves the window with every project closed, the common settings at the defaults with the values of the request,
// and one project of the root open on a fresh layout.
func (s *Shell) prepareFixture(raw json.RawMessage, answer func(any, error)) {
	value, err := params[struct {
		Root         string          `json:"root"`
		Settings     map[string]any  `json:"settings"`
		DebugEntries json.RawMessage `json:"debugEntries"`
	}](raw)
	if err != nil {
		answer(nil, Refuse(InvalidParams, "diagnostics.fixture: %s", err))
		return
	}
	if value.Root == "" {
		answer(nil, errors.New("diagnostics.fixture requires root"))
		return
	}
	entries, fixtureActive, err := fixtureDebugEntries(value.DebugEntries)
	if err != nil {
		answer(nil, Refuse(InvalidParams, "%s", err))
		return
	}

	s.flushProjects(func(err error) {
		if err != nil {
			answer(nil, err)
			return
		}
		s.closeProjects(func(err error) {
			if err != nil {
				answer(nil, err)
				return
			}
			settings := s.settings.Defaults()
			maps.Copy(settings, value.Settings)
			if err := s.changing("diagnostics.fixture", func() error { return s.settings.Set(settings, "common") }); err != nil {
				answer(nil, err)
				return
			}
			s.openRoot(value.Root, projectOpenColor, func(_ json.RawMessage, err error) {
				if err != nil {
					answer(nil, err)
					return
				}
				s.flushProjects(func(err error) {
					if err != nil {
						answer(nil, err)
						return
					}
					s.closeDebug()
					s.debugFixtureEntries, s.debugFixtureActive = entries, fixtureActive
					answer(map[string]any{"root": value.Root}, nil)
				})
			})
		})
	})
}

// flushProjects writes the layout and the geometry of the shown project, the tab sessions and the tab states, as projects.flush does.
// A reload or an end of the window follows done, so done runs after the host answered these writes and every store before them, with
// the failure of a write that failed.
func (s *Shell) flushProjects(done func(error)) {
	finish := func() {
		// A call in the order of the stores ends after them.
		s.calls.CallInOrder("workspace", "workspace", map[string]string{"kind": "snapshot"}, func(_ any, err error) { done(err) })
	}
	tabs := func() {
		if s.tabs == nil {
			finish()
			return
		}
		s.tabs.sessions.Flush(func() {
			if s.tabs.states == nil {
				finish()
				return
			}
			s.tabs.states.Flush(finish)
		})
	}
	project := s.opened()
	if project == nil || s.plane == nil {
		tabs()
		return
	}
	if err := s.keepPlane(project); err != nil {
		done(err)
		return
	}
	s.calls.CallInOrder("workspace", "workspace", map[string]any{"kind": "patch", "id": project.ID, "patch": spacesPatch(project)}, func(_ any, err error) {
		if err != nil {
			done(err)
			return
		}
		s.saveGeometry(func(err error) {
			if err != nil {
				done(err)
				return
			}
			tabs()
		})
	})
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
