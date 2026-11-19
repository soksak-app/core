// The layout observer reports where the transaction of a window starts and ends, and a settled wait takes the block that
// brings the content of the window to the screen. Only the window of the press check is put on screen.
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <WebKit/WebKit.h>
#import "private/coregraphics.h"
#import "private/webkit.h"
#import "surface_layout.h"
#import "host_api_webview.h"
#import "main_thread.h"
#import "support/event_wait.h"

static int failures;

static void check(BOOL ok, NSString *message) {
    fprintf(ok ? stdout : stderr, "%s: %s\n", ok ? "PASS" : "FAIL", message.UTF8String);
    if (!ok) failures++;
}

// A web view that holds the completion of its next presentation until the check releases it.
@interface SPHeldPresentation : WKWebView
@property(nonatomic, copy) void (^held)(void);
@end
@implementation SPHeldPresentation
- (void)_doAfterNextPresentationUpdate:(void (^)(void))completion { self.held = completion; }
- (void)dealloc { [_held release]; [super dealloc]; }
@end

static NSString *const transactionMarker = @"soksak.layout-observe";
static NSMutableArray<NSString *> *events;
static void *firstWindow;
static void *secondWindow;
static void *thirdWindow;
static BOOL endedInOpenTransaction;

static NSString *nameOf(void *window) { return window == firstWindow ? @"first" : window == secondWindow ? @"second" : window == thirdWindow ? @"third" : @"other"; }
static void record(NSString *event, void *window) { [events addObject:[NSString stringWithFormat:@"%@ %@", event, nameOf(window)]]; }

static NSString *recorded(void) {
    NSString *text = [events componentsJoinedByString:@", "];
    [events removeAllObjects];
    return text;
}

// Each ready of the check marks the Core Animation transaction, and a value of a transaction ends with its commit.
static void (^readyRecorder(void *window))(int) {
    return [[^(int allowed) {
        [events addObject:[NSString stringWithFormat:@"ready%@ %@", allowed ? @"" : @" refused", nameOf(window)]];
        if (allowed) [CATransaction setValue:@YES forKey:transactionMarker];
    } copy] autorelease];
}

static void checkStartedPrecedesReady(void) {
    surfaceLayoutBegin(firstWindow, 1, readyRecorder(firstWindow));
    check([CATransaction valueForKey:transactionMarker] != nil, @"the marker is readable inside the open transaction");
    surfaceLayoutBegin(firstWindow, 2, readyRecorder(firstWindow));
    NSString *order = recorded();
    check([order isEqualToString:@"started first, ready first, started first, ready first"],
        [NSString stringWithFormat:@"started precedes ready of each preparation, a newer preparation of the same window included (%@)", order]);
    check(surfaceLayoutCommit(firstWindow, 2), @"the newest preparation commits");
    order = recorded();
    check([order isEqualToString:@"ended first"], [NSString stringWithFormat:@"a commit ends the transaction once (%@)", order]);
    check(!endedInOpenTransaction, @"ended runs after the Core Animation transaction commits");
}

static void checkDeferredCommit(SPHeldPresentation *view) {
    surfaceLayoutBegin(firstWindow, 3, readyRecorder(firstWindow));
    surfaceLayoutBegin(secondWindow, 4, readyRecorder(secondWindow));
    __block BOOL presented = NO;
    check(surfaceLayoutJoinView(firstWindow, 3, view, ^{ presented = YES; }), @"the view joins the transaction");
    check(surfaceLayoutCommit(firstWindow, 3), @"the commit waits for the joined view");
    NSString *order = recorded();
    check([order isEqualToString:@"started first, ready first, started second, ready second"],
        [NSString stringWithFormat:@"a transaction of another window starts while a commit waits for its joined view (%@)", order]);
    check(view.held != nil, @"the join waits for the presentation of the view");
    if (view.held) view.held();
    view.held = nil;
    check(presented, @"the joined view presented");
    order = recorded();
    check([order isEqualToString:@"ended first"],
        [NSString stringWithFormat:@"ended of a deferred commit follows the joined view (%@)", order]);
    check(endedInOpenTransaction, @"the end of one transaction leaves the hold open while another window has one open");
    endedInOpenTransaction = NO;
    check(surfaceLayoutCommit(secondWindow, 4), @"the open transaction of the other window commits");
    order = recorded();
    check([order isEqualToString:@"ended second"], [NSString stringWithFormat:@"the second transaction ends (%@)", order]);
    check(!endedInOpenTransaction, @"ended of the last open transaction runs after the Core Animation hold commits");
}

static void checkCancel(void) {
    surfaceLayoutBegin(firstWindow, 5, readyRecorder(firstWindow));
    surfaceLayoutBegin(secondWindow, 6, readyRecorder(secondWindow));
    surfaceLayoutCancel(firstWindow);
    NSString *order = recorded();
    check([order isEqualToString:@"started first, ready first, started second, ready second, ended first"],
        [NSString stringWithFormat:@"a cancel ends only the transaction of its window (%@)", order]);
    endedInOpenTransaction = NO;
    surfaceLayoutCancelTicket(secondWindow, 6);
    order = recorded();
    check([order isEqualToString:@"ended second"], [NSString stringWithFormat:@"a cancel of a ticket ends its transaction (%@)", order]);
    check(!endedInOpenTransaction, @"ended of the last cancel runs after the Core Animation hold commits");
    surfaceLayoutBegin(firstWindow, 7, readyRecorder(firstWindow));
    surfaceLayoutBegin(secondWindow, 8, readyRecorder(secondWindow));
    surfaceLayoutCancel(secondWindow);
    order = recorded();
    check([order isEqualToString:@"started first, ready first, started second, ready second, ended second"],
        [NSString stringWithFormat:@"a cancel of the other window ends its own transaction and leaves the open one (%@)", order]);
    check(surfaceLayoutCommit(firstWindow, 7), @"the open transaction commits");
    [events removeAllObjects];
}

static void checkSettledWithBlock(NSWindow *window) {
    check(window.screen != nil, @"the window of the settled check lies on a screen, so its wait has a display refresh");
    __block int presentations = 0;
    __block void (^presented)(const char *) = nil;
    void (^present)(void (^)(const char *)) = ^(void (^callback)(const char *)) {
        presentations++;
        presented = [callback copy];
    };
    __block double displayed = 0;
    __block BOOL settled = NO;
    surfaceLayoutAfterSettled(window, present, ^(double at, const char *error) {
        check(error == NULL, @"a settled wait without a failure has no error");
        displayed = at;
        settled = YES;
    });
    check(presentations == 1 && !settled, @"the wait asks the block and does not end before the block calls back");
    double called = CACurrentMediaTime() * 1000;
    check(presented != nil, @"the wait asked the block before the check presents it");
    if (presented) presented(NULL);
    check(!settled, @"the callback of the block does not end the wait before the next display refresh");
    eventWait(@"the settled wait ends at the next display refresh", ^BOOL { return settled; });
    check(displayed >= called, [NSString stringWithFormat:@"the wait reports the display refresh after the block called back (%f, called %f)", displayed, called]);
    [presented release];
    presented = nil;

    // The open transaction of the window and the Core Animation hold that another window keeps open both hold the wait, because
    // no change of the window reaches the screen before the hold commits.
    presentations = 0;
    settled = NO;
    surfaceLayoutBegin(firstWindow, 9, readyRecorder(firstWindow));
    surfaceLayoutBegin(window, 10, readyRecorder(window));
    surfaceLayoutAfterSettled(window, present, ^(double at, const char *error) { settled = YES; });
    check(presentations == 0, @"the wait does not ask the block while a transaction of the window is open");
    check(surfaceLayoutCommit(window, 10), @"the transaction of the window commits while another window holds the hold");
    check(presentations == 0, @"the wait does not ask the block while the hold of another window is open");
    check(surfaceLayoutCommit(firstWindow, 9), @"the transaction of the other window commits");
    check(presentations == 1, @"the wait asks the block when the hold commits");

    // A transaction that opens while the block presents starts the wait again.
    surfaceLayoutBegin(window, 11, readyRecorder(window));
    check(presented != nil, @"the wait asked the block before the check presents it");
    if (presented) presented(NULL);
    [presented release];
    presented = nil;
    check(presentations == 1 && !settled, @"the wait does not end while a newer transaction of the window is open");
    check(surfaceLayoutCommit(window, 11), @"the newer transaction commits");
    check(presentations == 2, @"the end of the newer transaction asks the block again");
    BOOL askedAgain = presented != nil;
    check(askedAgain, @"the wait asked the block before the check presents it");
    if (presented) presented(NULL);
    [presented release];
    presented = nil;
    if (askedAgain) eventWait(@"the settled wait ends after the block presents the newer transaction", ^BOOL { return settled; });
    surfaceLayoutCancel(firstWindow);
    surfaceLayoutCancel(window);

    __block const char *failure = NULL;
    surfaceLayoutAfterSettled(window, ^(void (^callback)(const char *)) { callback("the frame failed"); },
        ^(double at, const char *error) { failure = strdup(error); });
    check(failure != NULL && strcmp(failure, "the frame failed") == 0, @"a failure of the block ends the wait with that failure");
    free((void *)failure);

    failure = NULL;
    surfaceLayoutAfterSettled(NULL, present, ^(double at, const char *error) { failure = strdup(error); });
    check(failure != NULL && strstr(failure, "window") != NULL, @"a wait without a window reports its cause");
    free((void *)failure);
    failure = NULL;
    surfaceLayoutAfterSettled(window, NULL, ^(double at, const char *error) { failure = strdup(error); });
    check(failure != NULL && strstr(failure, "presentation") != NULL, @"a wait without a block reports its cause");
    free((void *)failure);
    [events removeAllObjects];
}


// The close of a window ends its open transaction and refuses its waiting preparation in the turn of the close, so a window that
// closes leaves no transaction behind (docs/spec/native-surfaces.md#layout-transaction).
static void checkWindowCloseEnds(NSWindow *third, SPHeldPresentation *view) {
    surfaceLayoutBegin(thirdWindow, 31, readyRecorder(thirdWindow));
    check(surfaceLayoutJoinView(thirdWindow, 31, view, ^{}), @"the view of the closing window joins its transaction");
    check(surfaceLayoutCommit(thirdWindow, 31), @"the commit of the closing window waits for its joined view");
    surfaceLayoutBegin(thirdWindow, 32, readyRecorder(thirdWindow));
    surfaceLayoutBegin(firstWindow, 33, readyRecorder(firstWindow));
    [events removeAllObjects];
    [third close];
    NSString *order = recorded();
    check([order isEqualToString:@"ready refused third, ended third"],
        [NSString stringWithFormat:@"the close of a window refuses its waiting preparation and ends its transaction (%@)", order]);
    check(surfaceLayoutViewJoinCount(thirdWindow) == 0, @"the close of a window leaves no joined view of it");
    check(!surfaceLayoutIsPreparing(thirdWindow), @"a closed window has no open preparation");
    check(surfaceLayoutCommit(firstWindow, 33), @"the transaction of the other window commits after the close");
    [events removeAllObjects];
}

// The native close of a joined view ends its join in the turn of the close, so the deferred commit finishes.
static void checkViewCloseEndsJoin(SPHeldPresentation *view) {
    __block BOOL presented = NO;
    surfaceLayoutBegin(firstWindow, 41, readyRecorder(firstWindow));
    check(surfaceLayoutJoinView(firstWindow, 41, view, ^{ presented = YES; }), @"the closing view joins the transaction");
    check(surfaceLayoutCommit(firstWindow, 41), @"the commit waits for the closing view");
    [events removeAllObjects];
    [view retain];
    nativeWebviewClose(view);
    NSString *order = recorded();
    check([order isEqualToString:@"ended first"],
        [NSString stringWithFormat:@"the native close of a joined view ends the deferred commit (%@)", order]);
    check(surfaceLayoutViewJoinCount(firstWindow) == 0, @"the closed view leaves no join");
    check(!presented, @"a closed view reports no presentation");
    [events removeAllObjects];
}

// A view whose hit test gives no target while its window prepares, as a surface host does.
@interface SPGateView : NSView
@end
@implementation SPGateView
- (NSView *)hitTest:(NSPoint)point {
    if (surfaceLayoutIsPreparing(self.window)) return nil;
    return [super hitTest:point];
}
@end

// Runs the event queue until a marker event posted at its end comes back, so every event queued before the marker has run.
static void runQueue(void) {
    [NSApp postEvent:[NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0 timestamp:0
        windowNumber:0 context:nil subtype:0x7f18 data1:0 data2:0] atStart:NO];
    for (;;) {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate distantFuture] inMode:NSDefaultRunLoopMode
            dequeue:YES];
        if (event.type == NSEventTypeApplicationDefined && event.subtype == 0x7f18) return;
        [NSApp sendEvent:event];
    }
}

// The input that the transaction holds keeps only the content of its window: the title bar and a key with the Command modifier
// pass at once. The input that the end gives back returns without a turn that must arrive: a call whose turn the queue discards
// runs once, and the window takes input again (docs/spec/native-surfaces.md#placement-sequence).
static void checkHeldInputEnds(void) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 300, 200, 100) styleMask:NSWindowStyleMaskTitled
        backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    SPGateView *gate = [[[SPGateView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:gate];
    NSPoint inside = NSMakePoint(50, 50);
    __block int first = 0, second = 0, later = 0;
    surfaceLayoutBegin(window, 51, ^(int allowed) {});
    check(surfaceLayoutHoldCall(window, true, inside.x, inside.y, ^{ first++; }), @"a press without a target waits for the transaction");
    __block int seen = 0;
    id monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown | NSEventMaskKeyDown
        handler:^NSEvent *(NSEvent *event) { seen++; return nil; }];
    NSPoint titlebar = NSMakePoint(50, window.contentView.frame.size.height + 8);
    [NSApp sendEvent:[NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:titlebar modifierFlags:0 timestamp:0
        windowNumber:window.windowNumber context:nil eventNumber:1 clickCount:1 pressure:1]];
    check(seen == 1, @"a press on the title bar passes the input that the transaction holds");
    [NSApp sendEvent:[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:NSEventModifierFlagCommand
        timestamp:0 windowNumber:window.windowNumber context:nil characters:@"w" charactersIgnoringModifiers:@"w" isARepeat:NO
        keyCode:13]];
    check(seen == 2, @"a key with the Command modifier passes the input that the transaction holds");
    [NSEvent removeMonitor:monitor];
    check(surfaceLayoutHoldCall(window, false, 0, 0, ^{ second++; }), @"a call waits behind the held press");
    check(surfaceLayoutCommit(window, 51), @"the transaction of the held input commits");
    [NSApp discardEventsMatchingMask:NSEventMaskAny beforeEvent:nil];
    runQueue();
    check(first == 1 && second == 1,
        [NSString stringWithFormat:@"each held call runs once when the queue discards its turn (%d, %d)", first, second]);
    // A call that is not held is the caller's to run now, so the hold runs none of it.
    check(!surfaceLayoutHoldCall(window, false, 0, 0, ^{ later++; }) && later == 0,
        @"the window takes input at once after its held input came back");
    surfaceLayoutCancel(window);
    [window close];
    [window release];
}

// A view that counts the presses it receives.
@interface SPPressView : NSView
@property(nonatomic) int presses;
@end
@implementation SPPressView
- (void)mouseDown:(NSEvent *)event { self.presses++; }
// The window of the check is not key, so the press reaches the view only when its first press counts.
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
@end

// A joined peer that never presents holds the commit until the next press of the user: the press ends the hold at once, the
// commit carries what was presented, and the press reaches its view. A drag ends nothing, and no end waits for time
// (docs/spec/native-surfaces.md#layout-transaction).
static void checkPressEndsHold(void) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 500, 200, 100) styleMask:NSWindowStyleMaskBorderless
        backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    SPPressView *target = [[[SPPressView alloc] initWithFrame:NSMakeRect(0, 0, 100, 100)] autorelease];
    [window.contentView addSubview:target];
    SPHeldPresentation *stalled = [[[SPHeldPresentation alloc] initWithFrame:NSMakeRect(100, 0, 100, 100)] autorelease];
    [window.contentView addSubview:stalled];
    // AppKit delivers a press only to a view of a window that is on the screen, so this window is put on the screen.
    [window orderFrontRegardless];
    __block BOOL presented = NO;
    surfaceLayoutBegin(window, 61, ^(int allowed) {});
    check(surfaceLayoutJoinView(window, 61, stalled, ^{ presented = YES; }), @"the stalled peer joins the transaction");
    check(surfaceLayoutCommit(window, 61), @"the commit waits for the stalled peer");
    [events removeAllObjects];
    [NSApp sendEvent:[NSEvent mouseEventWithType:NSEventTypeLeftMouseDragged location:NSMakePoint(50, 50) modifierFlags:0
        timestamp:0 windowNumber:window.windowNumber context:nil eventNumber:1 clickCount:1 pressure:1]];
    check(surfaceLayoutIsPreparing(window) && events.count == 0, @"a drag of the pointer leaves the hold standing");
    [NSApp sendEvent:[NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:NSMakePoint(50, 50) modifierFlags:0
        timestamp:0 windowNumber:window.windowNumber context:nil eventNumber:2 clickCount:1 pressure:1]];
    NSString *order = recorded();
    check([order isEqualToString:@"ended other"], [NSString stringWithFormat:@"a press ends the hold of a stalled peer at once (%@)", order]);
    check(!surfaceLayoutIsPreparing(window), @"the window has no open transaction after the press");
    check(surfaceLayoutViewJoinCount(window) == 0, @"the press abandons the join of the stalled peer");
    check(!presented, @"the stalled peer reports no presentation");
    check(!endedInOpenTransaction, @"the press commits the Core Animation hold");
    runQueue();
    check(target.presses == 1, [NSString stringWithFormat:@"the press reaches its view (%d)", target.presses]);
    stalled.held = nil;
    surfaceLayoutAbandonView(window, stalled);
    surfaceLayoutCancel(window);
    [window close];
    [window release];
}

// A scroll of the pointer at the point of the content of window, in window coordinates, as the window server gives it to the
// application.
static NSEvent *scrollAt(NSWindow *window, NSPoint point) {
    CGEventRef scroll = CGEventCreateScrollWheelEvent2(NULL, kCGScrollEventUnitPixel, 2, -4, 0, 0);
    NSPoint screen = [window convertPointToScreen:point];
    CGEventSetLocation(scroll, CGPointMake(screen.x, NSMaxY(NSScreen.screens.firstObject.frame) - screen.y));
    CGEventSetIntegerValueField(scroll, kSPEventWindowNumberField, window.windowNumber);
    CGEventSetWindowLocation(scroll, CGPointMake(point.x, NSHeight(window.frame) - point.y));
    NSEvent *event = [NSEvent eventWithCGEvent:scroll];
    CFRelease(scroll);
    return event;
}

// The moves and scrolls of the pointer reach their own subscribers through the device of the actions of the user: each move and
// each scroll that reaches -[NSApplication sendEvent:] is told once before any monitor sees it, also when the hold kept it and gave
// it back, and it is not told to the observers of presses and keys, so it ends no hold
// (docs/spec/native-surfaces.md#layout-transaction).
static void checkPointerMovesAreToldOnce(void) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 700, 200, 100) styleMask:NSWindowStyleMaskBorderless
        backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    SPGateView *gate = [[[SPGateView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:gate];
    static NSMutableArray<NSNumber *> *moves, *actions;
    static BOOL subscribed;
    if (!moves) {
        moves = [[NSMutableArray alloc] init];
        actions = [[NSMutableArray alloc] init];
    }
    [moves removeAllObjects];
    [actions removeAllObjects];
    if (!subscribed) {
        subscribed = YES;
        surfaceInputPointerObserve(^(NSEvent *event) { [moves addObject:@(event.type)]; });
        surfaceInputActionObserve(^(NSEvent *event) { [actions addObject:@(event.type)]; });
    }
    NSMutableArray<NSNumber *> *toldAtMonitor = [NSMutableArray array];
    id monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskMouseMoved | NSEventMaskScrollWheel
        handler:^NSEvent *(NSEvent *event) { [toldAtMonitor addObject:@(moves.count)]; return nil; }];
    NSPoint inside = NSMakePoint(50, 50);
    [NSApp sendEvent:[NSEvent mouseEventWithType:NSEventTypeMouseMoved location:inside modifierFlags:0 timestamp:0
        windowNumber:window.windowNumber context:nil eventNumber:1 clickCount:0 pressure:0]];
    [NSApp sendEvent:scrollAt(window, inside)];
    [NSApp sendEvent:[NSEvent mouseEventWithType:NSEventTypeLeftMouseDragged location:inside modifierFlags:0 timestamp:0
        windowNumber:window.windowNumber context:nil eventNumber:2 clickCount:1 pressure:1]];
    NSArray *want = @[@(NSEventTypeMouseMoved), @(NSEventTypeScrollWheel)];
    check([moves isEqualToArray:want], [NSString stringWithFormat:@"a move and a scroll are told to the observers of moves, a drag is not (%@)", moves]);
    check([toldAtMonitor isEqualToArray:@[@1, @2]], [NSString stringWithFormat:@"each move is told before the monitors see it (%@)", toldAtMonitor]);
    check(actions.count == 0, [NSString stringWithFormat:@"a move and a scroll are not told to the observers of presses and keys (%@)", actions]);
    [moves removeAllObjects];
    __block int held = 0;
    surfaceLayoutBegin(window, 72, ^(int allowed) {});
    check(surfaceLayoutHoldCall(window, true, inside.x, inside.y, ^{ held++; }), @"a press without a target waits for the transaction");
    [NSApp sendEvent:[NSEvent mouseEventWithType:NSEventTypeMouseMoved location:NSMakePoint(60, 50) modifierFlags:0 timestamp:1
        windowNumber:window.windowNumber context:nil eventNumber:3 clickCount:0 pressure:0]];
    [NSApp sendEvent:scrollAt(window, NSMakePoint(60, 50))];
    check(surfaceLayoutIsPreparing(window), @"a move and a scroll end no hold");
    check([moves isEqualToArray:want], [NSString stringWithFormat:@"a kept move and a kept scroll are told when they arrive (%@)", moves]);
    // A press ends the hold, waits behind the kept input and comes back with it. AppKit gives a posted event back with a location
    // that it computes again from the screen, so the told content holds no location.
    [actions removeAllObjects];
    [NSApp sendEvent:[NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:NSMakePoint(70, 50) modifierFlags:0 timestamp:2
        windowNumber:window.windowNumber context:nil eventNumber:4 clickCount:1 pressure:1]];
    check(!surfaceLayoutIsPreparing(window), @"the press ends the hold of the window");
    runQueue();
    check(held == 1, [NSString stringWithFormat:@"the held press runs once after the hold ended (%d)", held]);
    check([moves isEqualToArray:want], [NSString stringWithFormat:@"the kept move and scroll are told once, also after they came back (%@)", moves]);
    check([actions isEqualToArray:@[@(NSEventTypeLeftMouseDown)]],
        [NSString stringWithFormat:@"the press that waited behind them is told once, also after it came back (%@)", actions]);
    [NSEvent removeMonitor:monitor];
    surfaceLayoutCancel(window);
    [window close];
    [window release];
}

// The actions of the user reach every subscriber through one device at the level of the application: each press and each key
// event that reaches -[NSApplication sendEvent:], a synthetic one and a modifier change included, is told once before any monitor
// sees it, a drag is not told, and an event that the hold kept is not told again when it comes back
// (docs/spec/native-surfaces.md#layout-transaction).
static void checkActionsAreToldOnce(void) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 700, 200, 100) styleMask:NSWindowStyleMaskBorderless
        backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    SPGateView *gate = [[[SPGateView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:gate];
    static NSMutableArray<NSNumber *> *told;
    static BOOL subscribed;
    if (!told) told = [[NSMutableArray alloc] init];
    [told removeAllObjects];
    if (!subscribed) {
        subscribed = YES;
        surfaceInputActionObserve(^(NSEvent *event) { [told addObject:@(event.type)]; });
    }
    NSMutableArray<NSNumber *> *toldAtMonitor = [NSMutableArray array];
    id monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown | NSEventMaskLeftMouseDragged | NSEventMaskKeyDown
        | NSEventMaskFlagsChanged handler:^NSEvent *(NSEvent *event) { [toldAtMonitor addObject:@(told.count)]; return nil; }];
    NSPoint inside = NSMakePoint(50, 50);
    [NSApp sendEvent:[NSEvent mouseEventWithType:NSEventTypeLeftMouseDragged location:inside modifierFlags:0 timestamp:0
        windowNumber:window.windowNumber context:nil eventNumber:1 clickCount:1 pressure:1]];
    [NSApp sendEvent:[NSEvent keyEventWithType:NSEventTypeFlagsChanged location:NSZeroPoint modifierFlags:NSEventModifierFlagShift
        timestamp:0 windowNumber:window.windowNumber context:nil characters:@"" charactersIgnoringModifiers:@"" isARepeat:NO
        keyCode:56]];
    [NSApp sendEvent:[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:0
        windowNumber:window.windowNumber context:nil characters:@"a" charactersIgnoringModifiers:@"a" isARepeat:NO keyCode:0]];
    [NSApp sendEvent:[NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:inside modifierFlags:0 timestamp:0
        windowNumber:window.windowNumber context:nil eventNumber:2 clickCount:1 pressure:1]];
    NSArray *want = @[@(NSEventTypeFlagsChanged), @(NSEventTypeKeyDown), @(NSEventTypeLeftMouseDown)];
    check([told isEqualToArray:want], [NSString stringWithFormat:@"a modifier change, a key and a press are told, a drag is not (%@)", told]);
    check([toldAtMonitor isEqualToArray:@[@0, @1, @2, @3]],
        [NSString stringWithFormat:@"each action is told before the monitors see it (%@)", toldAtMonitor]);
    [told removeAllObjects];
    __block int held = 0;
    surfaceLayoutBegin(window, 71, ^(int allowed) {});
    check(surfaceLayoutHoldCall(window, true, inside.x, inside.y, ^{ held++; }), @"a press without a target waits for the transaction");
    [NSApp sendEvent:[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:0
        windowNumber:window.windowNumber context:nil characters:@"b" charactersIgnoringModifiers:@"b" isARepeat:NO keyCode:11]];
    check(!surfaceLayoutIsPreparing(window), @"the key ends the hold of the window");
    runQueue();
    check(held == 1, [NSString stringWithFormat:@"the held press runs once after the hold ended (%d)", held]);
    check([told isEqualToArray:@[@(NSEventTypeKeyDown)]],
        [NSString stringWithFormat:@"the kept key is told once, also after it came back (%@)", told]);
    [NSEvent removeMonitor:monitor];
    surfaceLayoutCancel(window);
    [window close];
    [window release];
}

// A key call that a release gives back sends its key event in its turn, while the release of its window still returns. A key
// that arrived during that return waits behind it in the hold of a newer transaction, so the event of the returned key goes on
// at once and the keys reach the window in the order they were sent (docs/spec/native-surfaces.md#keyboard-of-a-surface).
static void checkReturnedKeyKeepsItsTurn(void) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 900, 200, 100) styleMask:NSWindowStyleMaskBorderless
        backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    SPGateView *gate = [[[SPGateView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:gate];
    NSPoint inside = NSMakePoint(50, 50);
    NSMutableString *typed = [NSMutableString string];
    id monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown handler:^NSEvent *(NSEvent *event) {
        [typed appendString:event.characters];
        return nil;
    }];
    void (^key)(NSString *, unsigned short) = ^(NSString *character, unsigned short code) {
        [NSApp sendEvent:[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:0
            windowNumber:window.windowNumber context:nil characters:character charactersIgnoringModifiers:character isARepeat:NO
            keyCode:code]];
    };
    __block int pressed = 0;
    surfaceLayoutBegin(window, 81, ^(int allowed) {});
    check(surfaceLayoutHoldCall(window, true, inside.x, inside.y, ^{ pressed++; }), @"a press without a target waits for the transaction");
    check(surfaceLayoutHoldKey(window, ^{ key(@"e", 14); }, ^{}), @"a key waits behind the held press");
    check(surfaceLayoutCommit(window, 81), @"the transaction of the held press and key commits");
    // The release returns the press and the key through the queue. A newer transaction of the window opens, and a key sent now
    // waits behind the return.
    surfaceLayoutBegin(window, 82, ^(int allowed) {});
    check(surfaceLayoutHoldKey(window, ^{ key(@"b", 11); }, ^{}), @"a key sent while the release returns waits");
    runQueue();
    check(pressed == 1, [NSString stringWithFormat:@"the held press runs once (%d)", pressed]);
    check([typed isEqualToString:@"eb"], [NSString stringWithFormat:
        @"the event of a returned key goes on in its turn, ahead of a key that arrived during the return (typed %@)", typed]);
    [NSEvent removeMonitor:monitor];
    surfaceLayoutCancel(window);
    [window close];
    [window release];
}

// A key that ends the hold commits the transaction of its window, and the presentation of that ticket answers the commit once,
// also when a newer layout of the window began before the presentation asked for its commit; the cancel of such a ticket removes
// that answer (docs/spec/native-surfaces.md#layout-transaction).
static void checkInputEndedTicketCommitsAfterANewerLayout(void) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 1100, 200, 100) styleMask:NSWindowStyleMaskBorderless
        backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    void (^key)(NSString *, unsigned short) = ^(NSString *character, unsigned short code) {
        [NSApp sendEvent:[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:0
            windowNumber:window.windowNumber context:nil characters:character charactersIgnoringModifiers:character isARepeat:NO
            keyCode:code]];
    };
    surfaceLayoutBegin(window, 91, ^(int allowed) {});
    key(@"c", 8);
    check(!surfaceLayoutIsPreparing(window), @"the key ends the hold of ticket 91");
    surfaceLayoutBegin(window, 92, ^(int allowed) {});
    check(surfaceLayoutCommit(window, 91), @"the presentation of ticket 91, whose transaction the key committed, commits after ticket 92 began");
    check(!surfaceLayoutCommit(window, 91), @"the commit that the key made answers ticket 91 once");
    check(surfaceLayoutCommit(window, 92), @"the newer layout of the window commits with its own ticket");
    surfaceLayoutBegin(window, 93, ^(int allowed) {});
    key(@"d", 2);
    surfaceLayoutBegin(window, 94, ^(int allowed) {});
    surfaceLayoutCancelTicket(window, 93);
    check(!surfaceLayoutCommit(window, 93), @"a cancelled ticket whose transaction the key committed does not commit");
    check(surfaceLayoutIsPreparing(window), @"the cancel of ticket 93 leaves the transaction of ticket 94 open");
    check(surfaceLayoutCommit(window, 94), @"the newer layout commits after the cancel of the earlier ticket");
    surfaceLayoutCancel(window);
    [window close];
    [window release];
}

static void runInline(void (^call)(void)) { call(); }

// Ends every transaction that a check left open, whatever its outcome, so each check starts with no open transaction.
static void resetOwners(void) {
    if (firstWindow) surfaceLayoutCancel(firstWindow);
    if (secondWindow) surfaceLayoutCancel(secondWindow);
    if (thirdWindow) surfaceLayoutCancel(thirdWindow);
    [events removeAllObjects];
    endedInOpenTransaction = NO;
}

int main(void) { @autoreleasepool {
    hostInstallMainThread(runInline, runInline);
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    events = [[NSMutableArray alloc] init];
    NSWindow *first = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 200, 100) styleMask:NSWindowStyleMaskBorderless
        backing:NSBackingStoreBuffered defer:NO];
    first.releasedWhenClosed = NO;
    NSWindow *second = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 200, 100) styleMask:NSWindowStyleMaskBorderless
        backing:NSBackingStoreBuffered defer:NO];
    second.releasedWhenClosed = NO;
    firstWindow = first;
    secondWindow = second;
    surfaceLayoutObserve(^(void *window) { record(@"started", window); }, ^(void *window) {
        record(@"ended", window);
        if ([CATransaction valueForKey:transactionMarker] != nil) endedInOpenTransaction = YES;
    });
    checkStartedPrecedesReady();
    SPHeldPresentation *view = [[[SPHeldPresentation alloc] initWithFrame:NSMakeRect(0, 0, 100, 100)] autorelease];
    [first.contentView addSubview:view];
    resetOwners();
    checkDeferredCommit(view);
    resetOwners();
    checkCancel();
    [view removeFromSuperview];
    resetOwners();
    checkSettledWithBlock(second);
    NSWindow *third = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 200, 100) styleMask:NSWindowStyleMaskBorderless
        backing:NSBackingStoreBuffered defer:NO];
    third.releasedWhenClosed = NO;
    thirdWindow = third;
    SPHeldPresentation *thirdView = [[[SPHeldPresentation alloc] initWithFrame:NSMakeRect(0, 0, 100, 100)] autorelease];
    [third.contentView addSubview:thirdView];
    resetOwners();
    checkWindowCloseEnds(third, thirdView);
    SPHeldPresentation *closing = [[SPHeldPresentation alloc] initWithFrame:NSMakeRect(0, 0, 100, 100)];
    [first.contentView addSubview:closing];
    resetOwners();
    checkViewCloseEndsJoin(closing);
    [closing release];
    resetOwners();
    checkHeldInputEnds();
    resetOwners();
    checkPressEndsHold();
    resetOwners();
    checkActionsAreToldOnce();
    resetOwners();
    checkPointerMovesAreToldOnce();
    resetOwners();
    checkReturnedKeyKeepsItsTurn();
    resetOwners();
    checkInputEndedTicketCommitsAfterANewerLayout();
    [third release];
    [first release];
    [second release];
    return failures == 0 ? 0 : 1;
} }
