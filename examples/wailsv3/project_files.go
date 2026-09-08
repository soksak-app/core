package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func (h *Host) FolderChoose(ctx context.Context) (string, error) {
	s, err := h.surface(ctx)
	if err != nil {
		return "", err
	}
	return application.Get().Dialog.OpenFile().CanChooseFiles(false).CanChooseDirectories(true).
		AttachToWindow(s.window).SetTitle("프로젝트 폴더 선택").PromptForSingleSelection()
}

type CreateProject struct {
	Parent     string `json:"parent"`
	Name       string `json:"name"`
	Repository string `json:"repository"`
}

func (h *Host) ProjectCreate(req CreateProject) (ProjectFolder, error) {
	parent, err := h.ProjectFolder(req.Parent)
	if err != nil {
		return ProjectFolder{}, err
	}
	name := strings.TrimSpace(req.Name)
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\\x00") {
		return ProjectFolder{}, fmt.Errorf("invalid project folder name")
	}
	destination := filepath.Join(parent.Root, name)
	if err := os.Mkdir(destination, 0755); err != nil {
		return ProjectFolder{}, err
	}
	if req.Repository != "" {
		cmd := exec.Command("git", "clone", "--", req.Repository, destination)
		cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
		if output, err := cmd.CombinedOutput(); err != nil {
			// 비어 있는 생성 폴더만 제거한다. 파일이 있는 폴더는 유지한다.
			_ = os.Remove(destination)
			return ProjectFolder{}, fmt.Errorf("git clone failed: %w: %s", err, strings.TrimSpace(string(output)))
		}
	}
	return h.ProjectFolder(destination)
}
