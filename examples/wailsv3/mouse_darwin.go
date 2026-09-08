//go:build darwin

package main

/*
#include <stdint.h>
*/
import "C"

import (
	"runtime/cgo"
	"unsafe"
)

// surfaceHit is called for each view a press walks through, from the one AppKit
// hit up to the window's content view. It is here rather than beside the
// monitor because a Go function exported to C cannot live in a file that also
// holds C definitions.
//
//export surfaceHit
func surfaceHit(owner C.uintptr_t, view unsafe.Pointer) C.int {
	if cgo.Handle(owner).Value().(*Surfaces).press(uintptr(view)) {
		return 1
	}
	return 0
}

//export surfacePoint
func surfacePoint(owner C.uintptr_t, phase C.int, x C.double, y C.double) {
	cgo.Handle(owner).Value().(*Surfaces).point(int(phase), float64(x), float64(y))
}
