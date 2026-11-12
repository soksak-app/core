#import <objc/runtime.h>
#import "application_log.h"
#import "observe.h"
#import "webview_dialogs.h"

// A request of a held window that waits for its answer, or a download whose answer waits for its end.
@interface SPDialogRequest : NSObject {
@public
    uint64_t number;
    void *hold;
    // An open: the completion of the panel.
    void (^chosen)(NSArray<NSURL *> *);
    // A download: the download, the completion of its destination and, after the answer, the end of the answer.
    WKDownload *download;
    void (^destination)(NSURL *);
    SPDialogAnswered answered;
}
@end

@implementation SPDialogRequest
- (void)dealloc {
    [chosen release];
    [download release];
    [destination release];
    [answered release];
    [super dealloc];
}
@end

// The hold of a window. The window keeps it as an associated object, and it keeps the window, so the address that the host
// holds stays valid after the window closed, until sp_window_release_dialogs ends the hold; the requests keep its address only.
@interface SPDialogHold : NSObject {
@public
    NSWindow *window;
    SPDialogRequested requested;
}
@end

@implementation SPDialogHold
- (void)dealloc {
    [requested release];
    [super dealloc];
}
@end

static const char holdKey;
static uint64_t lastRequest;
// The requests by number, while they wait for an answer or, for a download, for its end.
static NSMutableDictionary<NSNumber *, SPDialogRequest *> *waiting;
static NSString *downloadFolder;

static SPDialogHold *holdOf(NSWindow *window) {
    return window ? objc_getAssociatedObject(window, &holdKey) : nil;
}

static NSString *jsonText(NSDictionary *fields) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:fields options:0 error:nil];
    return [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease];
}

// Gives the request to the hold: it waits under its number until it is answered.
static void ask(SPDialogHold *hold, SPDialogRequest *request, NSDictionary *fields) {
    if (!waiting) waiting = [NSMutableDictionary new];
    request->number = ++lastRequest;
    request->hold = hold;
    waiting[@(request->number)] = request;
    NSMutableDictionary *json = [[@{@"suggestedName": NSNull.null, @"directory": NSNull.null, @"multiple": @NO,
        @"directories": @NO, @"url": NSNull.null} mutableCopy] autorelease];
    [json addEntriesFromDictionary:fields];
    hold->requested(request->number, jsonText(json).UTF8String);
}

// The proxy in front of a delegate of the framework of a web view. WKWebView references its delegates weakly, so the proxy is
// kept as an associated object of the web view and references the framework delegate weakly.
@interface SPDialogRoute : NSProxy {
@public
    NSPointerArray *target;
}
@end

@implementation SPDialogRoute
- (id)target {
    return [target pointerAtIndex:0];
}

- (void)dealloc {
    [target release];
    [super dealloc];
}

// The selectors that the route answers itself; for the others it responds only to what the framework delegate implements.
- (BOOL)handles:(SEL)selector {
    (void)selector;
    return NO; // silent: the predicate answers NO because the base route answers no selector itself, so the framework delegate receives every message
}

- (BOOL)respondsToSelector:(SEL)selector {
    return [self handles:selector] || [self.target respondsToSelector:selector];
}

- (BOOL)conformsToProtocol:(Protocol *)protocol {
    return protocol == @protocol(WKUIDelegate) || protocol == @protocol(WKNavigationDelegate) ||
        protocol == @protocol(WKDownloadDelegate) || [self.target conformsToProtocol:protocol];
}

// The types of selector: from the delegate protocols, from the class of the delegate, which also holds the methods that a proxy
// in front of the framework delegate implements itself, or from the delegate.
static const char *typesOf(id current, SEL selector) {
    for (Protocol *protocol in @[@protocol(WKUIDelegate), @protocol(WKNavigationDelegate), @protocol(WKDownloadDelegate)]) {
        for (int required = 0; required < 2; required++) {
            struct objc_method_description method = protocol_getMethodDescription(protocol, selector, required, YES);
            if (method.types) return method.types;
        }
    }
    Method method = current ? class_getInstanceMethod(object_getClass(current), selector) : NULL;
    return method ? method_getTypeEncoding(method) : NULL;
}

- (NSMethodSignature *)methodSignatureForSelector:(SEL)selector {
    id current = self.target;
    const char *types = typesOf(current, selector);
    if (types) return [NSMethodSignature signatureWithObjCTypes:types];
    NSMethodSignature *signature = [current methodSignatureForSelector:selector];
    // default: a message after the framework delegate is gone has no receiver, so it is received with a void signature and
    // discarded.
    return signature ?: [NSMethodSignature signatureWithObjCTypes:"v@:"];
}

- (void)forwardInvocation:(NSInvocation *)invocation {
    id current = self.target;
    if ([current respondsToSelector:invocation.selector]) [invocation invokeWithTarget:current];
}
@end

static SPDialogRoute *routeTo(Class route, id delegate) {
    SPDialogRoute *made = [route alloc];
    made->target = [[NSPointerArray weakObjectsPointerArray] retain];
    [made->target addPointer:delegate];
    return [made autorelease];
}

// The route of the destination of a download.
@interface SPDownloadRoute : SPDialogRoute <WKDownloadDelegate> {
@public
    WKWebView *view;
}
@end

// A name in folder that no file takes: name, then name 2, name 3 and on, before the extension.
static NSString *freePath(NSString *folder, NSString *name) {
    NSString *path = [folder stringByAppendingPathComponent:name];
    NSString *stem = name.stringByDeletingPathExtension;
    NSString *extension = name.pathExtension;
    for (NSUInteger count = 2; [NSFileManager.defaultManager fileExistsAtPath:path]; count++) {
        NSString *numbered = [NSString stringWithFormat:@"%@ %lu", stem, (unsigned long)count];
        if (extension.length) numbered = [numbered stringByAppendingPathExtension:extension];
        path = [folder stringByAppendingPathComponent:numbered];
    }
    return path;
}

static SPDialogRequest *requestOfDownload(WKDownload *download) {
    for (SPDialogRequest *request in waiting.allValues) {
        if (request->download == download) return request;
    }
    return nil;
}

static void downloadEnded(WKDownload *download, NSString *error) {
    SPDialogRequest *request = requestOfDownload(download);
    if (!request || !request->answered) return;
    [request retain];
    [waiting removeObjectForKey:@(request->number)];
    request->answered(error.UTF8String);
    [request release];
}

// The source of the deliveries of the download routes in the native entrance.
static const char *const kDownloadSource = "webview.download";

@implementation SPDownloadRoute
- (BOOL)handles:(SEL)selector {
    return selector == @selector(download:decideDestinationUsingResponse:suggestedFilename:completionHandler:) ||
        selector == @selector(downloadDidFinish:) || selector == @selector(download:didFailWithError:resumeData:);
}

- (void)download:(WKDownload *)download decideDestinationUsingResponse:(NSURLResponse *)response
    suggestedFilename:(NSString *)name completionHandler:(void (^)(NSURL *))completionHandler {
    sp_observe_delivered(kDownloadSource);
    SPDialogHold *hold = holdOf(view.window);
    if (hold) {
        SPDialogRequest *request = [[SPDialogRequest new] autorelease];
        request->download = [download retain];
        request->destination = [completionHandler copy];
        NSURL *url = download.originalRequest.URL ?: response.URL;
        ask(hold, request, @{@"kind": @"download", @"suggestedName": name ?: @"", @"url": url.absoluteString ?: (id)NSNull.null});
        return;
    }
    id current = self.target;
    if ([current respondsToSelector:_cmd]) {
        [current download:download decideDestinationUsingResponse:response suggestedFilename:name completionHandler:completionHandler];
        return;
    }
    NSString *folder = downloadFolder ?: NSSearchPathForDirectoriesInDomains(NSDownloadsDirectory, NSUserDomainMask, YES).firstObject;
    if (!folder) {
        sp_log_error("download", "the user has no folder of downloads, so the download is cancelled");
        completionHandler(nil);
        return;
    }
    completionHandler([NSURL fileURLWithPath:freePath(folder, name.length ? name : @"Unknown")]);
}

- (void)downloadDidFinish:(WKDownload *)download {
    sp_observe_delivered(kDownloadSource);
    downloadEnded(download, nil);
    id current = self.target;
    if ([current respondsToSelector:_cmd]) [current downloadDidFinish:download];
}

- (void)download:(WKDownload *)download didFailWithError:(NSError *)error resumeData:(NSData *)resumeData {
    sp_observe_delivered(kDownloadSource);
    downloadEnded(download, error.localizedDescription ?: @"the download failed");
    id current = self.target;
    if ([current respondsToSelector:_cmd]) [current download:download didFailWithError:error resumeData:resumeData];
}
@end

static const char downloadRouteKey;

// Puts the route in front of the delegate of download, which the framework set when the navigation became the download. The
// download references its delegate weakly, so the download keeps the route. When the entrance refuses the delegate, which it records
// as native.observe.failed, the download keeps the delegate of the framework and drops the route.
static void routeDownload(WKWebView *view, WKDownload *download) {
    SPDownloadRoute *route = (SPDownloadRoute *)routeTo(SPDownloadRoute.class, download.delegate);
    route->view = view;
    objc_setAssociatedObject(download, &downloadRouteKey, route, OBJC_ASSOCIATION_RETAIN);
    if (!sp_observe_delegate(kDownloadSource, SP_OBSERVE_RECORD, download, route))
        objc_setAssociatedObject(download, &downloadRouteKey, nil, OBJC_ASSOCIATION_RETAIN);
}

// The route of the navigations of a web view: a navigation that the page asks to download, and a response that the page cannot
// show or that is an attachment, become downloads when the framework decides nothing about them, and each download is routed.
@interface SPNavigationRoute : SPDialogRoute <WKNavigationDelegate>
@end

static BOOL isAttachment(WKNavigationResponse *response) {
    if (![response.response isKindOfClass:NSHTTPURLResponse.class]) return NO; // silent: the predicate answers NO for a response that is not HTTP, which has no Content-Disposition, and the caller decides by its MIME type
    NSString *disposition = [(NSHTTPURLResponse *)response.response valueForHTTPHeaderField:@"Content-Disposition"];
    return [[disposition.lowercaseString stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet] hasPrefix:@"attachment"];
}

@implementation SPNavigationRoute
// WebKit reads which methods the delegate implements when the delegate is set, so it keeps calling a method of the framework delegate
// after that delegate is gone, as when the framework releases it while its web view closes. A forwarded message without its receiver
// is discarded, and a discarded decision handler ends the process (CompletionHandlerCallChecker), so the route answers each method
// with a handler itself and decides as a web view without that delegate method when the framework delegate is gone.
- (BOOL)handles:(SEL)selector {
    return selector == @selector(webView:decidePolicyForNavigationAction:decisionHandler:) ||
        selector == @selector(webView:decidePolicyForNavigationResponse:decisionHandler:) ||
        selector == @selector(webView:navigationAction:didBecomeDownload:) ||
        selector == @selector(webView:navigationResponse:didBecomeDownload:);
}

- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action
    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    id current = self.target;
    if ([current respondsToSelector:_cmd]) {
        [current webView:webView decidePolicyForNavigationAction:action decisionHandler:decisionHandler];
        return;
    }
    // default: a web view without the delegate method allows every navigation.
    decisionHandler(WKNavigationActionPolicyAllow);
}

- (void)webView:(WKWebView *)webView decidePolicyForNavigationResponse:(WKNavigationResponse *)response
    decisionHandler:(void (^)(WKNavigationResponsePolicy))decisionHandler {
    id current = self.target;
    if ([current respondsToSelector:_cmd]) {
        [current webView:webView decidePolicyForNavigationResponse:response decisionHandler:decisionHandler];
        return;
    }
    BOOL download = isAttachment(response) || !response.canShowMIMEType;
    decisionHandler(download ? WKNavigationResponsePolicyDownload : WKNavigationResponsePolicyAllow);
}

- (void)webView:(WKWebView *)webView navigationAction:(WKNavigationAction *)action didBecomeDownload:(WKDownload *)download {
    id current = self.target;
    if ([current respondsToSelector:_cmd]) [current webView:webView navigationAction:action didBecomeDownload:download];
    routeDownload(webView, download);
}

- (void)webView:(WKWebView *)webView navigationResponse:(WKNavigationResponse *)response didBecomeDownload:(WKDownload *)download {
    id current = self.target;
    if ([current respondsToSelector:_cmd]) [current webView:webView navigationResponse:response didBecomeDownload:download];
    routeDownload(webView, download);
}
@end

// The route of the open panels of a web view.
@interface SPPanelRoute : SPDialogRoute <WKUIDelegate>
@end

@implementation SPPanelRoute
// The route answers each method with a handler itself, as the navigation route does.
- (BOOL)handles:(SEL)selector {
    return selector == @selector(webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:) ||
        selector == @selector(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:);
}

- (void)webView:(WKWebView *)webView requestMediaCapturePermissionForOrigin:(WKSecurityOrigin *)origin
    initiatedByFrame:(WKFrameInfo *)frame type:(WKMediaCaptureType)type decisionHandler:(void (^)(WKPermissionDecision))decisionHandler {
    id current = self.target;
    if ([current respondsToSelector:_cmd]) {
        [current webView:webView requestMediaCapturePermissionForOrigin:origin initiatedByFrame:frame type:type
            decisionHandler:decisionHandler];
        return;
    }
    // default: a web view without the delegate method prompts the person.
    decisionHandler(WKPermissionDecisionPrompt);
}

- (void)webView:(WKWebView *)webView runOpenPanelWithParameters:(WKOpenPanelParameters *)parameters
    initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(NSArray<NSURL *> *))completionHandler {
    SPDialogHold *hold = holdOf(webView.window);
    if (hold) {
        SPDialogRequest *request = [[SPDialogRequest new] autorelease];
        request->chosen = [completionHandler copy];
        ask(hold, request, @{@"kind": @"open", @"multiple": @(parameters.allowsMultipleSelection),
            @"directories": @(parameters.allowsDirectories)});
        return;
    }
    id current = self.target;
    if ([current respondsToSelector:_cmd]) {
        [current webView:webView runOpenPanelWithParameters:parameters initiatedByFrame:frame completionHandler:completionHandler];
        return;
    }
    completionHandler(nil);
}
@end

static const char panelRouteKey;
static const char navigationRouteKey;

// The delegate behind a route: a web view that copied the delegate of another web view copies its route.
static id behind(id delegate) {
    Class kind = delegate ? object_getClass(delegate) : Nil;
    if (kind == SPPanelRoute.class || kind == SPNavigationRoute.class) return ((SPDialogRoute *)delegate).target;
    return delegate;
}

void sp_webview_route_dialogs(WKWebView *view) {
    NSCAssert(NSThread.isMainThread, @"sp_webview_route_dialogs requires the main thread");
    // A route stays in front of the delegate that it routes also when another proxy is put in front of it later, such as the
    // navigation forwarder of a main web view, so a web view is routed once.
    if (objc_getAssociatedObject(view, &panelRouteKey)) return;
    SPDialogRoute *panels = routeTo(SPPanelRoute.class, behind(view.UIDelegate));
    objc_setAssociatedObject(view, &panelRouteKey, panels, OBJC_ASSOCIATION_RETAIN);
    view.UIDelegate = (id<WKUIDelegate>)panels;
    SPDialogRoute *navigations = routeTo(SPNavigationRoute.class, behind(view.navigationDelegate));
    objc_setAssociatedObject(view, &navigationRouteKey, navigations, OBJC_ASSOCIATION_RETAIN);
    view.navigationDelegate = (id<WKNavigationDelegate>)navigations;
}

void *sp_window_hold_dialogs(void *handle, SPDialogRequested requested) {
    NSCAssert(NSThread.isMainThread, @"sp_window_hold_dialogs requires the main thread");
    NSWindow *window = (NSWindow *)handle;
    if (!window || holdOf(window)) return NULL;
    // The host owns the new hold until sp_window_release_dialogs.
    SPDialogHold *hold = [SPDialogHold new];
    hold->window = [window retain];
    hold->requested = [requested copy];
    objc_setAssociatedObject(window, &holdKey, hold, OBJC_ASSOCIATION_RETAIN);
    return hold;
}

// Answers request as cancelled: an open receives no file, and a download is cancelled before it starts.
static void cancel(SPDialogRequest *request) {
    if (request->chosen) request->chosen(nil);
    if (request->destination) request->destination(nil);
}

void sp_window_release_dialogs(void *handle) {
    NSCAssert(NSThread.isMainThread, @"sp_window_release_dialogs requires the main thread");
    SPDialogHold *hold = handle;
    if (!hold) return;
    if (holdOf(hold->window) == hold) objc_setAssociatedObject(hold->window, &holdKey, nil, OBJC_ASSOCIATION_RETAIN);
    for (NSNumber *number in waiting.allKeys) {
        SPDialogRequest *request = waiting[number];
        // A download that was answered goes on to its end.
        if (request->hold != hold || request->answered) continue;
        [request retain];
        [waiting removeObjectForKey:number];
        cancel(request);
        [request release];
    }
    [hold->window release];
    hold->window = nil;
    [hold release];
}

void sp_dialog_answer(uint64_t number, const char *const *paths, size_t count, bool cancelled, SPDialogAnswered answered) {
    NSCAssert(NSThread.isMainThread, @"sp_dialog_answer requires the main thread");
    SPDialogRequest *request = [[waiting[@(number)] retain] autorelease];
    // A request that waits no more was cancelled or answered, so its cancel changes nothing.
    if (cancelled && !request) {
        answered(NULL);
        return;
    }
    if (!request || request->answered) {
        answered([NSString stringWithFormat:@"no request %llu waits", (unsigned long long)number].UTF8String);
        return;
    }
    if (cancelled) {
        [waiting removeObjectForKey:@(number)];
        cancel(request);
        answered(NULL);
        return;
    }
    NSMutableArray<NSURL *> *files = [NSMutableArray array];
    for (size_t index = 0; index < count; index++) {
        [files addObject:[NSURL fileURLWithPath:[NSString stringWithUTF8String:paths[index]]]];
    }
    if (request->chosen) {
        [waiting removeObjectForKey:@(number)];
        request->chosen(files);
        answered(NULL);
        return;
    }
    if (files.count != 1) {
        answered("a download takes one path");
        return;
    }
    // The host checked that the answer replaces an existing file only when it was asked to; WebKit writes no file over one.
    NSError *error = nil;
    if ([NSFileManager.defaultManager fileExistsAtPath:files[0].path] &&
        ![NSFileManager.defaultManager removeItemAtURL:files[0] error:&error]) {
        answered([NSString stringWithFormat:@"the file %@ is not replaced: %@", files[0].path, error.localizedDescription].UTF8String);
        return;
    }
    request->answered = [answered copy];
    request->destination(files[0]);
}

void sp_dialogs_set_download_folder(const char *folder) {
    NSCAssert(NSThread.isMainThread, @"sp_dialogs_set_download_folder requires the main thread");
    [downloadFolder release];
    downloadFolder = folder ? [[NSString alloc] initWithUTF8String:folder] : nil;
}
