//go:build windows

package windows

import (
	"fmt"
	"net"
	"unsafe"

	"github.com/min-median-max/soksak/packages/host/wailsv3/src/platform"
)

// implementation 은 Windows 의 platform.Platform 이다.
type implementation struct{}

func init() { platform.Register(implementation{}) }

// unsupported 는 Windows 에 구현하지 않은 동작 name 의 오류를 반환한다.
func unsupported(name string) error {
	return fmt.Errorf("%s is not implemented on windows", name)
}

// unreachable 은 핸들을 받는 동작에서 실패한다. 핸들을 만드는 함수가 모두 오류를 반환하므로
// 이 동작에 전달할 핸들은 없다.
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

func (implementation) UnifiedTitlebar(unsafe.Pointer) (float64, error) {
	return 0, unsupported("window title bar")
}

func (implementation) WindowControls(unsafe.Pointer) (platform.Rect, error) {
	return platform.Rect{}, unsupported("window controls")
}

func (implementation) WindowFacts(unsafe.Pointer) (string, error) {
	return "", unsupported("window state")
}
func (implementation) ConfigureMainWindow(unsafe.Pointer, bool) {}
func (implementation) SetMainWebview(unsafe.Pointer) error {
	return unsupported("main webview identity")
}
func (implementation) MainWebview(unsafe.Pointer) (unsafe.Pointer, error) {
	return nil, unsupported("main webview identity")
}

func (implementation) ClipboardRead(string) (platform.ClipboardValue, error) {
	return platform.ClipboardValue{}, unsupported("clipboard read")
}
func (implementation) ClipboardWriteText(string) error { return unsupported("clipboard text write") }
func (implementation) ClipboardWritePNG([]byte) error  { return unsupported("clipboard PNG write") }

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

func (implementation) InstantWindowResize() error {
	return unsupported("window resize animation")
}

func (implementation) DockItems() (string, error) {
	return "", unsupported("Dock menu")
}

func (implementation) MenuItems() (string, error) {
	return "", unsupported("application menu")
}

func (implementation) MenuSelect(string, string) error {
	return unsupported("application menu")
}

func (implementation) MainWindow() unsafe.Pointer { return nil }

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

func (implementation) GoDocument(unsafe.Pointer, int) bool {
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
	return nil, missing("surface hosts")
}
func (implementation) CloseSurface(unsafe.Pointer)                                         {}
func (implementation) SetSurfaceBounds(unsafe.Pointer, float64, float64, float64, float64) {}
func (implementation) SurfaceFrame(unsafe.Pointer) platform.Rect                           { return platform.Rect{} }
func (implementation) SetSurfaceHiddenHandle(unsafe.Pointer, bool)                         {}
func (implementation) SetSurfaceAlphaHandle(unsafe.Pointer, float64)                       {}
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

func (implementation) InjectPointer(unsafe.Pointer, float64, float64, int, int, float64, float64, float64, func(platform.PointerResult)) error {
	return unsupported("native pointer input")
}

func (implementation) ActivateWindow(unsafe.Pointer, float64, float64, float64, func(error)) error {
	return unsupported("window activation")
}

func (implementation) InjectKey(unsafe.Pointer, string, string, uint, bool) (bool, error) {
	return false, unsupported("native key input")
}

func (implementation) Listen(string, string) (net.Listener, platform.Endpoint, error) {
	return nil, platform.Endpoint{}, unsupported("local endpoint")
}

func (implementation) ServiceProcessExists(pid int) bool {
	return pid > 0
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

func (implementation) RasterImage(unsafe.Pointer) (int, int, float64, bool) {
	unreachable("image raster geometry")
	return 0, 0, 0, false
}

func (implementation) PresentImage(unsafe.Pointer, uint32, [16]byte, float64, float64, float64) error {
	unreachable("image presentation")
	return nil
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
	return "", unreachableError("image facts")
}

func (implementation) CloseImage(unsafe.Pointer) {
	unreachable("image removal")
}
