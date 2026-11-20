package host

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"sync"
)

// projectActivities are the activities from the highest to the lowest (docs/spec/activity.md#activities).
var projectActivities = []string{"attention", "failed", "running", "idle"}

// SpaceActivity is the activity of a space of a project with those of its content cards and group cards by card identifier, as the
// window that holds the project derives them (docs/spec/activity.md#activity-of-a-card-a-group-card-and-a-space).
type SpaceActivity struct {
	Activity string            `json:"activity"`
	Cards    map[string]string `json:"cards"`
	Groups   map[string]string `json:"groups"`
}

// ProjectActivityState is the entry of a project in the record: its activity, the highest of its spaces, and its spaces.
type ProjectActivityState struct {
	Activity string                   `json:"activity"`
	Spaces   map[string]SpaceActivity `json:"spaces"`
}

// ProjectActivityRecord is the record of the activities of the projects of the application, which the event project-activity carries.
type ProjectActivityRecord struct {
	Revision uint64                          `json:"revision"`
	Projects map[string]ProjectActivityState `json:"projects"`
}

// projectActivityEntry is a published project: the window that published it and the activities of its spaces.
type projectActivityEntry struct {
	window string
	spaces map[string]SpaceActivity
}

// ProjectActivities is the record of the activities of the projects of the application, by project and not by window
// (docs/spec/activity.md#activity-of-a-project). The Rust host holds the same record, and both meet the cases records of
// docs/spec/cases/activity.json.
type ProjectActivities struct {
	mu       sync.Mutex
	revision uint64
	entries  map[string]projectActivityEntry
}

// checkActivity refuses a value that is not an activity with the text of docs/spec/activity.md#activity-of-a-project. The value is
// written as JSON text without the escapes of HTML that json.Marshal adds, as serde_json writes it.
func checkActivity(at, value string) error {
	if slices.Contains(projectActivities, value) {
		return nil
	}
	var text bytes.Buffer
	encoder := json.NewEncoder(&text)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return fmt.Errorf("%s: activity: %w", at, err)
	}
	return fmt.Errorf("%s: activity %s is not one of %s", at, strings.TrimSuffix(text.String(), "\n"), strings.Join(projectActivities, ", "))
}

// sortedKeys are the keys of a map in code point order.
func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}

// Publish sets the activities of the spaces of the project id that window publishes; owner is the window that holds the project, ""
// for none. Empty spaces withdraw the project. It returns whether the record changed, and refuses a publication without changing the
// record.
func (r *ProjectActivities) Publish(window, owner, id string, spaces map[string]SpaceActivity) (bool, error) {
	if !validProjectID(id) {
		return false, fmt.Errorf("invalid project id")
	}
	if owner == "" || owner != window {
		return false, fmt.Errorf("project %s is not owned by this window", id)
	}
	for _, space := range sortedKeys(spaces) {
		at := fmt.Sprintf("project %s space %s", id, space)
		if err := checkActivity(at, spaces[space].Activity); err != nil {
			return false, err
		}
		for _, card := range sortedKeys(spaces[space].Cards) {
			if err := checkActivity(at+" card "+card, spaces[space].Cards[card]); err != nil {
				return false, err
			}
		}
		for _, card := range sortedKeys(spaces[space].Groups) {
			if err := checkActivity(at+" group "+card, spaces[space].Groups[card]); err != nil {
				return false, err
			}
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	held, ok := r.entries[id]
	if len(spaces) == 0 {
		if !ok {
			return false, nil
		}
		delete(r.entries, id)
	} else {
		if ok && held.window == window && reflect.DeepEqual(held.spaces, spaces) {
			return false, nil
		}
		if r.entries == nil {
			r.entries = map[string]projectActivityEntry{}
		}
		r.entries[id] = projectActivityEntry{window: window, spaces: spaces}
	}
	r.revision++
	return true, nil
}

// Release removes the entry of the released project id, and returns whether the record changed.
func (r *ProjectActivities) Release(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.entries[id]; !ok {
		return false
	}
	delete(r.entries, id)
	r.revision++
	return true
}

// End removes the entries that window published, because its page or the window ended, and returns whether the record changed.
func (r *ProjectActivities) End(window string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	ended := false
	for id, entry := range r.entries {
		if entry.window == window {
			delete(r.entries, id)
			ended = true
		}
	}
	if ended {
		r.revision++
	}
	return ended
}

// Record is the record {revision, projects}; each project has the highest activity of its spaces.
func (r *ProjectActivities) Record() ProjectActivityRecord {
	r.mu.Lock()
	defer r.mu.Unlock()
	projects := make(map[string]ProjectActivityState, len(r.entries))
	for id, entry := range r.entries {
		highest := ""
		for _, space := range entry.spaces {
			if highest == "" || slices.Index(projectActivities, space.Activity) < slices.Index(projectActivities, highest) {
				highest = space.Activity
			}
		}
		projects[id] = ProjectActivityState{Activity: highest, Spaces: entry.spaces}
	}
	return ProjectActivityRecord{Revision: r.revision, Projects: projects}
}
