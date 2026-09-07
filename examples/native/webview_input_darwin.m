#import <Cocoa/Cocoa.h>
#import "webview_input_darwin.h"

// This private WebKit API gates pointer tracking without disabling keyboard,
// clicks or drags. AppKit's hit test selects the webview that receives it.
@interface WKWebView (PointerInput)
- (void)_setIgnoresMouseMoveEvents:(BOOL)ignore;
@end

static NSHashTable *inputViews;

static NSEvent *routePointer(NSEvent *event) {
    NSWindow *window = event.window;
    if (!window) return event;
    NSView *content = window.contentView;
    NSPoint point = [content.superview convertPoint:event.locationInWindow fromView:nil];
    NSView *hit = [content hitTest:point];
    for (WKWebView *view in inputViews) {
        if (view.window == window) [view _setIgnoresMouseMoveEvents:![hit isDescendantOf:view]];
    }
    return event;
}

BOOL webviewInputRegister(WKWebView *view) {
    NSCAssert(NSThread.isMainThread, @"Webview input registration requires the main thread");
    if (![view respondsToSelector:@selector(_setIgnoresMouseMoveEvents:)]) return NO;
    if (!inputViews) {
        inputViews = [[NSHashTable weakObjectsHashTable] retain];
        // Leave exit events enabled for the previous owner so its DOM clears hover.
        [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskMouseMoved | NSEventMaskMouseEntered
            handler:^NSEvent *(NSEvent *event) { return routePointer(event); }];
    }
    [inputViews addObject:view];
    return YES;
}

void webviewInputUnregister(WKWebView *view) {
    NSCAssert(NSThread.isMainThread, @"Webview input removal requires the main thread");
    [view _setIgnoresMouseMoveEvents:NO];
    [inputViews removeObject:view];
}
