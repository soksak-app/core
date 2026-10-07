// 페이지를 새 WebContent 프로세스에서 다시 읽는 동안 창의 배치 트랜잭션을 열어 두고 그 안에서 제목줄 높이를 바꾼 뒤,
// 새 페이지의 첫 표시에 커밋하면 이전 페이지가 새 제목줄과 함께, 또는 새 페이지가 이전 제목줄과 함께 화면에 나오는
// 프레임이 없는지 윈도 서버가 보여 준 창 녹화로 검사한다. 트랜잭션을 연 채로 새 페이지의 첫 그리기가 표시되는지,
// 곧 시작이 멈추지 않는지도 잰다(docs/spec/native-surfaces.md#title-bar-height). 애플리케이션을 활성화하지 않는다.
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <WebKit/WebKit.h>
#import "surface_layout.h"
#import "window_controls.h"
#import "webview_navigation.h"
#import "window_facts.h"
#import "private/webkit.h"
#import "capture.h"
#import "support/capture_frame.m"

static const int kRefreshes = 12;
// 이전 페이지는 배율 1 의 40pt 첫 행, 새 페이지는 배율 2 의 72pt 첫 행을 그린다. 페이지는 한 색으로 칠하고 그 색으로
// 어느 페이지가 보였는지 가른다.
static const double kOldRow = 40, kNewRow = 72;
static const uint8_t kOld[3] = {40, 170, 90}, kNew[3] = {230, 120, 30};

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static NSString *recordingDirectory;
static void cleanupRecording(void) {
    if (recordingDirectory == nil) return;
    NSError *error = nil;
    if (![[NSFileManager defaultManager] removeItemAtPath:recordingDirectory error:&error])
        fprintf(stderr, "FAIL: title bar reload recording cleanup: %s\n", error.localizedDescription.UTF8String);
    [recordingDirectory release]; recordingDirectory = nil;
}

// 조건을 10초까지 기다린다. 기다린 시간(ms)을 반환하고, 넘으면 what 을 실패로 알리고 끝낸다.
static double until(NSString *what, BOOL (^done)(void)) {
    double start = CACurrentMediaTime() * 1000;
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                               beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    if (!done()) { fprintf(stderr, "FAIL: %s within 10 seconds\n", what.UTF8String); cleanupRecording(); exit(1); }
    return CACurrentMediaTime() * 1000 - start;
}

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
    until(@"the display refreshed", ^BOOL { return frames.left == 0; });
}

// 페이지는 메인 페이지처럼 head 의 render-blocking module 로 시작 문서를 가져온 뒤에 첫 화면을 그린다.
static NSString *page(const uint8_t *color) {
    return [NSString stringWithFormat:@"<!doctype html><html><head><script type=\"module\" blocking=\"render\">"
        "import start from \"sptitle://page/start.json\" with { type: \"json\" };"
        "document.body.style.background = start.background;</script></head>"
        "<body style=\"margin:0;background:rgb(%d,%d,%d)\"></body></html>", color[0], color[1], color[2]];
}

// 웹뷰의 loading 이 시작된 뒤 끝나면 그 다음 표시 갱신에 done 을 부른다. window_reveal.m 의 창 드러내기와 같은 때다.
@interface SPAfterLoad : NSObject {
@public
    WKWebView *webview;
    BOOL started;
    void (^done)(void);
}
@end
@implementation SPAfterLoad
- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary *)change context:(void *)context {
    if (webview.loading) { started = YES; return; }
    if (!started) return;
    fprintf(stdout, "observe: the load ended at %.1fms\n", CACurrentMediaTime() * 1000);
    [webview removeObserver:self forKeyPath:@"loading"];
    [webview _doAfterNextPresentationUpdate:done];
}
@end

// 시험 문서를 내 주는 처리기. 두 번째 페이지는 다시 읽은 페이지이고, 그 페이지의 시작 문서 요청에 답하기 전에
// surfaceLayoutStartPage 로 제목줄을 새 행 높이로 정한다. 호스트가 시작 문서 요청에 하는 일과 같다.
@interface SPPages : NSObject <WKURLSchemeHandler> {
@public
    NSWindow *window;
    int requests;
    double set;
    BOOL ready;
    NSString *failure;
}
@end
@implementation SPPages
- (void)webView:(WKWebView *)webView startURLSchemeTask:(id<WKURLSchemeTask>)task {
    BOOL start = [task.request.URL.path isEqualToString:@"/start.json"];
    if (!start) requests++;
    BOOL reload = requests > 1;
    if (start && reload) {
        fprintf(stdout, "observe: the start document of the reloaded page is requested while the web view %s loading\n",
            webView.loading ? "is" : "is not");
        set = CACurrentMediaTime() * 1000;
        surfaceLayoutStartPage(window, 301, kNewRow, ^(const char *problem) {
            self->ready = YES;
            self->failure = problem ? [[NSString alloc] initWithUTF8String:problem] : nil;
        });
    }
    const uint8_t *color = reload ? kNew : kOld;
    NSData *body = [(start ? [NSString stringWithFormat:@"{\"background\":\"rgb(%d,%d,%d)\"}", color[0], color[1], color[2]]
        : page(color)) dataUsingEncoding:NSUTF8StringEncoding];
    NSURLResponse *response = [[[NSURLResponse alloc] initWithURL:task.request.URL
        MIMEType:start ? @"application/json" : @"text/html"
        expectedContentLength:(NSInteger)body.length textEncodingName:@"utf-8"] autorelease];
    void (^answer)(void) = ^{
        [task didReceiveResponse:response];
        [task didReceiveData:body];
        [task didFinish];
    };
    // 다시 읽은 페이지의 시작 문서는 100ms 뒤에 답한다. 시작이 느린 페이지처럼 이전 페이지가 열린 트랜잭션 동안
    // 여러 프레임 화면에 남아, 그 프레임의 제목줄을 녹화에서 관측한다.
    if (start && reload) dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC), dispatch_get_main_queue(), answer);
    else answer();
}
- (void)webView:(WKWebView *)webView stopURLSchemeTask:(id<WKURLSchemeTask>)task {}
@end

typedef enum { SPShownOld, SPShownNew, SPShownOther } SPShown;

// 녹화 프레임 하나에서 보인 페이지와 창 단추가 차지한 행의 가운데(창 위 기준 pt)를 잰다.
static double measure(NSData *data, double *displayed, SPShown *shown, uint8_t seen[3]) {
    uint32_t head[3] = {0}; double info[7] = {0};
    *shown = SPShownOther;
    if (data.length < sizeof(head) + sizeof(info)) return NAN;
    [data getBytes:head length:sizeof(head)];
    [data getBytes:info range:NSMakeRange(sizeof(head), sizeof(info))];
    if (!(head[0] > 0 && head[1] > 0 && head[2] >= head[0] * 4 &&
          data.length == sizeof(head) + sizeof(info) + (size_t)head[2] * head[1] && info[4] > 0 && info[5] > 0))
        return NAN;
    *displayed = info[6];
    const uint8_t *pixels = (const uint8_t *)data.bytes + sizeof(head) + sizeof(info);
    double scale = info[4] * info[5];
    size_t bx = (size_t)floor((info[0] + 300) * scale), by = (size_t)floor((info[1] + 150) * scale);
    if (bx >= head[0] || by >= head[1]) return NAN;
    const uint8_t *background = pixels + by * head[2] + bx * 4;
    // BGRA
    seen[0] = background[2]; seen[1] = background[1]; seen[2] = background[0];
    BOOL old = abs(seen[0] - kOld[0]) < 24 && abs(seen[1] - kOld[1]) < 24 && abs(seen[2] - kOld[2]) < 24;
    BOOL new = abs(seen[0] - kNew[0]) < 24 && abs(seen[1] - kNew[1]) < 24 && abs(seen[2] - kNew[2]) < 24;
    *shown = old ? SPShownOld : new ? SPShownNew : SPShownOther;
    long top = (long)floor(info[1] * scale);
    long first = -1, last = -1;
    for (long y = (long)floor((info[1] + 6) * scale); y < (long)floor((info[1] + 120) * scale) && y < (long)head[1]; y++) {
        for (long x = (long)floor((info[0] + 6) * scale); x < (long)floor((info[0] + 90) * scale) && x < (long)head[0]; x++) {
            const uint8_t *p = pixels + (size_t)y * head[2] + (size_t)x * 4;
            if (abs((int)p[0] - background[0]) > 40 || abs((int)p[1] - background[1]) > 40 ||
                abs((int)p[2] - background[2]) > 40) {
                if (first < 0) first = y;
                last = y;
                break;
            }
        }
    }
    if (first < 0) return NAN;
    return ((first - top) + (last - top) + 1) / 2.0 / scale;
}

int main(void) { @autoreleasepool {
    atexit(cleanupRecording);
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSWindow *window = [[[NSWindow alloc] initWithContentRect:NSMakeRect(140, 140, 480, 240)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable
            | NSWindowStyleMaskResizable | NSWindowStyleMaskFullSizeContentView
        backing:NSBackingStoreBuffered defer:NO] autorelease];
    [window setReleasedWhenClosed:NO];
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    window.titlebarAppearsTransparent = YES;
    window.titleVisibility = NSWindowTitleHidden;
    SPPages *pages = [[SPPages new] autorelease];
    pages->window = window;
    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration new] autorelease];
    [configuration setURLSchemeHandler:pages forURLScheme:@"sptitle"];
    WKWebView *webview = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 480, 240)
        configuration:configuration] autorelease];
    window.contentView = webview;
    check(sp_window_set_main_webview(window, webview), @"the web view is the window's registered main webview");
    check(sp_webview_replace_documents_in_new_process(webview), @"the page reloads in a new WebContent process");
    // 아직 보이지 않는 창은 이전 페이지가 없으므로 트랜잭션 없이 바로 정한다.
    __block BOOL hiddenReady = NO;
    __block BOOL hiddenFailed = NO;
    surfaceLayoutStartPage(window, 300, kOldRow, ^(const char *problem) { hiddenReady = YES; hiddenFailed = problem != NULL; });
    check(hiddenReady && !hiddenFailed && windowTitlebarHeight(window) == kOldRow,
        @"a window that is not visible takes the 40pt title bar of the old row at once");
    check(!surfaceLayoutCommit(window, 300), @"a window that is not visible keeps no start transaction open");
    [window orderFrontRegardless];

    __block BOOL loaded = NO;
    SPAfterLoad *first = [[SPAfterLoad new] autorelease];
    first->webview = webview;
    first->done = [[^{ loaded = YES; } copy] autorelease];
    [webview addObserver:first forKeyPath:@"loading" options:0 context:NULL];
    [webview loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:@"sptitle://page/"]]];
    until(@"the old page presented", ^BOOL { return loaded; });
    waitFrames(window.screen, kRefreshes);
    pid_t before = webview._webProcessIdentifier;

    char directory[] = "/tmp/soksak-titlebar-reload-XXXXXX";
    BOOL created = mkdtemp(directory) != NULL;
    check(created, @"the recording directory is created");
    if (!created) { [window close]; return 1; }
    recordingDirectory = [[NSString stringWithUTF8String:directory] copy];
    char *operationError = NULL;
    BOOL opened = sp_capture_open(window.windowNumber, false, &operationError);
    BOOL started = NO;
    if (opened) { free(operationError); operationError = NULL; started = sp_capture_start(directory, &operationError); }
    check(started, [NSString stringWithFormat:@"the recording starts (%s)", operationError == NULL ? "" : operationError]);
    free(operationError);
    if (!started) { [window close]; return 1; }
    check(sp_capture_wait() > 0, @"the recording contains its initial frame");
    waitFrames(window.screen, kRefreshes);

    surfaceLayoutTraceStart();
    __block BOOL reloaded = NO;
    SPAfterLoad *second = [[SPAfterLoad new] autorelease];
    second->webview = webview;
    second->done = [[^{ reloaded = YES; } copy] autorelease];
    [webview addObserver:second forKeyPath:@"loading" options:0 context:NULL];
    [webview evaluateJavaScript:@"location.reload()" completionHandler:nil];
    until(@"the reloaded page presented", ^BOOL { return reloaded; });
    waitFrames(window.screen, kRefreshes);
    double records[SURFACE_LAYOUT_TRACE_STAGES * 8];
    size_t transactions = surfaceLayoutTraceStop(records, 8);
    double committed = NAN;
    for (size_t index = 0; index < transactions && index < 8; index++) {
        if (records[index * SURFACE_LAYOUT_TRACE_STAGES] == 301) committed = records[index * SURFACE_LAYOUT_TRACE_STAGES + 3];
    }
    check(pages->ready && pages->failure == nil, [NSString stringWithFormat:
        @"the start sets the title bar before the new page is answered (%@)", pages->failure ?: @"no failure"]);
    // 트랜잭션이 새 페이지의 첫 그리기를 막으면 커밋이 없다.
    check(!isnan(committed), @"the start transaction commits with the first presentation of the new page");
    pid_t after = webview._webProcessIdentifier;
    check(after != before && after > 0, [NSString stringWithFormat:
        @"the new page runs in a new WebContent process (%d, then %d)", before, after]);
    fprintf(stdout, "the start transaction stayed open %.1fms from the title bar change to the commit\n",
        committed - pages->set);

    int count = sp_capture_stop(CACurrentMediaTime() * 1000);
    const char *recordingError = sp_capture_error();
    check(recordingError[0] == 0 && !sp_capture_limited(), [NSString stringWithFormat:
        @"the recording ends without error or truncation (%s)", recordingError[0] ? recordingError : "none"]);
    fprintf(stdout, "recording: %d frames, longest gap %.1fms\n", count, sp_capture_longest_gap());

    // 보인 페이지마다 창 단추는 그 페이지의 첫 행 가운데에 있다. 이전 페이지는 바꾼 뒤에도 커밋까지 보여야 기준이
    // 관측된다.
    int oldHeld = 0, newShown = 0, newBeforeCommit = 0;
    for (int index = 0; index < count; index++) {
        NSString *path = [recordingDirectory stringByAppendingPathComponent:
            [NSString stringWithFormat:@"frame-%04d.bgra", index + 1]];
        NSData *data = readCaptureFrame([NSData dataWithContentsOfFile:path]);
        double displayed = NAN;
        SPShown shown = SPShownOther;
        uint8_t seen[3] = {0, 0, 0};
        double centre = data ? measure(data, &displayed, &shown, seen) : NAN;
        if (shown == SPShownOther) {
            check(NO, [NSString stringWithFormat:@"frame %d/%d shows one of the two pages (colour %d,%d,%d)",
                index + 1, count, seen[0], seen[1], seen[2]]);
            continue;
        }
        double row = shown == SPShownOld ? kOldRow : kNewRow;
        check(fabs(centre - row / 2) <= 0.5, [NSString stringWithFormat:
            @"frame %d/%d (%.1fms after the title bar change, %.1fms after the commit) shows the %@ page with the "
            "buttons at %.2fpt, the centre of its %.0fpt row", index + 1, count, displayed - pages->set,
            displayed - committed, shown == SPShownOld ? @"old" : @"new", centre, row]);
        if (shown == SPShownOld && displayed >= pages->set) oldHeld++;
        if (shown == SPShownNew) {
            newShown++;
            if (!(displayed >= committed)) newBeforeCommit++;
        }
    }
    fprintf(stdout, "%d old-page frames after the title bar change, %d new-page frames, %d of them before the commit\n",
        oldHeld, newShown, newBeforeCommit);
    check(oldHeld > 0, @"the recording has old-page frames displayed while the start transaction is open");
    check(newShown > 0, @"the recording has new-page frames");
    cleanupRecording();
    [window close];
    return failures ? 1 : 0;
}}
