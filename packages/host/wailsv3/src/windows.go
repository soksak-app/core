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
	configDir  string
	// endpoint 는 로컬 엔드포인트이고 relay 는 페이지에 보낸 노출 요청이다.
	endpoint *Endpoint
	relay    *Relay[relayTarget]
	// notifications 는 알림 센터가 마지막으로 알린 권한 상태다.
	notifications NotificationState
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
	return &Host{workspace: NewWorkspace(directory), configDir: directory, windows: map[uint]*Surfaces{}, owners: map[string]*Surfaces{}, sidecars: sidecars,
		relay: NewRelay[relayTarget]()}, nil
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
	owner := win.NativeWindow()
	if err := system.EnqueueUI(func() {
		if err := system.CancelLayout(owner); err != nil {
			log.Printf("surface layout: %v", err)
		}
	}); err != nil {
		log.Printf("surface layout: %v", err)
	}
}

// 앱 DOM 재로드는 모든 플러그인 문서를 교체하지만 터미널 세션은 종료하지 않는다.
func (s *Surfaces) reloadSurfaceDocuments() {
	if err := system.CancelLayout(s.window.NativeWindow()); err != nil {
		log.Printf("surface reload: %v", err)
		return
	}
	ids := make([]string, 0, len(s.views))
	for id, view := range s.views {
		system.SetSurfaceHiddenHandle(view.handle, true)
		s.closeSurfaceDocuments(id)
		s.closeSurfaceImages(id)
		s.images.BeginGeneration(id)
		ids = append(ids, id)
	}
	s.mu.Lock()
	clear(s.compositionRevisions)
	s.mu.Unlock()
	s.surfacesClosed(ids)
	s.windowChanged()
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
	// 네이티브 뷰는 DOM 위에 놓였으므로 놓인 파일은 페이지가 그 점의 DOM 요소를 기준으로 처리한다.
	var dropOnce sync.Once
	place := func(*application.WindowEvent) {
		application.InvokeSync(func() {
			if err := system.SetMainWebview(win.NativeWindow()); err != nil {
				log.Fatalf("main webview identity: %v", err)
			}
			dropOnce.Do(func() {
				main, err := system.MainWebview(win.NativeWindow())
				if err == nil {
					// 내용의 해석과 오류 보고는 페이지가 한다(core.drop).
					err = system.FileDrop(main, func(payload string) {
						s.Emit("files-dropped", payload)
					})
				}
				if err != nil {
					log.Fatalf("file drop: %v", err)
				}
			})
			system.ConfigureMainWindow(win.NativeWindow(), s.Theme().Scheme == "dark")
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
		h.relay.Abandon(func(t relayTarget) bool { return t.owner == s && t.surface == "" })
		go h.windowsChanged()
		// Finish the old surface cleanup before the replacement document can attach
		// its images. Queueing this after the framework callback lets the new page
		// publish a composition while the old generation is still being removed.
		application.InvokeSync(s.reloadSurfaceDocuments)
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
		h.relay.Abandon(func(t relayTarget) bool { return t.owner == s })
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

// Chrome 은 페이지가 첫 행을 그리는 데 쓰는 창의 값이다. Controls 는 창 단추가 차지하는 영역이고
// Row 는 제목줄의 높이(pt)다. 전체 화면처럼 제목줄이 없으면 Row 는 0 이고, 페이지는 쓰던 높이를 지킨다.
type Chrome struct {
	Controls Rect    `json:"controls"`
	Row      float64 `json:"row"`
}

// WindowChrome 은 창 단추 영역과 제목줄 높이를 반환한다. 페이지는 첫 행에서 단추만큼을 비우고
// 행의 높이를 제목줄에 맞춘다.
func (s *Surfaces) WindowChrome() (Chrome, error) {
	controls, err := s.WindowControls()
	if err != nil {
		return Chrome{}, err
	}
	win, ok := s.window, s.window != nil
	if !ok {
		return Chrome{}, errNoWindow
	}
	var row float64
	var rowErr error
	application.InvokeSync(func() { row, rowErr = system.UnifiedTitlebar(win.NativeWindow()) })
	if rowErr != nil {
		return Chrome{}, rowErr
	}
	return Chrome{Controls: controls, Row: row}, nil
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
