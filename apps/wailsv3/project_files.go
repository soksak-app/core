package main

import (
	"context"
	"fmt"
	"os"
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
	Parent string `json:"parent"`
	Name   string `json:"name"`
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
	return h.ProjectFolder(destination)
}
