// 프로젝트 창, 창 레지스트리, 준비·닫기·종료 처리와 창 상태.

package host

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// 창 자신의 단추를 두는 위치. 창의 왼쪽 위에서 잰 점이고, 맨 왼쪽 단추의 왼쪽 위
// 모서리가 여기에 온다. 타우리 호스트가 같은 값을 쓰고, 페이지의 검증기가 그 결과를
// 잰다.
const (
	controlsAtX = 12
	controlsAtY = 14.5
)

// 창을 만들 때의 콘텐츠 크기. 관측의 reset 이 창을 이 크기로 되돌린다.
const (
	startWidth  = 1200
	startHeight = 760
)

// Host 는 호출한 창의 네이티브 상태를 선택한다. Wails 는 Host 의 공개 메서드를 페이지에 바인딩한다.
type Host struct {
	quitting   bool
	nextWindow uint64
	workspace  *Workspace
	opening    sync.Mutex
	mu         sync.Mutex
	windows    map[uint]*Surfaces
	owners     map[string]*Surfaces
	sidecars   *Sidecars
}

// errNoWindow 는 이 애플리케이션의 창이 없을 때 반환한다. 여기의 호출은 모두 그 창에
// 무언가를 배치하거나 읽으므로 어느 것도 성공할 수 없다.
var errNoWindow = errors.New("the main window is gone")

func newHost(sidecars *Sidecars, configDir string) (*Host, error) {
	directory := configDir
	if directory == "" {
		config, err := os.UserConfigDir()
		if err != nil {
			return nil, err
		}
		directory = filepath.Join(config, "com.soksak.wailsv3")
	}
	return &Host{workspace: NewWorkspace(directory), windows: map[uint]*Surfaces{}, owners: map[string]*Surfaces{}, sidecars: sidecars}, nil
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

type WindowGeometry struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

func (h *Host) WindowNew() {
	h.newWindow(fmt.Sprintf("project-window-%d", atomic.AddUint64(&h.nextWindow, 1)), "/")
}

func (h *Host) notifyWorkspace() {
	h.mu.Lock()
	windows := make([]*Surfaces, 0, len(h.windows))
	for _, s := range h.windows {
		windows = append(windows, s)
	}
	h.mu.Unlock()
	for _, s := range windows {
		s.Emit("workspace-changed")
	}
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
	s.first.Do(func() { s.Emit("page-ready") })
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

// prepareWindow 는 창의 콘텐츠와 메인 웹뷰의 크기를 맞춘다. UI 스레드에서 호출한다.
func prepareWindow(win *application.WebviewWindow) {
	if err := system.PrepareWindow(win.NativeWindow()); err != nil {
		log.Printf("window: %v", err)
	}
}

// cancelLayout 은 창에서 진행 중인 표면 배치를 취소한다. UI 스레드에서 호출한다.
func cancelLayout(win *application.WebviewWindow) {
	if err := system.CancelLayout(win.NativeWindow()); err != nil {
		log.Printf("surface layout: %v", err)
	}
}

// newWindow 는 창 레지스트리 잠금을 해제한 상태에서 UI 스레드의 창 생성을 실행한다.
func (h *Host) newWindow(name, url string) *Surfaces {
	win := application.Get().Window.NewWithOptions(application.WebviewWindowOptions{
		Name: name, Title: "soksak / Wails v3", Width: startWidth, Height: startHeight,
		Mac: application.MacWindow{TitleBar: application.MacTitleBarHidden},
		URL: url, DevToolsEnabled: true, BackgroundColour: application.NewRGB(16, 17, 23),
	})
	s := NewSurfaces(win, h.sidecars)
	h.mu.Lock()
	h.windows[win.ID()] = s
	h.mu.Unlock()
	place := func(*application.WindowEvent) {
		application.InvokeSync(func() {
			prepareWindow(win)
			if err := system.PlaceWindowControls(win.NativeWindow(), controlsAtX, controlsAtY); err != nil {
				log.Printf("window: %v", err)
			}
		})
	}
	win.OnWindowEvent(events.Common.WindowDidResize, place)
	win.OnWindowEvent(events.Common.WindowShow, place)
	win.OnWindowEvent(events.Mac.WebViewDidCommitNavigation, func(*application.WindowEvent) {
		h.mu.Lock()
		s.ready = false
		h.mu.Unlock()
		application.InvokeSync(func() { cancelLayout(win) })
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
			s.Emit("project-close-request")
			return
		}
		s.close()
		h.notifyWorkspace()
		if quit {
			go application.Get().Quit()
		}
	})
	return s
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
		s.Emit("project-close-request")
	}
	if len(windows) > 0 {
		for _, s := range unready {
			s.window.Close()
		}
	}
	return len(windows) == 0
}

// WindowControls 는 창 단추가 차지하는 영역을 페이지 좌표로 반환한다. 페이지는 첫 행에서
// 그만큼을 비운다. 빈 영역은 창이 단추를 그리지 않는다는 뜻이다.
func (s *Surfaces) WindowControls() (Rect, error) {
	win, ok := s.window, s.window != nil
	if !ok {
		return Rect{}, errNoWindow
	}
	var at Rect
	var err error
	application.InvokeSync(func() {
		var got platformRect
		got, err = system.WindowControls(win.NativeWindow())
		at = Rect(got)
	})
	return at, err
}

// close 는 창이 닫힐 때 창의 네이티브 뷰, 입력 감시와 사이드카 표면을 정리한다.
func (s *Surfaces) close() {
	application.InvokeSync(func() {
		cancelLayout(s.window)
		if s.monitor != 0 {
			system.UnwatchInput(s.monitor)
		}
		for _, view := range nativeViews {
			if view.owner == s {
				view.Close()
			}
		}
		for _, shape := range s.shapes {
			shape.destroy()
		}
	})
	go s.sidecars.CloseOwner(s)
}
