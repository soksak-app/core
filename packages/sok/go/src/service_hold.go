package sok

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/soksak-app/core/packages/sok/go/src/platform"
)

// Services holds the version that the live service of each persistent sidecar runs, by sidecar name. A nil version is a service
// whose version the caller does not read, as on the command line (docs/spec/persistent-services.md#updates).
type Services map[string]*string

// Running is what a plugin operation knows of the running services. End ends the live services of the named sidecars, which hold
// the operation, after the releases are extracted and before installed.json is written; a nil End holds the operation.
type Running struct {
	Services Services
	End      func(sidecars []string) error
}

// recordedVersions holds the version that state records for each sidecar, read before a plan changes state.
func recordedVersions(state *InstalledState) map[string]string {
	versions := make(map[string]string, len(state.Sidecars))
	for name, sidecar := range state.Sidecars {
		versions[name] = sidecar.Version
	}
	return versions
}

// heldBy returns the sidecars, in name order, whose live service holds the operation of plugin id that leads to the planned
// state, with the error of the first: a persistent sidecar that an enabled plugin of state names and whose live service runs
// another version than state plans, or, for a service whose version is not read, a sidecar whose planned version differs from
// the version that recorded holds (docs/spec/persistent-services.md#updates).
func heldBy(id string, state *InstalledState, recorded map[string]string, services Services) ([]string, error) {
	named := map[string]bool{}
	for _, plugin := range state.Plugins {
		if !plugin.Enabled {
			continue
		}
		for name := range plugin.Sidecars {
			named[name] = true
		}
	}
	var held []string
	var first error
	for _, name := range slices.Sorted(maps.Keys(named)) {
		running, live := services[name]
		if !live {
			continue
		}
		planned := state.Sidecars[name].Version
		shown := "unknown"
		if running != nil {
			shown = *running
			if *running == planned {
				continue
			}
		} else if recorded[name] == planned {
			continue
		}
		held = append(held, name)
		if first == nil {
			first = fmt.Errorf("plugin %s %s: sidecar %s %s waits for the end of its running service %s",
				id, state.Plugins[id].Version, name, planned, shown)
		}
	}
	return held, first
}

// endHeld ends the services of held through running.End before the planned state is written, or returns the error of the hold
// when the operation has no End.
func endHeld(held []string, holding error, running Running) error {
	if len(held) == 0 {
		return nil
	}
	if running.End == nil {
		return holding
	}
	return running.End(held)
}

// LiveServices reads the live services of the persistent sidecars that state records: the service of a sidecar is live when the
// endpoint.json in services/<executable name> names the process that published it (docs/spec/persistent-services.md#updates).
// The command line reads no hello, so each version is nil.
func LiveServices(configDir string, state *InstalledState) (Services, error) {
	services := Services{}
	for _, name := range slices.Sorted(maps.Keys(state.Sidecars)) {
		folder := filepath.Join(configDir, state.Sidecars[name].Path)
		data, err := os.ReadFile(filepath.Join(folder, "sidecar.json"))
		if err != nil {
			return nil, fileError(filepath.Join(folder, "sidecar.json"), err)
		}
		var declaration struct {
			Executable string `json:"executable"`
			Transport  string `json:"transport"`
		}
		if json.Unmarshal(data, &declaration) != nil {
			return nil, fmt.Errorf("%s is not valid JSON", filepath.Join(folder, "sidecar.json"))
		}
		if declaration.Transport != "persistent" {
			continue
		}
		path := filepath.Join(configDir, "services", filepath.Base(declaration.Executable), "endpoint.json")
		live, err := endpointLive(path)
		if err != nil {
			return nil, fmt.Errorf("sidecar %s: %w", name, err)
		}
		if live {
			services[name] = nil
		}
	}
	return services, nil
}

// endpointLive reports whether the endpoint file at path names the process that published it. It reads the content and the
// modification time through one descriptor, so the time is the time of the content (docs/spec/persistent-services.md#endpoint-publisher).
func endpointLive(path string) (bool, error) {
	file, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fileError(path, err)
	}
	data, err := io.ReadAll(file)
	var published time.Time
	if err == nil {
		var info fs.FileInfo
		if info, err = file.Stat(); err == nil {
			published = info.ModTime()
		}
	}
	if err = errors.Join(err, file.Close()); err != nil {
		return false, fileError(path, err)
	}
	var endpoint struct {
		PID int `json:"pid"`
	}
	// The parser texts of encoding/json and serde_json differ, so the error names only the file.
	if json.Unmarshal(data, &endpoint) != nil {
		return false, fmt.Errorf("%s is not valid JSON", path)
	}
	current, err := platform.Current()
	if err != nil {
		return false, err
	}
	return current.ServiceProcessExists(endpoint.PID, published)
}
