//go:build windows

package windows

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"unsafe"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// implementation 은 Windows 의 platform.Platform 이다.
type implementation struct{}

func init() { platform.Register(implementation{}) }

// unsupported 는 Windows 에 구현하지 않은 동작 name 의 오류를 반환한다.
func unsupported(name string) error {
	return fmt.Errorf("%s is not implemented on windows", name)
}

// unreachable 은 오류 결과가 없는 동작에서 실패한다. Windows 에서 Run 은 창을 열기 전에 미구현 오류로
// 끝나므로 이 동작은 호출되지 않는다. 호출되면 그 시작 계약이 깨진 것이므로 동작 이름의 오류로 멈춘다.
func unreachable(name string) {
	panic(unsupported(name))
}

func (implementation) PrepareWindow(unsafe.Pointer) error {
	return unsupported("window preparation")
}

func (implementation) EnqueueUI(func()) error {
	return unsupported("UI queue")
}

func (implementation) Fullscreen(unsafe.Pointer, bool, func()) error {
	return unsupported("full screen")
}

func (implementation) TitlebarHeight(unsafe.Pointer) (float64, error) {
	return 0, unsupported("window title bar")
}

func (implementation) SetTitlebarHeight(unsafe.Pointer, float64) error {
	return unsupported("window title bar")
}

func (implementation) WindowControls(unsafe.Pointer) (platform.Rect, error) {
	return platform.Rect{}, unsupported("window controls")
}

func (implementation) WindowFacts(unsafe.Pointer) (string, error) {
	return "", unsupported("window state")
}
func (implementation) ConfigureMainWindow(unsafe.Pointer, bool) error {
	return unsupported("main window configuration")
}
func (implementation) RevealAfterLoad(unsafe.Pointer) error {
	return unsupported("window reveal")
}
func (implementation) SetMainWebview(unsafe.Pointer) error {
	return unsupported("main webview identity")
}
func (implementation) FileDrop(unsafe.Pointer, func(string)) error {
	return unsupported("file drop")
}
func (implementation) MainWebview(unsafe.Pointer) (unsafe.Pointer, error) {
	return nil, unsupported("main webview identity")
}
func (implementation) KillWebContentProcess(unsafe.Pointer) error {
	return unsupported("WebContent process termination")
}

func (implementation) CollectGarbage(unsafe.Pointer) error {
	return unsupported("JavaScript garbage collection")
}

func (implementation) ClipboardRead(string) (platform.ClipboardValue, error) {
	return platform.ClipboardValue{}, unsupported("clipboard read")
}
func (implementation) ClipboardWriteText(string) error { return unsupported("clipboard text write") }
func (implementation) ClipboardWritePNG([]byte) error  { return unsupported("clipboard PNG write") }
func (implementation) OpenLink(string) error           { return unsupported("link open") }
func (implementation) StartNotifications(func(string)) error {
	return unsupported("system notifications")
}
func (implementation) PostNotification(string, string, string) error {
	return unsupported("system notifications")
}
func (implementation) RemoveNotification(string) error { return unsupported("system notifications") }

func (implementation) WindowHit(unsafe.Pointer, float64, float64) (string, error) {
	return "", unsupported("window hit testing")
}

func (implementation) MoveWindow(unsafe.Pointer, float64, float64) error {
	return unsupported("window placement")
}

func (implementation) Screens() (string, error) {
	return "", unsupported("display list")
}

func (implementation) OnTermination(func()) error {
	return unsupported("termination requests")
}

func (implementation) OnQuitRequest(func()) error {
	return unsupported("quit requests")
}

// AnswerQuitRequests 는 받은 종료 요청이 없으므로 답할 것이 없다. OnQuitRequest 가 실패하면 애플리케이션이 시작하지 않는다.
func (implementation) AnswerQuitRequests() {}

func (implementation) InstantWindowResize() error {
	return unsupported("window resize animation")
}

func (implementation) ReplaceStandardError(*os.File) error {
	return unsupported("standard error replacement")
}

func (implementation) DockItems() (string, error) {
	return "", unsupported("Dock menu")
}

func (implementation) MenuItems() (string, error) {
	return "", unsupported("application menu")
}

func (implementation) PreferredLanguage() (string, error) {
	return "", unsupported("preferred language")
}

func (implementation) MenuSelect(string, string) error {
	return unsupported("application menu")
}

func (implementation) MainWindow() (unsafe.Pointer, error) {
	return nil, unsupported("main window")
}

func (implementation) DockSelect(string) error {
	return unsupported("Dock menu")
}

func (implementation) CreateWebview(unsafe.Pointer, platform.WebviewOptions) (unsafe.Pointer, error) {
	return nil, unsupported("native webview")
}

func (implementation) NavigateWebview(unsafe.Pointer, string) bool {
	unreachable("native webview navigation")
	return false
}

func (implementation) SetWebviewBounds(unsafe.Pointer, float64, float64, float64, float64) {
	unreachable("native webview bounds")
}

func (implementation) SetWebviewHidden(unsafe.Pointer, bool) {
	unreachable("native webview visibility")
}

func (implementation) SetWebviewBackground(unsafe.Pointer, bool) {
	unreachable("native webview background")
}

func (implementation) EvaluateScript(unsafe.Pointer, string) {
	unreachable("native webview script evaluation")
}

func (implementation) CreateDocument(unsafe.Pointer, string, func(string)) (unsafe.Pointer, error) {
	return nil, unsupported("document view")
}

func (implementation) SetDocumentEvent(unsafe.Pointer, func(string)) error {
	return unsupported("document events")
}

func (implementation) LoadDocument(unsafe.Pointer, string) bool {
	unreachable("document navigation")
	return false
}

func (implementation) ZoomDocument(unsafe.Pointer, float64) bool {
	unreachable("document zoom")
	return false
}

func (implementation) GoDocument(unsafe.Pointer, int, int) bool {
	unreachable("document history")
	return false
}

func (implementation) PlaceDocument(unsafe.Pointer, float64, float64, float64, float64, bool) {
	unreachable("document placement")
}

func (implementation) SetDocumentBackground(unsafe.Pointer, bool) {
	unreachable("document background")
}

func (implementation) SetDocumentAppearance(unsafe.Pointer, bool) {
	unreachable("document appearance")
}

func (implementation) CloseDocument(unsafe.Pointer) {
	unreachable("document removal")
}

func (implementation) CloseWebview(unsafe.Pointer) {
	unreachable("native webview close")
}

func (implementation) WebviewFrame(unsafe.Pointer) platform.Rect {
	unreachable("native webview frame")
	return platform.Rect{}
}

func (implementation) CreateSurface(unsafe.Pointer) (unsafe.Pointer, error) {
	return nil, unsupported("surface host")
}

func (implementation) CloseSurface(unsafe.Pointer) {
	unreachable("surface host removal")
}

func (implementation) SetSurfaceBounds(unsafe.Pointer, float64, float64, float64, float64) {
	unreachable("surface host placement")
}

func (implementation) SurfaceFrame(unsafe.Pointer) platform.Rect {
	unreachable("surface host frame")
	return platform.Rect{}
}

func (implementation) SetSurfaceHiddenHandle(unsafe.Pointer, bool) {
	unreachable("surface visibility")
}

func (implementation) SetSurfaceAlphaHandle(unsafe.Pointer, float64) {
	unreachable("surface opacity")
}

func (implementation) SetWindowOverlays(unsafe.Pointer, []platform.WindowOverlay) error {
	return unsupported("window DOM overlays")
}

func (implementation) SetWebviewAlpha(unsafe.Pointer, float64) {
	unreachable("native webview alpha")
}

func (implementation) SetSurfaceOverlays(unsafe.Pointer, []platform.DOMOverlay) {
	unreachable("surface DOM overlays")
}

func (implementation) SetWebviewResizing(unsafe.Pointer, bool) {
	unreachable("native webview live resize")
}

func (implementation) ConfigureModal(unsafe.Pointer, string, float64) {
	unreachable("modal configuration")
}

func (implementation) FocusModal(unsafe.Pointer, bool) {
	unreachable("modal focus")
}

func (implementation) AlignRect(unsafe.Pointer, platform.Rect) (platform.Rect, error) {
	return platform.Rect{}, unsupported("pixel alignment")
}

func (implementation) BeginLayout(unsafe.Pointer, uint64, func(bool)) error {
	return unsupported("surface layout")
}

func (implementation) CommitLayout(unsafe.Pointer, uint64) bool {
	unreachable("surface layout commit")
	return false
}

func (implementation) CancelLayout(unsafe.Pointer) error {
	return unsupported("surface layout cancel")
}

func (implementation) StartPageTitlebar(unsafe.Pointer, uint64, float64, func(error)) error {
	return unsupported("start title bar")
}

func (implementation) AfterSettled(unsafe.Pointer, func(float64, error)) error {
	return unsupported("native presentation")
}

func (implementation) InjectSettledFailure(unsafe.Pointer) error {
	return unsupported("native presentation")
}

func (implementation) AfterPresentation(unsafe.Pointer, func()) error {
	return unsupported("native presentation")
}

func (implementation) CreateShape(unsafe.Pointer, float64, float64, float64, float64) (unsafe.Pointer, error) {
	return nil, unsupported("native shapes")
}

func (implementation) SetShapeFrame(unsafe.Pointer, float64, float64, float64, float64) {
	unreachable("native shape frame")
}

func (implementation) SetShapeStyle(unsafe.Pointer, float64, float64, [4]float64, [4]float64) {
	unreachable("native shape style")
}

func (implementation) RaiseShape(unsafe.Pointer) {
	unreachable("native shape raise")
}

func (implementation) DestroyShape(unsafe.Pointer) {
	unreachable("native shape destroy")
}

func (implementation) WatchInput(unsafe.Pointer, platform.Input) (uintptr, error) {
	return 0, unsupported("surface input")
}

func (implementation) UnwatchInput(uintptr) {
	unreachable("surface input release")
}

func (implementation) WatchButtons(func(uint64)) error {
	return unsupported("mouse button state")
}

func (implementation) InjectPointer(unsafe.Pointer, float64, float64, int, int, float64, float64, float64, func(platform.PointerResult, platform.ButtonHeld)) error {
	return unsupported("native pointer input")
}

func (implementation) ActivateWindow(unsafe.Pointer, float64, float64, float64, func(error)) error {
	return unsupported("window activation")
}

func (implementation) InjectKey(unsafe.Pointer, string, string, uint, bool) (platform.PointerResult, error) {
	return platform.PointerRejected, unsupported("native key input")
}

func (implementation) Listen(string, string) (net.Listener, platform.Endpoint, error) {
	return nil, platform.Endpoint{}, unsupported("local endpoint")
}

func (implementation) ServiceProcessExists(int) (bool, error) {
	return false, unsupported("service process inspection")
}

func (implementation) NewSession(*exec.Cmd) error {
	return unsupported("new process session")
}

func (implementation) InstallDock(func()) error {
	return unsupported("Dock menu")
}

func (implementation) CreateImage(unsafe.Pointer, string, func(string)) (unsafe.Pointer, error) {
	return nil, unsupported("image view")
}

func (implementation) PlaceImage(unsafe.Pointer, float64, float64, float64, float64, bool) {
	unreachable("image placement")
}

func (implementation) SurfacePlacedImage(unsafe.Pointer) bool {
	unreachable("image surface placement")
	return false
}

func (implementation) RasterImage(unsafe.Pointer) (int, int, float64, bool) {
	unreachable("image raster geometry")
	return 0, 0, 0, false
}

func (implementation) PresentImage(unsafe.Pointer, uint32, [16]byte, float64, float64, float64) error {
	return unsupported("image presentation")
}

func (implementation) FocusImage(unsafe.Pointer) {
	unreachable("image focus")
}

func (implementation) CaretImage(unsafe.Pointer, float64, float64, float64, float64) {
	unreachable("image caret")
}

func (implementation) TextImage(unsafe.Pointer, string) {
	unreachable("image text")
}

func (implementation) FactsImage(unsafe.Pointer) (string, error) {
	return "", unsupported("image facts")
}

func (implementation) CloseImage(unsafe.Pointer) {
	unreachable("image removal")
}
