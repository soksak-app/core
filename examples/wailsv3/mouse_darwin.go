//go:build darwin

package main

/*
#include <stdlib.h>
*/
import "C"

// surfaceMouseDown is called from the mouse monitor with a press in the same
// coordinates the surface frames are given in. It is here rather than beside
// the monitor because a Go function exported to C cannot live in a file that
// also holds C definitions.
//
//export surfaceMouseDown
func surfaceMouseDown(x, y C.double) {
	if pressed != nil {
		pressed(float64(x), float64(y))
	}
}

// pressed is set once, by the surfaces that want to know.
var pressed func(x, y float64)
