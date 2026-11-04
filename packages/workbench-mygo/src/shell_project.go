package workbench

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The projects of a window and the binding of the plane to the stored layout of a space, as packages/workbench/projects.js does.

// storedLayout is a stored layout: the state of the plane with the other members as they are stored.
type storedLayout struct {
	State    layout.State    `json:"state"`
	Sidebars json.RawMessage `json:"sidebars"`
}

// newLayout returns the layout of a new space, from the grid of the environment declaration.
func (s *Shell) newLayout() (json.RawMessage, error) {
	cards := make([]map[string]any, 0, len(s.grid.Cards))
	for _, raw := range s.grid.Cards {
		var card map[string]any
		if err := json.Unmarshal(raw, &card); err != nil {
			return nil, err
		}
		tabs, ok := card["tabs"].([]any)
		delete(card, "tabs")
		if ok {
			made := make([]layout.Tab, 0, len(tabs))
			for _, item := range tabs {
				declared := item.(map[string]any)
				plugin, _ := declared["plugin"].(string) // silent: the environment test holds the form of these tabs.
				title, _ := declared["title"].(string)   // silent: as above.
				made = append(made, layout.Tab{ID: s.issueTab(made), Plugin: plugin, Title: title})
			}
			card["data"] = tabData(made, made[0].ID)
		}
		cards = append(cards, card)
	}
	return json.Marshal(map[string]any{"state": map[string]any{"xs": s.grid.Xs, "ys": s.grid.Ys, "cards": cards}})
}

// issueTab returns a new tab id that also differs from the tabs of the card that is being made.
func (s *Shell) issueTab(made []layout.Tab) string {
	for {
		id := s.newTabID()
		repeated := false
		for _, tab := range made {
			repeated = repeated || tab.ID == id
		}
		if !repeated {
			return id
		}
	}
}

// tabData is the data of a card that holds tabs.
func tabData(tabs []layout.Tab, active string) map[string]any {
	return map[string]any{"tabs": tabs, "activeId": active}
}

// openFolder adds the folder as a project and shows it, as projects.open does.
func (s *Shell) openFolder(folder ProjectFolderValue) {
	first, err := s.newLayout()
	if err != nil {
		s.fail(err)
		return
	}
	space := layout.Space{ID: s.newSpaceID(), Title: "SPACE1", Layout: first}
	id := s.newProjectID()
	record := map[string]any{"id": id, "root": folder.Root, "identity": folder.Identity, "title": baseName(folder.Root),
		"color": s.freeTint(), "named": 1, "spaces": []layout.Space{space}, "activeSpaceId": space.ID, "settings": map[string]any{}}
	s.calls.CallInOrder("workspace", "workspace", map[string]any{"kind": "add", "project": record}, func(value any, err error) {
		if err != nil {
			s.fail(err)
			return
		}
		raw, err := json.Marshal(value)
		if err != nil {
			s.fail(err)
			return
		}
		added, err := readProject(raw)
		if err != nil {
			s.fail(err)
			return
		}
		s.projects = append(s.projects, added)
		s.activate(added.ID)
	})
}

// ProjectFolderValue is the answer of projectFolder and projectCreate.
type ProjectFolderValue struct {
	Root     string `json:"root"`
	Identity string `json:"identity"`
}

// freeTint returns the first tint that no project uses, or the first tint when every tint is used.
func (s *Shell) freeTint() string {
	for _, tint := range tints {
		used := false
		for _, project := range s.projects {
			used = used || project.Color == tint
		}
		if !used {
			return tint
		}
	}
	return tints[0]
}

// activate shows the project id in the window, as projects.activate does.
func (s *Shell) activate(id string) {
	project := s.project(id)
	if project == nil {
		s.fail(fmt.Errorf("Unknown project: %s", id))
		return
	}
	s.keep()
	root, identity := project.Root, project.Identity
	s.calls.Call("projectFolder", root, func(value any, err error) {
		if err != nil {
			s.fail(err)
			return
		}
		folder, err := decode[ProjectFolderValue](value)
		if err != nil {
			s.fail(err)
			return
		}
		if folder.Identity != identity {
			s.fail(fmt.Errorf("Project directory has changed: %s", root))
			return
		}
		s.calls.Call("projectOpen", map[string]any{"id": id, "root": root, "separate": false, "geometry": nil}, func(value any, err error) {
			if err != nil {
				s.fail(err)
				return
			}
			opened, err := decode[struct {
				Local bool `json:"local"`
			}](value)
			if err != nil {
				s.fail(err)
				return
			}
			if opened.Local {
				s.show(id)
			}
			s.patch(id, map[string]any{"lastOpened": time.Now().UnixMilli()})
		})
	})
}

// show puts the project id on the screen.
func (s *Shell) show(id string) {
	project := s.project(id)
	if project == nil {
		return
	}
	if err := s.loadSpace(project); err != nil {
		s.fail(err)
		return
	}
	s.active, s.browsing = id, false
	s.errors.Hide(workbenchErrorPlace)
	s.calls.Call("projectShown", map[string]any{"project": map[string]string{"id": id, "root": project.Root, "title": project.Title}},
		func(_ any, err error) {
			if err != nil {
				s.fail(err)
			}
			s.shownProject(err)
		})
	s.tabsSettled()
	s.options.Invalidate()
}

// loadSpace makes the plane of the active space of project.
func (s *Shell) loadSpace(project *projectRecord) error {
	space, err := layout.SpaceIn(&project.Project, project.ActiveSpaceID)
	if err != nil {
		return err
	}
	var stored storedLayout
	if err := json.Unmarshal(space.Layout, &stored); err != nil {
		return fmt.Errorf("space %s: %w", space.ID, err)
	}
	gap := float64(s.palette.Gap)
	width, height := 0.0, 0.0
	if s.plane != nil {
		width, height = s.plane.Width(), s.plane.Height()
	}
	plane, err := layout.New(&stored.State, layout.Options{Gap: &gap, Width: &width, Height: &height})
	if err != nil {
		return fmt.Errorf("space %s: %w", space.ID, err)
	}
	if err := s.sidebars.Restore(stored.Sidebars); err != nil {
		return fmt.Errorf("space %s: %w", space.ID, err)
	}
	s.plane, s.focused = plane, s.firstCard(plane)
	return nil
}

// firstCard returns the card that takes the focus when a space shows: the first card with a tab of the plugin that the environment
// names, or the first card with a tab.
func (s *Shell) firstCard(plane *layout.Grid) string {
	first := ""
	for _, card := range plane.Cards() {
		data, err := layout.DecodeCardData(card.Data)
		if err != nil || data == nil || len(data.TabList()) == 0 {
			continue
		}
		if first == "" {
			first = card.ID
		}
		if data.ActiveTab() != nil && data.ActiveTab().Plugin == s.focus {
			return card.ID
		}
	}
	return first
}

// keep writes the plane into the active space and stores the spaces of the project.
func (s *Shell) keep() { s.keepThen(func() {}) }

// keepThen is keep that runs stored after the write is confirmed.
func (s *Shell) keepThen(stored func()) {
	project := s.opened()
	if project == nil || s.plane == nil {
		return
	}
	if err := s.keepPlane(project); err != nil {
		s.fail(err)
		return
	}
	s.storeSpacesThen(project, stored)
}

func (s *Shell) keepPlane(project *projectRecord) error {
	space, err := layout.SpaceIn(&project.Project, project.ActiveSpaceID)
	if err != nil {
		return err
	}
	var kept map[string]json.RawMessage
	if err := json.Unmarshal(space.Layout, &kept); err != nil {
		return err
	}
	state, err := json.Marshal(s.plane.ToJSON())
	if err != nil {
		return err
	}
	kept["state"] = state
	if kept["sidebars"], err = json.Marshal(s.sidebars.Stored()); err != nil {
		return err
	}
	next, err := json.Marshal(kept)
	if err != nil {
		return err
	}
	for i := range project.Spaces {
		if project.Spaces[i].ID == space.ID {
			project.Spaces[i].Layout = next
		}
	}
	return nil
}

func (s *Shell) storeSpaces(project *projectRecord) {
	s.storeSpacesThen(project, func() {})
}

// storeSpacesThen stores the spaces of project and runs stored after the write is confirmed.
func (s *Shell) storeSpacesThen(project *projectRecord, stored func()) {
	s.patchThen(project.ID, map[string]any{"spaces": project.Spaces, "activeSpaceId": project.ActiveSpaceID, "named": project.Named}, stored)
}

// patch writes members of the stored project id in the order of the changes.
func (s *Shell) patch(id string, members map[string]any) { s.patchThen(id, members, func() {}) }

// patchThen is patch that runs stored after the write is confirmed.
func (s *Shell) patchThen(id string, members map[string]any, stored func()) {
	s.calls.CallInOrder("workspace", "workspace", map[string]any{"kind": "patch", "id": id, "patch": members}, func(_ any, err error) {
		if err != nil {
			s.fail(err)
			return
		}
		stored()
	})
}

// settle stores the plane and asks for a frame after a change of the plane.
func (s *Shell) settle() { s.settleThen(func() {}) }

// settleThen is settle that runs stored after the plane is stored.
func (s *Shell) settleThen(stored func()) {
	s.held = nil
	s.keepThen(stored)
	s.tabsSettled()
	s.options.Invalidate()
}

// browse shows the library, as the project button does.
func (s *Shell) browse() {
	s.keep()
	s.browsing = true
	s.options.Invalidate()
}

// removeProject removes the project id, as projects.close does.
func (s *Shell) removeProject(id string) {
	s.calls.Call("projectRemoveAsk", id, func(value any, err error) {
		if err != nil {
			s.fail(err)
			return
		}
		allowed, err := decode[bool](value)
		if err != nil {
			s.fail(err)
			return
		}
		if !allowed {
			return
		}
		if id != s.active {
			s.keep()
		}
		s.calls.Call("projectRelease", id, func(_ any, err error) {
			if err != nil {
				s.fail(err)
				return
			}
			s.calls.CallInOrder("workspace", "workspace", map[string]any{"kind": "remove", "id": id}, func(_ any, err error) {
				if err != nil {
					s.fail(err)
					return
				}
				s.dropProject(id)
			})
		})
	})
}

// dropProject takes the removed project out of the window. The window shows the next project, or the library without one.
func (s *Shell) dropProject(id string) {
	for i := range s.projects {
		if s.projects[i].ID == id {
			s.projects = append(s.projects[:i:i], s.projects[i+1:]...)
			break
		}
	}
	if s.active == id {
		s.active, s.plane, s.browsing = "", nil, true
		if len(s.projects) > 0 {
			s.activate(s.projects[0].ID)
		}
	}
	s.options.Invalidate()
}

// activateSpace shows the space id of the project on the screen.
func (s *Shell) activateSpace(id string) error {
	project := s.opened()
	if project == nil {
		return fmt.Errorf("no project is shown")
	}
	if _, err := layout.SpaceIn(&project.Project, id); err != nil {
		return err
	}
	if err := s.keepPlane(project); err != nil {
		return err
	}
	project.ActiveSpaceID = id
	if err := s.loadSpace(project); err != nil {
		return err
	}
	s.storeSpaces(project)
	s.options.Invalidate()
	return nil
}

// addSpace adds a space with a new layout and shows it.
func (s *Shell) addSpace() error {
	project := s.opened()
	if project == nil {
		return fmt.Errorf("no project is shown")
	}
	first, err := s.newLayout()
	if err != nil {
		return err
	}
	if err := s.keepPlane(project); err != nil {
		return err
	}
	layout.AppendSpace(&project.Project, s.newSpaceID(), first)
	if err := s.loadSpace(project); err != nil {
		return err
	}
	s.storeSpaces(project)
	s.options.Invalidate()
	return nil
}

// closeSpace closes the space id. The only space of a project does not close.
func (s *Shell) closeSpace(id string) error {
	project := s.opened()
	if project == nil {
		return fmt.Errorf("no project is shown")
	}
	if err := s.keepPlane(project); err != nil {
		return err
	}
	shown := project.ActiveSpaceID
	removed, err := layout.RemoveSpace(&project.Project, id)
	if err != nil || removed == nil {
		return err
	}
	if project.ActiveSpaceID != shown {
		if err := s.loadSpace(project); err != nil {
			return err
		}
	}
	var dropped []string
	var stored storedLayout
	if err := json.Unmarshal(removed.Layout, &stored); err != nil {
		return fmt.Errorf("space %s: %w", id, err)
	}
	eachTab(stored.State.Cards, func(tab layout.Tab, _ bool) { dropped = append(dropped, tab.ID) })
	s.storeSpacesThen(project, s.droppedTabs(dropped))
	s.tabsSettled()
	s.options.Invalidate()
	return nil
}

// planeHasTab reports whether the shown plane holds the tab id.
func (s *Shell) planeHasTab(id string) bool {
	return s.cardOfTab(id) != ""
}

// cardOfTab returns the card of the shown plane that holds the tab id.
func (s *Shell) cardOfTab(id string) string {
	if s.plane == nil {
		return ""
	}
	for _, card := range s.plane.Cards() {
		data, err := layout.DecodeCardData(card.Data)
		if err != nil || data == nil {
			continue
		}
		for _, tab := range data.TabList() {
			if tab.ID == id {
				return card.ID
			}
		}
	}
	return ""
}

// cardData reads the data of the card id.
func (s *Shell) cardData(id string) (*layout.CardData, error) {
	card, ok := s.plane.Card(id)
	if !ok {
		return nil, fmt.Errorf("Unknown card: %s", id)
	}
	data, err := layout.DecodeCardData(card.Data)
	if err != nil {
		return nil, fmt.Errorf("card %s: %w", id, err)
	}
	if data == nil {
		return nil, fmt.Errorf("card %s holds no tabs", id)
	}
	return data, nil
}

func (s *Shell) storeCard(id string, data *layout.CardData) error {
	encoded, err := json.Marshal(data)
	if err != nil {
		return err
	}
	if !s.plane.SetData(id, encoded) {
		return fmt.Errorf("Unknown card: %s", id)
	}
	return nil
}

// newTabOf returns a new tab of the plugin, named by the counter of the project as newTab of plane.js names it.
func (s *Shell) newTabOf(plugin string) layout.Tab {
	return layout.Tab{ID: s.newTabID(), Plugin: plugin, Title: plugin}
}

// paneCard refuses an id that is no card of the plane or that is a window sidebar.
func (s *Shell) paneCard(id string) error {
	if _, ok := s.plane.Card(id); !ok || isPlace(id) {
		return fmt.Errorf("no card %s", id)
	}
	return nil
}

// splitSide tells whether side is a side that a card splits toward.
func splitSide(side string) bool {
	return side == "left" || side == "right" || side == "top" || side == "bottom"
}

// splitCard splits the card id toward side with a new tab of plugin, focuses the new card, and returns the card and its tab. Without
// a plugin the new tab has the plugin of the active tab, as the split tools of the card head ask.
func (s *Shell) splitCard(id, side, plugin string) (map[string]string, error) {
	if err := s.paneCard(id); err != nil {
		return nil, err
	}
	if !splitSide(side) {
		return nil, fmt.Errorf("unknown side %s; use left, right, top or bottom", side)
	}
	data, err := s.cardData(id)
	if err != nil {
		return nil, err
	}
	if plugin == "" {
		active := data.ActiveTab()
		if active == nil {
			return nil, fmt.Errorf("card %s has no active tab to split", id)
		}
		plugin = active.Plugin
	}
	tab := s.newTabOf(plugin)
	encoded, err := json.Marshal(tabData([]layout.Tab{tab}, tab.ID))
	if err != nil {
		return nil, err
	}
	born, ok := s.plane.SplitToward(id, side, layout.SplitInit{Data: encoded})
	if !ok {
		return nil, fmt.Errorf("card %s cannot split toward %s", id, side)
	}
	s.focused = born
	s.settle()
	return map[string]string{"card": born, "tab": tab.ID}, nil
}

// closeCard closes the card id with its tabs.
func (s *Shell) closeCard(id string) error {
	if err := s.paneCard(id); err != nil {
		return err
	}
	var dropped []string
	if data, err := s.cardData(id); err == nil && data != nil {
		for _, tab := range data.TabList() {
			dropped = append(dropped, tab.ID)
		}
	}
	if !s.plane.CanClose(id) {
		return fmt.Errorf("card %s cannot close", id)
	}
	s.plane.Close(id)
	if s.focused == id {
		s.focused = s.firstCard(s.plane)
	}
	s.settleThen(s.droppedTabs(dropped))
	return nil
}

// addTab adds a new tab to the card id and shows it.
func (s *Shell) addTab(id, plugin string) (string, error) { return s.addTabWith(id, plugin, nil) }

// addTabWith is addTab for a tab with the members rest.
func (s *Shell) addTabWith(id, plugin string, rest map[string]json.RawMessage) (string, error) {
	data, err := s.cardData(id)
	if err != nil {
		return "", err
	}
	if plugin == "" {
		active := data.ActiveTab()
		if active == nil {
			return "", fmt.Errorf("card %s has no active tab", id)
		}
		plugin = active.Plugin
	}
	tab := s.newTabOf(plugin)
	tab.Rest = rest
	data.AppendTab(tab)
	if err := s.storeCard(id, data); err != nil {
		return "", err
	}
	s.settle()
	return tab.ID, nil
}

// selectTab shows the tab id in its card.
func (s *Shell) selectTab(id string) error {
	card := s.cardOfTab(id)
	if card == "" {
		return fmt.Errorf("Unknown tab: %s", id)
	}
	data, err := s.cardData(card)
	if err != nil {
		return err
	}
	data.SelectTab(id)
	if err := s.storeCard(card, data); err != nil {
		return err
	}
	s.focused = card
	s.settle()
	return nil
}

// closeTab closes the tab id. The last tab of a card closes the card.
func (s *Shell) closeTab(id string) error {
	card := s.cardOfTab(id)
	if card == "" {
		return fmt.Errorf("Unknown tab: %s", id)
	}
	data, err := s.cardData(card)
	if err != nil {
		return err
	}
	if len(data.TabList()) == 1 {
		return s.closeCard(card)
	}
	data.RemoveTab(id)
	data.SettleActiveTab()
	if err := s.storeCard(card, data); err != nil {
		return err
	}
	s.settleThen(s.droppedTabs([]string{id}))
	return nil
}
