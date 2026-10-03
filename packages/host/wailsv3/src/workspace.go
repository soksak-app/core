// 공통 설정, 프로젝트 설정과 프로젝트 레지스트리 저장.

package host

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// Workspace 는 설정 디렉터리의 projects.json 과 settings.json, 각 프로젝트의
// .soksak/settings.json 을 읽고 쓴다.
type Workspace struct {
	mu        sync.Mutex
	directory string
}

// PrepareConfigDirectory 는 저장소와 서비스가 함께 사용하는 설정 디렉터리를 생성하고 정규화한다.
func PrepareConfigDirectory(path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("config directory is required")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(absolute, 0o700); err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(absolute)
}

// NewWorkspace 는 설정 디렉터리 directory 의 저장소를 반환한다.
func NewWorkspace(directory string) *Workspace {
	return &Workspace{directory: directory}
}

// Record 는 JSON 객체 하나다.
type Record map[string]any

// WorkspaceRequest 는 저장소 작업 하나다. Kind 는 snapshot, add, patch, remove, move, settings 중 하나다.
type WorkspaceRequest struct {
	Kind    string   `json:"kind"`
	ID      string   `json:"id"`
	Project Record   `json:"project"`
	Patch   Record   `json:"patch"`
	Remove  []string `json:"remove"`
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
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
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

// Apply 는 작업 req 를 수행하고 그 결과를 반환한다.
// Directory 는 이 저장소의 설정 디렉터리를 반환한다.
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
			if err := readJSON(path, &settings); err != nil {
				return nil, err
			}
			if _, has := settings["projectOpening"]; has {
				return nil, fmt.Errorf("%s: projectOpening is common-only", path)
			}
			p["settings"] = settings
		}
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
			if _, has := req.Patch["projectOpening"]; has {
				return nil, fmt.Errorf("projectOpening is common-only")
			}
			path = filepath.Join(projects[at]["root"].(string), ".soksak", "settings.json")
		}
		settings := Record{}
		if err := readJSON(path, &settings); err != nil {
			return nil, err
		}
		for key, value := range req.Patch {
			settings[key] = value
		}
		for _, key := range req.Remove {
			delete(settings, key)
		}
		return nil, writeJSON(path, settings)
	default:
		return nil, fmt.Errorf("unknown workspace operation: %s", req.Kind)
	}
	return true, writeJSON(registry, projects)
}

// Workspace 는 저장소 작업을 수행한다. add 는 프로젝트 폴더를 확인해 저장하고, snapshot 은
// 열린 프로젝트 id 를 함께 반환하고, 나머지 작업은 모든 창에 workspace-changed 를 발행한다.
func (h *Host) Workspace(req WorkspaceRequest) (any, error) {
	if req.Kind == "add" {
		root, ok := req.Project["root"].(string)
		if !ok {
			return nil, fmt.Errorf("invalid project root")
		}
		folder, err := h.ProjectFolder(root)
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
