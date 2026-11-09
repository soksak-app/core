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
	Plugin  string `json:"plugin"`
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
				surfaces = append(surfaces, retainedSurface{tab.ID, project.Root, tab.Plugin})
			})
			sections, err := s.spaceSections(project, space.ID, stored.State.Cards)
			if err != nil {
				return nil, fmt.Errorf("space %s: %w", space.ID, err)
			}
			for _, id := range sections {
				surfaces = append(surfaces, retainedSurface{id, project.Root, s.sidebars.surfacePlugin(id)})
			}
		}
	}
	return surfaces, nil
}

// spaceSections returns the section surfaces of the sidebars of a space of project, with the sets and the links of that project: of its
// fixed sidebars with every set that a link gives them, and of the sides of its cards with the set that a card chose or the set linked
// to the plugin of each of its tabs.
func (s *Shell) spaceSections(project *projectRecord, space string, cards []layout.Card) ([]string, error) {
	sets, err := decode[[]SidebarSet](s.settings.ProjectValue(project.Settings, "sets"))
	if err != nil {
		return nil, err
	}
	links, err := decode[[]SidebarLink](s.settings.ProjectValue(project.Settings, "links"))
	if err != nil {
		return nil, err
	}
	sections := s.sidebars.windowSurfaces(space, sets, links)
	for _, card := range cards {
		data, err := layout.DecodeCardData(card.Data)
		if err != nil || data == nil {
			continue // A place card has no sides, and the shell refuses a stored card that does not read when it loads the space.
		}
		for _, side := range layout.SidebarSides {
			held := map[string]bool{}
			hold := func(linked *string) error {
				current, err := layout.EffectiveSidebar(card.ID, data, side, s.sidebarSizes(), linked)
				if err != nil {
					return err
				}
				if current != nil && !held[current.Set] {
					held[current.Set] = true
					sections = append(sections, s.sidebars.setSurfaces(space, card.ID+":"+side, current.Set, sets)...)
				}
				return nil
			}
			if err := hold(nil); err != nil {
				return nil, err
			}
			for _, tab := range data.TabList() {
				if err := hold(linkedCardOf(links, side, tab.Plugin)); err != nil {
					return nil, err
				}
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
		if layout.IsWindowEdge(sidebar) {
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
