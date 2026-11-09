package workbench

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
)

// The project data of a plugin (docs/spec/plugins.md#project-data): a view reads and writes the keys that its plugin declares, in the
// project of its start values, which is not always the shown one. The member plugins of a project record stores each value as
// {format, value}.

// dataDeclaration is a key of the member data of plugin.json.
type dataDeclaration struct {
	Schema  any             `json:"schema"`
	Default json.RawMessage `json:"default"`
	Format  *int            `json:"format"`
}

// format is the declared format of a key: 1 for a key that declares none.
func (d dataDeclaration) format() int {
	if d.Format == nil {
		return 1
	}
	return *d.Format
}

// storedData is the stored entry of a key.
type storedData struct {
	Format *int             `json:"format"`
	Value  *json.RawMessage `json:"value"`
}

// storedPlugins reads the member plugins of a project record: the stored keys of each plugin.
func storedPlugins(project *projectRecord) (map[string]map[string]json.RawMessage, error) {
	plugins := map[string]map[string]json.RawMessage{}
	if raw, ok := project.Rest["plugins"]; ok {
		if err := json.Unmarshal(raw, &plugins); err != nil {
			return nil, fmt.Errorf("project %s member plugins: %w", project.ID, err)
		}
	}
	return plugins, nil
}

// readProjectData returns the value of a key of the plugin in the project: its default until it is stored. A value that is
// stored in another format, or without a format, fails the read and stays unchanged, as the workbench converts no stored value.
func readProjectData(project *projectRecord, unit *installedUnit, key string) (json.RawMessage, error) {
	declared, ok := unit.Data[key]
	if !ok {
		return nil, fmt.Errorf("%s data %s is not declared", unit.ID, key)
	}
	plugins, err := storedPlugins(project)
	if err != nil {
		return nil, err
	}
	raw, ok := plugins[unit.ID][key]
	if !ok {
		return declared.Default, nil
	}
	where := fmt.Sprintf("project %s plugin %s data %s", project.ID, unit.ID, key)
	var stored storedData
	if err := json.Unmarshal(raw, &stored); err != nil || stored.Format == nil || stored.Value == nil {
		return nil, fmt.Errorf("%s: stored without a format is not declared format %d", where, declared.format())
	}
	if *stored.Format != declared.format() {
		return nil, fmt.Errorf("%s: stored format %d is not declared format %d", where, *stored.Format, declared.format())
	}
	if err := checkProjectData(unit, key, *stored.Value); err != nil {
		return nil, err
	}
	return *stored.Value, nil
}

// checkProjectData refuses a value that does not match the schema of its key.
func checkProjectData(unit *installedUnit, key string, value json.RawMessage) error {
	declared, ok := unit.Data[key]
	if !ok {
		return fmt.Errorf("%s data %s is not declared", unit.ID, key)
	}
	var decoded any
	if err := json.Unmarshal(value, &decoded); err != nil {
		return fmt.Errorf("%s data %s: %w", unit.ID, key, err)
	}
	if !MatchesSchema(declared.Schema, decoded) {
		return fmt.Errorf("%s data %s does not match its schema", unit.ID, key)
	}
	return nil
}

// writeProjectData stores a value of a key of the plugin in the project and tells each view of that plugin in that project.
func (s *Shell) writeProjectData(project *projectRecord, unit *installedUnit, key string, value json.RawMessage, answer viewAnswer) error {
	if err := checkProjectData(unit, key, value); err != nil {
		return err
	}
	plugins, err := storedPlugins(project)
	if err != nil {
		return err
	}
	format := unit.Data[key].format()
	entry, err := json.Marshal(storedData{Format: &format, Value: &value})
	if err != nil {
		return err
	}
	if plugins[unit.ID] == nil {
		plugins[unit.ID] = map[string]json.RawMessage{}
	}
	plugins[unit.ID][key] = entry
	encoded, err := json.Marshal(plugins)
	if err != nil {
		return err
	}
	// The next write starts from this one, so the record takes it before the store confirms it. A store that refuses it takes it
	// back out, unless a later write stands on it.
	id, before, stored := project.ID, project.Rest["plugins"], json.RawMessage(encoded)
	if project.Rest == nil {
		project.Rest = map[string]json.RawMessage{}
	}
	project.Rest["plugins"] = stored
	s.surfaces.dataWrites[id]++
	s.calls.CallInOrder("workspace", "workspace", map[string]any{"kind": "patch", "id": id, "patch": map[string]any{"plugins": stored}}, func(_ any, err error) {
		s.surfaces.dataWrites[id]--
		if err != nil {
			if kept := s.project(id); kept != nil && bytes.Equal(kept.Rest["plugins"], stored) {
				if before == nil {
					delete(kept.Rest, "plugins")
				} else {
					kept.Rest["plugins"] = before
				}
			}
			answer(nil, err)
			return
		}
		answer(nil, nil)
		s.dataChanged(id, unit.ID, key)
	})
	return nil
}

// dataChanged pushes the event data to each view of the plugin in the project that follows it.
func (s *Shell) dataChanged(project, plugin, key string) {
	for surface, view := range s.surfaces.views {
		held := s.surfaces.held[surface]
		if view.data && held != nil && held.tab.Plugin == plugin && held.project.ID == project {
			s.pushView(surface, view, "data", map[string]string{"key": key})
		}
	}
}

// runDataCall serves a call runtime.data of a view of the project of its start values.
func (s *Shell) runDataCall(call viewCallEvent, unit *installedUnit, view *viewState, answer viewAnswer) error {
	held := s.surfaces.held[call.Surface]
	var project *projectRecord
	if held != nil {
		project = s.project(held.project.ID)
	}
	if project == nil {
		return fmt.Errorf("view call %s requires a project", call.Command)
	}
	if call.Command == "runtime.data.on" {
		view.data = true
		answer(nil, nil)
		return nil
	}
	fields, err := viewFields[struct {
		Key   string          `json:"key"`
		Base  json.RawMessage `json:"base"`
		Value json.RawMessage `json:"value"`
	}](call)
	if err != nil {
		return err
	}
	if fields.Key == "" {
		return fmt.Errorf("view call %s requires a non-empty key", call.Command)
	}
	if _, ok := unit.Data[fields.Key]; !ok {
		return fmt.Errorf("view call %s %s is not a data key of %s", call.Command, fields.Key, unit.ID)
	}
	if call.Command == "runtime.data.set" {
		return s.writeProjectData(project, unit, fields.Key, fields.Value, answer)
	}
	value, err := readProjectData(project, unit, fields.Key)
	if err != nil {
		return err
	}
	if call.Command != "runtime.data.replace" {
		answer(value, nil)
		return nil
	}
	if fields.Base == nil {
		return fmt.Errorf("view call %s requires base", call.Command)
	}
	same, err := sameData(value, fields.Base)
	if err != nil {
		return err
	}
	if !same {
		answer(false, nil)
		return nil
	}
	return s.writeProjectData(project, unit, fields.Key, fields.Value, func(_ any, err error) {
		if err != nil {
			answer(nil, err)
			return
		}
		answer(true, nil)
	})
}

// sameData tells whether two values of project data are the same value, whatever the order of the members of their objects and
// the form of their text.
func sameData(one, other json.RawMessage) (bool, error) {
	var first, second any
	if err := json.Unmarshal(one, &first); err != nil {
		return false, err
	}
	if err := json.Unmarshal(other, &second); err != nil {
		return false, err
	}
	return reflect.DeepEqual(first, second), nil
}

// workspaceChanged reads the store after a write: a project that the store no longer lists leaves this window, each project that this
// window does not hold takes its stored record, and each key of plugin data that differs from what this window holds is reported, as a
// write of another window reaches this window through the store.
func (s *Shell) workspaceChanged() {
	s.calls.CallInOrder("workspace", "workspace", map[string]string{"kind": "snapshot"}, func(value any, err error) {
		if err != nil {
			s.fail(fmt.Errorf("workspace changed: %w", err))
			return
		}
		if err := s.compareData(value); err != nil {
			s.fail(fmt.Errorf("workspace changed: %w", err))
		}
		// The registry and the settings of the page each listen to the change and report their errors apart (connectSettings of
		// packages/workbench/settings.js), so a refused setting does not stop the projects and the reverse.
		if err := s.refreshSettings(value); err != nil {
			s.fail(err)
		}
	})
}

// refreshSettings takes the common settings and the overrides of the shown project of a workspace snapshot, as refresh of
// packages/workbench/settings.js: a window that writes its settings reads nothing until the host answered every write, the
// settings file of the shown project that the host refuses is reported and the applied settings stay (docs/spec/projects.md#settings),
// values that the window refuses leave the applied settings, and only changed values are applied.
func (s *Shell) refreshSettings(value any) error {
	if s.settings.saving > 0 {
		return nil
	}
	snapshot, err := decode[struct {
		Common   map[string]any    `json:"common"`
		Projects []json.RawMessage `json:"projects"`
	}](value)
	if err != nil {
		return err
	}
	var overrides map[string]any
	if id := s.settings.Project(); id != "" {
		for _, raw := range snapshot.Projects {
			project, err := readProject(raw)
			if err != nil {
				return err
			}
			if project.ID != id {
				continue
			}
			var refused *string
			if err := member(project.Rest, "settingsError", &refused); err != nil {
				return err
			}
			if refused != nil {
				return errors.New(*refused)
			}
			if err := member(project.Rest, "settings", &overrides); err != nil {
				return err
			}
		}
	}
	common, overrides := orEmpty(snapshot.Common), orEmpty(overrides)
	if err := s.settings.Check(common, overrides); err != nil {
		return err
	}
	if reflect.DeepEqual(common, s.settings.common) && reflect.DeepEqual(overrides, s.settings.overrides) {
		return nil
	}
	if err := s.settings.Begin(common, overrides, s.settings.Project()); err != nil {
		return err
	}
	if err := s.followDiagnostics(); err != nil {
		return err
	}
	s.options.Invalidate()
	return s.applySettings()
}

// compareData takes the projects of a workspace snapshot: a project that another window removed leaves this window as readProjects of
// packages/workbench/projects.js ends it (docs/spec/projects.md#settings), a project that another window stored joins the list, a
// project that this window does not hold takes its whole record, and one that it holds takes its plugin data.
func (s *Shell) compareData(value any) error {
	snapshot, err := decode[struct {
		Projects      []json.RawMessage `json:"projects"`
		Open          []string          `json:"open"`
		ProjectsError *string           `json:"projectsError"`
	}](value)
	if err != nil {
		return err
	}
	if snapshot.ProjectsError != nil {
		return errors.New(*snapshot.ProjectsError)
	}
	reads := make([]projectRecord, 0, len(snapshot.Projects))
	listed := make(map[string]bool, len(snapshot.Projects))
	for _, raw := range snapshot.Projects {
		read, err := readProject(raw)
		if err != nil {
			return err
		}
		reads = append(reads, read)
		listed[read.ID] = true
	}
	var removed []string
	for _, project := range s.projects {
		if !listed[project.ID] {
			removed = append(removed, project.ID)
		}
	}
	// The window first stores the plane of its active project that the store still lists, as readProjects of the page does before
	// it cleans up after the removed projects: the tabs of that plane are kept with the stored layout.
	if len(removed) > 0 && listed[s.active] {
		s.keep()
	}
	for _, id := range removed {
		s.dropProject(id)
	}
	s.takeOpen(snapshot.Open)
	s.options.Invalidate()
	// The window lists the projects of the store in the order of the store, as readProjects of the page does: a project that this
	// window never read is its stored record, and one that it read takes the stored record or its plugin data (takeStored).
	next := make([]projectRecord, 0, len(reads))
	for _, read := range reads {
		project := s.project(read.ID)
		if project == nil {
			next = append(next, read)
			continue
		}
		taken, err := s.takeStored(project, read)
		if err != nil {
			return err
		}
		next = append(next, taken)
	}
	s.projects = next
	return nil
}

// takeStored is the record that this window lists for a project that it read, after the store gave the stored record read, and
// reports each key of plugin data that changed.
func (s *Shell) takeStored(project *projectRecord, read projectRecord) (projectRecord, error) {
	// The read stands before a write of this window that the record already holds. The host answers that write with this event again.
	if s.surfaces.dataWrites[read.ID] > 0 {
		return *project, nil
	}
	before, err := storedPlugins(project)
	if err != nil {
		return *project, err
	}
	now, err := storedPlugins(&read)
	if err != nil {
		return *project, err
	}
	// The window keeps the spaces of a project that it holds, which it writes itself; every other project takes its stored record,
	// which another window or another environment may have changed, as readProjects of the page does.
	if !s.windowProjects[read.ID] {
		*project = read
	} else if stored, ok := read.Rest["plugins"]; ok {
		if project.Rest == nil {
			project.Rest = map[string]json.RawMessage{}
		}
		project.Rest["plugins"] = stored
	} else {
		delete(project.Rest, "plugins")
	}
	for _, changed := range changedKeys(before, now) {
		s.dataChanged(project.ID, changed[0], changed[1])
	}
	return *project, nil
}

// changedKeys returns each plugin and key whose stored value differs, in a stable order.
func changedKeys(before, now map[string]map[string]json.RawMessage) [][2]string {
	changed := [][2]string{}
	for _, side := range []map[string]map[string]json.RawMessage{before, now} {
		for plugin, keys := range side {
			for key := range keys {
				pair := [2]string{plugin, key}
				if !slices.Contains(changed, pair) && !sameJSON(before[plugin][key], now[plugin][key]) {
					changed = append(changed, pair)
				}
			}
		}
	}
	slices.SortFunc(changed, func(a, b [2]string) int { return slices.Compare(a[:], b[:]) })
	return changed
}

// sameJSON tells whether two stored values are the same JSON value, whatever the white space and the order of their members.
func sameJSON(a, b json.RawMessage) bool {
	if len(a) == 0 || len(b) == 0 {
		return len(a) == len(b)
	}
	var left, right any
	if json.Unmarshal(a, &left) != nil || json.Unmarshal(b, &right) != nil {
		return bytes.Equal(a, b)
	}
	first, _ := json.Marshal(left)   // silent: a value that json decoded encodes again.
	second, _ := json.Marshal(right) // silent: a value that json decoded encodes again.
	return bytes.Equal(first, second)
}
