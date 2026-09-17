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

// windowTitle 은 프로젝트를 열지 않은 창의 제목이고, titleSuffix 는 프로젝트 창 제목의 끝이다.
const (
	windowTitle = "soksak / Wails v3"
	titleSuffix = " / Wails v3"
)

// setTitle 은 창 제목을 바꾸고 windows.list 가 반환할 값으로 기록한다.
func (s *Surfaces) setTitle(title string) {
	s.mu.Lock()
	s.title = title
	s.mu.Unlock()
	s.window.SetTitle(title)
	if s.host != nil {
		go s.host.windowsChanged()
	}
}

// 창을 만들 때의 콘텐츠 크기.
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
	// endpoint 는 로컬 엔드포인트이고 relay 는 페이지에 보낸 노출 요청이다.
	endpoint *Endpoint
	relay    relay
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
	return &Host{workspace: NewWorkspace(directory), windows: map[uint]*Surfaces{}, owners: map[string]*Surfaces{}, sidecars: sidecars,
		relay: relay{waiting: map[uint64]*waiter{}}}, nil
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
	readied := s.readied
	s.readied = nil
	h.mu.Unlock()
	// 첫 창은 생성과 함께 표시되어 WindowShow 가 오지 않을 수 있다. 페이지가 준비되면 창이
	// 표시된 상태이므로 여기서도 제목줄을 만든다.
	var titled error
	application.InvokeSync(func() {
		_, titled = system.UnifiedTitlebar(s.window.NativeWindow())
	})
	if titled != nil {
		return fmt.Errorf("window title bar: %w", titled)
	}
	s.first.Do(func() { s.Emit("page-ready") })
	s.replayRegistrations()
	go h.windowsChanged()
	for _, ready := range readied {
		close(ready)
	}
	go s.rewatch()
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
		Name: name, Title: windowTitle, Width: startWidth, Height: startHeight,
		Mac: application.MacWindow{TitleBar: application.MacTitleBarHidden},
		URL: url, DevToolsEnabled: true, BackgroundColour: application.NewRGB(16, 17, 23),
	})
	s := NewSurfaces(win, h.sidecars)
	s.host, s.name, s.title = h, name, windowTitle
	h.mu.Lock()
	h.windows[win.ID()] = s
	h.mu.Unlock()
	go h.windowsChanged()
	// 페이지가 첫 행의 높이를 제목줄에서 읽으므로 창이 표시될 때 만든다. 애플리케이션이 아직
	// 실행되기 전에는 메인 스레드 호출을 할 수 없으므로 창 이벤트에서 한다.
	place := func(*application.WindowEvent) {
		application.InvokeSync(func() {
			prepareWindow(win)
			if _, err := system.UnifiedTitlebar(win.NativeWindow()); err != nil {
				log.Printf("window: %v", err)
			}
		})
	}
	win.OnWindowEvent(events.Common.WindowDidResize, place)
	win.OnWindowEvent(events.Common.WindowShow, place)
	// host.window 를 감시하는 연결에 창의 위치, 크기와 키 상태 변경을 알린다.
	changed := func(*application.WindowEvent) {
		s.windowChanged()
		go h.windowsChanged()
	}
	for _, event := range []events.WindowEventType{events.Common.WindowDidResize, events.Common.WindowDidMove,
		events.Common.WindowFocus, events.Common.WindowLostFocus} {
		win.OnWindowEvent(event, changed)
	}
	win.OnWindowEvent(events.Mac.WebViewDidCommitNavigation, func(*application.WindowEvent) {
		h.mu.Lock()
		s.ready = false
		h.mu.Unlock()
		// 이전 페이지에 보낸 요청은 답을 받지 못한다.
		h.relay.abandon(s, map[string]bool{"": true})
		go h.windowsChanged()
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
		h.relay.abandon(s, nil)
		h.notifyWorkspace()
		go h.windowsChanged()
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
