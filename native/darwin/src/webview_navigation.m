#import <objc/runtime.h>
#import "webview_navigation.h"
#import "private/webkit.h"

// 프레임워크의 navigation delegate 앞에 놓는 전달자. WKWebView 는 delegate 를 약하게 참조하므로 전달자는 웹뷰의
// 연관 객체로 유지하고, 프레임워크 delegate 는 약하게 참조한다. 프레임워크 delegate 가 웹뷰를 붙잡아도 순환이 없다.
@interface SPNavigationForwarder : NSProxy <WKNavigationDelegate> {
@public
    // 원소 하나. 프레임워크 delegate 가 해제되면 nil 이 된다.
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

// 이 전달자가 직접 처리하는 선택자. 나머지는 프레임워크 delegate 가 구현한 것만 응답한다.
static BOOL handled(SEL selector) {
    return selector == @selector(webView:decidePolicyForNavigationAction:decisionHandler:) ||
        selector == @selector(webView:didCommitNavigation:);
}

- (BOOL)respondsToSelector:(SEL)selector {
    if (selector == @selector(webView:decidePolicyForNavigationAction:preferences:decisionHandler:)) return NO;
    return handled(selector) || [self.target respondsToSelector:selector];
}

- (BOOL)conformsToProtocol:(Protocol *)protocol {
    return protocol == @protocol(WKNavigationDelegate) || [self.target conformsToProtocol:protocol];
}

- (NSMethodSignature *)methodSignatureForSelector:(SEL)selector {
    id current = self.target;
    NSMethodSignature *signature = [current methodSignatureForSelector:selector];
    if (!signature) {
        // 기본값: 프레임워크 delegate 가 사라진 뒤의 알림은 받을 곳이 없으므로 void 시그니처로 받아 버린다.
        signature = [NSMethodSignature signatureWithObjCTypes:"v@:"];
    }
    return signature;
}

- (void)forwardInvocation:(NSInvocation *)invocation {
    id current = self.target;
    if ([current respondsToSelector:invocation.selector]) [invocation invokeWithTarget:current];
}

// 같은 문서 안의 이동인지: fragment 만 다르다.
static BOOL sameDocument(NSURL *from, NSURL *to) {
    if (!from || !to || !to.fragment) return NO;
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
    // 새 문서가 commit 되었으므로 뒤로 이동을 위해 멈춰 둔 이전 문서와 그 프로세스를 놓는다.
    [webView _clearBackForwardCache];
    id current = self.target;
    if ([current respondsToSelector:_cmd]) [current webView:webView didCommitNavigation:navigation];
}

@end

static const char forwarderKey;

bool sp_webview_replace_documents_in_new_process(WKWebView *view) {
    NSCAssert(NSThread.isMainThread, @"sp_webview_replace_documents_in_new_process requires the main thread");
    SPNavigationForwarder *installed = objc_getAssociatedObject(view, &forwarderKey);
    if (installed && (id)view.navigationDelegate == installed) return true;
    if (![view respondsToSelector:@selector(_clearBackForwardCache)]) return false;
    // delegate 가 없는 웹뷰는 모든 navigation 을 허용하는 것과 같으므로 전달자만 둔다.
    id delegate = view.navigationDelegate;
    SPNavigationForwarder *forwarder = [SPNavigationForwarder alloc];
    forwarder->target = [[NSPointerArray weakObjectsPointerArray] retain];
    [forwarder->target addPointer:delegate];
    objc_setAssociatedObject(view, &forwarderKey, forwarder, OBJC_ASSOCIATION_RETAIN);
    [forwarder release];
    view.navigationDelegate = forwarder;
    return true;
}
