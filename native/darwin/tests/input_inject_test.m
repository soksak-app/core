// 네이티브 입력 주입이 앱을 활성화하지 않고 웹뷰에 신뢰 이벤트로 도달하는지 검사한다.
//
// 창은 일반 NSWindow 이며 키 창 상태를 흉내 내지 않는다. 실제 애플리케이션 창과 같은 조건이다.
#import <Cocoa/Cocoa.h>
#import "input_inject.h"
#import "private/webkit.h"
#import "webview_input.h"

static int failures = 0;
static NSString *lastEvaluationScript = nil;

// 실제 포인터가 창 위에 있으면 AppKit 과 WebKit 이 그 이동도 처리하므로 검사 이벤트에 섞인다.
// 창을 포인터에서 떨어진 곳에 두고, 측정 동안 포인터가 창에 들어오면 측정을 무효로 보고한다.
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

typedef struct { BOOL done; sp_input_result result; NSUInteger seen; WKWebView *view; } SPReceipt;

static void received(void *context, sp_input_result result) {
    SPReceipt *receipt = context;
    receipt->result = result;
    // 완료 시점에 문서가 받은 누름과 뗌의 수. 메인 스레드에서 동기적으로 읽는다.
    receipt->seen = [evaluate(receipt->view, @"probe.events.filter(e=>e.type==='pointerdown'||e.type==='pointerup').length") unsignedIntegerValue];
    receipt->done = YES;
}

typedef struct { BOOL done; sp_input_result result; NSTimeInterval started; NSTimeInterval took; } SPTimed;

static void timed(void *context, sp_input_result result) {
    SPTimed *state = context;
    state->result = result;
    state->took = [NSDate timeIntervalSinceReferenceDate] - state->started;
    state->done = YES;
}

static SPReceipt pointerThen(NSWindow *window, WKWebView *view, double x, double y, int phase, double timeout) {
    SPReceipt receipt = {NO, SP_INPUT_REJECTED, 0, view};
    SPReceipt *state = &receipt;
    sp_input_pointer_then(window, x, y, phase, 0, 0, 0, timeout, received, state);
    until(^BOOL { return state->done; });
    return receipt;
}

// 누름과 뗌의 완료가 문서의 수신 뒤에 불리는지 검사한다. 수신은 페이지가 볼 수 없는 content world 가 알린다.
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

    // 등록하지 않은 웹뷰는 수신을 알리지 않으므로 전달 즉시 완료한다.
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
    check(down.result == SP_INPUT_DELIVERED && down.seen == 1,
        [NSString stringWithFormat:@"a press completes after the document received it (%d, %lu events)", down.result, (unsigned long)down.seen]);
    SPReceipt up = pointerThen(window, view, 50, 50, 3, 5);
    check(up.result == SP_INPUT_DELIVERED && up.seen == 2,
        [NSString stringWithFormat:@"a release completes after the document received it (%d, %lu events)", up.result, (unsigned long)up.seen]);

    // 바쁜 문서는 끝난 뒤에 누름을 받으므로 완료도 그 뒤다.
    [view evaluateJavaScript:@"{const end=Date.now()+1000; while(Date.now()<end){}} null" completionHandler:nil];
    SPTimed late = {NO, SP_INPUT_REJECTED, [NSDate timeIntervalSinceReferenceDate], 0};
    SPTimed *lateState = &late;
    sp_input_pointer_then(window, 50, 50, 1, 0, 0, 0, 5, timed, lateState);
    until(^BOOL { return lateState->done; });
    check(late.result == SP_INPUT_DELIVERED && late.took >= 0.9,
        [NSString stringWithFormat:@"a press completes only after a busy document is free to receive it (%d after %.3fs)", late.result, late.took]);
    pointerThen(window, view, 50, 50, 3, 5);

    // 문서가 바쁘면 수신이 늦어지고, 제한 시간이 지나면 받지 않은 것으로 알린다.
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

// 끌기와 뗌은 좌표 아래의 다른 뷰가 아니라 누름을 받은 뷰로 전달해야 한다.
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
        sp_input_pointer(window, 150, 30, 1, 0, 0, 0) == SP_INPUT_REJECTED,
        @"a duplicate press does not replace the gesture target");
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
    // 둘째 창은 받은 키를 200 ms 늦게 기록한다. WebContent 는 전달된 키를 비동기로 처리하므로, 검사는 그 처리를
    // 기다린 뒤에 판정해야 한다. 이 지연은 부하로 늦어진 처리를 재현한다.
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
    // 두 창이 키를 처리할 때까지 기다린 뒤 판정하고, 받은 키를 남긴다.
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
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
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
        " addEventListener(type,e=>probe.events.push({type,trusted:e.isTrusted,x:e.clientX,y:e.clientY,key:e.key}),true);"
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
    until(^BOOL { return [evaluate(view, @"probe.events.filter(e=>e.type==='keydown').length") intValue] >= 2; });
    NSArray *keysSeen = evaluate(view, @"probe.events.filter(e=>e.type==='keydown').map(e=>e.key)");
    check([keysSeen isEqual:@[@"a", @"Enter"]],
        [NSString stringWithFormat:@"keys reach the focused field in a window that is not key: %@", keysSeen]);
    check([evaluate(view, @"document.getElementById('field').value") isEqual:@"a"], @"text input reaches the field");

    // focus 된 입력은 WebKit 작업을 queue 에 남길 수 있다. 다음 네이티브 클릭은
    // 여전히 down 을 up 보다 먼저 전달하고 DOM click 을 정확히 하나 합성해야 한다.
    SPReceipt buttonDown = pointerThen(window, view, 50, 50, 1, 5);
    SPReceipt buttonUp = pointerThen(window, view, 50, 50, 3, 5);
    check(buttonDown.result == SP_INPUT_DELIVERED && buttonUp.result == SP_INPUT_DELIVERED,
        @"a click after keyboard input receives both pointer phases");
    drain(view);
    check([evaluate(view, @"window.buttonClicks") unsignedIntegerValue] == 1,
        @"a click after keyboard input synthesizes one DOM click");

    // 창 안의 다른 웹뷰를 누르면 AppKit 과 같이 그 웹뷰가 키 입력을 받는다.
    WKWebView *child = [[WKWebView alloc] initWithFrame:NSMakeRect(220, 0, 180, 50)];
    [view addSubview:child];
    [child loadHTMLString:@"<!doctype html><input id='other' style='width:160px'><script>window.ready=true</script>" baseURL:nil];
    until(^BOOL { return [evaluate(child, @"Boolean(window.ready)") boolValue]; });
    // WKWebView 는 뒤집힌 좌표계라 하위 뷰의 frame 이 곧 콘텐츠 영역 왼쪽 위 기준이다.
    check(sp_input_pointer(window, 300, 20, 1, 0, 0, 0) == SP_INPUT_DELIVERED && sp_input_pointer(window, 300, 20, 3, 0, 0, 0) == SP_INPUT_DELIVERED,
        @"child webview click delivered");
    drain(child);
    check(window.firstResponder == child || [(NSView *)window.firstResponder isDescendantOf:child],
        @"pressing a webview makes it the first responder");
    NSString *childActiveElement = [evaluate(child, @"document.activeElement && document.activeElement.id") description];
    check([childActiveElement isEqual:@"other"],
        [NSString stringWithFormat:@"child page remains responsive and focuses its input after click (got %@)", childActiveElement]);
    // 자식 웹뷰의 포커스 라우팅 검사에서는 입력 소스 변환 없이 영문 b를 명시한다.
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
