//go:build windows

package windows

import (
	"fmt"
	"os"
	"time"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// keyWait is how long a key may stay uncompleted before the next input reports it.
const keyWait = 10 * time.Second

// activateStep is how often an activation reads the foreground window.
const activateStep = 20 * time.Millisecond

// InjectPointer delivers a pointer input through the DevTools protocol of the web view of the window. It uses no real pointer and no
// system focus, so a window behind others takes it. Call it on the UI thread.
func (implementation) InjectPointer(window platform.Window, pointer string, x, y float64, phase, button int, deltaX, deltaY float64, clicks int, receive float64, done func(platform.PointerResult, platform.ButtonHeld)) error {
	view, err := webviewOf(uintptr(window))
	if err != nil {
		return err
	}
	call, result := view.presses.call(pointer, x, y, phase, button, deltaX, deltaY, clicks)
	if result == platform.PointerHeld {
		done(result, platform.ButtonHeld{Pointer: view.presses.holder, Reason: pointerHeldReason})
		return nil
	}
	if result != platform.PointerDelivered {
		done(result, platform.ButtonHeld{})
		return nil
	}
	wait := time.Duration(receive * float64(time.Second))
	return view.queue.push(call, wait, func(err error) {
		if err == nil {
			view.presses.delivered(pointer, phase, button)
		} else {
			fmt.Fprintf(os.Stderr, "input.pointer: %v\n", err)
		}
		done(pointerResult(err), platform.ButtonHeld{})
	})
}

// InjectKey queues a key input through the DevTools protocol of the web view of the window. The next input reports a call that failed,
// because this call answers on the UI thread before the call ends. Call it on the UI thread.
func (implementation) InjectKey(window platform.Window, key, text string, modifiers uint, down bool) (platform.PointerResult, error) {
	view, err := webviewOf(uintptr(window))
	if err != nil {
		return platform.PointerRejected, err
	}
	call, result := keyCall(key, text, modifiers, down)
	if result != platform.PointerDelivered {
		return result, nil
	}
	if err := view.queue.push(call, keyWait, nil); err != nil {
		return platform.PointerRejected, err
	}
	return platform.PointerDelivered, nil
}

// ActivateWindow asks the system for the foreground and gives the web view the focus. Input does not need it: a run that a person checks
// asks for it. The system refuses a process that is not in front, and that refusal is the answer after timeout. Call it on the UI thread.
func (implementation) ActivateWindow(window platform.Window, _, _, timeout float64, done func(error)) error {
	view, err := webviewOf(uintptr(window))
	if err != nil {
		return err
	}
	procSetForegroundWindow.Call(view.window)
	deadline := time.Now().Add(time.Duration(timeout * float64(time.Second)))
	var check func()
	check = func() {
		// default: GetForegroundWindow sets no error that GetLastError reads, so its value is the whole answer and the error of Call holds nothing.
		foreground, _, _ := procGetForegroundWindow.Call()
		switch {
		case foreground == view.window:
			if result := comCall(view.controller, controllerMoveFocus, 0); failedResult(result) { // COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC
				done(resultError("web view focus", result))
				return
			}
			done(nil)
		case time.Now().After(deadline):
			done(fmt.Errorf("the system did not give the window the foreground within %vs", timeout))
		default:
			afterOnUIThread(activateStep, check)
		}
	}
	check()
	return nil
}
