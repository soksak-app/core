// Checks that the window configuration turns off the cursor rect management of the window and keeps it off after
// common changes to the window. The content view places an arrow cursor rect over its whole area, like tao of Tauri
// (docs/features.md F95). The check does not activate the application.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "webview_geometry.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void spin(NSTimeInterval seconds) {
    NSDate *until = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (until.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:
            [NSDate dateWithTimeIntervalSinceNow:MIN(0.01, until.timeIntervalSinceNow)]];
    }
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
    spin(0.2);
    check(window.areCursorRectsEnabled, @"a new window manages cursor rectangles");

    void *surface = sp_surface_create(main);
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
        spin(0.2);
        check(!window.areCursorRectsEnabled, [NSString stringWithFormat:@"cursor rectangles stay off after %@", change[0]]);
    }
    check(!NSApp.isActive, @"the check does not activate the application");
    sp_surface_close(surface);
    [window close];
    fprintf(stderr, "%s: the window composition keeps cursor rectangles off (%.1fms)\n", failures ? "FAIL" : "PASS",
        (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
