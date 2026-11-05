#import <Cocoa/Cocoa.h>
#import <stdio.h>
#import <stdlib.h>
#import <unistd.h>
#import "window_reveal.h"

// A window that an application that is not active puts on the screen stays behind the front application, which stays
// the front application. It runs on a display with another application in front, as a covered window is the normal case
// of a check (docs/spec/hosts.md#launch-activation).

static int failures;

static void check(BOOL condition, NSString *what) {
    if (condition) return;
    fprintf(stderr, "FAIL: %s\n", what.UTF8String);
    failures++;
}

static void spin(void) {
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.3]];
}

static NSWindow *makeWindow(void) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 200, 150)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    return window;
}

// The place of the window among the normal windows on the screen, front to back, or -1.
static NSInteger placeOf(NSWindow *window) {
    NSArray *list = CFBridgingRelease(CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    NSInteger place = 0;
    for (NSDictionary *row in list) {
        if ([row[(id)kCGWindowLayer] integerValue] != 0) continue;
        if ([row[(id)kCGWindowNumber] integerValue] == window.windowNumber) return place;
        place++;
    }
    return -1;
}

// The place of the first normal window of the process pid, or -1.
static NSInteger placeOfProcess(pid_t pid) {
    NSArray *list = CFBridgingRelease(CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    NSInteger place = 0;
    for (NSDictionary *row in list) {
        if ([row[(id)kCGWindowLayer] integerValue] != 0) continue;
        if ([row[(id)kCGWindowOwnerPID] intValue] == pid) return place;
        place++;
    }
    return -1;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    spin();

    NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
    check(front != nil && front.processIdentifier != getpid(), @"another application is in front at the start");
    NSInteger frontPlace = placeOfProcess(front.processIdentifier);
    // A front application without a window has nothing to cover: the place is not compared, and the front is.
    if (frontPlace < 0) printf("window show order: the front application %s shows no window, so the place is not compared\n", front.localizedName.UTF8String);

    NSWindow *first = makeWindow();
    sp_window_show(first);
    spin();
    check(first.isVisible, @"the first window is on the screen");
    check(frontPlace < 0 || placeOf(first) > frontPlace, [NSString stringWithFormat:
        @"the first window is at place %ld, behind the front application at place %ld", (long)placeOf(first), (long)frontPlace]);
    check(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == front.processIdentifier,
        @"the first window leaves the front application in front");

    NSWindow *second = makeWindow();
    sp_window_show(second);
    spin();
    check(second.isVisible, @"the second window is on the screen");
    check(frontPlace < 0 || placeOf(second) > frontPlace, [NSString stringWithFormat:
        @"the second window is at place %ld, behind the front application at place %ld", (long)placeOf(second), (long)frontPlace]);
    check(placeOf(second) < placeOf(first), @"the second window is in front of the first window of its application");
    check(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == front.processIdentifier,
        @"the second window leaves the front application in front");
    check(!NSRunningApplication.currentApplication.active, @"the application is not activated");

    printf("window show order: front %s pid %d place %ld, first window place %ld, second window place %ld, front after %s, application active %d\n",
        front.localizedName.UTF8String, front.processIdentifier, (long)frontPlace, (long)placeOf(first), (long)placeOf(second),
        NSWorkspace.sharedWorkspace.frontmostApplication.localizedName.UTF8String, NSRunningApplication.currentApplication.active);
    [first close];
    [second close];
    [first release];
    [second release];
    if (failures) return 1;
    printf("window show order: ok\n");
    return 0;
} }
