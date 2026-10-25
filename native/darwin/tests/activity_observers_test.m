// The activity of the application and of its windows is recorded as events of the ring (docs/spec/logging.md#automatic-entrances).
// The check posts the notifications that AppKit posts and reads the events; it does not activate the application.
#import <Cocoa/Cocoa.h>
#import "activity_observers.h"
#import "support/records.h"
#import "event_ring.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

int main(void) { @autoreleasepool {
    // The records that this test reads include events below the level error, which the default policy refuses (docs/spec/logging.md#policy):
    // the policy that stores every level is set here, and the default policy is tested in event_ring_test.
    const int8_t everything[SP_CLASS_COUNT] = {SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE};
    check(sp_event_set_policy(everything), @"the policy stores every level of every class");
    [NSApplication sharedApplication];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 200, 100)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    NSTextView *field = [[NSTextView alloc] initWithFrame:NSMakeRect(0, 0, 100, 50)];
    [window.contentView addSubview:field];
    [window makeFirstResponder:field];

    sp_observe_activity();
    sp_observe_activity();  // a second call installs nothing more
    NSRunningApplication *frontmostAtDeactivation = NSWorkspace.sharedWorkspace.frontmostApplication;
    NSArray<NSDictionary *> *events = capturedEvents(^{
        NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
        [center postNotificationName:NSApplicationDidBecomeActiveNotification object:NSApp];
        [center postNotificationName:NSApplicationDidResignActiveNotification object:NSApp];
        [center postNotificationName:NSWindowDidBecomeKeyNotification object:window];
        [center postNotificationName:NSWindowDidResignKeyNotification object:window];
        [center postNotificationName:NSWindowDidBecomeMainNotification object:window];
        [center postNotificationName:NSWindowDidChangeOcclusionStateNotification object:window];
        [center postNotificationName:NSTextInputContextKeyboardSelectionDidChangeNotification object:nil];
    });
    NSMutableArray<NSString *> *names = [NSMutableArray array];
    for (NSDictionary *event in events) [names addObject:event[@"name"]];
    NSArray *want = @[@"native.app.activated", @"native.app.deactivated", @"native.window.key", @"native.window.resign_key",
        @"native.window.main", @"native.window.occlusion", @"native.input.source_changed"];
    check([names isEqualToArray:want], [NSString stringWithFormat:@"the events are %@ (want %@)", names, want]);
    for (NSDictionary *event in events) check([event[@"level"] intValue] == 2, [NSString stringWithFormat:@"%@ is at the level info", event[@"name"]]);
    NSDictionary *deactivated = events.count > 1 ? events[1][@"fields"] : @{};
    id expectedFrontmostPid = frontmostAtDeactivation ? @(frontmostAtDeactivation.processIdentifier) : NSNull.null;
    id expectedFrontmostBundle = frontmostAtDeactivation.bundleIdentifier ?: NSNull.null;
    check([deactivated[@"frontmost_pid"] isEqual:expectedFrontmostPid] &&
        [deactivated[@"frontmost_bundle"] isEqual:expectedFrontmostBundle],
        [NSString stringWithFormat:@"deactivation records the event-time frontmost process (%@, want %@ %@)",
            deactivated, expectedFrontmostPid, expectedFrontmostBundle]);
    NSDictionary *key = events.count > 2 ? events[2][@"fields"] : @{};
    check([key[@"window"] intValue] == (int)window.windowNumber, @"the key event names the window number");
    check([key[@"first_responder"] isEqual:NSStringFromClass([field class])], @"the key event names the class of the first responder");
    NSDictionary *occlusion = events.count > 5 ? events[5][@"fields"] : @{};
    check([occlusion[@"visible"] isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)occlusion[@"visible"]) == CFBooleanGetTypeID(),
        @"the occlusion event says whether the window is visible as a boolean");

    // The activation of the application names the application that another activation made frontmost before it, from the
    // notifications of the workspace, so the source of an activation is found from the records.
    NSRunningApplication *previous = nil;
    for (NSRunningApplication *app in NSWorkspace.sharedWorkspace.runningApplications) {
        if (app.processIdentifier != getpid() && app.bundleIdentifier.length > 0) {
            previous = app;
            break;
        }
    }
    check(previous != nil, @"another application with a bundle identifier runs");
    NSArray<NSDictionary *> *activations = capturedEvents(^{
        [NSWorkspace.sharedWorkspace.notificationCenter postNotificationName:NSWorkspaceDidActivateApplicationNotification
            object:NSWorkspace.sharedWorkspace userInfo:@{NSWorkspaceApplicationKey: previous}];
        [NSNotificationCenter.defaultCenter postNotificationName:NSApplicationDidBecomeActiveNotification object:NSApp];
    });
    NSDictionary *activated = nil;
    for (NSDictionary *event in activations) {
        if ([event[@"name"] isEqual:@"native.app.activated"]) activated = event[@"fields"];
    }
    check([activated[@"previous_pid"] intValue] == previous.processIdentifier && [activated[@"previous_bundle"] isEqual:previous.bundleIdentifier],
        [NSString stringWithFormat:@"the activation names the application that was frontmost before it (%@, want %d %@)", activated,
            previous.processIdentifier, previous.bundleIdentifier]);

    // The first responder of a window changes without a notification: each change is an event with the classes before and after.
    NSTextField *other = [[NSTextField alloc] initWithFrame:NSMakeRect(0, 60, 100, 30)];
    [window.contentView addSubview:other];
    [NSNotificationCenter.defaultCenter postNotificationName:NSWindowDidUpdateNotification object:window];
    NSArray<NSDictionary *> *moves = capturedEvents(^{
        [window makeFirstResponder:other];
        [NSNotificationCenter.defaultCenter postNotificationName:NSWindowDidUpdateNotification object:window];
        [window makeFirstResponder:field];
        [NSNotificationCenter.defaultCenter postNotificationName:NSWindowDidUpdateNotification object:window];
    });
    NSMutableArray<NSString *> *moved = [NSMutableArray array];
    for (NSDictionary *event in moves) {
        if ([event[@"name"] isEqual:@"native.window.first_responder"]) {
            [moved addObject:[NSString stringWithFormat:@"%@>%@", event[@"fields"][@"from"], event[@"fields"][@"to"]]];
        }
    }
    // AppKit passes through the window and the field editor of a text field, so the check requires a chain: it starts at the
    // class of the first responder before the first move, each move starts where the earlier one ended, and it ends at the
    // class of the view that was made the first responder last.
    NSString *fieldClass = NSStringFromClass([field class]);
    NSMutableArray<NSArray<NSString *> *> *chain = [NSMutableArray array];
    for (NSString *move in moved) [chain addObject:[move componentsSeparatedByString:@">"]];
    BOOL linked = chain.count >= 2 && [chain.firstObject.firstObject isEqual:fieldClass] && [chain.lastObject.lastObject isEqual:fieldClass];
    for (NSUInteger index = 1; index < chain.count; index++) linked = linked && [chain[index].firstObject isEqual:chain[index - 1].lastObject];
    check(linked, [NSString stringWithFormat:@"the first responder moves form a chain from and back to %@: %@", fieldClass, moved]);
    return failures == 0 ? 0 : 1;
} }
