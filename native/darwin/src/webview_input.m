#import <Cocoa/Cocoa.h>
#import "webview_input.h"
// _setIgnoresMouseMoveEvents: gates pointer tracking without disabling keyboard,
// clicks or drags. AppKit's hit test selects the webview that receives it.
#import "private/webkit.h"

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
        // 마우스 이탈 이벤트에서는 추적 대상을 변경하지 않는다.
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

BOOL webviewIgnorePageFocus(WKWebView *view) {
    NSCAssert(NSThread.isMainThread, @"webview focus belongs to the main thread");
    // WebKit moves the first responder to the web view when its page focuses an
    // element (PageClientImpl::makeFirstResponder). A surface that finishes
    // loading would take the keys from an open menu or the page being typed in.
    if (![view respondsToSelector:@selector(_setShouldSuppressFirstResponderChanges:)]) return NO;
    [view _setShouldSuppressFirstResponderChanges:YES];
    return YES;
}
