// Checks pointer and keyboard input of overlapping webviews and restoration after removal on the installed WebKit.
//
// WebKit updates hover only in the key window, so this check activates the application and takes the focus of the
// user. It is not part of make test and runs only through make test-activation. AppKit also delivers movement to a
// tracking area that holds the real pointer, so the check places the window away from the pointer and reports the
// measurement as a failure if the pointer enters the window.
#import <Cocoa/Cocoa.h>
#import "input_inject.h"
#import "webview_input.h"
#import "private/webkit.h"

static void require(BOOL condition, NSString *message) {
    if (!condition) { fprintf(stderr, "FAIL: %s\n", message.UTF8String); exit(1); }
}

// The activation notification arrives as an application event, so the check waits while it takes events and handles
// them.
static void until(BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny
            untilDate:[NSDate dateWithTimeIntervalSinceNow:0.01] inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event) [NSApp sendEvent:event];
    }
    require(done(), @"WebKit did not answer within 10 seconds");
}

static id evaluate(WKWebView *view, NSString *script) {
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
    require([view respondsToSelector:@selector(_doAfterProcessingAllPendingMouseEvents:)], @"WebKit has no native mouse-event barrier");
    [view _doAfterProcessingAllPendingMouseEvents:^{ done = YES; }];
    until(^BOOL { return done; });
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
    NSEvent *posted = [NSApp nextEventMatchingMask:NSEventMaskMouseMoved untilDate:[NSDate dateWithTimeIntervalSinceNow:1]
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
    until(^BOOL { return done; });
}

static void reset(NSArray *views) {
    for (WKWebView *view in views) evaluate(view, @"probe.moves = 0");
}

// tests/support/no_activation.m: this check activates the app in make test-activation.
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
    for (WKWebView *view in views) {
        [window.contentView addSubview:view];
        if (!baseline) require(webviewInputRegister(view), @"required webview pointer-input API is unavailable");
        [view loadHTMLString:html baseURL:nil];
    }
    [window orderFront:nil];
    for (WKWebView *view in views) until(^BOOL { return [evaluate(view, @"Boolean(window.probe)") boolValue]; });
    __block SPActivation activation = {NO, SP_ACTIVATE_DONE, ""};
    sp_input_activate(window, 5, activated, &activation);
    until(^BOOL { return activation.done; });
    require(activation.result == SP_ACTIVATE_DONE, [NSString stringWithFormat:
        @"the window did not become the key window of the active application (%d, frontmost %s)",
        activation.result, activation.frontmost]);
    for (WKWebView *view in views) {
        __block BOOL painted = NO;
        [view _doAfterNextPresentationUpdate:^{ painted = YES; }];
        until(^BOOL { return painted; });
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
        NSEvent *key = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0
            timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil
            characters:@"a" charactersIgnoringModifiers:@"a" isARepeat:NO keyCode:0];
        [window sendEvent:key];
        until(^BOOL { return [evaluate(top, @"document.getElementById('field').value") isEqual:@"a"]; });
        printf("PASS: pointer on another view does not block keyboard input\n");

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
    return 0;
} }
