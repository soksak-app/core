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

func beginSurfaceLayout(ticket uint64)       { C.surfaceLayoutBegin(C.uint64_t(ticket)) }
func commitSurfaceLayout(ticket uint64) bool { return bool(C.surfaceLayoutCommit(C.uint64_t(ticket))) }
func cancelSurfaceLayout()                   { C.surfaceLayoutCancel() }

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
