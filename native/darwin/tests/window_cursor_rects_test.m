// Checks that the window configuration turns off the cursor rect management of the window and keeps it off after
// common changes to the window. The content view places an arrow cursor rect over its whole area, like tao of Tauri
// (docs/features.md F95). The check does not activate the application.
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <WebKit/WebKit.h>
#import "webview_geometry.h"
#import "window_facts.h"
#import "support/event_wait.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
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

// Runs the run loop until the screen of the window has refreshed twice. AppKit updates the cursor rectangles of a window in
// the update and display cycle of the run loop, which runs before the run loop waits, so a change that it makes after a change
// of the window has been made when the screen refreshes for the second time.
static void afterDisplayCycle(NSWindow *window) {
    SPRefreshes *refreshes = [[SPRefreshes new] autorelease];
    refreshes.left = 2;
    // A link retains its target until it is invalidated.
    [[(window.screen ?: NSScreen.mainScreen) displayLinkWithTarget:refreshes selector:@selector(tick:)]
        addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
    eventWait(@"the screen of the window refreshes twice", ^BOOL { return refreshes.left == 0; });
}

// A content view that places an arrow cursor rect over its whole area, like TaoView of tao.
@interface SPArrowContentView : NSView
@end
@implementation SPArrowContentView
- (void)resetCursorRects {
    [self addCursorRect:self.bounds cursor:NSCursor.arrowCursor];
}
@end

int main(void) { @autoreleasepool {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: the window composition keeps cursor rectangles off\n");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    NSWindow *window = [[[NSWindow alloc] initWithContentRect:NSMakeRect(80, 80, 400, 300)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO] autorelease];
    [window setReleasedWhenClosed:NO];
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    window.contentView = [[[SPArrowContentView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    [window orderFrontRegardless];
    afterDisplayCycle(window);
    check(window.areCursorRectsEnabled, @"a new window manages cursor rectangles");

    void *surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    check(surface != NULL, @"the window composition is created");
    check(!window.areCursorRectsEnabled, @"the window composition turns cursor rectangles off");

    NSArray<NSArray *> *changes = @[
        @[@"a resize", ^{ [window setFrame:NSMakeRect(80, 80, 520, 360) display:YES]; }],
        @[@"a title change", ^{ window.title = @"changed"; }],
        @[@"an order out and in", ^{ [window orderOut:nil]; [window orderFrontRegardless]; }],
        @[@"making the window key", ^{ [window makeKeyWindow]; }],
        @[@"invalidating the cursor rectangles of the content view", ^{ [window invalidateCursorRectsForView:window.contentView]; }],
        @[@"a new subview", ^{ [window.contentView addSubview:[[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 10, 10)] autorelease]]; }],
    ];
    for (NSArray *change in changes) {
        ((void (^)(void))change[1])();
        afterDisplayCycle(window);
        check(!window.areCursorRectsEnabled, [NSString stringWithFormat:@"cursor rectangles stay off after %@", change[0]]);
    }
    check(!NSApp.isActive, @"the check does not activate the application");
    sp_surface_close(surface);
    [window close];
    fprintf(stderr, "%s: the window composition keeps cursor rectangles off (%.1fms)\n", failures ? "FAIL" : "PASS",
        (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
