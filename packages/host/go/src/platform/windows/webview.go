//go:build windows

package windows

import (
	"errors"
	"fmt"
	"os"
	"sync"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	sys "golang.org/x/sys/windows"
)

// nativeWebview is the WebView2 of a window that takes the input of the window.
type nativeWebview struct {
	window, core, controller uintptr
	presses                  pressState
	queue                    inputQueue
	// failed is the handler of ProcessFailed, and failedToken its subscription.
	failed      uintptr
	failedToken int64
}

var (
	webviewsMu sync.Mutex
	webviews   = map[uintptr]*nativeWebview{}
)

// SetWebview makes a WebView2 the one that takes the input and the capture of the window, whose handle is the HWND. core is its
// ICoreWebView2 and controller its ICoreWebView2Controller, which this package holds until EndWebview. ended runs on the UI thread when the
// process of its page ended (processFailureOf). Call it on the UI thread.
func SetWebview(window platform.Window, core, controller unsafe.Pointer, ended func()) error {
	if window == 0 || core == nil || controller == nil || ended == nil {
		return errors.New("a web view needs its window, its ICoreWebView2, its controller and the function of the end of its page")
	}
	if err := startUIThread(); err != nil {
		return err
	}
	view := &nativeWebview{window: uintptr(window), core: uintptr(core), controller: uintptr(controller)}
	view.queue = inputQueue{send: view.callDevTools}
	comCall(view.core, slotAddRef)
	comCall(view.controller, slotAddRef)
	if err := view.watchProcessFailures(ended); err != nil {
		view.release()
		return err
	}
	webviewsMu.Lock()
	previous := webviews[view.window]
	webviews[view.window] = view
	webviewsMu.Unlock()
	if previous != nil {
		previous.queue.end("the window took another web view")
		previous.release()
	}
	return nil
}

// EndWebview ends the WebView2 of the window, at the end of the window, and the inputs that wait for its DevTools calls answer that end.
// Call it on the UI thread.
func EndWebview(window platform.Window) {
	webviewsMu.Lock()
	view := webviews[uintptr(window)]
	delete(webviews, uintptr(window))
	webviewsMu.Unlock()
	if view != nil {
		view.queue.end("the window ended")
		view.release()
	}
}

func (v *nativeWebview) release() {
	if v.failed != 0 {
		comCall(v.core, webviewRemoveProcessFailed, uintptr(v.failedToken))
		comCall(v.failed, slotRelease)
	}
	comCall(v.controller, slotRelease)
	comCall(v.core, slotRelease)
}

// watchProcessFailures subscribes to the process failures of the web view, which WebView2 raises on the UI thread. The end of the page
// process ends its DevTools connection, so it also ends the input queue.
func (v *nativeWebview) watchProcessFailures(ended func()) error {
	window := v.window
	handler := newHandler(handlerVtables().valued, func(_, args uintptr) {
		var kind int32
		if result := comCall(args, processFailedArgsGetKind, uintptr(unsafe.Pointer(&kind))); failedResult(result) {
			fmt.Fprintf(os.Stderr, "web view process: window %#x: %v\n", window, resultError("ProcessFailedKind", result))
			return
		}
		switch processFailureOf(kind) {
		case pageEnded:
			v.queue.connectionEnded("the process of the page ended")
			ended()
		case pageStays:
			fmt.Fprintf(os.Stderr, "web view process: window %#x: process failure %d\n", window, kind)
		}
	})
	var token int64
	if result := comCall(v.core, webviewAddProcessFailed, handler, uintptr(unsafe.Pointer(&token))); failedResult(result) {
		comCall(handler, slotRelease)
		return resultError("add_ProcessFailed", result)
	}
	v.failed, v.failedToken = handler, token
	return nil
}

// webviewOf returns the WebView2 of the window.
func webviewOf(window uintptr) (*nativeWebview, error) {
	webviewsMu.Lock()
	defer webviewsMu.Unlock()
	view := webviews[window]
	if view == nil {
		return nil, fmt.Errorf("the window %#x has no web view", window)
	}
	return view, nil
}

// callDevTools starts a call of the DevTools protocol. complete runs on the UI thread.
func (v *nativeWebview) callDevTools(call devToolsCall, complete func(error)) error {
	method, err := sys.UTF16PtrFromString(call.method)
	if err != nil {
		return err
	}
	params, err := sys.UTF16PtrFromString(call.params)
	if err != nil {
		return err
	}
	handler := newHandler(handlerVtables().valued, func(result, _ uintptr) {
		if failedResult(result) {
			complete(resultError(call.method, result))
			return
		}
		complete(nil)
	})
	defer comCall(handler, slotRelease)
	if result := comCall(v.core, webviewCallDevToolsProtocolMethod, uintptr(unsafe.Pointer(method)), uintptr(unsafe.Pointer(params)), handler); failedResult(result) {
		return resultError(call.method, result)
	}
	return nil
}
