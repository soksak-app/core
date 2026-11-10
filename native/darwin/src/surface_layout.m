#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#import "surface_layout.h"
#import "application_log.h"
#import "event_ring.h"
#import "observe.h"
#import "window_controls.h"
#import "window_facts.h"
#import "window_reveal.h"
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

// SPHeldInput is one piece of the input of a window that waits: an event of the window system or an injected call. key and press
// tell an injected call of a key and of a press; dropped answers an injected key that the close of its window drops.
@interface SPHeldInput : NSObject
@property(nonatomic, assign) void *owner;
@property(nonatomic, retain) NSEvent *event;
@property(nonatomic, copy) void (^call)(void);
@property(nonatomic, copy) void (^dropped)(void);
@property(nonatomic, assign) BOOL key;
@property(nonatomic, assign) BOOL press;
@end
@implementation SPHeldInput
- (void)dealloc { [_event release]; [_call release]; [_dropped release]; [super dealloc]; }
@end

// SPKeyWait is the wait of the keys of a window for the decision of the workbench about the keyboard and for the modal web view
// that takes the keyboard (docs/spec/native-surfaces.md#keyboard-of-a-surface). The keys wait while either waits; no pointer
// event waits in it, and no time or count ends it.
@interface SPKeyWait : NSObject
@property(nonatomic, assign) BOOL decision;
@property(nonatomic, assign) BOOL modal;
@property(nonatomic, retain) NSMutableArray<SPHeldInput *> *keys;
@end
@implementation SPKeyWait
- (void)dealloc { [_keys release]; [super dealloc]; }
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
// The windows whose keys wait for the decision of the workbench about the keyboard or for a modal.
static NSMutableDictionary<NSValue *, SPKeyWait *> *keyWaits;
// The windows whose open left press began on the workbench.
static NSMutableSet<NSValue *> *workbenchPresses;
static bool (^pressOnWorkbench)(void *, double, double);

static void releaseSettled(void);

// Diagnostic trace. Records ticket, begun, presented, and committed for each transaction. The drag check uses it to divide the delay of the recording frames into stages.
static NSMutableArray<NSMutableArray<NSNumber *> *> *trace;

// The CATransaction pairs of this code that are open, the layout transaction included.
static NSUInteger openTransactions;

void surfaceTransactionBegin(void) {
    NSCAssert(NSThread.isMainThread, @"a transaction of the surfaces requires the UI thread");
    openTransactions++;
    [CATransaction begin];
}

void surfaceTransactionCommit(void) {
    NSCAssert(NSThread.isMainThread, @"a transaction of the surfaces requires the UI thread");
    NSCAssert(openTransactions > 0, @"a transaction of the surfaces commits without its begin");
    openTransactions--;
    [CATransaction commit];
}

static void traceValue(uint64_t ticket, NSUInteger stage, double value) {
    if (!trace) return;
    NSMutableArray<NSNumber *> *record = nil;
    for (NSMutableArray<NSNumber *> *item in trace.reverseObjectEnumerator) {
        if (item[0].unsignedLongLongValue == ticket) { record = item; break; }
    }
    if (!record) {
        record = [NSMutableArray arrayWithObject:@(ticket)];
        for (NSUInteger i = 1; i < SURFACE_LAYOUT_TRACE_STAGES; i++) [record addObject:@(NAN)];
        [trace addObject:record];
    }
    // When one transaction checks the presentation several times, the last check is kept.
    record[stage] = @(value);
}

static void traceMark(uint64_t ticket, NSUInteger stage) {
    traceValue(ticket, stage, CACurrentMediaTime() * 1000);
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

static SPHeldInput *heldPiece(void *owner, NSEvent *event, void (^call)(void), BOOL key, BOOL press) {
    SPHeldInput *input = [[[SPHeldInput alloc] init] autorelease];
    input.owner = owner;
    input.event = event;
    input.call = call;
    input.key = key;
    input.press = press;
    return input;
}

static void keepInput(SPHeldInput *input) {
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
    BOOL waits = window && (type & later) && ![returning containsObject:[NSValue valueWithPointer:window]]
        && (inputHeld(window) || ((type & presses) && surfaceLayoutPressWaits(window, event.locationInWindow.x, event.locationInWindow.y)));
    if (waits) keepInput(heldPiece(window, event, nil, NO, NO));
    return waits;
}

static void (*applicationSendEvent)(id, SEL, NSEvent *);

static void releaseInput(void *owner);
static void returnInput(void *owner, NSArray<SPHeldInput *> *pieces);

// Gives the input of owner back when its open transaction does not hold it.
static void releaseWhenFree(void *owner) {
    if (activeOwner != owner) releaseInput(owner);
}

static SPKeyWait *keyWait(void *owner) {
    return keyWaits[[NSValue valueWithPointer:owner]];
}

// Ends the key wait of owner: the keys that waited return in their order through the event queue, followed by after, the press
// that ended the wait. Returns whether after went with them.
static BOOL giveKeys(void *owner, SPKeyWait *wait, SPHeldInput *after) {
    [[wait retain] autorelease];
    [keyWaits removeObjectForKey:[NSValue valueWithPointer:owner]];
    if (wait.keys.count == 0) return NO;
    NSMutableArray<SPHeldInput *> *pieces = [NSMutableArray arrayWithArray:wait.keys];
    if (after) [pieces addObject:after];
    returnInput(owner, pieces);
    return after != nil;
}

// Ends the wait of the decision of owner; the keys go when the modal does not wait either.
static BOOL endDecision(void *owner, SPHeldInput *after) {
    SPKeyWait *wait = keyWait(owner);
    if (!wait) return NO;
    wait.decision = NO;
    if (wait.modal) return NO;
    return giveKeys(owner, wait, after);
}

// The key wait of owner takes a key, and a press ends the decision that it waits for: the keys go first and the press after them.
// Returns whether the piece was taken; a piece that is not taken goes on now.
static BOOL keyWaitTakes(void *owner, SPHeldInput *piece) {
    SPKeyWait *wait = keyWait(owner);
    if (!wait) return NO;
    if (piece.key) {
        if (!wait.keys) wait.keys = [NSMutableArray array];
        [wait.keys addObject:piece];
        return YES;
    }
    return piece.press && wait.decision && endDecision(owner, piece);
}

// Runs one turn of a release: an injected call, or the end of the release, which sends on what arrived while it returned. A key
// call that comes back while the keys of its window wait waits again, in its order, and a press call ends the decision.
static void runHeldTurn(long turn) {
    SPHeldInput *input = [[heldTurns[@(turn)] retain] autorelease];
    [heldTurns removeObjectForKey:@(turn)];
    if (input.call) {
        if (!keyWaitTakes(input.owner, input)) input.call();
    } else {
        [returning removeObject:[NSValue valueWithPointer:input.owner]];
        releaseWhenFree(input.owner);
    }
}

// The key wait of the window of event takes a key event or ends its decision at a press event.
static BOOL keyWaitTakesEvent(NSEvent *event) {
    NSWindow *window = event.window;
    if (!window || !keyWait(window)) return NO;
    NSEventType type = event.type;
    BOOL key = type == NSEventTypeKeyDown || type == NSEventTypeKeyUp || type == NSEventTypeFlagsChanged;
    BOOL press = type == NSEventTypeLeftMouseDown || type == NSEventTypeRightMouseDown || type == NSEventTypeOtherMouseDown;
    if (!key && !press) return NO;
    return keyWaitTakes(window, heldPiece(window, event, nil, key, press));
}

static void sendEventAfterLayout(id application, SEL selector, NSEvent *event) {
    if (event.type == NSEventTypeApplicationDefined && event.subtype == kHeldTurnSubtype) {
        runHeldTurn(event.data1);
    } else if (!holdInput(event) && !keyWaitTakesEvent(event)) {
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

// Gives pieces of the input of owner back through the event queue, because a press can run a loop of its own and the
// application reads NSApp.currentEvent. The turns go to the start of the queue from the last to the first, so they stay in order
// and ahead of the input that arrived after them, and the end of the release comes after them; until that end the injected calls
// of owner wait behind them.
static void returnInput(void *owner, NSArray<SPHeldInput *> *pieces) {
    if (!returning) returning = [[NSCountedSet alloc] init];
    [returning addObject:[NSValue valueWithPointer:owner]];
    SPHeldInput *end = [[[SPHeldInput alloc] init] autorelease];
    end.owner = owner;
    postHeldTurn(end);
    for (SPHeldInput *input in pieces.reverseObjectEnumerator) {
        if (input.event) [NSApp postEvent:input.event atStart:YES];
        else postHeldTurn(input);
    }
}

// Gives the waiting input of owner back after its transaction ended.
static void releaseInput(void *owner) {
    if (!inputHeld(owner)) return;
    NSMutableArray<SPHeldInput *> *pieces = [NSMutableArray array];
    for (SPHeldInput *input in [[heldInput copy] autorelease]) {
        if (input.owner != owner) continue;
        [pieces addObject:input];
        [heldInput removeObjectIdenticalTo:input];
    }
    returnInput(owner, pieces);
}

static void startLayout(SPLayoutRequest *request) {
    watchInput();
    if (!activeOwner) {
        surfaceTransactionBegin();
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

// Ends the open transaction through path (SURFACE_LAYOUT_COMMIT_*): the CATransaction commits, and the next waiting layout
// starts. The record of the transaction names the path and the other pairs of this code that were open at the commit.
static void finishTransaction(int path) {
    uint64_t ticket = preparation;
    void *owner = activeOwner;
    committing = NO;
    activeOwner = NULL;
    traceValue(ticket, 5, path);
    traceValue(ticket, 6, openTransactions - 1);
    surfaceTransactionCommit();
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

// Finishes a deferred commit through path once the last joined view has ended.
static void finishDeferredCommit(int path) {
    if (committing && viewJoins.count == 0) finishTransaction(path);
}

// Ends every view wait of the open transaction without a presentation.
static void dropViewJoins(void) {
    for (SPViewJoin *join in [[viewJoins copy] autorelease]) detachViewJoin(join);
}

// Commits the open transaction of owner when ticket is its preparation, through path, or defers the commit to the last joined view.
static bool commitLayout(void *owner, uint64_t ticket, int path) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    if (activeOwner != owner || ticket != preparation || committing) {
        return false;
    }
    if (viewJoins.count) {
        committing = YES;
        return true;
    }
    finishTransaction(path);
    return true;
}

bool surfaceLayoutCommit(void *owner, uint64_t ticket) {
    return commitLayout(owner, ticket, SURFACE_LAYOUT_COMMIT_PRESENT);
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
    SPHeldInput *piece = heldPiece(owner, nil, call, NO, press);
    if ([returning containsObject:[NSValue valueWithPointer:owner]] || inputHeld(owner) || (press && surfaceLayoutPressWaits(owner, x, y))) {
        keepInput(piece);
        return true;
    }
    return keyWaitTakes(owner, piece);
}

bool surfaceLayoutHoldKey(void *owner, void (^call)(void), void (^dropped)(void)) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    SPHeldInput *piece = heldPiece(owner, nil, call, YES, NO);
    piece.dropped = dropped;
    if ([returning containsObject:[NSValue valueWithPointer:owner]] || inputHeld(owner)) {
        keepInput(piece);
        return true;
    }
    return keyWaitTakes(owner, piece);
}

// The close of a window drops the keys that wait, records how many, and answers each injected key with its refusal.
static void dropKeyWait(void *owner) {
    SPKeyWait *wait = [[keyWait(owner) retain] autorelease];
    if (!wait) return;
    [keyWaits removeObjectForKey:[NSValue valueWithPointer:owner]];
    for (SPHeldInput *input in wait.keys) {
        if (input.dropped) input.dropped();
    }
    if (wait.keys.count == 0) return;
    NSString *fields = [NSString stringWithFormat:@"{\"count\":%lu,\"reason\":\"closed\"}", (unsigned long)wait.keys.count];
    sp_event(SP_CLASS_INPUT, SP_EVENT_WARN, "native.keyboard.wait_dropped", fields.UTF8String);
}

static void observeKeyWaitClose(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        sp_observe_notification("surface_layout.key_wait_close", SP_OBSERVE_RECORD, NSWindowWillCloseNotification, nil, nil,
            ^(NSNotification *note) {
                [workbenchPresses removeObject:[NSValue valueWithPointer:note.object]];
                dropKeyWait(note.object);
            });
    });
}

// The key wait of owner, opened when the window has none.
static SPKeyWait *openKeyWait(void *owner) {
    SPKeyWait *wait = keyWait(owner);
    if (wait) return wait;
    watchInput();
    observeKeyWaitClose();
    wait = [[[SPKeyWait alloc] init] autorelease];
    if (!keyWaits) keyWaits = [[NSMutableDictionary alloc] init];
    keyWaits[[NSValue valueWithPointer:owner]] = wait;
    return wait;
}

void surfaceLayoutKeysDecided(void *owner) {
    NSCAssert(NSThread.isMainThread, @"the keyboard of a window belongs to the UI thread");
    endDecision(owner, nil);
}

void surfaceLayoutKeysWaitForModal(void *owner) {
    NSCAssert(NSThread.isMainThread, @"the keyboard of a window belongs to the UI thread");
    if (!owner) return;
    openKeyWait(owner).modal = YES;
}

bool surfaceLayoutKeysModalWaits(void *owner) {
    NSCAssert(NSThread.isMainThread, @"the keyboard of a window belongs to the UI thread");
    return keyWait(owner).modal;
}

void surfaceLayoutKeysModalEnded(void *owner) {
    NSCAssert(NSThread.isMainThread, @"the keyboard of a window belongs to the UI thread");
    SPKeyWait *wait = keyWait(owner);
    if (!wait.modal) return;
    wait.modal = NO;
    if (!wait.decision) giveKeys(owner, wait, nil);
}

void surfaceLayoutObserveWorkbench(bool (^onWorkbench)(void *window, double x, double y)) {
    NSCAssert(NSThread.isMainThread, @"the keyboard of a window belongs to the UI thread");
    if (pressOnWorkbench) return;
    pressOnWorkbench = [onWorkbench copy];
    watchInput();
}

void surfaceLayoutPointerPassing(void *owner, bool down, double x, double y) {
    NSCAssert(NSThread.isMainThread, @"the keyboard of a window belongs to the UI thread");
    NSValue *key = [NSValue valueWithPointer:owner];
    if (down) {
        if (!workbenchPresses) workbenchPresses = [[NSMutableSet alloc] init];
        if (pressOnWorkbench && pressOnWorkbench(owner, x, y)) [workbenchPresses addObject:key];
        else [workbenchPresses removeObject:key];
    } else if ([workbenchPresses containsObject:key]) {
        [workbenchPresses removeObject:key];
        openKeyWait(owner).decision = YES;
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
        if (committing) finishTransaction(SURFACE_LAYOUT_COMMIT_CANCEL);
        else commitLayout(owner, preparation, SURFACE_LAYOUT_COMMIT_CANCEL);
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
        if (committing) finishTransaction(SURFACE_LAYOUT_COMMIT_CANCEL);
        else commitLayout(owner, ticket, SURFACE_LAYOUT_COMMIT_CANCEL);
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
            if (layoutOpen(window)) {
                settle(window, again, finish);
            } else {
                // A window that waits for its reveal shows nothing, so the screen that shows its state is the frame after the reveal.
                sp_window_after_reveal(window, ^{ afterNextFrame(window.screen, finish); });
            }
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
        commitLayout(self->_owner, self->_ticket, SURFACE_LAYOUT_COMMIT_START);
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
        finishDeferredCommit(SURFACE_LAYOUT_COMMIT_VIEW_JOIN);
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
    finishDeferredCommit(SURFACE_LAYOUT_COMMIT_VIEW_ABANDON);
    return true;
}

size_t surfaceLayoutViewJoinCount(void *owner) {
    return activeOwner == owner ? viewJoins.count : 0;
}
