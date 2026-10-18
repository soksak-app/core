// An external document webview inside a surface document.
//
// The state is read from the KVO properties of WKWebView and from WKNavigationDelegate. The scroll position is sent
// on
// every scroll event by a script in a content world (WKContentWorld) dedicated to the document. That world and its
// message
// handler are not visible to the scripts of the document page.
#import <Cocoa/Cocoa.h>
#import <CoreImage/CoreImage.h>
#import <WebKit/WebKit.h>
#import "application_log.h"
#import "document_view.h"
#import "event_ring.h"
#import "observe.h"
#import "private/webkit.h"
#import "webview_geometry.h"
#import "webview_input.h"

static NSString *const kScrollMessage = @"soksakDocumentScroll";

static NSString *const kScrollScript = @"(() => {"
    "const post = () => window.webkit.messageHandlers.soksakDocumentScroll.postMessage("
    "{ x: window.scrollX, y: window.scrollY });"
    "addEventListener('scroll', post, { capture: true, passive: true });"
    "addEventListener('load', post);"
    "post();"
    "})();";

// Forwards each message that a plugin document posts to its own window (docs/spec/native-surfaces.md#document-regions).
// The script runs in the host's content world, so it sees the message events of the page world without giving the
// page access to the handler; other documents have no message channel.
static NSString *const kMessageMessage = @"soksakDocumentMessage";
static NSString *const kMessageScript = @"(() => {"
    "if (location.protocol !== 'sok:') return;"
    "addEventListener('message', (event) => {"
    "if (event.source !== window) return;"
    "let text;"
    "try { text = JSON.stringify(event.data); } catch (error) { text = undefined; }"
    "window.webkit.messageHandlers.soksakDocumentMessage.postMessage("
    "text === undefined ? { error: 'the message data is not JSON' } : { message: text });"
    "});"
    "})();";

// The script of the document streams (docs/spec/native-surfaces.md#document-streams) and of the link under the pointer.
// It collects the elements and requests only while the host turns their stream on, so a document without a subscriber
// posts no element or request data. It runs in the content world of the host, so page scripts cannot send to this handler.
static NSString *const kPageMessage = @"soksakDocumentPage";
// The content world of the scripts of the host in a document.
static NSString *const kDocumentWorld = @"soksak-document";
static NSString *const kPageScript = @"(() => {"
    "const post = (value) => window.webkit.messageHandlers.soksakDocumentPage.postMessage(value);"
    // The element stream: the observer only marks the tree changed, once until the next snapshot takes it.
    "let elements = false; let marked = false;"
    "const tree = new MutationObserver(() => { if (marked) return; marked = true; post({ changed: true }); });"
    "globalThis.soksakSnapshot = () => {"
    "  marked = false; const nodes = []; let total = 0;"
    "  const walk = (element, depth) => {"
    "    total++;"
    "    if (nodes.length < 500) nodes.push({ depth, tag: element.localName, id: element.getAttribute('id') ?? '',"
    "      class: element.getAttribute('class') ?? '' });"
    "    for (const child of element.children) walk(child, depth + 1);"
    "  };"
    "  if (document.documentElement) walk(document.documentElement, 0);"
    "  return { nodes, total, truncated: total > 500 };"
    "};"
    // The request stream: each batch of new entries, the navigation first; the resource timing buffer is not cleared.
    "let resources = null;"
    "const entry = (item) => ({ url: item.name, type: item.entryType === 'navigation' ? 'navigation' : (item.initiatorType || 'other'),"
    "  start: item.startTime, duration: item.duration });"
    "globalThis.soksakStream = (name, on) => {"
    "  if (name === 'elements') {"
    "    if (on === elements) return null;"
    "    elements = on;"
    "    if (on) { tree.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['id', 'class'] });"
    "      marked = true; post({ changed: true }); }"
    "    else { tree.disconnect(); marked = false; }"
    "    return null;"
    "  }"
    "  if (name === 'requests') {"
    "    if (on === (resources !== null)) return null;"
    "    if (on) {"
    "      post({ entries: performance.getEntriesByType('navigation').map(entry) });"
    "      resources = new PerformanceObserver((list) => post({ entries: list.getEntries().map(entry) }));"
    "      resources.observe({ type: 'resource', buffered: true });"
    "    } else { resources.disconnect(); resources = null; }"
    "    return null;"
    "  }"
    "  throw new Error(`unknown stream ${name}`);"
    "};"
    "let link = null;"
    "const point = (target) => {"
    "  const anchor = target instanceof Element ? target.closest('a[href]') : null;"
    "  const next = anchor ? anchor.href : null;"
    "  if (next !== link) { link = next; post({ link: link ?? '' }); }"
    "};"
    "addEventListener('mouseover', (event) => point(event.target), true);"
    "addEventListener('mouseout', (event) => { if (!event.relatedTarget) point(null); }, true);"
    "addEventListener('pagehide', () => point(null));"
    // A document restored from the page cache does not run this script again, so it asks for its streams again.
    "addEventListener('pageshow', (event) => { if (event.persisted) post({ ready: true }); });"
    "post({ ready: true });"
    "})();";

// The contexts of the key paths that the document view registers; a notification with another context belongs to the platform.
static char kStateContext;
static char kAppearanceContext;

static NSArray<NSString *> *observedKeys(void) {
    return @[ @"URL", @"title", @"loading", @"estimatedProgress", @"canGoBack", @"canGoForward" ];
}

@class SPDocumentView;

// The time in seconds that a region stays hidden before it clears its back-forward cache.
static NSTimeInterval hiddenClearDelay = 300;

// The open document regions, which memory pressure clears. The table does not retain them; sp_document_close removes each.
static NSHashTable<SPDocumentView *> *openDocuments(void) {
    static NSHashTable<SPDocumentView *> *documents;
    if (!documents) {
        documents = [[NSHashTable alloc] initWithOptions:NSPointerFunctionsOpaqueMemory | NSPointerFunctionsObjectPointerPersonality
            capacity:0];
    }
    return documents;
}

// The memory pressure source of the process. It is created with the first document region and kept until the process ends.
static void watchMemoryPressure(void) {
    static dispatch_source_t source;
    if (source) return;
    source = dispatch_source_create(DISPATCH_SOURCE_TYPE_MEMORYPRESSURE, 0,
        DISPATCH_MEMORYPRESSURE_WARN | DISPATCH_MEMORYPRESSURE_CRITICAL, dispatch_get_main_queue());
    dispatch_source_set_event_handler(source, ^{ sp_document_memory_pressure(); });
    dispatch_resume(source);
}

extern double sp_surface_scale(void *surface);

static CGFloat documentSurfaceScale(NSView *surface) {
    return sp_surface_scale(surface);
}

// The message handler for scroll and document content. The user content controller retains the handler, so it points
// to the view weakly.
@interface SPDocumentScroll : NSObject <WKScriptMessageHandler>
@property(assign) SPDocumentView *view;
@end

@interface SPDocumentView : WKWebView <WKNavigationDelegate, WKUIDelegate>
@property sp_document_changed changed;
@property sp_document_message message;
@property void *messageContext;
// The id of the plugin whose surface owns the region; its plugin documents have the origin sok://<plugin>.
@property(copy) NSString *plugin;
- (void)reportMessage:(NSDictionary *)value;
@property void *context;
@property sp_document_event event;
@property void *eventContext;
@property(retain) id eventMonitor;
@property(retain) SPDocumentScroll *scroll;
@property(copy) NSString *failure;
// The main frame navigation in progress. From the time it is requested or started until it ends or fails, it is
// reported as loading,
// because when the replaced earlier navigation is cancelled, WKWebView.loading becomes NO before the new navigation
// starts.
@property(retain) WKNavigation *navigation;
@property(assign) NSView *webSurface;
@property NSPoint offset;
// The document streams (docs/spec/native-surfaces.md#document-streams). The host turns a stream on while it has a
// subscriber; ready is set when the script of the current document is installed.
@property sp_document_stream stream;
@property void *streamContext;
@property BOOL elementsOn;
@property BOOL requestsOn;
@property BOOL ready;
// The element tree changed since the last snapshot was taken.
@property BOOL dirty;
// A snapshot is being taken from the document.
@property BOOL taking;
// The seq of the last snapshot sent and of the snapshot that the host has not acknowledged (0 for none). seq keeps
// increasing across navigations.
@property unsigned long long lastSeq;
@property unsigned long long unacknowledged;
// The address of the link under the pointer. It is an empty string if there is none.
@property(copy) NSString *link;
@property NSEdgeInsets insets;
// The text scale (docs/spec/text-size.md). It is applied as page zoom.
@property double zoom;
@property BOOL wanted;
@property BOOL placed;
@property BOOL pending;
@property BOOL closed;
// Runs while the region is hidden and clears the back-forward cache when the hidden clear delay passes.
@property(retain) NSTimer *hiddenTimer;
- (void)clearBackForwardCache:(NSString *)reason;
- (void)stopHiddenTimer;
- (void)report;
- (void)request:(WKNavigation *)navigation;
- (BOOL)requestIfStarted:(WKNavigation *)navigation;
- (void)applyInsets;
- (void)surfaceScaleChanged;
- (void)surfaceAppearanceChanged:(NSNotification *)notification;
- (void)reportEvent:(const char *)json;
- (void)sendStream:(NSString *)name message:(NSDictionary *)message;
- (void)applyStream:(NSString *)name;
- (void)takeSnapshot;
@end

// The scheme of application documents inside webviews (docs/spec/native-host.md#application-addresses).
static NSString *const kApplicationScheme = @"sok";

// The content type of a plugin file from its extension (docs/spec/native-surfaces.md#document-regions).
static NSString *pluginContentType(NSString *path) {
    static NSDictionary<NSString *, NSString *> *types;
    if (!types) {
        types = [@{
            @"html": @"text/html", @"js": @"text/javascript", @"mjs": @"text/javascript", @"css": @"text/css",
            @"json": @"application/json", @"wasm": @"application/wasm", @"svg": @"image/svg+xml", @"png": @"image/png",
            @"jpg": @"image/jpeg", @"jpeg": @"image/jpeg", @"webp": @"image/webp", @"ico": @"image/x-icon",
            @"woff2": @"font/woff2", @"woff": @"font/woff", @"ttf": @"font/ttf", @"otf": @"font/otf", @"txt": @"text/plain",
        } retain];
    }
    NSString *type = types[path.pathExtension.lowercaseString];
    return type ?: @"application/octet-stream"; // default: an extension outside the list is sent as bytes.
}

// Serves sok://<plugin>/<path> from the folder of the region's plugin.
@interface SPPluginScheme : NSObject <WKURLSchemeHandler>
@property(copy) NSString *root;
@property(copy) NSString *plugin;
@end

@implementation SPPluginScheme
- (void)webView:(WKWebView *)view startURLSchemeTask:(id<WKURLSchemeTask>)task {
    (void)view;
    NSURL *url = task.request.URL;
    NSArray<NSString *> *parts = [url.path componentsSeparatedByString:@"/"];
    BOOL inside = self.root != nil && [url.host isEqualToString:self.plugin] && parts.count > 1 && parts[0].length == 0;
    for (NSUInteger index = 1; inside && index < parts.count; index++) {
        NSString *part = parts[index];
        if (part.length == 0 || [part isEqualToString:@"."] || [part isEqualToString:@".."]) inside = NO;
    }
    NSString *file = inside ? [self.root stringByAppendingPathComponent:[url.path substringFromIndex:1]] : nil;
    BOOL directory = NO;
    NSData *data = file && [[NSFileManager defaultManager] fileExistsAtPath:file isDirectory:&directory] && !directory
        ? [NSData dataWithContentsOfFile:file] : nil;
    if (!data) {
        sp_log_info("document view", [NSString stringWithFormat:@"plugin file not found: %@", url.absoluteString].UTF8String);
        [task didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorFileDoesNotExist
            userInfo:@{ NSLocalizedDescriptionKey: [NSString stringWithFormat:@"%@ is not found", url.absoluteString] }]];
        return;
    }
    NSHTTPURLResponse *response = [[[NSHTTPURLResponse alloc] initWithURL:url statusCode:200 HTTPVersion:@"HTTP/1.1"
        headerFields:@{ @"Content-Type": pluginContentType(file), @"Content-Length": @(data.length).stringValue }] autorelease];
    [task didReceiveResponse:response];
    [task didReceiveData:data];
    [task didFinish];
}

- (void)webView:(WKWebView *)view stopURLSchemeTask:(id<WKURLSchemeTask>)task {
    (void)view; (void)task;
}

- (void)dealloc { [_root release]; [_plugin release]; [super dealloc]; }
@end

@implementation SPDocumentScroll
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    SPDocumentView *view = self.view;
    if (!view || !message.frameInfo.isMainFrame || ![message.body isKindOfClass:NSDictionary.class]) return;
    NSDictionary *body = message.body;
    if ([message.name isEqualToString:kMessageMessage]) {
        if ([body[@"message"] isKindOfClass:NSString.class]) {
            [view reportMessage:@{ @"text": body[@"message"] }];
        } else {
            NSString *reason = [body[@"error"] isKindOfClass:NSString.class] ? body[@"error"] : @"the message has no data";
            sp_log_info("document view", [NSString stringWithFormat:@"message without data: %@ (%@)", reason, view.URL.absoluteString].UTF8String);
            [view reportMessage:@{ @"error": reason }];
        }
        return;
    }
    if ([message.name isEqualToString:kPageMessage]) {
        if ([body[@"ready"] isEqual:@YES]) {
            view.ready = YES;
            [view applyStream:@"elements"];
            [view applyStream:@"requests"];
        }
        if ([body[@"changed"] isEqual:@YES]) {
            view.dirty = YES;
            [view takeSnapshot];
        }
        if ([body[@"entries"] isKindOfClass:NSArray.class] && view.requestsOn) {
            [view sendStream:@"requests" message:@{ @"type": @"entries", @"entries": body[@"entries"] }];
        }
        if ([body[@"link"] isKindOfClass:NSString.class]) {
            view.link = body[@"link"];
            [view report];
        }
        return;
    }
    if (![body[@"x"] isKindOfClass:NSNumber.class] || ![body[@"y"] isKindOfClass:NSNumber.class]) return;
    NSPoint offset = NSMakePoint([body[@"x"] doubleValue], [body[@"y"] doubleValue]);
    if (NSEqualPoints(offset, view.offset)) return;
    view.offset = offset;
    [view report];
}
@end

@implementation SPDocumentView

- (void)dealloc {
    [_scroll release];
    [_failure release];
    [_link release];
    [_plugin release];
    [_navigation release];
    [_eventMonitor release];
    [_hiddenTimer release];
    [super dealloc];
}

// WebKit keeps each page that a region navigated away from in its back-forward cache, suspended with its process, and
// releases it only when the cache exceeds its capacity. A region releases these pages after it stays hidden for the hidden
// clear delay and under memory pressure (docs/spec/native-surfaces.md#document-regions); going back then loads the page again.
// A region without back or forward entries has no cached page.
- (void)clearBackForwardCache:(NSString *)reason {
    if (self.closed || (self.backForwardList.backList.count == 0 && self.backForwardList.forwardList.count == 0)) return;
    [self _clearBackForwardCache];
    NSString *fields = [NSString stringWithFormat:@"{\"reason\":\"%@\"}", reason];
    sp_event(SP_CLASS_LIFECYCLE, SP_EVENT_INFO, "native.document.backforward_cleared", fields.UTF8String);
}

- (void)hiddenDelayPassed:(NSTimer *)timer {
    self.hiddenTimer = nil;
    [self clearBackForwardCache:@"hidden"];
}

- (void)stopHiddenTimer {
    [self.hiddenTimer invalidate];
    self.hiddenTimer = nil;
}

// AppKit calls viewDidHide and viewDidUnhide when the region or one of its ancestors is hidden or shown.
- (void)viewDidHide {
    [super viewDidHide];
    if (self.closed || self.hiddenTimer) return;
    self.hiddenTimer = [NSTimer scheduledTimerWithTimeInterval:hiddenClearDelay target:self
        selector:@selector(hiddenDelayPassed:) userInfo:nil repeats:NO];
}

- (void)viewDidUnhide {
    [super viewDidUnhide];
    [self stopHiddenTimer];
}

- (void)reportEvent:(const char *)json {
    if (!self.closed && self.event) self.event(self.eventContext, json);
}

// Sends {"message": <text>} with the JSON text of a message, or {"error": <reason>}, to the message receiver.
- (void)reportMessage:(NSDictionary *)value {
    if (self.closed || !self.message) return;
    NSString *json;
    if (value[@"text"]) {
        json = [NSString stringWithFormat:@"{\"message\":%@}", value[@"text"]];
    } else {
        NSData *data = [NSJSONSerialization dataWithJSONObject:@{ @"error": value[@"error"] } options:0 error:nil];
        json = [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease];
    }
    self.message(self.messageContext, json.UTF8String);
}

- (void)installEventMonitor {
    SPDocumentView *document = self;
    self.eventMonitor = sp_observe_local_monitor("document_view.click", SP_OBSERVE_RECORD, NSEventMaskLeftMouseDown,
        ^NSEvent *(NSEvent *event) {
            NSWindow *window = event.window;
            NSView *content = window.contentView;
            NSView *hit = content ? [content hitTest:[content convertPoint:event.locationInWindow fromView:nil]] : nil;
            if (hit == document || [hit isDescendantOf:document]) [document reportEvent:"{\"type\":\"click\"}"];
            return event;
        });
}

- (void)surfaceAppearanceChanged:(NSNotification *)notification {
    NSAppearance *appearance = self.webSurface.effectiveAppearance;
    if (appearance) self.appearance = appearance;
}

// Combines several changes of the same run loop turn into one report.
- (void)report {
    if (self.closed || self.pending) return;
    self.pending = YES;
    [self retain];
    CFRunLoopPerformBlock(CFRunLoopGetMain(), kCFRunLoopCommonModes, ^{
        self.pending = NO;
        if (!self.closed) [self deliver];
        [self release];
    });
    CFRunLoopWakeUp(CFRunLoopGetMain());
}

// The session history. Entries are ordered from oldest, and index is the position of the current entry. Before the
// first load it is empty and index is -1.
- (NSDictionary *)history {
    WKBackForwardList *list = self.backForwardList;
    NSMutableArray *entries = [NSMutableArray array];
    NSInteger index = -1;
    NSArray<WKBackForwardListItem *> *items = list.currentItem
        ? [[list.backList arrayByAddingObject:list.currentItem] arrayByAddingObjectsFromArray:list.forwardList]
        : @[];
    for (WKBackForwardListItem *item in items) {
        if (item == list.currentItem) index = (NSInteger)entries.count;
        [entries addObject:@{ @"url": item.URL.absoluteString ?: @"", @"title": item.title ?: @"" }];
    }
    return @{ @"entries": entries, @"index": @(index) };
}

- (void)deliver {
    NSDictionary *state = @{
        @"url": self.URL.absoluteString ?: @"",
        @"title": self.title ?: @"",
        @"loading": @(self.loading || self.navigation != nil),
        @"progress": @(self.estimatedProgress),
        @"canGoBack": @(self.canGoBack),
        @"canGoForward": @(self.canGoForward),
        @"error": self.failure ?: (id)NSNull.null,
        @"scroll": @{ @"x": @(self.offset.x), @"y": @(self.offset.y) },
        @"history": [self history],
        @"link": self.link ?: @"",
    };
    NSData *data = [NSJSONSerialization dataWithJSONObject:state options:0 error:nil];
    if (!data) return;
    NSString *text = [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease];
    self.changed(self.context, text.UTF8String);
}

- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary *)change context:(void *)context {
    if (context != &kStateContext && context != &kAppearanceContext) {
        // The platform registers the view as an observer of itself too (a corner radius of the view); those are not ours.
        [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
    } else if (object == self) {
        // The progress of a load changes at the rate of the load, so the changes of the state are counted.
        sp_observe_delivered("document_view.state");
        [self report];
    } else if (object == self.webSurface && [keyPath isEqualToString:@"effectiveAppearance"]) {
        sp_observe_delivered("document_view.appearance");
        [self surfaceAppearanceChanged:nil];
    }
}

- (void)request:(WKNavigation *)navigation {
    self.navigation = navigation;
    [self report];
}

- (BOOL)requestIfStarted:(WKNavigation *)navigation {
    if (!navigation) return NO; // silent: a nil navigation is the answer that WebKit started no load, and the caller returns it to the host
    [self request:navigation];
    return YES;
}

// The navigation finished. If it is not the navigation in progress, it is a replaced navigation and is ignored.
- (void)settle:(WKNavigation *)navigation {
    if (navigation == self.navigation) self.navigation = nil;
}

- (void)webView:(WKWebView *)view didStartProvisionalNavigation:(WKNavigation *)navigation {
    self.navigation = navigation;
    self.failure = nil;
    [self report];
}

// A new document replaces the earlier one: each stream that is on sends reset, an unacknowledged snapshot is dropped, and
// the script of the new document asks for its streams again when it is installed.
- (void)webView:(WKWebView *)view didCommitNavigation:(WKNavigation *)navigation {
    self.ready = NO;
    self.dirty = NO;
    self.unacknowledged = 0;
    if (self.elementsOn) [self sendStream:@"elements" message:@{ @"type": @"reset" }];
    if (self.requestsOn) [self sendStream:@"requests" message:@{ @"type": @"reset" }];
}

// Sends {"stream": name, "message": message} to the receiver of the streams.
- (void)sendStream:(NSString *)name message:(NSDictionary *)message {
    if (self.closed || !self.stream) return;
    NSData *data = [NSJSONSerialization dataWithJSONObject:@{ @"stream": name, @"message": message } options:0 error:nil];
    if (!data) {
        sp_log_error("document stream", [NSString stringWithFormat:@"%@: the message is not JSON", name].UTF8String);
        return;
    }
    NSString *text = [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease];
    self.stream(self.streamContext, text.UTF8String);
}

// Tells the script of the current document whether the stream name is on. Before the script is installed there is
// nothing to tell; its ready message applies the streams.
- (void)applyStream:(NSString *)name {
    if (self.closed || !self.ready) return;
    BOOL on = [name isEqualToString:@"elements"] ? self.elementsOn : self.requestsOn;
    [self callAsyncJavaScript:@"return soksakStream(name, on);" arguments:@{ @"name": name, @"on": @(on) } inFrame:nil
        inContentWorld:[WKContentWorld worldWithName:kDocumentWorld] completionHandler:^(id result, NSError *error) {
        (void)result;
        if (error) sp_log_error("document stream", [NSString stringWithFormat:@"%@ %@: %@", name, on ? @"on" : @"off",
            error.localizedDescription].UTF8String);
    }];
}

// Takes a snapshot of the element tree when the stream is on, the tree changed and no snapshot is unacknowledged, so
// the walk runs once per acknowledged snapshot and not once per change.
- (void)takeSnapshot {
    if (self.closed || !self.ready || !self.elementsOn || !self.dirty || self.unacknowledged || self.taking) return;
    self.taking = YES;
    self.dirty = NO;
    [self callAsyncJavaScript:@"return soksakSnapshot();" arguments:@{} inFrame:nil
        inContentWorld:[WKContentWorld worldWithName:kDocumentWorld] completionHandler:^(id result, NSError *error) {
        self.taking = NO;
        if (self.closed || !self.elementsOn) return;
        if (error || ![result isKindOfClass:NSDictionary.class]) {
            sp_log_error("document stream", [NSString stringWithFormat:@"elements snapshot: %@",
                error ? error.localizedDescription : @"the result is not an object"].UTF8String);
            return;
        }
        self.lastSeq += 1;
        self.unacknowledged = self.lastSeq;
        NSMutableDictionary *message = [[result mutableCopy] autorelease];
        message[@"type"] = @"snapshot";
        message[@"seq"] = @(self.lastSeq);
        [self sendStream:@"elements" message:message];
    }];
}

- (void)fail:(NSError *)error {
    // A new navigation that cancelled the earlier navigation is not a failure.
    if ([error.domain isEqualToString:NSURLErrorDomain] && error.code == NSURLErrorCancelled) return;
    self.failure = error.localizedDescription;
    sp_log_info("document view", [NSString stringWithFormat:@"navigation failed: %@ (%@ %ld) %@", error.localizedDescription,
        error.domain, (long)error.code, error.userInfo[NSURLErrorFailingURLStringErrorKey] ?: [error.userInfo[NSURLErrorFailingURLErrorKey] absoluteString] ?: self.URL.absoluteString ?: @"(no address)"].UTF8String);
    [self report];
}

// The WebContent process of this document ended. The view stays without a document; the failure reaches the page that
// owns the region through the document state.
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)view {
    sp_log_error("document view", [NSString stringWithFormat:@"web content process terminated: %@", self.URL.absoluteString].UTF8String);
    self.navigation = nil;
    self.failure = @"the web content process ended";
    [self report];
}

- (void)webView:(WKWebView *)view didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    [self settle:navigation];
    [self fail:error];
}

- (void)webView:(WKWebView *)view didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    [self settle:navigation];
    [self fail:error];
}

- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
    [self settle:navigation];
    [self report];
}

// A document region opens web addresses, file addresses and plugin addresses, and refuses the application's scheme.
static BOOL webAddress(NSURL *url) {
    NSString *scheme = url.scheme.lowercaseString;
    return [scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"]
        || [scheme isEqualToString:@"file"] || [scheme isEqualToString:kApplicationScheme]
        || [url.absoluteString isEqualToString:@"about:blank"];
}


- (void)webView:(WKWebView *)view decidePolicyForNavigationAction:(WKNavigationAction *)action
    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    if (!webAddress(action.request.URL)) {
        self.failure = [NSString stringWithFormat:@"%@ is not a web address", action.request.URL.absoluteString];
        sp_log_info("document view", [NSString stringWithFormat:@"navigation refused: %@", self.failure].UTF8String);
        // A main frame navigation that was refused does not start. The navigation in progress is the one that
        // received this decision.
        if (action.targetFrame.isMainFrame) self.navigation = nil;
        [self report];
        decisionHandler(WKNavigationActionPolicyCancel);
        return;
    }
    decisionHandler(WKNavigationActionPolicyAllow);
}

// A navigation that requested a new window is opened in the same region.
- (WKWebView *)webView:(WKWebView *)view createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
    forNavigationAction:(WKNavigationAction *)action windowFeatures:(WKWindowFeatures *)features {
    if (webAddress(action.request.URL)) [self request:[self loadRequest:action.request]];
    return nil;
}

// Converts the insets to AppKit point coordinates of the surface view. A CSS pixel is larger than a point by the text
// scale
// (page zoom), and the backing scale applies only to the WebKit raster.
- (void)applyInsets {
    NSView *surface = self.webSurface;
    if (!surface) return;
    NSRect bounds = self.superview.bounds;
    NSEdgeInsets insets = self.insets;
    CGFloat width = NSWidth(bounds) - (insets.left + insets.right);
    CGFloat height = NSHeight(bounds) - (insets.top + insets.bottom);
    CGFloat top = insets.top;
    CGFloat y = surface.isFlipped ? top : NSHeight(bounds) - top - height;
    self.frame = NSMakeRect(insets.left, y, MAX(width, 0), MAX(height, 0));
    self.pageZoom = self.zoom;
    self.hidden = !self.wanted || width < 1 || height < 1 || surface.isHiddenOrHasHiddenAncestor;
}

- (void)surfaceScaleChanged {
    WKWebView *view = (WKWebView *)self;
    view.pageZoom = self.zoom;
    [view _setOverrideDeviceScaleFactor:documentSurfaceScale(self.webSurface)];
    if (self.placed) [self applyInsets];
}

// When the surface size changes, the region is set again from the insets. Autoresizing loses the size from before
// the surface became smaller than the insets.
- (void)viewWillMoveToSuperview:(NSView *)superview {
    if (self.superview) {
        [NSNotificationCenter.defaultCenter removeObserver:self name:NSViewFrameDidChangeNotification object:self.superview];
    }
    [super viewWillMoveToSuperview:superview];
}

- (void)viewDidMoveToSuperview {
    [super viewDidMoveToSuperview];
    if (!self.superview) return;
    self.superview.postsFrameChangedNotifications = YES;
    sp_observe_notification_selector("document_view.resized", SP_OBSERVE_COUNT, self, @selector(surfaceResized:),
        NSViewFrameDidChangeNotification, self.superview);
}

- (void)surfaceResized:(NSNotification *)notification {
    sp_observe_delivered("document_view.resized");
    if (self.placed) [self applyInsets];
}

@end

// One persistent data store per directory. Two store objects that use the same directory write the same files
// separately, so
// all documents of one directory use the same store. The store is kept until the process ends.
static WKWebsiteDataStore *storeForDirectory(const char *path) {
    static NSMutableDictionary<NSString *, WKWebsiteDataStore *> *stores;
    if (!stores) stores = [NSMutableDictionary new];
    NSString *directory = [NSFileManager.defaultManager stringWithFileSystemRepresentation:path length:strlen(path)];
    if (!directory.absolutePath) return nil;
    WKWebsiteDataStore *store = stores[directory];
    if (store) return store;
    if (![NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:nil]) {
        return nil;
    }
    _WKWebsiteDataStoreConfiguration *configuration = [[[_WKWebsiteDataStoreConfiguration alloc]
        initWithDirectory:[NSURL fileURLWithPath:directory isDirectory:YES]] autorelease];
    store = [[[WKWebsiteDataStore alloc] _initWithConfiguration:configuration] autorelease];
    if (store) stores[directory] = store;
    return store;
}

// The Safari name that a document region appends after the user agent. Sites send a reduced page to a WebKit user
// agent
// without a browser name, and the default page of a search engine has no dark theme. The version is the version of
// the system
// Safari, and it is nil if it cannot be read.
static NSString *safariApplicationName(void) {
    NSString *version = [NSBundle bundleWithPath:@"/Applications/Safari.app"].infoDictionary[@"CFBundleShortVersionString"];
    NSArray<NSString *> *parts = [version componentsSeparatedByString:@"."];
    if (parts.count < 2) return nil;
    return [NSString stringWithFormat:@"Version/%@.%@ Safari/605.1.15", parts[0], parts[1]];
}

void *sp_document_create(void *surfaceHandle, const char *directory, const char *folder, const char *plugin,
    sp_document_changed changed, void *context) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    NSView *surface = (NSView *)surfaceHandle;
    if (!surface || !directory || !changed || !surface.window) return NULL;
    WKWebsiteDataStore *store = storeForDirectory(directory);
    if (!store) return NULL;
    NSString *applicationName = safariApplicationName();
    if (!applicationName) return NULL;
    WKWebViewConfiguration *configuration = [[[WKWebViewConfiguration alloc] init] autorelease];
    configuration.applicationNameForUserAgent = applicationName;
    configuration.websiteDataStore = store;
    SPPluginScheme *scheme = [[SPPluginScheme new] autorelease];
    if (folder && plugin) {
        scheme.root = [NSString stringWithUTF8String:folder];
        scheme.plugin = [NSString stringWithUTF8String:plugin];
    }
    [configuration setURLSchemeHandler:scheme forURLScheme:kApplicationScheme];
    WKContentWorld *world = [WKContentWorld worldWithName:kDocumentWorld];
    SPDocumentScroll *scroll = [[SPDocumentScroll new] autorelease];
    [configuration.userContentController addScriptMessageHandler:scroll contentWorld:world name:kScrollMessage];
    [configuration.userContentController addScriptMessageHandler:scroll contentWorld:world name:kPageMessage];
    [configuration.userContentController addScriptMessageHandler:scroll contentWorld:world name:kMessageMessage];
    [configuration.userContentController addUserScript:[[[WKUserScript alloc] initWithSource:kMessageScript
        injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES inContentWorld:world] autorelease]];
    WKUserScript *script = [[[WKUserScript alloc] initWithSource:kScrollScript
        injectionTime:WKUserScriptInjectionTimeAtDocumentEnd forMainFrameOnly:YES inContentWorld:world] autorelease];
    [configuration.userContentController addUserScript:script];
    [configuration.userContentController addUserScript:[[[WKUserScript alloc] initWithSource:kPageScript
        injectionTime:WKUserScriptInjectionTimeAtDocumentEnd forMainFrameOnly:YES inContentWorld:world] autorelease]];

    SPDocumentView *view = [[SPDocumentView alloc] initWithFrame:NSZeroRect configuration:configuration];
    scroll.view = view;
    view.scroll = scroll;
    view.changed = changed;
    view.context = context;
    view.plugin = folder && plugin ? scheme.plugin : nil;
    view.navigationDelegate = view;
    view.UIDelegate = view;
    view.webSurface = surface;
    view.appearance = surface.effectiveAppearance;
    view.hidden = YES;
    watchMemoryPressure();
    if (!webviewInputRegister(view) || !webviewIgnorePageFocus(view)) {
        [view release];
        return NULL;
    }
    NSView *nativePlane = (NSView *)sp_surface_native_plane(surface);
    if (!nativePlane) {
        webviewInputUnregister(view);
        [view release];
        return NULL;
    }
    [nativePlane addSubview:view];
    [view installEventMonitor];
    sp_observe_key_path("document_view.appearance", SP_OBSERVE_RECORD, surface, view, @"effectiveAppearance", 0, &kAppearanceContext);
    view.zoom = 1;
    view.pageZoom = view.zoom;
    [view _setOverrideDeviceScaleFactor:sp_surface_scale(surface)];
    for (NSString *key in observedKeys()) sp_observe_key_path("document_view.state", SP_OBSERVE_COUNT, view, view, key, 0, &kStateContext);
    [openDocuments() addObject:view];
    return view; // The caller owns this reference until sp_document_close.
}

void sp_document_set_message(void *handle, sp_document_message message, void *context) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    SPDocumentView *view = (SPDocumentView *)handle;
    if (!view || view.closed) return;
    view.message = message;
    view.messageContext = context;
}

bool sp_document_post(void *handle, const char *json) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    SPDocumentView *view = (SPDocumentView *)handle;
    if (!view || view.closed || !json || !view.plugin) return false;
    NSURL *url = view.URL;
    if (![url.scheme.lowercaseString isEqualToString:kApplicationScheme] || ![url.host isEqualToString:view.plugin]) return false;
    id value = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json length:strlen(json)]
        options:NSJSONReadingFragmentsAllowed error:nil];
    if (!value) return false;
    [view callAsyncJavaScript:@"window.postMessage(message, location.origin);" arguments:@{ @"message": value }
        inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:^(id result, NSError *error) {
        (void)result;
        if (error) [view reportMessage:@{ @"error": [NSString stringWithFormat:@"post failed: %@", error.localizedDescription] }];
    }];
    return true;
}

void sp_document_set_stream(void *handle, sp_document_stream stream, void *context) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    SPDocumentView *view = (SPDocumentView *)handle;
    if (!view || view.closed) return;
    view.stream = stream;
    view.streamContext = context;
}

bool sp_document_stream_on(void *handle, const char *stream, bool on) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    SPDocumentView *view = (SPDocumentView *)handle;
    if (!view || view.closed || !stream) return false;
    NSString *name = [NSString stringWithUTF8String:stream];
    if ([name isEqualToString:@"elements"]) {
        if (view.elementsOn == on) return true;
        view.elementsOn = on;
        view.dirty = NO;
        view.unacknowledged = 0;
    } else if ([name isEqualToString:@"requests"]) {
        if (view.requestsOn == on) return true;
        view.requestsOn = on;
    } else {
        return false;
    }
    [view applyStream:name];
    return true;
}

bool sp_document_stream_ack(void *handle, unsigned long long seq) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    SPDocumentView *view = (SPDocumentView *)handle;
    if (!view || view.closed) return false;
    // An acknowledgement of a snapshot sent before a reset releases nothing; one of a seq that was never sent is refused.
    if (seq == 0 || seq > view.lastSeq) return false;
    if (seq != view.unacknowledged) return true;
    view.unacknowledged = 0;
    [view takeSnapshot];
    return true;
}

void sp_document_set_event(void *handle, sp_document_event event, void *context) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    SPDocumentView *view = (SPDocumentView *)handle;
    if (!view || view.closed) return;
    view.event = event;
    view.eventContext = context;
}

bool sp_document_load(void *handle, const char *address) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    SPDocumentView *view = (SPDocumentView *)handle;
    NSURL *url = address ? [NSURL URLWithString:[NSString stringWithUTF8String:address]] : nil;
    if (!url || !webAddress(url)) return false;
    // A file address is opened with read access granted up to the directory that holds the file. A file cannot be
    // opened with
    // loadRequest of WKWebView, and loadFileURL is required.
    if ([url.scheme.lowercaseString isEqualToString:@"file"]) {
        NSURL *directory = [url URLByDeletingLastPathComponent] ?: [NSURL fileURLWithPath:@"/"];
        [view request:[view loadFileURL:url allowingReadAccessToURL:directory]];
        return true;
    }
    [view request:[view loadRequest:[NSURLRequest requestWithURL:url]]];
    return true;
}

bool sp_document_go(void *handle, int action, int offset) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    SPDocumentView *view = (SPDocumentView *)handle;
    switch (action) {
        case 0: return [view requestIfStarted:[view goBack]];
        case 1: return [view requestIfStarted:[view goForward]];
        case 2: return [view requestIfStarted:[view reload]];
        case 3: [view stopLoading]; return true;
        case 4: {
            WKBackForwardListItem *item = offset == 0 ? nil : [view.backForwardList itemAtIndex:offset];
            return item ? [view requestIfStarted:[view goToBackForwardListItem:item]] : false;
        }
        default: return false;
    }
}

void sp_document_place(void *handle, double left, double top, double right, double bottom, bool visible) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    SPDocumentView *view = (SPDocumentView *)handle;
    view.insets = NSEdgeInsetsMake(top, left, bottom, right);
    view.wanted = visible;
    view.placed = YES;
    [view applyInsets];
}

void sp_document_frame(void *handle, double *out) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    NSView *view = (NSView *)handle;
    NSView *content = view.window.contentView;
    if (!content) return;
    NSRect frame = [view convertRect:view.bounds toView:content];
    out[0] = frame.origin.x;
    out[1] = content.isFlipped ? frame.origin.y : NSHeight(content.bounds) - NSMaxY(frame);
    out[2] = frame.size.width;
    out[3] = frame.size.height;
    out[4] = view.isHiddenOrHasHiddenAncestor ? 0 : 1;
}

bool sp_document_zoom(void *document, double zoom) {
    NSCAssert(NSThread.isMainThread, @"document zoom requires the UI thread");
    if (!document || !isfinite(zoom) || zoom <= 0) return false;
    SPDocumentView *view = (SPDocumentView *)document;
    view.zoom = zoom;
    view.pageZoom = zoom;
    return true;
}

void sp_document_background(void *handle, bool enabled) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    NSView *view = (NSView *)handle;
    view.wantsLayer = YES;
    view.layerUsesCoreImageFilters = YES;
    if (!enabled) {
        view.contentFilters = @[];
        return;
    }
    // The same radius as the CSS blur(3px) of the surface document. One unit of the view is the CSS pixel multiplied
    // by pageZoom.
    CIFilter *blur = [CIFilter filterWithName:@"CIGaussianBlur"];
    [blur setValue:@(3 * ((WKWebView *)view).pageZoom) forKey:kCIInputRadiusKey];
    view.contentFilters = @[ blur ];
}

void sp_document_appearance(void *handle, bool dark) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    SPDocumentView *view = (SPDocumentView *)handle;
    if (!view || view.closed) return;
    view.appearance = [NSAppearance appearanceNamed:(dark ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua)];
}

void sp_document_close(void *handle) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    SPDocumentView *view = (SPDocumentView *)handle;
    view.closed = YES;
    [openDocuments() removeObject:view];
    [view stopHiddenTimer];
    if (view.eventMonitor) {
        [NSEvent removeMonitor:view.eventMonitor];
        view.eventMonitor = nil;
    }
    [view.webSurface removeObserver:view forKeyPath:@"effectiveAppearance" context:&kAppearanceContext];
    view.event = NULL;
    view.eventContext = NULL;
    for (NSString *key in observedKeys()) [view removeObserver:view forKeyPath:key context:&kStateContext];
    view.scroll.view = nil;
    [view.configuration.userContentController removeAllScriptMessageHandlers];
    view.navigationDelegate = nil;
    view.UIDelegate = nil;
    webviewInputUnregister(view);
    [view stopLoading];
    [view removeFromSuperview];
    [view release];
}

bool sp_document_set_hidden_clear_delay(double seconds) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    if (!isfinite(seconds) || seconds <= 0) return false;
    hiddenClearDelay = seconds;
    return true;
}

void sp_document_memory_pressure(void) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    for (SPDocumentView *view in openDocuments().allObjects) [view clearBackForwardCache:@"pressure"];
}
