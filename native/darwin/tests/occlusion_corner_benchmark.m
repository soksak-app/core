// Measures the occlusion state that macOS reports for a window A that a window B of the same process covers. A is
// at the top-left corner of the visible frame of the main screen (below the menu bar) or away from that corner, and B
// covers A fully in the variants of kCases (the visible frame, A grown by 20 to 96 points on every side, the exact
// frame of A), as a titled window or a borderless window, with or without its shadow. For each case it prints
// A.occlusionState and document.visibilityState of a WKWebView in A after WebKit applied the activity state. Both
// windows are ordered front without activating the application. The benchmark prints the numbers and asserts
// nothing.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "private/webkit.h"

// The window server reports a change of occlusion asynchronously and reports no final state. After B is ordered
// front each case waits until no occlusion notification of A has arrived for settleSeconds, at most stepLimit.
static const NSTimeInterval settleSeconds = 2;
static const NSTimeInterval stepLimit = 10;

typedef enum { CoverNone, CoverVisibleFrame, CoverGrown, CoverExact } Cover;

typedef struct {
    const char *name;
    BOOL corner;     // A is at the top-left corner of the visible frame
    Cover cover;
    BOOL borderless; // B has no title bar and no rounded corners
    BOOL shadow;     // B has its shadow
    CGFloat grow;    // points that B extends beyond A on every side for CoverGrown
    BOOL aShadowOff; // A has no shadow
} Case;

static const Case kCases[] = {
    { "A alone at the corner", YES, CoverNone, NO, YES, 0, NO },
    { "titled B = visible frame, A at corner", YES, CoverVisibleFrame, NO, YES, 0, NO },
    { "titled B = A +20, A at corner", YES, CoverGrown, NO, YES, 20, NO },
    { "titled B = A exact, A at corner", YES, CoverExact, NO, YES, 0, NO },
    { "A alone away", NO, CoverNone, NO, YES, 0, NO },
    { "titled B = visible frame, A away", NO, CoverVisibleFrame, NO, YES, 0, NO },
    { "titled B = A +20, A away", NO, CoverGrown, NO, YES, 20, NO },
    { "titled B = A exact, A away", NO, CoverExact, NO, YES, 0, NO },
    { "borderless B = visible frame, A at corner", YES, CoverVisibleFrame, YES, YES, 0, NO },
    { "borderless B = A +20, A at corner", YES, CoverGrown, YES, YES, 20, NO },
    { "borderless B = A exact, A at corner", YES, CoverExact, YES, YES, 0, NO },
    { "borderless B = A +20, A away", NO, CoverGrown, YES, YES, 20, NO },
    { "titled no-shadow B = visible frame, A at corner", YES, CoverVisibleFrame, NO, NO, 0, NO },
    { "titled no-shadow B = A +20, A at corner", YES, CoverGrown, NO, NO, 20, NO },
    { "titled no-shadow B = A +20, A away", NO, CoverGrown, NO, NO, 20, NO },
    { "A no-shadow, titled B = A +20, A away", NO, CoverGrown, NO, YES, 20, YES },
    { "A no-shadow, titled B = visible frame, A at corner", YES, CoverVisibleFrame, NO, YES, 0, YES },
    { "titled B = A +24, A away", NO, CoverGrown, NO, YES, 24, NO },
    { "titled B = A +28, A away", NO, CoverGrown, NO, YES, 28, NO },
    { "titled B = A +32, A away", NO, CoverGrown, NO, YES, 32, NO },
    { "titled B = A +40, A away", NO, CoverGrown, NO, YES, 40, NO },
    { "titled B = A +48, A away", NO, CoverGrown, NO, YES, 48, NO },
    { "titled B = A +64, A away", NO, CoverGrown, NO, YES, 64, NO },
    { "titled B = A +96, A away", NO, CoverGrown, NO, YES, 96, NO },
};

// Occlusion state changes of the window server arrive as AppKit events. Application activation events are not taken.
static void pump(void) {
    NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAppKitDefined
                                        untilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]
                                           inMode:NSDefaultRunLoopMode
                                          dequeue:NO];
    if (event && event.subtype != NSEventSubtypeApplicationActivated
        && event.subtype != NSEventSubtypeApplicationDeactivated) {
        [NSApp sendEvent:[NSApp nextEventMatchingMask:NSEventMaskAppKitDefined untilDate:nil
                                               inMode:NSDefaultRunLoopMode dequeue:YES]];
    }
    [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
}

static BOOL until(BOOL (^done)(void)) {
    NSDate *limit = [NSDate dateWithTimeIntervalSinceNow:stepLimit];
    while (!done() && limit.timeIntervalSinceNow > 0) pump();
    return done();
}

@interface SPNavigation : NSObject <WKNavigationDelegate>
@property BOOL finished;
@end

@implementation SPNavigation
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation { self.finished = YES; }
@end

static NSString *visibility(WKWebView *view) {
    __block BOOL applied = NO;
    [view _doAfterActivityStateUpdate:^{ applied = YES; }];
    if (!until(^BOOL { return applied; })) return @"error: no activity state update";
    __block NSString *result = nil;
    [view evaluateJavaScript:@"document.visibilityState" completionHandler:^(id value, NSError *error) {
        result = error ? [NSString stringWithFormat:@"error: %@", error.localizedDescription] : [value description];
    }];
    return until(^BOOL { return result != nil; }) ? result : @"error: no reply";
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        [NSApp finishLaunching];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        NSScreen *screen = NSScreen.mainScreen;
        NSRect visible = screen.visibleFrame;
        printf("screen %s visible frame %s\n", NSStringFromRect(screen.frame).UTF8String,
               NSStringFromRect(visible).UTF8String);
        printf("%-48s %-26s %-26s %-8s %s\n", "case", "A frame", "B frame", "occluded", "visibilityState");
        for (size_t i = 0; i < sizeof kCases / sizeof kCases[0]; i++) {
            const Case c = kCases[i];
            NSSize size = NSMakeSize(997, 647);
            NSRect aFrame = c.corner
                ? NSMakeRect(NSMinX(visible), NSMaxY(visible) - size.height, size.width, size.height)
                : NSMakeRect(NSMinX(visible) + 300, NSMinY(visible) + 120, size.width, size.height);
            NSWindow *a = [[NSWindow alloc] initWithContentRect:aFrame
                                                      styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskResizable
                                                        backing:NSBackingStoreBuffered
                                                          defer:NO];
            a.releasedWhenClosed = NO;
            a.hasShadow = !c.aShadowOff;
            [a setFrame:aFrame display:NO];
            WKWebView *view = [[WKWebView alloc] initWithFrame:a.contentView.bounds];
            a.contentView = view;
            SPNavigation *navigation = [SPNavigation new];
            view.navigationDelegate = navigation;
            [view loadHTMLString:@"<!doctype html><body>a</body>" baseURL:nil];
            [a orderFrontRegardless];
            if (!until(^BOOL { return navigation.finished && (a.occlusionState & NSWindowOcclusionStateVisible) != 0; })) {
                printf("%-48s A did not load in a visible window (occlusion state %lu)\n", c.name,
                       (unsigned long)a.occlusionState);
                [a close];
                continue;
            }
            NSWindow *b = nil;
            if (c.cover != CoverNone) {
                NSRect bFrame = c.cover == CoverVisibleFrame ? visible
                              : c.cover == CoverGrown ? NSInsetRect(a.frame, -c.grow, -c.grow) : a.frame;
                NSWindowStyleMask style = c.borderless ? NSWindowStyleMaskBorderless
                                                       : NSWindowStyleMaskTitled | NSWindowStyleMaskResizable;
                b = [[NSWindow alloc] initWithContentRect:bFrame styleMask:style backing:NSBackingStoreBuffered
                                                    defer:NO];
                b.releasedWhenClosed = NO;
                b.opaque = YES;
                b.backgroundColor = NSColor.windowBackgroundColor;
                b.hasShadow = c.shadow;
                [b setFrame:bFrame display:NO];
            }
            __block NSDate *last = [NSDate date];
            id token = [NSNotificationCenter.defaultCenter addObserverForName:NSWindowDidChangeOcclusionStateNotification
                                                                       object:a
                                                                        queue:nil
                                                                   usingBlock:^(NSNotification *note) {
                                                                       last = [NSDate date];
                                                                   }];
            [b orderFrontRegardless];
            NSDate *limit = [NSDate dateWithTimeIntervalSinceNow:stepLimit];
            while (-last.timeIntervalSinceNow < settleSeconds && limit.timeIntervalSinceNow > 0) pump();
            [NSNotificationCenter.defaultCenter removeObserver:token];
            BOOL occluded = (a.occlusionState & NSWindowOcclusionStateVisible) == 0;
            NSString *state = visibility(view);
            printf("%-48s %-26s %-26s %-8s %s\n", c.name, NSStringFromRect(a.frame).UTF8String,
                   b ? NSStringFromRect(b.frame).UTF8String : "-", occluded ? "yes" : "no", state.UTF8String);
            [b close];
            [a close];
        }
    }
    return 0;
}
