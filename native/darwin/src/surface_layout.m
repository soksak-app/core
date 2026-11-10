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

// SPViewJoin is a view that the open layout transaction of its owner waits for. It ends once: by its presentation, by an
// abandon, by the close of the view or by a press or key event that ends the hold. ended answers each end that the host did not
// ask for, with its reason.
@interface SPViewJoin : NSObject
@property(nonatomic, assign) void *owner;
@property(nonatomic, retain) WKWebView *view;
@property(nonatomic, assign) BOOL resolved;
@property(nonatomic, copy) void (^ended)(const char *reason);
@end
@implementation SPViewJoin
- (void)dealloc { [_view release]; [_ended release]; [super dealloc]; }
@end

// SPWindowLayout is the open layout transaction of one window (docs/spec/native-surfaces.md#layout-transaction): its
// preparation, whether its commit waits for its joined views, those views, and the preparations of the window that wait for that
// commit. No transaction waits for the transaction of another window.
@interface SPWindowLayout : NSObject
@property(nonatomic, assign) void *owner;
@property(nonatomic, assign) uint64_t preparation;
@property(nonatomic, assign) BOOL committing;
@property(nonatomic, retain) NSMutableArray<SPViewJoin *> *joins;
@property(nonatomic, retain) NSMutableArray<SPLayoutRequest *> *waiting;
@end
@implementation SPWindowLayout
- (void)dealloc { [_joins release]; [_waiting release]; [super dealloc]; }
@end

// The preparation that started last, which the diagnostic trace names.
static uint64_t preparation;
// The open layout transaction of each window.
static NSMutableDictionary<NSValue *, SPWindowLayout *> *layouts;
// YES while the Core Animation transaction that holds the changes of every window is open: from the start of the first open
// layout transaction to the end of the last one.
static BOOL holdOpen;
// The preparation of each window whose transaction a press or key event ended before the host asked for its commit; that commit
// then reports the commit that the input made.
static NSMutableDictionary<NSValue *, NSNumber *> *inputEnded;
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

static SPWindowLayout *layoutOf(void *owner) {
    return owner ? layouts[[NSValue valueWithPointer:owner]] : nil;
}

// Whether event passes the input that a transaction holds at once: the hold keeps only the content of its window, so a pointer
// event outside the content view (the window buttons and the title bar of the frame) and a key that the menu answers, one with
// the Command modifier, go on, and the hold never keeps the close of its window.
static BOOL passesHold(NSEvent *event) {
    NSWindow *window = event.window;
    if (!window) return YES;
    NSEventType type = event.type;
    if (type == NSEventTypeKeyDown || type == NSEventTypeKeyUp) return (event.modifierFlags & NSEventModifierFlagCommand) != 0;
    if (type == NSEventTypeFlagsChanged || type == NSEventTypeScrollWheel) return NO;
    NSView *content = window.contentView;
    if (!content) return YES;
    NSRect frame = [content convertRect:content.bounds toView:nil];
    return !NSPointInRect(event.locationInWindow, frame);
}

// Whether event ends the hold: a press of any button or a key event (docs/spec/native-surfaces.md#layout-transaction). Moves and
// drags of the pointer end nothing, so the frames of a drag keep their hold.
static BOOL endsHold(NSEvent *event) {
    switch (event.type) {
        case NSEventTypeLeftMouseDown: case NSEventTypeRightMouseDown: case NSEventTypeOtherMouseDown:
        case NSEventTypeKeyDown: case NSEventTypeKeyUp: case NSEventTypeFlagsChanged:
            return YES;
        default:
            return NO;
    }
}

static BOOL holdInput(NSEvent *event) {
    const NSEventMask presses = NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown;
    const NSEventMask later = presses | NSEventMaskLeftMouseDragged | NSEventMaskLeftMouseUp | NSEventMaskRightMouseDragged
        | NSEventMaskRightMouseUp | NSEventMaskOtherMouseDown | NSEventMaskOtherMouseDragged | NSEventMaskOtherMouseUp
        | NSEventMaskMouseMoved | NSEventMaskScrollWheel | NSEventMaskKeyDown | NSEventMaskKeyUp | NSEventMaskFlagsChanged;
    NSEventMask type = NSEventMaskFromType(event.type);
    NSWindow *window = event.window;
    if (!(type & later) || passesHold(event)) return NO;
    // A release puts its events at the start of the queue, so while it returns every event of the window is in its turn.
    BOOL waits = window && (type & later) && ![returning containsObject:[NSValue valueWithPointer:window]]
        && (inputHeld(window) || ((type & presses) && surfaceLayoutPressWaits(window, event.locationInWindow.x, event.locationInWindow.y)));
    if (waits) keepInput(heldPiece(window, event, nil, NO, NO));
    return waits;
}

static void (*applicationSendEvent)(id, SEL, NSEvent *);

static void releaseInput(void *owner);
static void returnInput(void *owner, NSArray<SPHeldInput *> *pieces);

// Gives the input of owner back when no open transaction of owner holds it.
static void releaseWhenFree(void *owner) {
    if (!layoutOf(owner)) releaseInput(owner);
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
    // A turn that a discard already ran comes back with no piece.
    if (!input) return;
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

static void endHoldByInput(void);

// The observers of the actions of the user, which surfaceInputActionObserve adds.
static NSMutableArray *actionObservers;

// Marks a press or key event whose action was told: a kept event comes back through -[NSApplication sendEvent:] carrying the mark,
// and an event that never comes back takes its mark with it.
static char noticedAction;

static void sendEventAfterLayout(id application, SEL selector, NSEvent *event) {
    if (event.type == NSEventTypeApplicationDefined && event.subtype == kHeldTurnSubtype) {
        runHeldTurn(event.data1);
        return;
    }
    // Every press and key event that reaches the application, a synthetic one sent through -[NSApplication sendEvent:] included,
    // is told to each observer of the actions of the user before any monitor, gate or view sees it.
    // The end of the layout hold is one of these observers. When input of the window of the event waits for the hold, the event
    // takes its place behind that input, which the end of the hold gives back in its order.
    // An event that was kept comes back through this method once; its action was already told, so it is told once.
    BOOL action = endsHold(event) && !objc_getAssociatedObject(event, &noticedAction);
    if (action) {
        objc_setAssociatedObject(event, &noticedAction, @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        NSWindow *window = event.window;
        BOOL behind = holdOpen && window && !passesHold(event) && inputHeld(window);
        if (behind) keepInput(heldPiece(window, event, nil, NO, NO));
        for (void (^observer)(NSEvent *) in [[actionObservers copy] autorelease]) observer(event);
        if (behind) return;
    }
    if (!holdInput(event) && !keyWaitTakesEvent(event)) {
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
static void (*applicationDiscard)(id, SEL, NSEventMask, NSEvent *);

// A tracking loop that discards events before its release takes the turns of held input from the queue with them. Each turn that
// a discard of application events took runs in the discarding turn, in its order, so each injected call runs once and the end of
// each release lets its window take input again.
static void discardAfterLayout(id application, SEL selector, NSEventMask mask, NSEvent *before) {
    applicationDiscard(application, selector, mask, before);
    if (!(mask & NSEventMaskApplicationDefined) || heldTurns.count == 0) return;
    for (NSNumber *turn in [heldTurns.allKeys sortedArrayUsingSelector:@selector(compare:)]) runHeldTurn(turn.longValue);
}

static void watchInput(void);

void surfaceInputActionObserve(void (^observer)(NSEvent *event)) {
    NSCAssert(NSThread.isMainThread, @"the actions of the user belong to the UI thread");
    watchInput();
    if (!actionObservers) actionObservers = [[NSMutableArray alloc] init];
    [actionObservers addObject:[[observer copy] autorelease]];
}

static void watchInput(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        Class application = object_getClass([NSApplication sharedApplication]);
        Method method = class_getInstanceMethod(application, @selector(sendEvent:));
        applicationSendEvent = (void (*)(id, SEL, NSEvent *))method_getImplementation(method);
        method_setImplementation(method, (IMP)sendEventAfterLayout);
        Method discard = class_getInstanceMethod(application, @selector(discardEventsMatchingMask:beforeEvent:));
        applicationDiscard = (void (*)(id, SEL, NSEventMask, NSEvent *))method_getImplementation(discard);
        method_setImplementation(discard, (IMP)discardAfterLayout);
        // A press or key event ends the layout hold at once (docs/spec/native-surfaces.md#layout-transaction).
        if (!actionObservers) actionObservers = [[NSMutableArray alloc] init];
        [actionObservers addObject:[[^(NSEvent *event) { endHoldByInput(); } copy] autorelease]];
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

static void observeWindowClose(void);

static void startLayout(SPLayoutRequest *request) {
    watchInput();
    observeWindowClose();
    if (!holdOpen) {
        surfaceTransactionBegin();
        [CATransaction setDisableActions:YES];
        holdOpen = YES;
    }
    NSValue *key = [NSValue valueWithPointer:request.owner];
    SPWindowLayout *layout = layouts[key];
    if (!layout) {
        layout = [[[SPWindowLayout alloc] init] autorelease];
        layout.owner = request.owner;
        layout.joins = [NSMutableArray array];
        layout.waiting = [NSMutableArray array];
        if (!layouts) layouts = [[NSMutableDictionary alloc] init];
        layouts[key] = layout;
    }
    [inputEnded removeObjectForKey:key];
    layout.preparation = request.ticket;
    preparation = request.ticket;
    traceMark(request.ticket, 1);
    if (layoutStarted) layoutStarted(request.owner);
    request.ready(true);
}

// Each window owns its transaction, so the transactions of several windows are open at once. Core Animation commits the changes
// of every window of the UI thread together, so they share one hold.
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
    SPWindowLayout *layout = layoutOf(owner);
    // A preparation that arrives while the commit of its window waits for joined views starts when that commit ends, because it
    // would otherwise commit with the views of the earlier ticket.
    if (!layout || !layout.committing) {
        startLayout(request);
        return;
    }
    [layout.waiting addObject:request];
}

// Ends the open transaction of owner through path (SURFACE_LAYOUT_COMMIT_*). The hold commits when no other transaction is open,
// and the preparations of the window that waited for this commit start. The record of the transaction names the path and the
// other pairs of this code that were open at the commit.
static void finishTransaction(void *owner, int path) {
    SPWindowLayout *layout = [[layoutOf(owner) retain] autorelease];
    if (!layout) return;
    uint64_t ticket = layout.preparation;
    [layouts removeObjectForKey:[NSValue valueWithPointer:owner]];
    traceValue(ticket, 5, path);
    traceValue(ticket, 6, openTransactions - (holdOpen ? 1 : 0));
    if (holdOpen && layouts.count == 0) {
        holdOpen = NO;
        surfaceTransactionCommit();
    }
    traceMark(ticket, 3);
    if (layoutEnded) layoutEnded(owner);
    releaseWhenFree(owner);
    NSArray<SPLayoutRequest *> *next = [[layout.waiting copy] autorelease];
    for (SPLayoutRequest *request in next) surfaceLayoutBegin(request.owner, request.ticket, request.ready);
    releaseSettled();
}

// Detaches a join from the transaction of its owner. It returns false when the join already ended, so each join ends once.
static bool detachViewJoin(SPViewJoin *join) {
    if (join.resolved) return false;
    join.resolved = YES;
    [layoutOf(join.owner).joins removeObjectIdenticalTo:join];
    return true;
}

// Finishes the deferred commit of owner through path once its last joined view has ended.
static void finishDeferredCommit(void *owner, int path) {
    SPWindowLayout *layout = layoutOf(owner);
    if (layout.committing && layout.joins.count == 0) finishTransaction(owner, path);
}

// Ends every view wait of the transaction of layout without a presentation; a reason tells each join why.
static void endViewJoins(SPWindowLayout *layout, const char *reason) {
    for (SPViewJoin *join in [[layout.joins copy] autorelease]) {
        if (detachViewJoin(join) && reason && join.ended) join.ended(reason);
    }
}

// Commits the open transaction of owner when ticket is its preparation, through path, or defers the commit to the last joined
// view. A preparation whose transaction a press or key event ended reports that commit once.
static bool commitLayout(void *owner, uint64_t ticket, int path) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    NSValue *key = [NSValue valueWithPointer:owner];
    SPWindowLayout *layout = layouts[key];
    if (!layout) {
        if (inputEnded[key] && inputEnded[key].unsignedLongLongValue == ticket) {
            [inputEnded removeObjectForKey:key];
            return true;
        }
        return false;
    }
    if (ticket != layout.preparation || layout.committing) return false;
    if (layout.joins.count) {
        layout.committing = YES;
        return true;
    }
    finishTransaction(owner, path);
    return true;
}

// A press or key event ends the hold at once: each open transaction commits what its joined peers presented, and each join that
// has not presented ends with the reason input (docs/spec/native-surfaces.md#layout-transaction).
static void endHoldByInput(void) {
    if (!holdOpen) return;
    for (SPWindowLayout *layout in [[layouts.allValues copy] autorelease]) {
        void *owner = layout.owner;
        if (layoutOf(owner) != layout) continue;
        endViewJoins(layout, "input");
        if (!layout.committing) {
            if (!inputEnded) inputEnded = [[NSMutableDictionary alloc] init];
            inputEnded[[NSValue valueWithPointer:owner]] = @(layout.preparation);
        }
        finishTransaction(owner, SURFACE_LAYOUT_COMMIT_INPUT);
    }
}

bool surfaceLayoutCommit(void *owner, uint64_t ticket) {
    return commitLayout(owner, ticket, SURFACE_LAYOUT_COMMIT_PRESENT);
}

bool surfaceLayoutIsPreparing(void *owner) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    return !pastPreparation && layoutOf(owner) != nil;
}

bool surfaceLayoutPressWaits(void *owner, double x, double y) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    if (!layoutOf(owner)) return false;
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

// Refuses the preparations of owner that wait for its deferred commit; with a ticket, only that one.
static void refuseWaiting(SPWindowLayout *layout, bool exact, uint64_t ticket) {
    for (SPLayoutRequest *request in [[layout.waiting copy] autorelease]) {
        if (exact && request.ticket != ticket) continue;
        [layout.waiting removeObjectIdenticalTo:request];
        request.ready(false);
    }
}

void surfaceLayoutCancel(void *owner) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    [inputEnded removeObjectForKey:[NSValue valueWithPointer:owner]];
    SPWindowLayout *layout = layoutOf(owner);
    if (layout) {
        refuseWaiting(layout, false, 0);
        endViewJoins(layout, NULL);
        finishTransaction(owner, SURFACE_LAYOUT_COMMIT_CANCEL);
    }
    releaseSettled();
}

void surfaceLayoutCancelTicket(void *owner, uint64_t ticket) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    NSValue *key = [NSValue valueWithPointer:owner];
    if (inputEnded[key] && inputEnded[key].unsignedLongLongValue == ticket) [inputEnded removeObjectForKey:key];
    SPWindowLayout *layout = layoutOf(owner);
    if (layout) {
        refuseWaiting(layout, true, ticket);
        if (layout.preparation == ticket) {
            endViewJoins(layout, NULL);
            finishTransaction(owner, SURFACE_LAYOUT_COMMIT_CANCEL);
        }
    }
    releaseSettled();
}

// The will-close of a window cancels its transactions in that turn, so a window that closes leaves no transaction and no
// waiting preparation behind.
static void observeWindowClose(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        sp_observe_notification("surface_layout.window_close", SP_OBSERVE_RECORD, NSWindowWillCloseNotification, nil, nil,
            ^(NSNotification *note) { surfaceLayoutCancel(note.object); });
    });
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

// Returns whether a change of the window owner can reach the screen only later: while the hold is open, no change of any window
// reaches the screen, and the waiting preparations of a window lie inside its open transaction.
static bool layoutOpen(void *owner) {
    return holdOpen || layoutOf(owner) != nil;
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

// Joins the view webview to the open layout transaction of owner. The commit waits until the view presents or its join ends.
bool surfaceLayoutJoinViewEnds(void *owner, uint64_t ticket, void *handle, void (^presented)(void), void (^ended)(const char *reason)) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    WKWebView *view = (WKWebView *)handle;
    SPWindowLayout *layout = layoutOf(owner);
    if (!view || !layout || ticket != layout.preparation || layout.committing) return false;
    SPViewJoin *join = [[[SPViewJoin alloc] init] autorelease];
    join.owner = owner;
    join.view = view;
    join.ended = ended;
    [layout.joins addObject:join];
    void (^finish)(void) = [[presented copy] autorelease];
    [view _doAfterNextPresentationUpdate:^{
        if (!detachViewJoin(join)) return;
        if (finish) finish();
        finishDeferredCommit(owner, SURFACE_LAYOUT_COMMIT_VIEW_JOIN);
    }];
    return true;
}

bool surfaceLayoutJoinView(void *owner, uint64_t ticket, void *handle, void (^presented)(void)) {
    return surfaceLayoutJoinViewEnds(owner, ticket, handle, presented, nil);
}

// Ends the view wait of the open transaction of owner without a presentation.
bool surfaceLayoutAbandonView(void *owner, void *handle) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    SPWindowLayout *layout = layoutOf(owner);
    SPViewJoin *found = nil;
    for (SPViewJoin *join in layout.joins) {
        if ((void *)join.view == handle) { found = join; break; }
    }
    if (!found) return false;
    detachViewJoin(found);
    finishDeferredCommit(owner, SURFACE_LAYOUT_COMMIT_VIEW_ABANDON);
    return true;
}

void surfaceLayoutViewClosed(void *handle) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    if (!handle) return;
    for (SPWindowLayout *layout in [[layouts.allValues copy] autorelease]) {
        BOOL ended = NO;
        for (SPViewJoin *join in [[layout.joins copy] autorelease]) {
            if ((void *)join.view != handle || !detachViewJoin(join)) continue;
            ended = YES;
            if (join.ended) join.ended("closed");
        }
        if (ended) finishDeferredCommit(layout.owner, SURFACE_LAYOUT_COMMIT_VIEW_ABANDON);
    }
}

size_t surfaceLayoutViewJoinCount(void *owner) {
    return layoutOf(owner).joins.count;
}
