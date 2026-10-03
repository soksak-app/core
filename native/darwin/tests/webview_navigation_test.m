// 등록한 앱 DOM 웹뷰의 main frame 이 다른 문서로 바뀔 때마다 새 WebContent 프로세스에서 문서를 열고 이전 프로세스를
// 끝내는지 검사한다. WebKit 은 같은 프로세스에서 교체한 문서를 querySelectorAll 결과 캐시 때문에 메모리 압박 전까지
// 남기므로(docs/operations/private-native-apis.md), 프로세스가 끝나야 이전 문서가 해제된다. 프레임워크가 설정한
// navigation delegate 는 계속 모든 알림을 받아야 한다. 애플리케이션을 활성화하지 않는다.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "process_exit.h"
#import "private/webkit.h"
#import "window_facts.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void until(BOOL (^done)(void), NSString *what) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        @autoreleasepool {
            [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
        }
    }
    if (!done()) {
        fprintf(stderr, "FAIL: %s within 10 seconds\n", what.UTF8String);
        exit(1);
    }
}

// 프레임워크의 navigation delegate 를 대신한다. 모든 navigation 을 허용하고 받은 알림을 센다.
@interface SPFrameworkDelegate : NSObject <WKNavigationDelegate>
@property int decisions;
@property int finished;
@end

@implementation SPFrameworkDelegate
- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action
    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    (void)webView;
    (void)action;
    self.decisions++;
    decisionHandler(WKNavigationActionPolicyAllow);
}
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    (void)webView;
    (void)navigation;
    self.finished++;
}
@end

typedef struct {
    int calls;
    bool exited;
} SPExited;

static void exited(void *context, bool value) {
    SPExited *state = context;
    state->calls++;
    state->exited = value;
}

// 이전 프로세스가 끝났는지 커널의 종료 알림으로 확인한다.
static BOOL processEnds(pid_t pid) {
    SPExited state = {0};
    SPExited *answer = &state;
    sp_process_when_exited(pid, 5, exited, answer);
    until(^BOOL { return answer->calls > 0; }, @"the process exit answer arrives");
    return state.exited;
}

static NSString *evaluate(WKWebView *view, NSString *script) {
    __block NSString *value = nil;
    __block BOOL done = NO;
    [view evaluateJavaScript:script completionHandler:^(id result, NSError *error) {
        (void)error;
        value = [[result description] copy];
        done = YES;
    }];
    until(^BOOL { return done; }, @"the script answers");
    return [value autorelease];
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSWindow *window = [[[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 600, 300)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO] autorelease];
    window.releasedWhenClosed = NO;
    WKWebView *view = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:view];
    [window orderBack:nil];
    SPFrameworkDelegate *framework = [[[SPFrameworkDelegate alloc] init] autorelease];
    view.navigationDelegate = framework;
    check(sp_window_set_main_webview(window, view), @"the app DOM webview is registered");

    // 교체한 문서를 남기는 페이지: 캐시되는 querySelectorAll 결과가 있다.
    NSString *directory = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
    NSURL *file = [NSURL fileURLWithPath:[directory stringByAppendingPathComponent:@"page.html"]];
    check([NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:nil] &&
          [@"<span class=k></span><script>document.querySelectorAll('.k').length</script>" writeToURL:file atomically:YES
              encoding:NSUTF8StringEncoding error:nil], @"the test page is written");
    [view loadFileURL:file allowingReadAccessToURL:file.URLByDeletingLastPathComponent];
    until(^BOOL { return framework.finished == 1; }, @"the first document finishes");

    for (int i = 1; i <= 2; i++) {
        pid_t before = view._webProcessIdentifier;
        [view reload];
        until(^BOOL { return framework.finished == 1 + i; }, @"the reloaded document finishes");
        pid_t after = view._webProcessIdentifier;
        check(after > 0 && after != before, [NSString stringWithFormat:
            @"reload %d opens the document in a new WebContent process (%d -> %d)", i, before, after]);
        check(processEnds(before), [NSString stringWithFormat:@"reload %d ends the previous process %d", i, before]);
    }

    pid_t before = view._webProcessIdentifier;
    [view loadFileURL:file allowingReadAccessToURL:file.URLByDeletingLastPathComponent];
    until(^BOOL { return framework.finished == 4; }, @"the document loaded again finishes");
    check(view._webProcessIdentifier != before && processEnds(before), [NSString stringWithFormat:
        @"loading a document again opens it in a new process and ends the previous process %d", before]);

    // 같은 문서 안의 이동은 문서를 바꾸지 않으므로 프로세스를 바꾸지 않는다.
    pid_t current = view._webProcessIdentifier;
    evaluate(view, @"location.hash = 'moved'; location.hash");
    check(view._webProcessIdentifier == current && [evaluate(view, @"location.hash") isEqualToString:@"#moved"],
          @"a fragment navigation stays in the document and its process");

    check(framework.decisions >= 4, [NSString stringWithFormat:
        @"the framework delegate still decides every navigation (%d decisions)", framework.decisions]);
    view.navigationDelegate = nil;
    [NSFileManager.defaultManager removeItemAtPath:directory error:nil];
    [window close];
    check(!NSApp.isActive, @"application stays inactive");
    return failures ? 1 : 0;
}}
