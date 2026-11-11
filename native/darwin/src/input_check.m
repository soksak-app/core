// The windows that a check drives. See input_check.h.
//
// The drop stands at the front of -[NSApplication sendEvent:], which surface_layout.m replaces, so the observers of the actions
// of the user, the layout hold, the local monitors, AppKit and the views see none of the dropped events. input_inject.h delivers
// a synthetic pointer event on the main thread inside sp_input_delivering, through -[NSApplication sendEvent:] or to a view
// directly, so every pointer event that reaches the application outside it comes from the window server or from AppKit.
#import <Cocoa/Cocoa.h>
#include <stdatomic.h>
#import "input_check.h"
#import "input_inject.h"
#import "observe.h"
#import "surface_layout.h"

// The pointer events of the window server and of AppKit.
static const NSEventMask pointerEvents = NSEventMaskLeftMouseDown | NSEventMaskLeftMouseUp | NSEventMaskLeftMouseDragged
    | NSEventMaskRightMouseDown | NSEventMaskRightMouseUp | NSEventMaskRightMouseDragged | NSEventMaskOtherMouseDown
    | NSEventMaskOtherMouseUp | NSEventMaskOtherMouseDragged | NSEventMaskMouseMoved | NSEventMaskMouseEntered
    | NSEventMaskMouseExited | NSEventMaskCursorUpdate | NSEventMaskScrollWheel | NSEventMaskMagnify | NSEventMaskRotate
    | NSEventMaskSwipe | NSEventMaskSmartMagnify | NSEventMaskGesture | NSEventMaskBeginGesture | NSEventMaskEndGesture
    | NSEventMaskPressure | NSEventMaskTabletPoint | NSEventMaskTabletProximity;

// The driven windows, each with the count of the events of a person that it did not take. A window is named by its address and
// is not retained: the end of the drive or the close of the window removes it, so a later window at the same address is not
// driven.
static NSMutableDictionary<NSValue *, NSNumber *> *driven;
// The observer of the close of each driven window.
static NSMutableDictionary<NSValue *, id> *closeObservers;
// The number of driven windows, written on the main thread and read on any thread.
static _Atomic(unsigned long) drivenCount;

// The content of the synthetic events that go back to the event queue and have not come back.
static NSMutableArray<NSString *> *returningEvents;

static NSString *content(NSEvent *event) {
    return [NSString stringWithFormat:@"%lu %.9f %ld %lu %ld %.3f %.3f", (unsigned long)event.type, event.timestamp,
        (long)event.windowNumber, (unsigned long)event.modifierFlags, (long)event.buttonNumber, event.locationInWindow.x,
        event.locationInWindow.y];
}

uint64_t sp_input_check_end(void *window) {
    NSCAssert(NSThread.isMainThread, @"the drive of a window belongs to the main thread");
    NSValue *key = [NSValue valueWithPointer:window];
    NSNumber *dropped = driven[key];
    // silent: a window that no check drives has dropped nothing, so its end answers 0.
    if (!dropped) return 0;
    [driven removeObjectForKey:key];
    [NSNotificationCenter.defaultCenter removeObserver:closeObservers[key]];
    [closeObservers removeObjectForKey:key];
    atomic_store(&drivenCount, driven.count);
    if (driven.count == 0) [returningEvents removeAllObjects];
    return dropped.unsignedLongLongValue;
}

bool sp_input_check_begin(void *window) {
    NSCAssert(NSThread.isMainThread, @"the drive of a window belongs to the main thread");
    if (!window) return false;
    NSValue *key = [NSValue valueWithPointer:window];
    if (driven[key]) return false;
    surfaceLayoutWatchInput();
    if (!driven) driven = [[NSMutableDictionary alloc] init];
    if (!closeObservers) closeObservers = [[NSMutableDictionary alloc] init];
    driven[key] = @0;
    closeObservers[key] = sp_observe_notification("input_check.close", SP_OBSERVE_RECORD, NSWindowWillCloseNotification,
        (__bridge NSWindow *)window, nil, ^(NSNotification *note) { sp_input_check_end(window); });
    atomic_store(&drivenCount, driven.count);
    return true;
}

bool sp_input_check_driven(void *window) {
    return window && driven[[NSValue valueWithPointer:window]] != nil;
}

bool sp_input_check_any(void) {
    return atomic_load(&drivenCount) > 0;
}

void sp_input_check_returning(NSEvent *event) {
    // silent: an event of a window that no check drives passes when it comes back, so it needs no mark.
    if (!event.window || !sp_input_check_driven((__bridge void *)event.window)) return;
    if (!returningEvents) returningEvents = [[NSMutableArray alloc] init];
    [returningEvents addObject:content(event)];
}

// Whether event is a synthetic event that comes back from a layout wait; it takes its mark.
static bool comesBack(NSEvent *event) {
    // silent: the predicate answers false while no synthetic event is on its way back.
    if (returningEvents.count == 0) return false;
    NSUInteger index = [returningEvents indexOfObject:content(event)];
    // silent: the predicate answers false for an event that no mark names.
    if (index == NSNotFound) return false;
    [returningEvents removeObjectAtIndex:index];
    return true;
}

bool sp_input_check_admits(NSEvent *event) {
    // silent: the gate answers true while no check drives a window, and the event goes on.
    if (driven.count == 0) return true;
    NSWindow *window = event.window;
    NSValue *key = window ? [NSValue valueWithPointer:(__bridge void *)window] : nil;
    NSNumber *dropped = key ? driven[key] : nil;
    // silent: an event of a window that no check drives goes on.
    if (!dropped) return true;
    // silent: a key event and an event of the application go on; the drive holds only the pointer.
    if (!(NSEventMaskFromType(event.type) & pointerEvents)) return true;
    // silent: a synthetic event of a delivery, or one that a layout wait gives back, goes on.
    if (sp_input_delivering() || comesBack(event)) return true;
    driven[key] = @(dropped.unsignedLongLongValue + 1);
    return false;
}
