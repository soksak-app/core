// Checks that native input injection reaches the web view as a trusted event without activating the application.
//
// The window is an ordinary NSWindow and does not imitate the key window state. This is the same condition as a real application window.
#import <Cocoa/Cocoa.h>
#import "input_inject.h"
#import "input_activity_wait.h"
#import "support/records.h"
#import "event_ring.h"
#import "private/webkit.h"
#import "webview_input.h"

static int failures = 0;
static NSString *lastEvaluationScript = nil;

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
    SPInputActivityWait *timeout = activityWait(identifiers, &completionCount);
    [timeout startWithRegistration:^(NSUInteger index, NSString *identifier, sp_input_activity_member_completion completion) {
        (void)identifier;
        while (callbacks.count <= index) [callbacks addObject:[NSNull null]];
        callbacks[index] = [[completion copy] autorelease];
    }];
    ((sp_input_activity_member_completion)callbacks[0])();
    NSArray<NSString *> *unresolved = [timeout finishAtTimeout];
    check([unresolved isEqual:@[identifiers[1]]],
        [NSString stringWithFormat:@"timeout identifies only the unresolved webview (%@)", unresolved]);
    ((sp_input_activity_member_completion)callbacks[1])();
    check(completionCount == 0 && [timeout unresolvedIdentifiers].count == 0,
        @"a late webview completion cannot finish a timed out aggregate");
}

static void checkActivityWaitDelayedRegistration(void) {
    NSArray<NSString *> *identifiers = @[@"role=main view=main-view registrationIndex=0"];
    __block NSUInteger completionCount = 0;
    __block SPInputActivityWait *installed = nil;
    __block NSUInteger registrationCount = 0;
    @autoreleasepool {
        SPInputActivityWait *wait = [[SPInputActivityWait alloc]
            initWithIdentifiers:identifiers completion:^{ completionCount++; }];
        NSArray<NSString *> *timedOut = [wait finishAtTimeout];
        BOOL adopted = [wait installIfActivationPending:NO store:^(SPInputActivityWait *value) {
            installed = [value retain];
        }];
        check([timedOut isEqual:identifiers], @"timeout captures the member before delayed registration");
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
            @"a timed out wait registers no WebKit activity callbacks when its queued block runs late");
        [wait release];
    }
    [installed release];
    check(completionCount == 0, @"a delayed registration cannot invoke completion after timeout");
}

static void checkActivityWaitRegistrationTimeout(void) {
    NSString *beforeActivation = sp_input_activity_timeout_message(NO, NO, nil);
    check(beforeActivation == nil, @"a timeout before app and key activation does not report a webview-stage error");
    NSString *registrationPending = sp_input_activity_timeout_message(YES, NO, nil);
    check([registrationPending isEqualToString:@"webview activity-state registration pending at timeout"],
        [NSString stringWithFormat:@"timeout before callback registration reports its exact stage (%@)", registrationPending]);
    NSString *unresolved = sp_input_activity_timeout_message(YES, YES,
        @[@"view=document registrationIndex=1"]);
    check([unresolved containsString:@"view=document registrationIndex=1"]
        && ![unresolved containsString:@"registrationIndex=0"],
        [NSString stringWithFormat:@"registered timeout reports only actual unresolved identifiers (%@)", unresolved]);
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

static void until(BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                               beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    if (!done()) {
        fprintf(stderr, "FAIL: WebKit did not answer within 10 seconds; last JavaScript: %s\n",
            lastEvaluationScript.UTF8String ?: "none");
        exit(1);
    }
}

static id evaluate(WKWebView *view, NSString *script) {
    [lastEvaluationScript release];
    lastEvaluationScript = [script copy];
    __block BOOL done = NO;
    __block id result = nil;
    [view evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
        if (error) fprintf(stderr, "JavaScript: %s\n", error.localizedDescription.UTF8String);
        result = [value retain];
        done = YES;
    }];
    until(^BOOL { return done; });
    return [result autorelease];
}

static void drain(WKWebView *view) {
    __block BOOL done = NO;
    [view _doAfterProcessingAllPendingMouseEvents:^{ done = YES; }];
    until(^BOOL { return done; });
}

typedef struct { BOOL done; sp_input_result result; NSUInteger seen; WKWebView *view; BOOL held; } SPReceipt;

static void received(void *context, sp_input_result result, const sp_input_held *held) {
    SPReceipt *receipt = context;
    receipt->result = result;
    receipt->held = held != NULL;
    // The numbers of presses and releases that the document received at completion time. Read synchronously on the main thread.
    receipt->seen = [evaluate(receipt->view, @"probe.events.filter(e=>e.type==='pointerdown'||e.type==='pointerup').length") unsignedIntegerValue];
    receipt->done = YES;
}

typedef struct { BOOL done; sp_input_result result; NSTimeInterval started; NSTimeInterval took; } SPTimed;

static void timed(void *context, sp_input_result result, const sp_input_held *held) {
    SPTimed *state = context;
    state->result = result;
    state->took = [NSDate timeIntervalSinceReferenceDate] - state->started;
    state->done = YES;
}

static SPReceipt pointerThen(NSWindow *window, WKWebView *view, double x, double y, int phase, double timeout) {
    SPReceipt receipt = {NO, SP_INPUT_REJECTED, 0, view, NO};
    SPReceipt *state = &receipt;
    sp_input_pointer_then(window, x, y, phase, 0, 0, 0, timeout, received, state);
    until(^BOOL { return state->done; });
    return receipt;
}

// Checks that the completion of a press and release is called after the document receives them. A content world that the page cannot see reports the receipt.
static void checkReceipts(void) {
    NSWindow *window = [[[NSWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(300, 200))
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO] autorelease];
    [window setReleasedWhenClosed:NO];
    WKWebView *view = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 300, 200)] autorelease];
    window.contentView = view;
    [view loadHTMLString:@"<!doctype html><body style='margin:0;height:200px'><script>window.probe={events:[]};"
        "for (const type of ['pointerdown','pointerup']) addEventListener(type,e=>probe.events.push({type}),true);"
        "</script>" baseURL:nil];
    until(^BOOL { return [evaluate(view, @"Boolean(window.probe)") boolValue]; });
    [window orderBack:nil];

    // An unregistered web view does not report receipt, so the completion is immediate on delivery.
    SPReceipt unregistered = pointerThen(window, view, 50, 50, 1, 5);
    check(unregistered.result == SP_INPUT_DELIVERED, @"a press into an unregistered webview completes when it is delivered");
    pointerThen(window, view, 50, 50, 3, 5);
    drain(view);

    check(webviewInputRegister(view), @"the webview registers for pointer input");
    check([evaluate(view, @"typeof window.webkit?.messageHandlers?.soksakInputReceipt") isEqual:@"undefined"],
        @"the page cannot see the input receipt handler");
    evaluate(view, @"probe.events.length=0; null");
    pointerOutside(window);
    SPReceipt down = pointerThen(window, view, 50, 50, 1, 5);
    check(down.result == SP_INPUT_DELIVERED && down.seen == 1 && !down.held,
        [NSString stringWithFormat:@"a press completes after the document received it without a held-button report (%d, %lu events, held %d)",
            down.result, (unsigned long)down.seen, down.held]);
    SPReceipt up = pointerThen(window, view, 50, 50, 3, 5);
    check(up.result == SP_INPUT_DELIVERED && up.seen == 2,
        [NSString stringWithFormat:@"a release completes after the document received it (%d, %lu events)", up.result, (unsigned long)up.seen]);

    // A busy document receives the press after it finishes, so the completion is also after that.
    [view evaluateJavaScript:@"{const end=Date.now()+1000; while(Date.now()<end){}} null" completionHandler:nil];
    SPTimed late = {NO, SP_INPUT_REJECTED, [NSDate timeIntervalSinceReferenceDate], 0};
    SPTimed *lateState = &late;
    sp_input_pointer_then(window, 50, 50, 1, 0, 0, 0, 5, timed, lateState);
    until(^BOOL { return lateState->done; });
    check(late.result == SP_INPUT_DELIVERED && late.took >= 0.9,
        [NSString stringWithFormat:@"a press completes only after a busy document is free to receive it (%d after %.3fs)", late.result, late.took]);
    pointerThen(window, view, 50, 50, 3, 5);

    // When the document is busy the receipt is late, and when the time limit passes it is reported as not received.
    [view evaluateJavaScript:@"{const end=Date.now()+2500; while(Date.now()<end){}} null" completionHandler:nil];
    SPTimed busy = {NO, SP_INPUT_DELIVERED, [NSDate timeIntervalSinceReferenceDate], 0};
    SPTimed *busyState = &busy;
    sp_input_pointer_then(window, 50, 50, 1, 0, 0, 0, 0.5, timed, busyState);
    until(^BOOL { return busyState->done; });
    check(busy.result == SP_INPUT_UNRECEIVED && busy.took >= 0.45 && busy.took < 2,
        [NSString stringWithFormat:@"a press a busy document does not receive in time is reported (%d after %.3fs)", busy.result, busy.took]);
    pointerThen(window, view, 50, 50, 3, 5);
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

static void checkPointerTargetAcrossViews(void) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(240, 120))
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    NSView *content = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 240, 120)] autorelease];
    SPPointerTarget *first = [[[SPPointerTarget alloc] initWithFrame:NSMakeRect(0, 0, 120, 120)] autorelease];
    SPPointerTarget *second = [[[SPPointerTarget alloc] initWithFrame:NSMakeRect(120, 0, 120, 120)] autorelease];
    [content addSubview:first]; [content addSubview:second]; window.contentView = content;
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

static void checkIndependentWindowKeys(void) {
    NSWindow *first = [[NSWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(240, 120))
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    NSWindow *second = [[NSWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(240, 120))
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    WKWebView *firstView = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 240, 120)];
    WKWebView *secondView = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 240, 120)];
    first.contentView = firstView;
    second.contentView = secondView;
    NSString *html = @"<input id='field'><script>window.keys=[];"
        "addEventListener('keydown',e=>keys.push(e.key),true);</script>";
    // The second window records the received key 200 ms late. WebContent processes delivered keys asynchronously, so the check must
    // wait for that processing before judging. This delay reproduces processing delayed by load.
    NSString *late = @"<input id='field'><script>window.keys=[];"
        "addEventListener('keydown',e=>{const key=e.key;setTimeout(()=>keys.push(key),200);},true);</script>";
    [firstView loadHTMLString:html baseURL:nil];
    [secondView loadHTMLString:late baseURL:nil];
    [first orderBack:nil];
    [second orderBack:nil];
    until(^BOOL { return [evaluate(firstView, @"Boolean(window.keys)") boolValue] &&
        [evaluate(secondView, @"Boolean(window.keys)") boolValue]; });

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
    until(^BOOL { return [[evaluate(firstView, @"document.getElementById('field').value") description] isEqual:@"a"]; });
    check([evaluate(firstView, @"document.getElementById('field').value") isEqual:@"a"],
        @"the first window keeps its input");
    // Waits until both windows have processed the key, then judges, and keeps the received key.
    until(^BOOL { return [evaluate(secondView, @"keys.length") integerValue] > 0; });
    NSArray *firstKeys = evaluate(firstView, @"keys");
    NSArray *secondKeys = evaluate(secondView, @"keys");
    check([secondKeys isEqual:@[@"Escape"]],
        [NSString stringWithFormat:@"the second window receives only its own Escape (first %@, second %@)",
            [firstKeys componentsJoinedByString:@","], [secondKeys componentsJoinedByString:@","]]);
    check([evaluate(firstView, @"keys") isEqual:@[@"a"]],
        @"the first window does not receive the second window's Escape");
    [first close];
    [second close];
}

int main(void) { @autoreleasepool {
    // The records that this test reads include events below the level error, which the default policy refuses (docs/spec/logging.md#policy):
    // the policy that stores every level is set here, and the default policy is tested in event_ring_test.
    const int8_t everything[SP_CLASS_COUNT] = {SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE};
    check(sp_event_set_policy(everything), @"the policy stores every level of every class");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    checkActivityWaitAggregation();
    checkActivityWaitDelayedRegistration();
    checkActivityWaitRegistrationTimeout();
    checkPointerTargetAcrossViews();
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
    [view loadHTMLString:html baseURL:nil];
    [window orderBack:nil];
    until(^BOOL { return [evaluate(view, @"Boolean(window.probe)") boolValue]; });
    __block BOOL painted = NO;
    [view _doAfterNextPresentationUpdate:^{ painted = YES; }];
    until(^BOOL { return painted; });

    check(sp_input_pointer(window, 150, 100, 0, 0, 0, 0) == SP_INPUT_INACTIVE, @"a move without a button is reported as inactive in a window that is not key");
    drain(view);
    check([evaluate(view, @"probe.events.filter(e=>e.type==='pointermove').length") intValue] == 0, @"a rejected move sends nothing to the page");
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
    until(^BOOL { return [evaluate(view, @"probe.events.filter(e=>e.type==='wheel').length") intValue] > 0; });
    NSArray *wheel = evaluate(view, @"probe.events.filter(e=>e.type==='wheel')");
    check(wheel.count > 0 && ![[wheel valueForKey:@"trusted"] containsObject:@NO],
        [NSString stringWithFormat:@"scroll reaches the page as a trusted wheel event (%lu)", (unsigned long)wheel.count]);
    until(^BOOL { return [evaluate(view, @"document.getElementById('pad').scrollTop") doubleValue] > 0; });
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
        check(hasRecord(records, @[@"\"kind\":\"pointer\"", @"\"phase\":2", @"\"result\":\"rejected\"", @"\"reason\":\"no open press for the drag or release\""]),
            [NSString stringWithFormat:@"a rejected pointer input is recorded with its reason (got %@)", records]);
    }
    until(^BOOL { return [evaluate(view, @"probe.events.filter(e=>e.type==='keydown').length") intValue] >= 2; });
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
        until(^BOOL { return [evaluate(view, @"probe.events.filter(e=>e.type==='keydown').length") unsignedIntegerValue] >= 1; });
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
        until(^BOOL { return [evaluate(view, @"probe.events.filter(e=>e.type==='keydown').length") unsignedIntegerValue] >= 1; });
        NSArray *minusKey = evaluate(view, @"probe.events.filter(e=>e.type==='keydown').map(e=>({key:e.key,code:e.code}))");
        check([minusKey isEqual:@[@{@"key": @"-", @"code": @"Minus"}]],
            [NSString stringWithFormat:@"the minus character keeps its physical ANSI key identity: %@", minusKey]);
    }

    // Focused input can leave WebKit work in the queue. The next native click must
    // still deliver down before up and synthesize exactly one DOM click.
    SPReceipt buttonDown = pointerThen(window, view, 50, 50, 1, 5);
    SPReceipt buttonUp = pointerThen(window, view, 50, 50, 3, 5);
    check(buttonDown.result == SP_INPUT_DELIVERED && buttonUp.result == SP_INPUT_DELIVERED,
        @"a click after keyboard input receives both pointer phases");
    drain(view);
    check([evaluate(view, @"window.buttonClicks") unsignedIntegerValue] == 1,
        @"a click after keyboard input synthesizes one DOM click");

    // When another web view in the window is pressed, that web view receives key input as in AppKit.
    WKWebView *child = [[WKWebView alloc] initWithFrame:NSMakeRect(220, 0, 180, 50)];
    [view addSubview:child];
    [child loadHTMLString:@"<!doctype html><input id='other' style='width:160px'><script>window.ready=true</script>" baseURL:nil];
    until(^BOOL { return [evaluate(child, @"Boolean(window.ready)") boolValue]; });
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
    until(^BOOL { return [[evaluate(child, @"document.getElementById('other').value") description] isEqual:@"b"]; });
    check([evaluate(child, @"document.getElementById('other').value") isEqual:@"b"], @"keys reach the pressed webview");
    check([evaluate(view, @"document.getElementById('field').value") isEqual:@"a"], @"the previous webview keeps its text");
    [child release];

    check(!NSApp.isActive, @"application stays inactive");
    check(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != getpid(), @"this process did not become the frontmost application");
    [window close];
    checkIndependentWindowKeys();
    checkReceipts();
    return failures ? 1 : 0;
}}
