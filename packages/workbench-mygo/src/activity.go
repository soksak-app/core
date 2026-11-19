package workbench

import (
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
)

// The activities of a window (docs/spec/activity.md): the activity of each tab from the statuses of its plugin that declare activity,
// and the highest activity of each card, group card, space and project. The shared cases of docs/spec/cases/activity.json state them,
// and packages/workbench/activity.js meets the same cases.

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
	Activity map[string]string `json:"activity"`
	Value    any               `json:"value"`
}

// TabActivity is the activity of a tab from the statuses of its plugin that declare activity: a string value that names a member gives
// that activity.
func TabActivity(statuses []ActivityStatus) string {
	highest := ""
	for _, status := range statuses {
		if value, ok := status.Value.(string); ok {
			highest = HighestActivity(highest, status.Activity[value])
		}
	}
	return highest
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

// activityLayout is what the activities read of a stored layout: the tabs of each card and the group tree.
type activityLayout struct {
	State struct {
		Cards []struct {
			ID   string `json:"id"`
			Data *struct {
				Tabs []struct {
					ID     string `json:"id"`
					Plugin string `json:"plugin"`
				} `json:"tabs"`
			} `json:"data"`
		} `json:"cards"`
	} `json:"state"`
	Groups []activityNode `json:"groups"`
}

// activityNode is a member of a level: a content card by its identifier, or the node of a group card with its members.
type activityNode struct {
	Card    string
	Members []activityNode
	group   bool
}

// UnmarshalJSON reads a member: a string is a content card and an object the node of a group card.
func (n *activityNode) UnmarshalJSON(text []byte) error {
	if err := json.Unmarshal(text, &n.Card); err == nil {
		return nil
	}
	var node struct {
		Card    string         `json:"card"`
		Members []activityNode `json:"members"`
	}
	if err := json.Unmarshal(text, &node); err != nil {
		return fmt.Errorf("a group member is neither a card nor a group node: %w", err)
	}
	n.Card, n.Members, n.group = node.Card, node.Members, true
	return nil
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

// ActivityState is the value of core.activity (docs/spec/activity.md#status).
type ActivityState struct {
	Projects map[string]ActivityProjectState `json:"projects"`
	Tabs     map[string]string               `json:"tabs"`
}

// WindowActivity is the value of core.activity for the projects of a window from the activity of each tab, by tab id. Each holder is
// listed only with an activity.
func WindowActivity(projects []ActivityProject, tabs map[string]string) (ActivityState, error) {
	out := ActivityState{Projects: map[string]ActivityProjectState{}, Tabs: map[string]string{}}
	for _, project := range projects {
		spaces := map[string]ActivitySpaceState{}
		highest := ""
		for _, space := range project.Spaces {
			var stored activityLayout
			if err := json.Unmarshal(space.Layout, &stored); err != nil {
				return ActivityState{}, fmt.Errorf("project %s space %s: %w", project.ID, space.ID, err)
			}
			state := ActivitySpaceState{Cards: map[string]string{}, Groups: map[string]string{}}
			for _, card := range stored.State.Cards {
				// A seat card has null data, so it holds no tabs.
				if card.Data == nil {
					continue
				}
				held := ""
				for _, tab := range card.Data.Tabs {
					if activity := tabs[tab.ID]; activity != "" {
						out.Tabs[tab.ID] = activity
						held = HighestActivity(held, activity)
					}
				}
				if held != "" {
					state.Cards[card.ID] = held
				}
			}
			var member func(node activityNode) string
			member = func(node activityNode) string {
				if !node.group {
					return state.Cards[node.Card]
				}
				held := ""
				for _, inner := range node.Members {
					held = HighestActivity(held, member(inner))
				}
				if held != "" {
					state.Groups[node.Card] = held
				}
				return held
			}
			for _, node := range stored.Groups {
				member(node)
			}
			for _, activity := range state.Cards {
				state.Activity = HighestActivity(state.Activity, activity)
			}
			if state.Activity != "" {
				spaces[space.ID] = state
				highest = HighestActivity(highest, state.Activity)
			}
		}
		if highest != "" {
			out.Projects[project.ID] = ActivityProjectState{Activity: highest, Spaces: spaces}
		}
	}
	return out, nil
}

// ActivityDeclaration is a status of a plugin that declares activity: its name and its map.
type ActivityDeclaration struct {
	Name     string            `json:"name"`
	Activity map[string]string `json:"activity"`
}

// activityDeclarations reads the statuses of a plugin that declare activity from its status entries.
func activityDeclarations(plugin string, entries []json.RawMessage) ([]ActivityDeclaration, error) {
	var out []ActivityDeclaration
	for _, raw := range entries {
		var entry ActivityDeclaration
		if err := json.Unmarshal(raw, &entry); err != nil {
			return nil, fmt.Errorf("plugin %s status: %w", plugin, err)
		}
		if entry.Activity != nil {
			out = append(out, entry)
		}
	}
	return out, nil
}

// ActivityTab is a tab of the layouts of a window whose statuses the activities follow.
type ActivityTab struct {
	ID, Plugin string
}

// activityKey is a followed status of a tab.
type activityKey struct{ tab, name string }

// activityFollow is a followed status: its declared map, its value and the function that ends its watch.
type activityFollow struct {
	activity map[string]string
	value    any
	stop     func()
}

// ActivityFollow follows the statuses that declare activity on the surface of each tab of the projects of a window by a watch of each
// surface (docs/spec/activity.md#activity-of-a-tab).
type ActivityFollow struct {
	// observe follows the status name of surface: fn receives each value, nil while the surface has not registered it, and the returned
	// function ends it.
	observe func(name, surface string, fn func(value any)) (stop func())
	// statuses are the statuses of a plugin that declare activity.
	statuses func(plugin string) []ActivityDeclaration
	// projects are the projects of the window, each with the stored layout of each space.
	projects func() ([]ActivityProject, error)
	// changed is called after the value of core.activity changed, and failed with an error of a read.
	changed func()
	failed  func(error)

	followed map[activityKey]*activityFollow
	state    ActivityState
	syncing  bool
}

// NewActivityFollow makes the follow of the activities of a window, which reports nothing until its first Sync.
func NewActivityFollow(observe func(name, surface string, fn func(value any)) func(), statuses func(plugin string) []ActivityDeclaration,
	projects func() ([]ActivityProject, error), changed func(), failed func(error)) *ActivityFollow {
	return &ActivityFollow{observe: observe, statuses: statuses, projects: projects, changed: changed, failed: failed,
		followed: map[activityKey]*activityFollow{}, state: ActivityState{Projects: map[string]ActivityProjectState{}, Tabs: map[string]string{}}}
}

// State is the value of core.activity.
func (a *ActivityFollow) State() ActivityState { return a.state }

// derive derives the activities again and announces a change.
func (a *ActivityFollow) derive() {
	if a.syncing {
		return
	}
	tabs := map[string]string{}
	for key, follow := range a.followed {
		tabs[key.tab] = HighestActivity(tabs[key.tab], TabActivity([]ActivityStatus{{Activity: follow.activity, Value: follow.value}}))
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
	wanted := map[activityKey]map[string]string{}
	for _, project := range projects {
		for _, space := range project.Spaces {
			var stored activityLayout
			if err := json.Unmarshal(space.Layout, &stored); err != nil {
				a.failed(fmt.Errorf("project %s space %s: %w", project.ID, space.ID, err))
				return
			}
			for _, card := range stored.State.Cards {
				// A seat card has null data, so it holds no tabs.
				if card.Data == nil {
					continue
				}
				for _, tab := range card.Data.Tabs {
					for _, status := range a.statuses(tab.Plugin) {
						wanted[activityKey{tab.ID, status.Name}] = status.Activity
					}
				}
			}
		}
	}
	a.syncing = true
	for key, follow := range a.followed {
		if activity, ok := wanted[key]; ok && sameActivity(activity, follow.activity) {
			continue
		}
		delete(a.followed, key)
		follow.stop()
	}
	for key, activity := range wanted {
		if a.followed[key] != nil {
			continue
		}
		follow := &activityFollow{activity: activity}
		a.followed[key] = follow
		follow.stop = a.observe(key.name, key.tab, func(value any) {
			if a.followed[key] != follow {
				return
			}
			// A surface delivers the JSON text of its value; a read of the status gives the decoded value.
			if raw, isText := value.(json.RawMessage); isText {
				var decoded any
				if err := json.Unmarshal(raw, &decoded); err != nil {
					a.failed(fmt.Errorf("activity: status %s of surface %s: %w", key.name, key.tab, err))
					return
				}
				value = decoded
			}
			follow.value = value
			a.derive()
		})
	}
	a.syncing = false
	a.derive()
}

// sameActivity tells whether two declared maps are equal.
func sameActivity(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for value, activity := range a {
		if b[value] != activity {
			return false
		}
	}
	return true
}
