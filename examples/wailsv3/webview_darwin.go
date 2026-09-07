//go:build darwin

package main

/*
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#include <stdlib.h>
#include "webview_darwin.h"
*/
import "C"

import (
	"fmt"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//export nativeMessage
func nativeMessage(identifier C.ulonglong, message *C.char) {
	body := C.GoString(message)
	// A service may wait for the main thread. Return to WebKit before invoking it.
	go dispatchNative(uint64(identifier), body)
}

func prepareNativeWindow(window unsafe.Pointer) { C.nativeWindowPrepare(window) }

func newNativeWebview(window *application.WebviewWindow, options nativeWebviewOptions) (*nativeWebview, error) {
	var view *nativeWebview
	application.InvokeSync(func() {
		nativeSerial++
		bootstrap := C.CString(webviewBootstrap + "\n" + backgroundScript)
		defer C.free(unsafe.Pointer(bootstrap))
		handle := C.nativeWebviewCreate(window.NativeWindow(), C.ulonglong(nativeSerial), bootstrap,
			C.double(options.X), C.double(options.Y), C.double(options.Width), C.double(options.Height),
			C.bool(options.Hidden), C.bool(options.Transparent),
			C.bool(options.FillParent))
		if handle == nil {
			return
		}
		view = &nativeWebview{id: nativeSerial, handle: handle}
		nativeViews[view.id] = view
	})
	if view == nil {
		return nil, fmt.Errorf("cannot create a native webview in this window/WebKit")
	}
	if err := view.SetURL(options.URL); err != nil {
		view.Close()
		return nil, err
	}
	return view, nil
}

func (v *nativeWebview) NativeView() unsafe.Pointer {
	var handle unsafe.Pointer
	application.InvokeSync(func() { handle = v.handle })
	return handle
}
func (v *nativeWebview) SetURL(url string) error {
	var applied bool
	application.InvokeSync(func() {
		if v.handle == nil {
			return
		}
		target := C.CString(url)
		defer C.free(unsafe.Pointer(target))
		applied = bool(C.nativeWebviewNavigate(v.handle, target))
	})
	if !applied {
		return fmt.Errorf("native webview is closed or its URL is invalid: %s", url)
	}
	return nil
}
func (v *nativeWebview) SetBounds(x, y, width, height float64) {
	application.InvokeSync(func() {
		if v.handle != nil {
			C.nativeWebviewBounds(v.handle, C.double(x), C.double(y), C.double(width), C.double(height))
		}
	})
}
func (v *nativeWebview) SetHidden(hidden bool) {
	application.InvokeSync(func() {
		if v.handle != nil {
			C.nativeWebviewHidden(v.handle, C.bool(hidden))
		}
	})
}

func (v *nativeWebview) setBackground(enabled bool) {
	application.InvokeSync(func() {
		if v.handle != nil {
			C.nativeWebviewBackground(v.handle, C.bool(enabled))
		}
	})
}
func (v *nativeWebview) execJS(script string) {
	if v.handle == nil {
		return
	}
	value := C.CString(script)
	defer C.free(unsafe.Pointer(value))
	C.nativeWebviewEval(v.handle, value)
}
func (v *nativeWebview) Close() {
	application.InvokeSync(func() {
		if v.handle == nil {
			return
		}
		delete(nativeViews, v.id)
		C.nativeWebviewClose(v.handle)
		v.handle = nil
	})
}
