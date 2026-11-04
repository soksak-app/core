package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
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
	id := project.ID
	s.patchThen(id, map[string]any{"plugins": json.RawMessage(encoded)}, func() {
		kept := s.project(id)
		if kept == nil {
			answer(nil, errors.New("the project is gone"))
			return
		}
		kept.Rest["plugins"] = encoded
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
	answer(value, nil)
	return nil
}
