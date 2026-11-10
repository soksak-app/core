//go:build darwin

package darwin

import (
	"errors"
	"fmt"
	"github.com/soksak-app/core/packages/host/go/src/platform/darwin/abi"

	"unsafe"

	handles "github.com/soksak-app/core/packages/host/go/src/callback"
	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// watchers are the input receiver handles of each monitor number. They are read and changed only in main-thread steps.
var watchers = map[uintptr]handles.Handle{}

// goHost_surface_pressed receives the surface host that a press or a key input passed through. The library already decided that
// the view is a surface host, so the answer of Press is not returned.
func goHost_surface_pressed(owner uintptr, view unsafe.Pointer) {
	handles.Handle(owner).Value().(platform.Input).Press(uintptr(view))
}

func goHost_surface_point(owner uintptr, phase int32, x float64, y float64) {
	handles.Handle(owner).Value().(platform.Input).Point(int(phase), float64(x), float64(y))
}

func (implementation) WatchInput(window platform.Window, input platform.Input) (uintptr, error) {
	handle := handles.NewHandle(input)
	monitor := uintptr(native.SurfaceWatchMouse(uintptr(window), uintptr(handle)))
	watchers[monitor] = handle
	return monitor, nil
}

// InjectPointer delivers input with sp_input_pointer_then of native/darwin. It does not activate the application. The library
// starts each request after the answer of the request before it, so this step returns without waiting for an earlier delivery.
func (implementation) InjectPointer(window platform.Window, pointer string, x, y float64, phase, button int, deltaX, deltaY float64, clicks int, receive float64, done func(platform.PointerResult, platform.ButtonHeld)) error {
	native.InjectPointer(uintptr(window), native.CString(pointer), float64(x), float64(y), int32(phase), int32(button), float64(deltaX), float64(deltaY), int32(clicks),
		float64(receive), uintptr(handles.NewHandle(done)))
	return nil
}

// goHost_input_delivered announces the result of sp_input_pointer_then. The library passes held only when the result is SP_INPUT_BUTTON_HELD
// or SP_INPUT_POINTER_HELD and keeps it valid until done returns.
func goHost_input_delivered(context uintptr, result int32, held *abi.SpInputHeld) {
	handle := handles.Handle(uintptr(context))
	done := handle.Value().(func(platform.PointerResult, platform.ButtonHeld))
	handle.Delete()
	switch int32(result) {
	case abi.SP_INPUT_DELIVERED:
		done(platform.PointerDelivered, platform.ButtonHeld{})
	case abi.SP_INPUT_INACTIVE:
		done(platform.PointerInactive, platform.ButtonHeld{})
	case abi.SP_INPUT_UNRECEIVED:
		done(platform.PointerUnreceived, platform.ButtonHeld{})
	case abi.SP_INPUT_BUTTON_HELD:
		done(platform.PointerButtonHeld, buttonHeld(held))
	case abi.SP_INPUT_PRESS_OPEN:
		done(platform.PointerPressOpen, platform.ButtonHeld{})
	case abi.SP_INPUT_POINTER_HELD:
		done(platform.PointerHeld, pointerHeld(held))
	default:
		done(platform.PointerRejected, platform.ButtonHeld{})
	}
}

// buttonHeld reads sp_input_held. When pid is -1, there is no frontmost application. A notification of this result without a state is
// a contract violation of the library, so it stops and names the violation.
func buttonHeld(held *abi.SpInputHeld) platform.ButtonHeld {
	if held == nil {
		panic("sp_input_pointer_then reported SP_INPUT_BUTTON_HELD without its state")
	}
	result := platform.ButtonHeld{Mask: uint64(held.Mask)}
	if held.Pid >= 0 {
		result.Frontmost = &platform.FrontmostApplication{PID: int(held.Pid)}
		if held.BundleIdentifier != nil {
			result.Frontmost.BundleIdentifier = native.GoString(held.BundleIdentifier)
		}
	}
	return result
}

// pointerHeld reads the pointer and the reason of sp_input_held. A notification of this result without them is a contract violation
// of the library, so it stops and names the violation.
func pointerHeld(held *abi.SpInputHeld) platform.ButtonHeld {
	if held == nil || held.Pointer == nil || held.Reason == nil {
		panic("sp_input_pointer_then reported SP_INPUT_POINTER_HELD without its pointer and reason")
	}
	return platform.ButtonHeld{Pointer: native.GoString(held.Pointer), Reason: native.GoString(held.Reason)}
}

type activation struct {
	timeout float64
	done    func(error)
}

func goHost_input_activated(context uintptr, result int32, frontmost *byte) {
	handle := handles.Handle(uintptr(context))
	a := handle.Value().(activation)
	handle.Delete()
	name := "unknown"
	if frontmost != nil {
		name = native.GoString(frontmost)
	}
	a.done(activationResult(int32(result), a.timeout, name))
}

// activationResult converts the result of sp_input_activate to an error that names the stage where it stopped and the frontmost application.
func activationResult(result int32, timeout float64, frontmost string) error {
	switch result {
	case abi.SP_ACTIVATE_DONE:
		return nil
	case abi.SP_ACTIVATE_REFUSED:
		return fmt.Errorf("the system did not activate the application within %gs; the frontmost application is %s", timeout, frontmost)
	case abi.SP_ACTIVATE_NOT_KEY:
		return fmt.Errorf("the application is active but the window did not become key within %gs; the frontmost application is %s", timeout, frontmost)
	case abi.SP_ACTIVATE_PENDING:
		return fmt.Errorf("the window's webviews did not apply the active state within %gs", timeout)
	case abi.SP_ACTIVATE_LOST:
		return fmt.Errorf("the window lost activation before its webviews applied it; the frontmost application is %s", frontmost)
	default:
		return errors.New("the window cannot be activated")
	}
}

// ActivateWindow makes the window the key window with sp_input_activate of native/darwin.
func (implementation) ActivateWindow(window platform.Window, x, y, timeout float64, done func(error)) error {
	native.ActivateWindowAt(uintptr(window), float64(x), float64(y), float64(timeout), uintptr(handles.NewHandle(activation{timeout, done})))
	return nil
}

// InjectKey delivers input with sp_input_key of native/darwin. When text is empty, it types key.
func (implementation) InjectKey(window platform.Window, key, text string, modifiers uint, down bool) (platform.PointerResult, error) {
	name := native.CString(key)
	defer native.Free(unsafe.Pointer(name))
	var typed *byte
	if text != "" {
		typed = native.CString(text)
		defer native.Free(unsafe.Pointer(typed))
	}
	switch native.MainSpInputKey(uintptr(window), name, typed, uint32(modifiers), bool(down)) {
	case abi.SP_INPUT_DELIVERED:
		return platform.PointerDelivered, nil
	case abi.SP_INPUT_INACTIVE:
		return platform.PointerInactive, nil
	default:
		return platform.PointerRejected, nil
	}
}

func (implementation) UnwatchInput(monitor uintptr) {
	if handle, ok := watchers[monitor]; ok {
		native.SurfaceUnwatchMouse(uintptr(monitor))
		handle.Delete()
		delete(watchers, monitor)
	}
}
