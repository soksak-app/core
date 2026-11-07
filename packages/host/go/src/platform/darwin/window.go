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

func (implementation) Fullscreen(window platform.Window, on bool, done func()) error {
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

func goHost_native_fullscreen_done(value uintptr) {
	handle := handles.Handle(value)
	done := handle.Value().(func())
	handle.Delete()
	done()
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

func (implementation) RevealAfterLoad(window platform.Window) error {
	var failure *byte
	if !bool(native.MainSpWindowRevealAfterLoad(uintptr(window), &failure)) {
		defer native.Free(unsafe.Pointer(failure))
		return errors.New(native.GoString(failure))
	}
	return nil
}
