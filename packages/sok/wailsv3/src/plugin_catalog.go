package sok

// The classes of the events of the installed plugins (docs/spec/logging.md#plugin-catalogs). The class table generated from the
// core catalog declares no plugin event; each plugin declares its events in the catalog that the member events of its plugin.json
// names, and the writer gives a plugin event the class of that catalog.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// PluginEventClasses reads the catalogs of the enabled installed plugins and returns the class of each event they declare. A
// catalog that cannot be used is an error that names its file, and the other plugins keep their classes; the errors are in the
// order of the plugin ids.
func PluginEventClasses(configDir string) (map[string]Class, []error) {
	state, err := ReadInstalled(configDir)
	if err != nil {
		return map[string]Class{}, []error{err}
	}
	ids := make([]string, 0, len(state.Plugins))
	for id, plugin := range state.Plugins {
		if plugin.Enabled {
			ids = append(ids, id)
		}
	}
	slices.Sort(ids)
	classes := map[string]Class{}
	var errs []error
	for _, id := range ids {
		declared, err := pluginCatalogClasses(filepath.Join(configDir, state.Plugins[id].Path), id)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		for name, class := range declared {
			classes[name] = class
		}
	}
	return classes, errs
}

// pluginCatalogClasses reads the catalog that the plugin.json in folder names. A plugin without the member events declares no
// event.
func pluginCatalogClasses(folder, id string) (map[string]Class, error) {
	manifestPath := filepath.Join(folder, "plugin.json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, fmt.Errorf("%s: the manifest of plugin %s cannot be read", manifestPath, id)
	}
	var manifest struct {
		Events *string `json:"events"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, fmt.Errorf("%s: the manifest of plugin %s is not JSON", manifestPath, id)
	}
	if manifest.Events == nil {
		return map[string]Class{}, nil
	}
	path := filepath.Join(folder, filepath.FromSlash(*manifest.Events))
	data, err = os.ReadFile(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return nil, fmt.Errorf("%s: the event catalog of plugin %s does not exist", path, id)
	case err != nil:
		return nil, fmt.Errorf("%s: the event catalog of plugin %s cannot be read", path, id)
	}
	var catalog struct {
		Schema json.RawMessage `json:"schema"`
		Events map[string]struct {
			Class string `json:"class"`
		} `json:"events"`
	}
	if err := json.Unmarshal(data, &catalog); err != nil {
		return nil, fmt.Errorf("%s: the event catalog of plugin %s is not JSON", path, id)
	}
	var schema int
	if len(catalog.Schema) == 0 || json.Unmarshal(catalog.Schema, &schema) != nil || schema != 3 {
		found := "is missing"
		if len(catalog.Schema) != 0 {
			found = "is " + string(catalog.Schema)
		}
		return nil, fmt.Errorf("%s: event catalog schema %s; expected 3", path, found)
	}
	prefix := "plugin." + id + "."
	names := make([]string, 0, len(catalog.Events))
	for name := range catalog.Events {
		names = append(names, name)
	}
	slices.Sort(names)
	classes := map[string]Class{}
	for _, name := range names {
		if !strings.HasPrefix(name, prefix) || len(name) == len(prefix) {
			return nil, fmt.Errorf("%s: the event %s is not an event of plugin %s (plugin.%s.<event>)", path, name, id, id)
		}
		class := Class(catalog.Events[name].Class)
		if !slices.Contains(Classes, class) {
			return nil, fmt.Errorf("%s: the event %s has the class %s, which is not lifecycle, input, call, io or frame", path, name, class)
		}
		classes[name] = class
	}
	return classes, nil
}
