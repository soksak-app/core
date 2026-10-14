// Storage of the common settings, the project settings and the project registry.

package host

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// Workspace reads and writes projects.json and settings.json of the configuration directory and the
// .soksak/settings.json of each project.
type Workspace struct {
	mu        sync.Mutex
	directory string
}

// PrepareConfigDirectory creates and normalizes the configuration directory that the storage and the service use together.
func PrepareConfigDirectory(path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("config directory is required")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	system, err := platform.Current()
	if err != nil {
		return "", err
	}
	if err := system.CreatePrivateDirectories(absolute); err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(absolute)
}

// NewWorkspace returns the storage of the configuration directory directory.
func NewWorkspace(directory string) *Workspace {
	return &Workspace{directory: directory}
}

// Record is one JSON object.
type Record map[string]any

// commonOnly are the common settings that the project settings cannot override (docs/spec/projects.md#persistence). The host sets the window title bar before the page starts
// from textSize of the common settings (docs/spec/native-surfaces.md#title-bar-height).
var commonOnly = []string{"projectOpening", "textSize"}

// WorkspaceRequest is one storage operation. Kind is one of snapshot, add, patch, remove, move, and settings.
type WorkspaceRequest struct {
	Kind    string   `json:"kind"`
	ID      string   `json:"id,omitempty"`
	Project Record   `json:"project,omitempty"`
	Patch   Record   `json:"patch,omitempty"`
	Remove  []string `json:"remove,omitempty"`
	Delta   *int     `json:"delta"`
}

func readJSON(path string, into any) error {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return fmt.Errorf("%s: expected JSON object or array", path)
	}
	if err = json.Unmarshal(data, into); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	return nil
}

func writeJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	system, err := platform.Current()
	if err != nil {
		return err
	}
	if err = system.CreatePrivateDirectories(filepath.Dir(path)); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".settings-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(append(data, '\n')); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(file.Name(), path)
}

// Apply performs the operation req and returns its result.
// Directory returns the configuration directory of this storage.
func (w *Workspace) Directory() string {
	return w.directory
}

func (w *Workspace) Apply(req WorkspaceRequest) (any, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	registry := filepath.Join(w.directory, "projects.json")
	projects := []Record{}
	if err := readJSON(registry, &projects); err != nil {
		return nil, err
	}
	for _, p := range projects {
		id, idOK := p["id"].(string)
		root, rootOK := p["root"].(string)
		identity, identityOK := p["identity"].(string)
		if !idOK || !validProjectID(id) || !rootOK || root == "" || !identityOK || identity == "" {
			return nil, fmt.Errorf("%s: invalid project record", registry)
		}
	}
	at := -1
	for i, p := range projects {
		if p["id"] == req.ID {
			at = i
			break
		}
	}
	switch req.Kind {
	case "snapshot":
		common := Record{}
		// The entry of the shared reader of settings.json migrates it to the current format first
		// (docs/spec/installation.md#stored-data-migration).
		if _, err := sok.MigrateSettings(w.directory); err != nil {
			return nil, err
		}
		if err := readJSON(filepath.Join(w.directory, "settings.json"), &common); err != nil {
			return nil, err
		}
		for _, p := range projects {
			settings := Record{}
			root, ok := p["root"].(string)
			if !ok {
				return nil, fmt.Errorf("invalid project root")
			}
			path := filepath.Join(root, ".soksak", "settings.json")
			// The project settings file migrates at its first read like the common one.
			if _, err := sok.MigrateSettings(filepath.Dir(path)); err != nil {
				return nil, err
			}
			if err := readJSON(path, &settings); err != nil {
				return nil, err
			}
			for _, key := range commonOnly {
				if _, has := settings[key]; has {
					return nil, fmt.Errorf("%s: %s is common-only", path, key)
				}
			}
			delete(settings, "format")
			p["settings"] = settings
		}
		// The format member is the carrier of the stored form, not a setting, so the snapshot does not show it
		// (docs/spec/installation.md#stored-data-migration).
		delete(common, "format")
		return Record{"projects": projects, "common": common}, nil
	case "add":
		for _, p := range projects {
			if p["root"] == req.Project["root"] || p["identity"] == req.Project["identity"] {
				return p, nil
			}
		}
		delete(req.Project, "settings")
		projects = append(projects, req.Project)
		if err := writeJSON(registry, projects); err != nil {
			return nil, err
		}
		return req.Project, nil
	case "patch":
		if at < 0 {
			return false, nil
		}
		for key, value := range req.Patch {
			switch key {
			case "title", "color", "spaces", "activeSpaceId", "named", "geometry", "pinned", "lastOpened", "plugins":
				projects[at][key] = value
			default:
				return nil, fmt.Errorf("invalid project field: %s", key)
			}
		}
	case "remove":
		if at < 0 {
			return nil, nil
		}
		projects = append(projects[:at], projects[at+1:]...)
	case "move":
		if at < 0 {
			return nil, nil
		}
		if req.Delta == nil {
			return nil, errors.New("move delta is missing")
		}
		to := at + *req.Delta
		if to < 0 || to >= len(projects) {
			return nil, nil
		}
		project := projects[at]
		projects = append(projects[:at], projects[at+1:]...)
		projects = append(projects, nil)
		copy(projects[to+1:], projects[to:])
		projects[to] = project
	case "settings":
		path := filepath.Join(w.directory, "settings.json")
		if req.ID != "" {
			if at < 0 {
				return nil, fmt.Errorf("unknown project: %s", req.ID)
			}
			for _, key := range commonOnly {
				if _, has := req.Patch[key]; has {
					return nil, fmt.Errorf("%s is common-only", key)
				}
			}
			path = filepath.Join(projects[at]["root"].(string), ".soksak", "settings.json")
		}
		settings := Record{}
		if err := readJSON(path, &settings); err != nil {
			return nil, err
		}
		set := make([]string, 0, len(req.Patch))
		for key, value := range req.Patch {
			settings[key] = value
			set = append(set, key)
		}
		var removed []string
		for _, key := range req.Remove {
			if _, has := settings[key]; has {
				delete(settings, key)
				removed = append(removed, key)
			}
		}
		if err := writeJSON(path, settings); err != nil {
			return nil, err
		}
		scope := "common"
		if req.ID != "" {
			scope = req.ID
		}
		sort.Strings(set)
		sort.Strings(removed)
		EmitHost(LevelInfo, "host.workspace.settings", map[string]any{"scope": scope, "set": strings.Join(set, ","), "removed": strings.Join(removed, ",")})
		return nil, nil
	default:
		return nil, fmt.Errorf("unknown workspace operation: %s", req.Kind)
	}
	return true, writeJSON(registry, projects)
}

// Workspace performs the storage operations. add checks and stores the project folder, snapshot returns
// the open project ids together, and the other operations publish workspace-changed to all windows.
func (h *Host) Workspace(requestJSON json.RawMessage) (any, error) {
	req, err := argument[WorkspaceRequest]("request", requestJSON)
	if err != nil {
		return nil, err
	}
	return h.runWorkspace(req)
}

func (h *Host) runWorkspace(req WorkspaceRequest) (any, error) {
	if req.Kind == "add" {
		root, ok := req.Project["root"].(string)
		if !ok {
			return nil, fmt.Errorf("invalid project root")
		}
		folder, err := ResolveProjectFolder(root)
		if err != nil {
			return nil, err
		}
		req.Project["root"], req.Project["identity"] = folder.Root, folder.Identity
	}
	result, err := h.workspace.Apply(req)
	if err == nil {
		if req.Kind == "snapshot" {
			h.mu.Lock()
			ids := make([]string, 0, len(h.owners))
			for id := range h.owners {
				ids = append(ids, id)
			}
			h.mu.Unlock()
			result.(Record)["open"] = ids
		} else {
			h.notifyWorkspace()
		}
	}
	return result, err
}
