#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import "webview_input.h"
#import "input_inject.h"
#import "input_press_context.h"
#import "input_virtual.h"
#import "application_log.h"
#import "event_ring.h"
#import "observe.h"
#import "surface_layout.h"
// _setIgnoresMouseMoveEvents: controls only pointer tracking and does not disable keyboard, click, or
// drag input. The AppKit hit test selects the web view that receives those events.
#import "private/webkit.h"
#import "webview_geometry.h"
#import "window_objects.h"

static NSHashTable *inputViews;
static NSMapTable<NSWindow *, WKWebView *> *lastPointerTargets;
// The web view that does not ignore moves and may hover what is under the pointer. A press leaves it in place until its release.
// Each named pointer owns its previous hovered page inside a window. A
// second pointer entering another page must not move the first pointer out.
static NSMapTable<NSWindow *, NSMapTable<NSString *, WKWebView *> *> *pointerHolders;

// The move that turns tracking on may not reach the tracking owner of WebKit.
// Delivering the first move of the new target lets the page compute the cursor at the current position.
static void refreshPointerCursor(WKWebView *view, NSEvent *event) {
    if (sp_input_person_buttons() != 0) return;
    [view updateTrackingAreas];
    for (NSTrackingArea *area in view.trackingAreas) {
        if ((area.options & NSTrackingMouseMoved) && [area.owner respondsToSelector:@selector(mouseMoved:)]) {
            [area.owner mouseMoved:event];
            return;
        }
    }
}

// Script that reports the trusted pointer events the document received. It runs in a content world
// separate from the page, and marks that world so a wait that ends without its receipt can ask whether the document holds the
// listener.
static NSString *const kReceiptWorld = @"soksak-input";
static NSString *const kReceiptMessage = @"soksakInputReceipt";
static NSString *const kReceiptScript =
    @"globalThis.soksakInputReceipts = true;"
    " for (const type of ['pointerdown', 'pointerup', 'click']) addEventListener(type, (event) => {"
    " if (event.isTrusted) webkit.messageHandlers.soksakInputReceipt.postMessage(type); }, true);";

@class SPInputReceipts;
@class SPInputRegistration;

// The key-value context of the responsiveness of the web process of an observed view.
static char responsivenessContext;
// The source of the observation of that responsiveness.
static const char *const kResponsivenessSource = "webview_input.responsiveness";

// The events of a web view that end a wait for it: the close of the window that the view had when the observation began, the report of
// WebKit that the web process of the view stopped answering, and the end of the input registration of the view.
typedef NS_ENUM(NSInteger, SPInputViewEndKind) {
    SPInputViewEndClosed,
    SPInputViewEndUnresponsive,
    SPInputViewEndUnregistered,
};

// The observation of the ends of one web view. It retains the view until it fires or stops, so the view and its registration live
// while it observes them; it fires once.
@interface SPInputViewEnd : NSObject
@property(nonatomic, retain) WKWebView *view;
@property(nonatomic, copy) void (^ended)(SPInputViewEndKind kind, NSString *end);
@property(nonatomic, retain) id closeObserver;
@property(nonatomic) BOOL observesResponsiveness;
// The registration of the view, which holds this observation in its ends until it fires or stops.
@property(nonatomic, assign) SPInputRegistration *registration;
- (void)stop;
- (void)fire:(SPInputViewEndKind)kind end:(NSString *)end;
@end

static SPInputViewEnd *observeViewEnd(WKWebView *view, void (^ended)(SPInputViewEndKind kind, NSString *end));

// A receipt wait. Its view end retains the web view until the wait ends.
@interface SPInputWait : NSObject
@property(nonatomic, copy) NSString *type;
@property(nonatomic, copy) void (^done)(BOOL);
// The receipts of the view, which hold the wait until it ends.
@property(nonatomic, assign) SPInputReceipts *receipts;
@property(nonatomic, retain) WKWebView *view;
@property(nonatomic, retain) SPInputViewEnd *viewEnd;
@end
@implementation SPInputWait
- (void)dealloc { [_type release]; [_done release]; [_view release]; [_viewEnd release]; [super dealloc]; }
@end

// The receipt waits of one web view. The user content controller retains this object.
@interface SPInputReceipts : NSObject <WKScriptMessageHandler>
@property(nonatomic, retain) NSMutableArray<SPInputWait *> *waits;
// The time at which the last wait of each type ended without its receipt, until a receipt of that type arrives.
@property(nonatomic, retain) NSMutableDictionary<NSString *, NSDate *> *ended;
@end

// The waits whose event the input context of their view takes first: the next press or key event of the application ends them.
static NSMutableArray<SPInputWait *> *inputMethodWaits;

// Removes wait from the waits of its view and stops what it observes. Returns NO when the wait has already ended.
static BOOL takeWait(SPInputWait *wait) {
    SPInputReceipts *handler = wait.receipts;
    if (!handler || ![handler.waits containsObject:wait]) return NO;
    [[wait retain] autorelease];
    [handler.waits removeObject:wait];
    [inputMethodWaits removeObject:wait];
    [wait.viewEnd stop];
    wait.viewEnd = nil;
    return YES;
}

// Answers an ended wait once and lets its view go.
static void answer(SPInputWait *wait, BOOL received) {
    wait.view = nil;
    wait.done(received);
}

// Ends a receipt wait without its receipt: records the event that ended it, notes the time for a receipt that comes later, and
// records whether the document of the view holds the receipt listener, which the web process answers (or fails to answer) after this
// turn.
static void endWithout(SPInputWait *wait, NSString *reason) {
    WKWebView *view = [[wait.view retain] autorelease];
    SPInputReceipts *handler = [[wait.receipts retain] autorelease];
    if (!takeWait(wait)) return;
    NSString *type = wait.type;
    sp_log_error("webview input", [NSString stringWithFormat:@"wait for %@ ended: %@", type, reason].UTF8String);
    handler.ended[type] = [NSDate date];
    [view evaluateJavaScript:@"globalThis.soksakInputReceipts === true" inFrame:nil
        inContentWorld:[WKContentWorld worldWithName:kReceiptWorld] completionHandler:^(id value, NSError *error) {
            NSString *listener = error ? [NSString stringWithFormat:@"not answered: %@", error.localizedDescription]
                : [value isEqual:@YES] ? @"present" : @"absent";
            sp_log_error("webview input", [NSString stringWithFormat:@"the receipt listener of the document at the end of the wait for %@: %@",
                type, listener].UTF8String);
        }];
    answer(wait, NO);
}

@implementation SPInputReceipts
- (void)dealloc { [_waits release]; [_ended release]; [super dealloc]; }
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    if (!message.frameInfo.isMainFrame || ![message.body isKindOfClass:NSString.class]) {
        sp_log_error("webview input", [NSString stringWithFormat:@"receipt message ignored: main frame %@, body class %@",
            message.frameInfo.isMainFrame ? @"yes" : @"no", NSStringFromClass([message.body class])].UTF8String);
        return;
    }
    // One event answers every wait of its type: the sender of a press and the monitor of its origin wait for the same event.
    BOOL answered = NO;
    for (SPInputWait *wait in [[self.waits copy] autorelease]) {
        if (![wait.type isEqualToString:message.body] || !takeWait(wait)) continue;
        answer(wait, YES);
        answered = YES;
    }
    if (answered) return;
    // A receipt after the end of its wait tells a late document from one that never received the event.
    NSDate *ended = self.ended[message.body];
    if (ended) {
        sp_log_error("webview input", [NSString stringWithFormat:@"receipt of %@ arrived %.0f ms after its wait ended",
            message.body, -ended.timeIntervalSinceNow * 1000].UTF8String);
        [self.ended removeObjectForKey:message.body];
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
// The address of the web view, which identifies the registration in its records. It is text, so the registration does not
// retain the web view.
@property(nonatomic, copy) NSString *identifier;
// The observations of the ends of the view, which the end of the registration fires.
@property(nonatomic, retain) NSMutableArray<SPInputViewEnd *> *ends;
- (void)end;
@end

// Stores the record of a phase of an input registration with the count of live registrations after the phase.
static void recordInputPhase(NSString *identifier, const char *phase) {
    NSString *fields = [NSString stringWithFormat:@"{\"phase\":\"%s\",\"view\":\"%@\",\"count\":%ld}", phase, identifier,
        sp_window_objects_count().inputRegistrations];
    sp_event(SP_CLASS_LIFECYCLE, SP_EVENT_DEBUG, "native.webview.input", fields.UTF8String);
}

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
    for (SPInputViewEnd *viewEnd in [[self.ends copy] autorelease]) {
        [viewEnd fire:SPInputViewEndUnregistered end:@"the input registration of the web view ended"];
    }
}
- (void)dealloc {
    sp_window_object_change(SP_WINDOW_OBJECT_INPUT_REGISTRATION, -1);
    [self end];
    recordInputPhase(self.identifier, "released");
    [_receipts release];
    [_identifier release];
    [_ends release];
    [super dealloc];
}
@end

@implementation SPInputViewEnd
- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary *)change context:(void *)context {
    if (context != &responsivenessContext) {
        [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
        return;
    }
    sp_observe_delivered(kResponsivenessSource);
    if (![(WKWebView *)object _webProcessIsResponsive]) [self fire:SPInputViewEndUnresponsive end:@"the web process stopped answering"];
}
- (void)fire:(SPInputViewEndKind)kind end:(NSString *)end {
    void (^ended)(SPInputViewEndKind, NSString *) = [[self.ended retain] autorelease];
    [[self retain] autorelease];
    [self stop];
    if (ended) ended(kind, end);
}
- (void)stop {
    if (self.closeObserver) {
        [NSNotificationCenter.defaultCenter removeObserver:self.closeObserver];
        self.closeObserver = nil;
    }
    if (self.observesResponsiveness) {
        [self.view removeObserver:self forKeyPath:@"_webProcessIsResponsive" context:&responsivenessContext];
        self.observesResponsiveness = NO;
    }
    [self.registration.ends removeObject:self];
    self.registration = nil;
    self.ended = nil;
    self.view = nil;
}
- (void)dealloc { [_view release]; [_ended release]; [_closeObserver release]; [super dealloc]; }
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

static SPInputViewEnd *observeViewEnd(WKWebView *view, void (^ended)(SPInputViewEndKind kind, NSString *end)) {
    SPInputViewEnd *viewEnd = [[SPInputViewEnd new] autorelease];
    viewEnd.view = view;
    viewEnd.ended = ended;
    NSWindow *window = view.window;
    if (window) {
        viewEnd.closeObserver = sp_observe_notification("webview_input.window_close", SP_OBSERVE_RECORD, NSWindowWillCloseNotification,
            window, nil, ^(NSNotification *note) { [viewEnd fire:SPInputViewEndClosed end:@"the window closed"]; });
    }
    if ([view respondsToSelector:@selector(_webProcessIsResponsive)]) {
        viewEnd.observesResponsiveness = sp_observe_key_path(kResponsivenessSource, SP_OBSERVE_RECORD, view, viewEnd,
            @"_webProcessIsResponsive", 0, &responsivenessContext);
    }
    SPInputRegistration *registration = objc_getAssociatedObject(view, &registrationKey);
    if (registration.controller) {
        viewEnd.registration = registration;
        [registration.ends addObject:viewEnd];
    }
    return viewEnd;
}

id webviewInputObserveEnd(WKWebView *view, void (^ended)(NSString *end)) {
    NSCAssert(NSThread.isMainThread, @"Webview input ends belong to the main thread");
    return observeViewEnd(view, ^(SPInputViewEndKind kind, NSString *end) { ended(end); });
}

void webviewInputForgetEnd(id token) {
    [(SPInputViewEnd *)token stop];
}

static void installReceipts(WKWebView *view) {
    if (objc_getAssociatedObject(view, &registrationKey)) return;
    SPInputReceipts *handler = [[SPInputReceipts new] autorelease];
    handler.waits = [NSMutableArray array];
    handler.ended = [NSMutableDictionary dictionary];
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
    registration.identifier = [NSString stringWithFormat:@"%p", view];
    registration.ends = [NSMutableArray array];
    objc_setAssociatedObject(view, &registrationKey, registration, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    recordInputPhase(registration.identifier, "registered");
}

// Begins a receipt wait of view: it ends at the ends of the view, besides the ends that its caller asks for. The end of the
// registration ends it as the registration ends every wait, at the level info, because the view is going away.
static SPInputWait *beginWait(WKWebView *view, SPInputReceipts *handler, NSString *type, void (^done)(BOOL received)) {
    SPInputWait *wait = [[SPInputWait new] autorelease];
    wait.type = type;
    wait.done = done;
    wait.receipts = handler;
    wait.view = view;
    [handler.waits addObject:wait];
    wait.viewEnd = observeViewEnd(view, ^(SPInputViewEndKind kind, NSString *end) {
        if (kind != SPInputViewEndUnregistered) {
            endWithout(wait, end);
            return;
        }
        if (!takeWait(wait)) return;
        sp_log_info("webview input", [NSString stringWithFormat:@"wait for %@ ended by the end of the registration", wait.type].UTF8String);
        answer(wait, NO);
    });
    return wait;
}

// Ends wait at the end of the handling by WebKit of the mouse events that it was given up to the event of the wait. While the view
// has an input context, the context takes the event first and AppKit reports its answer only to WebKit, so the end of that handling
// proves nothing and the next press or key event that the application receives ends the wait instead.
static void awaitHandling(WKWebView *view, SPInputWait *wait) {
    if (view.inputContext) {
        static dispatch_once_t once;
        dispatch_once(&once, ^{
            inputMethodWaits = [[NSMutableArray alloc] init];
            surfaceInputActionObserve(^(NSEvent *event) {
                for (SPInputWait *pending in [[inputMethodWaits copy] autorelease]) {
                    endWithout(pending, @"the application received another press or key event");
                }
            });
        });
        [inputMethodWaits addObject:wait];
        return;
    }
    if (!hasPendingMouseDrain(view)) return;
    [view _doAfterProcessingAllPendingMouseEvents:^{
        endWithout(wait, @"WebKit handled the mouse events without the receipt");
    }];
}

void webviewInputReceiveThenDrain(WKWebView *view, NSString *type, void (^done)(BOOL received)) {
    NSCAssert(NSThread.isMainThread, @"Webview input receipts require the main thread");
    SPInputReceipts *handler = receiptsFor(view);
    if (!handler) { done(YES); return; }
    SPInputWait *wait = beginWait(view, handler, type, done);
    // A local monitor sees the event before AppKit gives it to the view, so the handling of WebKit includes the event from the next
    // turn of the main queue.
    dispatch_async(dispatch_get_main_queue(), ^{
        if ([handler.waits containsObject:wait]) awaitHandling(view, wait);
    });
}

void webviewInputSendThen(WKWebView *view, NSString *type, SPInputSend (^send)(void), void (^done)(BOOL received)) {
    NSCAssert(NSThread.isMainThread, @"Webview input receipts require the main thread");
    SPInputReceipts *handler = receiptsFor(view);
    if (!handler) {
        done(send() == SPInputSendDelivered);
        return;
    }
    if (!hasPendingMouseDrain(view)) { done(NO); return; }
    // The receipt is the end of the input (docs/spec/exposure.md#methods): no later step of WebKit, such as the end of its pending
    // mouse events, delays the answer.
    SPInputWait *wait = beginWait(view, handler, type, done);
    // After input to an image region the native drawing region can be the first responder. When the window is
    // inactive in that state, WebKit can exclude the target page from the mouse handling path, so the
    // drain callback does not arrive until the next synthetic pointer. Before waiting for the pending
    // mouse work of WebKit, restore the target web view as the responder. Only the one pointer sent
    // below reaches the page; the caller takes back the focus of the native drawing region. In a key
    // window the press passes the application, and AppKit moves the responder.
    NSWindow *window = view.window;
    NSResponder *first = window.firstResponder;
    BOOL targetOwnsResponder = first == view ||
        ([first isKindOfClass:NSView.class] && [(NSView *)first isDescendantOf:view]);
    if (window && !sp_input_virtual_through_application((__bridge void *)window) && !targetOwnsResponder) [window makeFirstResponder:view];
    // When an end of the wait came before the drain, completion is already reported, so nothing is sent.
    void (^sendAfterDrain)(void) = ^{
        if (![handler.waits containsObject:wait]) return;
        SPInputSend sent = send();
        if (sent == SPInputSendRefused) {
            if (!takeWait(wait)) return;
            sp_log_error("webview input", [NSString stringWithFormat:@"send of %@ was refused", type].UTF8String);
            answer(wait, NO);
            return;
        }
        if (sent == SPInputSendElsewhere) {
            endWithout(wait, @"the input reached another view");
            return;
        }
        if ([handler.waits containsObject:wait]) awaitHandling(view, wait);
    };
    [view _doAfterProcessingAllPendingMouseEvents:sendAfterDrain];
}

// Tells the page that the pointer left it: an exit outside the view, which WebKit takes as a move there, so the page
// hovers nothing. WebKit drops an exit once it ignores moves, and AppKit fixes no order between the exit of a view and
// the move that takes the pointer from it, so this comes before the view ignores moves.
static void pointerLeft(WKWebView *view, NSEvent *event) {
    NSEvent *exit = [NSEvent enterExitEventWithType:NSEventTypeMouseExited location:NSMakePoint(-1e5, -1e5)
        modifierFlags:0 timestamp:event.timestamp windowNumber:event.windowNumber context:nil
        eventNumber:0 trackingNumber:0 userData:NULL];
    [view updateTrackingAreas];
    for (NSTrackingArea *area in view.trackingAreas) {
        if ((area.options & NSTrackingMouseEnteredAndExited) && [area.owner respondsToSelector:@selector(mouseExited:)]) {
            [area.owner mouseExited:exit];
            return;
        }
    }
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
    if (NSEvent.pressedMouseButtons == 0) {
        NSMapTable<NSString *, WKWebView *> *holders = [pointerHolders objectForKey:window];
        if (!holders) {
            holders = [NSMapTable strongToWeakObjectsMapTable];
            [pointerHolders setObject:holders forKey:window];
        }
        NSString *pointer = [NSString stringWithUTF8String:sp_input_pointer_current_name()];
        WKWebView *holder = [holders objectForKey:pointer];
        if (holder && holder != target) pointerLeft(holder, event);
        if (target) [holders setObject:(WKWebView *)target forKey:pointer];
        else [holders removeObjectForKey:pointer];
    }
    for (WKWebView *view in inputViews) {
        if (view.window == window) [view _setIgnoresMouseMoveEvents:view != target];
    }
    if (sp_input_person_buttons() != 0) {
        [lastPointerTargets removeObjectForKey:window];
    } else if (target != previous) {
        if (target) [lastPointerTargets setObject:(WKWebView *)target forKey:window];
        else [lastPointerTargets removeObjectForKey:window];
        if (target) refreshPointerCursor((WKWebView *)target, event);
    }
    return event;
}

void webviewInputRoutePointer(NSEvent *event) {
    NSCAssert(NSThread.isMainThread, @"Webview pointer routing requires the main thread");
    routePointer(event);
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
        pointerHolders = [[NSMapTable weakToStrongObjectsMapTable] retain];
        sp_observe_notification("webview_input.app_active", SP_OBSERVE_RECORD, NSApplicationDidBecomeActiveNotification, NSApp, nil,
            ^(NSNotification *note) { [lastPointerTargets removeAllObjects]; });
        // A mouse-exit event does not change the tracking target. A wheel event passes unchanged: WebKit applies the
        // wheel delta of the event at the page zoom of the web view.
        // Pointer moves and wheel events arrive at the rate of the device, so the deliveries are counted.
        sp_observe_local_monitor("webview_input.pointer", SP_OBSERVE_COUNT, NSEventMaskMouseMoved | NSEventMaskMouseEntered | NSEventMaskScrollWheel,
            ^NSEvent *(NSEvent *event) {
                if (event.type == NSEventTypeScrollWheel) return event;
                return routePointer(event);
            });
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
    if (!registration) return;
    [registration end];
    // The registration is still alive here, so the count is unchanged. Clearing the association releases it, and its
    // release record follows.
    recordInputPhase(registration.identifier, "ended");
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
