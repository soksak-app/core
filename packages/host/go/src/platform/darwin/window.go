//go:build darwin

package darwin

import (
	"errors"
	"fmt"

	"unsafe"

	handles "github.com/soksak-app/core/packages/host/go/src/callback"
	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// implementation is the platform.Platform of macOS.
type implementation struct{}

func init() { platform.Register(implementation{}) }

func (implementation) PrepareWindow(window platform.Window) error {
	native.NativeWindowPrepare(uintptr(window))
	return nil
}

func (implementation) Fullscreen(window platform.Window, on bool, done func(platform.FullscreenResult, string)) error {
	handle := handles.NewHandle(done)
	if !bool(native.NativeWindowFullscreen(uintptr(window), bool(on), uintptr(handle))) {
		handle.Delete()
		return errors.New("the window does not support full screen")
	}
	return nil
}

// The observation callbacks by observation. They are read and changed only in main-thread steps.
var responderObservers = map[unsafe.Pointer]handles.Handle{}

func (implementation) ObserveResponder(window platform.Window, changed func()) (unsafe.Pointer, error) {
	handle := handles.NewHandle(changed)
	observation := native.NativeWindowObserveResponder(uintptr(window), uintptr(handle))
	if observation == nil {
		handle.Delete()
		return nil, errors.New("the first responder of the window cannot be observed")
	}
	responderObservers[observation] = handle
	return observation, nil
}

func (implementation) EndResponderObservation(observation unsafe.Pointer) {
	native.MainSpWindowEndResponderObservation(observation)
	if handle, ok := responderObservers[observation]; ok {
		handle.Delete()
		delete(responderObservers, observation)
	}
}

func goHost_native_responder_changed(value uintptr) {
	handles.Handle(value).Value().(func())()
}

// The cursor observation callbacks by observation. They are read and changed only in main-thread steps.
var cursorObservers = map[unsafe.Pointer]handles.Handle{}

func (implementation) ObserveCursor(window platform.Window, changed func()) (unsafe.Pointer, error) {
	handle := handles.NewHandle(changed)
	observation := native.NativeWindowObserveCursor(uintptr(window), uintptr(handle))
	if observation == nil {
		handle.Delete()
		return nil, errors.New("the cursor of the window cannot be observed")
	}
	cursorObservers[observation] = handle
	return observation, nil
}

func (implementation) EndCursorObservation(observation unsafe.Pointer) {
	native.MainSpInputVirtualEndCursorObservation(observation)
	if handle, ok := cursorObservers[observation]; ok {
		handle.Delete()
		delete(cursorObservers, observation)
	}
}

func goHost_native_cursor_changed(value uintptr) {
	handles.Handle(value).Value().(func())()
}

// The sheet observation callbacks by observation. They are read and changed only in main-thread steps.
var sheetObservers = map[unsafe.Pointer]handles.Handle{}

func (implementation) ObserveSheet(window platform.Window, changed func()) (unsafe.Pointer, error) {
	handle := handles.NewHandle(changed)
	observation := native.NativeWindowObserveSheet(uintptr(window), uintptr(handle))
	if observation == nil {
		handle.Delete()
		return nil, errors.New("the sheets of the window cannot be observed")
	}
	sheetObservers[observation] = handle
	return observation, nil
}

func (implementation) EndSheetObservation(observation unsafe.Pointer) {
	native.MainSpWindowEndSheetObservation(observation)
	if handle, ok := sheetObservers[observation]; ok {
		handle.Delete()
		delete(sheetObservers, observation)
	}
}

func goHost_native_sheet_changed(value uintptr) {
	handles.Handle(value).Value().(func())()
}

// The request callbacks of the dialog holds by hold. They are read and changed only in main-thread steps.
var dialogHolds = map[unsafe.Pointer]handles.Handle{}

func (implementation) HoldDialogs(window platform.Window, requested func(request uint64, json string)) (unsafe.Pointer, error) {
	handle := handles.NewHandle(requested)
	hold := native.NativeWindowHoldDialogs(uintptr(window), uintptr(handle))
	if hold == nil {
		handle.Delete()
		return nil, errors.New("the dialogs of the window are held already")
	}
	dialogHolds[hold] = handle
	return hold, nil
}

func (implementation) ReleaseDialogs(hold unsafe.Pointer) {
	native.MainSpWindowReleaseDialogs(hold)
	if handle, ok := dialogHolds[hold]; ok {
		handle.Delete()
		delete(dialogHolds, hold)
	}
}

func goHost_native_dialog_requested(value uintptr, request uint64, json *byte) {
	handles.Handle(value).Value().(func(uint64, string))(request, native.GoString(json))
}

func (implementation) AnswerDialog(request uint64, paths []string, cancel bool, answered func(failure string)) {
	handle := handles.NewHandle(answered)
	var list **byte
	if len(paths) > 0 {
		list = (**byte)(native.Calloc(uint64(len(paths)), uint64(unsafe.Sizeof(uintptr(0)))))
		items := unsafe.Slice(list, len(paths))
		for index, path := range paths {
			items[index] = native.CString(path)
		}
		defer func() {
			for _, item := range items {
				native.Free(unsafe.Pointer(item))
			}
			native.Free(unsafe.Pointer(list))
		}()
	}
	native.NativeDialogAnswer(request, list, uint64(len(paths)), cancel, uintptr(handle))
}

func goHost_native_dialog_answered(value uintptr, failure *byte) {
	handle := handles.Handle(value)
	answered := handle.Value().(func(string))
	handle.Delete()
	text := ""
	if failure != nil {
		text = native.GoString(failure)
	}
	answered(text)
}

// goHost_native_fullscreen_done answers a full screen request with its result (window_fullscreen.h, whose values are the
// platform.FullscreenResult values) and its static message, nil for a finished transition.
func goHost_native_fullscreen_done(value uintptr, result int32, message *byte) {
	handle := handles.Handle(value)
	done := handle.Value().(func(platform.FullscreenResult, string))
	handle.Delete()
	text := ""
	if message != nil {
		text = native.GoString(message)
	}
	done(platform.FullscreenResult(result), text)
}

func (implementation) TitlebarHeight(window platform.Window) (float64, error) {
	// 0 is the height of a window without a title bar (full screen), and a negative value is a window that cannot have a title bar.
	row := float64(native.MainWindowTitlebarHeight(uintptr(window)))
	if row < 0 {
		return 0, errors.New("the window has no standard buttons or content view for a title bar")
	}
	return row, nil
}

func (implementation) SetTitlebarHeight(window platform.Window, height float64) error {
	var failure *byte
	if !bool(native.MainWindowSetTitlebarHeight(uintptr(window), float64(height), &failure)) {
		defer native.Free(unsafe.Pointer(failure))
		return errors.New(native.GoString(failure))
	}
	return nil
}

func (implementation) WindowControls(window platform.Window) (platform.Rect, error) {
	var out [4]float64
	native.MainWindowControls(uintptr(window), &out[0])
	return platform.Rect{X: float64(out[0]), Y: float64(out[1]), W: float64(out[2]), H: float64(out[3])}, nil
}

// facts moves the JSON string returned by native/darwin into a Go string and releases it.
func facts(text *byte, what string) (string, error) {
	if text == nil {
		return "", fmt.Errorf("%s: the window is gone", what)
	}
	defer native.SpFactsFree(text)
	return native.GoString(text), nil
}

func (implementation) WindowFacts(window platform.Window) (string, error) {
	return facts(native.MainSpWindowFacts(uintptr(window)), "window state")
}

func (implementation) WindowOnScreen(window platform.Window) (bool, error) {
	if window == 0 {
		return false, errors.New("window on screen: the window is gone")
	}
	return bool(native.MainSpWindowOnScreen(uintptr(window))), nil
}

func (implementation) WindowContentSize(window platform.Window) (width, height float64, err error) {
	var out [2]float64
	if !native.MainSpWindowContentSize(uintptr(window), &out[0]) {
		return 0, 0, errors.New("window content size: the window is gone")
	}
	return out[0], out[1], nil
}

func (implementation) WindowColorSpace(window platform.Window) (string, error) {
	return facts(native.MainSpWindowColorSpaceFacts(uintptr(window)), "window color-space facts")
}

func (implementation) WindowHit(window platform.Window, x, y float64) (string, error) {
	return facts(native.MainSpWindowHit(uintptr(window), float64(x), float64(y)), "window hit testing")
}

func (implementation) MoveWindow(window platform.Window, x, y float64) error {
	if !native.MainSpWindowMove(uintptr(window), float64(x), float64(y)) {
		return errors.New("window placement: the window is gone")
	}
	return nil
}

func (implementation) RaiseWindow(window platform.Window) error {
	if !native.MainSpWindowRaise(uintptr(window)) {
		return errors.New("the window is gone or not ordered in")
	}
	return nil
}

func (implementation) LowerWindow(window platform.Window) error {
	if !native.MainSpWindowLower(uintptr(window)) {
		return errors.New("the window is gone or not ordered in")
	}
	return nil
}

func (implementation) Screens() (string, error) {
	return facts(native.MainSpScreens(), "display list")
}

func (implementation) InstantWindowResize() error {
	native.MainWindowResizeInstant()
	return nil
}

func (implementation) ShowWindow(window platform.Window) error {
	// Frameworks may show a window before host preparation selects the platform.
	if err := ensureNative(); err != nil {
		return err
	}
	native.MainSpWindowShow(uintptr(window))
	return nil
}

func (implementation) PlaceNewWindow(window platform.Window) error {
	var failure *byte
	if !bool(native.MainSpWindowPlaceNew(uintptr(window), &failure)) {
		defer native.Free(unsafe.Pointer(failure))
		return errors.New(native.GoString(failure))
	}
	return nil
}

func (implementation) RevealAfterLoad(window platform.Window) error {
	var failure *byte
	if !bool(native.MainSpWindowRevealAfterLoad(uintptr(window), &failure)) {
		defer native.Free(unsafe.Pointer(failure))
		return errors.New(native.GoString(failure))
	}
	return nil
}
