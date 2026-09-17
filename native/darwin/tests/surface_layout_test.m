// 표시 대기가 메인 문서와 같은 출처의 보이는 문서만 기다리고, 외부 문서와 숨긴 문서는 기다리지
// 않는지 검사한다. 각 웹뷰의 웹 프로세스를 스크립트로 붙잡은 동안 대기가 끝나는 시간을 잰다.
// 애플리케이션을 활성화하지 않는다.
#import <Cocoa/Cocoa.h>
#import "surface_layout.h"
#import "private/webkit.h"

static const NSTimeInterval kBusy = 1.5;

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

static WKWebView *page(NSWindow *window, WKWebViewConfiguration *configuration, NSRect frame, NSString *address) {
    WKWebView *view = [[[WKWebView alloc] initWithFrame:frame configuration:configuration] autorelease];
    [window.contentView addSubview:view];
    [view loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:address]]];
    __block BOOL ready = NO;
    until(^BOOL {
        if (!view.isLoading && !ready) {
            [view evaluateJavaScript:@"document.readyState" completionHandler:^(id value, NSError *error) {
                ready = [value isEqual:@"complete"];
            }];
        }
        return ready;
    });
    return view;
}

// busy 의 웹 프로세스를 붙잡은 뒤 메인 웹뷰 크기를 바꾸고, 표시 대기가 끝날 때까지의 시간을 반환한다.
static NSTimeInterval waitWhileBusy(WKWebView *main, WKWebView *busy, SPBusySignal *signal) {
    signal.started = NO;
    __block BOOL released = NO;
    [busy evaluateJavaScript:[NSString stringWithFormat:
        @"webkit.messageHandlers.busy.postMessage(0); {const end=Date.now()+%d; while(Date.now()<end){}} true",
        (int)(kBusy * 1000)] completionHandler:^(id value, NSError *error) { released = YES; }];
    until(^BOOL { return signal.started; });
    NSRect frame = main.frame;
    frame.size.width -= 1;
    main.frame = frame;
    __block BOOL presented = NO;
    NSDate *start = [NSDate date];
    surfaceLayoutAfterPresentation(main, ^{ presented = YES; });
    until(^BOOL { return presented; });
    NSTimeInterval took = -start.timeIntervalSinceNow;
    until(^BOOL { return released; });
    return took;
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

    NSTimeInterval externalWait = waitWhileBusy(main, external, signal);
    check(externalWait < kBusy / 2,
        [NSString stringWithFormat:@"a busy external document does not delay the presentation wait (%.3fs)", externalWait]);

    NSTimeInterval applicationWait = waitWhileBusy(main, application, signal);
    check(applicationWait >= kBusy * 0.8,
        [NSString stringWithFormat:@"the wait includes a visible document of the main origin (%.3fs)", applicationWait]);

    application.hidden = YES;
    NSTimeInterval hiddenWait = waitWhileBusy(main, application, signal);
    check(hiddenWait < kBusy / 2,
        [NSString stringWithFormat:@"a hidden document of the main origin does not delay the wait (%.3fs)", hiddenWait]);

    [window close];
    [window release];
    return failures ? 1 : 0;
}}
