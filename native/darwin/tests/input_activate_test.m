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

typedef struct { BOOL done; sp_activate_result result; char frontmost[256]; } SPActivation;

static void activated(void *context, sp_activate_result result, const char *frontmost) {
    SPActivation *state = context;
    state->result = result;
    snprintf(state->frontmost, sizeof state->frontmost, "%s", frontmost ?: "");
    state->done = YES;
}

static SPActivation activate(NSWindow *window, double timeout) {
    __block SPActivation state = {NO, SP_ACTIVATE_DONE, ""};
    sp_input_activate(window, timeout, activated, &state);
    until(^BOOL { return state.done; });
    return state;
}

// 활성 상태 전송이 끝났다고 알리지 않는 웹뷰.
@interface SPStalledWebView : WKWebView
@end
@implementation SPStalledWebView
- (void)_doAfterActivityStateUpdate:(void (^)(void))completionHandler {}
@end

// 활성 상태 전송을 기다리는 동안 다른 창이 키 창이 되는 웹뷰.
@interface SPYieldingWebView : WKWebView
@property(assign) NSWindow *other;
@end
@implementation SPYieldingWebView
- (void)_doAfterActivityStateUpdate:(void (^)(void))completionHandler {
    [super _doAfterActivityStateUpdate:completionHandler];
    [self.other makeKeyWindow];
}
@end

// 키 창이 될 수 없는 창.
@interface SPUnkeyableWindow : NSWindow
@end
@implementation SPUnkeyableWindow
- (BOOL)canBecomeKeyWindow { return NO; }
@end

static NSWindow *makeWindow(Class type, NSView *content) {
    NSWindow *window = [[type alloc] initWithContentRect:NSMakeRect(120, 120, 400, 300)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.ignoresMouseEvents = YES;
    if (content) window.contentView = content;
    return [window autorelease];
}

// 활성화가 멈춘 단계를 결과로 알리는지 조건을 만들어 확인한다.
static void checkFailures(void) {
    check(activate(nil, 1).result == SP_ACTIVATE_REJECTED, @"activating without a window is rejected");

    // 활성화가 금지된 애플리케이션은 시스템이 활성화하지 않는다.
    NSWindow *refused = makeWindow(NSWindow.class, nil);
    SPActivation state = activate(refused, 1);
    check(state.result == SP_ACTIVATE_REFUSED && state.frontmost[0] != 0 && !NSApp.isActive,
        [NSString stringWithFormat:@"a refused activation reports the frontmost application (%d, %s)", state.result, state.frontmost]);
    [refused close];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    SPStalledWebView *stalled = [[[SPStalledWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)] autorelease];
    NSWindow *pending = makeWindow(NSWindow.class, stalled);
    state = activate(pending, 1);
    check(state.result == SP_ACTIVATE_PENDING,
        [NSString stringWithFormat:@"a webview that does not apply the active state reports pending (%d)", state.result]);

    // Hidden document views are not input targets. They must not hold an explicit
    // activation request while a visible window is becoming active.
    SPStalledWebView *hiddenStalled = [[[SPStalledWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)] autorelease];
    hiddenStalled.hidden = YES;
    NSWindow *hiddenWindow = makeWindow(NSWindow.class, hiddenStalled);
    state = activate(hiddenWindow, 1);
    check(state.result == SP_ACTIVATE_DONE,
        [NSString stringWithFormat:@"a hidden webview does not block activation (%d)", state.result]);

    NSWindow *other = makeWindow(NSWindow.class, nil);
    [other orderFront:nil];
    SPYieldingWebView *yielding = [[[SPYieldingWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)] autorelease];
    yielding.other = other;
    // 앱의 표면처럼 문서를 읽은 웹뷰로 검사한다.
    [yielding loadHTMLString:@"<!doctype html><script>window.probe = true</script>" baseURL:nil];
    until(^BOOL { return [evaluate(yielding, @"Boolean(window.probe)") boolValue]; });
    NSWindow *lost = makeWindow(NSWindow.class, yielding);
    state = activate(lost, 5);
    check(state.result == SP_ACTIVATE_LOST && other.isKeyWindow,
        [NSString stringWithFormat:@"a window that loses key status before the state is applied reports lost (%d)", state.result]);

    // 앱이 활성인 상태에서 키 창이 될 수 없는 창을 활성화한다.
    state = activate(other, 5);
    check(state.result == SP_ACTIVATE_DONE,
        [NSString stringWithFormat:@"an ordinary window activates (%d, frontmost %s)", state.result, state.frontmost]);
    NSWindow *unkeyable = makeWindow(SPUnkeyableWindow.class, nil);
    state = activate(unkeyable, 1);
    check(state.result == SP_ACTIVATE_NOT_KEY && NSApp.isActive,
        [NSString stringWithFormat:@"an active application whose window cannot become key reports not key (%d)", state.result]);

    for (NSWindow *window in @[pending, hiddenWindow, other, lost, unkeyable]) [window close];
}

// tests/support/no_activation.m: 이 검사는 make test-activation 에서 앱을 활성화한다.
void sp_test_declare_activation(void);

int main(void) { @autoreleasepool {
    sp_test_declare_activation();
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    checkFailures();
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

    SPActivation state = activate(window, 5);
    check(state.result == SP_ACTIVATE_DONE,
        [NSString stringWithFormat:@"activation completes (%d, frontmost %s)", state.result, state.frontmost]);
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
