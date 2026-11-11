// Checks that native input injection reaches the web view as a trusted event without activating the application.
//
// The window is an ordinary NSWindow and does not imitate the key window state. This is the same condition as a real application window.
#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import "input_inject.h"
#import "input_press_context.h"
#import "input_virtual.h"
#import "input_activity_wait.h"
#import "support/event_wait.h"
#import "support/records.h"
#import "event_ring.h"
#import "private/webkit.h"
#import "webview_input.h"

static int failures = 0;

// When the real pointer is over the window, AppKit and WebKit also process its moves, which mix into the test events.
// The window is placed away from the pointer, and if the pointer enters the window during the measurement, the measurement is reported invalid.
static void pointerOutside(NSWindow *window) {
    if (!NSPointInRect(NSEvent.mouseLocation, window.frame)) return;
    fprintf(stderr, "FAIL: the pointer is over the test window, so its movements reach the page too; "
        "rerun without moving the pointer over the window\n");
    exit(1);
}

static NSRect awayFromPointer(NSSize size) {
    NSPoint pointer = NSEvent.mouseLocation;
    NSRect screen = NSScreen.mainScreen.visibleFrame;
    for (NSScreen *candidate in NSScreen.screens) {
        if (NSPointInRect(pointer, candidate.frame)) screen = candidate.visibleFrame;
    }
    CGFloat left = pointer.x < NSMidX(screen) ? NSMaxX(screen) - size.width - 20 : NSMinX(screen) + 20;
    CGFloat bottom = pointer.y < NSMidY(screen) ? NSMaxY(screen) - size.height - 60 : NSMinY(screen) + 20;
    return NSMakeRect(left, bottom, size.width, size.height);
}

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static SPInputActivityWait *activityWait(NSArray<NSString *> *identifiers, NSUInteger *completionCount) {
    return [[[SPInputActivityWait alloc] initWithIdentifiers:identifiers completion:^{
        (*completionCount)++;
    }] autorelease];
}

static void checkActivityWaitAggregation(void) {
    NSArray<NSString *> *identifiers = @[
        @"role=main view=main-view registrationIndex=0",
        @"view=document-view registrationIndex=1",
    ];
    NSMutableArray *callbacks = [NSMutableArray array];
    __block NSUInteger completionCount = 0;
    SPInputActivityWait *normal = activityWait(identifiers, &completionCount);
    [normal startWithRegistration:^(NSUInteger index, NSString *identifier, sp_input_activity_member_completion completion) {
        (void)identifier;
        while (callbacks.count <= index) [callbacks addObject:[NSNull null]];
        callbacks[index] = [[completion copy] autorelease];
    }];
    ((sp_input_activity_member_completion)callbacks[0])();
    check(completionCount == 0, @"activity wait remains pending until every registered webview completes");
    ((sp_input_activity_member_completion)callbacks[1])();
    check(completionCount == 1, @"activity wait completes once after every member completes");

    callbacks = [NSMutableArray array];
    completionCount = 0;
    SPInputActivityWait *duplicate = activityWait(identifiers, &completionCount);
    [duplicate startWithRegistration:^(NSUInteger index, NSString *identifier, sp_input_activity_member_completion completion) {
        (void)identifier;
        while (callbacks.count <= index) [callbacks addObject:[NSNull null]];
        callbacks[index] = [[completion copy] autorelease];
    }];
    ((sp_input_activity_member_completion)callbacks[0])();
    ((sp_input_activity_member_completion)callbacks[0])();
    check(completionCount == 0,
        @"duplicate completion for one webview does not complete another pending webview");
    ((sp_input_activity_member_completion)callbacks[1])();
    check(completionCount == 1, @"each distinct webview contributes one aggregate completion");

    callbacks = [NSMutableArray array];
    completionCount = 0;
    SPInputActivityWait *ended = activityWait(identifiers, &completionCount);
    [ended startWithRegistration:^(NSUInteger index, NSString *identifier, sp_input_activity_member_completion completion) {
        (void)identifier;
        while (callbacks.count <= index) [callbacks addObject:[NSNull null]];
        callbacks[index] = [[completion copy] autorelease];
    }];
    ((sp_input_activity_member_completion)callbacks[0])();
    NSArray<NSString *> *unresolved = [ended finish];
    check([unresolved isEqual:@[identifiers[1]]],
        [NSString stringWithFormat:@"the end of the step identifies only the unresolved webview (%@)", unresolved]);
    ((sp_input_activity_member_completion)callbacks[1])();
    check(completionCount == 0 && [ended unresolvedIdentifiers].count == 0,
        @"a late webview completion cannot finish an ended aggregate");
}

static void checkActivityWaitDelayedRegistration(void) {
    NSArray<NSString *> *identifiers = @[@"role=main view=main-view registrationIndex=0"];
    __block NSUInteger completionCount = 0;
    __block SPInputActivityWait *installed = nil;
    __block NSUInteger registrationCount = 0;
    @autoreleasepool {
        SPInputActivityWait *wait = [[SPInputActivityWait alloc]
            initWithIdentifiers:identifiers completion:^{ completionCount++; }];
        NSArray<NSString *> *finished = [wait finish];
        BOOL adopted = [wait installIfActivationPending:NO store:^(SPInputActivityWait *value) {
            installed = [value retain];
        }];
        check([finished isEqual:identifiers], @"the end of the step captures the member before delayed registration");
        check(!adopted && installed == nil,
            @"a completed activation does not retain a wait installed by a delayed main-queue block");
        [wait startWithRegistration:^(NSUInteger index, NSString *identifier,
            sp_input_activity_member_completion completion) {
            (void)index;
            (void)identifier;
            (void)completion;
            registrationCount++;
        }];
        check(registrationCount == 0,
            @"an ended wait registers no WebKit activity callbacks when its queued block runs late");
        [wait release];
    }
    [installed release];
    check(completionCount == 0, @"a delayed registration cannot invoke completion after the end of the step");
}

static void checkActivityWaitRegistrationEnd(void) {
    NSString *beforeActivation = sp_input_activity_end_message(NO, NO, nil, @"the window closed");
    check(beforeActivation == nil, @"an end before app and key activation does not report a webview-stage error");
    NSString *registrationPending = sp_input_activity_end_message(YES, NO, nil, @"the window closed");
    check([registrationPending isEqualToString:@"webview activity-state registration pending when the window closed"],
        [NSString stringWithFormat:@"an end before callback registration reports its exact stage and its event (%@)", registrationPending]);
    NSString *unresolved = sp_input_activity_end_message(YES, YES,
        @[@"view=document registrationIndex=1"], @"the window closed");
    check([unresolved containsString:@"view=document registrationIndex=1"]
        && ![unresolved containsString:@"registrationIndex=0"] && [unresolved containsString:@"when the window closed"],
        [NSString stringWithFormat:@"a registered end reports only actual unresolved identifiers and its event (%@)", unresolved]);
}

/// Whether one line of records holds every part.
static BOOL hasRecord(NSString *records, NSArray<NSString *> *parts) {
    for (NSString *line in [records componentsSeparatedByString:@"\n"]) {
        BOOL all = [line containsString:@" info native input inject: "];
        for (NSString *part in parts) if (![line containsString:part]) all = NO;
        if (all) return YES;
    }
    return NO;
}

static id evaluate(WKWebView *view, NSString *script) {
    __block BOOL done = NO;
    __block id result = nil;
    [view evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
        if (error) fprintf(stderr, "JavaScript: %s\n", error.localizedDescription.UTF8String);
        result = [value retain];
        done = YES;
    }];
    eventWait([@"JavaScript answers " stringByAppendingString:script], ^BOOL { return done; });
    return [result autorelease];
}

static void drain(WKWebView *view) {
    __block BOOL done = NO;
    [view _doAfterProcessingAllPendingMouseEvents:^{ done = YES; }];
    eventWait(@"WebKit has processed the pending mouse events", ^BOOL { return done; });
}

// The navigation delegate of a page that a check loads. It is kept on its web view, which does not retain its delegate.
@interface SPPageLoad : NSObject <WKNavigationDelegate>
@property BOOL finished;
@end
@implementation SPPageLoad
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
    (void)view;
    (void)navigation;
    self.finished = YES;
}
@end
static char pageLoadKey;

// Loads html into view and keeps a navigation delegate that hears when the navigation finishes.
static void loadPage(WKWebView *view, NSString *html) {
    SPPageLoad *load = [[[SPPageLoad alloc] init] autorelease];
    objc_setAssociatedObject(view, &pageLoadKey, load, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    view.navigationDelegate = load;
    [view loadHTMLString:html baseURL:nil];
}

// Waits until the navigation that loadPage started on view finishes, so the scripts of the document have run.
static void awaitLoad(WKWebView *view) {
    SPPageLoad *load = objc_getAssociatedObject(view, &pageLoadKey);
    eventWait(@"the navigation of the page finishes", ^BOOL { return load.finished; });
    view.navigationDelegate = nil;
}

// Waits until the page of view holds condition, a JavaScript expression. The page judges condition at once and again at each
// event of the type named type that reaches its window, after the listeners that the page added before, so the wait ends at
// the event of the page that makes condition hold.
static void awaitPage(WKWebView *view, NSString *what, NSString *type, NSString *condition) {
    NSString *body = [NSString stringWithFormat:@"if (%@) return true;"
        "await new Promise(resolve => {"
        " const heard = () => { if (%@) { removeEventListener(eventType, heard, true); resolve(); } };"
        " addEventListener(eventType, heard, true); });"
        "return true;", condition, condition];
    __block BOOL done = NO;
    [view callAsyncJavaScript:body arguments:@{ @"eventType": type } inFrame:nil inContentWorld:WKContentWorld.pageWorld
        completionHandler:^(id value, NSError *error) {
            (void)value;
            if (error) fprintf(stderr, "JavaScript: %s\n", error.localizedDescription.UTF8String);
            done = YES;
        }];
    eventWait(what, ^BOOL { return done; });
}

typedef struct { BOOL done; sp_input_result result; NSUInteger seen; WKWebView *view; BOOL held; } SPReceipt;

static void received(void *context, sp_input_result result, const sp_input_held *held) {
    SPReceipt *receipt = context;
    receipt->result = result;
    receipt->held = held != NULL;
    // The numbers of presses and releases that the document received at completion time. Read synchronously on the main thread.
    receipt->seen = [evaluate(receipt->view, @"probe.events.filter(e=>e.type==='pointerdown'||e.type==='pointerup').length") unsignedIntegerValue];
    receipt->done = YES;
    // The answer can come from a callback that does not end a turn of the run loop.
    eventWake();
}

// The answer of an input: for a press sent while the document runs a busy script, busyEnded is set when the busy script
// answers, and busyEndedAtAnswer keeps whether it had ended when the press answered.
typedef struct { BOOL done; sp_input_result result; BOOL busyEnded; BOOL busyEndedAtAnswer; } SPAnswer;

static void answered(void *context, sp_input_result result, const sp_input_held *held) {
    SPAnswer *state = context;
    state->result = result;
    state->busyEndedAtAnswer = state->busyEnded;
    state->done = YES;
    eventWake();
}

// Runs script, a busy script of the document, and sets busyEnded of state when the script answers. The document receives the
// script before any input sent after it and answers it on the connection of the input receipts, so a receipt of that input
// comes after the answer of the script.
static void runBusy(WKWebView *view, NSString *script, SPAnswer *state) {
    [view evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
        (void)value;
        (void)error;
        state->busyEnded = YES;
    }];
}

static SPReceipt pointerThen(NSWindow *window, WKWebView *view, double x, double y, int phase) {
    SPReceipt receipt = {NO, SP_INPUT_REJECTED, 0, view, NO};
    SPReceipt *state = &receipt;
    sp_input_pointer_then(window, SP_INPUT_POINTER_MAIN, x, y, phase, 0, 0, 0, 1, received, state);
    eventWait(@"the pointer input answers", ^BOOL { return state->done; });
    return receipt;
}

// A web view that counts the presses that reach it: the point at which a press has been sent.
@interface SPPressedWebView : WKWebView
@property(nonatomic) NSUInteger presses;
@end
@implementation SPPressedWebView
- (void)mouseDown:(NSEvent *)event {
    self.presses++;
    [super mouseDown:event];
}
@end

// Runs the main queue until a marker block that it enqueues now has run: the point at which a check sees what the turns
// before it decided, with no time in the check.
static void runMarker(void) {
    __block BOOL ran = NO;
    dispatch_async(dispatch_get_main_queue(), ^{ ran = YES; });
    eventWait(@"the marker block runs", ^BOOL { return ran; });
}

// Checks that the completion of a press and release is called after the document receives them. A content world that the page cannot see reports the receipt.
static void checkReceipts(void) {
    NSWindow *window = [[[NSWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(300, 200))
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO] autorelease];
    [window setReleasedWhenClosed:NO];
    SPPressedWebView *view = [[[SPPressedWebView alloc] initWithFrame:NSMakeRect(0, 0, 300, 200)] autorelease];
    window.contentView = view;
    loadPage(view, @"<!doctype html><body style='margin:0;height:200px'><script>window.probe={events:[]};"
        "for (const type of ['pointerdown','pointerup']) addEventListener(type,e=>probe.events.push({type}),true);"
        "</script>");
    awaitLoad(view);
    [window orderBack:nil];

    // An unregistered web view does not report receipt, so the completion is immediate on delivery.
    SPReceipt unregistered = pointerThen(window, view, 50, 50, 1);
    check(unregistered.result == SP_INPUT_DELIVERED, @"a press into an unregistered webview completes when it is delivered");
    pointerThen(window, view, 50, 50, 3);
    drain(view);

    check(webviewInputRegister(view), @"the webview registers for pointer input");
    check([evaluate(view, @"typeof window.webkit?.messageHandlers?.soksakInputReceipt") isEqual:@"undefined"],
        @"the page cannot see the input receipt handler");
    evaluate(view, @"probe.events.length=0; null");
    pointerOutside(window);
    SPReceipt down = pointerThen(window, view, 50, 50, 1);
    check(down.result == SP_INPUT_DELIVERED && down.seen == 1 && !down.held,
        [NSString stringWithFormat:@"a press completes after the document received it without a held-button report (%d, %lu events, held %d)",
            down.result, (unsigned long)down.seen, down.held]);
    SPReceipt up = pointerThen(window, view, 50, 50, 3);
    check(up.result == SP_INPUT_DELIVERED && up.seen == 2,
        [NSString stringWithFormat:@"a release completes after the document received it (%d, %lu events)", up.result, (unsigned long)up.seen]);

    // A busy document receives the press after it finishes, so the completion is also after that: when the press answers, the
    // busy script has answered.
    SPAnswer late = {NO, SP_INPUT_REJECTED, NO, NO};
    SPAnswer *lateState = &late;
    runBusy(view, @"{const end=Date.now()+1000; while(Date.now()<end){}} null", lateState);
    sp_input_pointer_then(window, SP_INPUT_POINTER_MAIN, 50, 50, 1, 0, 0, 0, 1, answered, lateState);
    eventWait(@"the press sent to a busy document answers", ^BOOL { return lateState->done; });
    check(late.result == SP_INPUT_DELIVERED && late.busyEndedAtAnswer,
        [NSString stringWithFormat:@"a press completes only after a busy document is free to receive it (%d, busy script ended %d)",
            late.result, late.busyEndedAtAnswer]);
    pointerThen(window, view, 50, 50, 3);

    // A scroll into a window that is not shown is refused in its turn, because that window presents nothing until it shows.
    [window orderOut:nil];
    SPAnswer hiddenScroll = {NO, SP_INPUT_DELIVERED};
    SPAnswer *hiddenScrollState = &hiddenScroll;
    sp_input_pointer_then(window, SP_INPUT_POINTER_MAIN, 50, 50, 4, 0, 0, 40, 1, answered, hiddenScrollState);
    runMarker();
    check(hiddenScroll.done && hiddenScroll.result == SP_INPUT_UNRECEIVED,
        [NSString stringWithFormat:@"a scroll into a window that is not shown is refused in its turn (done %d, %d)",
            hiddenScroll.done, hiddenScroll.result]);
    [window orderBack:nil];

    // A press that a busy document has not received when its window closes ends with the close and is reported as not
    // received. The window closes once the press has reached the web view, while the document is still busy. The record names, at the level error, the web view whose receipt it awaited and the view the press reached, so
    // a press that reached another page is told from a page that did not answer.
    [view evaluateJavaScript:@"{const end=Date.now()+2500; while(Date.now()<end){}} null" completionHandler:nil];
    SPAnswer busy = {NO, SP_INPUT_DELIVERED};
    SPAnswer *busyState = &busy;
    NSString *unreceived = capturedRecords(^{
        NSUInteger pressed = view.presses;
        sp_input_pointer_then(window, SP_INPUT_POINTER_MAIN, 50, 50, 1, 0, 0, 0, 1, answered, busyState);
        eventWait(@"the press reaches the web view", ^BOOL { return view.presses > pressed || busyState->done; });
        check(!busyState->done, @"a press into a busy document waits for its receipt");
        [window close];
        eventWait(@"the close of the window ends the press", ^BOOL { return busyState->done; });
    });
    check(busy.result == SP_INPUT_UNRECEIVED,
        [NSString stringWithFormat:@"a press that the close of its window ends is reported as not received (%d)", busy.result]);
    // The close ends the press itself, so the pointer presses again in another window (docs/spec/exposure.md#methods).
    check(!sp_input_press_open(window, 0) && NSEvent.pressedMouseButtons == sp_input_physical_buttons(),
        @"the close of its window ends the open press of the pointer");
    NSString *awaited = [NSString stringWithFormat:@"\"target\":{\"class\":\"SPPressedWebView\",\"frame\":[0,0,300,200],\"hidden\":false,\"inWindow\":true,"
        "\"loading\":false,\"url\":\"about:blank\",\"view\":\"%p\"}", view];
    BOOL named = NO;
    for (NSString *line in [unreceived componentsSeparatedByString:@"\n"]) {
        if ([line containsString:@" error native input inject: {"] && [line containsString:@"\"kind\":\"unreceived\""]
            && [line containsString:awaited]
            && [line containsString:@"\"samePage\":true"] && [line containsString:@"\"type\":\"pointerdown\""]) named = YES;
    }
    check(named, [NSString stringWithFormat:@"a press the document did not receive names the awaited and the reached view (got %@)", unreceived]);
    webviewInputUnregister(view);
}

// The native library delivers one input.pointer of the application at a time: a request starts in the turn in which the request
// before it answered, and a request whose window closes before it starts answers in the close turn (docs/spec/exposure.md#named-pointers).
typedef struct { NSMutableArray<NSString *> *order; NSString *name; BOOL done; sp_input_result result; } SPQueued;

static void queued(void *context, sp_input_result result, const sp_input_held *held) {
    (void)held;
    SPQueued *state = context;
    state->result = result;
    state->done = YES;
    [state->order addObject:state->name];
    eventWake();
}

static void checkPointerQueue(void) {
    NSWindow *window = [[[NSWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(300, 200))
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO] autorelease];
    [window setReleasedWhenClosed:NO];
    WKWebView *view = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 300, 200)] autorelease];
    window.contentView = view;
    loadPage(view, @"<!doctype html><body style='margin:0;height:200px'><script>window.probe={events:[]};"
        "for (const type of ['pointerdown','pointerup']) addEventListener(type,e=>probe.events.push({type}),true);"
        "</script>");
    awaitLoad(view);
    [window orderBack:nil];
    check(webviewInputRegister(view), @"the webview of the queue registers for pointer input");
    pointerOutside(window);
    NSMutableArray<NSString *> *order = [NSMutableArray array];

    // The press waits for the receipt of a busy document; the request after it, whose button is refused at once, waits for it.
    [view evaluateJavaScript:@"{const end=Date.now()+700; while(Date.now()<end){}} null" completionHandler:nil];
    SPQueued press = {order, @"press", NO, SP_INPUT_REJECTED};
    SPQueued refused = {order, @"refused", NO, SP_INPUT_DELIVERED};
    SPQueued *pressState = &press, *refusedState = &refused;
    sp_input_pointer_then(window, SP_INPUT_POINTER_MAIN, 50, 50, 1, 0, 0, 0, 1, queued, pressState);
    sp_input_pointer_then(window, SP_INPUT_POINTER_MAIN, 50, 50, 1, 5, 0, 0, 1, queued, refusedState);
    check(!refused.done, @"a request does not start while the request before it has not answered");
    eventWait(@"the press and the refused request answer", ^BOOL { return pressState->done && refusedState->done; });
    check([order isEqual:@[@"press", @"refused"]] && press.result == SP_INPUT_DELIVERED && refused.result == SP_INPUT_REJECTED,
        [NSString stringWithFormat:@"each request answers once, in the order of the requests (%@, %d, %d)", order, press.result, refused.result]);
    pointerThen(window, view, 50, 50, 3);
    drain(view);

    // A request of a window that closes while it waits for its turn answers in the close turn, before the request ahead of it.
    NSWindow *other = [[[NSWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(200, 100))
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO] autorelease];
    [other setReleasedWhenClosed:NO];
    [other orderBack:nil];
    [order removeAllObjects];
    [view evaluateJavaScript:@"{const end=Date.now()+700; while(Date.now()<end){}} null" completionHandler:nil];
    SPQueued ahead = {order, @"ahead", NO, SP_INPUT_REJECTED};
    SPQueued closed = {order, @"closed", NO, SP_INPUT_DELIVERED};
    SPQueued *aheadState = &ahead, *closedState = &closed;
    sp_input_pointer_then(window, SP_INPUT_POINTER_MAIN, 50, 50, 1, 0, 0, 0, 1, queued, aheadState);
    sp_input_pointer_then(other, SP_INPUT_POINTER_MAIN, 20, 20, 0, 0, 0, 0, 1, queued, closedState);
    [other close];
    check(closed.done && !ahead.done && closed.result == SP_INPUT_REJECTED,
        [NSString stringWithFormat:@"a waiting request of a closed window answers in the close turn (done %d, ahead %d, result %d)",
            closed.done, ahead.done, closed.result]);
    eventWait(@"the request ahead of the closed window answers", ^BOOL { return aheadState->done; });
    check([order isEqual:@[@"closed", @"ahead"]], [NSString stringWithFormat:@"each request answers once (%@)", order]);
    pointerThen(window, view, 50, 50, 3);
    webviewInputUnregister(view);
    [window close];
}

// A drag and a release must be delivered to the view that received the press, not to another view under the coordinates.
@interface SPPointerTarget : NSView
@property(nonatomic) NSUInteger downs;
@property(nonatomic) NSUInteger drags;
@property(nonatomic) NSUInteger ups;
@property(nonatomic) NSUInteger rightDowns;
@property(nonatomic) NSUInteger rightDrags;
@property(nonatomic) NSUInteger rightUps;
@end
@implementation SPPointerTarget
- (void)mouseDown:(NSEvent *)event { self.downs++; }
- (void)mouseDragged:(NSEvent *)event { self.drags++; }
- (void)mouseUp:(NSEvent *)event { self.ups++; }
- (void)rightMouseDown:(NSEvent *)event { self.rightDowns++; }
- (void)rightMouseDragged:(NSEvent *)event { self.rightDrags++; }
- (void)rightMouseUp:(NSEvent *)event { self.rightUps++; }
@end

// A window that answers as the key window, because a move without a button goes only to the key window and make test does not
// activate the application.
@interface SPKeyAnswerWindow : NSWindow
@end
@implementation SPKeyAnswerWindow
- (BOOL)isKeyWindow { return YES; }
@end

@interface SPTrackedView : NSView
@property(nonatomic) NSUInteger moves;
@property(nonatomic) NSUInteger enters;
@property(nonatomic) NSUInteger exits;
@property(nonatomic) NSUInteger downs;
@property(nonatomic) NSUInteger movesAtDown;
// The tracking area of each enter and exit, in order: AppKit gives a crossing the area it crosses (-[NSEvent trackingArea]).
@property(nonatomic, readonly) NSMutableArray *crossedAreas;
@end
@implementation SPTrackedView
@synthesize crossedAreas = _crossedAreas;
- (NSMutableArray *)crossedAreas {
    if (!_crossedAreas) _crossedAreas = [[NSMutableArray alloc] init];
    return _crossedAreas;
}
- (void)dealloc {
    [_crossedAreas release];
    [super dealloc];
}
- (NSTrackingArea *)track:(NSTrackingAreaOptions)options {
    NSTrackingArea *area = [[[NSTrackingArea alloc] initWithRect:self.bounds options:options | NSTrackingActiveAlways
        owner:self userInfo:nil] autorelease];
    [self addTrackingArea:area];
    return area;
}
- (void)mouseMoved:(NSEvent *)event { self.moves++; }
- (void)mouseEntered:(NSEvent *)event { self.enters++; [self.crossedAreas addObject:event.trackingArea ?: (id)NSNull.null]; }
- (void)mouseExited:(NSEvent *)event { self.exits++; [self.crossedAreas addObject:event.trackingArea ?: (id)NSNull.null]; }
// AppKit reads the key state of a window that answers it from the system, so it treats a press there as a first click.
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
- (void)mouseDown:(NSEvent *)event { self.downs++; self.movesAtDown = self.moves; }
@end

@interface SPAcceptingView : NSView
@property(nonatomic) NSUInteger downs;
@property(nonatomic) NSUInteger drags;
@property(nonatomic) NSUInteger ups;
@property(nonatomic) BOOL pressIsCurrent;
@end
@implementation SPAcceptingView
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
- (void)mouseDown:(NSEvent *)event { self.downs++; self.pressIsCurrent = NSApp.currentEvent == event; }
- (void)mouseDragged:(NSEvent *)event { self.drags++; }
- (void)mouseUp:(NSEvent *)event { self.ups++; }
@end

// A person's move reaches the owner of every tracking area that holds the pointer, so a view under another view hears it too. The
// move also crosses the enter and exit of each area.
static void checkMoveReachesEveryOwner(void) {
    NSWindow *window = [[SPKeyAnswerWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(300, 200))
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    NSView *content = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 300, 200)] autorelease];
    window.contentView = content;
    const NSTrackingAreaOptions both = NSTrackingMouseEnteredAndExited | NSTrackingMouseMoved;
    SPTrackedView *below = [[[SPTrackedView alloc] initWithFrame:content.bounds] autorelease];
    SPTrackedView *above = [[[SPTrackedView alloc] initWithFrame:NSMakeRect(0, 0, 200, 200)] autorelease];
    SPTrackedView *inner = [[[SPTrackedView alloc] initWithFrame:NSMakeRect(0, 0, 100, 100)] autorelease];
    SPTrackedView *hidden = [[[SPTrackedView alloc] initWithFrame:content.bounds] autorelease];
    SPTrackedView *quiet = [[[SPTrackedView alloc] initWithFrame:NSMakeRect(0, 0, 100, 100)] autorelease];
    hidden.hidden = YES;
    [content addSubview:below]; [content addSubview:quiet]; [content addSubview:above]; [above addSubview:inner]; [content addSubview:hidden];
    [below track:NSTrackingMouseMoved | NSTrackingInVisibleRect];
    [above track:both];
    [inner track:both];
    [hidden track:both];
    // An owner of two areas, as a WKWebView has one for the pointer and one for modifier keys, below every other view.
    SPTrackedView *pair = [[[SPTrackedView alloc] initWithFrame:NSMakeRect(0, 0, 100, 100)] autorelease];
    [content addSubview:pair positioned:NSWindowBelow relativeTo:nil];
    NSTrackingArea *pairMoves = [pair track:both];
    NSTrackingArea *pairCrossings = [pair track:NSTrackingMouseEnteredAndExited];
    [quiet track:NSTrackingMouseEnteredAndExited];
    [window orderBack:nil];
    pointerOutside(window);
    check(sp_input_pointer(window, 50, 150, 0, 0, 0, 0) == SP_INPUT_DELIVERED, @"a move over overlapping owners is delivered");
    check(below.moves == 1 && above.moves == 1 && inner.moves == 1, @"each owner of a tracking area at the point hears the move");
    check(hidden.moves == 0 && hidden.enters == 0, @"the owner of a tracking area in a hidden view hears nothing");
    check(quiet.moves == 0, @"an area without moves receives no move");
    check(quiet.enters == 1 && above.enters == 1 && inner.enters == 1, @"a first move enters each area at the point");
    check(sp_input_pointer(window, 60, 150, 0, 0, 0, 0) == SP_INPUT_DELIVERED && below.moves == 2 && inner.enters == 1,
        @"a move inside an area enters it once");
    check(sp_input_pointer(window, 150, 50, 0, 0, 0, 0) == SP_INPUT_DELIVERED && below.moves == 3 && above.moves == 3,
        @"owners that still hold the point keep hearing the moves");
    check(inner.moves == 2 && inner.exits == 1 && quiet.exits == 1, @"a move out of an area exits it and sends it no move");
    check(above.exits == 0, @"an area that holds the point is not exited");
    // An owner of two areas tells their crossings apart by the area of the event, as WebKit does with its area for modifier keys:
    // the move into the pair enters each area once and the move out exits each once.
    NSCountedSet *pairCrossed = [NSCountedSet setWithArray:pair.crossedAreas];
    check(pair.crossedAreas.count == 4 && [pairCrossed countForObject:pairMoves] == 2 && [pairCrossed countForObject:pairCrossings] == 2,
        [NSString stringWithFormat:@"each enter and exit carries the tracking area that it crosses (%@)", pair.crossedAreas]);

    // A press at another point: a person moved there first, so the owners know the point before the press.
    const NSUInteger before = below.moves;
    check(sp_input_pointer(window, 50, 150, 1, 0, 0, 0) == SP_INPUT_DELIVERED, @"a press after a move elsewhere is delivered");
    check(inner.downs == 1 && below.moves == before + 1 && inner.movesAtDown == 3, @"the owners hear the point of a press before the press");
    check(sp_input_pointer(window, 50, 150, 3, 0, 0, 0) == SP_INPUT_DELIVERED, @"the release of that press is delivered");
    [window close];
    [window release];
}

// The real activation, which this test gives in place of AppKit. It is replaced before the first virtual key window, so the
// virtual state reads it as the answer of AppKit.
static BOOL reallyActive;
static BOOL testIsActive(id self, SEL selector) { return reallyActive; }

// A press, drag and release of the key window of the application that is really active pass the application as a person's
// gesture does: the local monitors see them before the view, and the driver does not move the first responder ahead of the
// press. A window that is not the key window keeps direct delivery.
static void checkKeyWindowPressPassesApplication(void) {
    reallyActive = YES;
    NSWindow *window = [[SPKeyAnswerWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(300, 200))
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    NSView *content = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 300, 200)] autorelease];
    window.contentView = content;
    SPAcceptingView *pressed = [[[SPAcceptingView alloc] initWithFrame:content.bounds] autorelease];
    [content addSubview:pressed];
    [window orderBack:nil];
    pointerOutside(window);
    __block NSUInteger downs = 0, drags = 0, ups = 0;
    __block NSResponder *atDown = nil;
    NSEventMask gesture = NSEventMaskLeftMouseDown | NSEventMaskLeftMouseDragged | NSEventMaskLeftMouseUp;
    id monitor = [NSEvent addLocalMonitorForEventsMatchingMask:gesture handler:^NSEvent *(NSEvent *event) {
        if (event.type == NSEventTypeLeftMouseDown) { downs++; atDown = event.window.firstResponder; }
        else if (event.type == NSEventTypeLeftMouseDragged) drags++;
        else ups++;
        return event;
    }];
    [window makeFirstResponder:nil];
    check(sp_input_pointer(window, 50, 50, 1, 0, 0, 0) == SP_INPUT_DELIVERED, @"the press of a key window is delivered");
    check(downs == 1, [NSString stringWithFormat:@"a local monitor sees the press of a key window once (%lu)", (unsigned long)downs]);
    check(pressed.downs == 1, [NSString stringWithFormat:@"AppKit delivers the press of a key window to the view once (%lu)", (unsigned long)pressed.downs]);
    check(!pressed.pressIsCurrent, @"the application path leaves NSApp.currentEvent, so the press context stays on that path");
    check(atDown == window, [NSString stringWithFormat:@"the driver leaves the first responder until the press passes the application (%@)", atDown]);
    check(sp_input_pointer(window, 120, 80, 2, 0, 0, 0) == SP_INPUT_DELIVERED && drags == 1,
        [NSString stringWithFormat:@"a local monitor sees the drag of a key window once (%lu)", (unsigned long)drags]);
    check(pressed.drags == 1, [NSString stringWithFormat:@"AppKit delivers the drag of a key window to the pressed view once (%lu)", (unsigned long)pressed.drags]);
    check(sp_input_pointer(window, 120, 80, 3, 0, 0, 0) == SP_INPUT_DELIVERED && ups == 1,
        [NSString stringWithFormat:@"a local monitor sees the release of a key window once (%lu)", (unsigned long)ups]);
    check(pressed.ups == 1, [NSString stringWithFormat:@"AppKit delivers the release of a key window to the pressed view once (%lu)", (unsigned long)pressed.ups]);
    [window close];
    [window release];
    reallyActive = NO;

    NSWindow *other = [[NSWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(300, 200))
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [other setReleasedWhenClosed:NO];
    SPAcceptingView *direct = [[[SPAcceptingView alloc] initWithFrame:NSMakeRect(0, 0, 300, 200)] autorelease];
    other.contentView = direct;
    [other orderBack:nil];
    downs = 0;
    check(sp_input_pointer(other, 50, 50, 1, 0, 0, 0) == SP_INPUT_DELIVERED && direct.downs == 1 && other.firstResponder == direct,
        @"the press of a window that is not key reaches the view and moves the first responder");
    check(sp_input_pointer(other, 120, 80, 2, 0, 0, 0) == SP_INPUT_DELIVERED && direct.drags == 1,
        @"the drag of a window that is not key reaches the pressed view");
    check(sp_input_pointer(other, 120, 80, 3, 0, 0, 0) == SP_INPUT_DELIVERED && direct.ups == 1,
        @"the release of a window that is not key reaches the pressed view");
    check(downs == 0 && drags == 1 && ups == 1, @"the gesture of a window that is not key passes no monitor");
    [other close];
    [other release];
    [NSEvent removeMonitor:monitor];
}

static void checkPointerTargetAcrossViews(void) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(240, 120))
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    NSView *content = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 240, 120)] autorelease];
    SPPointerTarget *first = [[[SPPointerTarget alloc] initWithFrame:NSMakeRect(0, 0, 120, 120)] autorelease];
    SPPointerTarget *second = [[[SPPointerTarget alloc] initWithFrame:NSMakeRect(120, 0, 120, 120)] autorelease];
    [content addSubview:first]; [content addSubview:second]; window.contentView = content;
    // A person presses only a window on the screen; the window stands behind the windows of the person.
    [window orderBack:nil];
    check(sp_input_pointer(window, 30, 30, 1, 0, 0, 0) == SP_INPUT_DELIVERED, @"cross-view press delivered");
    check(sp_input_pointer(window, 150, 30, 2, 0, 0, 0) == SP_INPUT_DELIVERED, @"cross-view drag delivered");
    check(sp_input_pointer(window, 150, 30, 3, 0, 0, 0) == SP_INPUT_DELIVERED, @"cross-view release delivered");
    check(first.downs == 1 && first.drags == 1 && first.ups == 1 && second.downs == 0 && second.drags == 0 && second.ups == 0,
        [NSString stringWithFormat:@"press target keeps the entire gesture: first %lu/%lu/%lu, second %lu/%lu/%lu",
            (unsigned long)first.downs, (unsigned long)first.drags, (unsigned long)first.ups,
            (unsigned long)second.downs, (unsigned long)second.drags, (unsigned long)second.ups]);
    check(sp_input_pointer(window, 30, 30, 2, 0, 0, 0) == SP_INPUT_REJECTED &&
        sp_input_pointer(window, 30, 30, 3, 0, 0, 0) == SP_INPUT_REJECTED,
        @"drag and release without a press are rejected");
    check(sp_input_pointer(window, 30, 30, 1, 0, 0, 0) == SP_INPUT_DELIVERED &&
        sp_input_pointer(window, 150, 30, 1, 0, 0, 0) == SP_INPUT_PRESS_OPEN,
        @"a duplicate press reports the open press and does not replace the gesture target");
    check(sp_input_pointer(window, 150, 30, 1, 1, 0, 0) == SP_INPUT_DELIVERED &&
        sp_input_pointer(window, 30, 30, 2, 1, 0, 0) == SP_INPUT_DELIVERED &&
        sp_input_pointer(window, 30, 30, 3, 1, 0, 0) == SP_INPUT_DELIVERED &&
        sp_input_pointer(window, 150, 30, 2, 0, 0, 0) == SP_INPUT_DELIVERED &&
        sp_input_pointer(window, 150, 30, 3, 0, 0, 0) == SP_INPUT_DELIVERED,
        @"left and right gestures keep separate targets");
    check(first.downs == 2 && first.drags == 2 && first.ups == 2 &&
        second.rightDowns == 1 && second.rightDrags == 1 && second.rightUps == 1,
        @"each button receives its complete gesture on its press target");
    check(sp_input_pointer(window, 30, 30, 1, 0, 0, 0) == SP_INPUT_DELIVERED,
        @"a released button starts a new gesture");
    [first removeFromSuperview];
    check(sp_input_pointer(window, 150, 30, 2, 0, 0, 0) == SP_INPUT_REJECTED,
        @"a removed press target rejects the remaining gesture");
    [window close]; [window release];
}

// A window that is not shown takes no pointer input: no person points at it, and AppKit gives no press to it. Its move, press and
// release are refused in their turn with the reason, and the view under the point receives nothing.
static void checkHiddenWindowRefusesPointer(void) {
    NSWindow *window = [[[NSWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(200, 100))
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO] autorelease];
    window.releasedWhenClosed = NO;
    SPPointerTarget *target = [[[SPPointerTarget alloc] initWithFrame:NSMakeRect(0, 0, 200, 100)] autorelease];
    window.contentView = target;
    __block sp_input_result move = SP_INPUT_DELIVERED, down = SP_INPUT_DELIVERED, up = SP_INPUT_DELIVERED;
    NSString *records = capturedRecords(^{
        move = sp_input_pointer(window, 20, 20, 0, 0, 0, 0);
        down = sp_input_pointer(window, 20, 20, 1, 0, 0, 0);
        up = sp_input_pointer(window, 20, 20, 3, 0, 0, 0);
    });
    check(move == SP_INPUT_REJECTED && down == SP_INPUT_REJECTED && up == SP_INPUT_REJECTED && target.downs == 0 && target.ups == 0,
        [NSString stringWithFormat:@"a move, a press and a release of a window that is not shown are refused (%d %d %d, downs %lu, ups %lu)",
            move, down, up, (unsigned long)target.downs, (unsigned long)target.ups]);
    check(hasRecord(records, @[@"\"kind\":\"pointer\"", @"\"phase\":1", @"\"result\":\"rejected\"", @"\"reason\":\"the window is not shown\""]),
        [NSString stringWithFormat:@"the refusal of a window that is not shown is recorded with its reason (got %@)", records]);
    [window orderBack:nil];
    check(sp_input_pointer(window, 20, 20, 1, 0, 0, 0) == SP_INPUT_DELIVERED && sp_input_pointer(window, 20, 20, 3, 0, 0, 0) == SP_INPUT_DELIVERED
        && target.downs == 1 && target.ups == 1, @"the window takes the press and its release once it is shown");
    [window close];
}

static void checkIndependentWindowKeys(void) {
    NSWindow *first = [[NSWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(240, 120))
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [first setReleasedWhenClosed:NO];
    NSWindow *second = [[NSWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(240, 120))
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [second setReleasedWhenClosed:NO];
    WKWebView *firstView = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 240, 120)];
    WKWebView *secondView = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 240, 120)];
    first.contentView = firstView;
    second.contentView = secondView;
    NSString *html = @"<input id='field'><script>window.keys=[];"
        "addEventListener('keydown',e=>keys.push(e.key),true);</script>";
    // The second window records the received key 200 ms late and then sends the event recorded. WebContent processes delivered
    // keys asynchronously, so the check waits for that processing before judging. This delay reproduces processing delayed by load.
    NSString *late = @"<input id='field'><script>window.keys=[];"
        "addEventListener('keydown',e=>{const key=e.key;setTimeout(()=>{keys.push(key);dispatchEvent(new Event('recorded'));},200);},true);"
        "</script>";
    loadPage(firstView, html);
    loadPage(secondView, late);
    [first orderBack:nil];
    [second orderBack:nil];
    awaitLoad(firstView);
    awaitLoad(secondView);

    check(sp_input_pointer(first, 20, 20, 1, 0, 0, 0) == SP_INPUT_DELIVERED &&
        sp_input_pointer(first, 20, 20, 3, 0, 0, 0) == SP_INPUT_DELIVERED,
        @"first window receives its focus click");
    check(sp_input_pointer(second, 20, 20, 1, 0, 0, 0) == SP_INPUT_DELIVERED &&
        sp_input_pointer(second, 20, 20, 3, 0, 0, 0) == SP_INPUT_DELIVERED,
        @"second window receives its focus click");
    drain(firstView);
    drain(secondView);
    check((sp_input_key(first, "a", "a", 0, true) == SP_INPUT_DELIVERED) && (sp_input_key(first, "a", "a", 0, false) == SP_INPUT_DELIVERED),
        @"a key is delivered to the first window target");
    check((sp_input_key(second, "Escape", NULL, 0, true) == SP_INPUT_DELIVERED) && (sp_input_key(second, "Escape", NULL, 0, false) == SP_INPUT_DELIVERED),
        @"Escape is delivered to the second window target");
    awaitPage(firstView, @"the field of the first window takes the text a", @"input",
        @"document.getElementById('field').value === 'a'");
    check([evaluate(firstView, @"document.getElementById('field').value") isEqual:@"a"],
        @"the first window keeps its input");
    // Waits until both windows have processed the key, then judges, and keeps the received key.
    awaitPage(secondView, @"the second window records its key", @"recorded", @"keys.length > 0");
    NSArray *firstKeys = evaluate(firstView, @"keys");
    NSArray *secondKeys = evaluate(secondView, @"keys");
    check([secondKeys isEqual:@[@"Escape"]],
        [NSString stringWithFormat:@"the second window receives only its own Escape (first %@, second %@)",
            [firstKeys componentsJoinedByString:@","], [secondKeys componentsJoinedByString:@","]]);
    check([evaluate(firstView, @"keys") isEqual:@[@"a"]],
        @"the first window does not receive the second window's Escape");
    [first close];
    [second close];
    [first release];
    [second release];
}

// A press and a release carry the click count of a person's click, and the second press of a double click makes the page's dblclick.
@interface SPClickRecorder : NSView
@property(nonatomic) NSInteger downCount;
@property(nonatomic) NSInteger upCount;
@end
@implementation SPClickRecorder
- (void)mouseDown:(NSEvent *)event { self.downCount = event.clickCount; }
- (void)mouseUp:(NSEvent *)event { self.upCount = event.clickCount; }
@end

static void checkClickCount(void) {
    NSWindow *window = [[[NSWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(300, 200))
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO] autorelease];
    [window setReleasedWhenClosed:NO];
    SPClickRecorder *recorder = [[[SPClickRecorder alloc] initWithFrame:NSMakeRect(0, 0, 300, 200)] autorelease];
    window.contentView = recorder;
    [window orderBack:nil];
    check(sp_input_pointer(window, 20, 20, 1, 0, 0, 0) == SP_INPUT_DELIVERED && sp_input_pointer(window, 20, 20, 3, 0, 0, 0) == SP_INPUT_DELIVERED,
        @"a click without a count is delivered");
    check(recorder.downCount == 1 && recorder.upCount == 1, @"a click without a count has the click count 1");
    check(sp_input_pointer_clicks(window, 20, 20, 1, 0, 2) == SP_INPUT_DELIVERED && sp_input_pointer_clicks(window, 20, 20, 3, 0, 2) == SP_INPUT_DELIVERED,
        @"a second press with the count 2 is delivered");
    check(recorder.downCount == 2 && recorder.upCount == 2,
        [NSString stringWithFormat:@"the press and the release have the click count 2 (got %ld and %ld)", (long)recorder.downCount, (long)recorder.upCount]);
    recorder.downCount = 0;
    const int outside[] = {0, -1, SP_INPUT_CLICKS_MAX + 1};
    for (size_t index = 0; index < sizeof outside / sizeof outside[0]; index++) {
        check(sp_input_pointer_clicks(window, 20, 20, 1, 0, outside[index]) == SP_INPUT_REJECTED, @"a click count out of range is rejected");
    }
    check(recorder.downCount == 0, @"a rejected click count delivers no press");
    check(sp_input_pointer(window, 20, 20, 1, 0, 0, 0) == SP_INPUT_DELIVERED && sp_input_pointer(window, 20, 20, 3, 0, 0, 0) == SP_INPUT_DELIVERED,
        @"a rejected click count leaves no press open");

    WKWebView *view = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 300, 200)] autorelease];
    window.contentView = view;
    loadPage(view, @"<!doctype html><body style='margin:0;height:200px'><script>window.probe={double:0,detail:0};"
        "addEventListener('dblclick',e=>{probe.double++;probe.detail=e.detail},true);window.ready=true;</script>");
    awaitLoad(view);
    pointerOutside(window);
    check(sp_input_pointer_clicks(window, 50, 50, 1, 0, 1) == SP_INPUT_DELIVERED && sp_input_pointer_clicks(window, 50, 50, 3, 0, 1) == SP_INPUT_DELIVERED
        && sp_input_pointer_clicks(window, 50, 50, 1, 0, 2) == SP_INPUT_DELIVERED && sp_input_pointer_clicks(window, 50, 50, 3, 0, 2) == SP_INPUT_DELIVERED,
        @"the presses of a double click are delivered to the page");
    awaitPage(view, @"the page receives the dblclick", @"dblclick", @"probe.double > 0");
    check([evaluate(view, @"probe.double") unsignedIntegerValue] == 1 && [evaluate(view, @"probe.detail") unsignedIntegerValue] == 2,
        @"the second press with the count 2 makes one dblclick with the detail 2");
    [window close];
}

// A page reads the pressed buttons of a gesture from the event. WebKit takes them from +[NSEvent pressedMouseButtons], so
// a press delivered to the view must be visible there for the page to see a person's drag. focused delivers through the
// input method of a focused field, which passes the event to WebKit later.
static void checkButtonsReachPage(BOOL focused) {
    NSWindow *window = [[[NSWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(300, 200))
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO] autorelease];
    [window setReleasedWhenClosed:NO];
    WKWebView *view = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 300, 200)] autorelease];
    window.contentView = view;
    loadPage(view, @"<!doctype html><body style='margin:0;height:200px'><input id=field style='position:absolute;left:0;top:150px'><script>window.seen={};"
        "for (const type of ['pointerdown','mousedown','pointermove','mousemove','pointerup','mouseup'])"
        "addEventListener(type,e=>{(seen[type]=seen[type]||[]).push(e.buttons)},true);window.ready=true;</script>");
    awaitLoad(view);
    [window orderBack:nil];
    pointerOutside(window);
    if (focused) {
        check(sp_input_pointer(window, 20, 160, 1, 0, 0, 0) == SP_INPUT_DELIVERED && sp_input_pointer(window, 20, 160, 3, 0, 0, 0) == SP_INPUT_DELIVERED,
            @"a press focuses the field");
        drain(view);
        awaitPage(view, @"the field takes the focus", @"focus", @"document.activeElement && document.activeElement.id === 'field'");
        evaluate(view, @"seen={}; null");
    }
    NSString *mode = focused ? @"with a focused field" : @"without a focused field";
    // The input method of a focused field passes each event to WebKit later, so the next step waits for the page like a person's hand.
    check(sp_input_pointer(window, 50, 50, 1, 0, 0, 0) == SP_INPUT_DELIVERED, @"the press of a drag is delivered");
    awaitPage(view, @"the page receives the mousedown", @"mousedown", @"(seen.mousedown||[]).length > 0");
    check((NSEvent.pressedMouseButtons & 1) != 0 && sp_input_physical_buttons() == 0,
        @"an open press is in the mask of AppKit that WebKit reads and not in the mask of a person");
    check(sp_input_pointer(window, 90, 50, 2, 0, 0, 0) == SP_INPUT_DELIVERED, @"the drag is delivered");
    awaitPage(view, @"the page receives the mousemove", @"mousemove", @"(seen.mousemove||[]).length > 0");
    check(sp_input_pointer(window, 90, 50, 3, 0, 0, 0) == SP_INPUT_DELIVERED, @"the release of a drag is delivered");
    check(NSEvent.pressedMouseButtons == sp_input_physical_buttons(), @"a release takes the button out of the mask");
    awaitPage(view, @"the page receives the mouseup", @"mouseup", @"(seen.mouseup||[]).length > 0");
    NSString *seen = evaluate(view, @"JSON.stringify(seen)");
    fprintf(stdout, "measured %s: mask after the release %lu, page %s\n", mode.UTF8String, (unsigned long)NSEvent.pressedMouseButtons, seen.UTF8String);
    NSDictionary *events = [NSJSONSerialization JSONObjectWithData:[seen dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    for (NSString *type in @[@"pointerdown", @"mousedown", @"pointermove", @"mousemove"]) {
        check([[events[type] lastObject] integerValue] == 1,
            [NSString stringWithFormat:@"%@: %@ has the left button in e.buttons (got %@)", mode, type, events[type]]);
    }
    for (NSString *type in @[@"pointerup", @"mouseup"]) {
        check([[events[type] lastObject] integerValue] == 0,
            [NSString stringWithFormat:@"%@: %@ has no button in e.buttons (got %@)", mode, type, events[type]]);
    }
    [window close];
}

static IMP pressedButtonsImplementation(void) {
    return method_getImplementation(class_getClassMethod(NSEvent.class, @selector(pressedMouseButtons)));
}

// A right press has its own bit, a pointer holds one press of a button in any window, and a window that goes away ends its press.
static void checkButtonsByWindow(void) {
    NSWindow *first = [[[NSWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(200, 100))
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO] autorelease];
    [first setReleasedWhenClosed:NO];
    first.contentView = [[[SPPointerTarget alloc] initWithFrame:NSMakeRect(0, 0, 200, 100)] autorelease];
    [first orderBack:nil];
    NSWindow *second = nil;
    check(sp_input_pointer(first, 20, 20, 1, 1, 0, 0) == SP_INPUT_DELIVERED && NSEvent.pressedMouseButtons == 2,
        @"a right press has the bit of the right button");
    @autoreleasepool {
        second = [[NSWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(200, 100))
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        [second setReleasedWhenClosed:NO];
        second.contentView = [[[SPPointerTarget alloc] initWithFrame:NSMakeRect(0, 0, 200, 100)] autorelease];
        [second orderBack:nil];
        check(sp_input_pointer(second, 20, 20, 1, 1, 0, 0) == SP_INPUT_PRESS_OPEN,
            @"a press of a button whose press the pointer holds in another window answers press open");
        check(sp_input_pointer(first, 20, 20, 3, 1, 0, 0) == SP_INPUT_DELIVERED && sp_input_pointer(second, 20, 20, 1, 1, 0, 0) == SP_INPUT_DELIVERED
            && sp_input_pointer(second, 20, 20, 1, 0, 0, 0) == SP_INPUT_DELIVERED && NSEvent.pressedMouseButtons == 3,
            @"after the release the pointer presses both buttons in the second window");
        // A window off the screen is not held by the list of windows, so the release lets it go.
        [second orderOut:nil];
        [second release];
    }
    eventWait(@"the released window ends its open presses", ^BOOL { return NSEvent.pressedMouseButtons == 0; });
    check(NSEvent.pressedMouseButtons == 0, @"a window that goes away ends its open presses");
    check(sp_input_pointer(first, 20, 20, 1, 1, 0, 0) == SP_INPUT_DELIVERED && sp_input_pointer(first, 20, 20, 3, 1, 0, 0) == SP_INPUT_DELIVERED
        && NSEvent.pressedMouseButtons == 0, @"the pointer presses again after the window went away, and the last release leaves no button");
}

// A key of an application that is not really active passes no -[NSApplication sendEvent:], which drops it and leaves no trace, also
// when the application names the window as its key window.
@interface SPKeyView : NSView
@property(nonatomic) NSUInteger keys;
@end
@implementation SPKeyView
- (BOOL)acceptsFirstResponder { return YES; }
- (void)keyDown:(NSEvent *)event { self.keys++; }
@end
static NSWindow *namedKeyWindow;
static NSWindow *(*appKitKeyWindow)(id, SEL);
static NSWindow *keyWindowWithNamed(id self, SEL selector) { return namedKeyWindow ?: appKitKeyWindow(self, selector); }
static void checkKeyOfInactiveApplicationArrives(void) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(240, 120))
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    SPKeyView *view = [[[SPKeyView alloc] initWithFrame:NSMakeRect(0, 0, 240, 120)] autorelease];
    window.contentView = view;
    [window orderBack:nil];
    [window makeFirstResponder:view];
    namedKeyWindow = window;
    check(sp_input_key(window, "a", "a", 0, true) == SP_INPUT_DELIVERED, @"a key of a named key window of an inactive application answers delivered");
    check(view.keys == 1, [NSString stringWithFormat:@"a key that answers delivered reaches the first responder (%lu)", (unsigned long)view.keys]);
    sp_input_key(window, "a", "a", 0, false);
    namedKeyWindow = nil;
    [window close];
    [window release];
}

int main(void) { @autoreleasepool {
    method_setImplementation(class_getInstanceMethod(NSApplication.class, @selector(isActive)), (IMP)testIsActive);
    appKitKeyWindow = (NSWindow *(*)(id, SEL))method_setImplementation(
        class_getInstanceMethod(NSApplication.class, @selector(keyWindow)), (IMP)keyWindowWithNamed);
    IMP appKitButtons = pressedButtonsImplementation();
    check(sp_input_pointer(NULL, 0, 0, 1, 0, 0, 0) == SP_INPUT_REJECTED && pressedButtonsImplementation() == appKitButtons,
        @"a press that is not delivered leaves the buttons to AppKit");
    // The records that this test reads include events below the level error, which the default policy refuses (docs/spec/logging.md#policy):
    // the policy that stores every level is set here, and the default policy is tested in event_ring_test.
    const int8_t everything[SP_CLASS_COUNT] = {SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE};
    check(sp_event_set_policy(everything), @"the policy stores every level of every class");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    checkKeyOfInactiveApplicationArrives();
    checkActivityWaitAggregation();
    checkActivityWaitDelayedRegistration();
    checkActivityWaitRegistrationEnd();
    checkHiddenWindowRefusesPointer();
    checkPointerTargetAcrossViews();
    checkMoveReachesEveryOwner();
    check(pressedButtonsImplementation() != appKitButtons, @"a delivered press shows its button to WebKit");
    checkKeyWindowPressPassesApplication();
    NSWindow *window = [[NSWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(400, 300))
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.acceptsMouseMovedEvents = YES;
    WKWebView *view = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)];
    window.contentView = view;
    NSString *html = @"<!doctype html><style>html,body{margin:0;width:100%;height:100%}</style>"
        "<input id='field' style='position:absolute;left:10px;top:10px;width:200px'>"
        "<button id='button' style='position:absolute;left:10px;top:40px'>button</button>"
        "<div id='pad' style='position:absolute;left:0;top:60px;width:400px;height:240px;overflow:auto'>"
        "<div style='height:2000px'></div></div><script>"
        "window.probe={events:[]}; window.buttonClicks=0; button.addEventListener('click',()=>buttonClicks++);"
        "for (const type of ['pointerdown','pointerup','pointermove','click','wheel','keydown','input'])"
        " addEventListener(type,e=>probe.events.push({type,trusted:e.isTrusted,x:e.clientX,y:e.clientY,key:e.key,code:e.code}),true);"
        "</script>";
    loadPage(view, html);
    [window orderBack:nil];
    awaitLoad(view);
    __block BOOL painted = NO;
    [view _doAfterNextPresentationUpdate:^{ painted = YES; }];
    eventWait(@"the next presentation of the page", ^BOOL { return painted; });

    evaluate(view, @"probe.events.length=0; null");
    pointerOutside(window);
    check(sp_input_pointer(window, 150, 100, 1, 0, 0, 0) == SP_INPUT_DELIVERED, @"press delivered");
    check(sp_input_pointer(window, 160, 155, 2, 0, 0, 0) == SP_INPUT_DELIVERED, @"drag delivered");
    check(sp_input_pointer(window, 160, 155, 3, 0, 0, 0) == SP_INPUT_DELIVERED, @"release delivered");
    drain(view);
    pointerOutside(window);
    NSArray *pointer = evaluate(view, @"probe.events.filter(e=>e.type.startsWith('pointer')||e.type==='click')");
    NSArray *types = [pointer valueForKey:@"type"];
    check([types containsObject:@"pointerdown"] && [types containsObject:@"pointerup"] && [types containsObject:@"click"],
        [NSString stringWithFormat:@"pointer sequence reaches the page: %@", [types componentsJoinedByString:@","]]);
    check(![[pointer valueForKey:@"trusted"] containsObject:@NO], @"pointer events are trusted");
    NSDictionary *down = nil;
    for (NSDictionary *event in pointer) if ([event[@"type"] isEqual:@"pointerdown"]) { down = event; break; }
    check(down && [down[@"x"] doubleValue] == 150 && [down[@"y"] doubleValue] == 100,
        [NSString stringWithFormat:@"pointer coordinates are CSS pixels from the top left: %@", down]);

    evaluate(view, @"probe.events.length=0; null");
    check(sp_input_pointer(window, 100, 200, 4, 0, 0, 120) == SP_INPUT_DELIVERED, @"scroll delivered");
    drain(view);
    awaitPage(view, @"the page receives the wheel event", @"wheel", @"probe.events.filter(e=>e.type==='wheel').length > 0");
    NSArray *wheel = evaluate(view, @"probe.events.filter(e=>e.type==='wheel')");
    check(wheel.count > 0 && ![[wheel valueForKey:@"trusted"] containsObject:@NO],
        [NSString stringWithFormat:@"scroll reaches the page as a trusted wheel event (%lu)", (unsigned long)wheel.count]);
    awaitPage(view, @"the element under the point scrolls", @"scroll", @"document.getElementById('pad').scrollTop > 0");
    check([evaluate(view, @"document.getElementById('pad').scrollTop") doubleValue] == 120, @"scroll moves the element under the point by the requested 120 pixels");

    check(sp_input_pointer(window, 50, 20, 1, 0, 0, 0) == SP_INPUT_DELIVERED && sp_input_pointer(window, 50, 20, 3, 0, 0, 0) == SP_INPUT_DELIVERED, @"field click delivered");
    drain(view);
    check([evaluate(view, @"document.activeElement && document.activeElement.id") isEqual:@"field"], @"a click focuses the field in an inactive window");
    evaluate(view, @"probe.events.length=0; null");
    check((sp_input_key(window, "a", "a", 0, true) == SP_INPUT_DELIVERED) && (sp_input_key(window, "a", "a", 0, false) == SP_INPUT_DELIVERED), @"explicit text key accepted");
    check((sp_input_key(window, "Enter", NULL, 0, true) == SP_INPUT_DELIVERED) && (sp_input_key(window, "Enter", NULL, 0, false) == SP_INPUT_DELIVERED), @"named key accepted");
    check(sp_input_key(window, "NoSuchKey", NULL, 0, true) == SP_INPUT_REJECTED, @"unknown key name rejected");
    // Every injected input leaves a record with its arguments, its result and the reason of a refusal.
    {
        // A window of its own receives these, so no page of the other checks sees them.
        NSWindow *recorded = [[[NSWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(120, 80))
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO] autorelease];
        recorded.releasedWhenClosed = NO;
        [recorded orderBack:nil];
        NSString *records = capturedRecords(^{
            sp_input_key(recorded, "NoSuchKey", NULL, 0, true);
            sp_input_key(recorded, "Escape", NULL, 1, true);
            sp_input_key(recorded, "Escape", NULL, 1, false);
            sp_input_pointer(recorded, 10, 10, 2, 0, 0, 0);
        });
        check(hasRecord(records, @[@"\"kind\":\"key\"", @"\"key\":\"NoSuchKey\"", @"\"result\":\"rejected\"", @"\"reason\":\"unknown key name\""]),
            [NSString stringWithFormat:@"a rejected key is recorded with its reason (got %@)", records]);
        check(hasRecord(records, @[@"\"kind\":\"key\"", @"\"key\":\"Escape\"", @"\"text\":null", @"\"modifiers\":1", @"\"down\":true", @"\"result\":\"delivered\""]),
            [NSString stringWithFormat:@"a delivered key is recorded with its arguments (got %@)", records]);
        check(hasRecord(records, @[@"\"kind\":\"key\"", @"\"key\":\"Escape\"", @"\"responder\":"]),
            [NSString stringWithFormat:@"a key record names the first responder that receives the key (got %@)", records]);
        check(hasRecord(records, @[@"\"kind\":\"pointer\"", @"\"pointer\":\"main\"", @"\"phase\":2", @"\"result\":\"rejected\"", @"\"reason\":\"no open press of the pointer and button in the window\""]),
            [NSString stringWithFormat:@"a rejected pointer input is recorded with its reason (got %@)", records]);
        [recorded orderOut:nil];
    }
    awaitPage(view, @"the page receives both keydown events", @"keydown", @"probe.events.filter(e=>e.type==='keydown').length >= 2");
    NSArray *keysSeen = evaluate(view, @"probe.events.filter(e=>e.type==='keydown').map(e=>e.key)");
    check([keysSeen isEqual:@[@"a", @"Enter"]],
        [NSString stringWithFormat:@"keys reach the focused field in a window that is not key: %@", keysSeen]);
    check([evaluate(view, @"document.getElementById('field').value") isEqual:@"a"], @"text input reaches the field");

    evaluate(view, @"probe.events.length=0; null");
    sp_input_result equalDown = sp_input_key(window, "=", NULL, 0, true);
    sp_input_result equalUp = sp_input_key(window, "=", NULL, 0, false);
    check(equalDown == SP_INPUT_DELIVERED && equalUp == SP_INPUT_DELIVERED,
        @"the equal character is delivered through its physical ANSI key");
    if (equalDown == SP_INPUT_DELIVERED && equalUp == SP_INPUT_DELIVERED) {
        awaitPage(view, @"the page receives the keydown", @"keydown", @"probe.events.filter(e=>e.type==='keydown').length >= 1");
        NSArray *equalKey = evaluate(view, @"probe.events.filter(e=>e.type==='keydown').map(e=>({key:e.key,code:e.code}))");
        check([equalKey isEqual:@[@{@"key": @"=", @"code": @"Equal"}]],
            [NSString stringWithFormat:@"the equal character keeps its physical ANSI key identity: %@", equalKey]);
    }

    evaluate(view, @"probe.events.length=0; null");
    sp_input_result minusDown = sp_input_key(window, "-", NULL, 0, true);
    sp_input_result minusUp = sp_input_key(window, "-", NULL, 0, false);
    check(minusDown == SP_INPUT_DELIVERED && minusUp == SP_INPUT_DELIVERED,
        @"the minus character is delivered through its physical ANSI key");
    if (minusDown == SP_INPUT_DELIVERED && minusUp == SP_INPUT_DELIVERED) {
        awaitPage(view, @"the page receives the keydown", @"keydown", @"probe.events.filter(e=>e.type==='keydown').length >= 1");
        NSArray *minusKey = evaluate(view, @"probe.events.filter(e=>e.type==='keydown').map(e=>({key:e.key,code:e.code}))");
        check([minusKey isEqual:@[@{@"key": @"-", @"code": @"Minus"}]],
            [NSString stringWithFormat:@"the minus character keeps its physical ANSI key identity: %@", minusKey]);
    }

    // Focused input can leave WebKit work in the queue. The next native click must
    // still deliver down before up and synthesize exactly one DOM click.
    SPReceipt buttonDown = pointerThen(window, view, 50, 50, 1);
    SPReceipt buttonUp = pointerThen(window, view, 50, 50, 3);
    check(buttonDown.result == SP_INPUT_DELIVERED && buttonUp.result == SP_INPUT_DELIVERED,
        @"a click after keyboard input receives both pointer phases");
    drain(view);
    check([evaluate(view, @"window.buttonClicks") unsignedIntegerValue] == 1,
        @"a click after keyboard input synthesizes one DOM click");

    // When another web view in the window is pressed, that web view receives key input as in AppKit.
    WKWebView *child = [[WKWebView alloc] initWithFrame:NSMakeRect(220, 0, 180, 50)];
    [view addSubview:child];
    loadPage(child, @"<!doctype html><input id='other' style='width:160px'><script>window.ready=true</script>");
    awaitLoad(child);
    // WKWebView has a flipped coordinate system, so the frame of a subview is relative to the top left of the content area.
    check(sp_input_pointer(window, 300, 20, 1, 0, 0, 0) == SP_INPUT_DELIVERED && sp_input_pointer(window, 300, 20, 3, 0, 0, 0) == SP_INPUT_DELIVERED,
        @"child webview click delivered");
    drain(child);
    check(window.firstResponder == child || [(NSView *)window.firstResponder isDescendantOf:child],
        @"pressing a webview makes it the first responder");
    NSString *childActiveElement = [evaluate(child, @"document.activeElement && document.activeElement.id") description];
    check([childActiveElement isEqual:@"other"],
        [NSString stringWithFormat:@"child page remains responsive and focuses its input after click (got %@)", childActiveElement]);
    // In the focus routing check of the child web view, English b is specified without input source conversion.
    check((sp_input_key(window, "b", "b", 0, true) == SP_INPUT_DELIVERED) && (sp_input_key(window, "b", "b", 0, false) == SP_INPUT_DELIVERED), @"key after child click accepted");
    awaitPage(child, @"the field of the pressed webview takes the text b", @"input", @"document.getElementById('other').value === 'b'");
    check([evaluate(child, @"document.getElementById('other').value") isEqual:@"b"], @"keys reach the pressed webview");
    check([evaluate(view, @"document.getElementById('field').value") isEqual:@"a"], @"the previous webview keeps its text");
    [child release];

    check(!sp_input_virtual_real_active(), @"application stays inactive");
    check(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != getpid(), @"this process did not become the frontmost application");
    [window close];
    checkIndependentWindowKeys();
    checkReceipts();
    checkPointerQueue();
    checkClickCount();
    checkButtonsReachPage(NO);
    checkButtonsReachPage(YES);
    checkButtonsByWindow();
    return failures ? 1 : 0;
}}
