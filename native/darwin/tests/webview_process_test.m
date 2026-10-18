// Ending a WebContent process must be an explicit and usable operation, and a reload in the same process leaves the
// previous document that the WebKit result cache holds.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <libproc.h>
#import "support/temporary_folder.h"
#import "webview_geometry.h"
#import "support/records.h"
#import "private/webkit.h"

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
    if (!done()) {
        fprintf(stderr, "FAIL: WebKit did not answer within 10 seconds\n");
        exit(1);
    }
}

@interface SPLoaded : NSObject <WKNavigationDelegate>
@property BOOL finished;
@property BOOL terminated;
@end

@implementation SPLoaded
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    (void)webView;
    (void)navigation;
    self.finished = YES;
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
    // The delegate of a native webview of the application records the end as this call does.
    sp_webview_log_process_end((__bridge void *)webView, "surface webview");
    self.terminated = YES;
}
@end

static SPLoaded *load(WKWebView *view, NSString *html) {
    SPLoaded *loaded = [[[SPLoaded alloc] init] autorelease];
    view.navigationDelegate = loaded;
    [view loadHTMLString:html baseURL:nil];
    until(^BOOL { return loaded.finished; });
    return [loaded retain];
}

// The physical footprint (bytes) of the process. Resident memory does not shrink while the allocator holds released
// pages.
static long processFootprint(pid_t pid) {
    struct rusage_info_v2 info;
    return proc_pid_rusage(pid, RUSAGE_INFO_V2, (rusage_info_t *)&info) == 0 ? (long)info.ri_phys_footprint : -1;
}

// The footprint (bytes) that grew after opening an html file and reloading it four times. Collects JavaScript objects
// at every reload. A document opened from a string becomes an empty document on reload, so the check opens it from a
// file in a temporary directory.
static long reloadGrowth(WKWebView *view, NSString *html) {
    NSString *directory = temporaryFolder(@"soksak-webview-process-");
    NSURL *file = [NSURL fileURLWithPath:[directory stringByAppendingPathComponent:@"page.html"]];
    check([html writeToURL:file atomically:YES encoding:NSUTF8StringEncoding error:nil], @"the test page is written");
    SPLoaded *loaded = [[[SPLoaded alloc] init] autorelease];
    view.navigationDelegate = loaded;
    [view loadFileURL:file allowingReadAccessToURL:file.URLByDeletingLastPathComponent];
    until(^BOOL { return loaded.finished; });
    check(sp_webview_collect_garbage(view), @"the JavaScript garbage collection request is available");
    pid_t process = view._webProcessIdentifier;
    long first = processFootprint(process);
    for (int i = 0; i < 4; i++) {
        loaded.finished = NO;
        [view reload];
        until(^BOOL { return loaded.finished; });
        sp_webview_collect_garbage(view);
    }
    long growth = processFootprint(process) - first;
    check(view._webProcessIdentifier == process, @"reloads stay in one WebContent process");
    view.navigationDelegate = nil;
    return growth;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSWindow *window = [[[NSWindow alloc]
        initWithContentRect:NSMakeRect(100, 100, 600, 300)
                  styleMask:NSWindowStyleMaskTitled
                    backing:NSBackingStoreBuffered
                      defer:NO] autorelease];
    WKWebView *view = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:view];
    [window orderBack:nil];
    SPLoaded *first = load(view, @"<p id='first'>first</p>");

    NSString *ended = capturedRecords(^{
        check(sp_webview_kill_content_process(view),
              @"the WebContent process termination operation is available");
        until(^BOOL { return first.terminated; });
    });
    check([ended containsString:@" error native surface webview: web content process terminated: about:blank"],
          [NSString stringWithFormat:@"the end of the WebContent process is recorded with the address (got %@)", ended]);
    view.navigationDelegate = nil;
    [first release];
    SPLoaded *second = load(view, @"<p id='second'>second</p>");
    view.navigationDelegate = nil;
    [second release];
    __block BOOL evaluated = NO;
    __block NSString *value = nil;
    [view evaluateJavaScript:@"document.body.textContent"
           completionHandler:^(id result, NSError *error) {
               value = [result copy];
               evaluated = YES;
               (void)error;
           }];
    until(^BOOL { return evaluated; });
    check([value isEqualToString:@"second"],
          @"a page can reload after WebContent termination");
    [value release];

    // The per-document querySelectorAll result cache of WebKit holds the result elements, and the elements hold the
    // document. Teardown does not empty this cache, so a reload in the same process leaves the previous document
    // until memory pressure. The same page without the query does not leave it. The marker is an attribute of an
    // element that the query matches. Attributes with the same value share one string between documents, so each
    // document uses a different value.
    NSString *marked = @"<span class=k></span><script>document.querySelector('.k').setAttribute('data-marker', performance.timeOrigin + 'x'.repeat(50 << 20));";
    long uncached = reloadGrowth(view, [marked stringByAppendingString:@"</script>"]);
    long cached = reloadGrowth(view, [marked stringByAppendingString:@"document.body.querySelectorAll('.k').length;</script>"]);
    check(uncached < 40 * 1024 * 1024,
          [NSString stringWithFormat:@"reloads release a page without cached query results: %ld bytes", uncached]);
    check(cached > 3 * 40 * 1024 * 1024,
          [NSString stringWithFormat:@"reloads keep a page with cached query results until memory pressure: %ld bytes", cached]);
    [window close];
    return failures ? 1 : 0;
}}
