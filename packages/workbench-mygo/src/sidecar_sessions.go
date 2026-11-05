package workbench

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// retainedSurface is one entry of the surfaces that sidecarsRetain keeps.
type retainedSurface struct {
	Surface string `json:"surface"`
	Root    string `json:"root"`
}

// layoutSurfaces returns what the layouts of every space of every project hold, with the root of their project: the tabs and the section
// surfaces of their sidebars. A session stays recoverable while a layout holds its surface (docs/spec/persistent-services.md), so the list
// follows from the layouts and the declared sets, and not from what the window draws: a window starts in the library, where no sidebar
// is drawn, and the sessions of a service outlive an application that ended. The spaces of a project hold the plane of its shown space,
// because each change of the plane writes it there before it reaches this list.
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
			sections, err := s.spaceSections(space.ID, stored.State.Cards)
			if err != nil {
				return nil, fmt.Errorf("space %s: %w", space.ID, err)
			}
			for _, id := range sections {
				surfaces = append(surfaces, retainedSurface{id, project.Root})
			}
		}
	}
	return surfaces, nil
}

// spaceSections returns the section surfaces of the sidebars of a space: of its fixed sidebars and of the sides of its cards.
func (s *Shell) spaceSections(space string, cards []layout.Card) ([]string, error) {
	sections := s.sidebars.WindowSurfaces(space)
	for _, card := range cards {
		data, err := layout.DecodeCardData(card.Data)
		if err != nil || data == nil {
			continue // A place card has no sides, and the shell refuses a stored card that does not read when it loads the space.
		}
		for _, side := range layout.SidebarSides {
			current, err := layout.EffectiveSidebar(card.ID, data, side, s.sidebarSizes(), s.linkedSide(data, side))
			if err != nil {
				return nil, err
			}
			if current != nil {
				sections = append(sections, s.sidebars.SetSurfaces(space, card.ID+":"+side, current.Set)...)
			}
		}
	}
	return sections, nil
}

// storedSurfaceKept returns whether a stored entry belongs to a surface that a layout holds: a tab of a layout, a section of a fixed
// sidebar of a space, or a section of a card of a space, whose sidebar is `<card>:<side>`.
func (s *Shell) storedSurfaceKept() (func(id string) bool, error) {
	surfaces, err := s.layoutSurfaces()
	if err != nil {
		return nil, err
	}
	tabs := map[string]bool{}
	for _, item := range surfaces {
		tabs[item.Surface] = true
	}
	spaces := map[string]map[string]bool{}
	for i := range s.projects {
		for _, space := range s.projects[i].Spaces {
			var stored storedLayout
			if err := json.Unmarshal(space.Layout, &stored); err != nil {
				return nil, fmt.Errorf("space %s: %w", space.ID, err)
			}
			cards := map[string]bool{}
			for _, card := range stored.State.Cards {
				cards[card.ID] = true
			}
			spaces[space.ID] = cards
		}
	}
	return func(id string) bool {
		if tabs[id] {
			return true
		}
		parts := strings.Split(id, "/")
		cards, known := spaces[parts[0]]
		if !known || len(parts) < 2 {
			return false
		}
		sidebar := parts[1]
		if sidebar == "left" || sidebar == "right" {
			return true
		}
		colon := strings.LastIndex(sidebar, ":")
		return colon > 0 && cards[sidebar[:colon]]
	}, nil
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
