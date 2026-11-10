#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <stdio.h>
#import <stdlib.h>
#import <unistd.h>
#import "window_reveal.h"
#import "support/event_wait.h"

// A window that an application that is not active puts on the screen stays behind the front application, which stays
// the front application: the first window goes behind every window and a later window directly above the frontmost window
// of its application. It runs on a display with another application in front, as a covered window is the normal case of a
// check (docs/spec/hosts.md#launch-activation).

static int failures;

static void check(BOOL condition, NSString *what) {
    if (condition) return;
    fprintf(stderr, "FAIL: %s\n", what.UTF8String);
    failures++;
}

// Counts the refreshes of a screen.
@interface SPRefreshes : NSObject
@property int left;
@end
@implementation SPRefreshes
- (void)tick:(CADisplayLink *)link {
    if (--self.left == 0) [link invalidate];
}
@end

// Runs the run loop until the screen has refreshed twice. The window server applies the order of a window, and an activation
// that the order or the launch would cause, before it composites the frame that shows the result, and the events of that
// change reach the application before the second refresh after it, so the state is judged after that refresh. The wait
// sends the events that arrive to the application meanwhile.
static void afterRefreshes(NSScreen *screen) {
    SPRefreshes *refreshes = [[SPRefreshes new] autorelease];
    refreshes.left = 2;
    // A link retains its target until it is invalidated.
    [[(screen ?: NSScreen.mainScreen) displayLinkWithTarget:refreshes selector:@selector(tick:)]
        addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
    eventWait(@"the screen refreshes twice", ^BOOL { return refreshes.left == 0; });
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

// The number of normal windows on the screen.
static NSInteger normalWindows(void) {
    NSArray *list = CFBridgingRelease(CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    NSInteger count = 0;
    for (NSDictionary *row in list) if ([row[(id)kCGWindowLayer] integerValue] == 0) count++;
    return count;
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
    // The hosts run with the regular policy, whose window that orders front goes in front of the front application. A window of
    // an accessory application stays behind it either way, so that policy would not tell the show from an order front.
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    [NSApp finishLaunching];
    afterRefreshes(NSScreen.mainScreen);

    NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
    check(front != nil && front.processIdentifier != getpid(), @"another application is in front at the start");
    NSInteger frontPlace = placeOfProcess(front.processIdentifier);
    // A front application without a window has nothing to cover: the place is not compared, and the front is.
    if (frontPlace < 0) printf("window show order: the front application %s shows no window, so the place is not compared\n", front.localizedName.UTF8String);

    NSWindow *first = makeWindow();
    sp_window_show(first);
    afterRefreshes(first.screen);
    check(first.isVisible, @"the first window is on the screen");
    check(frontPlace < 0 || placeOf(first) > frontPlace, [NSString stringWithFormat:
        @"the first window is at place %ld, behind the front application at place %ld", (long)placeOf(first), (long)frontPlace]);
    check(placeOf(first) == normalWindows() - 1, [NSString stringWithFormat:
        @"the first window is at place %ld of %ld normal windows, behind every window", (long)placeOf(first), (long)normalWindows()]);
    check(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == front.processIdentifier,
        @"the first window leaves the front application in front");

    NSWindow *second = makeWindow();
    sp_window_show(second);
    afterRefreshes(second.screen);
    check(second.isVisible, @"the second window is on the screen");
    check(frontPlace < 0 || placeOf(second) > frontPlace, [NSString stringWithFormat:
        @"the second window is at place %ld, behind the front application at place %ld", (long)placeOf(second), (long)frontPlace]);
    check(placeOf(second) == placeOf(first) - 1, [NSString stringWithFormat:
        @"the second window is at place %ld, directly in front of the first window of its application at place %ld",
        (long)placeOf(second), (long)placeOf(first)]);
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
