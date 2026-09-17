// 표시 대기가 메인 문서와 같은 출처의 보이는 문서만 기다리고, 외부 문서와 숨긴 문서는 기다리지
// 않는지 검사한다. 각 웹뷰의 웹 프로세스를 스크립트로 붙잡은 동안 대기가 그 스크립트보다 먼저 끝나는지 본다.
// 애플리케이션을 활성화하지 않는다.
#import <Cocoa/Cocoa.h>
#import "surface_layout.h"
#import "private/webkit.h"

static const NSTimeInterval kBusy = 3;

static int failures = 0;

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

// 요청한 주소마다 같은 빈 문서를 돌려준다. 주소의 호스트가 출처를 정한다.
@interface SPPageScheme : NSObject <WKURLSchemeHandler>
@end
@implementation SPPageScheme
- (void)webView:(WKWebView *)view startURLSchemeTask:(id<WKURLSchemeTask>)task {
    NSData *body = [@"<!doctype html><body style='margin:0'></body>" dataUsingEncoding:NSUTF8StringEncoding];
    NSURLResponse *response = [[[NSURLResponse alloc] initWithURL:task.request.URL MIMEType:@"text/html"
        expectedContentLength:(NSInteger)body.length textEncodingName:@"utf-8"] autorelease];
    [task didReceiveResponse:response];
    [task didReceiveData:body];
    [task didFinish];
}
- (void)webView:(WKWebView *)view stopURLSchemeTask:(id<WKURLSchemeTask>)task {}
@end

// 바쁜 스크립트가 시작했다는 메시지를 받는다.
@interface SPBusySignal : NSObject <WKScriptMessageHandler>
@property BOOL started;
@end
@implementation SPBusySignal
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    self.started = YES;
}
@end

// 문서 불러오기가 끝나면 알린다.
@interface SPLoaded : NSObject <WKNavigationDelegate>
@property BOOL finished;
@end
@implementation SPLoaded
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation { self.finished = YES; }
@end

static WKWebView *page(NSWindow *window, WKWebViewConfiguration *configuration, NSRect frame, NSString *address) {
    WKWebView *view = [[[WKWebView alloc] initWithFrame:frame configuration:configuration] autorelease];
    [window.contentView addSubview:view];
    SPLoaded *loaded = [[SPLoaded new] autorelease];
    view.navigationDelegate = loaded;
    [view loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:address]]];
    until(^BOOL { return loaded.finished; });
    view.navigationDelegate = nil;
    return view;
}

typedef struct { NSTimeInterval took; BOOL beforeRelease; } SPWait;

// busy 의 웹 프로세스를 붙잡은 뒤 메인 웹뷰 크기를 바꾸고, 표시 대기가 끝날 때까지의 시간과 그 대기가
// busy 의 스크립트가 끝나기 전에 끝났는지 반환한다. 순서로 판정하므로 기계 부하와 무관하다.
static SPWait waitWhileBusy(WKWebView *main, WKWebView *busy, SPBusySignal *signal) {
    signal.started = NO;
    __block BOOL released = NO;
    __block BOOL presented = NO;
    __block BOOL beforeRelease = NO;
    [busy evaluateJavaScript:[NSString stringWithFormat:
        @"webkit.messageHandlers.busy.postMessage(0); {const end=Date.now()+%d; while(Date.now()<end){}} true",
        (int)(kBusy * 1000)] completionHandler:^(id value, NSError *error) { beforeRelease = presented; released = YES; }];
    until(^BOOL { return signal.started; });
    NSRect frame = main.frame;
    frame.size.width -= 1;
    main.frame = frame;
    NSDate *start = [NSDate date];
    __block NSTimeInterval took = 0;
    surfaceLayoutAfterPresentation(main, ^{ took = -start.timeIntervalSinceNow; presented = YES; });
    until(^BOOL { return presented && released; });
    return (SPWait){ took, beforeRelease };
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 120, 600, 300)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    SPPageScheme *scheme = [[SPPageScheme new] autorelease];
    SPBusySignal *signal = [[SPBusySignal new] autorelease];
    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration new] autorelease];
    [configuration setURLSchemeHandler:scheme forURLScheme:@"sptest"];
    [configuration.userContentController addScriptMessageHandler:signal name:@"busy"];
    // 웹뷰마다 웹 프로세스를 따로 쓰도록 출처가 같은 문서도 별도 구성으로 만든다.
    WKWebView *main = page(window, configuration, NSMakeRect(0, 0, 200, 300), @"sptest://app/main");
    WKWebView *application = page(window, [[configuration copy] autorelease], NSMakeRect(200, 0, 200, 300), @"sptest://app/surface");
    WKWebView *external = page(window, [[configuration copy] autorelease], NSMakeRect(400, 0, 200, 300), @"sptest://external/page");
    [window orderBack:nil];
    __block BOOL painted = NO;
    [main _doAfterNextPresentationUpdate:^{ painted = YES; }];
    until(^BOOL { return painted; });

    SPWait externalWait = waitWhileBusy(main, external, signal);
    check(externalWait.beforeRelease,
        [NSString stringWithFormat:@"a busy external document does not delay the presentation wait (%.3fs)", externalWait.took]);

    SPWait visibleWait = waitWhileBusy(main, application, signal);
    check(!visibleWait.beforeRelease,
        [NSString stringWithFormat:@"the wait includes a visible document of the main origin (%.3fs)", visibleWait.took]);

    application.hidden = YES;
    SPWait hiddenWait = waitWhileBusy(main, application, signal);
    check(hiddenWait.beforeRelease,
        [NSString stringWithFormat:@"a hidden document of the main origin does not delay the wait (%.3fs)", hiddenWait.took]);

    [window close];
    [window release];
    return failures ? 1 : 0;
}}
