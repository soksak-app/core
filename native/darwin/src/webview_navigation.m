#import <objc/runtime.h>
#import "event_ring.h"
#import "webview_navigation.h"
#import "private/webkit.h"

// Forwarder placed in front of the navigation delegate of the framework. WKWebView references its delegate
// weakly, so the forwarder is kept as an associated object of the web view and references the framework
// delegate weakly. There is no cycle even if the framework delegate retains the web view.
@interface SPNavigationForwarder : NSProxy <WKNavigationDelegate> {
@public
    // One element. It becomes nil when the framework delegate is released.
    NSPointerArray *target;
}
@end

@implementation SPNavigationForwarder

- (id)target {
    return [target pointerAtIndex:0];
}

- (void)dealloc {
    [target release];
    [super dealloc];
}

// Selectors that this forwarder handles itself. For the others it responds only to what the framework
// delegate implements.
static BOOL handled(SEL selector) {
    return selector == @selector(webView:decidePolicyForNavigationAction:decisionHandler:) ||
        selector == @selector(webView:didCommitNavigation:) ||
        selector == @selector(_webView:webContentProcessDidTerminateWithReason:);
}

// The name of a reason of a WebContent process end (SPProcessTerminationReason), and `unknown-<n>` for a value that
// WebKit defines after this code.
static NSString *terminationReasonName(NSInteger reason) {
    switch (reason) {
        case SPProcessTerminationReasonExceededMemoryLimit: return @"exceeded-memory";
        case SPProcessTerminationReasonExceededCPULimit: return @"exceeded-cpu";
        case SPProcessTerminationReasonRequestedByClient: return @"requested-by-client";
        case SPProcessTerminationReasonCrash: return @"crash";
        case SPProcessTerminationReasonExceededSharedProcessCrashLimit: return @"exceeded-shared-process-crash-limit";
        default: return [NSString stringWithFormat:@"unknown-%ld", (long)reason];
    }
}

- (BOOL)respondsToSelector:(SEL)selector {
    if (selector == @selector(webView:decidePolicyForNavigationAction:preferences:decisionHandler:)) return NO; // silent: the answer NO selects the variant of the delegate method without preferences, which is the contract of the forwarder
    return handled(selector) || [self.target respondsToSelector:selector];
}

- (BOOL)conformsToProtocol:(Protocol *)protocol {
    return protocol == @protocol(WKNavigationDelegate) || [self.target conformsToProtocol:protocol];
}

- (NSMethodSignature *)methodSignatureForSelector:(SEL)selector {
    id current = self.target;
    NSMethodSignature *signature = [current methodSignatureForSelector:selector];
    if (!signature) {
        // default: a notification after the framework delegate is gone has no receiver, so it is
        // received with a void signature and discarded.
        signature = [NSMethodSignature signatureWithObjCTypes:"v@:"];
    }
    return signature;
}

- (void)forwardInvocation:(NSInvocation *)invocation {
    id current = self.target;
    if ([current respondsToSelector:invocation.selector]) [invocation invokeWithTarget:current];
}

// Whether the navigation stays within the same document: only the fragment differs.
static BOOL sameDocument(NSURL *from, NSURL *to) {
    if (!from || !to || !to.fragment) return NO; // silent: a missing address or fragment means the navigation changes the document, which is the result of the predicate
    NSURLComponents *a = [NSURLComponents componentsWithURL:from resolvingAgainstBaseURL:NO];
    NSURLComponents *b = [NSURLComponents componentsWithURL:to resolvingAgainstBaseURL:NO];
    a.fragment = nil;
    b.fragment = nil;
    return [a.URL isEqual:b.URL];
}

- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action
    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    BOOL replacesDocument = action.targetFrame.isMainFrame && webView.URL != nil &&
        !(action.navigationType != WKNavigationTypeReload && sameDocument(webView.URL, action.request.URL));
    void (^decide)(WKNavigationActionPolicy) = ^(WKNavigationActionPolicy policy) {
        decisionHandler(replacesDocument && policy == WKNavigationActionPolicyAllow
            ? SPNavigationActionPolicyAllowInNewProcess : policy);
    };
    id current = self.target;
    if ([current respondsToSelector:_cmd]) [current webView:webView decidePolicyForNavigationAction:action decisionHandler:decide];
    else decide(WKNavigationActionPolicyAllow);
}

- (void)webView:(WKWebView *)webView didCommitNavigation:(WKNavigation *)navigation {
    // The new document has committed, so release the previous document, which was paused for back
    // navigation, and its process.
    [webView _clearBackForwardCache];
    id current = self.target;
    if ([current respondsToSelector:_cmd]) [current webView:webView didCommitNavigation:navigation];
}

// WebKit calls this method instead of webViewWebContentProcessDidTerminate: when the delegate responds to it, so the
// forwarder records the reason and passes the end on under the selector that the framework delegate implements.
- (void)_webView:(WKWebView *)webView webContentProcessDidTerminateWithReason:(SPProcessTerminationReason)reason {
    NSString *fields = [NSString stringWithFormat:@"{\"reason\":\"%@\",\"code\":%ld}", terminationReasonName(reason), (long)reason];
    sp_event(SP_CLASS_LIFECYCLE, SP_EVENT_WARN, "native.webview.process_ended", fields.UTF8String);
    id<SPNavigationDelegatePrivate> current = self.target;
    if ([current respondsToSelector:_cmd]) [current _webView:webView webContentProcessDidTerminateWithReason:reason];
    else if ([current respondsToSelector:@selector(webViewWebContentProcessDidTerminate:)]) [current webViewWebContentProcessDidTerminate:webView];
}

@end

static const char forwarderKey;

bool sp_webview_replace_documents_in_new_process(WKWebView *view) {
    NSCAssert(NSThread.isMainThread, @"sp_webview_replace_documents_in_new_process requires the main thread");
    SPNavigationForwarder *installed = objc_getAssociatedObject(view, &forwarderKey);
    if (installed && (id)view.navigationDelegate == installed) return true;
    if (![view respondsToSelector:@selector(_clearBackForwardCache)]) return false;
    // A web view without a delegate behaves as if it allows every navigation, so only the forwarder is set.
    id delegate = view.navigationDelegate;
    SPNavigationForwarder *forwarder = [SPNavigationForwarder alloc];
    forwarder->target = [[NSPointerArray weakObjectsPointerArray] retain];
    [forwarder->target addPointer:delegate];
    objc_setAssociatedObject(view, &forwarderKey, forwarder, OBJC_ASSOCIATION_RETAIN);
    [forwarder release];
    view.navigationDelegate = forwarder;
    return true;
}
