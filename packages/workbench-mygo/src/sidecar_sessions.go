package workbench

import (
	"encoding/json"
	"fmt"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// retainedSurface is one entry of the surfaces that sidecarsRetain keeps.
type retainedSurface struct {
	Surface string `json:"surface"`
	Root    string `json:"root"`
}

// layoutSurfaces returns the tabs of every space of every project with the root of their project, and the section surfaces of the shown
// project. The spaces of a project hold the plane of its shown space, because each change of the plane writes it there before it
// reaches this list.
func (s *Shell) layoutSurfaces() ([]retainedSurface, error) {
	surfaces := []retainedSurface{}
	for i := range s.projects {
		project := &s.projects[i]
		for _, space := range project.Spaces {
			var stored storedLayout
			if err := json.Unmarshal(space.Layout, &stored); err != nil {
				return nil, fmt.Errorf("space %s: %w", space.ID, err)
			}
			eachTab(stored.State.Cards, func(tab layout.Tab, _ bool) {
				surfaces = append(surfaces, retainedSurface{tab.ID, project.Root})
			})
		}
	}
	// The library shows no project, so its sidebars hold no section surface.
	if project := s.opened(); project != nil && s.plane != nil && !s.browsing {
		listed := map[string]bool{}
		for _, id := range s.sidebars.Surfaces(project.ActiveSpaceID, s.focusedSurface()) {
			listed[id] = true
			surfaces = append(surfaces, retainedSurface{id, project.Root})
		}
		// The sections of a card sidebar are known by the surfaces that the window holds.
		for _, id := range s.surfaces.order {
			if held := s.surfaces.held[id]; held != nil && held.section != nil && !listed[id] {
				surfaces = append(surfaces, retainedSurface{id, held.project.Root})
			}
		}
	}
	return surfaces, nil
}

// retainSessions makes the persistent sidecar services close the sessions of surfaces that no layout holds. A layout that does not
// read sends nothing: a partial list would close the sessions of the tabs it leaves out.
func (s *Shell) retainSessions() {
	surfaces, err := s.layoutSurfaces()
	if err != nil {
		s.fail(err)
		return
	}
	s.calls.CallInOrder("sidecar retain", "sidecarsRetain", map[string]any{"surfaces": surfaces}, func(_ any, err error) {
		if err != nil {
			s.fail(err)
		}
	})
}
