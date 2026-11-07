//go:build darwin

package darwin

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#cgo pkg-config: soksak-darwin
#include <stdlib.h>
#include "webview_geometry.h"
#include "window_controls.h"
#include "window_facts.h"
#include "window_fullscreen.h"
#include "window_motion.h"
#include "window_reveal.h"
#include "main_thread.h"

bool nativeWindowFullscreen(uintptr_t window, bool on, uintptr_t callback);
void *nativeWindowObserveResponder(uintptr_t window, uintptr_t callback);
#import <Cocoa/Cocoa.h>

void nativeWindowPrepare(uintptr_t window);

// The native calls of this file run on the main thread (main_thread.h).
static void main_sp_window_end_responder_observation(void *observation) {
    hostRunOnMain(^{ sp_window_end_responder_observation(observation); });
}
static double main_windowTitlebarHeight(uintptr_t window) { return ON_MAIN(double, windowTitlebarHeight((void *)window)); }
static bool main_windowSetTitlebarHeight(uintptr_t window, double height, char **failure) {
    return ON_MAIN(bool, windowSetTitlebarHeight((void *)window, height, failure));
}
static void main_windowControls(uintptr_t window, double *out) { hostRunOnMain(^{ windowControls((void *)window, out); }); }
static char *main_sp_window_facts(uintptr_t window) {
    return ON_MAIN(char *, sp_window_facts((void *)window, sp_window_composition((void *)window)));
}
static bool main_sp_window_on_screen(uintptr_t window) { return ON_MAIN(bool, sp_window_on_screen((void *)window)); }
static char *main_sp_window_color_space_facts(uintptr_t window) { return ON_MAIN(char *, sp_window_color_space_facts((void *)window)); }
static char *main_sp_window_hit(uintptr_t window, double x, double y) {
    return ON_MAIN(char *, sp_window_hit((void *)window, sp_window_composition((void *)window), x, y));
}
static bool main_sp_window_move(uintptr_t window, double x, double y) { return ON_MAIN(bool, sp_window_move((void *)window, x, y)); }
static char *main_sp_screens(void) { return ON_MAIN(char *, sp_screens()); }
static void main_windowResizeInstant(void) { hostRunOnMain(^{ windowResizeInstant(); }); }
static bool main_sp_window_reveal_after_load(uintptr_t window, char **error) {
    return ON_MAIN(bool, sp_window_reveal_after_load((void *)window, error));
}
static void main_sp_window_show(uintptr_t window) { hostRunOnMain(^{ sp_window_show((void *)window); }); }
*/
import "C"

import (
	"errors"
	"fmt"

	"unsafe"

	handles "github.com/soksak-app/core/packages/host/go/src/callback"
	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// implementation is the platform.Platform of macOS.
type implementation struct{}

func init() { platform.Register(implementation{}) }

func (implementation) PrepareWindow(window platform.Window) error {
	C.nativeWindowPrepare(C.uintptr_t(window))
	return nil
}

func (implementation) Fullscreen(window platform.Window, on bool, done func()) error {
	handle := handles.NewHandle(done)
	if !bool(C.nativeWindowFullscreen(C.uintptr_t(window), C.bool(on), C.uintptr_t(handle))) {
		handle.Delete()
		return errors.New("the window does not support full screen")
	}
	return nil
}

// The observation callbacks by observation. They are read and changed only in main-thread steps.
var responderObservers = map[unsafe.Pointer]handles.Handle{}

func (implementation) ObserveResponder(window platform.Window, changed func()) (unsafe.Pointer, error) {
	handle := handles.NewHandle(changed)
	observation := C.nativeWindowObserveResponder(C.uintptr_t(window), C.uintptr_t(handle))
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
	handles.Handle(value).Value().(func())()
}

//export goNativeFullscreenDone
func goNativeFullscreenDone(value C.uintptr_t) {
	handle := handles.Handle(value)
	done := handle.Value().(func())
	handle.Delete()
	done()
}

func (implementation) TitlebarHeight(window platform.Window) (float64, error) {
	// 0 is the height of a window without a title bar (full screen), and a negative value is a window that cannot have a title bar.
	row := float64(C.main_windowTitlebarHeight(C.uintptr_t(window)))
	if row < 0 {
		return 0, errors.New("the window has no standard buttons or content view for a title bar")
	}
	return row, nil
}

func (implementation) SetTitlebarHeight(window platform.Window, height float64) error {
	var failure *C.char
	if !bool(C.main_windowSetTitlebarHeight(C.uintptr_t(window), C.double(height), &failure)) {
		defer C.free(unsafe.Pointer(failure))
		return errors.New(C.GoString(failure))
	}
	return nil
}

func (implementation) WindowControls(window platform.Window) (platform.Rect, error) {
	var out [4]C.double
	C.main_windowControls(C.uintptr_t(window), &out[0])
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

func (implementation) WindowFacts(window platform.Window) (string, error) {
	return facts(C.main_sp_window_facts(C.uintptr_t(window)), "window state")
}

func (implementation) WindowOnScreen(window platform.Window) (bool, error) {
	if window == 0 {
		return false, errors.New("window on screen: the window is gone")
	}
	return bool(C.main_sp_window_on_screen(C.uintptr_t(window))), nil
}

func (implementation) WindowColorSpace(window platform.Window) (string, error) {
	return facts(C.main_sp_window_color_space_facts(C.uintptr_t(window)), "window color-space facts")
}

func (implementation) WindowHit(window platform.Window, x, y float64) (string, error) {
	return facts(C.main_sp_window_hit(C.uintptr_t(window), C.double(x), C.double(y)), "window hit testing")
}

func (implementation) MoveWindow(window platform.Window, x, y float64) error {
	if !C.main_sp_window_move(C.uintptr_t(window), C.double(x), C.double(y)) {
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

func (implementation) ShowWindow(window platform.Window) error {
	C.main_sp_window_show(C.uintptr_t(window))
	return nil
}

func (implementation) RevealAfterLoad(window platform.Window) error {
	var failure *C.char
	if !bool(C.main_sp_window_reveal_after_load(C.uintptr_t(window), &failure)) {
		defer C.free(unsafe.Pointer(failure))
		return errors.New(C.GoString(failure))
	}
	return nil
}
