//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>

// The window server's number for this window and for the windows attached to it.
// A capture tool addresses a window by this number, so it reads the composite the
// window server draws - the page, the surfaces and the modal - without raising the
// window.
//
// Writes up to `max` numbers and returns how many. This app's own window is first.
static int windowNumbers(void* nsWindow, long* out, int max) {
    NSWindow* window = (NSWindow*)nsWindow;
    if (window == nil || max <= 0) return 0;
    int n = 0;
    out[n++] = (long)[window windowNumber];
    for (NSWindow* child in [window childWindows]) {
        if (n >= max) break;
        out[n++] = (long)[child windowNumber];
    }
    return n;
}
*/
import "C"

import "unsafe"

// windowNumbers reports the window server's numbers for this window and the
// windows attached to it.
func windowNumbers(window unsafe.Pointer) []int {
	var buf [32]C.long
	n := int(C.windowNumbers(window, &buf[0], C.int(len(buf))))
	out := make([]int, n)
	for i := 0; i < n; i++ {
		out[i] = int(buf[i])
	}
	return out
}
