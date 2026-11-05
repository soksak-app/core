//go:build windows

package windows

import (
	"errors"
	"fmt"
	"sync"
	"unsafe"

	sys "golang.org/x/sys/windows"
)

// nativeWebview is the WebView2 of a window that takes the input of the window.
type nativeWebview struct {
	window, core, controller uintptr
	presses                  pressState
	queue                    inputQueue
}

var (
	webviewsMu sync.Mutex
	webviews   = map[uintptr]*nativeWebview{}
)

// SetWebview makes a WebView2 the one that takes the input and the capture of the window, whose handle is the HWND. core is its
// ICoreWebView2 and controller its ICoreWebView2Controller, which this package holds until EndWebview. Call it on the UI thread.
func SetWebview(window, core, controller unsafe.Pointer) error {
	if window == nil || core == nil || controller == nil {
		return errors.New("a web view needs its window, its ICoreWebView2 and its controller")
	}
	if err := startUIThread(); err != nil {
		return err
	}
	view := &nativeWebview{window: uintptr(window), core: uintptr(core), controller: uintptr(controller)}
	view.queue = inputQueue{send: view.callDevTools, after: afterOnUIThread}
	comCall(view.core, slotAddRef)
	comCall(view.controller, slotAddRef)
	webviewsMu.Lock()
	previous := webviews[view.window]
	webviews[view.window] = view
	webviewsMu.Unlock()
	if previous != nil {
		previous.release()
	}
	return nil
}

// EndWebview ends the WebView2 of the window. Call it on the UI thread.
func EndWebview(window unsafe.Pointer) {
	webviewsMu.Lock()
	view := webviews[uintptr(window)]
	delete(webviews, uintptr(window))
	webviewsMu.Unlock()
	if view != nil {
		view.release()
	}
}

func (v *nativeWebview) release() {
	comCall(v.controller, slotRelease)
	comCall(v.core, slotRelease)
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
