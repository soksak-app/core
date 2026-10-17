// Checks that the navigation delegate wrapper of an app DOM webview records the reason of a WebContent process end and
// hands the end to the framework delegate. WebKit calls `_webView:webContentProcessDidTerminateWithReason:` on the
// delegate instead of `webViewWebContentProcessDidTerminate:` when the delegate responds to it, so the wrapper answers
// the private selector and calls the public method of a delegate that implements only the public one. The check does
// not activate the application.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/message.h>
#import "private/webkit.h"
#import "event_ring.h"
#import "webview_navigation.h"
#import "support/records.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Stands in for the navigation delegate of the framework. It implements only the public process end notification.
@interface SPPublicOnlyDelegate : NSObject <WKNavigationDelegate>
@property int ended;
@property (assign) WKWebView *endedView;
@end

@implementation SPPublicOnlyDelegate
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
    self.ended++;
    self.endedView = webView;
}
@end

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    // The end is a warn event, which the default policy refuses (docs/spec/logging.md#policy): this check sets the policy that
    // stores every level, and the default policy is tested in event_ring_test.
    const int8_t everything[SP_CLASS_COUNT] = {SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE};
    check(sp_event_set_policy(everything), @"the policy stores every level of every class");

    WKWebView *view = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 200, 100)] autorelease];
    SPPublicOnlyDelegate *framework = [[[SPPublicOnlyDelegate alloc] init] autorelease];
    view.navigationDelegate = framework;
    check(sp_webview_replace_documents_in_new_process(view), @"the app DOM webview is wrapped");

    // WebKit sends the private selector to the delegate. The wrapper receives it through its selector, so the call
    // goes through the same message send that WebKit uses.
    SEL reasonSelector = NSSelectorFromString(@"_webView:webContentProcessDidTerminateWithReason:");
    id wrapper = view.navigationDelegate;
    NSArray<NSDictionary *> *events = capturedEvents(^{
        ((void (*)(id, SEL, WKWebView *, NSInteger))objc_msgSend)(wrapper, reasonSelector, view, 3);
    });

    check(framework.ended == 1 && framework.endedView == view,
        [NSString stringWithFormat:@"the framework delegate receives the public process end once (%d calls)", framework.ended]);

    NSDictionary *ended = nil;
    for (NSDictionary *event in events) {
        if ([event[@"name"] isEqualToString:@"native.webview.process_ended"]) ended = event;
    }
    check(ended != nil && [ended[@"level"] intValue] == SP_EVENT_WARN && [ended[@"class"] intValue] == SP_CLASS_LIFECYCLE,
        [NSString stringWithFormat:@"the end is stored as native.webview.process_ended at warn in the lifecycle class (%@)", events]);
    check([ended[@"fields"][@"reason"] isEqualToString:@"crash"] && [ended[@"fields"][@"code"] isEqualToNumber:@3],
        [NSString stringWithFormat:@"the event holds reason crash and code 3 (%@)", ended[@"fields"]]);

    view.navigationDelegate = nil;
    return failures ? 1 : 0;
}}
