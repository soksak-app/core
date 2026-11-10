// Checks that a page of a surface webview cannot move the keyboard focus of the window by focusing an element, while
// the host can move it. The check does not activate the application.
#import <Cocoa/Cocoa.h>
#import "webview_input.h"
#import "support/event_wait.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Waits until the page focuses an input element and the result reaches the UI process.
static void focusInPage(WKWebView *view) {
    __block BOOL done = NO;
    [view evaluateJavaScript:@"document.getElementById('field').focus(); document.activeElement.id"
        completionHandler:^(id value, NSError *error) { done = YES; }];
    eventWait(@"the page answers the focus request", ^BOOL { return done; });
    __block BOOL settled = NO;
    [view evaluateJavaScript:@"null" completionHandler:^(id value, NSError *error) { settled = YES; }];
    eventWait(@"the page answers the evaluation after the focus request", ^BOOL { return settled; });
}

// Notifies when the document load finishes.
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
    eventWait(@"the navigation of the document finishes", ^BOOL { return loaded.finished; });
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
