package workbench

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The projects of a window and the binding of the plane to the stored layout of a space, as packages/workbench/projects.js does.

// storedLayout is a stored layout: the state of the plane with the other members as they are stored.
type storedLayout struct {
	State          layout.State    `json:"state"`
	Named          int             `json:"named"`
	FocusedID      string          `json:"focusedId"`
	WindowSidebars json.RawMessage `json:"windowSidebars"`
	Sidebars       json.RawMessage `json:"sidebars"`
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
	return json.Marshal(map[string]any{"state": map[string]any{"xs": s.grid.Xs, "ys": s.grid.Ys, "cards": cards}, "named": 0})
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

// openFolder adds the folder as a project of the color and shows it, as projects.open does. done takes the stored project, or the
// failure, after the project is shown.
func (s *Shell) openFolder(folder ProjectFolderValue, color string, done func(project json.RawMessage, err error)) {
	first, err := s.newLayout()
	if err != nil {
		done(nil, err)
		return
	}
	space := layout.Space{ID: s.newSpaceID(), Title: "SPACE1", Layout: first}
	id := s.newProjectID()
	record := map[string]any{"id": id, "root": folder.Root, "identity": folder.Identity, "title": baseName(folder.Root),
		"color": color, "named": 1, "spaces": []layout.Space{space}, "activeSpaceId": space.ID, "settings": map[string]any{}}
	s.calls.CallInOrder("workspace", "workspace", map[string]any{"kind": "add", "project": record}, func(value any, err error) {
		if err != nil {
			done(nil, err)
			return
		}
		raw, err := json.Marshal(value)
		if err != nil {
			done(nil, err)
			return
		}
		added, err := readProject(raw)
		if err != nil {
			done(nil, err)
			return
		}
		s.adoptAdded(added.ID, func(err error) {
			if err != nil {
				done(nil, err)
				return
			}
			s.activateThen(added.ID, func() { done(raw, nil) })
		})
	})
}

// adoptAdded takes the project id that the workspace just added or already knew, as readProjects does after an add: the record of
// the workspace holds the settings of the file of its folder, which the answer of the add does not. A project that the window holds
// keeps its layouts and takes the settings.
func (s *Shell) adoptAdded(id string, done func(err error)) {
	s.calls.CallInOrder("workspace", "workspace", map[string]string{"kind": "snapshot"}, func(value any, err error) {
		if err != nil {
			done(err)
			return
		}
		snapshot, err := decode[struct {
			Projects []json.RawMessage `json:"projects"`
		}](value)
		if err != nil {
			done(err)
			return
		}
		for _, raw := range snapshot.Projects {
			stored, err := readProject(raw)
			if err != nil {
				done(err)
				return
			}
			if stored.ID != id {
				continue
			}
			if known := s.project(id); known != nil {
				delete(known.Rest, "settings")
				if settings, ok := stored.Rest["settings"]; ok {
					known.Rest["settings"] = settings
				}
				done(nil)
				return
			}
			s.projects = append(s.projects, stored)
			done(nil)
			return
		}
		done(fmt.Errorf("Unknown project: %s", id))
	})
}

// projectOpenColor is the color of a project that core.project.open opens without one.
const projectOpenColor = "#ffb36b"

// registerProjectOpen registers core.project.open, which opens a folder for an endpoint client as the library form does for a person.
func (s *Shell) registerProjectOpen() {
	s.registry.CommandLater("core.project.open", func(raw json.RawMessage, answer func(any, error)) {
		value, err := params[struct {
			Root  string `json:"root"`
			Color string `json:"color"`
		}](raw)
		switch {
		case err != nil:
			answer(nil, Refuse(InvalidParams, "core.project.open: %s", err))
			return
		case strings.TrimSpace(value.Root) == "":
			answer(nil, errors.New("Project directory is empty"))
			return
		}
		color := value.Color
		if color == "" {
			color = projectOpenColor
		}
		s.openRoot(value.Root, color, func(project json.RawMessage, err error) {
			if err != nil {
				answer(nil, err)
				return
			}
			answer(project, nil)
		})
	})
}

// openRoot opens the folder of root as a project on a fresh layout.
func (s *Shell) openRoot(root, color string, done func(project json.RawMessage, err error)) {
	s.calls.Call("projectFolder", root, func(reply any, err error) {
		if err != nil {
			done(nil, err)
			return
		}
		folder, err := decode[ProjectFolderValue](reply)
		if err != nil {
			done(nil, err)
			return
		}
		s.openFolder(folder, color, done)
	})
}

// registerProjectClose registers core.project.close. The window that shows the project asks about its modified tabs, and the
// command answers when the host removed the project or when a tab or another window kept it.
func (s *Shell) registerProjectClose() {
	s.registry.CommandLater("core.project.close", func(raw json.RawMessage, answer func(any, error)) {
		value, err := params[idParam](raw)
		if err != nil {
			answer(nil, Refuse(InvalidParams, "core.project.close: %s", err))
			return
		}
		if s.project(value.ID) == nil {
			answer(nil, fmt.Errorf("Unknown project: %s", value.ID))
			return
		}
		remove := func() {
			s.removeProjectThen(value.ID, func(removed bool, err error) {
				if err != nil {
					answer(nil, err)
					return
				}
				answer(closed(removed), nil)
			})
		}
		if value.ID != s.active {
			remove()
			return
		}
		s.settleModified(func(settled bool) {
			if !settled {
				answer(closed(false), nil)
				return
			}
			remove()
		})
	})
}

// newWindow opens a new unassigned window, as projects.newWindow does, and gives done the outcome of the host call.
func (s *Shell) newWindow(done func(err error)) {
	cids := s.events.BeginOperation("workbench.window.operation", map[string]any{"action": "new"})
	s.calls.Caused(cids).Call("windowNew", nil, func(_ any, err error) { done(err) })
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
func (s *Shell) activate(id string) { s.activateThen(id, func() {}) }

// activateThen is activate that runs done after the project is shown or after it failed.
func (s *Shell) activateThen(id string, done func()) {
	project := s.project(id)
	if project == nil {
		s.fail(fmt.Errorf("Unknown project: %s", id))
		done()
		return
	}
	var refused string
	if err := member(project.Rest, "settingsError", &refused); err != nil {
		s.fail(err)
		done()
		return
	}
	// The host refused the settings file of the project, so the window does not open it (docs/spec/projects.md#settings).
	if refused != "" {
		s.fail(errors.New(refused))
		done()
		return
	}
	s.keep()
	root, identity := project.Root, project.Identity
	s.calls.Call("projectFolder", root, func(value any, err error) {
		if err != nil {
			s.fail(err)
			done()
			return
		}
		folder, err := decode[ProjectFolderValue](value)
		if err != nil {
			s.fail(err)
			done()
			return
		}
		if folder.Identity != identity {
			s.fail(fmt.Errorf("Project directory has changed: %s", root))
			done()
			return
		}
		cids := s.events.BeginOperation("workbench.project.operation", map[string]any{"action": "open", "project": id})
		s.calls.Caused(cids).Call("projectOpen", map[string]any{"id": id, "root": root, "separate": s.settings.Value("projectOpening") == "windows", "geometry": nil}, func(value any, err error) {
			if err != nil {
				s.fail(err)
				done()
				return
			}
			opened, err := decode[struct {
				Local bool `json:"local"`
			}](value)
			if err != nil {
				s.fail(err)
				done()
				return
			}
			now := time.Now().UnixMilli()
			if project := s.project(id); project != nil {
				project.LastOpened = float64(now)
			}
			s.patch(id, map[string]any{"lastOpened": now})
			if opened.Local {
				s.showThen(id, done)
				return
			}
			// Another window holds the project, so this window leaves the library for the project that it shows.
			s.showThen(s.active, done)
		})
	})
}

// show puts the project id on the screen.
func (s *Shell) show(id string) { s.showThen(id, func() {}) }

// showThen is show that runs done after the host took the project, or after it failed.
func (s *Shell) showThen(id string, done func()) {
	project := s.project(id)
	if project == nil {
		done()
		return
	}
	if err := s.loadSpace(project); err != nil {
		s.fail(err)
		done()
		return
	}
	s.active, s.browsing = id, false
	s.windowProjects[id] = true
	s.options.Located(id)
	s.errors.Hide(workbenchErrorPlace)
	if err := s.beginSettings(s.settings.Common()); err != nil {
		s.fail(err)
	}
	s.calls.Call("projectShown", map[string]any{"project": map[string]string{"id": id, "root": project.Root, "title": project.Title}},
		func(_ any, err error) {
			if err != nil {
				s.fail(err)
			}
			s.shownProject(err)
			done()
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
	if space.ID != s.planeSpace {
		s.leavePlace()
	}
	s.planeSpace = space.ID
	s.tabsNamed = stored.Named
	gap := float64(2 * s.palette.Gap) // The gap of a theme is the half width of the passage between two cards.
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
	s.windowSidebars = map[string]layout.WindowSidebar{}
	if len(stored.WindowSidebars) > 0 {
		if s.windowSidebars, err = layout.RestoreWindowSidebars(stored.WindowSidebars); err != nil {
			return fmt.Errorf("space %s: %w", space.ID, err)
		}
	}
	s.plane, s.fullscreen = plane, ""
	// A new space stores no focus, and the stored focus of a card that left the layout names no card.
	focused := stored.FocusedID
	if _, known := plane.Card(focused); !known {
		focused = s.firstCard(plane)
	}
	s.focusCard(focused)
	if _, err := s.arrangeWindowSidebars(); err != nil {
		return fmt.Errorf("space %s: %w", space.ID, err)
	}
	s.operated = map[string]map[string]layout.Side{}
	s.columnsChanged = true
	// The views of this space take the scale that changed while it was off the screen.
	s.followScale()
	return nil
}

// arrangeWindowSidebars matches the fixed sidebars of the plane to the settings left and right, and tells whether the plane changed.
// A plane without its size has no room for a column, and its first frame arranges it.
func (s *Shell) arrangeWindowSidebars() (bool, error) {
	if s.plane == nil || s.plane.Width() == 0 {
		return false, nil
	}
	shown := func(side string) bool {
		on, _ := s.settings.Value(side).(bool)
		return on
	}
	width, _ := s.settings.Value("sidebarWidth").(float64)
	changed, err := layout.ArrangeWindowSidebars(s.plane, s.sidebars.Sides(), s.windowSidebars, width, shown)
	if _, ok := s.plane.Card(s.focused); !ok {
		s.focusCard(s.firstCard(s.plane))
	}
	return changed, err
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
	if kept["named"], err = json.Marshal(s.tabsNamed); err != nil {
		return err
	}
	if kept["focusedId"], err = json.Marshal(s.focused); err != nil {
		return err
	}
	if kept["sidebars"], err = json.Marshal(s.sidebars.Stored()); err != nil {
		return err
	}
	layout.KeepWindowSidebarWidths(s.plane, s.windowSidebars)
	if kept["windowSidebars"], err = json.Marshal(s.windowSidebars); err != nil {
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
	s.closePicker()
	if _, err := s.arrangeWindowSidebars(); err != nil {
		s.fail(err)
	}
	s.held = nil
	if s.plane != nil {
		s.text.KeepPressedCard(func(card string) bool {
			_, ok := s.plane.Card(card)
			return ok
		})
	}
	s.keepThen(stored)
	s.tabsSettled()
	s.options.Invalidate()
}

// leavePlace ends the press on a card of the plane leaving the screen: another space has cards of the same ids, which were not
// pressed (docs/spec/text-size.md#scope).
func (s *Shell) leavePlace() {
	s.text.KeepPressedCard(func(string) bool { return false })
}

// browse shows the library, as the project button does.
func (s *Shell) browse() {
	s.keep()
	s.leavePlace()
	s.browsing = true
	s.options.Invalidate()
}

// removeProject removes the project id, as projects.close does.
func (s *Shell) removeProject(id string) {
	s.removeProjectThen(id, func(_ bool, err error) {
		if err != nil {
			s.fail(err)
		}
	})
}

// removeProjectThen is removeProject that tells whether the project was removed: a kept tab of the project keeps it.
func (s *Shell) removeProjectThen(id string, done func(removed bool, err error)) {
	operation := s.calls.Caused(s.events.BeginOperation("workbench.project.operation", map[string]any{"action": "remove", "project": id}))
	operation.Call("projectRemoveAsk", id, func(value any, err error) {
		if err != nil {
			done(false, err)
			return
		}
		allowed, err := decode[bool](value)
		if err != nil {
			done(false, err)
			return
		}
		if !allowed {
			done(false, nil)
			return
		}
		if id != s.active {
			s.keep()
		}
		operation.Call("projectRelease", id, func(_ any, err error) {
			if err != nil {
				done(false, err)
				return
			}
			s.calls.CallInOrder("workspace", "workspace", map[string]any{"kind": "remove", "id": id}, func(_ any, err error) {
				if err != nil {
					done(false, err)
					return
				}
				s.dropProject(id)
				done(true, nil)
			})
		})
	})
}

// dropProject takes the removed project out of the window. The window shows the next project, or the library without one.
func (s *Shell) dropProject(id string) {
	var tabs []string
	for tab, held := range s.surfaces.held {
		if held.owner == id {
			tabs = append(tabs, tab)
		}
	}
	s.forgetSurfaces(tabs)
	delete(s.windowProjects, id)
	for i := range s.projects {
		if s.projects[i].ID == id {
			s.projects = append(s.projects[:i:i], s.projects[i+1:]...)
			break
		}
	}
	if s.active == id {
		s.leavePlace()
		s.active, s.plane, s.browsing, s.fullscreen = "", nil, true, ""
		s.options.Located("")
		for _, project := range s.projects {
			if s.windowProjects[project.ID] {
				s.activate(project.ID)
				break
			}
		}
	}
	s.retainSessions()
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
	s.tabsSettled()
	s.options.Invalidate()
	return nil
}

// addSpace adds a space with a new layout and shows it.
func (s *Shell) addSpace() (layout.Space, error) {
	project := s.opened()
	if project == nil {
		return layout.Space{}, fmt.Errorf("no project is shown")
	}
	first, err := s.newLayout()
	if err != nil {
		return layout.Space{}, err
	}
	if err := s.keepPlane(project); err != nil {
		return layout.Space{}, err
	}
	space := layout.AppendSpace(&project.Project, s.newSpaceID(), first)
	if err := s.loadSpace(project); err != nil {
		return layout.Space{}, err
	}
	s.storeSpaces(project)
	s.tabsSettled()
	s.options.Invalidate()
	return space, nil
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
	for surface, held := range s.surfaces.held {
		if held.section != nil && strings.HasPrefix(surface, id+"/") {
			dropped = append(dropped, surface)
		}
	}
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

// cardRead is the data of a card, kept while the text of the card stays the same.
type cardRead struct {
	text json.RawMessage
	data *layout.CardData
	err  error
}

// readCard returns the data of card for reading. The reads of a text share the data, so that a frame does not decode the cards
// again: a change takes its own copy from DecodeCardData.
func (s *Shell) readCard(card layout.Card) (*layout.CardData, error) {
	read, ok := s.cardReads[card.ID]
	if !ok || !bytes.Equal(read.text, card.Data) {
		data, err := layout.DecodeCardData(card.Data)
		read = cardRead{text: card.Data, data: data, err: err}
		s.cardReads[card.ID] = read
	}
	return read.data, read.err
}

// forgetCardReads lets the reads of the cards that left the layout go.
func (s *Shell) forgetCardReads(cards []layout.Card) {
	if len(s.cardReads) > len(cards) {
		maps.DeleteFunc(s.cardReads, func(id string, _ cardRead) bool {
			return !slices.ContainsFunc(cards, func(card layout.Card) bool { return card.ID == id })
		})
	}
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

// newTabOf returns a new tab of the known plugin, named by its mark and the counter of the project as newTab of plane.js names it. from
// is the source tab, whose reported directory the new tab keeps as its origin, or nil (docs/spec/projects.md#tab-origin).
func (s *Shell) newTabOf(plugin *LoadedPlugin, from *layout.Tab) (layout.Tab, error) {
	var directory *string
	if from != nil {
		if report := s.surfaces.reports[from.ID]; report != nil {
			directory = optionalText(report.Directory)
		}
	}
	origin, err := json.Marshal(map[string]*string{"directory": directory})
	if err != nil {
		return layout.Tab{}, err
	}
	s.tabsNamed++
	return layout.Tab{ID: s.newTabID(), Plugin: plugin.ID, Title: fmt.Sprintf("%s 탭 %d", plugin.Mark, s.tabsNamed),
		Rest: map[string]json.RawMessage{"origin": origin}}, nil
}

// knownPlugin returns the loaded plugin with a surface, or the refusal of the page.
func (s *Shell) knownPlugin(id string) (*LoadedPlugin, error) {
	if id == "" {
		id = "undefined"
	}
	if plugin := s.loadedPlugin(id); plugin != nil && plugin.Surface {
		return plugin, nil
	}
	return nil, fmt.Errorf("unknown plugin %s", id)
}

// paneCard refuses an id that is no card of the plane or that is a window sidebar.
func (s *Shell) paneCard(id string) error {
	if _, ok := s.plane.Card(id); !ok || isPlace(id) {
		return fmt.Errorf("no card %s", id)
	}
	return nil
}

// layoutChangeable refuses a change of the layout while a card covers the plane (docs/spec/example-model.md#card-fullscreen).
func (s *Shell) layoutChangeable(id string) error {
	if s.fullscreen != "" {
		return fmt.Errorf("card %s: the layout does not change while card %s is fullscreen; restore the arrangement first", id, s.fullscreen)
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
	if err := s.layoutChangeable(id); err != nil {
		return nil, err
	}
	known, err := s.knownPlugin(plugin)
	if err != nil {
		return nil, err
	}
	if !splitSide(side) {
		return nil, fmt.Errorf("unknown side %s; use left, right, top or bottom", side)
	}
	data, err := s.cardData(id)
	if err != nil {
		return nil, err
	}
	tab, err := s.newTabOf(known, data.ActiveTab())
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(tabData([]layout.Tab{tab}, tab.ID))
	if err != nil {
		return nil, err
	}
	born, ok := s.plane.SplitToward(id, side, layout.SplitInit{Data: encoded})
	if !ok {
		return nil, fmt.Errorf("card %s cannot split toward %s", id, side)
	}
	s.focusCard(born)
	s.settle()
	return map[string]string{"card": born, "tab": tab.ID}, nil
}

// closeCard closes the card id with its tabs.
func (s *Shell) closeCard(id string) error {
	if err := s.paneCard(id); err != nil {
		return err
	}
	if err := s.layoutChangeable(id); err != nil {
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
	delete(s.operated, id)
	if s.focused == id {
		s.focusCard(s.firstCard(s.plane))
	}
	s.settleThen(s.droppedTabs(dropped))
	return nil
}

// addTab adds a new tab of plugin with params to the card id, shows it and focuses the card.
func (s *Shell) addTab(id, plugin string, params json.RawMessage) (string, error) {
	if err := s.layoutChangeable(id); err != nil {
		return "", err
	}
	data, err := s.cardData(id)
	if err != nil {
		return "", err
	}
	known, err := s.knownPlugin(plugin)
	if err != nil {
		return "", err
	}
	checked, err := checkTabParams(known, params)
	if err != nil {
		return "", err
	}
	tab, err := s.newTabOf(known, data.ActiveTab())
	if err != nil {
		return "", err
	}
	if checked != nil {
		tab.Rest["params"] = checked
	}
	data.AppendTab(tab)
	if err := s.storeCard(id, data); err != nil {
		return "", err
	}
	s.focusCard(id)
	s.settle()
	return tab.ID, nil
}

// checkTabParams returns params of a new tab of plugin, nil without params. They match surface.params of the plugin
// (docs/spec/plugins.md#pluginjson).
func checkTabParams(plugin *LoadedPlugin, params json.RawMessage) (json.RawMessage, error) {
	var value any
	if len(params) > 0 {
		if err := json.Unmarshal(params, &value); err != nil {
			return nil, fmt.Errorf("params of %s: %w", plugin.ID, err)
		}
	}
	if value == nil {
		return nil, nil
	}
	if plugin.Params == nil {
		return nil, fmt.Errorf("plugin %s declares no tab params", plugin.ID)
	}
	if !MatchesSchema(plugin.Params, value) {
		return nil, fmt.Errorf("params do not match %s surface.params", plugin.ID)
	}
	return params, nil
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
	s.focusCard(card)
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
