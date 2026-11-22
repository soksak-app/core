package workbench

import (
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"strings"

	"github.com/egoist/mygo/ui"
)

// The activities of a window (docs/spec/activity.md): the activity of each tab from the statuses of its plugin that declare activity,
// and the highest activity of each card, group card and space, which the window publishes to the record of the project activities of
// the host. The shared cases tabs and windows of docs/spec/cases/activity.json state them, and packages/workbench/activity.js meets
// the same cases.

// Activities are the activities from the highest to the lowest (docs/spec/activity.md#activities).
var Activities = []string{"attention", "failed", "running", "idle"}

// HighestActivity is the highest of the activities, and "" when none is given. "" stands for no activity.
func HighestActivity(activities ...string) string {
	highest := ""
	for _, activity := range activities {
		if activity != "" && (highest == "" || slices.Index(Activities, activity) < slices.Index(Activities, highest)) {
			highest = activity
		}
	}
	return highest
}

// ActivityStatus is a status of a plugin that declares activity, with the value that the surface of a tab reports, nil while the
// surface has not registered it.
type ActivityStatus struct {
	Name  string `json:"name"`
	Value any    `json:"value"`
}

// TabActivity is the activity of the tab tab of plugin from the statuses of the plugin that declare activity: a status whose value is
// an activity gives it, and nil gives none. The error names the first status in the order of statuses whose value is neither an
// activity nor nil, which gives no activity (docs/spec/activity.md#activity-of-a-tab).
func TabActivity(plugin, tab string, statuses []ActivityStatus) (string, error) {
	highest := ""
	var failure error
	for _, status := range statuses {
		if status.Value == nil {
			continue
		}
		if value, ok := status.Value.(string); ok && slices.Contains(Activities, value) {
			highest = HighestActivity(highest, value)
			continue
		}
		if failure == nil {
			text, err := json.Marshal(status.Value)
			if err != nil {
				return "", fmt.Errorf("%s exposes %s on tab %s: activity value: %w", plugin, status.Name, tab, err)
			}
			failure = fmt.Errorf("%s exposes %s on tab %s: activity value %s is not one of %s", plugin, status.Name, tab, text, strings.Join(Activities, ", "))
		}
	}
	return highest, failure
}

// ActivityProject is a project of a window for its activities: its id and the stored layout of each of its spaces.
type ActivityProject struct {
	ID     string          `json:"id"`
	Spaces []ActivitySpace `json:"spaces"`
}

// ActivitySpace is a space with its layout in the stored form (docs/spec/groups.md#storage).
type ActivitySpace struct {
	ID     string          `json:"id"`
	Layout json.RawMessage `json:"layout"`
}

// activityLayout is what the activities read of a stored layout: its stored tree (docs/spec/groups.md#storage).
type activityLayout struct {
	State struct {
		Root activityNode `json:"root"`
	} `json:"state"`
}

// activityNode is a node of the stored tree: a card with the tabs of its data, a cut with its kids, or the box of a group card around
// its inner node.
type activityNode struct {
	Card string `json:"card"`
	// A window sidebar or a seat card has null data, so it holds no tabs.
	Data *struct {
		Tabs []struct {
			ID     string `json:"id"`
			Plugin string `json:"plugin"`
		} `json:"tabs"`
	} `json:"data"`
	Kids []struct {
		Node activityNode `json:"node"`
	} `json:"kids"`
	Box   string        `json:"box"`
	Inner *activityNode `json:"inner"`
}

// eachCard calls visit with each card node of the tree under n that holds data, in tree order.
func (n activityNode) eachCard(visit func(card activityNode)) {
	switch {
	case n.Box != "":
		if n.Inner != nil {
			n.Inner.eachCard(visit)
		}
	case n.Kids != nil:
		for _, kid := range n.Kids {
			kid.Node.eachCard(visit)
		}
	case n.Data != nil:
		visit(n)
	}
}

// ActivitySpaceState is a space of core.activity: its activity and those of its content cards and group cards by card identifier.
type ActivitySpaceState struct {
	Activity string            `json:"activity"`
	Cards    map[string]string `json:"cards"`
	Groups   map[string]string `json:"groups"`
}

// ActivityProjectState is a project of core.activity: its activity and its spaces that have one.
type ActivityProjectState struct {
	Activity string                        `json:"activity"`
	Spaces   map[string]ActivitySpaceState `json:"spaces"`
}

// ActivityState is the value of core.activity (docs/spec/activity.md#status): the record of the project activities of the application
// and the activities of the tabs of the window.
type ActivityState struct {
	Projects map[string]ActivityProjectState `json:"projects"`
	Tabs     map[string]string               `json:"tabs"`
}

// ActivityRecord is the record of the project activities of the application that the host sends as project-activity
// (docs/spec/activity.md#activity-of-a-project).
type ActivityRecord struct {
	Revision int64                           `json:"revision"`
	Projects map[string]ActivityProjectState `json:"projects"`
}

// WindowActivities are the activities that a window derives: for each project that has a space with an activity the activities of its
// spaces, which the window publishes with projectActivity, and the activities of the tabs.
type WindowActivities struct {
	Spaces map[string]map[string]ActivitySpaceState `json:"spaces"`
	Tabs   map[string]string                        `json:"tabs"`
}

// WindowActivity is the activities of the projects of a window from the activity of each tab, by tab id
// (docs/spec/activity.md#activity-of-a-card-a-group-card-and-a-space). Each holder is listed only with an activity, and no activity of a
// project is derived here.
func WindowActivity(projects []ActivityProject, tabs map[string]string) (WindowActivities, error) {
	out := WindowActivities{Spaces: map[string]map[string]ActivitySpaceState{}, Tabs: map[string]string{}}
	for _, project := range projects {
		spaces := map[string]ActivitySpaceState{}
		for _, space := range project.Spaces {
			var stored activityLayout
			if err := json.Unmarshal(space.Layout, &stored); err != nil {
				return WindowActivities{}, fmt.Errorf("project %s space %s: %w", project.ID, space.ID, err)
			}
			state := ActivitySpaceState{Cards: map[string]string{}, Groups: map[string]string{}}
			// The activity of a node is the highest activity of the cards inside it; a box records it as the activity of its group card.
			var held func(node activityNode) string
			held = func(node activityNode) string {
				highest := ""
				switch {
				case node.Box != "":
					if node.Inner == nil {
						return ""
					}
					highest = held(*node.Inner)
					if highest != "" {
						state.Groups[node.Box] = highest
					}
				case node.Kids != nil:
					for _, kid := range node.Kids {
						highest = HighestActivity(highest, held(kid.Node))
					}
				case node.Data != nil:
					for _, tab := range node.Data.Tabs {
						if activity := tabs[tab.ID]; activity != "" {
							out.Tabs[tab.ID] = activity
							highest = HighestActivity(highest, activity)
						}
					}
					if highest != "" {
						state.Cards[node.Card] = highest
					}
				}
				return highest
			}
			held(stored.State.Root)
			for _, activity := range state.Cards {
				state.Activity = HighestActivity(state.Activity, activity)
			}
			if state.Activity != "" {
				spaces[space.ID] = state
			}
		}
		if len(spaces) > 0 {
			out.Spaces[project.ID] = spaces
		}
	}
	return out, nil
}

// readActivityStatuses reads the names of the statuses of a plugin that declare activity from its status entries, in their order.
func readActivityStatuses(plugin string, entries []json.RawMessage) ([]string, error) {
	var out []string
	for _, raw := range entries {
		var entry struct {
			Name     string `json:"name"`
			Activity bool   `json:"activity"`
		}
		if err := json.Unmarshal(raw, &entry); err != nil {
			return nil, fmt.Errorf("plugin %s status: %w", plugin, err)
		}
		if entry.Activity {
			out = append(out, entry.Name)
		}
	}
	return out, nil
}

// activityWatch is a followed status of a tab: its value and the function that ends its watch.
type activityWatch struct {
	value any
	stop  func()
}

// activityTab is a followed tab: its plugin and its followed statuses in the order of their declaration.
type activityTab struct {
	plugin  string
	names   []string
	watches map[string]*activityWatch
}

// ActivityFollow follows the statuses that declare activity on the surface of each tab of the projects of a window by a watch of each
// surface (docs/spec/activity.md#activity-of-a-tab), and publishes the activities of the spaces of each project of the window after each
// change of them (docs/spec/activity.md#activity-of-a-project). A project that leaves the window is not published again: the host
// removes its entry with its release.
type ActivityFollow struct {
	// observe follows the status name of surface: fn receives each value, nil while the surface has not registered it, and the returned
	// function ends it.
	observe func(name, surface string, fn func(value any)) (stop func())
	// statuses are the names of the statuses of a plugin that declare activity, in the order of its declaration.
	statuses func(plugin string) []string
	// projects are the projects of the window, each with the stored layout of each space.
	projects func() ([]ActivityProject, error)
	// changed is called after the value of core.activity changed, shown with the error text of the activity values of a tab or "" when
	// it is withdrawn, and failed with an error of a read.
	changed func()
	shown   func(tab, text string)
	failed  func(error)
	// publish publishes the activities of the spaces of a project, empty when none has an activity.
	publish func(id string, spaces map[string]ActivitySpaceState)

	followed map[string]*activityTab
	errors   map[string]string
	state    WindowActivities
	// published are the published activities of the spaces of each project of the window, as JSON text, by project id.
	published map[string]string
	syncing   bool
}

// NewActivityFollow makes the follow of the activities of a window, which reports nothing until its first Sync.
func NewActivityFollow(observe func(name, surface string, fn func(value any)) func(), statuses func(plugin string) []string,
	projects func() ([]ActivityProject, error), changed func(), shown func(tab, text string), failed func(error),
	publish func(id string, spaces map[string]ActivitySpaceState)) *ActivityFollow {
	return &ActivityFollow{observe: observe, statuses: statuses, projects: projects, changed: changed, shown: shown, failed: failed,
		publish: publish, followed: map[string]*activityTab{}, errors: map[string]string{}, published: map[string]string{},
		state: WindowActivities{Spaces: map[string]map[string]ActivitySpaceState{}, Tabs: map[string]string{}}}
}

// State is the activities that the window derived.
func (a *ActivityFollow) State() WindowActivities { return a.state }

// derive derives the activities again, shows and withdraws the errors of the values and announces a change.
func (a *ActivityFollow) derive() {
	if a.syncing {
		return
	}
	tabs := map[string]string{}
	for tab, follow := range a.followed {
		statuses := make([]ActivityStatus, 0, len(follow.names))
		for _, name := range follow.names {
			statuses = append(statuses, ActivityStatus{Name: name, Value: follow.watches[name].value})
		}
		activity, err := TabActivity(follow.plugin, tab, statuses)
		if activity != "" {
			tabs[tab] = activity
		}
		text := ""
		if err != nil {
			text = err.Error()
		}
		if text != a.errors[tab] {
			if text == "" {
				delete(a.errors, tab)
			} else {
				a.errors[tab] = text
			}
			a.shown(tab, text)
		}
	}
	for tab := range a.errors {
		if a.followed[tab] == nil {
			delete(a.errors, tab)
			a.shown(tab, "")
		}
	}
	projects, err := a.projects()
	if err != nil {
		a.failed(err)
		return
	}
	next, err := WindowActivity(projects, tabs)
	if err != nil {
		a.failed(err)
		return
	}
	held := map[string]bool{}
	for _, project := range projects {
		held[project.ID] = true
	}
	for id := range a.published {
		if !held[id] {
			delete(a.published, id)
		}
	}
	for _, project := range projects {
		// A project without a space with an activity publishes empty spaces, which a project never published leaves unpublished.
		spaces := next.Spaces[project.ID]
		if spaces == nil {
			spaces = map[string]ActivitySpaceState{}
		}
		text, err := json.Marshal(spaces)
		if err != nil {
			a.failed(fmt.Errorf("activity: project %s: %w", project.ID, err))
			return
		}
		published, ok := a.published[project.ID]
		if !ok {
			published = "{}"
		}
		if string(text) == published {
			continue
		}
		a.published[project.ID] = string(text)
		a.publish(project.ID, spaces)
	}
	if reflect.DeepEqual(a.state, next) {
		return
	}
	a.state = next
	a.changed()
}

// Sync starts and ends the watches after a layout, a project or the plugins of the window changed.
func (a *ActivityFollow) Sync() {
	projects, err := a.projects()
	if err != nil {
		a.failed(err)
		return
	}
	wanted := map[string]*activityTab{}
	for _, project := range projects {
		for _, space := range project.Spaces {
			var stored activityLayout
			if err := json.Unmarshal(space.Layout, &stored); err != nil {
				a.failed(fmt.Errorf("project %s space %s: %w", project.ID, space.ID, err))
				return
			}
			stored.State.Root.eachCard(func(card activityNode) {
				for _, tab := range card.Data.Tabs {
					if names := a.statuses(tab.Plugin); len(names) > 0 {
						wanted[tab.ID] = &activityTab{plugin: tab.Plugin, names: names}
					}
				}
			})
		}
	}
	a.syncing = true
	for tab, follow := range a.followed {
		if want := wanted[tab]; want != nil && want.plugin == follow.plugin && slices.Equal(want.names, follow.names) {
			continue
		}
		delete(a.followed, tab)
		for _, watch := range follow.watches {
			watch.stop()
		}
	}
	for tab, want := range wanted {
		if a.followed[tab] != nil {
			continue
		}
		follow := &activityTab{plugin: want.plugin, names: want.names, watches: map[string]*activityWatch{}}
		a.followed[tab] = follow
		for _, name := range want.names {
			watch := &activityWatch{}
			follow.watches[name] = watch
			watch.stop = a.observe(name, tab, func(value any) {
				if a.followed[tab] != follow {
					return
				}
				// A surface delivers the JSON text of its value; a read of the status gives the decoded value.
				if raw, isText := value.(json.RawMessage); isText {
					var decoded any
					if err := json.Unmarshal(raw, &decoded); err != nil {
						a.failed(fmt.Errorf("activity: status %s of surface %s: %w", name, tab, err))
						return
					}
					value = decoded
				}
				watch.value = value
				a.derive()
			})
		}
	}
	a.syncing = false
	a.derive()
}

// shownActivities are the activities that the window draws: those of the tabs and of the group cards of the shown space, and those of
// the projects and the spaces of the shown project (docs/spec/activity.md#drawing).
func (s *Shell) shownActivities() (tabs, groups, projects, spaces map[string]string) {
	state := s.activityState()
	tabs, groups, projects, spaces = state.Tabs, map[string]string{}, map[string]string{}, map[string]string{}
	for id, project := range state.Projects {
		projects[id] = project.Activity
	}
	if shown, ok := state.Projects[s.active]; ok && !s.inLibrary() {
		for id, space := range shown.Spaces {
			spaces[id] = space.Activity
		}
		if project := s.opened(); project != nil {
			groups = shown.Spaces[project.ActiveSpaceID].Groups
		}
	}
	return tabs, groups, projects, spaces
}

// activityState is the value of core.activity: the record of the project activities that the host sent and the activities of the tabs
// of the window (docs/spec/activity.md#status).
func (s *Shell) activityState() ActivityState {
	return ActivityState{Projects: s.projectRecord.Projects, Tabs: s.activity.State().Tabs}
}

// projectActivityReceived keeps the record of the project activities of the highest revision that the host sent.
func (s *Shell) projectActivityReceived(data []any) {
	record, err := eventBody[ActivityRecord]("project-activity", data)
	if err != nil {
		s.fail(err)
		return
	}
	if record.Revision <= s.projectRecord.Revision {
		return
	}
	s.projectRecord = record
	s.options.Invalidate()
}

// activityPublication is a publication of the activities of the spaces of a project that waits for the one before it.
type activityPublication struct {
	id     string
	spaces map[string]ActivitySpaceState
}

// publishActivity publishes the activities of the spaces of the project id to the host, one publication after the other, so that the
// host receives them in the order of their changes; Calls runs each call on a goroutine of its own.
func (s *Shell) publishActivity(id string, spaces map[string]ActivitySpaceState) {
	s.publications = append(s.publications, activityPublication{id, spaces})
	if len(s.publications) == 1 {
		s.nextPublication()
	}
}

// nextPublication sends the first waiting publication and the next one after its answer.
func (s *Shell) nextPublication() {
	next := s.publications[0]
	s.calls.Call("projectActivity", map[string]any{"id": next.id, "spaces": next.spaces}, func(_ any, err error) {
		if err != nil {
			s.fail(fmt.Errorf("projectActivity %s: %w", next.id, err))
		}
		s.publications = s.publications[1:]
		if len(s.publications) > 0 {
			s.nextPublication()
		}
	})
}

// activityColor is the color of the icon of activity; none is the error color, which belongs to the display of errors.
func (s *Shell) activityColor(activity string) ui.Color {
	switch activity {
	case "attention":
		return s.palette.Focus
	case "failed":
		return s.palette.Fail
	case "running":
		return s.palette.Rail
	}
	return s.palette.Muted
}

// activityMark is the size of the icon of an activity beside a name of text points and the gap between the icon and the name: both
// are declared shares of the text size, so every holder keeps one ratio (docs/spec/activity.md#drawing).
func (s *Shell) activityMark(text float32) (icon, gap float32) {
	return text * s.metrics.activityIconEm, text * s.metrics.activityGapEm
}

// drawActivity draws the icon of activity, size wide, as the element name of item: an image with the declared name of the activity as
// its label and tooltip, as drawActivity of packages/workbench/activity.js.
func (s *Shell) drawActivity(c *ui.Context, name, item, activity string, size float32) ui.Element {
	paint := fmt.Sprintf(`fill="none" stroke="currentColor" stroke-width="%g"`, s.metrics.activityStroke)
	label := s.options.Declared.ActivityNames[activity]
	return ui.Icon(s.binder.Name(c, name, item), s.declaredIcon("0 0 16 16", paint, s.options.Declared.Icons["activity-"+activity])).
		Size(size, size).Shrink(0).TextColor(s.activityColor(activity)).Role(ui.RoleImage).Label(label).Tooltip(label)
}

// activityError shows the error text of the activity values of the tab in the error banner of the window with the source
// `activity <tab>`, and withdraws it for "" (docs/spec/activity.md#activity-of-a-tab).
func (s *Shell) activityError(tab, text string) {
	if text == "" {
		// silent: an error that another source showed since then stays in the banner.
		s.errors.HideFrom(workbenchErrorPlace, "activity "+tab)
	} else {
		s.errors.ShowFrom(workbenchErrorPlace, "activity "+tab, text, "")
	}
	s.options.Invalidate()
}
