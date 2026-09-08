package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

type Workspace struct {
	mu        sync.Mutex
	directory string
}
type Record map[string]any
type WorkspaceRequest struct {
	Kind    string   `json:"kind"`
	ID      string   `json:"id"`
	Project Record   `json:"project"`
	Patch   Record   `json:"patch"`
	Remove  []string `json:"remove"`
	Delta   int      `json:"delta"`
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
			case "title", "color", "spaces", "activeSpaceId", "named", "geometry", "pinned", "lastOpened":
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
		to := at + req.Delta
		if at < 0 || to < 0 || to >= len(projects) {
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
