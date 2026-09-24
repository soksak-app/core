// Package platform 은 네이티브 호스트의 운영체제별 동작을 선언하고 현재 운영체제의 구현을 선택한다.
//
// 운영체제별 구현은 platform/<os>/ 패키지가 init 에서 Register 로 등록한다. host 패키지가
// 모든 운영체제 패키지를 가져오므로 현재 운영체제의 구현만 등록된다.
//
// 창과 뷰는 unsafe.Pointer 핸들로 전달한다. 핸들을 받는 함수는 UI 스레드에서 호출한다.
package platform

import (
	"errors"
	"net"
	"os"
	"sync"
	"unsafe"
)

// Rect 는 페이지 뷰포트 기준 CSS 픽셀 단위의 영역이다.
type Rect struct {
	X, Y, W, H float64
}

// DOMOverlay 는 표면 뷰포트 기준 CSS 픽셀 여백과 표시 여부다.
type DOMOverlay struct {
	Left, Top, Right, Bottom float64
	Visible                  bool
}

// WindowOverlay is a main-DOM region that must participate in native hit ownership.
type WindowOverlay struct {
	X, Y, W, H float64
	Visible    bool
}

// ClipboardValue distinguishes an empty clipboard from an operation error.
type ClipboardValue struct {
	Present bool
	Type    string
	Text    string
	PNG     []byte
	URLs    []string
}

func VisibleWindowOverlayRects(overlays []WindowOverlay) []float64 {
	values := make([]float64, 0, len(overlays)*4)
	for _, overlay := range overlays {
		if !overlay.Visible {
			continue
		}
		values = append(values, overlay.X, overlay.Y, overlay.W, overlay.H)
	}
	return values
}

// WebviewOptions 는 앱이 만드는 네이티브 웹뷰의 생성 값이다.
type WebviewOptions struct {
	// Identifier 는 웹뷰가 보낸 메시지에 붙는 번호다.
	Identifier uint64
	// Name 은 창 히트 테스트가 반환하는 네이티브 뷰 식별자다. 비어 있으면 식별자를 설정하지 않는다.
	Name string
	// Script 는 각 문서가 시작할 때 실행하는 스크립트다.
	Script              string
	X, Y, Width, Height float64
	Hidden, Transparent bool
	// FillParent 는 부모 뷰의 크기를 따라 크기를 바꿀지 나타낸다.
	FillParent bool
	// Receive 는 웹뷰의 문서가 보낸 메시지를 받는다. UI 스레드 밖에서 호출된다.
	Receive func(identifier uint64, body string)
	// Committed 는 웹뷰가 새 문서를 표시하기 시작했음을 받는다. UI 스레드 밖에서 호출된다.
	Committed func(identifier uint64)
}

// Input 은 표면 위 입력을 받는 함수들이다.
type Input struct {
	// Press 는 누른 뷰가 표면인지 반환하고, 표면이면 그 사실을 전달한다.
	Press func(view uintptr) bool
	// Point 는 왼쪽 단추 끌기의 한 단계를 페이지 좌표로 전달한다. phase 는 누름 0, 이동 1, 뗌 2 이다.
	Point func(phase int, x, y float64)
}

// InputSources 는 키보드 입력 소스 연산이다. 진단 빌드(태그 diagnostics)의 플랫폼 구현만 제공하며,
// 진단 코드는 Current() 의 값을 이 인터페이스로 확인해 사용한다. 두 연산 모두 메인 스레드에서 호출한다.
type InputSources interface {
	// InputSource 는 현재 선택된 키보드 입력 소스의 식별자를 반환한다.
	InputSource() (string, error)
	// SelectInputSource 는 켜져 있는 입력 소스 가운데 identifier 를 선택한다.
	SelectInputSource(identifier string) error
}

// Capturer 는 창 녹화 연산이다. 진단 빌드(태그 diagnostics)의 플랫폼 구현만 제공하며, 진단
// 코드는 Current() 의 값을 이 인터페이스로 확인해 사용한다.
type Capturer interface {
	// WindowNumbers 는 창과 자식 창의 윈도 서버 번호를 반환한다. 창 자신의 번호가 처음이다.
	WindowNumbers(window unsafe.Pointer) ([]int, error)
	// CaptureOpen 은 윈도 서버 번호 windowNumber 의 창을 녹화 대상으로 정한다. display 이면 창이 있는
	// 디스플레이에서 이 앱의 창을 녹화한다.
	CaptureOpen(windowNumber int, display bool) error
	// CaptureStart 는 directory 에 프레임 기록을 시작한다.
	CaptureStart(directory string) error
	// CaptureWait 는 첫 프레임이 기록되었는지 반환한다.
	CaptureWait() (bool, error)
	// CaptureStop 은 녹화를 끝내고 기록한 프레임 수를 반환한다.
	// after 는 녹화에 포함할 마지막 표시 시각(ms, 표시 시각과 같은 시계)이고, 0 이면 호출 시각이다.
	CaptureStop(after float64) (int, error)
	// CaptureLimited reports whether the last recording reached the frame cap.
	CaptureLimited() bool
	// CaptureLongestGap 은 마지막으로 멈춘 녹화에서 연속한 프레임 사이의 가장 긴 표시 간격(ms)이다.
	CaptureLongestGap() float64
	// CaptureClock 은 현재 시각(ms)이다. 기록 프레임의 표시 시각과 같은 시계다.
	CaptureClock() float64
	// CaptureStill 은 윈도 서버 번호 windowNumber 의 창을 포커스를 주지 않고 한 장 찍어 path 에 PNG 로 쓴다.
	// 관측 자료다.
	CaptureStill(windowNumber int, path string) error
}

// Platform 은 운영체제마다 다른 동작이다.
//
// 오류를 반환하지 않는 함수는 오류를 반환하는 생성 함수가 만든 핸들만 받는다.
type Platform interface {
	// EnqueueUI 는 현재 프레임워크 이벤트 콜백이 끝난 뒤 메인 큐에서 work 를 한 번 실행한다.
	EnqueueUI(work func()) error
	// PrepareWindow 는 창의 콘텐츠 뷰와 메인 웹뷰의 크기를 맞춘다.
	PrepareWindow(window unsafe.Pointer) error
	// Fullscreen 은 창을 전체 화면으로 바꾸거나 되돌리고, 전환이 끝나면 done 을 UI 스레드에서
	// 호출한다. 전환 중에 온 요청은 그 전환이 끝난 뒤에 처리한다.
	Fullscreen(window unsafe.Pointer, on bool, done func()) error

	// UnifiedTitlebar 는 창의 제목줄을 도구막대 높이로 만들고 그 높이(pt)를 반환한다. AppKit 이 그
	// 높이의 세로 가운데에 창 단추를 두므로 호스트는 단추를 옮기지 않는다. 창에 단추가 없으면
	// 오류를 반환한다.
	UnifiedTitlebar(window unsafe.Pointer) (float64, error)
	// WindowControls 는 창 단추가 차지하는 영역을 페이지 좌표로 반환한다.
	WindowControls(window unsafe.Pointer) (Rect, error)
	// WindowFacts 는 창의 프레임, 활성 상태, 창 단추와 웹뷰를 JSON 으로 반환한다. 형식은
	// native/darwin/src/window_facts.h 의 sp_window_facts 와 같다. UI 스레드에서 호출한다.
	WindowFacts(window unsafe.Pointer) (string, error)
	SetMainWebview(window unsafe.Pointer) error
	MainWebview(window unsafe.Pointer) (unsafe.Pointer, error)
	ConfigureMainWindow(window unsafe.Pointer, dark bool)
	ClipboardRead(kind string) (ClipboardValue, error)
	ClipboardWriteText(text string) error
	ClipboardWritePNG(bytes []byte) error
	// WindowHit 는 창 좌표 (x, y) 의 히트 테스트 결과 {view, main, identifier} 를 JSON 으로 반환한다.
	// UI 스레드에서 호출한다.
	WindowHit(window unsafe.Pointer, x, y float64) (string, error)
	// MoveWindow 는 창 프레임의 왼쪽 위를 화면 좌표 (x, y) 로 옮긴다. UI 스레드에서 호출한다.
	MoveWindow(window unsafe.Pointer, x, y float64) error
	// Screens 는 디스플레이 [{x, y, width, height, scale}] 를 화면 좌표의 JSON 으로 반환한다.
	// UI 스레드에서 호출한다.
	Screens() (string, error)

	// CreateWebview 는 창의 메인 웹뷰 위에 네이티브 웹뷰를 추가하고 그 핸들을 반환한다.
	CreateWebview(window unsafe.Pointer, options WebviewOptions) (unsafe.Pointer, error)
	// NavigateWebview 는 메인 문서 주소 기준으로 url 을 연다. url 이 잘못되었으면 false 를 반환한다.
	NavigateWebview(view unsafe.Pointer, url string) bool
	SetWebviewBounds(view unsafe.Pointer, x, y, width, height float64)
	SetWebviewHidden(view unsafe.Pointer, hidden bool)
	// SetWebviewBackground 는 문서의 window.__soksakBackground 값을 정한다.
	SetWebviewBackground(view unsafe.Pointer, enabled bool)
	EvaluateScript(view unsafe.Pointer, script string)
	// CloseWebview 는 웹뷰를 제거하고 핸들을 해제한다.
	CloseWebview(view unsafe.Pointer)
	// WebviewFrame 은 뷰의 현재 영역을 페이지 좌표로 반환한다.
	WebviewFrame(view unsafe.Pointer) Rect
	// CreateSurface creates a logical SurfaceHost below the main DOM webview.
	CreateSurface(main unsafe.Pointer) (unsafe.Pointer, error)
	CloseSurface(surface unsafe.Pointer)
	SetSurfaceBounds(surface unsafe.Pointer, x, y, width, height float64)
	SurfaceFrame(surface unsafe.Pointer) Rect
	SetSurfaceHiddenHandle(surface unsafe.Pointer, hidden bool)
	SetSurfaceAlphaHandle(surface unsafe.Pointer, alpha float64)
	SetWindowOverlays(main unsafe.Pointer, overlays []WindowOverlay) error
	// SetWebviewAlpha 는 뷰의 불투명도를 정한다.
	SetWebviewAlpha(view unsafe.Pointer, alpha float64)
	// SetSurfaceOverlays 는 네이티브 입력보다 먼저 처리할 선언된 DOM 오버레이를 설정한다.
	SetSurfaceOverlays(view unsafe.Pointer, overlays []DOMOverlay)
	// SetWebviewResizing 은 연속 크기 변경의 시작과 종료를 뷰에 전달한다.
	SetWebviewResizing(view unsafe.Pointer, live bool)
	// ConfigureModal 은 모달 웹뷰의 접근성 이름과 모서리 반경을 정한다.
	ConfigureModal(view unsafe.Pointer, title string, radius float64)
	// FocusModal 은 키보드 초점을 모달 웹뷰로 옮기거나 메인 웹뷰로 되돌린다.
	FocusModal(view unsafe.Pointer, take bool)
	// AlignRect 는 페이지 좌표의 영역을 디스플레이 픽셀에 안쪽으로 맞춘다.
	AlignRect(window unsafe.Pointer, at Rect) (Rect, error)

	// CreateDocument 는 표면 웹뷰 surface 안에 외부 문서 웹뷰를 숨긴 상태로 만든다. store 는 영구 데이터
	// 저장소의 이름이다. changed 는 상태 JSON({url, title, loading, progress, canGoBack, canGoForward,
	// error, scroll}) 을 UI 스레드에서 받는다.
	CreateDocument(surface unsafe.Pointer, store string, changed func(state string)) (unsafe.Pointer, error)
	SetDocumentEvent(document unsafe.Pointer, event func(value string)) error
	// LoadDocument 는 http 또는 https 주소를 연다. 그 밖의 주소이면 false 를 반환한다.
	LoadDocument(document unsafe.Pointer, url string) bool
	// ZoomDocument 는 문서의 페이지 확대를 정한다. 유한한 양수가 아니면 false 를 반환한다.
	ZoomDocument(document unsafe.Pointer, zoom float64) bool
	// GoDocument 는 뒤로 0, 앞으로 1, 다시 읽기 2, 멈춤 3 을 실행하고 실행했는지 반환한다.
	GoDocument(document unsafe.Pointer, action int) bool
	// PlaceDocument 는 표면 뷰포트의 CSS 픽셀 여백으로 문서 영역을 정한다.
	PlaceDocument(document unsafe.Pointer, left, top, right, bottom float64, visible bool)
	// SetDocumentBackground 는 대화 상자가 열린 동안 문서를 흐리게 표시한다.
	SetDocumentBackground(document unsafe.Pointer, enabled bool)
	// SetDocumentAppearance 는 문서 웹뷰와 그 웹 콘텐츠의 명시적인 테마를 설정한다.
	SetDocumentAppearance(document unsafe.Pointer, dark bool)
	// CloseDocument 는 문서 웹뷰를 제거한다. 이후 changed 는 호출되지 않는다.
	CloseDocument(document unsafe.Pointer)

	// CreateImage 는 표면 웹뷰 surface 안에 외부 그림 표시 영역을 만든다. event 는
	// 키보드·IME·입력 이벤트를 JSON 문자열({key, insert, compose, focus, size, error})으로
	// 메인 스레드에서 받는다.
	CreateImage(surface unsafe.Pointer, name string, event func(json string)) (unsafe.Pointer, error)
	// PlaceImage 는 표면 뷰포트의 CSS 픽셀 여백으로 그림 영역을 정한다.
	PlaceImage(image unsafe.Pointer, left, top, right, bottom float64, visible bool)
	// RasterImage 는 적용된 그림 영역의 장치 픽셀 크기와 CSS 픽셀당 장치 픽셀 배율을 반환한다.
	RasterImage(image unsafe.Pointer) (width, height int, scale float64, ok bool)
	// PresentImage 는 외부 IOSurface 를 표시한다. token_id 는 IOSurface 의 전역 ID,
	// nonce 는 논스 대조용 16바이트 데이터, width·height 는 장치 픽셀 단위의 크기이고,
	// scale 은 이미지가 만들어진 배율이다 (contentsScale 로 사용).
	// 실패하면 네이티브 거부 이유(notFound, forbidden, size, unsupported 등)를 오류 문자열로 반환한다.
	PresentImage(image unsafe.Pointer, token_id uint32, nonce [16]byte, width, height, scale float64) error
	// FocusImage 는 영역을 첫 응답자로 만들고 포커스 이벤트를 보낸다.
	FocusImage(image unsafe.Pointer)
	// CaretImage 는 캐럿(입력 커서) 위치를 받아 둔다.
	CaretImage(image unsafe.Pointer, x, y, w, h float64)
	// TextImage 는 접근성 값으로 보일 문자열을 받아 둔다.
	TextImage(image unsafe.Pointer, utf8 string)
	// FactsImage 는 영역의 모든 정보를 JSON 으로 반환한다.
	FactsImage(image unsafe.Pointer) (string, error)
	// CloseImage 는 그림 영역을 제거한다. 이후 event 는 호출되지 않는다.
	CloseImage(image unsafe.Pointer)

	// BeginLayout 은 표면 배치 트랜잭션을 시작한다. 배치가 가능해지면 ready 를 UI 스레드에서 호출한다.
	BeginLayout(window unsafe.Pointer, ticket uint64, ready func(allowed bool)) error
	// CommitLayout 은 ticket 의 배치를 확정하고 확정했는지 반환한다.
	CommitLayout(window unsafe.Pointer, ticket uint64) bool
	// CancelLayout 은 진행 중인 배치를 취소한다.
	CancelLayout(window unsafe.Pointer) error
	// AfterPresentation 은 열린 배치를 커밋하기 전에 앱 문서의 표시 준비를 확인한다.
	AfterPresentation(window unsafe.Pointer, done func()) error
	// AfterSettled 는 창에 열린 표면 배치 트랜잭션이 없는 상태에서 메인 웹뷰와 보이는 앱 문서가 화면을
	// 표시한 뒤 done 을 UI 스레드에서 호출한다. displayed 는 그 화면이 표시되는 시각(ms, mach 절대 시각)이다.
	AfterSettled(window unsafe.Pointer, done func(displayed float64, err error)) error
	// InjectSettledFailure makes the next settled wait fail in a diagnostics build.
	InjectSettledFailure(window unsafe.Pointer) error

	// CreateShape 는 표면 위에 그리는 도형 뷰를 만든다. 창에 콘텐츠 뷰가 없으면 nil 핸들을 반환한다.
	CreateShape(window unsafe.Pointer, x, y, w, h float64) (unsafe.Pointer, error)
	SetShapeFrame(shape unsafe.Pointer, x, y, w, h float64)
	// SetShapeStyle 은 모서리 반경, 선 두께, 채움 색과 선 색을 정한다. 색은 0-1 범위의 sRGB 와 알파다.
	SetShapeStyle(shape unsafe.Pointer, radius, lineWidth float64, fill, line [4]float64)
	// RaiseShape 는 도형을 형제 뷰들 위로 올린다.
	RaiseShape(shape unsafe.Pointer)
	DestroyShape(shape unsafe.Pointer)

	// WatchInput 은 창의 누름, 끌기와 키 입력을 감시하고 감시 번호를 반환한다.
	WatchInput(window unsafe.Pointer, input Input) (uintptr, error)
	// UnwatchInput 은 WatchInput 이 반환한 감시를 해제한다.
	UnwatchInput(monitor uintptr)

	// InjectPointer 는 창의 콘텐츠 영역 좌표 (x, y) 에 포인터 입력을 전달하고 그 결과를 반환한다.
	// phase 는 이동 0, 누름 1, 끌기 2, 뗌 3, 스크롤 4 이고 button 은 왼쪽 0, 오른쪽 1 이다.
	// 누름과 뗌은 좌표의 문서가 그 이벤트를 받거나 receive 초가 지난 뒤 done 을 UI 스레드에서 호출한다.
	// 다른 단계는 전달한 즉시 호출한다.
	InjectPointer(window unsafe.Pointer, x, y float64, phase, button int, deltaX, deltaY, receive float64, done func(PointerResult)) error
	// ActivateWindow 는 애플리케이션과 창을 활성화한다. 좌표의 웹뷰만 활성 상태를 받은 뒤
	// done(nil) 을, timeout 초 안에 끝나지 않으면 멈춘 단계를 적은 오류로 done 을 UI 스레드에서
	// 호출한다. 좌표가 네이티브 표면이면 웹뷰 상태를 기다리지 않는다.
	ActivateWindow(window unsafe.Pointer, x, y, timeout float64, done func(error)) error
	// InjectKey 는 창에 키 입력을 전달하고 전달했는지 반환한다. modifiers 는 1 Shift, 2 Control,
	// 4 Option, 8 Command 의 비트 합이다.
	InjectKey(window unsafe.Pointer, key, text string, modifiers uint, down bool) (bool, error)

	// Listen 은 directory 안에 로컬 엔드포인트의 리스너를 만든다. directory 는 현재 사용자 전용이어야
	// 한다. application 은 주소 이름에 들어간다.
	// 리스너를 닫으면 주소도 제거된다.
	Listen(directory, application string) (net.Listener, Endpoint, error)
	// ServiceProcessExists checks whether a persisted sidecar service process is
	// still alive before its endpoint is reused after an application restart.
	ServiceProcessExists(pid int) bool

	// OnTermination 은 종료 신호(SIGTERM, SIGINT, SIGHUP)를 처음 받으면 quit 를 호출하게 한다. 그
	// 뒤의 종료 신호는 기본 동작으로 프로세스를 끝낸다.
	OnTermination(quit func()) error

	// InstantWindowResize 는 창 확대와 애니메이션 크기 변경을 한 화면 갱신 안에 끝나게 한다.
	// 창을 만들기 전에 호출한다.
	InstantWindowResize() error

	// InstallDock 은 Dock 메뉴를 등록한다. 새 창 항목은 newWindow 를 호출한다.
	InstallDock(newWindow func()) error
	// DockItems 는 Dock 메뉴 항목의 제목을 JSON 배열로 반환한다. UI 스레드에서 호출한다.
	DockItems() (string, error)
	// MenuItems 는 애플리케이션 메뉴를 JSON 배열로 반환한다. 하위 메뉴마다 {title, items: [{title, key}]} 다.
	// UI 스레드에서 호출한다.
	MenuItems() (string, error)
	// MenuSelect 는 제목이 menu 인 하위 메뉴에서 제목이 title 인 항목을 실행한다. UI 스레드에서 호출한다.
	MenuSelect(menu, title string) error
	// MainWindow 는 애플리케이션의 주 창 핸들이다. 없으면 nil 이다. UI 스레드에서 호출한다.
	MainWindow() unsafe.Pointer
	// DockSelect 는 제목이 title 인 Dock 메뉴 항목을 실행한다. UI 스레드에서 호출한다.
	DockSelect(title string) error

	// DirectoryIdentity 는 디렉터리를 식별하는 문자열을 반환한다.
	DirectoryIdentity(path string, info os.FileInfo) (string, error)
}

// PointerResult 는 포인터 입력 전달의 결과다.
type PointerResult int

const (
	// PointerDelivered 는 입력을 전달했다는 뜻이다.
	PointerDelivered PointerResult = iota
	// PointerRejected 는 창, 좌표 또는 단계가 올바르지 않아 전달하지 않았다는 뜻이다.
	PointerRejected
	// PointerInactive 는 버튼 없는 이동이고 창이 키 창이 아니어서 전달하지 않았다는 뜻이다.
	PointerInactive
	// PointerUnreceived 는 누름이나 뗌을 전달했지만 문서가 제한 시간 안에 받지 않았다는 뜻이다.
	PointerUnreceived
	// PointerButtonHeld 는 실제 마우스 버튼이 눌려 있어 누름이나 뗌을 전달하지 않았다는 뜻이다.
	PointerButtonHeld
)

// Endpoint 는 로컬 엔드포인트의 전송과 주소다.
type Endpoint struct {
	// Transport 는 unix 또는 pipe 다.
	Transport string
	Address   string
}

var (
	mu      sync.Mutex
	current Platform
)

// Register 는 현재 운영체제의 구현을 등록한다. 두 번 등록하면 실패한다.
func Register(p Platform) {
	mu.Lock()
	defer mu.Unlock()
	if current != nil {
		panic("platform: implementation registered twice")
	}
	current = p
}

// Current 는 등록된 구현을 반환한다. 등록된 구현이 없으면 오류를 반환한다.
func Current() (Platform, error) {
	mu.Lock()
	defer mu.Unlock()
	if current == nil {
		return nil, errors.New("no platform implementation is registered")
	}
	return current, nil
}
