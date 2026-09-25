// 표시 대기가 단일 앱 DOM만 기다리는지 검사한다. 다른 웹뷰는 출처와 표시 여부에 관계없이
// 독립적으로 렌더링하며, 바쁜 문서가 앱 DOM의 네이티브 배치를 막지 않아야 한다.
// 애플리케이션을 활성화하지 않는다.
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
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

// 화면 갱신을 정해진 수만큼 센다.
@interface SPFrames : NSObject
@property int left;
- (void)tick:(CADisplayLink *)link;
@end
@implementation SPFrames
- (void)tick:(CADisplayLink *)link {
    if (--self.left == 0) [link invalidate];
}
@end

static void waitFrames(NSScreen *screen, int count) {
    SPFrames *frames = [[SPFrames new] autorelease];
    frames.left = count;
    [[screen displayLinkWithTarget:frames selector:@selector(tick:)]
        addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
    until(^BOOL { return frames.left == 0; });
}

// 창의 배치 트랜잭션이 열린 동안 끝난 표시는 대기를 끝내지 않는다. 트랜잭션을 연 요청보다 새 요청이
// 트랜잭션을 연장하면 이전 요청의 확정은 실패하고, 대기는 새 요청이 확정된 뒤에 끝난다.
static void checkSettledWaitsForLayout(NSWindow *window, WKWebView *main) {
    __block int order = 0;
    __block int settledAt = 0;
    surfaceLayoutBegin(window, 101, ^(int allowed) {});
    surfaceLayoutAfterSettled(main, ^(double displayed, const char *error) {
        check(error == NULL, @"a settled layout has no DOM error");
        settledAt = ++order;
    });
    surfaceLayoutBegin(window, 102, ^(int allowed) {});
    check(!surfaceLayoutCommit(window, 101), @"an older request does not commit an extended layout transaction");
    waitFrames(window.screen, 5);
    check(surfaceLayoutCommit(window, 102), @"the newest request commits the layout transaction");
    int committedAt = ++order;
    until(^BOOL { return settledAt != 0; });
    check(settledAt > committedAt,
        [NSString stringWithFormat:@"the settled wait ends after the open layout transaction commits (settled %d, committed %d)",
            settledAt, committedAt]);
}

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

typedef struct { NSTimeInterval took; BOOL beforeRelease; double requested; double finished; double displayed; } SPWait;

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
    __block double displayed = 0;
    __block double finished = 0;
    // 요청·완료·표시 시각은 모두 같은 시계(CACurrentMediaTime)로 잰다.
    double requested = CACurrentMediaTime() * 1000;
    surfaceLayoutAfterSettled(main, ^(double at, const char *error) {
        check(error == NULL, @"a displayed frame has no DOM error");
        took = -start.timeIntervalSinceNow;
        finished = CACurrentMediaTime() * 1000;
        displayed = at;
        presented = YES;
    });
    until(^BOOL { return presented && released; });
    return (SPWait){ took, beforeRelease, requested, finished, displayed };
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
    WKWebView *sameOrigin = page(window, [[configuration copy] autorelease], NSMakeRect(200, 0, 200, 300), @"sptest://app/document");
    WKWebView *external = page(window, [[configuration copy] autorelease], NSMakeRect(400, 0, 200, 300), @"sptest://external/page");
    [window orderBack:nil];
    __block BOOL painted = NO;
    [main _doAfterNextPresentationUpdate:^{ painted = YES; }];
    until(^BOOL { return painted; });

    checkSettledWaitsForLayout(window, main);

    // 열린 트랜잭션에서도 웹 프로세스의 새 배치 확인이 완료되어야 커밋 전에 기다릴 수 있다.
    // 진단 추적은 이 트랜잭션의 시작, 앱 DOM 표시 확인, 커밋 시각을 녹화 프레임과 같은 시계로 남긴다.
    surfaceLayoutTraceStart();
    double traceBegan = CACurrentMediaTime() * 1000;
    __block BOOL prepared = NO;
    __block BOOL mainReady = NO;
    surfaceLayoutBegin(window, 103, ^(int allowed) { prepared = allowed; });
    check(prepared, @"a presentation preparation starts");
    sameOrigin.frame = NSMakeRect(180, 0, 220, 300);
    [main evaluateJavaScript:@"document.body.style.width='180px'" completionHandler:^(id value, NSError *error) {
        check(error == nil, @"the main DOM changes during preparation");
        surfaceLayoutAfterPresentation(main, ^{ mainReady = YES; });
    }];
    until(^BOOL { return mainReady; });
    check(surfaceLayoutCommit(window, 103), @"the app DOM confirms its new layout before native commit");
    double traceEnded = CACurrentMediaTime() * 1000;
    double trace[4 * 4];
    size_t traced = surfaceLayoutTraceStop(trace, 4);
    check(traced == 1 && trace[0] == 103 && traceBegan <= trace[1] && trace[1] <= trace[2] && trace[2] <= trace[3] &&
        trace[3] <= traceEnded,
        [NSString stringWithFormat:@"the trace records ticket 103 begun <= presented <= committed within the transaction "
            "(%zu records: ticket %.0f, %.3f, %.3f, %.3f within %.3f..%.3f)",
            traced, trace[0], trace[1], trace[2], trace[3], traceBegan, traceEnded]);
    surfaceLayoutBegin(window, 104, ^(int allowed) {});
    check(surfaceLayoutCommit(window, 104) && surfaceLayoutTraceStop(trace, 4) == 0,
        @"a stopped trace records nothing");

    SPWait externalWait = waitWhileBusy(main, external, signal);
    check(externalWait.beforeRelease,
        [NSString stringWithFormat:@"a busy external document does not delay the presentation wait (%.3fs)", externalWait.took]);

    SPWait visibleWait = waitWhileBusy(main, sameOrigin, signal);
    check(visibleWait.beforeRelease,
        [NSString stringWithFormat:@"a same-origin document does not own the app DOM presentation wait (%.3fs)", visibleWait.took]);
    // 표시 시각은 요청보다 늦고, 대기를 마친 시점에서 한 번의 화면 갱신 안이다.
    // 표시 시각은 디스플레이 링크 틱의 목표 시각이다. 메인 스레드가 늦으면 틱이 목표 시각을 지나서
    // 도착하므로 표시 시각이 완료 시각보다 앞설 수 있다. 완료보다 늦다는 것은 약속이 아니다.
    check(visibleWait.displayed > visibleWait.requested && visibleWait.displayed < visibleWait.finished + 100,
        [NSString stringWithFormat:@"the wait reports the display time of the presented frame (requested %.1fms, finished %.1fms, displayed %.1fms)",
            visibleWait.requested, visibleWait.finished, visibleWait.displayed]);

    sameOrigin.hidden = YES;
    SPWait hiddenWait = waitWhileBusy(main, sameOrigin, signal);
    check(hiddenWait.beforeRelease,
        [NSString stringWithFormat:@"a hidden document of the main origin does not delay the wait (%.3fs)", hiddenWait.took]);

    SPWait mainWait = waitWhileBusy(main, main, signal);
    check(!mainWait.beforeRelease, @"the app DOM must still confirm its own presentation");

    [window close];
    [window release];
    return failures ? 1 : 0;
}}
