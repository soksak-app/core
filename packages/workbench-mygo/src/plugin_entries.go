package workbench

import (
	"bytes"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
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
				Surface     *struct {
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
				Settings declaredSettings `json:"settings"`
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
			Icon: entry.Manifest.Icon, Surface: entry.Manifest.Surface != nil, Version: entry.Version, Dependencies: entry.Manifest.Dependencies}
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
				Default: item.Default}
			if value, ok := declared.Settings[entry.ID][item.Local]; ok {
				definition.Default = value
			}
			definitions = append(definitions, definition)
		}
	}
	slices.SortStableFunc(plugins, func(a, b LoadedPlugin) int { return strings.Compare(a.ID, b.ID) })
	return plugins, definitions, nil
}
