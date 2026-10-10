// Checks that the end of a full screen transition is notified and that a request that arrives during the transition
// is handled afterwards. macOS ignores -toggleFullScreen: during a transition. The window occupies the full screen,
// so the check activates the application.
#import <Cocoa/Cocoa.h>
#import "window_fullscreen.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void until(BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:20];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
}

static BOOL fullscreen(NSWindow *window) {
    return (window.styleMask & NSWindowStyleMaskFullScreen) != 0;
}

// tests/support/no_activation.m: this check activates the app in make test-activation.
void sp_test_declare_activation(void);

int main(void) { @autoreleasepool {
    sp_test_declare_activation();
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    [NSApp finishLaunching];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(200, 200, 800, 500)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.collectionBehavior |= NSWindowCollectionBehaviorFullScreenPrimary;
    [window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];

    __block BOOL entered = NO;
    check(sp_window_fullscreen(window, true, ^{ entered = YES; }), @"the window accepts a full screen request");
    until(^BOOL { return entered; });
    check(entered && fullscreen(window), @"entering full screen answers after the transition");

    // A request that arrives during the transition. macOS ignores -toggleFullScreen: at that moment, so it must be
    // handled after the transition ends.
    __block int answers = 0;
    __block BOOL back = NO;
    sp_window_fullscreen(window, false, ^{ answers++; });
    sp_window_fullscreen(window, true, ^{ answers++; back = YES; });
    until(^BOOL { return back; });
    check(back && fullscreen(window), @"a request during the transition is applied after it");
    check(answers == 2, [NSString stringWithFormat:@"every request is answered (%d of 2)", answers]);

    __block BOOL done = NO;
    sp_window_fullscreen(window, false, ^{ done = YES; });
    until(^BOOL { return done; });
    check(done && !fullscreen(window), @"leaving full screen answers after the transition");

    __block BOOL already = NO;
    sp_window_fullscreen(window, false, ^{ already = YES; });
    check(already, @"a request for the current state answers at once");

    [window close];
    [window release];
    return failures ? 1 : 0;
}}
