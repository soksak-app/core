// Checks that while a page reloads in a new WebContent process, the layout transaction of the window stays open, the title
// bar height is changed in it before the new page is answered, and the transaction is committed with the first presentation of
// the new page (docs/spec/native-surfaces.md#title-bar-height). A recording of the window at each refresh keeps every still
// with a complete frame file; the frames are evidence of what the window showed and their pixels are not judged. The check does
// not activate the application.
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
        started = sp_capture_start(directory, 1000.0 / window.screen.maximumFramesPerSecond, 0, 4096, false, 0, &operationError);
    }
    check(started, [NSString stringWithFormat:@"the recording starts with its initial frame (%s)",
        operationError == NULL ? "" : operationError]);
    free(operationError);
    if (!started) { [window close]; return 1; }
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

    int count = sp_capture_stop(CACurrentMediaTime() * 1000, 0);
    const char *recordingError = sp_capture_error();
    check(recordingError[0] == 0, [NSString stringWithFormat:
        @"the recording ends without error or a failed still (%s)", recordingError[0] ? recordingError : "none"]);
    fprintf(stdout, "recording: %d frames, %d late, longest gap %.1fms\n", count, sp_capture_late(), sp_capture_longest_gap());

    // Every still of the recording has a complete frame file. The frames are evidence and are not judged.
    int unreadable = 0;
    for (int index = 0; index < count; index++) {
        NSString *path = [recordingDirectory stringByAppendingPathComponent:
            [NSString stringWithFormat:@"frame-%04d.bgra", index]];
        if (readCaptureFrame([NSData dataWithContentsOfFile:path]) == nil) unreadable++;
    }
    check(count > 0 && unreadable == 0, [NSString stringWithFormat:@"every still of the recording has a complete frame file "
        "(%d frames, %d unreadable)", count, unreadable]);
    if (failures) keepTemporaryFolder(recordingDirectory);
    [window close];
    return failures ? 1 : 0;
}}
