//go:build darwin

package main

/*
#include "surface_layout_darwin.h"
#include "webview_darwin.h"
*/
import "C"

import (
	"runtime/cgo"
	"unsafe"
)

func beginSurfaceLayout(window unsafe.Pointer, ticket uint64, ready func(bool)) {
	handle := cgo.NewHandle(ready)
	C.nativeWindowLayoutBegin(window, C.uint64_t(ticket), C.uintptr_t(handle))
}
func commitSurfaceLayout(window unsafe.Pointer, ticket uint64) bool {
	return bool(C.surfaceLayoutCommit(window, C.uint64_t(ticket)))
}
func cancelSurfaceLayout(window unsafe.Pointer) { C.surfaceLayoutCancel(window) }

//export nativeLayoutReady
func nativeLayoutReady(value C.uintptr_t, allowed C.bool) {
	handle := cgo.Handle(value)
	ready := handle.Value().(func(bool))
	handle.Delete()
	ready(bool(allowed))
}

func afterSurfacePresentation(window unsafe.Pointer, done func()) bool {
	handle := cgo.NewHandle(done)
	if !bool(C.nativeWindowAfterPresentation(window, C.uintptr_t(handle))) {
		handle.Delete()
		return false
	}
	return true
}

//export nativePresentationDone
func nativePresentationDone(value C.uintptr_t) {
	handle := cgo.Handle(value)
	done := handle.Value().(func())
	handle.Delete()
	done()
}
