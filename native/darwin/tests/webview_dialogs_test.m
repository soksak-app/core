// Checks the dialogs of the pages of a window (docs/spec/exposure.md#dialogs): while the host holds them, the open panel of a
// file input and the destination of a download are requests that the host answers, with no panel; without a hold the open
// panel is the panel of the framework, and a download goes where the framework puts it or, without one, into the download
// folder. Each wait ends by the event that answers it or by the event that the old path gives instead, so a case fails at once.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "support/temporary_folder.h"
#import "support/event_wait.h"
#import "input_inject.h"
#import "webview_dialogs.h"
#import "webview_input.h"
#import "window_facts.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// The delegates of the framework of a test web view. The UI delegate answers each open panel as cancelled and counts it, as a
// person who closes the panel. The navigation delegate records the end of each navigation and each navigation that became a
// download. When it places downloads it writes each of them into its own folder, and when it observes downloads it sees
// their end without placing them.
@interface FrameworkDelegate : NSObject <WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate>
@property (nonatomic) NSInteger panels;
@property (nonatomic) NSInteger navigationsEnded;
@property (nonatomic) BOOL becameDownload;
@property (nonatomic) BOOL observes;
@property (nonatomic, copy) NSString *downloads;
@property (nonatomic, copy) NSString *placed;
@property (nonatomic) BOOL finished;
@property (nonatomic) BOOL failed;
@end

@implementation FrameworkDelegate
- (void)dealloc {
    [_downloads release];
    [_placed release];
    [super dealloc];
}

- (void)webView:(WKWebView *)webView runOpenPanelWithParameters:(WKOpenPanelParameters *)parameters
    initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(NSArray<NSURL *> *))completionHandler {
    (void)webView; (void)parameters; (void)frame;
    self.panels += 1;
    completionHandler(nil);
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    (void)webView; (void)navigation;
    self.navigationsEnded += 1;
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    (void)webView; (void)navigation; (void)error;
    self.navigationsEnded += 1;
}

- (BOOL)respondsToSelector:(SEL)selector {
    if (selector == @selector(download:decideDestinationUsingResponse:suggestedFilename:completionHandler:)) return self.downloads != nil;
    if (selector == @selector(downloadDidFinish:) || selector == @selector(download:didFailWithError:resumeData:)) {
        return self.downloads != nil || self.observes;
    }
    return [super respondsToSelector:selector];
}

- (void)webView:(WKWebView *)webView navigationResponse:(WKNavigationResponse *)response didBecomeDownload:(WKDownload *)download {
    (void)webView; (void)response;
    self.becameDownload = YES;
    if (self.downloads || self.observes) download.delegate = self;
}

- (void)download:(WKDownload *)download didFailWithError:(NSError *)error resumeData:(NSData *)resumeData {
    (void)download; (void)error; (void)resumeData;
    self.failed = YES;
}

- (void)download:(WKDownload *)download decideDestinationUsingResponse:(NSURLResponse *)response
    suggestedFilename:(NSString *)name completionHandler:(void (^)(NSURL *))completionHandler {
    (void)download; (void)response;
    self.placed = [self.downloads stringByAppendingPathComponent:name];
    completionHandler([NSURL fileURLWithPath:self.placed]);
}

- (void)downloadDidFinish:(WKDownload *)download {
    (void)download;
    self.finished = YES;
}
@end

// One request that a hold received.
static NSMutableArray<NSDictionary *> *requests;
static NSMutableArray<NSNumber *> *numbers;

static void *hold(NSWindow *window) {
    return sp_window_hold_dialogs(window, ^(uint64_t request, const char *json) {
        [numbers addObject:@(request)];
        [requests addObject:[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json length:strlen(json)] options:0 error:nil]];
    });
}

// A web view in window whose framework delegates are delegate, routed as the host routes a web view of the application.
static WKWebView *routedView(NSWindow *window, NSRect frame, FrameworkDelegate *delegate) {
    WKWebView *view = [[[WKWebView alloc] initWithFrame:frame] autorelease];
    view.UIDelegate = delegate;
    view.navigationDelegate = delegate;
    [window.contentView addSubview:view];
    sp_webview_route_dialogs(view);
    return view;
}

// Presses and releases the primary button at the point of the window, as input.pointer does.
static BOOL click(NSWindow *window, double x, double y) {
    return sp_input_pointer(window, x, y, 1, 0, 0, 0) == SP_INPUT_DELIVERED && sp_input_pointer(window, x, y, 3, 0, 0, 0) == SP_INPUT_DELIVERED;
}

static NSString *contents(NSString *path) {
    return [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:nil];
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    requests = [NSMutableArray new];
    numbers = [NSMutableArray new];

    NSString *temporary = temporaryFolder(@"soksak-webview-dialogs-");
    NSString *chosen = [temporary stringByAppendingPathComponent:@"chosen.txt"];
    [@"chosen" writeToFile:chosen atomically:YES encoding:NSUTF8StringEncoding error:nil];
    NSString *page = [temporary stringByAppendingPathComponent:@"input.html"];
    // The file input fills the page. The title names the files after a change and says cancel after a cancel.
    [@"<!doctype html><title>ready</title><style>body{margin:0}input{position:absolute;inset:0;width:100%;height:100%}</style>"
        "<input type=file>"
        "<script>const input = document.querySelector('input');"
        "input.addEventListener('change', () => { document.title = 'files:' + [...input.files].map((f) => f.name).join(','); });"
        "input.addEventListener('cancel', () => { document.title = 'cancel'; });</script>"
        writeToFile:page atomically:YES encoding:NSUTF8StringEncoding error:nil];

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 600, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 600, 400)] autorelease];
    [window orderBack:nil];
    FrameworkDelegate *framework = [[FrameworkDelegate new] autorelease];
    WKWebView *inputView = routedView(window, NSMakeRect(0, 0, 300, 400), framework);
    check(sp_window_set_main_webview(window, inputView) != NULL && webviewInputRegister(inputView), @"the web view of the file input is registered");
    [inputView loadFileURL:[NSURL fileURLWithPath:page] allowingReadAccessToURL:[NSURL fileURLWithPath:temporary]];
    eventWait(@"the page of the file input loads", ^BOOL{ return [inputView.title isEqual:@"ready"] && !inputView.loading; });

    // Without a hold the open panel is the panel of the framework.
    check(click(window, 150, 200), @"a press on the file input without a hold is delivered");
    eventWait(@"the open panel of the unheld file input", ^BOOL{ return framework.panels > 0 || requests.count > 0; });
    check(framework.panels == 1 && requests.count == 0, @"without a hold the open panel of a file input is the panel of the framework");
    eventWait(@"the cancel of the panel of the framework", ^BOOL{ return [inputView.title isEqual:@"cancel"]; });

    // With a hold the open panel is a request, and its answer gives the files to the input.
    void *held = hold(window);
    check(held != NULL && hold(window) == NULL, @"a window holds its dialogs once");
    check(click(window, 150, 200), @"a press on the held file input is delivered");
    eventWait(@"the request of the held file input", ^BOOL{ return requests.count > 0 || framework.panels > 1; });
    check(framework.panels == 1 && window.attachedSheet == nil, @"a held file input shows no panel");
    check(requests.count == 1 && [requests[0][@"kind"] isEqual:@"open"] && [requests[0][@"multiple"] isEqual:@NO]
        && [requests[0][@"directories"] isEqual:@NO] && requests[0][@"suggestedName"] == NSNull.null && requests[0][@"url"] == NSNull.null,
        [NSString stringWithFormat:@"a held file input is the request {kind: open, multiple: false, directories: false} (%@)", requests]);
    // applied is the end of an answer: nil when it was applied, or its error.
    __block NSString *applied = @"not answered";
    const char *paths[] = {chosen.fileSystemRepresentation};
    if (numbers.count == 1) {
        sp_dialog_answer(numbers[0].unsignedLongLongValue, paths, 1, false, ^(const char *error) {
            applied = error ? [[NSString alloc] initWithUTF8String:error] : nil;
        });
        eventWait(@"the change of the answered input", ^BOOL{
            return [inputView.title hasPrefix:@"files:"] || (applied != nil && ![applied isEqual:@"not answered"]);
        });
    }
    check(applied == nil && [inputView.title isEqual:@"files:chosen.txt"],
        [NSString stringWithFormat:@"the answer of a held file input gives the input its files (%@, %@)", applied, inputView.title]);

    // The end of the hold answers the request that waits as cancelled.
    check(click(window, 150, 200), @"a second press on the held file input is delivered");
    eventWait(@"the second request of the held file input", ^BOOL{ return requests.count > 1 || framework.panels > 1; });
    check(requests.count == 2, @"a second press of a held file input is a second request");
    sp_window_release_dialogs(held);
    eventWait(@"the cancel of the released request", ^BOOL{ return [inputView.title isEqual:@"cancel"] || framework.panels > 1; });
    check([inputView.title isEqual:@"cancel"] && framework.panels == 1, @"the end of a hold answers its waiting request as cancelled");
    // The host cancels the requests of a watch that ended, which the release may have cancelled first: a cancel of a request
    // that waits no more changes nothing and is applied.
    __block NSString *cancelled = @"not answered";
    if (numbers.count == 2) {
        sp_dialog_answer(numbers[1].unsignedLongLongValue, NULL, 0, true, ^(const char *error) {
            cancelled = error ? [[NSString alloc] initWithUTF8String:error] : nil;
        });
    }
    check(cancelled == nil, [NSString stringWithFormat:@"a cancel of a request that waits no more is applied (%@)", cancelled]);

    // Downloads: a response that the page cannot show is a download.
    NSString *content = @"download content";
    NSString *base64 = [[content dataUsingEncoding:NSUTF8StringEncoding] base64EncodedStringWithOptions:0];
    NSURL *file = [NSURL URLWithString:[@"data:application/octet-stream;base64," stringByAppendingString:base64]];
    NSString *downloads = [temporary stringByAppendingPathComponent:@"downloads"];
    NSString *placed = [temporary stringByAppendingPathComponent:@"placed"];
    NSString *answered = [temporary stringByAppendingPathComponent:@"answered"];
    for (NSString *folder in @[downloads, placed, answered]) {
        [NSFileManager.defaultManager createDirectoryAtPath:folder withIntermediateDirectories:NO attributes:nil error:nil];
    }
    sp_dialogs_set_download_folder(downloads.fileSystemRepresentation);

    // With a hold the destination is a request, and the answer returns after the file is written.
    FrameworkDelegate *bare = [[FrameworkDelegate new] autorelease];
    WKWebView *downloading = routedView(window, NSMakeRect(300, 0, 300, 400), bare);
    held = hold(window);
    NSUInteger before = requests.count;
    [downloading loadRequest:[NSURLRequest requestWithURL:file]];
    // A navigation that does not become a download ends without a request.
    eventWait(@"the request of the held download", ^BOOL{ return requests.count > before || (bare.navigationsEnded > 0 && !bare.becameDownload); });
    NSDictionary *download = requests.count > before ? requests.lastObject : nil;
    check([download[@"kind"] isEqual:@"download"] && [download[@"url"] isEqual:file.absoluteString] && [download[@"suggestedName"] isKindOfClass:NSString.class],
        [NSString stringWithFormat:@"a held download is the request {kind: download, suggestedName, url} (%@)", download]);
    NSString *target = [answered stringByAppendingPathComponent:@"saved.bin"];
    [@"old" writeToFile:target atomically:YES encoding:NSUTF8StringEncoding error:nil];
    applied = @"not answered";
    const char *targets[] = {target.fileSystemRepresentation};
    if (download) {
        sp_dialog_answer(numbers.lastObject.unsignedLongLongValue, targets, 1, false, ^(const char *error) {
            applied = error ? [[NSString alloc] initWithUTF8String:error] : nil;
        });
        eventWait(@"the end of the answered download", ^BOOL{ return ![applied isEqual:@"not answered"]; });
    }
    check(applied == nil && [contents(target) isEqual:content],
        [NSString stringWithFormat:@"the answer of a held download returns after it replaced the chosen file (%@, %@)", applied, contents(target)]);
    sp_window_release_dialogs(held);

    // Without a hold a download goes where the framework puts it.
    FrameworkDelegate *placing = [[FrameworkDelegate new] autorelease];
    placing.downloads = placed;
    WKWebView *placingView = routedView(window, NSMakeRect(300, 0, 300, 400), placing);
    before = requests.count;
    [placingView loadRequest:[NSURLRequest requestWithURL:file]];
    eventWait(@"the download that the framework places", ^BOOL{
        return placing.finished || placing.failed || (placing.navigationsEnded > 0 && !placing.becameDownload) || requests.count > before;
    });
    check(placing.finished && requests.count == before && [contents(placing.placed) isEqual:content]
        && [[NSFileManager.defaultManager contentsOfDirectoryAtPath:downloads error:nil] count] == 0,
        @"without a hold a download goes where the framework puts it");

    // Without a hold and without a framework that places it, a download goes into the download folder under a free name.
    // The name that the download suggests is taken in the download folder.
    NSString *suggested = [download[@"suggestedName"] isKindOfClass:NSString.class] ? download[@"suggestedName"] : @"Unknown";
    [@"taken" writeToFile:[downloads stringByAppendingPathComponent:suggested] atomically:YES encoding:NSUTF8StringEncoding error:nil];
    // The framework sees the end of the download, as a framework that observes downloads without placing them.
    FrameworkDelegate *observing = [[FrameworkDelegate new] autorelease];
    observing.observes = YES;
    WKWebView *observedView = routedView(window, NSMakeRect(300, 0, 300, 400), observing);
    [observedView loadRequest:[NSURLRequest requestWithURL:file]];
    eventWait(@"the download into the download folder", ^BOOL{
        return observing.finished || observing.failed || (observing.navigationsEnded > 0 && !observing.becameDownload);
    });
    NSArray<NSString *> *saved = [NSFileManager.defaultManager contentsOfDirectoryAtPath:downloads error:nil];
    NSString *second = nil;
    for (NSString *name in saved) if (![name isEqual:suggested]) second = name;
    check(observing.finished && second != nil && [contents([downloads stringByAppendingPathComponent:suggested]) isEqual:@"taken"]
        && [contents([downloads stringByAppendingPathComponent:second]) isEqual:content],
        [NSString stringWithFormat:@"without a framework that places it a download goes into the download folder and keeps the file there (%@)", saved]);

    [window close];
    if (failures) keepTemporaryFolder(temporary);
    return failures ? 1 : 0;
} }
