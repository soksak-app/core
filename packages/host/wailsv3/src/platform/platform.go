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

// WebviewOptions 는 앱이 만드는 네이티브 웹뷰의 생성 값이다.
type WebviewOptions struct {
	// Identifier 는 웹뷰가 보낸 메시지에 붙는 번호다.
	Identifier uint64
	// Script 는 각 문서가 시작할 때 실행하는 스크립트다.
	Script              string
	X, Y, Width, Height float64
	Hidden, Transparent bool
	// FillParent 는 부모 뷰의 크기를 따라 크기를 바꿀지 나타낸다.
	FillParent bool
	// Receive 는 웹뷰의 문서가 보낸 메시지를 받는다. UI 스레드 밖에서 호출된다.
	Receive func(identifier uint64, body string)
}

// Input 은 표면 위 입력을 받는 함수들이다.
type Input struct {
	// Press 는 누른 뷰가 표면인지 반환하고, 표면이면 그 사실을 전달한다.
	Press func(view uintptr) bool
	// Point 는 왼쪽 단추 끌기의 한 단계를 페이지 좌표로 전달한다. phase 는 누름 0, 이동 1, 뗌 2 이다.
	Point func(phase int, x, y float64)
}

// Platform 은 운영체제마다 다른 동작이다.
//
// 오류를 반환하지 않는 함수는 오류를 반환하는 생성 함수가 만든 핸들만 받는다.
type Platform interface {
	// PrepareWindow 는 창의 콘텐츠 뷰와 메인 웹뷰의 크기를 맞춘다.
	PrepareWindow(window unsafe.Pointer) error
	// PlaceWindowControls 는 창 단추의 왼쪽 위 모서리를 콘텐츠 왼쪽 위 기준 (x, y) 에 둔다.
	PlaceWindowControls(window unsafe.Pointer, x, y float64) error
	// WindowControls 는 창 단추가 차지하는 영역을 페이지 좌표로 반환한다.
	WindowControls(window unsafe.Pointer) (Rect, error)
	// WindowNumbers 는 창과 자식 창의 윈도 서버 번호를 반환한다. 창 자신의 번호가 처음이다.
	WindowNumbers(window unsafe.Pointer) ([]int, error)
	// Probe 는 네이티브 검사 요청(JSON)을 실행하고 결과(JSON)를 reply 에 전달한다. reply 는 요청마다
	// 한 번 호출되고, 요청을 실행하는 동안 또는 그 뒤에 UI 스레드에서 호출된다.
	Probe(window unsafe.Pointer, request string, reply func(string)) error

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
	// SetWebviewAlpha 는 뷰의 불투명도를 정한다.
	SetWebviewAlpha(view unsafe.Pointer, alpha float64)
	// SetWebviewResizing 은 연속 크기 변경의 시작과 종료를 뷰에 전달한다.
	SetWebviewResizing(view unsafe.Pointer, live bool)
	// ConfigureModal 은 모달 웹뷰의 접근성 이름과 모서리 반경을 정한다.
	ConfigureModal(view unsafe.Pointer, title string, radius float64)
	// FocusModal 은 키보드 초점을 모달 웹뷰로 옮기거나 메인 웹뷰로 되돌린다.
	FocusModal(view unsafe.Pointer, take bool)
	// AlignRect 는 페이지 좌표의 영역을 디스플레이 픽셀에 안쪽으로 맞춘다.
	AlignRect(window unsafe.Pointer, at Rect) (Rect, error)

	// BeginLayout 은 표면 배치 트랜잭션을 시작한다. 배치가 가능해지면 ready 를 UI 스레드에서 호출한다.
	BeginLayout(window unsafe.Pointer, ticket uint64, ready func(allowed bool)) error
	// CommitLayout 은 ticket 의 배치를 확정하고 확정했는지 반환한다.
	CommitLayout(window unsafe.Pointer, ticket uint64) bool
	// CancelLayout 은 진행 중인 배치를 취소한다.
	CancelLayout(window unsafe.Pointer) error
	// AfterPresentation 은 메인 웹뷰가 다음 화면을 표시한 뒤 done 을 UI 스레드에서 호출한다.
	AfterPresentation(window unsafe.Pointer, done func()) error

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

	// CaptureOpen 은 윈도 서버 번호 windowNumber 의 창을 녹화 대상으로 정한다.
	CaptureOpen(windowNumber int) error
	// CaptureStart 는 directory 에 프레임 기록을 시작한다.
	CaptureStart(directory string) error
	// CaptureWait 는 첫 프레임이 기록되었는지 반환한다.
	CaptureWait() (bool, error)
	// CaptureStop 은 녹화를 끝내고 기록한 프레임 수를 반환한다.
	CaptureStop() (int, error)

	// InjectPointer 는 창의 콘텐츠 영역 좌표 (x, y) 에 포인터 입력을 전달하고 그 결과를 반환한다.
	// phase 는 이동 0, 누름 1, 끌기 2, 뗌 3, 스크롤 4 이고 button 은 왼쪽 0, 오른쪽 1 이다.
	InjectPointer(window unsafe.Pointer, x, y float64, phase, button int, deltaX, deltaY float64) (PointerResult, error)
	// ActivateWindow 는 애플리케이션을 활성화하고 창을 키 창으로 만든다. 창의 모든 웹뷰가 활성
	// 상태를 받은 뒤 done(true) 를, timeout 초 안에 활성화되지 않으면 done(false) 를 UI 스레드에서 호출한다.
	ActivateWindow(window unsafe.Pointer, timeout float64, done func(ok bool)) error
	// InjectKey 는 창에 키 입력을 전달하고 전달했는지 반환한다. modifiers 는 1 Shift, 2 Control,
	// 4 Option, 8 Command 의 비트 합이다.
	InjectKey(window unsafe.Pointer, key, text string, modifiers uint, down bool) (bool, error)

	// Listen 은 로컬 엔드포인트의 리스너를 만든다. application 은 주소 이름에 들어간다.
	// 리스너를 닫으면 주소도 제거된다.
	Listen(application string) (net.Listener, Endpoint, error)

	// InstallDock 은 Dock 메뉴를 등록한다. 새 창 항목은 newWindow 를 호출한다.
	InstallDock(newWindow func()) error

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
