// 프로젝트 폴더 확인, 폴더 선택, 프로젝트 생성과 프로젝트 열기.

package host

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

type ProjectFolder struct {
	Root     string `json:"root"`
	Identity string `json:"identity"`
}

// ProjectFolder 는 root 의 실제 경로와 디렉터리 식별자를 반환한다.
func (h *Host) ProjectFolder(rootJSON json.RawMessage) (ProjectFolder, error) {
	root, err := argument[string]("root", rootJSON)
	if err != nil {
		return ProjectFolder{}, err
	}
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
	requested := path
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		return ProjectFolder{}, folderError(requested, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		return ProjectFolder{}, folderError(requested, err)
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

// folderError 는 폴더를 확인하지 못한 오류를 요청한 경로 하나를 담은 계약 문구로 바꾼다. 두 호스트가 같은 문구를
// 낸다(docs/spec/host-contract.md 의 workspace.folder.messages).
func folderError(path string, err error) error {
	switch {
	case errors.Is(err, fs.ErrNotExist), errors.Is(err, syscall.ENOTDIR):
		return fmt.Errorf("project directory does not exist: %s", path)
	case errors.Is(err, fs.ErrPermission):
		return fmt.Errorf("project directory is not readable: %s", path)
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return fmt.Errorf("project directory cannot be resolved: %s (errno %d)", path, int(errno))
	}
	return fmt.Errorf("project directory cannot be resolved: %s: %w", path, err)
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

func (h *Host) ProjectOpen(ctx context.Context, reqJSON json.RawMessage) (ProjectOpened, error) {
	req, err := argument[ProjectOpen]("request", reqJSON)
	if err != nil {
		return ProjectOpened{}, err
	}
	current, err := h.surface(ctx)
	if err != nil {
		return ProjectOpened{}, err
	}
	if !validProjectID(req.ID) {
		return ProjectOpened{}, fmt.Errorf("invalid project id")
	}
	folder, err := ResolveProjectFolder(req.Root)
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
			// Wails 창 크기는 정수 논리 픽셀이므로 저장된 크기를 가장 가까운 정수로 둔다.
			owner.window.SetSize(int(math.Round(req.Geometry.Width)), int(math.Round(req.Geometry.Height)))
			owner.window.SetPosition(int(req.Geometry.X), int(req.Geometry.Y))
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

func (h *Host) ProjectRelease(idJSON json.RawMessage) error {
	id, err := argument[string]("id", idJSON)
	if err != nil {
		return err
	}
	h.mu.Lock()
	owner := h.owners[id]
	if owner != nil {
		delete(owner.projects, id)
	}
	delete(h.owners, id)
	empty := owner != nil && len(owner.projects) == 0
	h.mu.Unlock()
	// 프로젝트가 남지 않은 창은 라이브러리를 보이므로 프로젝트 root 와 제목을 비운다.
	if empty {
		owner.mu.Lock()
		owner.root = ""
		owner.mu.Unlock()
		owner.setTitle(windowTitle)
	}
	h.notifyWorkspace()
	return nil
}

// ProjectRemoveAsk asks the window that shows the project whether the project may be removed and returns its answer;
// it returns true at once when no other window shows the project (docs/spec/projects.md).
func (h *Host) ProjectRemoveAsk(ctx context.Context, idJSON json.RawMessage) (bool, error) {
	id, err := argument[string]("id", idJSON)
	if err != nil {
		return false, err
	}
	current, err := h.surface(ctx)
	if err != nil {
		return false, err
	}
	h.mu.Lock()
	owner := h.owners[id]
	h.mu.Unlock()
	if owner == nil || owner == current {
		return true, nil
	}
	asked, err := h.removals.Begin(id, owner.name)
	if err != nil {
		return false, err
	}
	owner.Emit("project-remove-request", id)
	return <-asked, nil
}

// ProjectRemoveAnswer answers the removal request that ProjectRemoveAsk sent to this window.
func (h *Host) ProjectRemoveAnswer(answerJSON json.RawMessage) error {
	answer, err := argument[struct {
		ID      string `json:"id"`
		Allowed bool   `json:"allowed"`
	}]("answer", answerJSON)
	if err != nil {
		return err
	}
	return h.removals.Answer(answer.ID, answer.Allowed)
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

func (h *Host) ProjectCreate(reqJSON json.RawMessage) (ProjectFolder, error) {
	req, err := argument[CreateProject]("request", reqJSON)
	if err != nil {
		return ProjectFolder{}, err
	}
	parent, err := ResolveProjectFolder(req.Parent)
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
	return ResolveProjectFolder(destination)
}
