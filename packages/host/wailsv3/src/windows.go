// 프로젝트 창, 창 레지스트리, 준비·닫기·종료 처리와 창 상태.

package host

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sync"
	"sync/atomic"
	"unsafe"

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
	plugins    *Plugins
	// buttons 는 host.buttons 의 값이다. 애플리케이션이 시작한 뒤 endpoint.json 을 쓰기 전에 감시를 설치한다.
	buttons   *Buttons
	configDir string
	// endpoint 는 로컬 엔드포인트이고 relay 는 페이지에 보낸 노출 요청이다.
	endpoint *Endpoint
	relay    *Relay[relayTarget]
	// notifications 는 알림 센터가 마지막으로 알린 권한 상태다.
	notifications NotificationState
}

// errNoWindow 는 이 애플리케이션의 창이 없을 때 반환한다. 여기의 호출은 모두 그 창에
// 무언가를 배치하거나 읽으므로 어느 것도 성공할 수 없다.
var errNoWindow = errors.New("the main window is gone")

func newHost(directory string) (*Host, error) {
	h := &Host{workspace: NewWorkspace(directory), configDir: directory, windows: map[uint]*Surfaces{}, owners: map[string]*Surfaces{},
		relay: NewRelay[relayTarget]()}
	plugins, err := NewPlugins(directory, h.notifyPlugins)
	if err != nil {
		return nil, err
	}
	h.plugins = plugins
	return h, nil
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
	X      int32   `json:"x"`
	Y      int32   `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
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
	return &WindowGeometry{X: int32(x), Y: int32(y), Width: float64(width), Height: float64(height)}, nil
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
		LogError("window prepare", err)
	}
}

// cancelLayout 은 창에서 진행 중인 표면 배치를 취소한다. UI 스레드에서 호출한다.
func cancelLayout(win *application.WebviewWindow) {
	owner := win.NativeWindow()
	if err := system.EnqueueUI(func() {
		if err := system.CancelLayout(owner); err != nil {
			LogError("surface layout cancel", err)
		}
	}); err != nil {
		LogError("surface layout cancel", err)
	}
}

// handleNavigation 은 진단 빌드에서 main webview navigation callback 의 처리를 감싼다. 검사가 처리를 늦추고
// 끝났음을 기록에서 확인한다. 다른 빌드에서는 nil 이다.
var handleNavigation func(s *Surfaces, handle func())

// 앱 DOM 재로드는 모든 플러그인 문서를 교체하지만 터미널 세션은 종료하지 않는다.
func (s *Surfaces) reloadSurfaceDocuments() {
	if err := system.CancelLayout(s.window.NativeWindow()); err != nil {
		LogError("surface layout cancel", err)
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
		// 창은 첫 화면이 표시된 뒤에 보인다(docs/spec/native-host.md#page-start). 준비가 끝나면 reveal 이 보인다.
		URL: url, DevToolsEnabled: true, BackgroundColour: application.NewRGB(16, 17, 23), Hidden: true,
	})
	s := NewSurfaces(win, h.sidecars)
	s.host, s.name, s.title = h, name, windowTitle
	h.mu.Lock()
	h.windows[win.ID()] = s
	h.mu.Unlock()
	go h.windowsChanged()
	// 네이티브 뷰는 DOM 위에 놓였으므로 놓인 파일은 페이지가 그 점의 DOM 요소를 기준으로 처리한다.
	var dropOnce sync.Once
	place := func(*application.WindowEvent) {
		application.InvokeSync(func() {
			if err := system.SetMainWebview(win.NativeWindow()); err != nil {
				fatalError("main webview identity", err)
			}
			system.ConfigureMainWindow(win.NativeWindow(), s.Theme().Scheme == "dark")
			prepareWindow(win)
			// 놓기 뷰는 창 합성 뷰에 들어가고, 합성 뷰는 만들 때의 메인 웹뷰 크기를 가진다. 메인 웹뷰를 내용
			// 영역에 맞춘 뒤에 등록한다.
			dropOnce.Do(func() {
				main, err := system.MainWebview(win.NativeWindow())
				if err == nil {
					// 내용의 해석과 오류 보고는 페이지가 한다(core.drop).
					err = system.FileDrop(main, func(payload string) {
						s.Emit("files-dropped", payload)
					})
				}
				if err != nil {
					fatalError("file drop", err)
				}
			})
		})
	}
	win.OnWindowEvent(events.Common.WindowDidResize, place)
	win.OnWindowEvent(events.Common.WindowShow, place)
	// WindowShow 는 창의 가림 상태가 보임으로 바뀔 때 온다. 다른 애플리케이션의 창에 완전히 가려진 채 열린
	// 창에는 오지 않으므로, 네이티브 창이 있으면 만든 직후에 준비한다. 애플리케이션이 실행되기 전에 만든
	// 첫 창은 애플리케이션이 시작하면 준비한다.
	// 창을 투명하게 화면에 올리고 첫 화면이 표시되면 불투명하게 한다. Show 는 UI 스레드 밖에서 부른다.
	var revealed sync.Once
	s.prepareNative = func() {
		place(nil)
		revealed.Do(func() {
			// 제목줄은 페이지가 첫 행 높이로 요청할 때까지 처음 높이를 갖는다. 창이 보이기 전에 정한다.
			var titled error
			application.InvokeSync(func() { titled = system.SetTitlebarHeight(win.NativeWindow(), initialTitlebarHeight) })
			if titled != nil {
				LogError("window title bar", titled)
			}
			var failed error
			application.InvokeSync(func() { failed = system.RevealAfterLoad(win.NativeWindow()) })
			if failed != nil {
				fatalError("window reveal", failed)
			}
			win.Show()
		})
	}
	if win.NativeWindow() != nil {
		s.prepareNative()
	}
	// host.window 를 감시하는 연결에 창의 위치, 크기, 키 상태와 가림 상태 변경을 알린다. Wails 는 macOS 의 가림
	// 상태 변경을 WindowShow(보임)와 WindowHide(완전히 가려짐)로 보낸다.
	changed := func(*application.WindowEvent) {
		s.windowChanged()
		go h.windowsChanged()
	}
	for _, event := range []events.WindowEventType{events.Common.WindowDidResize, events.Common.WindowDidMove,
		events.Common.WindowFocus, events.Common.WindowLostFocus, events.Common.WindowShow, events.Common.WindowHide} {
		win.OnWindowEvent(event, changed)
	}
	win.OnWindowEvent(events.Mac.WebViewDidCommitNavigation, func(*application.WindowEvent) {
		// 이 callback 은 별도 goroutine 에서 새 페이지의 호출보다 늦게 실행될 수 있다. 이전 페이지의 정리는
		// 새 페이지의 시작 문서 요청(startPage)이 하고, 여기서는 이 실행의 WebKit 자식 기록만 갱신한다(V5-113).
		committed := func() {
			if h.workspace != nil {
				RefreshWebKitChildren(h.workspace.Directory())
			}
		}
		if handleNavigation != nil {
			handleNavigation(s, committed)
		} else {
			committed()
		}
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
// Row 는 제목줄의 높이(pt)다. 전체 화면처럼 제목줄이 없으면 Row 는 0 이다.
type Chrome struct {
	Controls Rect    `json:"controls"`
	Row      float64 `json:"row"`
}

// WindowChrome 은 창 단추 영역과 제목줄 높이를 반환한다. 페이지는 첫 행에서 단추만큼을 비우고
// 제목줄이 행과 다르면 행을 담은 배치를 준비한다(docs/spec/native-surfaces.md#title-bar-height).
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
	application.InvokeSync(func() { row, rowErr = system.TitlebarHeight(win.NativeWindow()) })
	if rowErr != nil {
		return Chrome{}, rowErr
	}
	return Chrome{Controls: controls, Row: row}, nil
}

// initialTitlebarHeight 는 창을 만들 때 정하는 제목줄 높이(pt)다. 프레임 글자 배율 1 의 첫 행 높이와 같다
// (packages/workbench/app.css 의 --chrome-h).
const initialTitlebarHeight = 40

// ValidateTitlebarHeight 는 표면 준비가 담은 제목줄 높이(pt)를 검사한다. 첫 행은 40pt 에서 프레임 글자 배율 3 의
// 108pt 사이다. AppKit 은 0 이하의 값을 사용자 지정 높이가 없다는 뜻으로 쓰므로 그 값도 이 범위 밖이다.
func ValidateTitlebarHeight(height float64) error {
	if math.IsNaN(height) || height < 32 || height > 200 {
		return errors.New("title bar height must be a finite number from 32 through 200 points")
	}
	return nil
}

// titlebarChrome 은 창의 제목줄을 height(pt)로 만들고 그 뒤의 창 단추 영역과 제목줄 높이, 그리고 이전 높이로 되돌리는
// 함수를 반환한다. 표면 준비가 창의 배치 트랜잭션 안에서 UI 스레드에서 호출하므로 새 높이는 그 트랜잭션의 커밋과 함께
// 화면에 나간다. 전체 화면인 창은 높이를 바꾸지 않고 Row 0 을 반환하며, 되돌릴 것이 없다.
func titlebarChrome(window unsafe.Pointer, height float64) (Chrome, func() error, error) {
	previous, err := system.TitlebarHeight(window)
	if err != nil {
		return Chrome{}, nil, err
	}
	restore := func() error {
		if previous <= 0 {
			return nil
		}
		return system.SetTitlebarHeight(window, previous)
	}
	if err := system.SetTitlebarHeight(window, height); err != nil {
		return Chrome{}, nil, err
	}
	controls, err := system.WindowControls(window)
	if err != nil {
		return Chrome{}, restore, err
	}
	row, err := system.TitlebarHeight(window)
	if err != nil {
		return Chrome{}, restore, err
	}
	return Chrome{Controls: Rect(controls), Row: row}, restore, nil
}

// StartTitlebarHeight 는 페이지의 첫 그리기가 보일 첫 행의 높이(pt)다. 공통 설정 textSize 의 round(max(40, 36 ×
// textSize)) 이고, 설정이 없으면 40 이다(docs/spec/native-surfaces.md#title-bar-height). textSize 는 공통 전용이므로
// 페이지는 같은 값으로 첫 행을 그린다.
func StartTitlebarHeight(common Record) (float64, error) {
	value, has := common["textSize"]
	if !has {
		return initialTitlebarHeight, nil
	}
	factor, ok := value.(float64)
	if !ok {
		return 0, fmt.Errorf("common setting textSize must be a number, not %s", jsonKind(value))
	}
	if factor < 0.5 || factor > 3 {
		return 0, errors.New("common setting textSize must be from 0.5 through 3")
	}
	return math.Round(math.Max(initialTitlebarHeight, 36*factor)), nil
}

// startTitlebar 는 시작 문서에 답하기 전에 창의 제목줄을 공통 설정의 첫 행 높이로 정한다. 새 창은 아직 투명하고 페이지의
// 첫 그리기와 함께 보이므로 그 첫 프레임의 행과 제목줄이 같다. 전체 화면인 창은 높이를 바꾸지 않는다.
func (s *Surfaces) startTitlebar(common Record) error {
	height, err := StartTitlebarHeight(common)
	if err != nil {
		return err
	}
	win, ok := s.window, s.window != nil
	if !ok {
		return errNoWindow
	}
	application.InvokeSync(func() { err = system.SetTitlebarHeight(win.NativeWindow(), height) })
	return err
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
		// 논리 표면은 nativeViews 가 아니라 s.views 에 있다. 표면은 메인 웹뷰를 보유하므로 닫지 않으면 메인
		// 웹뷰와 그 웹 콘텐츠 프로세스가 남는다.
		handles := make(map[string]unsafe.Pointer, len(s.views))
		views := make(map[unsafe.Pointer]*nativeWebview, len(s.views))
		for id, view := range s.views {
			handles[id] = view.handle
			views[view.handle] = view
		}
		err := CloseWindowSurfaces(handles, s.documents, s.images, func(native WindowNative) error {
			switch native.Kind {
			case WindowNativeDocument:
				system.CloseDocument(native.Handle)
			case WindowNativeImage:
				system.CloseImage(native.Handle)
			default:
				views[native.Handle].Close()
			}
			return nil
		})
		if err != nil {
			LogError("window close", err)
		}
		clear(s.views)
		clear(s.named)
		for _, shape := range s.shapes {
			shape.destroy()
		}
	})
	go s.sidecars.CloseOwner(s)
}
