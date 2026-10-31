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

// WorkspaceRequest is one storage operation. Kind is one of snapshot, add, patch, remove, move, settings, tabState,
// tabStatePut, tabSession, tabSessionPut, and tabSessions.
type WorkspaceRequest struct {
	Kind    string   `json:"kind"`
	ID      string   `json:"id,omitempty"`
	Project Record   `json:"project,omitempty"`
	Patch   Record   `json:"patch,omitempty"`
	Remove  []string `json:"remove,omitempty"`
	Delta   *int     `json:"delta"`
	Tab     string   `json:"tab,omitempty"`
	Entry   Record   `json:"entry,omitempty"`
	Regions Record   `json:"regions,omitempty"`
}

// readProjects reads the projects of projects.json, which holds them under the `projects` member beside the format
// member of the stored form (docs/spec/installation.md#stored-data-formats).
// projectSettings reads the overrides of the project settings file at path; a missing file holds no override.
func projectSettings(path string) (Record, error) {
	settings, err := readStored(path, "settings.json", settingsFormat)
	if err != nil {
		return nil, err
	}
	if settings == nil {
		settings = Record{}
	}
	for _, key := range commonOnly {
		if _, has := settings[key]; has {
			return nil, fmt.Errorf("%s: %s is common-only", path, key)
		}
	}
	// The format member is the carrier of the stored form, not a setting, so the snapshot does not show it
	// (docs/spec/installation.md#stored-data-formats).
	delete(settings, "format")
	return settings, nil
}

// checkProjects returns the error that names projects.json when a record has no valid id, root or identity.
func checkProjects(registry string, projects []Record) error {
	for _, p := range projects {
		id, idOK := p["id"].(string)
		root, rootOK := p["root"].(string)
		identity, identityOK := p["identity"].(string)
		if !idOK || !validProjectID(id) || !rootOK || root == "" || !identityOK || identity == "" {
			return fmt.Errorf("%s: invalid project record", registry)
		}
	}
	return nil
}

// snapshot returns the project list with the settings of each project, and the common settings. A refused projects.json is
// reported as projectsError with no project and a refused settings.json as settingsError with no common setting, so the page
// starts and shows each error; every write reads the file again and fails with its error without changing it
// (docs/spec/projects.md#settings).
func snapshot(directory string, projects []Record, projectsErr error) (Record, error) {
	document := Record{}
	if projectsErr != nil {
		document["projectsError"] = projectsErr.Error()
		projects = []Record{}
	}
	common, err := readStored(filepath.Join(directory, "settings.json"), "settings.json", settingsFormat)
	if err != nil {
		document["settingsError"] = err.Error()
		common = nil
	}
	if common == nil {
		// default: a missing or refused settings.json holds no common settings.
		common = Record{}
	}
	for _, p := range projects {
		root, ok := p["root"].(string)
		if !ok {
			return nil, fmt.Errorf("invalid project root")
		}
		// A project settings file that is refused is reported at its project, which the page does not open, so the other
		// projects and the page start (docs/spec/projects.md#settings).
		settings, err := projectSettings(filepath.Join(root, ".soksak", "settings.json"))
		if err != nil {
			p["settingsError"] = err.Error()
			continue
		}
		p["settings"] = settings
	}
	// The format member is the carrier of the stored form, not a setting, so the snapshot does not show it
	// (docs/spec/installation.md#stored-data-formats).
	delete(common, "format")
	document["projects"] = projects
	document["common"] = common
	return document, nil
}

func readProjects(path string) ([]Record, error) {
	document, err := readStored(path, "projects.json", projectsFormat)
	if err != nil || document == nil {
		return []Record{}, err
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

// projectsFormat and settingsFormat are the current format numbers of the stored files that the host writes
// (docs/spec/installation.md#stored-data-formats).
const (
	projectsFormat = 1
	settingsFormat = 1
)

// writeProjects writes the projects under the `projects` member with the format member of the current form.
func writeProjects(path string, projects []Record) error {
	return writeJSON(path, Record{"format": projectsFormat, "projects": projects})
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

// readStored reads a stored file that carries its format in the member format. A missing file reads as nil. A file that is
// not an object, or whose format member is absent or another number, is refused with the file and the number it requires
// (docs/spec/installation.md#stored-data-formats).
func readStored(path, name string, format int) (Record, error) {
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return nil, nil
	}
	var value any
	if err := readJSON(path, &value); err != nil {
		return nil, err
	}
	document, ok := value.(map[string]any)
	if !ok {
		return nil, formatMustBe(path, name, format)
	}
	if number, held := document["format"].(float64); !held || number != float64(format) {
		return nil, formatMustBe(path, name, format)
	}
	return Record(document), nil
}

// formatMustBe is the refusal of a stored file whose format is not the number that its contract requires.
func formatMustBe(path, name string, format int) error {
	return fmt.Errorf("%s: %s: format must be %d", path, name, format)
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
	document, err := readStored(path, "tab-state.json", tabStateFormat)
	if err != nil || document == nil {
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
	document, err := readStored(path, "tab-state.json", tabStateFormat)
	if err != nil {
		return nil, err
	}
	tabs := map[string]any{}
	if document != nil {
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

// tabSessionFormat is the format of tab-sessions/<tab>.json, the session history of the document regions of one tab
// (docs/spec/projects.md#persistence).
const tabSessionFormat = 1

// tabSessionPath returns the session file of tab in directory, or an error for a tab that is not an identifier.
func tabSessionPath(directory, tab string) (string, error) {
	if tab == "" {
		return "", errors.New("tab session requires a tab")
	}
	if !validProjectID(tab) {
		return "", fmt.Errorf("invalid tab session tab: %s", tab)
	}
	return filepath.Join(directory, "tab-sessions", tab+".json"), nil
}

// readTabSession returns the document of the session file of tab, or nil when the file does not exist; a document of
// another format or without a regions object is refused with the path of the file.
func readTabSession(directory, tab string) (any, error) {
	path, err := tabSessionPath(directory, tab)
	if err != nil {
		return nil, err
	}
	document, err := readStored(path, "tab-sessions/"+tab+".json", tabSessionFormat)
	if err != nil || document == nil {
		return nil, err
	}
	if _, ok := document["regions"].(map[string]any); !ok {
		return nil, fmt.Errorf("%s: tab session regions is not an object", path)
	}
	return document, nil
}

// putTabSession replaces the session file of tab with regions and returns the size of the written file, or removes the
// file and returns nil when regions is nil. Each tab has its own file, so a put rewrites no other tab.
func putTabSession(directory, tab string, regions Record) (any, error) {
	path, err := tabSessionPath(directory, tab)
	if err != nil {
		return nil, err
	}
	if regions == nil {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return nil, err
		}
		return nil, nil
	}
	if len(regions) == 0 {
		return nil, fmt.Errorf("invalid tab session of %s: empty", tab)
	}
	names := make([]string, 0, len(regions))
	for name := range regions {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		region, ok := regions[name].(map[string]any)
		session, isText := region["session"].(string)
		if !ok || len(region) != 1 || !isText || session == "" {
			return nil, fmt.Errorf("invalid tab session region of %s: %s", tab, name)
		}
	}
	if err := writeJSON(path, Record{"format": tabSessionFormat, "regions": regions}); err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	return int(info.Size()), nil
}

// listTabSessions returns the tabs that have a session file, in name order; an absent directory has none.
func listTabSessions(directory string) (any, error) {
	files, err := os.ReadDir(filepath.Join(directory, "tab-sessions"))
	if os.IsNotExist(err) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	tabs := []string{}
	for _, file := range files {
		tab, ok := strings.CutSuffix(file.Name(), ".json")
		if ok && !file.IsDir() && validProjectID(tab) {
			tabs = append(tabs, tab)
		}
	}
	return tabs, nil
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
	case "tabSession":
		return readTabSession(w.directory, req.Tab)
	case "tabSessionPut":
		return putTabSession(w.directory, req.Tab, req.Regions)
	case "tabSessions":
		return listTabSessions(w.directory)
	}
	registry := filepath.Join(w.directory, "projects.json")
	// The file holds the projects under the `projects` member beside the format member (docs/spec/installation.md#stored-data-formats).
	projects, err := readProjects(registry)
	if err == nil {
		err = checkProjects(registry, projects)
	}
	if req.Kind == "snapshot" {
		return snapshot(w.directory, projects, err)
	}
	if err != nil {
		return nil, err
	}
	at := -1
	for i, p := range projects {
		if p["id"] == req.ID {
			at = i
			break
		}
	}
	switch req.Kind {
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
		settings, err := readStored(path, "settings.json", settingsFormat)
		if err != nil {
			return nil, err
		}
		if settings == nil {
			settings = Record{}
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
		settings["format"] = settingsFormat
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
		case "tabState", "tabStatePut", "tabSession", "tabSessionPut", "tabSessions":
			// The tab state store and the tab sessions change no project or setting, so no window is notified.
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
