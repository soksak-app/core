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

// HeldSidecar is a persistent sidecar whose live service holds a plugin operation: Planned is the version that the operation
// plans, and Running the version that the service runs, nil when the caller does not read it.
type HeldSidecar struct {
	Sidecar string  `json:"sidecar"`
	Planned string  `json:"planned"`
	Running *string `json:"running"`
}

// Held is a held plugin operation: the plugin, its planned version, the sidecars whose services hold it in name order and the
// error of the hold, which names the first (docs/spec/persistent-services.md#updates).
type Held struct {
	Plugin   string
	Version  string
	Sidecars []HeldSidecar
	Error    string
}

// Running is what a plugin operation knows of the running services. End ends the services of a held operation after the releases
// are extracted and before installed.json is written; a nil End holds the operation before it extracts anything, and Held, when it
// is set, receives the held operation before the operation fails with its error.
type Running struct {
	Services Services
	End      func(held Held) error
	Held     func(held Held)
}

// recordedVersions holds the version that state records for each sidecar, read before a plan changes state.
func recordedVersions(state *InstalledState) map[string]string {
	versions := make(map[string]string, len(state.Sidecars))
	for name, sidecar := range state.Sidecars {
		versions[name] = sidecar.Version
	}
	return versions
}

// heldBy returns the operation of plugin id that leads to the planned state when a live service holds it, and nil otherwise: the
// service of a persistent sidecar that an enabled plugin of state names holds it when it runs another version than state plans,
// or, for a service whose version is not read, when the planned version differs from the version that recorded holds.
func heldBy(id string, state *InstalledState, recorded map[string]string, services Services) *Held {
	named := map[string]bool{}
	for _, plugin := range state.Plugins {
		if !plugin.Enabled {
			continue
		}
		for name := range plugin.Sidecars {
			named[name] = true
		}
	}
	var sidecars []HeldSidecar
	for _, name := range slices.Sorted(maps.Keys(named)) {
		running, live := services[name]
		if !live {
			continue
		}
		planned := state.Sidecars[name].Version
		if running != nil && *running == planned || running == nil && recorded[name] == planned {
			continue
		}
		sidecars = append(sidecars, HeldSidecar{Sidecar: name, Planned: planned, Running: running})
	}
	if len(sidecars) == 0 {
		return nil
	}
	first := sidecars[0]
	shown := "unknown"
	if first.Running != nil {
		shown = *first.Running
	}
	version := state.Plugins[id].Version
	return &Held{Plugin: id, Version: version, Sidecars: sidecars, Error: fmt.Sprintf(
		"plugin %s %s: sidecar %s %s waits for the end of its running service %s", id, version, first.Sidecar, first.Planned, shown)}
}

// endHeld ends the services of a held operation through running.End before the planned state is written, or, without an End, gives
// the operation to running.Held and returns the error of the hold.
func endHeld(held *Held, running Running) error {
	if held == nil {
		return nil
	}
	if running.End != nil {
		return running.End(*held)
	}
	if running.Held != nil {
		running.Held(*held)
	}
	return errors.New(held.Error)
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
