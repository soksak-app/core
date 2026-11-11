// Shows a new window after its first screen is presented (window_reveal.h).
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "observe.h"
#import "window_facts.h"
#import "window_reveal.h"
#import "private/webkit.h"
#import <objc/runtime.h>

// The calls that wait for the reveal of a window (sp_window_after_reveal), held by the window while its reveal is pending.
static char revealWaitersKey;

// Runs the calls that waited for the reveal of window, once.
static void runRevealWaiters(NSWindow *window) {
    NSArray *waiters = [[objc_getAssociatedObject(window, &revealWaitersKey) retain] autorelease];
    objc_setAssociatedObject(window, &revealWaitersKey, nil, OBJC_ASSOCIATION_RETAIN);
    for (void (^waiter)(void) in waiters) waiter();
}

// Observes loading of the main web view and makes the window opaque when the first load ends. After the
// window is revealed it ends the observation and releases itself.
@interface SPWindowReveal : NSObject {
    NSWindow *_window;
    WKWebView *_webview;
    BOOL _observing;
    BOOL _started;
}
- (instancetype)initWithWindow:(NSWindow *)window webview:(WKWebView *)webview;
@end

@implementation SPWindowReveal

- (instancetype)initWithWindow:(NSWindow *)window webview:(WKWebView *)webview {
    if ((self = [super init])) {
        _window = [window retain];
        _webview = [webview retain];
    }
    return self;
}

- (void)start {
    _observing = YES;
    // Initial also reports a load that already ended at registration.
    sp_observe_key_path("window_reveal.loading", SP_OBSERVE_RECORD, _webview, self, @"loading", NSKeyValueObservingOptionInitial, NULL);
}

- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary *)change context:(void *)context {
    // Wait until a load starts. A load that already ended at registration still has its URL. A failed load
    // clears the URL when it ends, so the end is judged as an end that follows an observed start.
    sp_observe_delivered("window_reveal.loading");
    if (!_observing) return;
    if (_webview.loading) {
        _started = YES;
        return;
    }
    if (!_started && _webview.URL == nil) return;
    _observing = NO;
    [_webview removeObserver:self forKeyPath:@"loading"];
    [_webview _doAfterNextPresentationUpdate:^{
        self->_window.alphaValue = 1;
        runRevealWaiters(self->_window);
        [self release];
    }];
}

- (void)dealloc {
    [_window release];
    [_webview release];
    [super dealloc];
}

@end

bool sp_window_reveal_after_load(void *handle, char **error) {
    NSCAssert(NSThread.isMainThread, @"window reveal requires the UI thread");
    *error = NULL;
    NSWindow *window = (NSWindow *)handle;
    WKWebView *main = sp_window_main_webview(window);
    if (main == nil) {
        *error = strdup("window reveal needs a registered main webview");
        return false;
    }
    window.alphaValue = 0;
    if (!objc_getAssociatedObject(window, &revealWaitersKey)) {
        objc_setAssociatedObject(window, &revealWaitersKey, [NSMutableArray array], OBJC_ASSOCIATION_RETAIN);
    }
    // The observer releases itself when the window is revealed.
    [[[SPWindowReveal alloc] initWithWindow:window webview:main] start];
    return true;
}

void sp_window_after_reveal(void *handle, void (^done)(void)) {
    NSCAssert(NSThread.isMainThread, @"window reveal requires the UI thread");
    NSMutableArray *waiters = objc_getAssociatedObject((NSWindow *)handle, &revealWaitersKey);
    if (!waiters) {
        done();
        return;
    }
    [waiters addObject:[[done copy] autorelease]];
}

bool sp_window_place_new(void *handle, char **error) {
    NSCAssert(NSThread.isMainThread, @"window placement requires the UI thread");
    *error = NULL;
    NSWindow *window = (NSWindow *)handle;
    NSScreen *screen = nil;
    // The windows of the application on the screen, from front to back. The display of a window is the one that holds most of
    // its frame.
    for (NSNumber *number in [NSWindow windowNumbersWithOptions:0]) {
        if (number.integerValue == window.windowNumber) continue;
        NSWindow *front = [NSApp windowWithWindowNumber:number.integerValue];
        if (!front) continue;
        CGFloat most = 0;
        for (NSScreen *candidate in NSScreen.screens) {
            NSRect shared = NSIntersectionRect(candidate.frame, front.frame);
            if (NSWidth(shared) * NSHeight(shared) > most) {
                most = NSWidth(shared) * NSHeight(shared);
                screen = candidate;
            }
        }
        if (screen) break;
    }
    if (!screen) screen = NSScreen.mainScreen;
    if (!screen) {
        *error = strdup("window placement found no display");
        return false;
    }
    NSRect area = screen.visibleFrame, frame = window.frame;
    [window setFrameOrigin:NSMakePoint(NSMinX(area) + floor((NSWidth(area) - NSWidth(frame)) / 2),
        NSMinY(area) + floor((NSHeight(area) - NSHeight(frame)) / 2))];
    return true;
}

// keepFrame gives a window that the order put on the screen the frame that it had before, which the host gave it. AppKit constrains the
// frame of a window that it puts on the screen (constrainFrameRect:toScreen:), and a window that a framework shows only after its
// first screen goes on the screen after the moves of the host, so a window that reaches over an edge of the screen would move, where a
// window that went on the screen before its moves keeps them.
static void keepFrame(NSWindow *window, BOOL wasVisible, NSRect given) {
    if (!wasVisible && !NSEqualRects(window.frame, given)) [window setFrame:given display:YES];
}

// The window level of the windows of a check that owns their stacking (sp_windows_raise), the level of the windows of the native
// checks (native/darwin/tests/support/check_level.h).
static const NSWindowLevel kRaisedWindowLevel = NSPopUpMenuWindowLevel;

// Whether the windows of the application stand at kRaisedWindowLevel (sp_windows_raise).
static bool windowsRaised;

// Marks a window that sp_windows_raise or sp_window_show raised, so that the end of the state lowers that window and no other.
static char raisedKey;

// Raises window when it stands at the normal level.
static void raiseWindow(NSWindow *window) {
    if (window.level != NSNormalWindowLevel) return;
    window.level = kRaisedWindowLevel;
    objc_setAssociatedObject(window, &raisedKey, @YES, OBJC_ASSOCIATION_RETAIN);
}

// The windows of the application from back to front: the windows on the screen in their order, then the others.
static NSArray<NSWindow *> *windowsBackToFront(void) {
    NSMutableArray<NSWindow *> *windows = [NSMutableArray array];
    for (NSNumber *number in [NSWindow windowNumbersWithOptions:0].reverseObjectEnumerator) {
        NSWindow *window = [NSApp windowWithWindowNumber:number.integerValue];
        if (window) [windows addObject:window];
    }
    for (NSWindow *window in NSApp.windows) {
        if (![windows containsObject:window]) [windows addObject:window];
    }
    return windows;
}

void sp_windows_raise(bool raise) {
    NSCAssert(NSThread.isMainThread, @"window raise requires the UI thread");
    windowsRaised = raise;
    for (NSWindow *window in windowsBackToFront()) {
        if (raise) {
            raiseWindow(window);
            continue;
        }
        if (!objc_getAssociatedObject(window, &raisedKey)) continue;
        objc_setAssociatedObject(window, &raisedKey, nil, OBJC_ASSOCIATION_RETAIN);
        if (window.level == kRaisedWindowLevel) window.level = NSNormalWindowLevel;
    }
}

void sp_window_show(void *handle) {
    NSCAssert(NSThread.isMainThread, @"window show requires the UI thread");
    NSWindow *window = (NSWindow *)handle;
    if (windowsRaised) raiseWindow(window);
    BOOL wasVisible = window.isVisible;
    NSRect given = window.frame;
    if (NSRunningApplication.currentApplication.active) {
        [window makeKeyAndOrderFront:nil];
        keepFrame(window, wasVisible, given);
        return;
    }
    NSInteger frontmost = 0;
    for (NSNumber *number in [NSWindow windowNumbersWithOptions:0]) {
        if (number.integerValue != window.windowNumber) {
            frontmost = number.integerValue;
            break;
        }
    }
    if (frontmost != 0) {
        [window orderWindow:NSWindowAbove relativeTo:frontmost];
    } else if (!window.isVisible) {
        [window orderWindow:NSWindowBelow relativeTo:0];
    }
    keepFrame(window, wasVisible, given);
    [window makeKeyWindow];
}
