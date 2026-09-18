// 전체 화면 전환이 끝난 뒤에 알리는지, 전환 중에 들어온 요청을 그다음에 처리하는지 검사한다.
// macOS 는 전환 중의 -toggleFullScreen: 을 무시한다. 창이 전체 화면을 차지하므로 애플리케이션을
// 활성화한다.
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

int main(void) { @autoreleasepool {
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

    // 전환 중에 들어온 요청. macOS 는 그 순간의 -toggleFullScreen: 을 무시하므로 전환이 끝난 뒤에
    // 이어서 처리해야 한다.
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
