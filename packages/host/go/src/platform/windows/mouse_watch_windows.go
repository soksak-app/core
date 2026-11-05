//go:build windows

package windows

import (
	"fmt"
	"os"
	"runtime"
	"sync"
	"syscall"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	"github.com/soksak-app/core/packages/host/go/src/routine"
)

// The buttons and the window input come from the raw input of the system, with no hook: a raw input is a copy that the
// system sends beside the input, so a person's input never waits for this process. The registration receives the mouse
// inputs of every application, because host.buttons reports them, and it does not register the keyboard.
//
// Its limits: the source thread wakes at every move of the mouse, also over other applications; touch and pen input
// that the system does not send as raw mouse input are not seen; a press is read at the place of the pointer when the
// source reads it, not when the button changed.

var (
	procRegisterRawInputDevices = user32.NewProc("RegisterRawInputDevices")
	procGetRawInputData         = user32.NewProc("GetRawInputData")
	procGetAsyncKeyState        = user32.NewProc("GetAsyncKeyState")
	procGetSystemMetrics        = user32.NewProc("GetSystemMetrics")
	procGetCursorPos            = user32.NewProc("GetCursorPos")
	procWindowFromPoint         = user32.NewProc("WindowFromPoint")
	procGetAncestor             = user32.NewProc("GetAncestor")
	procScreenToClient          = user32.NewProc("ScreenToClient")
	procGetDpiForWindow         = user32.NewProc("GetDpiForWindow")
	procGetMessageW             = user32.NewProc("GetMessageW")
	procDispatchMessageW        = user32.NewProc("DispatchMessageW")
)

const (
	wmInput         = 0x00FF
	ridInput        = 0x10000003
	rimTypeMouse    = 0
	ridevInputSink  = 0x00000100
	usagePageMouse  = 0x01
	usageMouse      = 0x02
	smSwapButton    = 23
	gaParent        = 1
	gaRoot          = 2
	keyHeldBit      = 0x8000
	pageDotsPerInch = 96
)

type rawInputDevice struct {
	usagePage, usage uint16
	flags            uint32
	target           uintptr
}

// rawMouseInput is RAWINPUT with RAWMOUSE in its union.
type rawMouseInput struct {
	kind, size          uint32
	device, wParam      uintptr
	mouseFlags, _       uint16
	buttonFlags, _      uint16
	rawButtons          uint32
	lastX, lastY, extra int32
}

type windowMessage struct {
	window         uintptr
	message        uint32
	wParam, lParam uintptr
	time           uint32
	x, y           int32
	private        uint32
}

type screenPoint struct{ x, y int32 }

// systemMouse reads the mouse of the system.
type systemMouse struct{}

func (systemMouse) swapped() bool {
	swapped, _, _ := procGetSystemMetrics.Call(smSwapButton)
	return swapped != 0
}

func (systemMouse) hit() (uintptr, []uintptr, error) {
	var at screenPoint
	if done, _, err := procGetCursorPos.Call(uintptr(unsafe.Pointer(&at))); done == 0 {
		return 0, nil, fmt.Errorf("mouse input: the pointer position: %w", err)
	}
	// A POINT goes by value in one register on the 64-bit targets of this platform.
	hit, _, _ := procWindowFromPoint.Call(uintptr(uint32(at.x)) | uintptr(uint32(at.y))<<32)
	if hit == 0 {
		return 0, nil, nil
	}
	root, _, _ := procGetAncestor.Call(hit, gaRoot)
	var views []uintptr
	for view := hit; view != 0 && view != root; {
		views = append(views, view)
		parent, _, _ := procGetAncestor.Call(view, gaParent)
		view = parent
	}
	return root, views, nil
}

func (systemMouse) position(window uintptr) (float64, float64, error) {
	var at screenPoint
	if done, _, err := procGetCursorPos.Call(uintptr(unsafe.Pointer(&at))); done == 0 {
		return 0, 0, fmt.Errorf("mouse input: the pointer position: %w", err)
	}
	if done, _, err := procScreenToClient.Call(window, uintptr(unsafe.Pointer(&at))); done == 0 {
		return 0, 0, fmt.Errorf("mouse input: the pointer in window %#x: %w", window, err)
	}
	dots, _, err := procGetDpiForWindow.Call(window)
	if dots == 0 {
		return 0, 0, fmt.Errorf("mouse input: the scale of window %#x: %w", window, err)
	}
	scale := float64(dots) / pageDotsPerInch
	return float64(at.x) / scale, float64(at.y) / scale, nil
}

func reportMouseError(err error) {
	// The source thread has no caller to answer.
	fmt.Fprintf(os.Stderr, "mouse input: %v\n", err)
}

var mouse = mouseSource{
	system: systemMouse{},
	post: func(task func()) {
		if err := uiTasks.add(task); err != nil {
			reportMouseError(err)
		}
	},
	report: reportMouseError,
}

// readRawMouse reads the button flags of a WM_INPUT message. It answers false for an input that is not of the mouse.
func readRawMouse(lParam uintptr) (uint16, bool, error) {
	var input rawMouseInput
	size := uint32(unsafe.Sizeof(input))
	header := unsafe.Offsetof(input.mouseFlags)
	read, _, err := procGetRawInputData.Call(lParam, ridInput, uintptr(unsafe.Pointer(&input)), uintptr(unsafe.Pointer(&size)), header)
	if int32(read) < 0 {
		return 0, false, fmt.Errorf("mouse input: the raw input: %w", err)
	}
	return input.buttonFlags, input.kind == rimTypeMouse, nil
}

func mouseWindowProc(window, message, wParam, lParam uintptr) uintptr {
	if message == wmInput {
		flags, isMouse, err := readRawMouse(lParam)
		if err != nil {
			reportMouseError(err)
		} else if isMouse {
			mouse.receive(flags)
		}
	}
	// A WM_INPUT also needs the default handling, which releases the input.
	result, _, _ := procDefWindowProcW.Call(window, message, wParam, lParam)
	return result
}

// runMouseSource is the source thread: it registers for the raw mouse input, reads the buttons held at that point, and
// then handles the inputs. A press that arrives between the two is both read and applied, and applying a press to a
// mask that holds it changes nothing.
func runMouseSource(started chan<- error) {
	runtime.LockOSThread()
	window, err := createMessageWindow("soksak-mouse-input", syscall.NewCallback(mouseWindowProc))
	if err != nil {
		started <- fmt.Errorf("mouse input window: %w", err)
		return
	}
	device := rawInputDevice{usagePage: usagePageMouse, usage: usageMouse, flags: ridevInputSink, target: window}
	done, _, err := procRegisterRawInputDevices.Call(uintptr(unsafe.Pointer(&device)), 1, unsafe.Sizeof(device))
	if done == 0 {
		started <- fmt.Errorf("mouse input registration: %w", err)
		return
	}
	mouse.mu.Lock()
	mouse.mask = mouseButtonsHeld(func(key int) bool {
		state, _, _ := procGetAsyncKeyState.Call(uintptr(key))
		return state&keyHeldBit != 0
	})
	mouse.mu.Unlock()
	started <- nil
	for {
		var message windowMessage
		got, _, err := procGetMessageW.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(got) <= 0 {
			// Only WM_QUIT or a failure ends the loop, and nothing asks this thread to quit.
			reportMouseError(fmt.Errorf("the source thread ended: %w", err))
			return
		}
		// The result of a dispatch is the result of the window procedure, which reports its own failures.
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&message)))
	}
}

var startMouseSource = sync.OnceValue(func() error {
	if err := startUIThread(); err != nil {
		return err
	}
	started := make(chan error, 1)
	routine.Go("mouse-input", func() { runMouseSource(started) })
	return <-started
})

// WatchInput delivers the presses and the drags of the window, read from raw input. The key inputs are not watched,
// because the keyboard is not registered. Call it on the UI thread.
func (implementation) WatchInput(window unsafe.Pointer, input platform.Input) (uintptr, error) {
	if err := startMouseSource(); err != nil {
		return 0, err
	}
	return mouse.watch(uintptr(window), input), nil
}

// UnwatchInput ends the watch that WatchInput returned. Call it on the UI thread.
func (implementation) UnwatchInput(monitor uintptr) {
	mouse.unwatch(monitor)
}

// WatchButtons reports the mouse buttons of every application, read from raw input. Call it once on the UI thread.
func (implementation) WatchButtons(changed func(mask uint64)) error {
	if err := startMouseSource(); err != nil {
		return err
	}
	return mouse.setChanged(changed)
}
