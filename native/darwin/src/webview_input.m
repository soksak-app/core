#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import "webview_input.h"
#import "application_log.h"
// _setIgnoresMouseMoveEvents: controls only pointer tracking and does not disable keyboard, click, or
// drag input. The AppKit hit test selects the web view that receives those events.
#import "private/webkit.h"
#import "webview_geometry.h"
#import "window_objects.h"

static NSHashTable *inputViews;
static NSMapTable<NSWindow *, WKWebView *> *lastPointerTargets;

// The move that turns tracking on may not reach the tracking owner of WebKit.
// Delivering the first move of the new target lets the page compute the cursor at the current position.
static void refreshPointerCursor(WKWebView *view, NSEvent *event) {
    if (NSEvent.pressedMouseButtons != 0) return;
    [view updateTrackingAreas];
    for (NSTrackingArea *area in view.trackingAreas) {
        if ((area.options & NSTrackingMouseMoved) && [area.owner respondsToSelector:@selector(mouseMoved:)]) {
            [area.owner mouseMoved:event];
            return;
        }
    }
}

// Script that reports the trusted pointer events the document received. It runs in a content world
// separate from the page.
static NSString *const kReceiptWorld = @"soksak-input";
static NSString *const kReceiptMessage = @"soksakInputReceipt";
static NSString *const kReceiptScript =
    @"for (const type of ['pointerdown', 'pointerup', 'click']) addEventListener(type, (event) => {"
    " if (event.isTrusted) webkit.messageHandlers.soksakInputReceipt.postMessage(type); }, true);";

@interface SPInputWait : NSObject
@property(nonatomic, copy) NSString *type;
@property(nonatomic, copy) void (^done)(BOOL);
@end
@implementation SPInputWait
- (void)dealloc { [_type release]; [_done release]; [super dealloc]; }
@end

// The receipt waits of one web view. The user content controller retains this object.
@interface SPInputReceipts : NSObject <WKScriptMessageHandler>
@property(nonatomic, retain) NSMutableArray<SPInputWait *> *waits;
@end
@implementation SPInputReceipts
- (void)dealloc { [_waits release]; [super dealloc]; }
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    if (!message.frameInfo.isMainFrame || ![message.body isKindOfClass:NSString.class]) {
        sp_log_error("webview input", [NSString stringWithFormat:@"receipt message ignored: main frame %@, body class %@",
            message.frameInfo.isMainFrame ? @"yes" : @"no", NSStringFromClass([message.body class])].UTF8String);
        return;
    }
    for (SPInputWait *wait in self.waits) {
        if (![wait.type isEqualToString:message.body]) continue;
        [[wait retain] autorelease];
        [self.waits removeObject:wait];
        wait.done(YES);
        return;
    }
    sp_log_info("webview input", [NSString stringWithFormat:@"receipt of %@ arrived without a wait", message.body].UTF8String);
}
@end

// The input registration of one web view. It is an associated object of the web view, so it is released
// with the web view. The user content controller of WebKit retains itself while a message handler is
// registered; without removing the handler, the controller and the other handlers registered on it remain
// after the web view is released. This object removes the handler on unregistration or web view release.
@interface SPInputRegistration : NSObject
@property(nonatomic, retain) WKUserContentController *controller;
@property(nonatomic, retain) SPInputReceipts *receipts;
- (void)end;
@end
@implementation SPInputRegistration
- (instancetype)init {
    if (!(self = [super init])) return nil;
    sp_window_object_change(SP_WINDOW_OBJECT_INPUT_REGISTRATION, 1);
    return self;
}
- (void)end {
    if (!self.controller) return;
    [self.controller removeScriptMessageHandlerForName:kReceiptMessage contentWorld:[WKContentWorld worldWithName:kReceiptWorld]];
    self.controller = nil;
    NSArray *waits = [[self.receipts.waits copy] autorelease];
    [self.receipts.waits removeAllObjects];
    for (SPInputWait *wait in waits) {
        sp_log_info("webview input", [NSString stringWithFormat:@"wait for %@ ended by the end of the registration", wait.type].UTF8String);
        wait.done(NO);
    }
}
- (void)dealloc {
    sp_window_object_change(SP_WINDOW_OBJECT_INPUT_REGISTRATION, -1);
    [self end];
    [_receipts release];
    [super dealloc];
}
@end

static const char registrationKey;

static SPInputReceipts *receiptsFor(WKWebView *view) {
    SPInputRegistration *registration = objc_getAssociatedObject(view, &registrationKey);
    return registration.receipts;
}

static BOOL hasPendingMouseDrain(WKWebView *view) {
    if ([view respondsToSelector:@selector(_doAfterProcessingAllPendingMouseEvents:)]) return YES;
    sp_log_error("webview input", "_doAfterProcessingAllPendingMouseEvents: is unavailable");
    return NO;
}

// Logs that a receipt wait did not end within its time.
static void logReceiptTimeout(NSString *type, NSTimeInterval timeout) {
    sp_log_error("webview input", [NSString stringWithFormat:@"receipt of %@ did not arrive within %g seconds", type, timeout].UTF8String);
}

static void installReceipts(WKWebView *view) {
    if (objc_getAssociatedObject(view, &registrationKey)) return;
    SPInputReceipts *handler = [[SPInputReceipts new] autorelease];
    handler.waits = [NSMutableArray array];
    WKContentWorld *world = [WKContentWorld worldWithName:kReceiptWorld];
    WKUserContentController *controller = view.configuration.userContentController;
    [controller addScriptMessageHandler:handler contentWorld:world name:kReceiptMessage];
    [controller addUserScript:[[[WKUserScript alloc] initWithSource:kReceiptScript
        injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES inContentWorld:world] autorelease]];
    // A user script does not apply to a document that is already loaded, so run the script once in
    // the same world.
    if (view.URL) [view evaluateJavaScript:kReceiptScript inFrame:nil inContentWorld:world completionHandler:nil];
    SPInputRegistration *registration = [[SPInputRegistration new] autorelease];
    registration.controller = controller;
    registration.receipts = handler;
    objc_setAssociatedObject(view, &registrationKey, registration, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}

void webviewInputReceive(WKWebView *view, NSString *type, NSTimeInterval timeout, void (^done)(BOOL received)) {
    NSCAssert(NSThread.isMainThread, @"Webview input receipts require the main thread");
    SPInputReceipts *handler = receiptsFor(view);
    if (!handler) { done(YES); return; }
    SPInputWait *wait = [[SPInputWait new] autorelease];
    wait.type = type;
    wait.done = done;
    [handler.waits addObject:wait];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeout * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (![handler.waits containsObject:wait]) return;
        logReceiptTimeout(type, timeout);
        [[wait retain] autorelease];
        [handler.waits removeObject:wait];
        wait.done(NO);
    });
}

void webviewInputSendThen(WKWebView *view, NSString *type, NSTimeInterval timeout,
    BOOL (^send)(void), void (^done)(BOOL received)) {
    NSCAssert(NSThread.isMainThread, @"Webview input receipts require the main thread");
    SPInputReceipts *handler = receiptsFor(view);
    if (!handler) {
        done(send());
        return;
    }
    if (!hasPendingMouseDrain(view)) { done(NO); return; }
    SPInputWait *wait = [[SPInputWait new] autorelease];
    wait.type = type;
    wait.done = ^(BOOL received) {
        if (!received || !hasPendingMouseDrain(view)) {
            done(NO);
            return;
        }
        [view _doAfterProcessingAllPendingMouseEvents:^{ done(YES); }];
    };
    [handler.waits addObject:wait];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeout * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (![handler.waits containsObject:wait]) return;
        logReceiptTimeout(type, timeout);
        [[wait retain] autorelease];
        [handler.waits removeObject:wait];
        wait.done(NO);
    });
    // After terminal input the native drawing region can be the first responder. When the window is
    // inactive in that state, WebKit can exclude the target page from the mouse handling path, so the
    // drain callback does not arrive until the next synthetic pointer. Before waiting for the pending
    // mouse work of WebKit, restore the target web view as the responder. Only the one pointer sent
    // below reaches the page; the caller takes back the focus of the native drawing region.
    NSWindow *window = view.window;
    NSResponder *first = window.firstResponder;
    BOOL targetOwnsResponder = first == view ||
        ([first isKindOfClass:NSView.class] && [(NSView *)first isDescendantOf:view]);
    if (window && !targetOwnsResponder) [window makeFirstResponder:view];
    // When a timeout or an unregistration ended the wait before the drain, completion is already
    // reported, so nothing is sent.
    void (^sendAfterDrain)(void) = ^{
        if (![handler.waits containsObject:wait]) return;
        BOOL sent = send();
        if (!sent && [handler.waits containsObject:wait]) {
            sp_log_error("webview input", [NSString stringWithFormat:@"send of %@ was refused", type].UTF8String);
            [[wait retain] autorelease];
            [handler.waits removeObject:wait];
            wait.done(NO);
        }
    };
    [view _doAfterProcessingAllPendingMouseEvents:sendAfterDrain];
}

static NSEvent *routePointer(NSEvent *event) {
    NSWindow *window = event.window;
    if (!window) return event;
    NSView *content = window.contentView;
    NSPoint point = [content.superview convertPoint:event.locationInWindow fromView:nil];
    NSView *hit = [content hitTest:point];
    // When a registered web view contains another registered web view (a document region), only the
    // innermost web view receives moves.
    NSView *target = hit;
    while (target && ![inputViews containsObject:target]) target = target.superview;
    WKWebView *previous = [lastPointerTargets objectForKey:window];
    for (WKWebView *view in inputViews) {
        if (view.window == window) [view _setIgnoresMouseMoveEvents:view != target];
    }
    if (NSEvent.pressedMouseButtons != 0) {
        [lastPointerTargets removeObjectForKey:window];
    } else if (target != previous) {
        if (target) [lastPointerTargets setObject:(WKWebView *)target forKey:window];
        else [lastPointerTargets removeObjectForKey:window];
        if (target) refreshPointerCursor((WKWebView *)target, event);
    }
    return event;
}

BOOL webviewInputRegister(WKWebView *view) {
    NSCAssert(NSThread.isMainThread, @"Webview input registration requires the main thread");
    if (![view respondsToSelector:@selector(_setIgnoresMouseMoveEvents:)]) {
        sp_log_error("webview input", "_setIgnoresMouseMoveEvents: is unavailable");
        return NO;
    }
    if (!hasPendingMouseDrain(view)) return NO;
    if (!inputViews) {
        inputViews = [[NSHashTable weakObjectsHashTable] retain];
        lastPointerTargets = [[NSMapTable weakToWeakObjectsMapTable] retain];
        [NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidBecomeActiveNotification object:NSApp queue:nil
            usingBlock:^(NSNotification *note) { [lastPointerTargets removeAllObjects]; }];
        // A mouse-exit event does not change the tracking target. A wheel event is converted to
        // the units of the surface coordinate system.
        [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskMouseMoved | NSEventMaskMouseEntered | NSEventMaskScrollWheel
            handler:^NSEvent *(NSEvent *event) {
                if (event.type != NSEventTypeScrollWheel) return routePointer(event);
                NSView *content = event.window.contentView;
                if (!content) return event;
                NSView *hit = [content hitTest:[content.superview convertPoint:event.locationInWindow fromView:nil]];
                return webviewScrollInViewUnits(event, hit);
            }];
    }
    [inputViews addObject:view];
    installReceipts(view);
    return YES;
}

void webviewInputUnregister(WKWebView *view) {
    NSCAssert(NSThread.isMainThread, @"Webview input removal requires the main thread");
    [view _setIgnoresMouseMoveEvents:NO];
    [inputViews removeObject:view];
    SPInputRegistration *registration = objc_getAssociatedObject(view, &registrationKey);
    [registration end];
    objc_setAssociatedObject(view, &registrationKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}

BOOL webviewIgnorePageFocus(WKWebView *view) {
    NSCAssert(NSThread.isMainThread, @"webview focus belongs to the main thread");
    // When the page gives focus to an element, WebKit moves the first responder to the web view
    // (PageClientImpl::makeFirstResponder). A surface that finished loading would then take key input
    // from an open menu or a page that is receiving input.
    if (![view respondsToSelector:@selector(_setShouldSuppressFirstResponderChanges:)]) {
        sp_log_error("webview input", "_setShouldSuppressFirstResponderChanges: is unavailable");
        return NO;
    }
    [view _setShouldSuppressFirstResponderChanges:YES];
    return YES;
}
