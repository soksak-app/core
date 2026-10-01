// 등록한 주 웹뷰는 창이 가려져도 문서를 숨기지 않고 animation frame 을 계속 실행하는지 검사한다.
// 배치 표시와 프로젝트 명령은 주 웹뷰의 다음 표시를 기다리므로 가려진 창에서도 끝나야 한다.
// 애플리케이션을 활성화하지 않는다.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "window_facts.h"
#import "private/webkit.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// 창 서버의 가림 상태 변경은 AppKit 이벤트로 도착한다. 애플리케이션 활성화 이벤트는 꺼내지 않는다.
static void pump(void) {
    NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAppKitDefined untilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]
        inMode:NSDefaultRunLoopMode dequeue:NO];
    if (event && event.subtype != NSEventSubtypeApplicationActivated && event.subtype != NSEventSubtypeApplicationDeactivated) {
        [NSApp sendEvent:[NSApp nextEventMatchingMask:NSEventMaskAppKitDefined untilDate:nil inMode:NSDefaultRunLoopMode dequeue:YES]];
    }
    [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
}

static void until(BOOL (^done)(void), NSString *what) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) pump();
    if (!done()) { fprintf(stderr, "FAIL: %s within 10 seconds\n", what.UTF8String); exit(1); }
}

@interface SPNavigation : NSObject <WKNavigationDelegate>
@property BOOL finished;
@end

@implementation SPNavigation
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation { self.finished = YES; }
@end

static NSString *visibility(WKWebView *view) {
    __block NSString *result = nil;
    __block BOOL done = NO;
    [view evaluateJavaScript:@"document.visibilityState" completionHandler:^(id value, NSError *error) {
        result = error ? [NSString stringWithFormat:@"error: %@", error.localizedDescription] : [value copy];
        done = YES;
    }];
    until(^BOOL { return done; }, @"WebKit did not report document visibility");
    return [result autorelease];
}

// WebKit 이 창의 가림 상태를 웹 프로세스의 activity state 로 반영한 뒤에 돌아온다.
static void afterActivityState(WKWebView *view) {
    __block BOOL done = NO;
    [view _doAfterActivityStateUpdate:^{ done = YES; }];
    until(^BOOL { return done; }, @"WebKit did not apply the activity state");
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSWindow *window = [[[NSWindow alloc] initWithContentRect:NSMakeRect(60, 60, 400, 300)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO] autorelease];
    [window setReleasedWhenClosed:NO];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)] autorelease];
    window.contentView = main;
    check(sp_window_set_main_webview(window, main), @"the main webview is registered");
    SPNavigation *navigation = [[SPNavigation new] autorelease];
    main.navigationDelegate = navigation;
    [main loadHTMLString:@"<!doctype html><body>main</body>" baseURL:nil];
    [window orderFrontRegardless];
    until(^BOOL { return navigation.finished && (window.occlusionState & NSWindowOcclusionStateVisible) != 0; },
        @"the main page did not load in a visible window");
    afterActivityState(main);
    check([visibility(main) isEqualToString:@"visible"], @"the uncovered document is visible");

    NSWindow *cover = [[[NSWindow alloc] initWithContentRect:NSMakeRect(20, 20, 480, 380)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO] autorelease];
    [cover setReleasedWhenClosed:NO];
    cover.backgroundColor = NSColor.blackColor;
    [cover orderFrontRegardless];
    until(^BOOL { return (window.occlusionState & NSWindowOcclusionStateVisible) == 0; }, @"the covering window did not occlude the main window");
    afterActivityState(main);
    NSString *covered = visibility(main);
    check([covered isEqualToString:@"visible"], [NSString stringWithFormat:@"the covered document stays visible (actual %@)", covered]);

    __block NSString *frame = nil;
    [main callAsyncJavaScript:@"return await new Promise((resolve) => requestAnimationFrame(() => resolve('frame')));"
        arguments:nil inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:^(id value, NSError *error) {
            frame = error ? [[NSString alloc] initWithFormat:@"error: %@", error.localizedDescription] : [value copy];
        }];
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:5];
    while (!frame && deadline.timeIntervalSinceNow > 0) pump();
    check([frame isEqualToString:@"frame"], [NSString stringWithFormat:@"the covered document runs an animation frame (result %@)", frame ?: @"none within 5 seconds"]);
    [frame release];

    check(!NSApp.isActive, @"application stays inactive");
    [cover close];
    [window close];
    return failures ? 1 : 0;
}}
