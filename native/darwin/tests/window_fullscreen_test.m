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

// The delegate of the window that the framework owns. It does not implement the failure methods of a full screen transition,
// which AppKit sends only to the delegate of the window.
@interface SPFrameworkDelegate : NSObject <NSWindowDelegate>
@end
@implementation SPFrameworkDelegate
@end

// tests/support/no_activation.m: this check activates the app in make test-app-activation.
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
    SPFrameworkDelegate *frameworkDelegate = [[SPFrameworkDelegate alloc] init];
    window.delegate = frameworkDelegate;
    [window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];

    __block BOOL entered = NO;
    check(sp_window_fullscreen(window, true, ^(int result, const char *message) { entered = result == SP_FULLSCREEN_DONE; }), @"the window accepts a full screen request");
    until(^BOOL { return entered; });
    check(entered && fullscreen(window), @"entering full screen answers after the transition");

    // A request that arrives during the transition. macOS ignores -toggleFullScreen: at that moment, so it must be
    // handled after the transition ends.
    __block int answers = 0;
    __block BOOL back = NO;
    sp_window_fullscreen(window, false, ^(int result, const char *message) { answers++; });
    sp_window_fullscreen(window, true, ^(int result, const char *message) { answers++; back = result == SP_FULLSCREEN_DONE; });
    until(^BOOL { return back; });
    check(back && fullscreen(window), @"a request during the transition is applied after it");
    check(answers == 2, [NSString stringWithFormat:@"every request is answered (%d of 2)", answers]);

    __block BOOL done = NO;
    sp_window_fullscreen(window, false, ^(int result, const char *message) { done = result == SP_FULLSCREEN_DONE; });
    until(^BOOL { return done; });
    check(done && !fullscreen(window), @"leaving full screen answers after the transition");

    __block BOOL already = NO;
    sp_window_fullscreen(window, false, ^(int result, const char *message) { already = result == SP_FULLSCREEN_DONE; });
    check(already, @"a request for the current state answers at once");

    // macOS ignores the request of a window that is not shown and sends no notification, so the request is refused in its turn,
    // and a later request is answered as well.
    NSWindow *hidden = [[NSWindow alloc] initWithContentRect:NSMakeRect(200, 200, 400, 300)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered defer:NO];
    [hidden setReleasedWhenClosed:NO];
    hidden.collectionBehavior |= NSWindowCollectionBehaviorFullScreenPrimary;
    __block int refusals = 0;
    __block NSString *refusal = nil;
    for (int request = 0; request < 2; request++) {
        sp_window_fullscreen(hidden, true, ^(int result, const char *message) {
            if (result == SP_FULLSCREEN_REFUSED) refusals++;
            refusal = message ? [@(message) copy] : nil;
        });
    }
    check(refusals == 2, [NSString stringWithFormat:@"each request of a window that is not shown is refused in its turn (%d of 2)", refusals]);
    check([refusal isEqualToString:@"the window is not shown"],
        [NSString stringWithFormat:@"the refusal names its cause (got %@)", refusal]);

    // A started transition that fails is reported to the delegate of the window, and that failure answers the request once.
    __block int failedAnswers = 0;
    __block int failed = 0;
    __block NSString *failure = nil;
    sp_window_fullscreen(window, true, ^(int result, const char *message) {
        failedAnswers++;
        if (result == SP_FULLSCREEN_FAILED) failed++;
        failure = message ? [@(message) copy] : nil;
    });
    BOOL heard = [window.delegate respondsToSelector:@selector(windowDidFailToEnterFullScreen:)];
    check(heard, @"the host hears the failure of a full screen transition at the delegate of the window");
    if (heard) [(id<NSWindowDelegate>)window.delegate windowDidFailToEnterFullScreen:window];
    until(^BOOL { return failedAnswers > 0; });
    check(failedAnswers == 1 && failed == 1 && [failure isEqualToString:@"macOS failed the full screen transition"],
        [NSString stringWithFormat:@"the failure of a started transition answers once (%d answers, %d failures, %@)",
            failedAnswers, failed, failure]);
    until(^BOOL { return fullscreen(window); });
    __block BOOL left = NO;
    sp_window_fullscreen(window, false, ^(int result, const char *message) { left = result == SP_FULLSCREEN_DONE; });
    until(^BOOL { return left; });
    check(failedAnswers == 1 && !fullscreen(window), @"the end of the transition after its failure answers nothing again");

    // A window that closes during a transition answers its request with the close.
    __block int closed = 0;
    __block int answered = 0;
    sp_window_fullscreen(window, true, ^(int result, const char *message) {
        answered++;
        if (result == SP_FULLSCREEN_CLOSED) closed++;
    });
    [window close];
    until(^BOOL { return answered > 0; });
    check(answered == 1 && closed == 1,
        [NSString stringWithFormat:@"the close of the window answers its request once with the close (%d answers, %d closes)", answered, closed]);
    [hidden close];
    [hidden release];
    [window release];
    [frameworkDelegate release];
    return failures ? 1 : 0;
}}
