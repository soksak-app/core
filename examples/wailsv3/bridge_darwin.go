//go:build darwin

package main

/*
#include <stdlib.h>
*/
import "C"

// surfaceMessage receives one message from a page this app serves. It is here
// rather than beside the C definitions because a Go function exported to C
// cannot live in a file that also holds them.
//
//export surfaceMessage
func surfaceMessage(payload *C.char) {
	if onSurfaceMessage != nil {
		onSurfaceMessage(C.GoString(payload))
	}
}

// onSurfaceMessage is set once, by the surfaces that answer these messages.
var onSurfaceMessage func(payload string)
