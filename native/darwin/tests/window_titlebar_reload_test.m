// Checks that while a page reloads in a new WebContent process, the layout transaction of the window stays open, the title
// bar height is changed in it before the new page is answered, and the transaction is committed with the first presentation of
// the new page (docs/spec/native-surfaces.md#title-bar-height), judged by the layout trace of the start transaction. A recording
// of the window at each refresh is evidence of what the window showed and is not judged; a failing check keeps its folder. The
// check does not activate the application.
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <WebKit/WebKit.h>
#import "surface_layout.h"
#import "window_controls.h"
#import "webview_navigation.h"
#import "window_facts.h"
#import "private/webkit.h"
#import "capture.h"
#import "support/event_wait.h"
#import "support/temporary_folder.h"

static const int kRefreshes = 12;
// The refreshes of the screen for which the start document of the reloaded page stays unanswered.
static const int kHeldRefreshes = 6;
// The previous page draws a 40pt first row at scale 1, and the new page draws a 72pt first row at scale 2. Each page
// is painted with one color, so the frames show to a reader which page was visible.
static const double kOldRow = 40, kNewRow = 72;
static const uint8_t kOld[3] = {40, 170, 90}, kNew[3] = {230, 120, 30};

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Counts the refreshes of a screen and calls done, when it is set, after the last one.
@interface SPFrames : NSObject
@property int left;
@property (copy) void (^done)(void);
- (void)tick:(CADisplayLink *)link;
@end
@implementation SPFrames
- (void)tick:(CADisplayLink *)link {
    if (--self.left != 0) return;
    // The link releases its target when it is invalidated, so the block is kept until it has run.
    void (^done)(void) = [[self.done retain] autorelease];
    [link invalidate];
    if (done) done();
}
- (void)dealloc {
    [_done release];
    [super dealloc];
}
@end

// Calls done on the main thread after count refreshes of screen.
static SPFrames *afterFrames(NSScreen *screen, int count, void (^done)(void)) {
    SPFrames *frames = [[SPFrames new] autorelease];
    frames.left = count;
    frames.done = done;
    [[screen displayLinkWithTarget:frames selector:@selector(tick:)]
        addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
    return frames;
}

static void waitFrames(NSScreen *screen, int count) {
    SPFrames *frames = [afterFrames(screen, count, nil) retain];
    eventWait([NSString stringWithFormat:@"the display refreshes %d times", count], ^BOOL { return frames.left == 0; });
    [frames release];
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
        // The start changes the title bar inside its transaction and answers ready right after the change, so the time of
        // the answer is the time of the change.
        surfaceLayoutStartPage(window, 301, kNewRow, ^(const char *problem) {
            self->set = CACurrentMediaTime() * 1000;
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
    // The start document of the reloaded page is answered after several refreshes of the screen. As with a page with a slow
    // start, the previous page stays on screen for those frames during the open transaction, and the check observes the
    // title bar of those frames in the recording.
    if (start && reload) afterFrames(window.screen, kHeldRefreshes, answer);
    else answer();
}
- (void)webView:(WKWebView *)webView stopURLSchemeTask:(id<WKURLSchemeTask>)task {}
@end

int main(void) { @autoreleasepool {
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
    [window.contentView addSubview:webview];
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
    eventWait(@"the old page presents", ^BOOL { return loaded; });
    waitFrames(window.screen, kRefreshes);
    pid_t before = webview._webProcessIdentifier;

    NSString *recordingDirectory = temporaryFolder(@"soksak-titlebar-reload-");
    const char *directory = recordingDirectory.fileSystemRepresentation;
    char *operationError = NULL;
    BOOL opened = sp_capture_open(window.windowNumber, false, &operationError);
    BOOL started = NO;
    // One still at each refresh of the display, for longer than the reload takes: the stop ends the recording.
    if (opened) {
        free(operationError);
        operationError = NULL;
        started = sp_capture_start(directory, 1000.0 / window.screen.maximumFramesPerSecond, 0, 4096, 0, &operationError);
    }
    // The recording is evidence: a recording that does not start or ends with an error is reported and not judged.
    if (!started) fprintf(stdout, "the recording did not start (%s)\n", operationError == NULL ? "" : operationError);
    free(operationError);
    waitFrames(window.screen, kRefreshes);

    surfaceLayoutTraceStart();
    __block BOOL reloaded = NO;
    SPAfterLoad *second = [[SPAfterLoad new] autorelease];
    second->webview = webview;
    second->done = [[^{ reloaded = YES; } copy] autorelease];
    [webview addObserver:second forKeyPath:@"loading" options:0 context:NULL];
    [webview evaluateJavaScript:@"location.reload()" completionHandler:nil];
    eventWait(@"the reloaded page presents", ^BOOL { return reloaded; });
    waitFrames(window.screen, kRefreshes);
    double records[SURFACE_LAYOUT_TRACE_STAGES * 8];
    size_t transactions = surfaceLayoutTraceStop(records, 8);
    double ended = CACurrentMediaTime() * 1000;
    double committed = NAN, begun = NAN, flushed = NAN, path = NAN;
    for (size_t index = 0; index < transactions && index < 8; index++) {
        const double *record = records + index * SURFACE_LAYOUT_TRACE_STAGES;
        if (record[0] == 301) { begun = record[1]; committed = record[3]; path = record[5]; flushed = record[7]; }
    }
    check(pages->ready && pages->failure == nil, [NSString stringWithFormat:
        @"the start sets the title bar before the new page is answered (%@)", pages->failure ?: @"no failure"]);
    // If the transaction blocks the first drawing of the new page, there is no commit.
    check(!isnan(committed), @"the start transaction commits with the first presentation of the new page");
    check(begun <= pages->set && pages->set <= committed && committed <= ended && path == SURFACE_LAYOUT_COMMIT_START,
        [NSString stringWithFormat:@"the trace records the start transaction begun before the title bar change and committed "
            "by the start of the new page after it (begun %.3f, set %.3f, committed %.3f, ended %.3f, path %.0f)", begun,
            pages->set, committed, ended, path]);
    check(begun <= flushed && flushed <= ended, [NSString stringWithFormat:@"the trace records when the commit of the start "
        "transaction was sent to the render server (begun %.3f, flushed %.3f, ended %.3f)", begun, flushed, ended]);
    pid_t after = webview._webProcessIdentifier;
    check(after != before && after > 0, [NSString stringWithFormat:
        @"the new page runs in a new WebContent process (%d, then %d)", before, after]);
    fprintf(stdout, "the start transaction stayed open %.1fms from the title bar change to the commit\n",
        committed - pages->set);

    if (started) {
        int count = sp_capture_stop(CACurrentMediaTime() * 1000, 0);
        const char *recordingError = sp_capture_error();
        fprintf(stdout, "recording: %d frames, %d late, longest gap %.1fms, error %s\n", count, sp_capture_late(),
            sp_capture_longest_gap(), recordingError[0] ? recordingError : "none");
    }
    if (failures) keepTemporaryFolder(recordingDirectory);
    [window close];
    return failures ? 1 : 0;
}}
