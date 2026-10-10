// Reports the pressed mouse button mask that AppKit reports.
//
// A human button changes NSEvent.pressedMouseButtons even while this application is inactive and another application is
// frontmost, and input_inject.m rejects a synthetic press and release when that mask is not 0. The global event monitor
// receives button events delivered to other applications, and the local event monitor receives button events delivered
// to this application. Both monitors use public AppKit API, and the global monitor of mouse events does not require the
// accessibility permission.
#import <Cocoa/Cocoa.h>
#import "mouse_buttons.h"

static const NSEventMask buttonEvents = NSEventMaskLeftMouseDown | NSEventMaskLeftMouseUp
    | NSEventMaskRightMouseDown | NSEventMaskRightMouseUp | NSEventMaskOtherMouseDown | NSEventMaskOtherMouseUp;

static id localMonitor, globalMonitor;

bool sp_mouse_buttons_watch(sp_mouse_buttons_changed changed, void *context) {
    if (!changed || !NSThread.isMainThread || localMonitor || globalMonitor) return false;
    // The handler of a monitor runs on the main thread. The mask is read from the AppKit state of the turn being handled, not from the event.
    void (^report)(void) = ^{ changed(context, NSEvent.pressedMouseButtons); };
    id local = [NSEvent addLocalMonitorForEventsMatchingMask:buttonEvents handler:^NSEvent *(NSEvent *event) {
        report();
        return event;
    }];
    id global = [NSEvent addGlobalMonitorForEventsMatchingMask:buttonEvents handler:^(NSEvent *event) {
        report();
    }];
    if (!local || !global) {
        if (local) [NSEvent removeMonitor:local];
        if (global) [NSEvent removeMonitor:global];
        return false;
    }
    localMonitor = [local retain];
    globalMonitor = [global retain];
    report();
    return true;
}
