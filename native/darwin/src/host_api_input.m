// Native implementation of the host binding helpers formerly owned by input.go.
#include "host_api_input.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include "input_inject.h"
#include "main_thread.h"
#include "host_callbacks.h"
#include "observe.h"
#import <Cocoa/Cocoa.h>

static void activated(void *context, sp_activate_result result, const char *frontmost) {
    hostRunOnWorker(^{ sp_host_callback_input_activated((uintptr_t)context, (int)result, (char *)frontmost); });
}
void activateWindowAt(uintptr_t window, double x, double y, uintptr_t handle) {
    hostRunOnMain(^{ sp_input_activate_at((void *)window, x, y, activated, (void *)handle); });
}

static void delivered(void *context, sp_input_result result, const sp_input_held *held) {
    hostRunOnWorker(^{ sp_host_callback_input_delivered((uintptr_t)context, (int)result, (sp_input_held *)held); });
}
// pointer is a C string that the block frees after the delivery took it.
void injectPointer(uintptr_t window, char *pointer, double x, double y, int phase, int button, double deltaX, double deltaY, int clicks,
    uintptr_t handle) {
    hostRunOnMain(^{
        sp_input_pointer_then((void *)window, pointer, x, y, phase, button, deltaX, deltaY, clicks, delivered, (void *)handle);
        free(pointer);
    });
}

// Announces whether a view that a press passes through is a surface. For a surface it returns a non-zero value, and the upward
// search from the hit view stops there.

// Announces one step of a left button drag in page coordinates. phase is 0 for press, 1 for move and 2 for release.

// Announces the first surface found while going up from a view to the content view. It returns whether a surface was found. This value
// shows whether the input started in a view of this app and not in the page.
static int surfaceWalk(uintptr_t owner, NSView* view, NSView* content) {
    while (view != nil && view != content) {
        if (ON_WORKER(int, sp_host_callback_surface_hit(owner, (void*)view))) {
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
static uintptr_t surfaceWatchMouseOnMain(void* nsWindow, uintptr_t owner) {
    __block int surfaceDragging = 0;
    NSWindow* window = (NSWindow*)nsWindow;
    NSEventMask mask = NSEventMaskLeftMouseDown | NSEventMaskLeftMouseDragged
                     | NSEventMaskLeftMouseUp | NSEventMaskKeyDown;
    return (uintptr_t)sp_observe_local_monitor("host_input.surface", SP_OBSERVE_COUNT, mask, ^NSEvent*(NSEvent* event) {
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
                    if (surfaceDragging) hostRunOnWorker(^{ sp_host_callback_surface_point(owner, 0, x, y); });
                } else if (surfaceDragging) {
                    int phase = type == NSEventTypeLeftMouseDragged ? 1 : 2;
                    hostRunOnWorker(^{ sp_host_callback_surface_point(owner, phase, x, y); });
                    if (type == NSEventTypeLeftMouseUp) surfaceDragging = 0;
                }
            }
        }
        return event;
    });
}

uintptr_t surfaceWatchMouse(uintptr_t nsWindow, uintptr_t owner) {
    return ON_MAIN(uintptr_t, surfaceWatchMouseOnMain((void *)nsWindow, owner));
}

void surfaceUnwatchMouse(uintptr_t monitor) {
    hostRunOnMain(^{ if (monitor) [NSEvent removeMonitor:(id)monitor]; });
}

int main_sp_input_key(uintptr_t window, const char *key, const char *text, unsigned int modifiers, bool down) {
    return ON_MAIN(sp_input_result, sp_input_key((void *)window, key, text, modifiers, down));
}
