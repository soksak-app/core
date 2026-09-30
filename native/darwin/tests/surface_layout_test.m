// 표시 대기가 단일 앱 DOM만 기다리는지 검사한다. 다른 웹뷰는 출처와 표시 여부에 관계없이
// 독립적으로 렌더링하며, 바쁜 문서가 앱 DOM의 네이티브 배치를 막지 않아야 한다.
// 애플리케이션을 활성화하지 않는다.
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import "surface_layout.h"
#import "capture.h"
#import "webview_geometry.h"
#import "window_facts.h"
#import "private/webkit.h"

static const NSTimeInterval kBusy = 3;

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// 콜백 타임아웃으로 프로세스가 종료돼도 녹화 파일을 남기지 않는다.
static NSString *compositionDirectory;
static void cleanupCompositionRecording(void) {
    if (compositionDirectory == nil) return;
    NSError *error = nil;
    if (![[NSFileManager defaultManager] removeItemAtPath:compositionDirectory error:&error])
        fprintf(stderr, "FAIL: composition recording cleanup: %s\n", error.localizedDescription.UTF8String);
    [compositionDirectory release]; compositionDirectory = nil;
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

// 실제 DOM 경계와 네이티브 영역의 합성은 준비 중에도 양쪽 경계를 보존해야 한다.
// 표시 확인 뒤 커밋을 제어해 진행 중 트랜잭션의 프레임도 녹화한다.
static void checkRecordedComposition(WKWebViewConfiguration *configuration) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 120, 400, 200)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    WKWebView *main = page(window, configuration, NSMakeRect(0, 0, 400, 200), @"sptest://app/composition");
    check(sp_window_set_main_webview(window, main), @"the composition fixture registers its main DOM");
    void *surface = sp_surface_create(main);
    check(surface != NULL, @"the composition fixture creates its native surface");
    if (surface == NULL) { [window close]; [window release]; return; }
    webviewSetFrame(surface, 40, 40, 260, 120);
    webviewSetSurfaceHidden(surface, false);
    NSView *region = (NSView *)sp_surface_native_plane(surface);
    region.wantsLayer = YES;
    region.layer.backgroundColor = [NSColor colorWithSRGBRed:25.0/255 green:27.0/255 blue:36.0/255 alpha:1].CGColor;
    __block BOOL loaded = NO;
    [main evaluateJavaScript:@"document.head.innerHTML='<style>body{margin:0;isolation:isolate}body::before{content:\"\";position:fixed;inset:0;z-index:-1;background:rgb(25,27,36);clip-path:path(\"M0,0H400V200H0ZM40,40v120h260v-120Z\")}</style>';"
        "document.body.innerHTML='<div id=box style=\"position:absolute;left:39px;top:39px;width:260px;height:120px;border:1px solid rgb(43,46,61)\"></div>'"
        completionHandler:^(id value, NSError *error) {
            check(error == nil, @"the composition fixture installs its DOM border"); loaded = YES;
        }];
    until(^BOOL { return loaded; });
    [window orderFrontRegardless];
    __block double shown = 0;
    surfaceLayoutAfterSettled(main, ^(double at, const char *error) {
        check(error == NULL, @"the initial composition fixture is presented"); shown = at;
    });
    until(^BOOL { return shown != 0; });
    char directory[] = "/tmp/soksak-composition-test-XXXXXX";
    BOOL created = mkdtemp(directory) != NULL;
    check(created, @"the composition recording directory is created");
    if (!created) { sp_surface_close(surface); [window close]; [window release]; return; }
    compositionDirectory = [[NSString stringWithUTF8String:directory] copy];
    BOOL opened = sp_capture_open(window.windowNumber, false);
    BOOL started = opened && sp_capture_start(directory);
    check(started, [NSString stringWithFormat:@"the composition recording starts (%s)", sp_capture_error()]);
    if (started) {
        check(sp_capture_wait() > 0, @"the composition recording contains its initial frame");
        surfaceLayoutTraceStart();
        surfaceLayoutBegin(window, 107, ^(int allowed) { check(allowed, @"the composition transaction starts"); });
        webviewSetFrame(surface, 40, 40, 250, 120);
        __block BOOL ready = NO;
        [main evaluateJavaScript:@"document.getElementById('box').style.width='250px'"
            completionHandler:^(id value, NSError *error) {
                check(error == nil, @"the composition DOM border moves during preparation");
                surfaceLayoutAfterPresentation(main, ^{ ready = YES; });
            }];
        until(^BOOL { return ready; });
        waitFrames(window.screen, 1);
        __block BOOL clipped = NO;
        [main evaluateJavaScript:@"document.styleSheets[0].cssRules[1].style.clipPath='path(\"M0,0H400V200H0ZM40,40v120h250v-120Z\")'"
            completionHandler:^(id value, NSError *error) {
                check(error == nil, @"the composition paint clip changes while the native transaction is pending");
                surfaceLayoutAfterPresentation(main, ^{ clipped = YES; });
            }];
        until(^BOOL { return clipped; });
        waitFrames(window.screen, 5);
        check(surfaceLayoutCommit(window, 107), @"the controlled composition transaction commits");
        shown = 0;
        surfaceLayoutAfterSettled(main, ^(double at, const char *error) {
            check(error == NULL, @"the final composition fixture is presented"); shown = at;
        });
        until(^BOOL { return shown != 0; });
        int count = sp_capture_stop(shown);
        check(count >= 2 && !sp_capture_limited(), @"the composition recording includes initial and final frames without truncation");
        double timeline[4] = {0};
        check(surfaceLayoutTraceStop(timeline, 1) == 1, @"the composition recording contains its transaction timeline");
        for (int index = 1; index <= count; index++) {
            NSString *path = [[NSString stringWithUTF8String:directory] stringByAppendingPathComponent:
                [NSString stringWithFormat:@"frame-%04d.bgra", index]];
            NSData *data = [NSData dataWithContentsOfFile:path];
            uint32_t head[3] = {0}; double info[7] = {0};
            BOOL valid = data.length >= sizeof(head) + sizeof(info);
            if (valid) {
                [data getBytes:head length:sizeof(head)];
                [data getBytes:info range:NSMakeRange(sizeof(head), sizeof(info))];
                valid = head[0] > 0 && head[1] > 0 && head[2] >= head[0] * 4 &&
                    data.length == sizeof(head) + sizeof(info) + (size_t)head[2] * head[1] &&
                    info[4] > 0 && info[5] > 0;
            }
            check(valid, [NSString stringWithFormat:@"composition frame %d has complete pixels and metadata", index]);
            if (!valid) continue;
            const uint8_t *pixels = (const uint8_t *)data.bytes + sizeof(head) + sizeof(info);
            double scale = info[4] * info[5];
            BOOL found = NO;
            double borderAt = NAN;
            for (double x = 290; x <= 302 && !found; x += 0.5) {
                BOOL matches = YES;
                for (int offset = -12; offset <= 12; offset += 6) {
                    size_t px = (size_t)floor((info[0] + x) * scale);
                    size_t py = (size_t)floor((info[1] + 100 + offset) * scale);
                    if (px >= head[0] || py >= head[1]) { matches = NO; break; }
                    const uint8_t *rgb = pixels + py * head[2] + px * 4;
                    if (abs((int)rgb[2] - 43) > 3 || abs((int)rgb[1] - 46) > 3 || abs((int)rgb[0] - 61) > 3)
                        matches = NO;
                }
                found = matches;
                if (matches) borderAt = x;
            }
            check(found, [NSString stringWithFormat:@"composition frame %d/%d preserves the right DOM border "
                "(display %.3f, begun %.3f, presented %.3f, committed %.3f)",
                index, count, info[6], timeline[1], timeline[2], timeline[3]]);
            if (index == 1 || info[6] < timeline[3])
                check(borderAt >= 300 && borderAt < 301, [NSString stringWithFormat:
                    @"a pre-commit composition frame retains the initial border (x %.1f)", borderAt]);
            if (index == count)
                check(borderAt >= 290 && borderAt < 291, [NSString stringWithFormat:
                    @"the final composition frame contains the moved border (x %.1f)", borderAt]);
        }
    }
    NSError *cleanupError = nil;
    check([[NSFileManager defaultManager] removeItemAtPath:[NSString stringWithUTF8String:directory] error:&cleanupError],
        [NSString stringWithFormat:@"the composition recording is removed (%@)", cleanupError]);
    if (cleanupError == nil) { [compositionDirectory release]; compositionDirectory = nil; }
    sp_surface_close(surface);
    [window close]; [window release];
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
    atexit(cleanupCompositionRecording);
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

    checkRecordedComposition([[configuration copy] autorelease]);
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
    surfaceLayoutTraceStart();
    surfaceLayoutBegin(window, 105, ^(int allowed) {});
    check(surfaceLayoutCommit(window, 105), @"the first capacity fixture commits");
    surfaceLayoutBegin(window, 106, ^(int allowed) {});
    check(surfaceLayoutCommit(window, 106), @"the second capacity fixture commits");
    size_t capacityCount = surfaceLayoutTraceStop(trace, 1);
    check(capacityCount == 2, [NSString stringWithFormat:
        @"the trace reports all records when output capacity is exceeded (got %zu, expected 2)", capacityCount]);

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
