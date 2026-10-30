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
#include "main_thread.h"

bool nativeWindowFullscreen(void *window, bool on, uintptr_t callback);
void *nativeWindowObserveResponder(void *window, uintptr_t callback);
#import <Cocoa/Cocoa.h>

void nativeWindowPrepare(void *window);

// The native calls of this file run on the main thread (main_thread.h).
static void main_sp_window_end_responder_observation(void *observation) {
    wailsRunOnMain(^{ sp_window_end_responder_observation(observation); });
}
static double main_windowTitlebarHeight(void *window) { return ON_MAIN(double, windowTitlebarHeight(window)); }
static bool main_windowSetTitlebarHeight(void *window, double height, char **failure) {
    return ON_MAIN(bool, windowSetTitlebarHeight(window, height, failure));
}
static void main_windowControls(void *window, double *out) { wailsRunOnMain(^{ windowControls(window, out); }); }
static char *main_sp_window_facts(void *window) { return ON_MAIN(char *, sp_window_facts(window)); }
static char *main_sp_window_color_space_facts(void *window) { return ON_MAIN(char *, sp_window_color_space_facts(window)); }
static char *main_sp_window_hit(void *window, double x, double y) { return ON_MAIN(char *, sp_window_hit(window, x, y)); }
static bool main_sp_window_move(void *window, double x, double y) { return ON_MAIN(bool, sp_window_move(window, x, y)); }
static char *main_sp_screens(void) { return ON_MAIN(char *, sp_screens()); }
static void main_windowResizeInstant(void) { wailsRunOnMain(^{ windowResizeInstant(); }); }
static bool main_sp_window_reveal_after_load(void *window, char **error) {
    return ON_MAIN(bool, sp_window_reveal_after_load(window, error));
}
*/
import "C"

import (
	"errors"
	"fmt"
	"runtime/cgo"
	"unsafe"

	// The framework defines the functions of main_thread.h, which the native calls and callbacks of this package use.
	_ "github.com/wailsapp/wails/v3/pkg/application"

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

// The observation callbacks by observation. They are read and changed only in main-thread steps.
var responderObservers = map[unsafe.Pointer]cgo.Handle{}

func (implementation) ObserveResponder(window unsafe.Pointer, changed func()) (unsafe.Pointer, error) {
	handle := cgo.NewHandle(changed)
	observation := C.nativeWindowObserveResponder(window, C.uintptr_t(handle))
	if observation == nil {
		handle.Delete()
		return nil, errors.New("the first responder of the window cannot be observed")
	}
	responderObservers[observation] = handle
	return observation, nil
}

func (implementation) EndResponderObservation(observation unsafe.Pointer) {
	C.main_sp_window_end_responder_observation(observation)
	if handle, ok := responderObservers[observation]; ok {
		handle.Delete()
		delete(responderObservers, observation)
	}
}

//export goNativeResponderChanged
func goNativeResponderChanged(value C.uintptr_t) {
	cgo.Handle(value).Value().(func())()
}

//export goNativeFullscreenDone
func goNativeFullscreenDone(value C.uintptr_t) {
	handle := cgo.Handle(value)
	done := handle.Value().(func())
	handle.Delete()
	done()
}

func (implementation) TitlebarHeight(window unsafe.Pointer) (float64, error) {
	// 0 is the height of a window without a title bar (full screen), and a negative value is a window that cannot have a title bar.
	row := float64(C.main_windowTitlebarHeight(window))
	if row < 0 {
		return 0, errors.New("the window has no standard buttons or content view for a title bar")
	}
	return row, nil
}

func (implementation) SetTitlebarHeight(window unsafe.Pointer, height float64) error {
	var failure *C.char
	if !bool(C.main_windowSetTitlebarHeight(window, C.double(height), &failure)) {
		defer C.free(unsafe.Pointer(failure))
		return errors.New(C.GoString(failure))
	}
	return nil
}

func (implementation) WindowControls(window unsafe.Pointer) (platform.Rect, error) {
	var out [4]C.double
	C.main_windowControls(window, &out[0])
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
	return facts(C.main_sp_window_facts(window), "window state")
}

func (implementation) WindowColorSpace(window unsafe.Pointer) (string, error) {
	return facts(C.main_sp_window_color_space_facts(window), "window color-space facts")
}

func (implementation) WindowHit(window unsafe.Pointer, x, y float64) (string, error) {
	return facts(C.main_sp_window_hit(window, C.double(x), C.double(y)), "window hit testing")
}

func (implementation) MoveWindow(window unsafe.Pointer, x, y float64) error {
	if !C.main_sp_window_move(window, C.double(x), C.double(y)) {
		return errors.New("window placement: the window is gone")
	}
	return nil
}

func (implementation) Screens() (string, error) {
	return facts(C.main_sp_screens(), "display list")
}

func (implementation) InstantWindowResize() error {
	C.main_windowResizeInstant()
	return nil
}

func (implementation) RevealAfterLoad(window unsafe.Pointer) error {
	var failure *C.char
	if !bool(C.main_sp_window_reveal_after_load(window, &failure)) {
		defer C.free(unsafe.Pointer(failure))
		return errors.New(C.GoString(failure))
	}
	return nil
}
