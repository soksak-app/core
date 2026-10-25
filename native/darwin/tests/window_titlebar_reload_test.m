// Checks, with a window recording that the window server showed, that while a page reloads in a new WebContent
// process, the layout transaction of the window stays open, the title bar height is changed in it, and the
// transaction is committed at the first display of the new page, no frame shows the previous page with the new title
// bar or the new page with the previous title bar. It also measures whether the first drawing of the new page is
// displayed while the transaction stays open and whether the start does not stall
// (docs/spec/native-surfaces.md#title-bar-height). The check does not activate the application.
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
// The previous page draws a 40pt first row at scale 1, and the new page draws a 72pt first row at scale 2. Each page
// is painted with one color, and that color tells which page was visible.
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

// Waits for the condition for up to 10 seconds. Returns the waited time (ms); if the limit is exceeded, reports what
// as a failure and ends.
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

// Like the main page, the page draws the first screen after it fetches the start document with a render-blocking
// module in head.
static NSString *page(const uint8_t *color) {
    return [NSString stringWithFormat:@"<!doctype html><html><head><script type=\"module\" blocking=\"render\">"
        "import start from \"sptitle://page/start.json\" with { type: \"json\" };"
        "document.body.style.background = start.background;</script></head>"
        "<body style=\"margin:0;background:rgb(%d,%d,%d)\"></body></html>", color[0], color[1], color[2]];
}

// After the loading of the webview has started and ended, calls done at the next display refresh. It is the same
// moment as the window reveal of window_reveal.m.
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

// The handler that serves the test documents. The second page is the reloaded page, and before it answers the start
// document request of that page, it sets the title bar to the new row height with surfaceLayoutStartPage. This is
// what the host does for a start document request.
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
    // The start document of the reloaded page is answered after 100ms. As with a page with a slow start, the previous
    // page stays on screen for several frames during the open transaction, and the check observes the title bar of
    // those frames in the recording.
    if (start && reload) dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC), dispatch_get_main_queue(), answer);
    else answer();
}
- (void)webView:(WKWebView *)webView stopURLSchemeTask:(id<WKURLSchemeTask>)task {}
@end

typedef enum { SPShownOld, SPShownNew, SPShownOther } SPShown;

// Measures the visible page and the center (pt from the window top) of the rows that the window buttons occupy in one
// recording frame.
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
    // A window that is not visible yet has no previous page, so the height is set directly without a transaction.
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
    if (opened) { free(operationError); operationError = NULL; started = sp_capture_start(directory, false, &operationError); }
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
    // If the transaction blocks the first drawing of the new page, there is no commit.
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

    // For every visible page, the window buttons are at the center of the first row of that page. The previous page
    // must stay visible until the commit, even after the change, so the criterion is observed.
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
