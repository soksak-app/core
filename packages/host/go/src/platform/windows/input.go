//go:build windows

package windows

import (
	"fmt"
	"os"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// InjectPointer delivers a pointer input through the DevTools protocol of the web view of the window. It uses no real pointer and no
// system focus, so a window behind others takes it. done runs when its call completes, or when the page or the web view ends first.
// Call it on the UI thread.
func (implementation) InjectPointer(window platform.Window, pointer string, x, y float64, phase, button int, deltaX, deltaY float64, clicks int, done func(platform.PointerResult, platform.ButtonHeld)) error {
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
	return view.queue.push(call, func(err error) {
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
	if err := view.queue.push(call, nil); err != nil {
		return platform.PointerRejected, err
	}
	return platform.PointerDelivered, nil
}

// ActivateWindow asks the system for the foreground and gives the web view the focus. Input does not need it: a run that a person checks
// asks for it. SetForegroundWindow answers in its call: it returns zero when the system refuses a process that is not in front, and that
// refusal is the answer unless the window already has the foreground. Call it on the UI thread.
func (implementation) ActivateWindow(window platform.Window, _, _ float64, done func(error)) error {
	view, err := webviewOf(uintptr(window))
	if err != nil {
		return err
	}
	// default: the return of SetForegroundWindow is its whole answer; it sets no error that GetLastError reads.
	set, _, _ := procSetForegroundWindow.Call(view.window)
	if set == 0 {
		// default: GetForegroundWindow sets no error that GetLastError reads, so its value is the whole answer and the error of Call holds nothing.
		if foreground, _, _ := procGetForegroundWindow.Call(); foreground != view.window {
			done(fmt.Errorf("the system did not give the window the foreground; the foreground window is %#x", foreground))
			return nil
		}
	}
	if result := comCall(view.controller, controllerMoveFocus, 0); failedResult(result) { // COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC
		done(resultError("web view focus", result))
		return nil
	}
	done(nil)
	return nil
}
