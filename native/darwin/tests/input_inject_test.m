// 네이티브 입력 주입이 앱을 활성화하지 않고 웹뷰에 신뢰 이벤트로 도달하는지 검사한다.
//
// 창은 일반 NSWindow 이며 키 창 상태를 흉내 내지 않는다. 실제 애플리케이션 창과 같은 조건이다.
#import <Cocoa/Cocoa.h>
#import "input_inject.h"
#import "private/webkit.h"

static int failures = 0;

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
    if (!done()) { fprintf(stderr, "FAIL: WebKit did not answer within 10 seconds\n"); exit(1); }
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
    [view _doAfterProcessingAllPendingMouseEvents:^{ done = YES; }];
    until(^BOOL { return done; });
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(400, 300))
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.acceptsMouseMovedEvents = YES;
    WKWebView *view = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)];
    window.contentView = view;
    NSString *html = @"<!doctype html><style>html,body{margin:0;width:100%;height:100%}</style>"
        "<input id='field' style='position:absolute;left:10px;top:10px;width:200px'>"
        "<div id='pad' style='position:absolute;left:0;top:60px;width:400px;height:240px;overflow:auto'>"
        "<div style='height:2000px'></div></div><script>"
        "window.probe={events:[]};"
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
    check(sp_input_key(window, "a", NULL, 0, true) && sp_input_key(window, "a", NULL, 0, false), @"key accepted");
    check(sp_input_key(window, "Enter", NULL, 0, true) && sp_input_key(window, "Enter", NULL, 0, false), @"named key accepted");
    check(!sp_input_key(window, "NoSuchKey", NULL, 0, true), @"unknown key name rejected");
    until(^BOOL { return [evaluate(view, @"probe.events.filter(e=>e.type==='keydown').length") intValue] >= 2; });
    NSArray *keysSeen = evaluate(view, @"probe.events.filter(e=>e.type==='keydown').map(e=>e.key)");
    check([keysSeen isEqual:@[@"a", @"Enter"]],
        [NSString stringWithFormat:@"keys reach the focused field in a window that is not key: %@", keysSeen]);
    check([evaluate(view, @"document.getElementById('field').value") isEqual:@"a"], @"text input reaches the field");

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
    check(sp_input_key(window, "b", NULL, 0, true) && sp_input_key(window, "b", NULL, 0, false), @"key after child click accepted");
    until(^BOOL { return [[evaluate(child, @"document.getElementById('other').value") description] isEqual:@"b"]; });
    check([evaluate(child, @"document.getElementById('other').value") isEqual:@"b"], @"keys reach the pressed webview");
    check([evaluate(view, @"document.getElementById('field').value") isEqual:@"a"], @"the previous webview keeps its text");
    [child release];

    check(!NSApp.isActive, @"application stays inactive");
    check(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != getpid(), @"this process did not become the frontmost application");
    [window close];
    return failures ? 1 : 0;
}}
