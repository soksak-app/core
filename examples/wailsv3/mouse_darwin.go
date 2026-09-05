//go:build darwin

package main

/*
#include <stdlib.h>
*/
import "C"

import "unsafe"

// surfaceHit is called for each view a press walks through, from the one AppKit
// hit up to the window's content view. It is here rather than beside the
// monitor because a Go function exported to C cannot live in a file that also
// holds C definitions.
//
//export surfaceHit
func surfaceHit(view unsafe.Pointer) C.int {
	if pressed != nil && pressed(uintptr(view)) {
		return 1
	}
	return 0
}

// surfacePoint is called for a press, a move and a release of the left button,
// with the point in the page's coordinates.
//
//export surfacePoint
func surfacePoint(phase C.int, x C.double, y C.double) {
	if pointed != nil {
		pointed(int(phase), float64(x), float64(y))
	}
}

// pressed is set once, by the surfaces that want to know. It reports whether
// the view is one of theirs.
var pressed func(view uintptr) bool

// pointed is set once, alongside pressed. It receives every step of a drag.
var pointed func(phase int, x float64, y float64)
