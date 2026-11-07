//go:build darwin

package darwin

import (
	"errors"
	"fmt"

	"unsafe"

	handles "github.com/soksak-app/core/packages/host/go/src/callback"
	"github.com/soksak-app/core/packages/host/go/src/platform"
	"github.com/soksak-app/core/packages/host/go/src/routine"
)

// dispatcher passes the commit and the messages of a web view to the receiver function. The receiver function is that of the last created web view, and the host
// passes the same function to all web views.
var dispatcher platform.Dispatcher

func goHost_native_committed(identifier uint64) {
	dispatcher.Commit(uint64(identifier))
}

// terminated receives the end of the WebContent process of the web views; the host passes the same function to all web views, as the dispatcher does.
var terminated func(identifier uint64)

func goHost_native_terminated(identifier uint64) {
	if receiver := terminated; receiver != nil {
		routine.Go("webview-terminated", func() { receiver(uint64(identifier)) })
	}
}

func goHost_native_message(identifier uint64, message *byte) {
	dispatcher.Message(uint64(identifier), native.GoString(message))
}

func (implementation) CreateWebview(window platform.Window, options platform.WebviewOptions) (unsafe.Pointer, error) {
	dispatcher.Handle(options.Receive, options.Committed)
	terminated = options.Terminated
	script := native.CString(options.Script)
	defer native.Free(unsafe.Pointer(script))
	name := native.CString(options.Name)
	defer native.Free(unsafe.Pointer(name))
	handle := native.NativeWebviewCreate(uintptr(window), uint64(options.Identifier), name, script,
		float64(options.X), float64(options.Y), float64(options.Width), float64(options.Height),
		bool(options.Hidden), bool(options.Transparent))
	if handle == nil {
		return nil, fmt.Errorf("cannot create a native webview in this window/WebKit")
	}
	return handle, nil
}

func (implementation) NavigateWebview(view unsafe.Pointer, url string) bool {
	target := native.CString(url)
	defer native.Free(unsafe.Pointer(target))
	return bool(native.NativeWebviewNavigate(view, target))
}

func (implementation) SetWebviewBounds(view unsafe.Pointer, x, y, width, height float64) {
	native.NativeWebviewBounds(view, float64(x), float64(y), float64(width), float64(height))
}

func (implementation) SetWebviewHidden(view unsafe.Pointer, hidden bool) {
	native.NativeWebviewHidden(view, bool(hidden))
}

func (implementation) SetWebviewBackground(view unsafe.Pointer, enabled bool) {
	native.NativeWebviewBackground(view, bool(enabled))
}

func (implementation) EvaluateScript(view unsafe.Pointer, script string) {
	value := native.CString(script)
	defer native.Free(unsafe.Pointer(value))
	native.NativeWebviewEval(view, value)
}

func (implementation) CloseWebview(view unsafe.Pointer) { native.NativeWebviewClose(view) }

func (implementation) ConfigureMainWindow(window platform.Window, dark bool) error {
	if !bool(native.NativeWindowConfigureMain(uintptr(window), bool(dark))) {
		return errors.New("the window has no main webview or the requested appearance is unavailable")
	}
	return nil
}

func goHost_file_dropped(context uintptr, json *byte) {
	dropped := handles.Handle(uintptr(context)).Value().(func(string))
	dropped(native.GoString(json))
}

// Clears the handle when the drop view no longer uses the receiver.
func goHost_file_drop_released(context uintptr) {
	handles.Handle(uintptr(context)).Delete()
}

func (implementation) FileDrop(main unsafe.Pointer, dropped func(json string)) error {
	handle := handles.NewHandle(dropped)
	if !bool(native.WindowFileDrop(main, uintptr(handle))) {
		handle.Delete()
		return fmt.Errorf("the main webview has no window composition for file drops")
	}
	return nil
}

func (implementation) SetMainWebview(window platform.Window) error {
	if bool(native.NativeWindowSetMainWebview(uintptr(window))) {
		return nil
	}
	return fmt.Errorf("the main webview is not in the window hierarchy")
}

func (implementation) MainWebview(window platform.Window) (unsafe.Pointer, error) {
	main := native.MainSpWindowMainWebview(uintptr(window))
	if main == nil {
		return nil, fmt.Errorf("the window has no registered app DOM webview")
	}
	return main, nil
}

func (implementation) CollectGarbage(view unsafe.Pointer) error {
	if bool(native.MainSpWebviewCollectGarbage(view)) {
		return nil
	}
	return fmt.Errorf("the JavaScript garbage collection request is unavailable")
}

func (implementation) NativeView(window platform.Window) unsafe.Pointer {
	return native.MainSpWindowNativeView(uintptr(window))
}

func (implementation) RetainView(view unsafe.Pointer) { native.MainViewRetain(view) }

func (implementation) ReleaseView(view unsafe.Pointer) { native.MainViewRelease(view) }

func (implementation) CreateSurface(window platform.Window) (unsafe.Pointer, error) {
	handle := native.MainSpSurfaceCreate(uintptr(window))
	if handle == nil {
		return nil, fmt.Errorf("cannot create SurfaceHost")
	}
	return handle, nil
}

func (implementation) CloseSurface(surface unsafe.Pointer) { native.MainSpSurfaceClose(surface) }
func (implementation) SetSurfaceBounds(surface unsafe.Pointer, x, y, width, height float64) {
	native.MainWebviewSetFrame(surface, float64(x), float64(y), float64(width), float64(height))
}

// SurfaceFrame returns the current region of a surface. The host fits the declared region to pixels, so
// it can differ from the region that the page sent, and the page receives that difference.
func (implementation) SurfaceFrame(surface unsafe.Pointer) platform.Rect {
	var out [4]float64
	native.MainWebviewGetFrame(surface, &out[0])
	return platform.Rect{X: float64(out[0]), Y: float64(out[1]), W: float64(out[2]), H: float64(out[3])}
}
func (implementation) SetSurfaceHiddenHandle(surface unsafe.Pointer, hidden bool) {
	native.MainWebviewSetSurfaceHidden(surface, bool(hidden))
}
func (implementation) FocusSurface(surface unsafe.Pointer) { native.MainSpSurfaceFocus(surface) }
func (implementation) FocusSurfaceForRegion(surface unsafe.Pointer) {
	native.MainSpSurfaceFocusForRegion(surface)
}
func (implementation) FocusWorkbench(window platform.Window) {
	native.MainSpWindowFocusWorkbench(uintptr(window))
}
func (implementation) KeyboardHold(window platform.Window) {
	native.MainSpWindowKeyboardHold(uintptr(window))
}
func (implementation) KeyboardDecided(window platform.Window) {
	native.MainSpWindowKeyboardDecided(uintptr(window))
}
func (implementation) ModalHold(window platform.Window) {
	native.MainSpWindowModalHold(uintptr(window))
}
func (implementation) ModalHoldEnd(window platform.Window) {
	native.MainSpWindowModalHoldEnd(uintptr(window))
}
func (implementation) SetSurfaceAlphaHandle(surface unsafe.Pointer, alpha float64) {
	native.MainWebviewSetSurfaceAlpha(surface, float64(alpha))
}
func (implementation) SetWindowOverlays(main unsafe.Pointer, overlays []platform.WindowOverlay) error {
	if main == nil {
		return fmt.Errorf("cannot set window overlays without the registered main webview")
	}
	packed := platform.VisibleWindowOverlayRects(overlays)
	values := make([]float64, len(packed))
	for i, value := range packed {
		values[i] = float64(value)
	}
	var data *float64
	if len(values) > 0 {
		data = &values[0]
	}
	native.MainSpSurfaceSetWindowOverlays(main, data, uint64(len(values)/4))
	return nil
}

// surfaceOverlayValues returns the values of the native overlay call: five per overlay, the left, top, right and bottom insets and then 1 when visible or 0 when not.
func surfaceOverlayValues(overlays []platform.DOMOverlay) []float64 {
	values := make([]float64, 0, len(overlays)*5)
	for _, overlay := range overlays {
		visible := 0.0
		if overlay.Visible {
			visible = 1
		}
		values = append(values, overlay.Left, overlay.Top, overlay.Right, overlay.Bottom, visible)
	}
	return values
}

func (implementation) SetSurfaceOverlays(view unsafe.Pointer, overlays []platform.DOMOverlay) {
	floats := surfaceOverlayValues(overlays)
	values := make([]float64, len(floats))
	for index, value := range floats {
		values[index] = float64(value)
	}
	var data *float64
	if len(values) > 0 {
		data = &values[0]
	}
	native.MainWebviewSetSurfaceOverlays(view, data, uint64(len(overlays)))
}

func (implementation) ConfigureModal(view unsafe.Pointer, title string, radius float64) {
	name := native.CString(title)
	defer native.Free(unsafe.Pointer(name))
	native.ModalViewConfigure(view, name, float64(radius))
}

func (implementation) FocusModal(view unsafe.Pointer, take bool) {
	value := int32(0)
	if take {
		value = 1
	}
	native.ModalViewFocus(view, value)
}

func (implementation) AlignRect(window platform.Window, at platform.Rect) (platform.Rect, error) {
	var out [4]float64
	native.ModalAligned(uintptr(window), float64(at.X), float64(at.Y), float64(at.W), float64(at.H), &out[0])
	return platform.Rect{X: float64(out[0]), Y: float64(out[1]), W: float64(out[2]), H: float64(out[3])}, nil
}
