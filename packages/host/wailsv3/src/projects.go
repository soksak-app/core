// 프로젝트 폴더 확인, 폴더 선택, 프로젝트 생성과 프로젝트 열기.

package host

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/min-median-max/soksak/packages/host/wailsv3/src/platform"
)

type ProjectFolder struct {
	Root     string `json:"root"`
	Identity string `json:"identity"`
}

// ProjectFolder 는 root 의 실제 경로와 디렉터리 식별자를 반환한다.
func (h *Host) ProjectFolder(root string) (ProjectFolder, error) {
	return ResolveProjectFolder(root)
}

// ResolveProjectFolder 는 ~ 를 홈 디렉터리로 바꾸고 심볼릭 링크를 따라간 디렉터리 root 의
// 실제 경로와 디렉터리 식별자를 반환한다. root 가 디렉터리가 아니면 실패한다.
func ResolveProjectFolder(root string) (ProjectFolder, error) {
	if strings.TrimSpace(root) == "" {
		return ProjectFolder{}, fmt.Errorf("project directory is empty")
	}
	if root == "~" || strings.HasPrefix(root, "~/") || strings.HasPrefix(root, "~\\") {
		home, err := os.UserHomeDir()
		if err != nil {
			return ProjectFolder{}, err
		}
		root = filepath.Join(home, strings.TrimLeft(root[1:], "/\\"))
	}
	path, err := filepath.Abs(root)
	if err != nil {
		return ProjectFolder{}, err
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		return ProjectFolder{}, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return ProjectFolder{}, err
	}
	if !info.IsDir() {
		return ProjectFolder{}, fmt.Errorf("not a project directory: %s", path)
	}
	current, err := platform.Current()
	if err != nil {
		return ProjectFolder{}, err
	}
	identity, err := current.DirectoryIdentity(path, info)
	return ProjectFolder{Root: path, Identity: identity}, err
}

type ProjectOpen struct {
	ID       string          `json:"id"`
	Root     string          `json:"root"`
	Title    string          `json:"title"`
	Separate bool            `json:"separate"`
	Geometry *WindowGeometry `json:"geometry"`
}
type ProjectOpened struct {
	Local bool `json:"local"`
}

func (h *Host) ProjectOpen(ctx context.Context, req ProjectOpen) (ProjectOpened, error) {
	current, err := h.surface(ctx)
	if err != nil {
		return ProjectOpened{}, err
	}
	if !validProjectID(req.ID) {
		return ProjectOpened{}, fmt.Errorf("invalid project id")
	}
	folder, err := h.ProjectFolder(req.Root)
	if err != nil {
		return ProjectOpened{}, err
	}
	h.opening.Lock()
	defer h.opening.Unlock()
	h.mu.Lock()
	owner := h.owners[req.ID]
	if owner != nil {
		local := owner == current
		owner.mu.Lock()
		owner.root = folder.Root
		owner.mu.Unlock()
		h.mu.Unlock()
		owner.setTitle(req.Title + titleSuffix)
		if !local {
			owner.Emit("project-activate", req.ID)
			owner.window.Show()
			owner.window.Focus()
		}
		return ProjectOpened{Local: local}, nil
	}
	separate := req.Separate && len(current.projects) > 0
	h.mu.Unlock()
	owner = current
	if separate {
		owner = h.newWindow("project-"+req.ID, "/?project="+req.ID)
	}
	h.mu.Lock()
	owner.projects[req.ID] = true
	owner.mu.Lock()
	owner.root = folder.Root
	owner.mu.Unlock()
	h.owners[req.ID] = owner
	h.mu.Unlock()
	owner.setTitle(req.Title + titleSuffix)
	if req.Geometry != nil && req.Geometry.Width > 0 && req.Geometry.Height > 0 {
		application.InvokeSync(func() {
			owner.window.SetSize(req.Geometry.Width, req.Geometry.Height)
			owner.window.SetPosition(req.Geometry.X, req.Geometry.Y)
			prepareWindow(owner.window)
		})
	}
	h.notifyWorkspace()
	return ProjectOpened{Local: owner == current}, nil
}

func validProjectID(id string) bool {
	if id == "" {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return true
}

func (h *Host) ProjectRelease(id string) {
	h.mu.Lock()
	if owner := h.owners[id]; owner != nil {
		delete(owner.projects, id)
	}
	delete(h.owners, id)
	h.mu.Unlock()
	h.notifyWorkspace()
}

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
