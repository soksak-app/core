// Checks that the mouse button monitor reports the mask at the moment of installation and, for each press and release of a mouse button delivered to the application, the mask that AppKit reports.
// It does not activate the application.
//
// Presses and releases delivered to other applications (global event monitor) arise only from a human button or real input posted to the window server,
// so this check does not cover them. The window check observes that path through host.buttons.
#import <Cocoa/Cocoa.h>
#import "mouse_buttons.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Records, for each notification, the mask and the mask that AppKit reported at that point.
static NSMutableArray<NSArray<NSNumber *> *> *reports;

static void changed(void *context, unsigned long long mask) {
    [reports addObject:@[@(mask), @(NSEvent.pressedMouseButtons), @(NSThread.isMainThread), @((uintptr_t)context)]];
}

static NSEvent *mouse(NSEventType type) {
    return [NSEvent mouseEventWithType:type location:NSZeroPoint modifierFlags:0
        timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:0 context:nil eventNumber:0
        clickCount:type == NSEventTypeMouseMoved ? 0 : 1 pressure:0];
}

// Takes the events of the event queue and delivers them to the application. The local event monitor receives events in this delivery.
static void pump(NSString *what, BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny
            untilDate:[NSDate dateWithTimeIntervalSinceNow:0.01] inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event) [NSApp sendEvent:event];
    }
    if (!done()) { fprintf(stderr, "FAIL: %s within 10 seconds (%lu reports)\n", what.UTF8String, (unsigned long)reports.count); exit(1); }
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    reports = [NSMutableArray array];

    // dispatch_sync can run the block on the calling thread, so the block is run on another thread and waited for.
    __block bool background = true;
    dispatch_semaphore_t finished = dispatch_semaphore_create(0);
    [NSThread detachNewThreadWithBlock:^{
        background = sp_mouse_buttons_watch(changed, (void *)7);
        dispatch_semaphore_signal(finished);
    }];
    dispatch_semaphore_wait(finished, DISPATCH_TIME_FOREVER);
    dispatch_release(finished);
    check(!background && reports.count == 0, @"a watch outside the main thread is refused and reports nothing");

    check(sp_mouse_buttons_watch(changed, (void *)7), @"the watch is installed on the main thread");
    check(reports.count == 1 && [reports[0][0] isEqual:reports[0][1]] && [reports[0][2] boolValue] && [reports[0][3] unsignedLongValue] == 7,
        [NSString stringWithFormat:@"the watch reports the current mask once on the main thread when it is installed: %@", reports]);
    check(!sp_mouse_buttons_watch(changed, (void *)8) && reports.count == 1, @"a second watch is refused");

    // A move without a button is not reported. The queue is taken in order, so after the last release is reported the move has been delivered too.
    NSEventType types[] = {
        NSEventTypeMouseMoved,
        NSEventTypeLeftMouseDown, NSEventTypeLeftMouseUp,
        NSEventTypeRightMouseDown, NSEventTypeRightMouseUp,
        NSEventTypeOtherMouseDown, NSEventTypeOtherMouseUp,
        NSEventTypeMouseMoved,
    };
    for (size_t i = 0; i < sizeof types / sizeof types[0]; i++) [NSApp postEvent:mouse(types[i]) atStart:NO];
    // Puts a marker after the last move to know the point at which all events of the queue have been delivered.
    __block BOOL drained = NO;
    NSEvent *marker = [NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0
        timestamp:0 windowNumber:0 context:nil subtype:0x4654 data1:0 data2:0];
    id markerMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskApplicationDefined handler:^NSEvent *(NSEvent *event) {
        if (event.subtype == 0x4654) drained = YES;
        return event;
    }];
    [NSApp postEvent:marker atStart:NO];
    pump(@"the posted events were not delivered", ^BOOL { return drained; });
    [NSEvent removeMonitor:markerMonitor];
    BOOL matching = reports.count == 7;
    for (NSArray<NSNumber *> *report in reports) {
        matching = matching && [report[0] isEqual:report[1]] && [report[2] boolValue] && [report[3] unsignedLongValue] == 7;
    }
    check(matching, [NSString stringWithFormat:
        @"each left, right, and other button press and release delivered to the application reports the AppKit mask, and a move reports nothing: %@",
        reports]);

    return failures ? 1 : 0;
}}
