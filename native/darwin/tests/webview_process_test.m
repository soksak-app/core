// 페이지 reload 전에 WebContent 프로세스 종료는 명시적이고 사용 가능한 동작이어야 한다.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "webview_geometry.h"

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
    [window close];
    return failures ? 1 : 0;
}}
