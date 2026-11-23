package workbench

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/egoist/mygo/ui"
)

// The activities of a window (docs/spec/activity.md): the activity of each tab from the statuses of its plugin that declare activity,
// and the highest activity of each card, group card and space, which the window publishes to the record of the project activities of
// the host. The shared cases tabs and windows of docs/spec/cases/activity.json state them, and packages/workbench/activity.js meets
// the same cases.

// Activities are the activities from the highest to the lowest (docs/spec/activity.md#activities).
var Activities = []string{"attention", "running", "failed", "idle"}

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
	// program is the program status of the plugin, "" when it declares none, and programWatch its watch (docs/spec/program-state.md).
	program      string
	programWatch *activityWatch
}

// ProgramState is the program state of a tab (docs/spec/program-state.md#value) as core.grid reports it: the state, and the process id of
// the foreground program of the tab, or nil when the tab runs no program.
type ProgramState struct {
	State string  `json:"state"`
	Pid   *int64  `json:"pid"`
	App   *string `json:"app"`
}

// programStates are the program states from the first to the last (docs/spec/program-state.md#value).
var programStates = []string{"idle", "working", "blocked"}

// TabProgram is the program state of the tab tab from the value that its surface reports for the program status status of plugin: an
// object whose only members are state, one of the program states, pid, a positive integer or null, and app, a text of 1 to 64
// characters or null, gives that state, pid and app, and null gives none. Another value gives an error with the text of docs/spec/program-state.md#value, where the JSON text of the value has
// its members in code point order.
func TabProgram(plugin, status, tab string, value any) (*ProgramState, error) {
	if value == nil {
		return nil, nil
	}
	if object, ok := value.(map[string]any); ok && len(object) == 3 {
		state, isText := object["state"].(string)
		app, appValid := programApp(object)
		if pid, hasPid := object["pid"]; hasPid && isText && appValid && slices.Contains(programStates, state) {
			if pid == nil {
				return &ProgramState{State: state, App: app}, nil
			}
			// default: JSON numbers decode as float64, so a whole number that fits the safe integer range is a process id.
			if number, isNumber := pid.(float64); isNumber && number >= 1 && number <= 1<<53 && number == math.Trunc(number) {
				id := int64(number)
				return &ProgramState{State: state, Pid: &id, App: app}, nil
			}
		}
	}
	text, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("%s exposes %s on tab %s: program value: %w", plugin, status, tab, err)
	}
	return nil, fmt.Errorf("%s exposes %s on tab %s: program value %s is not null or an object with only the members state, pid and app, where state is one of %s, pid is a positive integer or null and app is a text of 1 to 64 characters or null",
		plugin, status, tab, text, strings.Join(programStates, ", "))
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
	// programStatus is the program status of a plugin, "" when it declares none, and programShown shows the error text of the program
	// value of a tab, "" when it is withdrawn (docs/spec/program-state.md#value).
	programStatus func(plugin string) string
	programShown  func(tab, text string)

	followed map[string]*activityTab
	errors   map[string]string
	state    WindowActivities
	// programs are the program states of the tabs that have one, by tab id; programErrors are the shown program errors by tab id.
	programs      map[string]*ProgramState
	programErrors map[string]string
	// published are the published activities of the spaces of each project of the window, as JSON text, by project id.
	published map[string]string
	syncing   bool
}

// NewActivityFollow makes the follow of the activities of a window, which reports nothing until its first Sync.
func NewActivityFollow(observe func(name, surface string, fn func(value any)) func(), statuses func(plugin string) []string,
	programStatus func(plugin string) string, projects func() ([]ActivityProject, error), changed func(), shown func(tab, text string),
	programShown func(tab, text string), failed func(error), publish func(id string, spaces map[string]ActivitySpaceState)) *ActivityFollow {
	return &ActivityFollow{observe: observe, statuses: statuses, programStatus: programStatus, projects: projects, changed: changed,
		shown: shown, programShown: programShown, failed: failed, publish: publish, followed: map[string]*activityTab{},
		errors: map[string]string{}, published: map[string]string{}, programs: map[string]*ProgramState{},
		programErrors: map[string]string{},
		state:         WindowActivities{Spaces: map[string]map[string]ActivitySpaceState{}, Tabs: map[string]string{}}}
}

// State is the activities that the window derived.
func (a *ActivityFollow) State() WindowActivities { return a.state }

// Programs are the program states of the tabs of the window that have one, by tab id (docs/spec/program-state.md#status).
func (a *ActivityFollow) Programs() map[string]*ProgramState { return a.programs }

// derive derives the activities again, shows and withdraws the errors of the values and announces a change.
func (a *ActivityFollow) derive() {
	if a.syncing {
		return
	}
	tabs := map[string]string{}
	programs := map[string]*ProgramState{}
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
		if follow.programWatch == nil {
			continue
		}
		program, programErr := TabProgram(follow.plugin, follow.program, tab, follow.programWatch.value)
		if program != nil {
			programs[tab] = program
		}
		programText := ""
		if programErr != nil {
			programText = programErr.Error()
		}
		if programText != a.programErrors[tab] {
			if programText == "" {
				delete(a.programErrors, tab)
			} else {
				a.programErrors[tab] = programText
			}
			a.programShown(tab, programText)
		}
	}
	for tab := range a.errors {
		if a.followed[tab] == nil {
			delete(a.errors, tab)
			a.shown(tab, "")
		}
	}
	for tab := range a.programErrors {
		if follow := a.followed[tab]; follow == nil || follow.programWatch == nil {
			delete(a.programErrors, tab)
			a.programShown(tab, "")
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
	programsChanged := !reflect.DeepEqual(programs, a.programs)
	if reflect.DeepEqual(a.state, next) && !programsChanged {
		return
	}
	a.state = next
	a.programs = programs
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
					names := a.statuses(tab.Plugin)
					program := a.programStatus(tab.Plugin)
					if len(names) > 0 || program != "" {
						wanted[tab.ID] = &activityTab{plugin: tab.Plugin, names: names, program: program}
					}
				}
			})
		}
	}
	a.syncing = true
	for tab, follow := range a.followed {
		if want := wanted[tab]; want != nil && want.plugin == follow.plugin && slices.Equal(want.names, follow.names) && want.program == follow.program {
			continue
		}
		delete(a.followed, tab)
		for _, watch := range follow.watches {
			watch.stop()
		}
		if follow.programWatch != nil {
			follow.programWatch.stop()
		}
	}
	for tab, want := range wanted {
		if a.followed[tab] != nil {
			continue
		}
		follow := &activityTab{plugin: want.plugin, names: want.names, watches: map[string]*activityWatch{}, program: want.program}
		a.followed[tab] = follow
		for _, name := range want.names {
			watch := &activityWatch{}
			follow.watches[name] = watch
			watch.stop = a.observe(name, tab, a.receive(tab, follow, name, watch))
		}
		if want.program != "" {
			// A surface that has not registered the program status delivers nil, which gives no program state.
			watch := &activityWatch{}
			follow.programWatch = watch
			watch.stop = a.observe(want.program, tab, a.receive(tab, follow, want.program, watch))
		}
	}
	a.syncing = false
	a.derive()
}

// receive is the function that receives each value of the status name of the tab, while the follow of the tab is current. A surface
// delivers the JSON text of its value; a read of the status gives the decoded value.
func (a *ActivityFollow) receive(tab string, follow *activityTab, name string, watch *activityWatch) func(value any) {
	return func(value any) {
		if a.followed[tab] != follow {
			return
		}
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
	}
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

// programError shows the error text of the program value of the tab in the error banner of the window with the source `program <tab>`,
// and withdraws it for "" (docs/spec/program-state.md#value).
func (s *Shell) programError(tab, text string) {
	if text == "" {
		// silent: an error that another source showed since then stays in the banner.
		s.errors.HideFrom(workbenchErrorPlace, "program "+tab)
	} else {
		s.errors.ShowFrom(workbenchErrorPlace, "program "+tab, text, "")
	}
	s.options.Invalidate()
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

// programApp reads the member app of a program value: a text of 1 to 64 characters or null, and whether the member holds one of them
// (docs/spec/program-state.md#value).
func programApp(object map[string]any) (*string, bool) {
	value, present := object["app"]
	if !present {
		return nil, false
	}
	if value == nil {
		return nil, true
	}
	text, isText := value.(string)
	if !isText || utf8.RuneCountInString(text) < 1 || utf8.RuneCountInString(text) > 64 {
		return nil, false
	}
	return &text, true
}
