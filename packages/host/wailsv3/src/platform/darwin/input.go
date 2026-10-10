//go:build darwin

package darwin

/*
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include "input_inject.h"
#import <Cocoa/Cocoa.h>

extern void inputActivated(void *context, int result, char *frontmost);
static void activated(void *context, sp_activate_result result, const char *frontmost) {
    inputActivated(context, (int)result, (char *)frontmost);
}
static void activateWindowAt(void *window, double x, double y, double timeout, uintptr_t handle) {
    sp_input_activate_at(window, x, y, timeout, activated, (void *)handle);
}

extern void inputDelivered(void *context, int result, sp_input_held *held);
static void delivered(void *context, sp_input_result result, const sp_input_held *held) {
    inputDelivered(context, (int)result, (sp_input_held *)held);
}
static void injectPointer(void *window, double x, double y, int phase, int button, double deltaX, double deltaY,
    double receive, uintptr_t handle) {
    sp_input_pointer_then(window, x, y, phase, button, deltaX, deltaY, receive, delivered, (void *)handle);
}

// Announces whether a view that a press passes through is a surface. For a surface it returns a non-zero value, and the upward
// search from the hit view stops there.
extern int surfaceHit(uintptr_t owner, void* view);

// Announces one step of a left button drag in page coordinates. phase is 0 for press, 1 for move and 2 for release.
extern void surfacePoint(uintptr_t owner, int phase, double x, double y);

// Announces the first surface found while going up from a view to the content view. It returns whether a surface was found. This value
// shows whether the input started in a view of this app and not in the page.
static int surfaceWalk(uintptr_t owner, NSView* view, NSView* content) {
    while (view != nil && view != content) {
        if (surfaceHit(owner, (void*)view)) {
            return 1;
        }
        view = [view superview];
    }
    return 0;
}

// A surface is a native view, so input over a surface does not reach the page. One monitor of the app
// receives all presses, drags and key inputs and announces the target view and the position of the input.
//
// The target of a press is found with hitTest:. The target of a key input is the first responder of the window, and a page that
// took the focus by itself becomes the first responder. A page that focuses a search field when it loads would otherwise leave the page model
// pointing at the surface pressed last without this handling. In both cases
// the coordinates are not converted, so they do not drift from the region of the page.
//
// The position of a drag must be converted. The grab region of a boundary is wider than the passage between two cards, so when the passage
// width is one line, that whole region is over a surface and a press inside it does not reach the page.
// The page decides the meaning of the position, and this function computes the page
// coordinates from the height of the content view that the page view filled.
//
// A drag that started in the page is handled by the page, so it is not delivered. Delivering it would pile up one message per pointer move on the thread
// that redraws the plane.
//
// The monitor returns the event without changing it, so the view also receives the event.
static uintptr_t surfaceWatchMouse(void* nsWindow, uintptr_t owner) {
    __block int surfaceDragging = 0;
    NSWindow* window = (NSWindow*)nsWindow;
    NSEventMask mask = NSEventMaskLeftMouseDown | NSEventMaskLeftMouseDragged
                     | NSEventMaskLeftMouseUp | NSEventMaskKeyDown;
    return (uintptr_t)[NSEvent addLocalMonitorForEventsMatchingMask:mask
                                          handler:^NSEvent*(NSEvent* event) {
        if ([event window] == window) {
            NSView* content = [window contentView];
            NSEventType type = [event type];
            if (type == NSEventTypeKeyDown) {
                NSResponder* first = [window firstResponder];
                if ([first isKindOfClass:[NSView class]]) {
                    surfaceWalk(owner, (NSView*)first, content);
                }
            } else {
                NSPoint at = [event locationInWindow];
                double x = at.x;
                double y = [content bounds].size.height - at.y;
                if (type == NSEventTypeLeftMouseDown) {
                    surfaceDragging = surfaceWalk(owner, [content hitTest:at], content);
                    if (surfaceDragging) surfacePoint(owner, 0, x, y);
                } else if (surfaceDragging) {
                    surfacePoint(owner, type == NSEventTypeLeftMouseDragged ? 1 : 2, x, y);
                    if (type == NSEventTypeLeftMouseUp) surfaceDragging = 0;
                }
            }
        }
        return event;
    }];
}

static void surfaceUnwatchMouse(uintptr_t monitor) { if (monitor) [NSEvent removeMonitor:(id)monitor]; }
*/
import "C"

import (
	"errors"
	"fmt"
	"runtime/cgo"
	"sync"
	"unsafe"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// watchers are the input receiver handles of each monitor number. They are read and changed only on the main thread.
var watchers = map[uintptr]cgo.Handle{}
var pointerSequence sync.Mutex

//export surfaceHit
func surfaceHit(owner C.uintptr_t, view unsafe.Pointer) C.int {
	if cgo.Handle(owner).Value().(platform.Input).Press(uintptr(view)) {
		return 1
	}
	return 0
}

//export surfacePoint
func surfacePoint(owner C.uintptr_t, phase C.int, x C.double, y C.double) {
	cgo.Handle(owner).Value().(platform.Input).Point(int(phase), float64(x), float64(y))
}

func (implementation) WatchInput(window unsafe.Pointer, input platform.Input) (uintptr, error) {
	handle := cgo.NewHandle(input)
	monitor := uintptr(C.surfaceWatchMouse(window, C.uintptr_t(handle)))
	watchers[monitor] = handle
	return monitor, nil
}

// InjectPointer delivers input with sp_input_pointer_then of native/darwin. It does not activate the application.
func (implementation) InjectPointer(window unsafe.Pointer, x, y float64, phase, button int, deltaX, deltaY, receive float64, done func(platform.PointerResult, platform.ButtonHeld)) error {
	pointerSequence.Lock()
	var once sync.Once
	serialized := func(result platform.PointerResult, held platform.ButtonHeld) {
		once.Do(func() {
			pointerSequence.Unlock()
			done(result, held)
		})
	}
	C.injectPointer(window, C.double(x), C.double(y), C.int(phase), C.int(button), C.double(deltaX), C.double(deltaY),
		C.double(receive), C.uintptr_t(cgo.NewHandle(serialized)))
	return nil
}

// inputDelivered announces the result of sp_input_pointer_then. The library passes held only when the result is SP_INPUT_BUTTON_HELD
// and keeps it valid until done returns.
//
//export inputDelivered
func inputDelivered(context unsafe.Pointer, result C.int, held *C.sp_input_held) {
	handle := cgo.Handle(uintptr(context))
	done := handle.Value().(func(platform.PointerResult, platform.ButtonHeld))
	handle.Delete()
	switch C.sp_input_result(result) {
	case C.SP_INPUT_DELIVERED:
		done(platform.PointerDelivered, platform.ButtonHeld{})
	case C.SP_INPUT_INACTIVE:
		done(platform.PointerInactive, platform.ButtonHeld{})
	case C.SP_INPUT_UNRECEIVED:
		done(platform.PointerUnreceived, platform.ButtonHeld{})
	case C.SP_INPUT_BUTTON_HELD:
		done(platform.PointerButtonHeld, buttonHeld(held))
	case C.SP_INPUT_PRESS_OPEN:
		done(platform.PointerPressOpen, platform.ButtonHeld{})
	default:
		done(platform.PointerRejected, platform.ButtonHeld{})
	}
}

// buttonHeld reads sp_input_held. When pid is -1, there is no frontmost application. A notification of this result without a state is
// a contract violation of the library, so it stops and names the violation.
func buttonHeld(held *C.sp_input_held) platform.ButtonHeld {
	if held == nil {
		panic("sp_input_pointer_then reported SP_INPUT_BUTTON_HELD without its state")
	}
	result := platform.ButtonHeld{Mask: uint64(held.mask)}
	if held.pid >= 0 {
		result.Frontmost = &platform.FrontmostApplication{PID: int(held.pid)}
		if held.bundleIdentifier != nil {
			result.Frontmost.BundleIdentifier = C.GoString(held.bundleIdentifier)
		}
	}
	return result
}

type activation struct {
	timeout float64
	done    func(error)
}

//export inputActivated
func inputActivated(context unsafe.Pointer, result C.int, frontmost *C.char) {
	handle := cgo.Handle(uintptr(context))
	a := handle.Value().(activation)
	handle.Delete()
	name := "unknown"
	if frontmost != nil {
		name = C.GoString(frontmost)
	}
	a.done(activationResult(C.sp_activate_result(result), a.timeout, name))
}

// activationResult converts the result of sp_input_activate to an error that names the stage where it stopped and the frontmost application.
func activationResult(result C.sp_activate_result, timeout float64, frontmost string) error {
	switch result {
	case C.SP_ACTIVATE_DONE:
		return nil
	case C.SP_ACTIVATE_REFUSED:
		return fmt.Errorf("the system did not activate the application within %gs; the frontmost application is %s", timeout, frontmost)
	case C.SP_ACTIVATE_NOT_KEY:
		return fmt.Errorf("the application is active but the window did not become key within %gs; the frontmost application is %s", timeout, frontmost)
	case C.SP_ACTIVATE_PENDING:
		return fmt.Errorf("the window's webviews did not apply the active state within %gs", timeout)
	case C.SP_ACTIVATE_LOST:
		return fmt.Errorf("the window lost activation before its webviews applied it; the frontmost application is %s", frontmost)
	default:
		return errors.New("the window cannot be activated")
	}
}

// ActivateWindow makes the window the key window with sp_input_activate of native/darwin.
func (implementation) ActivateWindow(window unsafe.Pointer, x, y, timeout float64, done func(error)) error {
	C.activateWindowAt(window, C.double(x), C.double(y), C.double(timeout), C.uintptr_t(cgo.NewHandle(activation{timeout, done})))
	return nil
}

// InjectKey delivers input with sp_input_key of native/darwin. When text is empty, it types key.
func (implementation) InjectKey(window unsafe.Pointer, key, text string, modifiers uint, down bool) (platform.PointerResult, error) {
	name := C.CString(key)
	defer C.free(unsafe.Pointer(name))
	var typed *C.char
	if text != "" {
		typed = C.CString(text)
		defer C.free(unsafe.Pointer(typed))
	}
	switch C.sp_input_key(window, name, typed, C.uint(modifiers), C.bool(down)) {
	case C.SP_INPUT_DELIVERED:
		return platform.PointerDelivered, nil
	case C.SP_INPUT_INACTIVE:
		return platform.PointerInactive, nil
	default:
		return platform.PointerRejected, nil
	}
}

func (implementation) UnwatchInput(monitor uintptr) {
	if handle, ok := watchers[monitor]; ok {
		C.surfaceUnwatchMouse(C.uintptr_t(monitor))
		handle.Delete()
		delete(watchers, monitor)
	}
}
