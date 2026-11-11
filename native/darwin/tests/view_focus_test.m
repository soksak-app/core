// Checks that a mouse press on a view (docs/spec/native-surfaces.md#view-surfaces) reaches the page and moves keyboard focus
// into the view. The default path sends a press through -[NSWindow sendEvent:] to a window that is not key. The --activation path
// first makes the window key with the emulated activation of sp_input_activate, which leaves the process inactive and makes the
// window the virtual key window (input_virtual.h), and checks that the page also receives a key event. No path activates the
// application, so no path restores a frontmost application.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "support/temporary_folder.h"
#import "support/view_import_map.h"
#import "document_view.h"
#import "private/webkit.h"
#import "webview_geometry.h"
#import "window_facts.h"
#import "input_inject.h"
#import "input_virtual.h"
#import "application_log.h"
#import "support/event_wait.h"
#import "support/records.h"

static int failures = 0;
static void check(BOOL condition, NSString *message);

static NSString *inputActivityErrorReport(NSArray<NSDictionary *> *events) {
    NSMutableArray<NSString *> *lines = [NSMutableArray array];
    for (NSDictionary *event in events) {
        NSDictionary *fields = event[@"fields"];
        if (![event[@"name"] isEqual:@"native.record.error"]
            || ![fields[@"where"] isKindOfClass:NSString.class]
            || ![fields[@"text"] isKindOfClass:NSString.class]) continue;
        [lines addObject:[NSString stringWithFormat:@"DIAGNOSTIC: %@: %@", fields[@"where"], fields[@"text"]]];
    }
    return [lines componentsJoinedByString:@"\n"];
}

static int activityErrorReportTest(void) {
    NSArray<NSDictionary *> *events = capturedEvents(^{
        sp_log_error("input inject", "webview activity-state registration pending at timeout");
        sp_log_error("document view", "web content process terminated during activation");
    });
    NSString *report = inputActivityErrorReport(events);
    NSString *expected = @"DIAGNOSTIC: input inject: webview activity-state registration pending at timeout\n"
        "DIAGNOSTIC: document view: web content process terminated during activation";
    BOOL reported = [report isEqualToString:expected];
    check(reported, [NSString stringWithFormat:@"the test output preserves captured activation errors from each source (%@)", report]);
    if (report.length > 0) fprintf(stderr, "%s\n", report.UTF8String);
    return failures ? 1 : 0;
}

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void applicationEventPumpTest(void) {
    const NSInteger subtype = 23995;
    __block BOOL delivered = NO;
    id monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskApplicationDefined
        handler:^NSEvent *(NSEvent *event) {
            if (event.subtype == subtype) delivered = YES;
            return event;
        }];
    NSEvent *event = [NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint
        modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:0 context:nil
        subtype:(short)subtype data1:1 data2:0];
    [NSApp postEvent:event atStart:NO];
    eventWait(@"the wait dispatches the queued application event", ^BOOL { return delivered; });
    [NSEvent removeMonitor:monitor];
    check(delivered, @"the wait dispatches a queued AppKit application event");
}

static NSDictionary *latest;

static void changed(void *context, const char *text) {
    (void)context;
    latest = [[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:text length:strlen(text)] options:0 error:nil] retain];
    eventWake();
}

static void writeFile(NSString *root, NSString *path, NSString *text) {
    NSString *file = [root stringByAppendingPathComponent:path];
    [[NSFileManager defaultManager] createDirectoryAtPath:file.stringByDeletingLastPathComponent
        withIntermediateDirectories:YES attributes:nil error:nil];
    [text writeToFile:file atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

// The channel script of a view configuration, as the host adds it to every view.
static NSString *const channelScript = @"window.webkit.messageHandlers['sok-view'].postMessage("
    "{ event: 'view.ready', plugin: 'probe', document: 'doc-1' });";

// A page whose body is one text field that fills the view. The title reports that the page has loaded, and that the page
// received a mouse down.
static NSString *const page = @"<!doctype html><meta charset=utf-8><title>loading</title>"
    "<input id='field' style='position:absolute;left:0;top:0;width:100%;height:100%;font-size:24px;border:0'>"
    "<script>document.title = 'ready';"
    "document.addEventListener('mousedown', () => { document.title = 'down'; }, true);"
    "document.addEventListener('keydown', (e) => { document.title = 'key:' + e.key; }, true);</script>";
static NSString *const mainPageHTML = @"<!doctype html><meta charset=utf-8><title>main-ready</title><body></body>";

@interface MainPageReadiness : NSObject <WKNavigationDelegate>
@property(assign) BOOL finished;
@property(retain) NSError *failure;
@end

@implementation MainPageReadiness
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    (void)webView;
    (void)navigation;
    self.finished = YES;
}
- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    (void)webView;
    (void)navigation;
    self.failure = error;
}
- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    (void)webView;
    (void)navigation;
    self.failure = error;
}
- (void)dealloc {
    [_failure release];
    [super dealloc];
}
@end

static BOOL activationDone;
static sp_activate_result activationResult;
static NSString *activationFrontmost;

static void storeActivationResult(sp_activate_result result, NSString *frontmost) {
    NSString *snapshot = [frontmost retain];
    [activationFrontmost release];
    activationResult = result;
    activationFrontmost = snapshot;
    activationDone = YES;
    // The answer can come from the timer of the activation limit, which does not end a turn of the run loop.
    eventWake();
}

static void clearActivationFrontmost(void) {
    [activationFrontmost release];
    activationFrontmost = nil;
}

@interface TestActivationDescription : NSString {
    BOOL *_deallocated;
}
- (instancetype)initWithDeallocatedFlag:(BOOL *)deallocated;
@end

@implementation TestActivationDescription
- (instancetype)initWithDeallocatedFlag:(BOOL *)deallocated {
    self = [super init];
    if (self) _deallocated = deallocated;
    return self;
}
- (NSUInteger)length { return 1; }
- (unichar)characterAtIndex:(NSUInteger)index {
    if (index != 0) [NSException raise:NSRangeException format:@"index out of range"];
    return 'x';
}
- (void)dealloc {
    if (_deallocated) *_deallocated = YES;
    [super dealloc];
}
@end

typedef NSString *(*ActivationDescriptionFactory)(const char *);
static ActivationDescriptionFactory activationDescriptionFactory;
static BOOL *activationDescriptionDeallocated;

static NSString *defaultActivationDescription(const char *frontmost) {
    return [NSString stringWithUTF8String:frontmost];
}

static NSString *shortLivedActivationDescription(const char *frontmost) {
    if (!frontmost || strcmp(frontmost, "frontmost.test") != 0) return nil;
    return [[[TestActivationDescription alloc] initWithDeallocatedFlag:activationDescriptionDeallocated] autorelease];
}

static void activationReported(void *context, sp_activate_result result, const char *frontmost) {
    (void)context;
    ActivationDescriptionFactory factory = activationDescriptionFactory ?: defaultActivationDescription;
    storeActivationResult(result, frontmost ? factory(frontmost) : nil);
}

static void activationDescriptionLifetimeTest(void) {
    BOOL deallocated = NO;
    activationDone = NO;
    activationResult = SP_ACTIVATE_PENDING;
    clearActivationFrontmost();
    activationDescriptionDeallocated = &deallocated;
    ActivationDescriptionFactory previousFactory = activationDescriptionFactory;
    activationDescriptionFactory = shortLivedActivationDescription;
    @autoreleasepool {
        activationReported(NULL, SP_ACTIVATE_NOT_KEY, "frontmost.test");
    }
    activationDescriptionFactory = previousFactory;
    activationDescriptionDeallocated = NULL;
    check(activationDone && activationResult == SP_ACTIVATE_NOT_KEY,
        @"the activation callback records a result that names the frontmost application");
    BOOL retained = !deallocated;
    check(retained, @"the saved frontmost description survives the callback autorelease pool");
    if (retained) {
        clearActivationFrontmost();
        check(deallocated, @"the saved frontmost description is released by its owner");
    } else {
        // The unchanged implementation leaves a dangling pointer after the inner pool drains.
        activationFrontmost = nil;
    }
    activationDone = NO;
    activationResult = SP_ACTIVATE_PENDING;
}

static NSEvent *mouseEvent(NSWindow *window, NSEventType type, NSPoint point, NSInteger clicks, float pressure) {
    return [NSEvent mouseEventWithType:type location:[window.contentView convertPoint:point toView:nil] modifierFlags:0
        timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil eventNumber:0
        clickCount:clicks pressure:pressure];
}

int main(int argc, char **argv) { @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "--activity-error-report-test") == 0) return activityErrorReportTest();
    BOOL activation = argc == 2 && strcmp(argv[1], "--activation") == 0;
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    applicationEventPumpTest();
    activationDescriptionLifetimeTest();

    NSString *temporary = temporaryFolder(@"soksak-view-focus-");
    sp_view_import_map_set(viewImportMapFixture().UTF8String);
    NSString *folder = [temporary stringByAppendingPathComponent:@"plugin"];
    writeFile(folder, @"ui/page.html", page);

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    [window orderBack:nil];
    BOOL mainRegistered = sp_window_set_main_webview(window, main);
    check(mainRegistered && sp_window_main_webview(window) == main,
        @"the activation fixture registers its app DOM web view");
    MainPageReadiness *mainPage = [[[MainPageReadiness alloc] init] autorelease];
    main.navigationDelegate = mainPage;
    [main loadHTMLString:mainPageHTML baseURL:nil];
    // WebKit sends the title of the page to the web view apart from the end of its navigation, and in some runs after it, so the
    // page is ready when both arrived.
    eventWait(@"the main page finishes its navigation and its title arrives", ^BOOL {
        return (mainPage.finished && [main.title isEqual:@"main-ready"]) || mainPage.failure != nil;
    });
    BOOL mainReady = mainPage.failure == nil;
    check(mainReady, mainPage.failure
        ? [NSString stringWithFormat:@"the registered app DOM web view finishes its main page before activation (%@)", mainPage.failure]
        : [NSString stringWithFormat:@"the registered app DOM web view finishes its main page before activation (finished %d, title \"%@\")",
            mainPage.finished, main.title]);
    if (!mainReady) {
        [window close];
        [window release];
        return 1;
    }
    void *surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    webviewSetFrame(surface, 0, 0, 500, 400);
    NSString *store = [temporary stringByAppendingPathComponent:@"store"];

    WKWebView *view = (WKWebView *)sp_document_create(surface, store.fileSystemRepresentation, folder.fileSystemRepresentation,
        "probe", NULL, channelScript.UTF8String, changed, NULL);
    check(view != NULL, @"a view is created on the surface");
    if (!view) return 1;
    // Both hosts place a wanted view while its surface is hidden for layout preparation, then reveal the surface at presentation.
    sp_document_place(view, 0, 0, 0, 0, true);
    check(view.hidden, @"a view placed during preparation stays hidden with its surface");
    webviewSetSurfaceHidden(surface, false);
    double frame[5] = {0};
    sp_document_frame(view, frame);
    check(frame[4] == 1, @"revealing the surface reveals its wanted view");

    // A later preparation must restore the view too, while an explicitly hidden view remains hidden.
    webviewSetSurfaceHidden(surface, true);
    sp_document_place(view, 0, 0, 0, 0, false);
    webviewSetSurfaceHidden(surface, false);
    sp_document_frame(view, frame);
    check(frame[4] == 0, @"revealing the surface keeps an explicitly hidden view hidden");
    webviewSetSurfaceHidden(surface, true);
    sp_document_place(view, 0, 0, 0, 0, true);
    webviewSetSurfaceHidden(surface, false);
    sp_document_frame(view, frame);
    check(frame[4] == 1, @"a later presentation restores the wanted view");
    latest = nil;
    check(sp_document_load(view, "soksak://probe/ui/page.html"), @"the view loads the page of its plugin");
    eventWait(@"the view page reports that it has loaded", ^BOOL { return [latest[@"title"] isEqual:@"ready"]; });

    if (activation) {
        activationDone = NO;
        activationResult = SP_ACTIVATE_PENDING;
        activationFrontmost = nil;
        NSArray<NSDictionary *> *events = capturedEvents(^{
            sp_input_activate(window, activationReported, NULL);
            eventWait(@"the activation answers", ^BOOL { return activationDone; });
        });
        NSString *report = inputActivityErrorReport(events);
        if (report.length > 0) fprintf(stderr, "%s\n", report.UTF8String);
        if (!activationDone || activationResult != SP_ACTIVATE_DONE || !sp_input_virtual_is((__bridge void *)window)
            || !window.isKeyWindow || !NSApp.isActive) {
            fprintf(stderr, "FAIL: the window did not become the virtual key window of an application that answers as active (activation %d, virtual %d, active %d, window key %d, frontmost %s)\n",
                activationResult, (int)sp_input_virtual_is((__bridge void *)window), (int)NSApp.isActive, (int)window.isKeyWindow,
                activationFrontmost.UTF8String ?: "unknown");
            clearActivationFrontmost();
            return 1;
        }
    }

    // The keyboard focus starts in the app DOM, so a change of the first responder is observable.
    check([window makeFirstResponder:main], @"the app DOM takes the keyboard focus before the press");

    // The press and the release are at the center of the view, which is inside the text field of the view page.
    [window sendEvent:mouseEvent(window, NSEventTypeLeftMouseDown, NSMakePoint(250, 200), 1, 1)];
    [window sendEvent:mouseEvent(window, NSEventTypeLeftMouseUp, NSMakePoint(250, 200), 1, 0)];
    eventWait(@"the page of the view reports the press", ^BOOL { return [latest[@"title"] isEqual:@"down"]; });
    check([latest[@"title"] isEqual:@"down"], @"the page of the view receives the press");
    if (activation) {
        NSTimeInterval time = NSProcessInfo.processInfo.systemUptime;
        [NSApp sendEvent:[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:time
            windowNumber:window.windowNumber context:nil characters:@"x" charactersIgnoringModifiers:@"x" isARepeat:NO keyCode:7]];
        [NSApp sendEvent:[NSEvent keyEventWithType:NSEventTypeKeyUp location:NSZeroPoint modifierFlags:0 timestamp:time
            windowNumber:window.windowNumber context:nil characters:@"x" charactersIgnoringModifiers:@"x" isARepeat:NO keyCode:7]];
        eventWait(@"the page of the view reports the key x", ^BOOL { return [latest[@"title"] isEqual:@"key:x"]; });
        check([latest[@"title"] isEqual:@"key:x"],
            [NSString stringWithFormat:@"the page of the view receives the key x (title %@)", latest[@"title"]]);
    }

    NSResponder *responder = window.firstResponder;
    BOOL inView = responder == view || ([responder isKindOfClass:NSView.class] && [(NSView *)responder isDescendantOf:view]);
    check(inView,
        [NSString stringWithFormat:@"a press on the view moves the keyboard focus into the view (first responder %@)",
            NSStringFromClass(responder.class)]);

    sp_document_close(view);
    sp_surface_close(surface);
    [window close];
    [window release];
    clearActivationFrontmost();
    return failures ? 1 : 0;
}}
