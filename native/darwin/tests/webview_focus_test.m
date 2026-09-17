// 표면 웹뷰의 페이지가 요소에 초점을 줘도 창의 키보드 초점을 옮기지 못하고, 호스트는 옮길 수
// 있는지 검사한다. 애플리케이션을 활성화하지 않는다.
#import <Cocoa/Cocoa.h>
#import "webview_input.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void until(BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    if (!done()) { fprintf(stderr, "FAIL: WebKit did not answer within 10 seconds\n"); exit(1); }
}

// 페이지가 입력 요소에 초점을 주고, 그 결과가 UI 프로세스에 도달할 때까지 기다린다.
static void focusInPage(WKWebView *view) {
    __block BOOL done = NO;
    [view evaluateJavaScript:@"document.getElementById('field').focus(); document.activeElement.id"
        completionHandler:^(id value, NSError *error) { done = YES; }];
    until(^BOOL { return done; });
    __block BOOL settled = NO;
    [view evaluateJavaScript:@"null" completionHandler:^(id value, NSError *error) { settled = YES; }];
    until(^BOOL { return settled; });
}

// 문서 불러오기가 끝나면 알린다.
@interface SPLoaded : NSObject <WKNavigationDelegate>
@property BOOL finished;
@end
@implementation SPLoaded
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation { self.finished = YES; }
@end

static WKWebView *page(NSWindow *window, NSRect frame) {
    WKWebView *view = [[[WKWebView alloc] initWithFrame:frame] autorelease];
    [window.contentView addSubview:view];
    SPLoaded *loaded = [[SPLoaded new] autorelease];
    view.navigationDelegate = loaded;
    [view loadHTMLString:@"<!doctype html><input id='field'>" baseURL:nil];
    until(^BOOL { return loaded.finished; });
    view.navigationDelegate = nil;
    return view;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 600, 300)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    WKWebView *main = page(window, NSMakeRect(0, 0, 300, 300));
    WKWebView *surface = page(window, NSMakeRect(300, 0, 300, 300));
    WKWebView *other = page(window, NSMakeRect(0, 150, 300, 150));
    [window orderBack:nil];

    check(webviewIgnorePageFocus(surface), @"the surface ignores page focus requests");
    [window makeFirstResponder:main];
    focusInPage(surface);
    check(window.firstResponder == main, @"a surface page focusing an element leaves the keyboard focus where it was");

    check([window makeFirstResponder:surface] && window.firstResponder == surface, @"the host can still give the surface keyboard focus");

    focusInPage(other);
    check(window.firstResponder == other, @"a page without the setting takes the keyboard focus when it focuses an element");

    [window close];
    [window release];
    return failures ? 1 : 0;
}}
