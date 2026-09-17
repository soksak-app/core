// 설치된 WebKit에서 겹친 웹뷰의 포인터·키보드 입력과 제거 후 복원을 검사한다.
//
// WebKit 은 키 창에서만 호버를 갱신하므로 이 검사는 애플리케이션을 활성화해 사용자의 포커스를
// 가져간다. make test 에 포함하지 않고 make test-activation 으로만 실행한다. 창은
// ignoresMouseEvents 로 실제 마우스 이벤트를 받지 않으며, 검사가 만든 이벤트만 웹뷰에 도달한다.
#import <Cocoa/Cocoa.h>
#import "input_inject.h"
#import "webview_input.h"
#import "private/webkit.h"

static void require(BOOL condition, NSString *message) {
    if (!condition) { fprintf(stderr, "FAIL: %s\n", message.UTF8String); exit(1); }
}

// 활성화 알림은 애플리케이션 이벤트로 도착하므로 이벤트를 꺼내 처리하며 기다린다.
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

typedef struct { BOOL done; bool ok; } SPActivation;

static void activated(void *context, bool ok) {
    SPActivation *state = context;
    state->ok = ok;
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

static void deliver(NSWindow *window, NSArray *views, NSPoint point) {
    NSEvent *event = [NSEvent mouseEventWithType:NSEventTypeMouseMoved location:point
        modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime
        windowNumber:window.windowNumber context:nil eventNumber:1 clickCount:0 pressure:0];
    // AppKit delivers a movement to each overlapping tracking area. Use the
    // actual WebKit observer, not a DOM-dispatched or mocked mouse event.
    [NSApp postEvent:event atStart:NO];
    NSEvent *posted = [NSApp nextEventMatchingMask:NSEventMaskMouseMoved untilDate:[NSDate dateWithTimeIntervalSinceNow:1]
        inMode:NSDefaultRunLoopMode dequeue:YES];
    require(posted != nil, @"AppKit did not dequeue the test mouse event");
    [NSApp sendEvent:posted];
    for (WKWebView *view in views) [observer(view) mouseMoved:event];
}

static void move(NSWindow *window, NSArray *views, NSPoint point) {
    deliver(window, views, point);
    for (WKWebView *view in views) drain(view);
}

static void expectMoves(NSArray *views, NSArray *expected, NSString *stage) {
    NSMutableArray *actual = [NSMutableArray array];
    for (WKWebView *view in views) [actual addObject:evaluate(view, @"probe.moves") ?: @(-1)];
    require([actual isEqual:expected], [NSString stringWithFormat:@"%@: expected %@, received %@", stage, expected, actual]);
    printf("PASS: %s %s\n", stage.UTF8String, actual.description.UTF8String);
}

// 뷰를 창에 다시 붙이면 WebKit 이 활성 상태 전송을 다시 예약한다. 그 전송이 끝난 뒤에 이동을 보낸다.
static void settle(WKWebView *view) {
    __block BOOL done = NO;
    [view _doAfterActivityStateUpdate:^{ done = YES; }];
    until(^BOOL { return done; });
}

static void reset(NSArray *views) {
    for (WKWebView *view in views) evaluate(view, @"probe.moves = 0");
}

int main(int argc, const char **argv) { @autoreleasepool {
    BOOL baseline = NO;
    for (int i = 1; i < argc; ++i) {
        baseline |= strcmp(argv[i], "--baseline") == 0;
    }
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100,100,500,400)
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
    __block SPActivation activation = {NO, false};
    sp_input_activate(window, 5, activated, &activation);
    until(^BOOL { return activation.done; });
    require(activation.ok && window.isKeyWindow, @"the window did not become the key window of the active application");
    for (WKWebView *view in views) {
        __block BOOL painted = NO;
        [view _doAfterNextPresentationUpdate:^{ painted = YES; }];
        until(^BOOL { return painted; });
    }
    reset(views);
    move(window, views, NSMakePoint(300,150));
    expectMoves(views, baseline ? @[@1,@1] : @[@0,@1], baseline ? @"original overlap bug" : @"overlap reaches only top DOM");
    if (!baseline) {
        reset(views);
        move(window, views, NSMakePoint(100,150));
        expectMoves(views, @[@1,@0], @"uncovered bottom receives movement");

        top.hidden = YES;
        reset(views);
        move(window, views, NSMakePoint(300,150));
        expectMoves(views, @[@1,@0], @"hiding the overlay exposes bottom");
        top.hidden = NO;

        [window.contentView addSubview:bottom positioned:NSWindowAbove relativeTo:nil];
        settle(bottom);
        reset(views);
        move(window, views, NSMakePoint(300,150));
        expectMoves(views, @[@1,@0], @"native z-order is authoritative");
        [window.contentView addSubview:top positioned:NSWindowAbove relativeTo:nil];
        settle(top);

        top.frame = NSMakeRect(10,10,250,250);
        reset(views);
        move(window, views, NSMakePoint(300,150));
        expectMoves(views, @[@1,@0], @"moving the overlay updates hit testing");

        NSView *cover = [[NSView alloc] initWithFrame:NSMakeRect(0,0,500,400)];
        [window.contentView addSubview:cover];
        reset(views);
        move(window, views, NSMakePoint(100,150));
        expectMoves(views, @[@0,@0], @"ordinary native view occludes both webviews");
        [cover removeFromSuperview];
        [cover release];

        // Pointer ownership must not steal keyboard focus.
        [window makeFirstResponder:top];
        evaluate(top, @"document.getElementById('field').focus()");
        move(window, views, NSMakePoint(400,150));
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
        move(window, @[bottom], NSMakePoint(100,150));
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
