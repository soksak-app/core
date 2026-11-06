#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#import "surface_layout.h"
#import "application_log.h"
#import "event_ring.h"
#import "observe.h"
#import "window_controls.h"
#import "window_facts.h"
#import "private/webkit.h"

@interface SPLayoutRequest : NSObject
@property(nonatomic, assign) void *owner;
@property(nonatomic, assign) uint64_t ticket;
@property(nonatomic, copy) void (^ready)(int);
@end
@implementation SPLayoutRequest
- (void)dealloc { [_ready release]; [super dealloc]; }
@end

// SPSettleRequest is a presentation wait for every layout transaction of the window to be settled.
@interface SPSettleRequest : NSObject
@property(nonatomic, retain) NSWindow *window;
@property(nonatomic, copy) surfaceLayoutPresent present;
@property(nonatomic, copy) void (^done)(double, const char *);
@end
@implementation SPSettleRequest
- (void)dealloc { [_window release]; [_present release]; [_done release]; [super dealloc]; }
@end

// SPHeldInput is one piece of the input of a window that waits: an event of the window system or an injected call.
@interface SPHeldInput : NSObject
@property(nonatomic, assign) void *owner;
@property(nonatomic, retain) NSEvent *event;
@property(nonatomic, copy) void (^call)(void);
@end
@implementation SPHeldInput
- (void)dealloc { [_event release]; [_call release]; [super dealloc]; }
@end

// SPKeyboardHold is the wait of the input of a window for the decision of the workbench about the keyboard
// (docs/spec/native-surfaces.md#keyboard-of-a-surface).
@interface SPKeyboardHold : NSObject
@property(nonatomic, assign) double opened;
@property(nonatomic, assign) NSUInteger dropped;
@end
@implementation SPKeyboardHold
@end

// SPViewJoin is a view that the open layout transaction waits for. It ends once: by its presentation or by an abandon.
@interface SPViewJoin : NSObject
@property(nonatomic, retain) WKWebView *view;
@property(nonatomic, assign) BOOL resolved;
@end
@implementation SPViewJoin
- (void)dealloc { [_view release]; [super dealloc]; }
@end

static uint64_t preparation;
// The views that the open transaction waits for. Joins are added only while the transaction of activeOwner is open.
static NSMutableArray<SPViewJoin *> *viewJoins;
// YES while the open transaction waits for its joined views before the CATransaction commit.
static BOOL committing;
static void *activeOwner;
static NSMutableArray<SPLayoutRequest *> *waiting;
static NSMutableArray<SPSettleRequest *> *settling;
static bool injectSettledFailure;
static void (^layoutStarted)(void *);
static void (^layoutEnded)(void *);
// YES while surfaceLayoutPressWaits asks where a press goes once the open transaction has reached the screen.
static BOOL pastPreparation;
// The input of a window that waits for the end of its open transaction, in the order it arrived.
static NSMutableArray<SPHeldInput *> *heldInput;
// The windows whose released input is on its way back through the event queue, once for each release.
static NSCountedSet<NSValue *> *returning;
// The turns of the event queue that the release of a window posted: an injected call, or the end of the release with no call.
static NSMutableDictionary<NSNumber *, SPHeldInput *> *heldTurns;
static long nextHeldTurn;
// The subtype of an application event that is a turn of held input.
static const short kHeldTurnSubtype = 0x6869;
// The windows whose input waits for the decision of the workbench about the keyboard.
static NSMutableDictionary<NSValue *, SPKeyboardHold *> *keyboardHolds;
// The windows whose open left press began on the workbench, and the windows whose open left press reached a view.
static NSMutableSet<NSValue *> *workbenchPresses;
static NSMutableSet<NSValue *> *passedPresses;
static bool (^pressOnWorkbench)(void *, double, double);
// A person types about 10 keys in a second and a pointer moves about 120 times, so the limit holds more than the bound of a hold.
static const NSUInteger kKeyboardHoldLimit = 256;
static const double kKeyboardHoldBound = 1.0;

static void releaseSettled(void);

// Diagnostic trace. Records ticket, begun, presented, and committed for each transaction. The drag check uses it to divide the delay of the recording frames into stages.
static NSMutableArray<NSMutableArray<NSNumber *> *> *trace;

static void traceMark(uint64_t ticket, NSUInteger stage) {
    if (!trace) return;
    double now = CACurrentMediaTime() * 1000;
    NSMutableArray<NSNumber *> *record = nil;
    for (NSMutableArray<NSNumber *> *item in trace.reverseObjectEnumerator) {
        if (item[0].unsignedLongLongValue == ticket) { record = item; break; }
    }
    if (!record) {
        record = [NSMutableArray arrayWithObjects:@(ticket), @(NAN), @(NAN), @(NAN), @(NAN), nil];
        [trace addObject:record];
    }
    // When one transaction checks the presentation several times, the last check is kept.
    record[stage] = @(now);
}

uint64_t surfaceLayoutTraceRequested(void) {
    NSCAssert(NSThread.isMainThread, @"surface layout trace requires the UI thread");
    traceMark(preparation, 4);
    return preparation;
}

void surfaceLayoutTracePresented(uint64_t ticket) {
    NSCAssert(NSThread.isMainThread, @"surface layout trace requires the UI thread");
    traceMark(ticket, 2);
}

void surfaceLayoutTraceStart(void) {
    NSCAssert(NSThread.isMainThread, @"surface layout trace requires the UI thread");
    [trace release];
    trace = [[NSMutableArray alloc] init];
}

size_t surfaceLayoutTraceStop(double *out, size_t capacity) {
    NSCAssert(NSThread.isMainThread, @"surface layout trace requires the UI thread");
    size_t total = trace.count;
    size_t count = 0;
    for (NSMutableArray<NSNumber *> *record in trace) {
        if (count >= capacity) break;
        for (NSUInteger i = 0; i < SURFACE_LAYOUT_TRACE_STAGES; i++) out[count * SURFACE_LAYOUT_TRACE_STAGES + i] = record[i].doubleValue;
        count++;
    }
    [trace release];
    trace = nil;
    return total;
}

// Takes a press that surfaceLayoutPressWaits holds back, and every later pointer and key event of the window, so the input stays
// in order.
static BOOL inputHeld(void *owner) {
    BOOL held = NO;
    for (SPHeldInput *earlier in heldInput) held = held || earlier.owner == owner;
    return held;
}

static SPKeyboardHold *keyboardHold(void *owner) {
    return keyboardHolds[[NSValue valueWithPointer:owner]];
}

static void keepInput(void *owner, NSEvent *event, void (^call)(void)) {
    SPKeyboardHold *hold = keyboardHold(owner);
    if (hold) {
        NSUInteger count = 0;
        for (SPHeldInput *earlier in heldInput) count += earlier.owner == owner;
        if (count >= kKeyboardHoldLimit) {
            hold.dropped++;
            return;
        }
    }
    SPHeldInput *input = [[[SPHeldInput alloc] init] autorelease];
    input.owner = owner;
    input.event = event;
    input.call = call;
    if (!heldInput) heldInput = [[NSMutableArray alloc] init];
    [heldInput addObject:input];
}

static BOOL holdInput(NSEvent *event) {
    const NSEventMask presses = NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown;
    const NSEventMask later = presses | NSEventMaskLeftMouseDragged | NSEventMaskLeftMouseUp | NSEventMaskRightMouseDragged
        | NSEventMaskRightMouseUp | NSEventMaskOtherMouseDown | NSEventMaskOtherMouseDragged | NSEventMaskOtherMouseUp
        | NSEventMaskMouseMoved | NSEventMaskScrollWheel | NSEventMaskKeyDown | NSEventMaskKeyUp | NSEventMaskFlagsChanged;
    NSEventMask type = NSEventMaskFromType(event.type);
    NSWindow *window = event.window;
    // A release puts its events at the start of the queue, so while it returns every event of the window is in its turn.
    BOOL waits = window && (type & later) && (keyboardHold(window) || (![returning containsObject:[NSValue valueWithPointer:window]]
        && (inputHeld(window) || ((type & presses) && surfaceLayoutPressWaits(window, event.locationInWindow.x, event.locationInWindow.y)))));
    if (waits) keepInput(window, event, nil);
    return waits;
}

static void (*applicationSendEvent)(id, SEL, NSEvent *);

static void releaseInput(void *owner);

// Gives the input of owner back when neither its open transaction nor the decision about its keyboard holds it.
static void releaseWhenFree(void *owner) {
    if (activeOwner != owner && !keyboardHold(owner)) releaseInput(owner);
}

// Runs one turn of a release: an injected call, or the end of the release, which sends on what arrived while it returned. A call
// that comes back while a hold of the keyboard opened waits again, in its order.
static void runHeldTurn(long turn) {
    SPHeldInput *input = [[heldTurns[@(turn)] retain] autorelease];
    [heldTurns removeObjectForKey:@(turn)];
    if (input.call) {
        if (keyboardHold(input.owner)) keepInput(input.owner, nil, input.call);
        else input.call();
    } else {
        [returning removeObject:[NSValue valueWithPointer:input.owner]];
        releaseWhenFree(input.owner);
    }
}

static void sendEventAfterLayout(id application, SEL selector, NSEvent *event) {
    if (event.type == NSEventTypeApplicationDefined && event.subtype == kHeldTurnSubtype) {
        runHeldTurn(event.data1);
    } else if (!holdInput(event)) {
        if (event.window && (event.type == NSEventTypeLeftMouseDown || event.type == NSEventTypeLeftMouseUp)) {
            surfaceLayoutPointerPassing(event.window, event.type == NSEventTypeLeftMouseDown, event.locationInWindow.x,
                event.locationInWindow.y);
        }
        applicationSendEvent(application, selector, event);
    }
}

// -[NSApplication sendEvent:] calls the local monitors, in no fixed order, and a monitor that returns nil ends the others. A
// framework's application class can override the method, read the event before super and send a key past super. The hold stands
// in front of the method of the class of the application, so no monitor or override of the library, a host or a framework sees
// an event that waits, and each sees the event once when it comes back.
static void watchInput(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        Method method = class_getInstanceMethod(object_getClass([NSApplication sharedApplication]), @selector(sendEvent:));
        applicationSendEvent = (void (*)(id, SEL, NSEvent *))method_getImplementation(method);
        method_setImplementation(method, (IMP)sendEventAfterLayout);
    });
}

// Posts a turn of the event queue at the start of the queue.
static void postHeldTurn(SPHeldInput *input) {
    long turn = ++nextHeldTurn;
    if (!heldTurns) heldTurns = [[NSMutableDictionary alloc] init];
    heldTurns[@(turn)] = input;
    NSEvent *event = [NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0 timestamp:0
        windowNumber:0 context:nil subtype:kHeldTurnSubtype data1:turn data2:0];
    [NSApp postEvent:event atStart:YES];
}

// Gives the waiting input of owner back after its transaction ended, through the event queue, because a press can run a loop of
// its own and the application reads NSApp.currentEvent. The turns go to the start of the queue from the last to the first, so
// they stay in order and ahead of the input that arrived after them, and the end of the release comes after them.
static void releaseInput(void *owner) {
    if (!inputHeld(owner)) return;
    if (!returning) returning = [[NSCountedSet alloc] init];
    [returning addObject:[NSValue valueWithPointer:owner]];
    SPHeldInput *end = [[[SPHeldInput alloc] init] autorelease];
    end.owner = owner;
    postHeldTurn(end);
    NSArray<SPHeldInput *> *held = [[heldInput copy] autorelease];
    for (SPHeldInput *input in held.reverseObjectEnumerator) {
        if (input.owner != owner) continue;
        if (input.event) [NSApp postEvent:input.event atStart:YES];
        else postHeldTurn(input);
        [heldInput removeObjectIdenticalTo:input];
    }
}

static void startLayout(SPLayoutRequest *request) {
    watchInput();
    if (!activeOwner) {
        [CATransaction begin];
        [CATransaction setDisableActions:YES];
        activeOwner = request.owner;
    }
    preparation = request.ticket;
    traceMark(request.ticket, 1);
    if (layoutStarted) layoutStarted(request.owner);
    request.ready(true);
}

static void nextLayout(void) {
    while (waiting.count && (!activeOwner || (waiting.firstObject.owner == activeOwner && !committing))) {
        SPLayoutRequest *request = [waiting.firstObject retain];
        [waiting removeObjectAtIndex:0];
        startLayout(request);
        [request release];
    }
}

// CATransaction is per UI thread, so the preparation and presentation of several windows are serialized.
void surfaceLayoutObserve(void (^started)(void *), void (^ended)(void *)) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    [layoutStarted release];
    [layoutEnded release];
    layoutStarted = [started copy];
    layoutEnded = [ended copy];
}

void surfaceLayoutBegin(void *owner, uint64_t ticket, void (^ready)(int)) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    SPLayoutRequest *request = [[[SPLayoutRequest alloc] init] autorelease];
    request.owner = owner;
    request.ticket = ticket;
    request.ready = ready;
    if (!activeOwner || (activeOwner == owner && !committing)) { startLayout(request); return; }
    if (!waiting) waiting = [[NSMutableArray alloc] init];
    [waiting addObject:request];
}

// Ends the open transaction: the CATransaction commits, and the next waiting layout starts.
static void finishTransaction(void) {
    uint64_t ticket = preparation;
    void *owner = activeOwner;
    committing = NO;
    activeOwner = NULL;
    [CATransaction commit];
    traceMark(ticket, 3);
    if (layoutEnded) layoutEnded(owner);
    releaseWhenFree(owner);
    nextLayout();
    releaseSettled();
}

// Detaches a join from the open transaction. It returns false when the join already ended, so each join ends once.
static bool detachViewJoin(SPViewJoin *join) {
    if (join.resolved) return false;
    join.resolved = YES;
    [viewJoins removeObjectIdenticalTo:join];
    return true;
}

// Finishes a deferred commit once the last joined view has ended.
static void finishDeferredCommit(void) {
    if (committing && viewJoins.count == 0) finishTransaction();
}

// Ends every view wait of the open transaction without a presentation.
static void dropViewJoins(void) {
    for (SPViewJoin *join in [[viewJoins copy] autorelease]) detachViewJoin(join);
}

bool surfaceLayoutCommit(void *owner, uint64_t ticket) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    if (activeOwner != owner || ticket != preparation || committing) {
        return false;
    }
    if (viewJoins.count) {
        committing = YES;
        return true;
    }
    finishTransaction();
    return true;
}

bool surfaceLayoutIsPreparing(void *owner) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    return !pastPreparation && owner != NULL && activeOwner == owner;
}

bool surfaceLayoutPressWaits(void *owner, double x, double y) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    if (!owner || activeOwner != owner) return false;
    NSView *content = ((NSWindow *)owner).contentView;
    NSPoint point = [content.superview convertPoint:NSMakePoint(x, y) fromView:nil];
    NSView *now = [content hitTest:point];
    pastPreparation = YES;
    NSView *committed = [content hitTest:point];
    pastPreparation = NO;
    return now != committed;
}

bool surfaceLayoutHoldCall(void *owner, bool press, double x, double y, void (^call)(void)) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    BOOL waits = keyboardHold(owner) || [returning containsObject:[NSValue valueWithPointer:owner]] || inputHeld(owner)
        || (press && surfaceLayoutPressWaits(owner, x, y));
    if (waits) keepInput(owner, nil, call);
    return waits;
}

static double nowMs(void) {
    return CACurrentMediaTime() * 1000;
}

static void recordHoldDropped(NSUInteger count, const char *reason) {
    NSString *fields = [NSString stringWithFormat:@"{\"count\":%lu,\"reason\":\"%s\"}", (unsigned long)count, reason];
    sp_event(SP_CLASS_INPUT, SP_EVENT_WARN, "native.keyboard.hold_dropped", fields.UTF8String);
}

// Ends the hold of the keyboard of owner. An expired hold gives the input to the first responder of that moment, and a closed
// window drops what it held.
static void endKeyboardHold(void *owner, const char *end) {
    SPKeyboardHold *hold = [[keyboardHold(owner) retain] autorelease];
    if (!hold) return;
    [keyboardHolds removeObjectForKey:[NSValue valueWithPointer:owner]];
    NSUInteger held = 0;
    for (SPHeldInput *input in heldInput) held += input.owner == owner;
    BOOL closed = strcmp(end, "closed") == 0;
    if (closed) {
        for (SPHeldInput *input in [[heldInput copy] autorelease]) {
            if (input.owner == owner) [heldInput removeObjectIdenticalTo:input];
        }
    }
    if (hold.dropped) recordHoldDropped(hold.dropped, "full");
    if (closed && held) recordHoldDropped(held, "closed");
    if (strcmp(end, "expired") == 0) {
        NSString *fields = [NSString stringWithFormat:@"{\"held\":%lu,\"ms\":%.1f}", (unsigned long)held, nowMs() - hold.opened];
        sp_event(SP_CLASS_INPUT, SP_EVENT_WARN, "native.keyboard.hold_expired", fields.UTF8String);
    }
    if (!closed) releaseWhenFree(owner);
}

static void observeHoldClose(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        sp_observe_notification("surface_layout.keyboard_hold_close", SP_OBSERVE_RECORD, NSWindowWillCloseNotification, nil, nil,
            ^(NSNotification *note) {
                [workbenchPresses removeObject:[NSValue valueWithPointer:note.object]];
                [passedPresses removeObject:[NSValue valueWithPointer:note.object]];
                endKeyboardHold(note.object, "closed");
            });
    });
}

void surfaceLayoutKeyboardHold(void *owner) {
    NSCAssert(NSThread.isMainThread, @"the keyboard of a window belongs to the UI thread");
    if (!owner || keyboardHold(owner)) return;
    watchInput();
    observeHoldClose();
    SPKeyboardHold *hold = [[[SPKeyboardHold alloc] init] autorelease];
    hold.opened = nowMs();
    if (!keyboardHolds) keyboardHolds = [[NSMutableDictionary alloc] init];
    keyboardHolds[[NSValue valueWithPointer:owner]] = hold;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kKeyboardHoldBound * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (keyboardHold(owner) == hold) endKeyboardHold(owner, "expired");
    });
}

void surfaceLayoutKeyboardDecided(void *owner) {
    NSCAssert(NSThread.isMainThread, @"the keyboard of a window belongs to the UI thread");
    endKeyboardHold(owner, "decided");
}

bool surfaceLayoutKeyboardHeld(void *owner) {
    NSCAssert(NSThread.isMainThread, @"the keyboard of a window belongs to the UI thread");
    return keyboardHold(owner) != nil;
}

void surfaceLayoutObserveWorkbench(bool (^onWorkbench)(void *window, double x, double y)) {
    NSCAssert(NSThread.isMainThread, @"the keyboard of a window belongs to the UI thread");
    if (pressOnWorkbench) return;
    pressOnWorkbench = [onWorkbench copy];
    watchInput();
}

bool surfaceLayoutLeftPressPassed(void *owner) {
    NSCAssert(NSThread.isMainThread, @"the keyboard of a window belongs to the UI thread");
    return [passedPresses containsObject:[NSValue valueWithPointer:owner]];
}

void surfaceLayoutPointerPassing(void *owner, bool down, double x, double y) {
    NSCAssert(NSThread.isMainThread, @"the keyboard of a window belongs to the UI thread");
    NSValue *key = [NSValue valueWithPointer:owner];
    if (!passedPresses) passedPresses = [[NSMutableSet alloc] init];
    if (down) [passedPresses addObject:key];
    else [passedPresses removeObject:key];
    if (down) {
        if (!workbenchPresses) workbenchPresses = [[NSMutableSet alloc] init];
        if (pressOnWorkbench && pressOnWorkbench(owner, x, y)) [workbenchPresses addObject:key];
        else [workbenchPresses removeObject:key];
    } else if ([workbenchPresses containsObject:key]) {
        [workbenchPresses removeObject:key];
        surfaceLayoutKeyboardHold(owner);
    }
}

void surfaceLayoutCancel(void *owner) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    for (SPLayoutRequest *request in [[waiting copy] autorelease]) {
        if (request.owner != owner) continue;
        [waiting removeObjectIdenticalTo:request];
        request.ready(false);
    }
    if (activeOwner == owner) {
        dropViewJoins();
        if (committing) finishTransaction();
        else surfaceLayoutCommit(owner, preparation);
    }
    releaseSettled();
}

void surfaceLayoutCancelTicket(void *owner, uint64_t ticket) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    for (SPLayoutRequest *request in [[waiting copy] autorelease]) {
        if (request.owner != owner || request.ticket != ticket) continue;
        [waiting removeObjectIdenticalTo:request];
        request.ready(false);
    }
    if (activeOwner == owner && preparation == ticket) {
        dropViewJoins();
        if (committing) finishTransaction();
        else surfaceLayoutCommit(owner, ticket);
    }
    releaseSettled();
}

// SPDisplayedFrame reads the target time of the next display refresh once. Content committed after a presentation
// update finishes appears on the screen by that refresh at the latest. The refresh of the screen continues even when the window is occluded, so the display link is used.
@interface SPDisplayedFrame : NSObject
@property(nonatomic, copy) void (^done)(double, const char *);
- (void)tick:(CADisplayLink *)link;
@end
@implementation SPDisplayedFrame
- (void)dealloc { [_done release]; [super dealloc]; }
- (void)tick:(CADisplayLink *)link {
    double displayed = link.targetTimestamp * 1000;
    [link invalidate];
    self.done(displayed, NULL);
}
@end

static void afterNextFrame(NSScreen *screen, void (^done)(double, const char *)) {
    if (screen == nil) {
        done(CACurrentMediaTime() * 1000, NULL);
        return;
    }
    SPDisplayedFrame *frame = [[SPDisplayedFrame new] autorelease];
    frame.done = done;
    // A link retains its target until it is invalidated.
    CADisplayLink *link = [screen displayLinkWithTarget:frame selector:@selector(tick:)];
    [link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
}

// On macOS, WebKit enables by default the feature that limits page rendering updates to about 60 fps. One layout
// waits for the next presentation of the app DOM (_doAfterNextPresentationUpdate), so even on a 120 Hz display the
// layout is limited to a 60 Hz cycle and during a drag the screen lags the pointer by two or more cycles. This feature is turned on and off with the feature flag list of WebKit (_WKFeature).
// The list does not change in a process, and each read of it allocates every feature in the WebKit heap of the process, so the
// feature is looked up once: a status watcher reads the window facts for each frame of a region.
static _WKFeature *near60FPSFeature(void) {
    static _WKFeature *near60;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        for (_WKFeature *feature in [WKPreferences _features]) {
            if ([feature.key isEqualToString:@"PreferPageRenderingUpdatesNear60FPSEnabled"]) {
                near60 = [feature retain];
                break;
            }
        }
    });
    return near60;
}

bool surfaceLayoutRenderAtDisplayRate(void *handle) {
    NSCAssert(NSThread.isMainThread, @"webview configuration requires the UI thread");
    WKWebView *view = (WKWebView *)handle;
    _WKFeature *feature = near60FPSFeature();
    if (!feature) return false;
    [view.configuration.preferences _setEnabled:NO forFeature:feature];
    return true;
}

int surfaceLayoutPrefersNear60FPS(void *handle) {
    WKWebView *view = (WKWebView *)handle;
    _WKFeature *feature = near60FPSFeature();
    if (!feature) return -1;
    return [view.configuration.preferences _isEnabledForFeature:feature] ? 1 : 0;
}

void surfaceLayoutAfterPresentation(void *handle, void (^done)(void)) {
    NSCAssert(NSThread.isMainThread, @"surface presentation requires the UI thread");
    WKWebView *main = (WKWebView *)handle;
    // The app DOM is a separate web view; plugin roots and nested document regions are independent web views.
    // Time at which the presentation check of the DOM drawn by the page was requested. This time and presented measure whether the wait
    // for presentation waits for the update of the frame that was drawn or for the update after it (docs/features.md F92).
    uint64_t ticket = surfaceLayoutTraceRequested();
    void (^finish)(void) = [[done copy] autorelease];
    [main _doAfterNextPresentationUpdate:^{
        surfaceLayoutTracePresented(ticket);
        finish();
    }];
}

// Returns whether the window owner has a layout transaction that is open or waiting to open. While a transaction is open,
// no change of the window reaches the screen.
static bool layoutOpen(void *owner) {
    if (activeOwner == owner) return true;
    for (SPLayoutRequest *request in waiting) {
        if (request.owner == owner) return true;
    }
    return false;
}

// Runs done after every shown modal has presented. A modal is the only web view placed directly in the content view
// beside the composition; a surface's web views live inside it and render independently of this wait. A shown modal
// starts drawing when it becomes visible, and the presentation of the content of the window says nothing about it.
static void afterModalsPresented(NSWindow *window, void (^done)(void)) {
    dispatch_group_t group = dispatch_group_create();
    BOOL waiting = NO;
    for (NSView *view in window.contentView.subviews) {
        if (![view isKindOfClass:WKWebView.class] || view.isHiddenOrHasHiddenAncestor) continue;
        waiting = YES;
        dispatch_group_enter(group);
        [(WKWebView *)view _doAfterNextPresentationUpdate:^{ dispatch_group_leave(group); }];
    }
    if (waiting) dispatch_group_notify(group, dispatch_get_main_queue(), done);
    else done();
    dispatch_release(group);
}

static void settle(NSWindow *window, surfaceLayoutPresent present, void (^done)(double, const char *)) {
    if (layoutOpen(window)) {
        SPSettleRequest *request = [[SPSettleRequest new] autorelease];
        request.window = window;
        request.present = present;
        request.done = done;
        if (!settling) settling = [[NSMutableArray alloc] init];
        [settling addObject:request];
        return;
    }
    surfaceLayoutPresent again = [[present copy] autorelease];
    void (^finish)(double, const char *) = [[done copy] autorelease];
    [window retain];
    present(^(const char *error) {
        if (error) {
            finish(0, error);
            [window release];
            return;
        }
        afterModalsPresented(window, ^{
            // When a new transaction opened while waiting for presentation, the wait starts again from the settlement of that transaction.
            if (layoutOpen(window)) settle(window, again, finish);
            else afterNextFrame(window.screen, finish);
            [window release];
        });
    });
}

static void releaseSettled(void) {
    for (SPSettleRequest *request in [[settling copy] autorelease]) {
        if (layoutOpen(request.window)) continue;
        [[request retain] autorelease];
        [settling removeObjectIdenticalTo:request];
        settle(request.window, request.present, request.done);
    }
}

surfaceLayoutPresent surfaceLayoutMainPresentation(void *handle) {
    WKWebView *main = (WKWebView *)handle;
    return [[^(void (^presented)(const char *)) {
        [main evaluateJavaScript:@"void document.documentElement.offsetWidth" completionHandler:^(id value, NSError *error) {
            if (error) {
                sp_log_error("surface settle", [NSString stringWithFormat:@"DOM completion failed: %@", error.localizedDescription].UTF8String);
                presented(error.localizedDescription.UTF8String);
                return;
            }
            // DOM evaluation only finishes layout. The web content process must commit the rendering of that DOM before it appears on the screen.
            [main _doAfterNextPresentationUpdate:^{ presented(NULL); }];
        }];
    } copy] autorelease];
}

void surfaceLayoutAfterSettled(void *window, surfaceLayoutPresent present, void (^done)(double, const char *)) {
    NSCAssert(NSThread.isMainThread, @"surface presentation requires the UI thread");
    if (injectSettledFailure) {
        injectSettledFailure = false;
        done(0, "injected native presentation failure");
        return;
    }
    if (!window) {
        done(0, "the settled wait has no window");
        return;
    }
    if (!present) {
        done(0, "the settled wait has no presentation block");
        return;
    }
    settle((NSWindow *)window, present, done);
}

void surfaceLayoutInjectSettledFailure(void) {
    NSCAssert(NSThread.isMainThread, @"surface presentation failure injection requires the UI thread");
    injectSettledFailure = true;
}

// SPStartCommit commits the start transaction at the next presentation update after the read of the new page finishes,
// and releases itself. This is the same time at which window_reveal.m reveals a new window. When a new preparation of
// the same window took over the transaction in the meantime, the ticket changed, so SPStartCommit does not commit and the presentation of that preparation commits.
@interface SPStartCommit : NSObject {
    WKWebView *_webview;
    void *_owner;
    uint64_t _ticket;
    BOOL _started;
}
- (instancetype)initWithWebview:(WKWebView *)webview owner:(void *)owner ticket:(uint64_t)ticket;
@end

@implementation SPStartCommit

- (instancetype)initWithWebview:(WKWebView *)webview owner:(void *)owner ticket:(uint64_t)ticket {
    if ((self = [super init])) {
        _webview = [webview retain];
        _owner = owner;
        _ticket = ticket;
        // The start document is requested during the read of the new page, so the read has already started.
        _started = webview.loading;
    }
    return self;
}

- (void)start {
    if (!_webview.loading) {
        [self commitAfterPresentation];
        return;
    }
    sp_observe_key_path("surface_layout.loading", SP_OBSERVE_RECORD, _webview, self, @"loading", 0, NULL);
}

- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary *)change context:(void *)context {
    sp_observe_delivered("surface_layout.loading");
    if (_webview.loading) {
        _started = YES;
        return;
    }
    if (!_started) return;
    [_webview removeObserver:self forKeyPath:@"loading"];
    [self commitAfterPresentation];
}

- (void)commitAfterPresentation {
    [_webview _doAfterNextPresentationUpdate:^{
        surfaceLayoutCommit(self->_owner, self->_ticket);
        [self release];
    }];
}

- (void)dealloc {
    [_webview release];
    [super dealloc];
}

@end

void surfaceLayoutStartPage(void *owner, uint64_t ticket, double height, void (^ready)(const char *failure)) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    NSWindow *window = (NSWindow *)owner;
    WKWebView *main = (WKWebView *)sp_window_main_webview(window);
    if (main == nil) {
        ready("the start title bar needs a registered main webview");
        return;
    }
    char *failure = NULL;
    // A window that is not visible has no previous page. A new window is transparent until the first page presents (window_reveal.h).
    if (!window.isVisible || window.alphaValue == 0) {
        bool set = windowSetTitlebarHeight(window, height, &failure);
        ready(set ? NULL : failure);
        free(failure);
        return;
    }
    void (^finish)(const char *) = [[ready copy] autorelease];
    [main retain];
    surfaceLayoutBegin(owner, ticket, ^(int allowed) {
        if (!allowed) {
            finish("the window closed before the start transaction began");
            [main release];
            return;
        }
        char *problem = NULL;
        if (!windowSetTitlebarHeight(window, height, &problem)) {
            surfaceLayoutCancel(owner);
            finish(problem);
            free(problem);
            [main release];
            return;
        }
        // The observer releases itself when it commits.
        [[[SPStartCommit alloc] initWithWebview:main owner:owner ticket:ticket] start];
        finish(NULL);
        [main release];
    });
}

// Joins the view webview to the open layout transaction of owner. The commit waits until the view presents or is abandoned.
bool surfaceLayoutJoinView(void *owner, uint64_t ticket, void *handle, void (^presented)(void)) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    WKWebView *view = (WKWebView *)handle;
    if (!view || activeOwner != owner || ticket != preparation || committing) return false;
    SPViewJoin *join = [[[SPViewJoin alloc] init] autorelease];
    join.view = view;
    if (!viewJoins) viewJoins = [[NSMutableArray alloc] init];
    [viewJoins addObject:join];
    void (^finish)(void) = [[presented copy] autorelease];
    [view _doAfterNextPresentationUpdate:^{
        if (!detachViewJoin(join)) return;
        finish();
        finishDeferredCommit();
    }];
    return true;
}

// Ends the view wait of the open transaction of owner without a presentation.
bool surfaceLayoutAbandonView(void *owner, void *handle) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    if (activeOwner != owner) return false;
    SPViewJoin *found = nil;
    for (SPViewJoin *join in viewJoins) {
        if ((void *)join.view == handle) { found = join; break; }
    }
    if (!found) return false;
    detachViewJoin(found);
    finishDeferredCommit();
    return true;
}

size_t surfaceLayoutViewJoinCount(void *owner) {
    return activeOwner == owner ? viewJoins.count : 0;
}
