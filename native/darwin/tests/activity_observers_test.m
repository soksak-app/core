// The activity of the application and of its windows is recorded as events of the ring (docs/spec/logging.md#automatic-entrances).
// The check posts the notifications that AppKit posts and reads the events; it does not activate the application.
#import <Cocoa/Cocoa.h>
#import "activity_observers.h"
#import "support/records.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 200, 100)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    NSTextView *field = [[NSTextView alloc] initWithFrame:NSMakeRect(0, 0, 100, 50)];
    [window.contentView addSubview:field];
    [window makeFirstResponder:field];

    sp_observe_activity();
    sp_observe_activity();  // a second call installs nothing more
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
    NSDictionary *key = events.count > 2 ? events[2][@"fields"] : @{};
    check([key[@"window"] intValue] == (int)window.windowNumber, @"the key event names the window number");
    check([key[@"first_responder"] isEqual:NSStringFromClass([field class])], @"the key event names the class of the first responder");
    NSDictionary *occlusion = events.count > 5 ? events[5][@"fields"] : @{};
    check([occlusion[@"visible"] isKindOfClass:NSNumber.class], @"the occlusion event says whether the window is visible");
    return failures == 0 ? 0 : 1;
} }
