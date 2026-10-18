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

// WorkspaceRequest is one storage operation. Kind is one of snapshot, add, patch, remove, move, settings, tabState, and tabStatePut.
type WorkspaceRequest struct {
	Kind    string   `json:"kind"`
	ID      string   `json:"id,omitempty"`
	Project Record   `json:"project,omitempty"`
	Patch   Record   `json:"patch,omitempty"`
	Remove  []string `json:"remove,omitempty"`
	Delta   *int     `json:"delta"`
	Tab     string   `json:"tab,omitempty"`
	Entry   Record   `json:"entry,omitempty"`
}

// readProjects reads the projects of projects.json, which holds them under the `projects` member beside the format
// member of the stored form (docs/spec/installation.md#stored-data-migration).
func readProjects(path string) ([]Record, error) {
	document := Record{}
	if err := readJSON(path, &document); err != nil {
		return nil, err
	}
	projects := []Record{}
	if list, held := document["projects"].([]any); held {
		for _, item := range list {
			record, ok := item.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("%s: a project is not an object", path)
			}
			projects = append(projects, Record(record))
		}
	}
	return projects, nil
}

// writeProjects writes the projects under the `projects` member with the format member of the current form.
func writeProjects(path string, projects []Record) error {
	return writeJSON(path, Record{"format": sok.ProjectsFormat(), "projects": projects})
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

// tabStateFormat is the format of tab-state.json, the tab state store of the memory saver (docs/spec/projects.md#persistence).
const tabStateFormat = 1

// readTabState returns the document of tab-state.json as stored, or nil when the file does not exist; the page reader
// checks its format.
func readTabState(path string) (any, error) {
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return nil, nil
	}
	document := Record{}
	if err := readJSON(path, &document); err != nil {
		return nil, err
	}
	return document, nil
}

// putTabState sets the entry of tab, or removes it when entry is nil, in tab-state.json and returns the size of the
// written file. Each put changes one entry, so windows that write different tabs keep each other's entries.
func putTabState(path, tab string, entry Record) (any, error) {
	if tab == "" {
		return nil, errors.New("tab state put requires a tab")
	}
	if entry != nil {
		if err := checkTabStateEntry(tab, entry); err != nil {
			return nil, err
		}
	}
	document := Record{}
	if err := readJSON(path, &document); err != nil {
		return nil, err
	}
	tabs := map[string]any{}
	if len(document) > 0 {
		format, held := document["format"]
		if !held {
			return nil, fmt.Errorf("%s: tab state format missing is not %d", path, tabStateFormat)
		}
		if number, ok := format.(float64); !ok || number != tabStateFormat {
			found, err := json.Marshal(format)
			if err != nil {
				return nil, err
			}
			return nil, fmt.Errorf("%s: tab state format %s is not %d", path, found, tabStateFormat)
		}
		stored, ok := document["tabs"].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("%s: tab state tabs is not an object", path)
		}
		tabs = stored
	}
	if entry == nil {
		delete(tabs, tab)
	} else {
		tabs[tab] = entry
	}
	if err := writeJSON(path, Record{"format": tabStateFormat, "tabs": tabs}); err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	return int(info.Size()), nil
}

// checkTabStateEntry refuses an entry that is empty or holds a field other than state {format, value}, kept true and
// a label of 1 to 256 characters; the first invalid field in name order is named.
func checkTabStateEntry(tab string, entry Record) error {
	if len(entry) == 0 {
		return fmt.Errorf("invalid tab state entry of %s: empty", tab)
	}
	keys := make([]string, 0, len(entry))
	for key := range entry {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		value := entry[key]
		valid := false
		switch key {
		case "kept":
			valid = value == true
		case "label":
			text, ok := value.(string)
			valid = ok && text != "" && len([]rune(text)) <= 256
		case "state":
			if state, ok := value.(map[string]any); ok {
				_, hasValue := state["value"]
				valid = len(state) == 2 && hasValue && positiveInteger(state["format"])
			}
		}
		if !valid {
			return fmt.Errorf("invalid tab state entry of %s: %s", tab, key)
		}
	}
	return nil
}

// positiveInteger reports whether value, decoded from JSON or built by a caller, is a positive integer.
func positiveInteger(value any) bool {
	switch number := value.(type) {
	case float64:
		return number >= 1 && number == float64(int64(number))
	case int:
		return number >= 1
	}
	return false
}

// Directory returns the configuration directory of this storage.
func (w *Workspace) Directory() string {
	return w.directory
}

func (w *Workspace) Apply(req WorkspaceRequest) (any, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	switch req.Kind {
	case "tabState":
		return readTabState(filepath.Join(w.directory, "tab-state.json"))
	case "tabStatePut":
		return putTabState(filepath.Join(w.directory, "tab-state.json"), req.Tab, req.Entry)
	}
	registry := filepath.Join(w.directory, "projects.json")
	// The entry of the shared reader of projects.json migrates it to the current format first; the file holds the
	// projects under the `projects` member beside the format member (docs/spec/installation.md#stored-data-migration).
	if _, err := sok.MigrateProjects(w.directory); err != nil {
		return nil, err
	}
	projects, err := readProjects(registry)
	if err != nil {
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
		if err := writeProjects(registry, projects); err != nil {
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
	return true, writeProjects(registry, projects)
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
		switch req.Kind {
		case "tabState", "tabStatePut":
			// The tab state store changes no project or setting, so no window is notified.
		case "snapshot":
			h.mu.Lock()
			ids := make([]string, 0, len(h.owners))
			for id := range h.owners {
				ids = append(ids, id)
			}
			h.mu.Unlock()
			result.(Record)["open"] = ids
		default:
			h.notifyWorkspace()
		}
	}
	return result, err
}
