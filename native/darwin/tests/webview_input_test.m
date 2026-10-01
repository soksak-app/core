// 설치된 WebKit에서 겹친 웹뷰의 포인터·키보드 입력과 제거 후 복원을 검사한다.
//
// WebKit 은 키 창에서만 호버를 갱신하므로 이 검사는 애플리케이션을 활성화해 사용자의 포커스를
// 가져간다. make test 에 포함하지 않고 make test-activation 으로만 실행한다. AppKit 은 실제
// 포인터가 있는 추적 영역에도 이동을 전달하므로, 창을 포인터에서 떨어진 곳에 두고 포인터가 창에
// 들어오면 측정을 실패로 보고한다.
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

// AppKit 은 게시된 이동 이벤트를 실제 pointer 가 있는 tracking area 에도 전달한다.
// 창은 pointer 에서 떨어진 곳에 두며, 이동 이벤트는 pointer 가 창 밖에 있는 동안에만
// 유효하다.
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
    // -[NSApplication sendEvent:] 는 pointer 를 라우팅하는 local monitor 를 실행한다.
    // 그다음 AppKit 은 이동 이벤트를 그 지점의 최상위 등록 WebKit observer 에 전달한다.
    // 모든 observer 에 전달하면 네이티브 z-order 를 우회하고 겹친 페이지를
    // 중복 집계한다.
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
        // 덮고 있던 뷰가 네이티브 enter/exit 전환 없이 숨겨지면 AppKit 은 새로 드러난
        // tracking area 에 다시 진입하지 않는다.
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

// 뷰를 창에 다시 붙이면 WebKit 이 활성 상태 전송을 다시 예약한다. 그 전송이 끝난 뒤에 이동을 보낸다.
static void settle(WKWebView *view) {
    __block BOOL done = NO;
    [view _doAfterActivityStateUpdate:^{ done = YES; }];
    until(^BOOL { return done; });
}

static void reset(NSArray *views) {
    for (WKWebView *view in views) evaluate(view, @"probe.moves = 0");
}

// tests/support/no_activation.m: 이 검사는 make test-activation 에서 앱을 활성화한다.
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
    // 창을 포인터에서 떨어진 곳에 둔다. 포인터가 있는 화면의 반대쪽 절반이다.
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

        // pointer 소유권이 키보드 focus 를 가져가면 안 된다.
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
