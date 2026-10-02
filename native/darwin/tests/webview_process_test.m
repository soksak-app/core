// 페이지 reload 전에 WebContent 프로세스 종료는 명시적이고 사용 가능한 동작이어야 한다.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <libproc.h>
#import "webview_geometry.h"
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
    (void)webView;
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

// process 의 physical footprint(바이트). 상주 메모리는 해제한 page 를 할당기가 붙들고 있으면 줄지 않는다.
static long processFootprint(pid_t pid) {
    struct rusage_info_v2 info;
    return proc_pid_rusage(pid, RUSAGE_INFO_V2, (rusage_info_t *)&info) == 0 ? (long)info.ri_phys_footprint : -1;
}

// html 파일을 열고 네 번 다시 읽은 뒤 늘어난 footprint(바이트). 다시 읽을 때마다 JavaScript 객체를 수집한다.
// 문자열로 연 문서는 다시 읽으면 빈 문서가 되므로 임시 디렉터리의 파일로 연다.
static long reloadGrowth(WKWebView *view, NSString *html) {
    NSString *directory = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
    NSURL *file = [NSURL fileURLWithPath:[directory stringByAppendingPathComponent:@"page.html"]];
    check([NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:nil] &&
          [html writeToURL:file atomically:YES encoding:NSUTF8StringEncoding error:nil], @"the test page is written");
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
    [NSFileManager.defaultManager removeItemAtPath:directory error:nil];
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

    check(sp_webview_kill_content_process(view),
          @"the WebContent process termination operation is available");
    until(^BOOL { return first.terminated; });
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

    // WebKit 의 문서별 querySelectorAll 결과 캐시는 결과 요소를 붙잡고, 요소는 문서를 붙잡는다. teardown 은 이 캐시를
    // 비우지 않으므로 같은 process 에서 다시 읽으면 이전 문서가 메모리 압박 전까지 남는다. 쿼리가 없는 같은 페이지는
    // 남기지 않는다.
    // 표식은 쿼리에 걸리는 요소의 속성이다. 같은 값의 속성은 문서끼리 문자열 하나를 나눠 쓰므로 문서마다 다른 값을 쓴다.
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
