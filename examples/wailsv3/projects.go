package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// Host는 호출한 창의 네이티브 상태를 선택한다.
type Host struct {
	quitting  bool
	workspace *Workspace
	opening   sync.Mutex
	mu        sync.Mutex
	windows   map[uint]*Surfaces
	owners    map[string]*Surfaces
}

var configDirectory = flag.String("config-dir", "", "Application configuration directory")

func NewHost() *Host {
	config, err := os.UserConfigDir()
	if err != nil {
		panic(err)
	}
	directory := filepath.Join(config, "com.soksak.wailsv3")
	if *configDirectory != "" {
		directory = *configDirectory
	}
	return &Host{workspace: &Workspace{directory: directory}, windows: map[uint]*Surfaces{}, owners: map[string]*Surfaces{}}
}

func (h *Host) surface(ctx context.Context) (*Surfaces, error) {
	win, ok := ctx.Value(application.WindowKey).(*application.WebviewWindow)
	if !ok {
		return nil, fmt.Errorf("host call has no window")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.windows[win.ID()]
	if s == nil {
		return nil, errNoWindow
	}
	return s, nil
}

type ProjectFolder struct {
	Root     string `json:"root"`
	Identity string `json:"identity"`
}

func (h *Host) ProjectFolder(root string) (ProjectFolder, error) {
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
	identity, err := directoryIdentity(path, info)
	return ProjectFolder{Root: path, Identity: identity}, err
}

type WindowGeometry struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
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
		owner.window.SetTitle(req.Title + " / Wails v3")
		if !local {
			owner.emit("project-activate", req.ID)
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
	owner.window.SetTitle(req.Title + " / Wails v3")
	if req.Geometry != nil && req.Geometry.Width > 0 && req.Geometry.Height > 0 {
		application.InvokeSync(func() { prepareNativeWindow(owner.window.NativeWindow()) })
		owner.window.SetSize(req.Geometry.Width, req.Geometry.Height)
		owner.window.SetPosition(req.Geometry.X, req.Geometry.Y)
	}
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
	defer h.mu.Unlock()
	if owner := h.owners[id]; owner != nil {
		delete(owner.projects, id)
	}
	delete(h.owners, id)
}

func (h *Host) WindowState(ctx context.Context) (*WindowGeometry, error) {
	s, err := h.surface(ctx)
	if err != nil {
		return nil, err
	}
	if s.window.IsMaximised() || s.window.IsFullscreen() || s.window.IsMinimised() {
		return nil, nil
	}
	x, y := s.window.Position()
	width, height := s.window.Size()
	return &WindowGeometry{X: x, Y: y, Width: width, Height: height}, nil
}

func (h *Host) WindowReady(ctx context.Context) error {
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	h.mu.Lock()
	s.ready = true
	h.mu.Unlock()
	s.first.Do(func() { s.emit("page-ready") })
	return nil
}

func (h *Host) WindowClose(ctx context.Context) error {
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	h.mu.Lock()
	s.ready = false
	h.mu.Unlock()
	s.window.Close()
	return nil
}

// 창 레지스트리 잠금을 해제한 상태에서 UI 스레드의 창 생성을 실행한다.
func (h *Host) newWindow(name, url string) *Surfaces {
	win := application.Get().Window.NewWithOptions(application.WebviewWindowOptions{
		Name: name, Title: "soksak / Wails v3", Width: 1200, Height: 760,
		Mac: application.MacWindow{TitleBar: application.MacTitleBarHidden},
		URL: url, DevToolsEnabled: true, BackgroundColour: application.NewRGB(16, 17, 23),
	})
	s := NewSurfaces(win)
	h.mu.Lock()
	h.windows[win.ID()] = s
	h.mu.Unlock()
	place := func(*application.WindowEvent) {
		application.InvokeSync(func() {
			prepareNativeWindow(win.NativeWindow())
			windowPlaceControls(win.NativeWindow(), controlsAtX, controlsAtY)
		})
	}
	win.OnWindowEvent(events.Common.WindowDidResize, place)
	win.OnWindowEvent(events.Common.WindowShow, place)
	win.OnWindowEvent(events.Mac.WebViewDidCommitNavigation, func(*application.WindowEvent) {
		h.mu.Lock()
		s.ready = false
		h.mu.Unlock()
		application.InvokeSync(func() { cancelSurfaceLayout(win.NativeWindow()) })
		s.discardOverlay()
	})
	win.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		h.mu.Lock()
		ready := s.ready
		if !ready {
			delete(h.windows, win.ID())
			for id := range s.projects {
				delete(h.owners, id)
			}
		}
		quit := h.quitting && len(h.windows) == 0
		h.mu.Unlock()
		if ready {
			e.Cancel()
			s.emit("project-close-request")
			return
		}
		s.close()
		if quit {
			go application.Get().Quit()
		}
	})
	return s
}

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
	if err == nil && req.Kind != "snapshot" {
		h.mu.Lock()
		windows := make([]*Surfaces, 0, len(h.windows))
		for _, s := range h.windows {
			windows = append(windows, s)
		}
		h.mu.Unlock()
		for _, s := range windows {
			s.emit("workspace-changed")
		}
	}
	return result, err
}

func (h *Host) shouldQuit() bool {
	h.mu.Lock()
	windows := make([]*Surfaces, 0, len(h.windows))
	unready := make([]*Surfaces, 0)
	for _, s := range h.windows {
		if s.ready {
			windows = append(windows, s)
		} else {
			unready = append(unready, s)
		}
	}
	if len(windows) > 0 {
		h.quitting = true
	}
	h.mu.Unlock()
	for _, s := range windows {
		s.emit("project-close-request")
	}
	if len(windows) > 0 {
		for _, s := range unready {
			s.window.Close()
		}
	}
	return len(windows) == 0
}
