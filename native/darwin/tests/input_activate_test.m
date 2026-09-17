// 창을 활성화한 뒤 버튼 없는 이동이 페이지의 호버를 갱신하는지 검사한다.
//
// 이 검사는 애플리케이션을 활성화하므로 사용자의 포커스를 가져간다. make test 에 포함하지 않고
// make test-activation 으로만 실행한다. 이동은 추적 영역 소유자에게 직접 전달하므로 실제 포인터 위치와 무관하다.
#import <Cocoa/Cocoa.h>
#import "input_inject.h"
#import "private/webkit.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// 활성화 알림은 애플리케이션 이벤트로 도착하므로 이벤트를 꺼내 처리하며 기다린다.
static void until(BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny
            untilDate:[NSDate dateWithTimeIntervalSinceNow:0.01] inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event) [NSApp sendEvent:event];
    }
    if (!done()) { fprintf(stderr, "FAIL: no answer within 10 seconds\n"); exit(1); }
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

typedef struct { BOOL done; bool ok; } SPActivation;

static void activated(void *context, bool ok) {
    SPActivation *state = context;
    state->ok = ok;
    state->done = YES;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 120, 400, 300)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.ignoresMouseEvents = YES;
    WKWebView *view = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)];
    window.contentView = view;
    NSString *html = @"<!doctype html><style>html,body{margin:0;width:100%;height:100%}"
        "#target{position:absolute;left:100px;top:50px;width:200px;height:200px}"
        "#target:hover{background:rgb(255,0,0)}</style><div id='target'></div><script>"
        "window.probe={events:[]};"
        "for (const type of ['pointerover','pointermove'])"
        " addEventListener(type,e=>probe.events.push({type,trusted:e.isTrusted,x:e.clientX,y:e.clientY}),true);"
        "</script>";
    [view loadHTMLString:html baseURL:nil];
    [window orderFront:nil];
    until(^BOOL { return [evaluate(view, @"Boolean(window.probe)") boolValue]; });

    __block SPActivation state = {NO, false};
    sp_input_activate(window, 5, activated, &state);
    until(^BOOL { return state.done; });
    check(state.ok, @"activation completes");
    check(NSApp.isActive && window.isKeyWindow, @"the application is active and the window is key");

    check(sp_input_pointer(window, 150, 100, 0, 0, 0, 0) == SP_INPUT_DELIVERED, @"move delivered");
    check(sp_input_pointer(window, 170, 110, 0, 0, 0, 0) == SP_INPUT_DELIVERED, @"second move delivered");
    drain(view);
    NSArray *moves = evaluate(view, @"probe.events.filter(e=>e.type==='pointermove')");
    check(moves.count >= 2 && ![[moves valueForKey:@"trusted"] containsObject:@NO]
        && [moves.lastObject[@"x"] doubleValue] == 170 && [moves.lastObject[@"y"] doubleValue] == 110,
        [NSString stringWithFormat:@"moves reach the page as trusted pointermove at the requested point: %@", moves]);
    check([evaluate(view, @"probe.events.some(e=>e.type==='pointerover'&&e.trusted)") boolValue], @"the target receives a trusted pointerover");
    check([evaluate(view, @"getComputedStyle(document.getElementById('target')).backgroundColor") isEqual:@"rgb(255, 0, 0)"],
        @"the :hover style applies to the element under the point");
    [window close];
    return failures ? 1 : 0;
}}
