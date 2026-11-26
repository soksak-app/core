package workbench

import (
	"bytes"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	sok "github.com/soksak-app/core/packages/sok/go/src"
)

// The plugins that a window loaded, read from the document of the installed plugins: what the settings window and the menus show
// of them, and the settings that they declare (docs/spec/plugins.md#pluginjson).

// PluginMenuItem is an item of the context menu that a surface declares.
type PluginMenuItem struct {
	Command string `json:"command"`
	Title   string `json:"title"`
}

// declaredSetting is a member of the settings of plugin.json.
type declaredSetting struct {
	Local       string
	Type        string   `json:"type"`
	Label       string   `json:"label"`
	Description string   `json:"description"`
	Values      []string `json:"values"`
	Minimum     float64  `json:"minimum"`
	Maximum     float64  `json:"maximum"`
	MaxLength   int      `json:"maxLength"`
	Default     any      `json:"default"`
	Category    string   `json:"category"`
}

// declaredSettings keeps the members of the settings of plugin.json in their order, which is the order of the rows of the plugin.
type declaredSettings []declaredSetting

// UnmarshalJSON reads the members in document order.
func (d *declaredSettings) UnmarshalJSON(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	if _, err := decoder.Token(); err != nil {
		return err
	}
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return err
		}
		item := declaredSetting{Local: key.(string)} // A member name of an object is a string.
		if err := decoder.Decode(&item); err != nil {
			return err
		}
		*d = append(*d, item)
	}
	return nil
}

// readLoadedPlugins returns the plugins of the installed document in id order and their setting definitions, in which a value of
// the settings of the environment declaration replaces the default of the plugin.
func readLoadedPlugins(installed, environment []byte) ([]LoadedPlugin, []SettingDefinition, error) {
	var document struct {
		Plugins []struct {
			ID       string `json:"id"`
			Version  string `json:"version"`
			Manifest struct {
				Name        string `json:"name"`
				Description string `json:"description"`
				Mark        string `json:"mark"`
				Icon        string `json:"icon"`
				Preview     *struct {
					Ink string `json:"ink"`
				} `json:"preview"`
				Surface *struct {
					Composition *struct {
						Kind string `json:"kind"`
					} `json:"composition"`
					Menu   []PluginMenuItem `json:"menu"`
					Save   string           `json:"save"`
					Params any              `json:"params"`
				} `json:"surface"`
				Dependencies map[string]string `json:"dependencies"`
				Sections     []struct {
					ID   string `json:"id"`
					Name string `json:"name"`
				} `json:"sections"`
				Settings   declaredSettings `json:"settings"`
				Categories []string         `json:"categories"`
			} `json:"manifest"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(installed, &document); err != nil {
		return nil, nil, fmt.Errorf("installed plugins: %w", err)
	}
	var declared struct {
		Settings map[string]map[string]any `json:"settings"`
	}
	if err := json.Unmarshal(environment, &declared); err != nil {
		return nil, nil, fmt.Errorf("environment declaration: %w", err)
	}
	var plugins []LoadedPlugin
	var definitions []SettingDefinition
	for _, entry := range document.Plugins {
		plugin := LoadedPlugin{ID: entry.ID, Name: entry.Manifest.Name, Description: entry.Manifest.Description, Mark: entry.Manifest.Mark,
			Icon: entry.Manifest.Icon, Surface: entry.Manifest.Surface != nil, Version: entry.Version, Dependencies: entry.Manifest.Dependencies,
			Categories: entry.Manifest.Categories}
		if entry.Manifest.Preview != nil {
			plugin.Ink = entry.Manifest.Preview.Ink
		}
		if entry.Manifest.Surface != nil {
			plugin.Menu, plugin.Save = entry.Manifest.Surface.Menu, entry.Manifest.Surface.Save
			plugin.Params = entry.Manifest.Surface.Params
			if composition := entry.Manifest.Surface.Composition; composition != nil {
				plugin.Composition = &composition.Kind
			}
		}
		for _, section := range entry.Manifest.Sections {
			plugin.Sections = append(plugin.Sections, LoadedSection{ID: section.ID, Name: section.Name})
		}
		plugins = append(plugins, plugin)
		for _, item := range entry.Manifest.Settings {
			definition := SettingDefinition{Key: entry.ID + "." + item.Local, Plugin: entry.ID, Type: item.Type, Label: item.Label,
				Description: item.Description, Values: item.Values, Minimum: item.Minimum, Maximum: item.Maximum, MaxLength: item.MaxLength,
				Default: item.Default, Category: item.Category}
			if value, ok := declared.Settings[entry.ID][item.Local]; ok {
				definition.Default = value
			}
			definitions = append(definitions, definition)
		}
	}
	slices.SortStableFunc(plugins, func(a, b LoadedPlugin) int { return strings.Compare(a.ID, b.ID) })
	return plugins, definitions, nil
}

// dropRequirers removes each plugin of the installed document that requires a category which no other plugin of the document serves,
// and repeats the check until no plugin is removed, because a removed plugin serves no category. It returns the document of the plugins
// that remain and the category that each removed plugin requires, by plugin id (docs/spec/plugins.md#plugin-categories).
func dropRequirers(document []byte) ([]byte, map[string]string, error) {
	var read struct {
		Plugins []json.RawMessage `json:"plugins"`
	}
	if err := json.Unmarshal(document, &read); err != nil {
		return nil, nil, fmt.Errorf("installed plugins: %w", err)
	}
	type entry struct {
		id               string
		raw              json.RawMessage
		serves, requires []string
	}
	entries := make([]entry, 0, len(read.Plugins))
	for _, raw := range read.Plugins {
		var head struct {
			ID       string         `json:"id"`
			Manifest map[string]any `json:"manifest"`
		}
		if err := json.Unmarshal(raw, &head); err != nil {
			return nil, nil, fmt.Errorf("installed plugins: %w", err)
		}
		serves, requires, err := sok.ManifestCategories(head.Manifest)
		if err != nil {
			return nil, nil, err
		}
		entries = append(entries, entry{id: head.ID, raw: raw, serves: serves, requires: requires})
	}
	missing := map[string]string{}
	for {
		served := map[string]bool{}
		for _, e := range entries {
			if _, gone := missing[e.id]; !gone {
				for _, category := range e.serves {
					served[category] = true
				}
			}
		}
		removed := false
		for _, e := range entries {
			if _, gone := missing[e.id]; gone {
				continue
			}
			for _, category := range e.requires {
				if !served[category] {
					missing[e.id] = category
					removed = true
					break
				}
			}
		}
		if !removed {
			break
		}
	}
	kept := []json.RawMessage{}
	for _, e := range entries {
		if _, gone := missing[e.id]; !gone {
			kept = append(kept, e.raw)
		}
	}
	encoded, err := json.Marshal(map[string]any{"plugins": kept})
	if err != nil {
		return nil, nil, err
	}
	return encoded, missing, nil
}

// categoryPlugin is a plugin of a plugin category in the status core.plugin-categories.
type categoryPlugin struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// categoryStatus returns the status core.plugin-categories: each plugin category of core with the loaded plugins that serve it, in the
// order of plugins, which is the order of their ids (docs/spec/plugins.md#plugin-categories).
func categoryStatus(plugins []LoadedPlugin) map[string][]categoryPlugin {
	status := map[string][]categoryPlugin{}
	for _, category := range sok.PluginCategories() {
		status[category] = []categoryPlugin{}
	}
	for _, plugin := range plugins {
		for _, category := range plugin.Categories {
			status[category] = append(status[category], categoryPlugin{ID: plugin.ID, Name: plugin.Name})
		}
	}
	return status
}
