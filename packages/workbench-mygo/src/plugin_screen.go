package workbench

import (
	"errors"
	"regexp"
	"slices"
	"strconv"
)

// The plugin state of the settings tab (docs/spec/installation.md#plugin-state-and-commands). Its values are those of
// `core.plugins`, and it runs the plugin operations through their commands.

// PluginInstalled is what installed.json records of a plugin.
type PluginInstalled struct {
	Version string `json:"version"`
	Enabled bool   `json:"enabled"`
}

// PluginSidecar is a sidecar that a plugin names. Version and Range are nil when they are unknown.
type PluginSidecar struct {
	Name    string  `json:"name"`
	Range   *string `json:"range"`
	Version *string `json:"version"`
}

// PluginRow is an entry of `plugins` of `core.plugins`. Sidecars is nil for an incompatible plugin that is neither installed
// nor loaded.
type PluginRow struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	State       string `json:"state"`
	// Composition is the kind of the surface composition of a loaded plugin, and nil without one.
	Composition  *string          `json:"composition"`
	Installed    *PluginInstalled `json:"installed"`
	Latest       *string          `json:"latest"`
	Incompatible bool             `json:"incompatible"`
	Sidecars     []PluginSidecar  `json:"sidecars"`
}

// PluginOperation is `operation` of `core.plugins`.
type PluginOperation struct {
	Action string
	Plugin string
	State  string
	Error  string
}

// PluginUpdate is an entry of `updates` of `core.plugins`.
type PluginUpdate struct {
	ID        string `json:"id"`
	Installed string `json:"installed"`
	Latest    string `json:"latest"`
}

// OutdatedSidecar is an entry of `outdated` of `core.plugins`. Running is nil for a service that sent no version, and
// Installed is nil for a sidecar that is no longer declared.
type OutdatedSidecar struct {
	Sidecar   string  `json:"sidecar"`
	Running   *string `json:"running"`
	Installed *string `json:"installed"`
	Sessions  int     `json:"sessions"`
}

// PluginFailure is why the plugin state or the registry index could not be read. Kind is `state` or `index`.
type PluginFailure struct {
	Kind    string
	Message string
}

// AppVersion is the candidate of the application update.
type AppVersion struct {
	Version string
	Release string
}

// AppIncompatible is an installed plugin whose range does not contain the candidate. Compatible is nil without a version that does.
type AppIncompatible struct {
	ID         string
	Installed  string
	Range      string
	Compatible *string
}

// AppOperation is the running or failed application update. State is `staging`, `applying` or `failed`.
type AppOperation struct {
	Version string
	State   string
	Error   string
}

// AppUpdate is the state of the application update.
type AppUpdate struct {
	Version      string
	Available    *AppVersion
	Incompatible []AppIncompatible
	Operation    *AppOperation
	// Error is the failure of the last read of the candidate.
	Error string
}

var versionForm = regexp.MustCompile(`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$`)

func versionParts(version string) ([3]int, error) {
	var parts [3]int
	match := versionForm.FindStringSubmatch(version)
	if match == nil {
		return parts, errors.New("version " + version + " must be x.y.z with numeric parts and no leading zeros")
	}
	for i := range parts {
		number, err := strconv.Atoi(match[i+1])
		if err != nil {
			return parts, err
		}
		parts[i] = number
	}
	return parts, nil
}

// CompareVersions compares two versions by number, as compareVersions of @soksak/plugin-api does.
func CompareVersions(a, b string) (int, error) {
	left, err := versionParts(a)
	if err != nil {
		return 0, err
	}
	right, err := versionParts(b)
	if err != nil {
		return 0, err
	}
	return slices.Compare(left[:], right[:]), nil
}

func hasUpdate(row PluginRow) (bool, error) {
	if row.Installed == nil || row.Latest == nil {
		return false, nil
	}
	order, err := CompareVersions(*row.Latest, row.Installed.Version)
	return order > 0, err
}
