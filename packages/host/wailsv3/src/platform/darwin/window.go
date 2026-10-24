//go:build darwin

package darwin

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#cgo pkg-config: soksak-darwin
#include <stdlib.h>
#include "window_controls.h"
#include "window_facts.h"
#include "window_fullscreen.h"
#include "window_motion.h"
#include "window_reveal.h"

bool nativeWindowFullscreen(void *window, bool on, uintptr_t callback);
#import <Cocoa/Cocoa.h>

void nativeWindowPrepare(void *window);
*/
import "C"

import (
	"errors"
	"fmt"
	"runtime/cgo"
	"unsafe"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// implementation is the platform.Platform of macOS.
type implementation struct{}

func init() { platform.Register(implementation{}) }

func (implementation) PrepareWindow(window unsafe.Pointer) error {
	C.nativeWindowPrepare(window)
	return nil
}

func (implementation) Fullscreen(window unsafe.Pointer, on bool, done func()) error {
	handle := cgo.NewHandle(done)
	if !bool(C.nativeWindowFullscreen(window, C.bool(on), C.uintptr_t(handle))) {
		handle.Delete()
		return errors.New("the window does not support full screen")
	}
	return nil
}

//export nativeFullscreenDone
func nativeFullscreenDone(value C.uintptr_t) {
	handle := cgo.Handle(value)
	done := handle.Value().(func())
	handle.Delete()
	done()
}

func (implementation) TitlebarHeight(window unsafe.Pointer) (float64, error) {
	// 0 is the height of a window without a title bar (full screen), and a negative value is a window that cannot have a title bar.
	row := float64(C.windowTitlebarHeight(window))
	if row < 0 {
		return 0, errors.New("the window has no standard buttons or content view for a title bar")
	}
	return row, nil
}

func (implementation) SetTitlebarHeight(window unsafe.Pointer, height float64) error {
	var failure *C.char
	if !bool(C.windowSetTitlebarHeight(window, C.double(height), &failure)) {
		defer C.free(unsafe.Pointer(failure))
		return errors.New(C.GoString(failure))
	}
	return nil
}

func (implementation) WindowControls(window unsafe.Pointer) (platform.Rect, error) {
	var out [4]C.double
	C.windowControls(window, &out[0])
	return platform.Rect{X: float64(out[0]), Y: float64(out[1]), W: float64(out[2]), H: float64(out[3])}, nil
}

// facts moves the JSON string returned by native/darwin into a Go string and releases it.
func facts(text *C.char, what string) (string, error) {
	if text == nil {
		return "", fmt.Errorf("%s: the window is gone", what)
	}
	defer C.sp_facts_free(text)
	return C.GoString(text), nil
}

func (implementation) WindowFacts(window unsafe.Pointer) (string, error) {
	return facts(C.sp_window_facts(window), "window state")
}

func (implementation) WindowColorSpace(window unsafe.Pointer) (string, error) {
	return facts(C.sp_window_color_space_facts(window), "window color-space facts")
}

func (implementation) WindowHit(window unsafe.Pointer, x, y float64) (string, error) {
	return facts(C.sp_window_hit(window, C.double(x), C.double(y)), "window hit testing")
}

func (implementation) MoveWindow(window unsafe.Pointer, x, y float64) error {
	if !C.sp_window_move(window, C.double(x), C.double(y)) {
		return errors.New("window placement: the window is gone")
	}
	return nil
}

func (implementation) Screens() (string, error) {
	return facts(C.sp_screens(), "display list")
}

func (implementation) InstantWindowResize() error {
	C.windowResizeInstant()
	return nil
}

func (implementation) RevealAfterLoad(window unsafe.Pointer) error {
	var failure *C.char
	if !bool(C.sp_window_reveal_after_load(window, &failure)) {
		defer C.free(unsafe.Pointer(failure))
		return errors.New(C.GoString(failure))
	}
	return nil
}
