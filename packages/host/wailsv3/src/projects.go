// Project folder check, folder selection, project creation, and project opening.

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

// ProjectFolder returns the real path and the directory identifier of root.
func (h *Host) ProjectFolder(rootJSON json.RawMessage) (ProjectFolder, error) {
	root, err := argument[string]("root", rootJSON)
	if err != nil {
		return ProjectFolder{}, err
	}
	return ResolveProjectFolder(root)
}

// ResolveProjectFolder replaces ~ with the home directory and returns the real path and the directory identifier of the directory root
// after following symbolic links. It fails when root is not a directory.
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

// folderError converts the error of a folder that could not be checked to the contract sentence that carries the one requested path. Both hosts produce the same sentence
// (workspace.folder.messages of docs/spec/host-contract.md).
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
	Separate bool            `json:"separate"`
	Geometry *WindowGeometry `json:"geometry"`
}
type ProjectOpened struct {
	Local  bool `json:"local"`
	Staged bool `json:"staged"`
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
		owner.projects[req.ID] = folder.Root
		staged := owner.pendingProjects[req.ID]
		h.mu.Unlock()
		if !local {
			owner.Emit("project-activate", req.ID)
			owner.window.Show()
			owner.window.Focus()
		}
		return ProjectOpened{Local: local, Staged: staged}, nil
	}
	separate := req.Separate && len(current.projects) > 0
	h.mu.Unlock()
	owner = current
	if separate {
		owner = h.newWindow("project-"+req.ID, "/?project="+req.ID)
	}
	h.mu.Lock()
	owner.projects[req.ID] = folder.Root
	if owner.pendingProjects == nil {
		owner.pendingProjects = make(map[string]bool)
	}
	owner.pendingProjects[req.ID] = true
	h.owners[req.ID] = owner
	h.mu.Unlock()
	if req.Geometry != nil && req.Geometry.Width > 0 && req.Geometry.Height > 0 {
		application.InvokeSync(func() {
			// A Wails window size is in integer logical pixels, so the stored size is set to the nearest integer.
			owner.window.SetSize(int(math.Round(req.Geometry.Width)), int(math.Round(req.Geometry.Height)))
			owner.window.SetPosition(int(req.Geometry.X), int(req.Geometry.Y))
			prepareWindow(owner.window)
		})
	}
	h.notifyWorkspace()
	return ProjectOpened{Local: owner == current, Staged: true}, nil
}

type ProjectShown struct {
	Project json.RawMessage `json:"project,omitempty"`
}

type ShownProject struct {
	ID    string `json:"id"`
	Root  string `json:"root"`
	Title string `json:"title"`
}

// ProjectShown commits the project displayed by a page after its project data is ready.
func (h *Host) ProjectShown(ctx context.Context, reqJSON json.RawMessage) error {
	req, err := argument[ProjectShown]("request", reqJSON)
	if err != nil {
		return err
	}
	if len(req.Project) == 0 {
		return fmt.Errorf("argument request.project is missing")
	}
	current, err := h.surface(ctx)
	if err != nil {
		return err
	}
	h.opening.Lock()
	defer h.opening.Unlock()
	if string(req.Project) == "null" {
		current.mu.Lock()
		current.shown, current.root = "", ""
		current.mu.Unlock()
		current.setTitle(windowTitle)
		current.postProjectToPluginHosts()
		return nil
	}
	project, err := argument[ShownProject]("request.project", req.Project)
	if err != nil {
		return err
	}
	if !validProjectID(project.ID) {
		return fmt.Errorf("invalid project id")
	}
	folder, err := ResolveProjectFolder(project.Root)
	if err != nil {
		return err
	}
	h.mu.Lock()
	owner := h.owners[project.ID]
	if owner != current {
		h.mu.Unlock()
		return fmt.Errorf("project %s is not owned by this window", project.ID)
	}
	root, ok := current.projects[project.ID]
	if !ok || root != folder.Root {
		h.mu.Unlock()
		return fmt.Errorf("project %s root does not match its owned folder", project.ID)
	}
	current.mu.Lock()
	current.shown, current.root = project.ID, folder.Root
	current.mu.Unlock()
	delete(current.pendingProjects, project.ID)
	h.mu.Unlock()
	current.setTitle(project.Title + titleSuffix)
	current.postProjectToPluginHosts()
	return nil
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
		delete(owner.pendingProjects, id)
	}
	delete(h.owners, id)
	empty := owner != nil && len(owner.projects) == 0
	h.mu.Unlock()
	// The plugin sessions of the project end with it, when the holding window owns them (docs/plans/plugin-host-routes.md rule 7).
	if owner != nil {
		owner.sidecars.closeProjectSessions(owner, id)
	}
	// A release of the shown project clears the shown root at once, even when another project is still held: the window shows no
	// project until the page shows one explicitly (docs/plans/plugin-host-routes.md F229-1). A window with no project left shows
	// the library, so the title is cleared with it.
	if owner != nil {
		owner.mu.Lock()
		shownReleased := owner.shown == id
		if shownReleased {
			owner.shown, owner.root = "", ""
		}
		owner.mu.Unlock()
		if shownReleased {
			owner.postProjectToPluginHosts()
		}
		if empty || shownReleased {
			owner.setTitle(windowTitle)
		}
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
