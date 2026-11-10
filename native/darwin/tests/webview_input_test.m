// Checks pointer and keyboard input of overlapping webviews and restoration after removal on the installed WebKit.
//
// WebKit updates hover only in the key window, so this check activates the application and takes the focus of the
// user. It is not part of make test and runs only through make test-app-activation. AppKit also delivers movement to a
// tracking area that holds the real pointer, so the check places the window away from the pointer and reports the
// measurement as a failure if the pointer enters the window.
#import <Cocoa/Cocoa.h>
#import "input_inject.h"
#import "webview_input.h"
#import "private/webkit.h"
#import "support/event_wait.h"

static void require(BOOL condition, NSString *message) {
    if (!condition) { fprintf(stderr, "FAIL: %s\n", message.UTF8String); exit(1); }
}

static id evaluate(WKWebView *view, NSString *script) {
    __block BOOL done = NO;
    __block id result = nil;
    [view evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
        if (error) fprintf(stderr, "JavaScript: %s\n", error.localizedDescription.UTF8String);
        result = [value retain];
        done = YES;
    }];
    eventWait(@"the page answers the evaluation", ^BOOL { return done; });
    return [result autorelease];
}

static void drain(WKWebView *view) {
    __block BOOL done = NO;
    require([view respondsToSelector:@selector(_doAfterProcessingAllPendingMouseEvents:)], @"WebKit has no native mouse-event barrier");
    [view _doAfterProcessingAllPendingMouseEvents:^{ done = YES; }];
    eventWait(@"WebKit processes all pending mouse events", ^BOOL { return done; });
}

typedef struct { BOOL done; sp_activate_result result; char frontmost[256]; } SPActivation;

static void activated(void *context, sp_activate_result result, const char *frontmost) {
    SPActivation *state = context;
    state->result = result;
    snprintf(state->frontmost, sizeof state->frontmost, "%s", frontmost ?: "");
    state->done = YES;
}

static id observer(WKWebView *view) {
    [view updateTrackingAreas];
    for (NSTrackingArea *area in view.trackingAreas) {
        if (area.options & NSTrackingMouseMoved) return area.owner;
    }
    require(NO, @"the actual WKWebView has no mouse-move tracking area");
    return nil;
}

// AppKit also delivers a posted movement event to a tracking area that holds the real pointer. The window is placed
// away from the pointer, and a movement event is valid only while the pointer is outside the window.
static void pointerOutside(NSWindow *window) {
    require(!NSPointInRect(NSEvent.mouseLocation, window.frame),
        @"the pointer is over the test window, so AppKit delivers movements to its tracking areas too; "
        "rerun without moving the pointer over the window");
}

static void deliver(NSWindow *window, NSArray *views, NSPoint point, BOOL baseline, WKWebView *manualTarget) {
    require(NSApp.isActive && window.isKeyWindow, @"the window must be the key window of the active application");
    pointerOutside(window);
    NSEvent *event = [NSEvent mouseEventWithType:NSEventTypeMouseMoved location:point
        modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime
        windowNumber:window.windowNumber context:nil eventNumber:1 clickCount:0 pressure:0];
    // [NSApplication sendEvent:] runs the local monitor that routes the pointer. Then AppKit delivers the movement
    // event to the topmost registered WebKit observer at that point. Delivering to every observer would bypass the
    // native z-order and count overlapping pages twice.
    [NSApp postEvent:event atStart:NO];
    // The posted event is in the queue, so taking it waits for no other event.
    NSEvent *posted = [NSApp nextEventMatchingMask:NSEventMaskMouseMoved untilDate:NSDate.distantFuture
        inMode:NSDefaultRunLoopMode dequeue:YES];
    require(posted != nil, @"AppKit did not dequeue the test mouse event");
    [NSApp sendEvent:posted];
    if (baseline) {
        for (WKWebView *view in views) [observer(view) mouseMoved:event];
    } else if (manualTarget) {
        [observer(manualTarget) mouseMoved:event];
    } else if ([views.lastObject isHidden] ||
               [window.contentView.subviews indexOfObject:views.firstObject] > [window.contentView.subviews indexOfObject:views.lastObject]) {
        // If a covering view is hidden without a native enter/exit transition, AppKit does not re-enter the newly
        // revealed tracking area.
        [observer(views.firstObject) mouseMoved:event];
    }
    pointerOutside(window);
}

static void move(NSWindow *window, NSArray *views, NSPoint point, BOOL baseline, WKWebView *manualTarget) {
    deliver(window, views, point, baseline, manualTarget);
    for (WKWebView *view in views) drain(view);
}

static void expectMoves(NSArray *views, NSArray *expected, NSString *stage) {
    NSMutableArray *actual = [NSMutableArray array];
    for (WKWebView *view in views) [actual addObject:evaluate(view, @"probe.moves") ?: @(-1)];
    require([actual isEqual:expected], [NSString stringWithFormat:@"%@: expected %@, received %@", stage, expected, actual]);
    printf("PASS: %s %s\n", stage.UTF8String, actual.description.UTF8String);
}

// When a view is attached to the window again, WebKit schedules the active state transmission again. Sends the
// movement after that transmission ends.
static void settle(WKWebView *view) {
    __block BOOL done = NO;
    [view _doAfterActivityStateUpdate:^{ done = YES; }];
    eventWait(@"WebKit sends the activity state of the view", ^BOOL { return done; });
}

static void reset(NSArray *views) {
    for (WKWebView *view in views) evaluate(view, @"probe.moves = 0");
}

static NSEvent *moved(NSWindow *window, NSPoint point) {
    return [NSEvent mouseEventWithType:NSEventTypeMouseMoved location:point modifierFlags:0
        timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil eventNumber:1 clickCount:0 pressure:0];
}

static NSEvent *crossed(NSWindow *window, NSEventType type, NSPoint point) {
    return [NSEvent enterExitEventWithType:type location:point modifierFlags:0
        timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil eventNumber:20 trackingNumber:0 userData:NULL];
}

static int orderFailures = 0;

// Notes when the navigation of the document finishes; the script of the document has run then.
@interface SPLoaded : NSObject <WKNavigationDelegate>
@property BOOL finished;
@end
@implementation SPLoaded
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
    (void)view;
    (void)navigation;
    self.finished = YES;
}
@end

static void expectHover(NSArray *views, NSArray *expected, NSString *stage) {
    NSMutableArray *actual = [NSMutableArray array];
    for (WKWebView *view in views) {
        drain(view);
        [actual addObject:evaluate(view, @"document.body.matches(':hover')") ?: @NO];
    }
    BOOL same = [actual isEqual:expected];
    if (!same) orderFailures++;
    fprintf(same ? stdout : stderr, "%s: %s: expected %s, received %s\n", same ? "PASS" : "FAIL", stage.UTF8String,
        [expected componentsJoinedByString:@","].UTF8String, [actual componentsJoinedByString:@","].UTF8String);
}

// AppKit fixes no order among the enter, the exit and the move of a tracking area, and each area of overlapping views hears its
// own. The pointer that a page hovers follows the view at the point in each order. Each step calls what AppKit calls: the local
// monitor that routes the pointer, then the tracking owner.
static void checkTrackingOrders(NSWindow *window, WKWebView *bottom, WKWebView *top) {
    NSArray *views = @[bottom, top];
    const NSPoint both = NSMakePoint(300, 150), lower = NSMakePoint(100, 150), away = NSMakePoint(-10, 150);
    pointerOutside(window);
    // Starts with the pointer out of both views.
    webviewInputRoutePointer(moved(window, away));
    [observer(top) mouseExited:crossed(window, NSEventTypeMouseExited, away)];
    [observer(bottom) mouseExited:crossed(window, NSEventTypeMouseExited, away)];
    expectHover(views, @[@NO, @NO], @"the pointer starts out of both views");

    // The move before the enter, in the view at the point, which no other view covers.
    webviewInputRoutePointer(moved(window, lower));
    [observer(bottom) mouseMoved:moved(window, lower)];
    webviewInputRoutePointer(crossed(window, NSEventTypeMouseEntered, lower));
    [observer(bottom) mouseEntered:crossed(window, NSEventTypeMouseEntered, lower)];
    expectHover(views, @[@YES, @NO], @"a move before the enter hovers the view at the point");

    // Overlapping views: each area hears its enter and its move, and the view on top is the one at the point.
    webviewInputRoutePointer(crossed(window, NSEventTypeMouseEntered, both));
    [observer(top) mouseEntered:crossed(window, NSEventTypeMouseEntered, both)];
    webviewInputRoutePointer(moved(window, both));
    [observer(bottom) mouseMoved:moved(window, both)];
    [observer(top) mouseMoved:moved(window, both)];
    expectHover(views, @[@NO, @YES], @"overlapping areas hover the view on top");

    // The area of the view on top is left before its exit comes: an enter without the exit, and the exit last.
    webviewInputRoutePointer(moved(window, lower));
    [observer(bottom) mouseMoved:moved(window, lower)];
    expectHover(views, @[@YES, @NO], @"a move off the view on top leaves it before its exit comes");
    [observer(top) mouseExited:crossed(window, NSEventTypeMouseExited, lower)];
    expectHover(views, @[@YES, @NO], @"the exit that comes last leaves the view at the point hovered");

    // The enter of the view on top after its move, and its exit before a later move of the view below.
    webviewInputRoutePointer(moved(window, both));
    [observer(top) mouseMoved:moved(window, both)];
    webviewInputRoutePointer(crossed(window, NSEventTypeMouseEntered, both));
    [observer(top) mouseEntered:crossed(window, NSEventTypeMouseEntered, both)];
    expectHover(views, @[@NO, @YES], @"a move before the enter takes the hover from the view below");
    [observer(top) mouseExited:crossed(window, NSEventTypeMouseExited, lower)];
    webviewInputRoutePointer(moved(window, lower));
    [observer(bottom) mouseMoved:moved(window, lower)];
    expectHover(views, @[@YES, @NO], @"an exit before the move gives the hover back");
    [observer(bottom) mouseExited:crossed(window, NSEventTypeMouseExited, away)];
    expectHover(views, @[@NO, @NO], @"the exit of the last view clears the hover");
}

// tests/support/no_activation.m: this check activates the app in make test-app-activation.
void sp_test_declare_activation(void);

int main(int argc, const char **argv) { @autoreleasepool {
    sp_test_declare_activation();
    BOOL baseline = NO;
    for (int i = 1; i < argc; ++i) {
        baseline |= strcmp(argv[i], "--baseline") == 0;
    }
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    // Places the window away from the pointer, in the half of the screen opposite to the one that holds the pointer.
    NSPoint pointer = NSEvent.mouseLocation;
    NSRect screen = NSScreen.mainScreen.visibleFrame;
    for (NSScreen *candidate in NSScreen.screens) {
        if (NSPointInRect(pointer, candidate.frame)) screen = candidate.visibleFrame;
    }
    CGFloat left = pointer.x < NSMidX(screen) ? NSMaxX(screen) - 520 : NSMinX(screen) + 20;
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(left, NSMinY(screen) + 20, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.title = @"WebKit input regression";
    window.acceptsMouseMovedEvents = YES;
    window.ignoresMouseEvents = YES;
    WKWebView *bottom = [[WKWebView alloc] initWithFrame:NSMakeRect(0,0,500,400)];
    WKWebView *top = [[WKWebView alloc] initWithFrame:NSMakeRect(200,50,250,250)];
    NSArray *views = @[bottom, top];
    NSString *html = @"<!doctype html><style>html,body{margin:0;width:100%;height:100%;user-select:none}</style>"
        "<input id='field'><script>window.probe={moves:0};addEventListener('mousemove',()=>probe.moves++);</script>";
    NSMutableArray<SPLoaded *> *loads = [NSMutableArray array];
    for (WKWebView *view in views) {
        [window.contentView addSubview:view];
        if (!baseline) require(webviewInputRegister(view), @"required webview pointer-input API is unavailable");
        SPLoaded *loaded = [[SPLoaded new] autorelease];
        [loads addObject:loaded];
        view.navigationDelegate = loaded;
        [view loadHTMLString:html baseURL:nil];
    }
    [window orderFront:nil];
    for (NSUInteger i = 0; i < views.count; i++) {
        SPLoaded *loaded = loads[i];
        eventWait(@"the navigation of the document finishes", ^BOOL { return loaded.finished; });
        [views[i] setNavigationDelegate:nil];
        require([evaluate(views[i], @"Boolean(window.probe)") boolValue], @"the document defines its probe");
    }
    __block SPActivation activation = {NO, SP_ACTIVATE_DONE, ""};
    sp_input_activate(window, activated, &activation);
    eventWait(@"the activation of the window ends", ^BOOL { return activation.done; });
    require(activation.result == SP_ACTIVATE_DONE, [NSString stringWithFormat:
        @"the window did not become the key window of the active application (%d, frontmost %s)",
        activation.result, activation.frontmost]);
    for (WKWebView *view in views) {
        __block BOOL painted = NO;
        [view _doAfterNextPresentationUpdate:^{ painted = YES; }];
        eventWait(@"the next presentation of the view", ^BOOL { return painted; });
    }
    reset(views);
    move(window, views, NSMakePoint(300,150), baseline, nil);
    expectMoves(views, baseline ? @[@1,@1] : @[@0,@1], baseline ? @"original overlap bug" : @"overlap reaches only top DOM");
    if (!baseline) {
        reset(views);
        move(window, views, NSMakePoint(100,150), baseline, nil);
        expectMoves(views, @[@1,@0], @"uncovered bottom receives movement");

        top.hidden = YES;
        reset(views);
        move(window, views, NSMakePoint(300,150), baseline, nil);
        expectMoves(views, @[@1,@0], @"hiding the overlay exposes bottom");
        top.hidden = NO;

        [window.contentView addSubview:bottom positioned:NSWindowAbove relativeTo:nil];
        settle(bottom);
        reset(views);
        move(window, views, NSMakePoint(300,150), baseline, nil);
        expectMoves(views, @[@1,@0], @"native z-order is authoritative");
        [window.contentView addSubview:top positioned:NSWindowAbove relativeTo:nil];
        settle(top);

        top.frame = NSMakeRect(10,10,250,250);
        reset(views);
        move(window, views, NSMakePoint(300,150), baseline, bottom);
        expectMoves(views, @[@1,@0], @"moving the overlay updates hit testing");

        NSView *cover = [[NSView alloc] initWithFrame:NSMakeRect(0,0,500,400)];
        [window.contentView addSubview:cover];
        reset(views);
        move(window, views, NSMakePoint(100,150), baseline, nil);
        expectMoves(views, @[@0,@0], @"ordinary native view occludes both webviews");
        [cover removeFromSuperview];
        [cover release];

        // Pointer ownership must not take the keyboard focus.
        [window makeFirstResponder:top];
        evaluate(top, @"document.getElementById('field').focus()");
        move(window, views, NSMakePoint(400,150), baseline, nil);
        require(window.firstResponder == top || [(NSView *)window.firstResponder isDescendantOf:top], @"pointer movement stole keyboard focus");
        printf("PASS: pointer movement preserves keyboard focus\n");
        // The page answers at the input event of the field. The listener is sent to the web process before the key, so it
        // is in place when the key arrives.
        __block BOOL typed = NO;
        __block id typedValue = nil;
        [top callAsyncJavaScript:@"const field = document.getElementById('field');"
            "if (field.value !== 'a') await new Promise(resolve => field.addEventListener('input', resolve, {once: true}));"
            "return field.value;"
            arguments:nil inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:^(id value, NSError *error) {
                if (error) fprintf(stderr, "JavaScript: %s\n", error.localizedDescription.UTF8String);
                typedValue = [value retain];
                typed = YES;
            }];
        NSEvent *key = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0
            timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil
            characters:@"a" charactersIgnoringModifiers:@"a" isARepeat:NO keyCode:0];
        [window sendEvent:key];
        eventWait(@"the field of the page receives the key", ^BOOL { return typed; });
        require([typedValue isEqual:@"a"], [NSString stringWithFormat:@"the key reaches the field (got %@)", typedValue]);
        [typedValue release];
        printf("PASS: pointer on another view does not block keyboard input\n");

        top.frame = NSMakeRect(200,50,250,250);
        checkTrackingOrders(window, bottom, top);

        webviewInputUnregister(top);
        [top removeFromSuperview];
        reset(@[bottom]);
        move(window, @[bottom], NSMakePoint(100,150), baseline, bottom);
        expectMoves(@[bottom], @[@1], @"closing overlay restores bottom");
        require([evaluate(bottom, @"document.body.matches(':hover')") boolValue], @"body was not hovered before exit");
        NSEvent *left = [NSEvent enterExitEventWithType:NSEventTypeMouseExited location:NSMakePoint(-10,150)
            modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
            context:nil eventNumber:20 trackingNumber:0 userData:NULL];
        [observer(bottom) mouseExited:left];
        drain(bottom);
        require(![evaluate(bottom, @"document.body.matches(':hover')") boolValue], @"leaving the window retained the old DOM hover");
        printf("PASS: leaving the window clears the previous DOM hover\n");
    }
    for (WKWebView *view in views) webviewInputUnregister(view);
    [window orderOut:nil];
    [top release]; [bottom release]; [window close]; [window release];
    return orderFailures ? 1 : 0;
} }
