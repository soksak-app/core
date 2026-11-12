// An external document webview inside a surface document.
//
// The state is read from the KVO properties of WKWebView and from WKNavigationDelegate. The scroll position is sent
// on
// every scroll event by a script in a content world (WKContentWorld) dedicated to the document. That world and its
// message
// handler are not visible to the scripts of the document page.
#import <Cocoa/Cocoa.h>
#import <CommonCrypto/CommonDigest.h>
#import <CoreImage/CoreImage.h>
#import <QuartzCore/QuartzCore.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#import "application_log.h"
#import "document_upload_body.h"
#import "document_view.h"
#import "document_message.h"
#import "event_ring.h"
#import "observe.h"
#import "private/webkit.h"
#import "surface_layout.h"
#import "webview_geometry.h"
#import "webview_input.h"

static NSString *const kScrollMessage = @"soksakDocumentScroll";

// The callback borrows the encoded message until delivery returns.
NSString *sp_document_view_message_json(id body) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:@{ @"message": body } options:0 error:nil];
    NSString *json = data ? [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease] : nil;
    return json ?: @"{\"error\":\"the view channel message is not JSON\"}";
}

// The script message handler of the view channel of a view configuration (docs/spec/native-surfaces.md#view-surfaces). The
// handler belongs to the page world, where the channel script runs, so the page can post to it.
static NSString *const kViewMessage = @"sok-view";

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
// The reason that a value is not plain JSON, or an empty string when it is. Plain JSON is null, a boolean, a finite number,
// a string, an array or a plain object of such values, without a cycle or a property that JSON would drop, so the text
// that JSON.stringify makes from a forwarded value holds the value that the page posted. The article of a type name is
// "an" when the name starts with A, E, I or O, which covers the type names that JSON refuses (Uint8Array takes "a").
static NSString *const kMessageScript = @"(() => {"
    "if (location.protocol !== 'soksak:') return;"
    "const refusal = (value, ancestors) => {"
    "if (value === null || typeof value === 'string' || typeof value === 'boolean') return '';"
    "if (typeof value === 'number') return Number.isFinite(value) ? '' : 'the message holds a number that is not finite, which is not JSON';"
    "if (typeof value !== 'object') return 'the message holds ' + (value === undefined ? 'undefined' : 'a ' + typeof value) + ', which is not JSON';"
    "const array = Array.isArray(value);"
    "const proto = Object.getPrototypeOf(value);"
    "if (proto !== null && proto !== (array ? Array.prototype : Object.prototype)) {"
    "const type = proto.constructor?.name || 'object';"
    "return 'the message holds ' + (/^[AEIO]/.test(type) ? 'an ' : 'a ') + type + ', which is not JSON';"
    "}"
    "if (ancestors.includes(value)) return 'the message holds a cycle, which is not JSON';"
    "const keys = Reflect.ownKeys(value).filter((key) => !(array && key === 'length'));"
    "if (keys.length !== Object.keys(value).length) return 'the message holds a property that JSON does not keep, which is not JSON';"
    "for (const item of array ? value : Object.values(value)) {"
    "const reason = refusal(item, [...ancestors, value]);"
    "if (reason) return reason;"
    "}"
    "return '';"
    "};"
    "addEventListener('message', (event) => {"
    "if (event.source !== window) return;"
    "let reason = '';"
    "try { reason = refusal(event.data, []); } catch (error) { reason = 'the message could not be read: ' + String(error); }"
    "window.webkit.messageHandlers.soksakDocumentMessage.postMessage("
    "reason ? { error: reason } : { message: JSON.stringify(event.data) });"
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
    // The identity of an element is a number that the script gives it at its first snapshot and that stays while it exists.
    "const identities = new WeakMap(); let identity = 0;"
    "const identityOf = (element) => { let value = identities.get(element); if (value === undefined) { value = ++identity; identities.set(element, value); } return value; };"
    "const tree = new MutationObserver(() => { if (marked) return; marked = true; post({ changed: true }); });"
    "globalThis.soksakSnapshot = () => {"
    "  marked = false; const nodes = []; let total = 0;"
    "  const walk = (element, depth) => {"
    "    total++;"
    "    if (nodes.length < 500) nodes.push({ node: identityOf(element), depth, tag: element.localName, id: element.getAttribute('id') ?? '',"
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
    // A document restored from the page cache does not run this script again, and native sent reset at the commit of its
    // restore. The script turns its streams off and asks for them again, so each stream that is on sends the data of the
    // restored document: a snapshot, and the navigation entry with every buffered resource entry.
    "addEventListener('pageshow', (event) => {"
    "  if (!event.persisted) return;"
    "  if (elements) { tree.disconnect(); elements = false; marked = false; }"
    "  if (resources !== null) { resources.disconnect(); resources = null; }"
    "  post({ ready: true });"
    "});"
    "post({ ready: true });"
    "})();";

// The script of the form flags (docs/spec/plugins.md#memory-saver). It runs in every frame in the content world of the host
// and reports a trusted input event on an editable element (a form field or a contenteditable element) once per document,
// with an identifier of the frame document that it generates; pagehide and a form submit clear the flag of that frame.
static NSString *const kFormMessage = @"soksakDocumentForm";
static NSString *const kFormScript = @"(() => {"
    "const frame = crypto.randomUUID();"
    "const post = (edited) => window.webkit.messageHandlers.soksakDocumentForm.postMessage({ frame, edited });"
    "let edited = false;"
    "addEventListener('input', (event) => {"
    "  if (edited || !event.isTrusted) return;"
    "  const target = event.composedPath()[0];"
    "  if (!(target instanceof Element) || !(target.matches('input, textarea, select') || target.isContentEditable)) return;"
    "  edited = true; post(true);"
    "}, true);"
    "const clear = () => { if (!edited) return; edited = false; post(false); };"
    "addEventListener('submit', clear, true);"
    "addEventListener('pagehide', clear);"
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

extern double sp_surface_scale(void *surface);

static CGFloat documentSurfaceScale(NSView *surface) {
    return sp_surface_scale(surface);
}

// The message handler for scroll and document content. The user content controller retains the handler, so it points
// to the view weakly.
// The token of a hidden delay of a region. The region clears region when the delay stops, so the delay that ends after it
// clears nothing.
@interface SPHiddenDelay : NSObject
@property(assign) SPDocumentView *region;
@end

@implementation SPHiddenDelay
@end

// The binary store of a document region (docs/spec/native-surfaces.md#document-regions): the bytes of each upload of the
// region's plugin, under the id that the host mints. The store belongs to the main thread.
@interface SPBinaryStore : NSObject
@property(readonly) NSUInteger count;
@property(readonly) NSUInteger total;
// Stores data with its content type and returns its new id.
- (NSString *)addData:(NSData *)data type:(NSString *)type;
// Returns {data, type} of the id, or nil when the id is not stored.
- (NSDictionary *)entryForId:(NSString *)identifier;
- (void)removeId:(NSString *)identifier;
- (void)releaseAll;
@end

@implementation SPBinaryStore {
    NSMutableDictionary<NSString *, NSDictionary *> *_entries;
    NSUInteger _total;
}

- (instancetype)init {
    self = [super init];
    if (self) _entries = [NSMutableDictionary new];
    return self;
}

- (void)dealloc {
    [_entries release];
    [super dealloc];
}

- (NSUInteger)count { return _entries.count; }

- (NSUInteger)total { return _total; }

- (NSString *)addData:(NSData *)data type:(NSString *)type {
    NSString *identifier = [[[NSUUID UUID].UUIDString stringByReplacingOccurrencesOfString:@"-" withString:@""] lowercaseString];
    _entries[identifier] = @{ @"data": data, @"type": type };
    _total += data.length;
    return identifier;
}

- (NSDictionary *)entryForId:(NSString *)identifier {
    return _entries[identifier];
}

- (void)removeId:(NSString *)identifier {
    NSDictionary *entry = _entries[identifier];
    if (!entry) return;
    _total -= [entry[@"data"] length];
    [_entries removeObjectForKey:identifier];
}

- (void)releaseAll {
    [_entries removeAllObjects];
    _total = 0;
}
@end

// The upload and download paths of the binary store. The document region answers them before it looks up a file, so a
// plugin release refuses a .binary path segment (plugin-api validateReleaseFiles).
static NSString *const kBinaryUploadPath = @"/.binary";
static NSString *const kBinaryDownloadPrefix = @"/.binary/";
// The bytes of one upload: the clipboard bound of both hosts. A page holds four uploads of that size.
static const NSUInteger kBinaryUploadLimit = 16 * 1024 * 1024;
static const NSUInteger kBinaryPageLimit = 64 * 1024 * 1024;

// Whether text is a binary id: 32 lowercase hexadecimal characters.
static BOOL isBinaryIdentifier(NSString *text) {
    if (text.length != 32) return NO; // silent: the predicate answers NO for a text of another length, and the caller refuses the id
    for (NSUInteger index = 0; index < text.length; index++) {
        unichar character = [text characterAtIndex:index];
        if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) return NO; // silent: a character outside lowercase hexadecimal makes the text no id, and the caller refuses it
    }
    return YES;
}

// The refusal of bytes that the binary store cannot take, named by the operation that brings them (an upload or a put), or nil
// when the store takes them. status is set to the HTTP status of the refusal of an upload.
static NSString *binaryRefusal(SPBinaryStore *store, NSUInteger length, NSString *operation, NSInteger *status) {
    if (!length) {
        *status = 400;
        return [NSString stringWithFormat:@"the %@ holds no bytes", operation];
    }
    if (length > kBinaryUploadLimit) {
        *status = 413;
        return [NSString stringWithFormat:@"the %@ is over the limit of 16777216 bytes", operation];
    }
    if (store.total + length > kBinaryPageLimit) {
        *status = 413;
        return [NSString stringWithFormat:@"the binary store of the page would hold %lu bytes, over the limit of 67108864 bytes",
            (unsigned long)(store.total + length)];
    }
    return nil;
}

@interface SPDocumentScroll : NSObject <WKScriptMessageHandler>
@property(assign) SPDocumentView *view;
@end

@interface SPDocumentView : WKWebView <WKNavigationDelegate, WKUIDelegate>
@property sp_document_changed changed;
@property sp_document_message message;
@property void *messageContext;
// The receiver of the sok-view handler of a view configuration (docs/spec/native-surfaces.md#view-surfaces).
@property sp_view_message viewMessage;
@property void *viewMessageContext;
// The receiver of the end of the WebContent process of a view (docs/spec/plugin-processes.md, rule 5). A region has none.
@property sp_view_ended viewEnded;
@property void *viewEndedContext;
// The receiver of the responsiveness notices of a view (docs/spec/plugin-processes.md, rule 6). A region has none.
@property sp_view_responsiveness viewResponsiveness;
@property void *viewResponsivenessContext;
// The id of the plugin whose surface owns the region; its plugin documents have the origin soksak://<plugin>.
@property(copy) NSString *plugin;
// The bytes that the plugin documents of the region store under binary ids (docs/spec/native-surfaces.md#document-regions).
@property(retain) SPBinaryStore *binaries;
// Whether the view takes the first mouse down of an inactive window. WKWebView refuses it, so AppKit consumes that press for
// the activation of the window and it reaches neither the page nor the first responder. A view takes it, so the press reaches the page and
// the view takes the keyboard focus (docs/spec/native-surfaces.md#view-surfaces). A document region keeps the refusal.
@property BOOL acceptsFirstMouseClick;
- (void)reportMessage:(NSDictionary *)value;
- (void)reportViewMessage:(WKScriptMessage *)message;
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
// The address of the current document: the address of the last committed main frame navigation, or nil while no document has
// committed or after the WebContent process ended. WKWebView.URL reports the address of a navigation that has not committed yet,
// whose document is not the current one.
@property(copy) NSURL *committedURL;
// The navigation that was last counted in navigations, so a navigation is counted once, when it starts.
@property(retain) WKNavigation *countedNavigation;
// The navigations that a requested navigation replaced before they ended. WebKit can deliver the start of such a navigation
// after the request that replaced it, and then its cancellation; neither changes the navigation in progress, so the end of a
// replaced load is not reported. A navigation leaves the set when it ends or fails.
@property(retain) NSMutableSet<WKNavigation *> *replacedNavigations;
// The number of navigations that the document has started. A progress change of a navigation does not change it, so the host
// clears the ready document of a view only when a new navigation starts (docs/spec/native-surfaces.md, document-state).
@property unsigned long long navigations;
// The surface that the document is placed on. The document observes its appearance until it closes, so it keeps the surface
// until then, also when the host closes the surface first.
@property(retain) NSView *webSurface;
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
// The running hidden delay, which clears the back-forward cache when the hidden clear delay passes, or nil. The delay
// holds the token and not the region, so a closed region is released before its delay ends.
@property(retain) SPHiddenDelay *hiddenDelay;
// The frame documents with a form flag, by the identifier that the form script of each frame document generates.
@property(retain) NSMutableSet<NSString *> *formFrames;
@property BOOL viewportMarkerEnabled;
@property BOOL viewportMarkerOriginalWantsLayer;
@property CGFloat viewportMarkerOriginalBorderWidth;
@property CGColorRef viewportMarkerOriginalBorderColor;
- (void)restoreViewportMarker;
@property BOOL pluginRootView;
// Whether the view of a plugin has committed its first document. A view keeps that document for its source generation.
@property BOOL viewDocumentCommitted;
- (void)clearBackForwardCache:(NSString *)reason;
- (void)stopHiddenTimer;
- (void)report;
- (void)request:(WKNavigation *)navigation;
- (void)countNavigation:(WKNavigation *)navigation;
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
static NSString *const kApplicationScheme = @"soksak";

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

// The core root resolver of the application (sp_core_root_set_resolver) and its context. The main thread reads and writes them.
static sp_core_root_resolver coreRootResolver;
static void *coreRootContext;

// The host of the core root in a soksak address of a view (docs/spec/native-surfaces.md#document-regions).
static NSString *const kCoreHost = @"core";

// The view import map of the application: the JSON text that sp_view_import_map_set sets. The main thread reads and writes it.
static NSString *viewImportMap;

// Inserts the import map text map directly after the doctype of the view page html, with the rule of the plugin-api function
// insertViewImportMap (docs/spec/plugin-processes.md, rule 4). The checks run in the order of that function, and a refused page
// returns nil with the reason in reason. The reasons are the texts of the shared cases of contract/view-page.json.
static NSString *insertViewPage(NSString *html, NSString *map, NSString **reason) {
    static NSRegularExpression *doctype;
    static NSRegularExpression *importMap;
    static NSRegularExpression *scriptEnd;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        doctype = [[NSRegularExpression alloc] initWithPattern:@"^<!doctype[^>]*>" options:NSRegularExpressionCaseInsensitive error:nil];
        importMap = [[NSRegularExpression alloc] initWithPattern:@"<script\\b[^>]*\\btype\\s*=\\s*[\"']?importmap\\b"
            options:NSRegularExpressionCaseInsensitive error:nil];
        scriptEnd = [[NSRegularExpression alloc] initWithPattern:@"</script" options:NSRegularExpressionCaseInsensitive error:nil];
    });
    NSTextCheckingResult *token = [doctype firstMatchInString:html options:NSMatchingAnchored range:NSMakeRange(0, html.length)];
    if (!token) {
        *reason = @"view page has no doctype at its start";
        return nil;
    }
    if ([importMap firstMatchInString:html options:0 range:NSMakeRange(0, html.length)]) {
        *reason = @"view page has an import map";
        return nil;
    }
    if (map.length == 0) {
        *reason = @"the view import map is empty";
        return nil;
    }
    if ([scriptEnd firstMatchInString:map options:0 range:NSMakeRange(0, map.length)]) {
        *reason = @"import map text ends a script element";
        return nil;
    }
    NSString *declaration = [html substringWithRange:token.range];
    NSString *rest = [html substringFromIndex:NSMaxRange(token.range)];
    return [NSString stringWithFormat:@"%@<script type=\"importmap\">%@</script>%@", declaration, map, rest];
}

// Serves soksak://<plugin>/<path> from the folder of the region's plugin.
@interface SPPluginScheme : NSObject <WKURLSchemeHandler>
@property(copy) NSString *root;
@property(copy) NSString *plugin;
// The binary store of the region that owns the scheme.
@property(retain) SPBinaryStore *binaries;
// Whether the region is a view, which may request the core root at soksak://core/<path>.
@property BOOL allowsCoreRoot;
// The path of the page that the view loaded last. The served page at this path receives the view import map.
@property(copy) NSString *viewPage;
@end

// The bytes of one didReceiveData of a document response. One message that carries a whole file raises the peak footprint of the
// host by the size of the file, even when the file is mapped.
static const size_t kResponseChunkBytes = 256 * 1024;

// Sends data as the body of the task in chunks and finishes the task. WebKit keeps a chunk of a synchronous load, so each chunk
// owns its bytes. The whole body is sent within the start of the task, so no stop of the task arrives between two chunks.
static void sendBody(id<WKURLSchemeTask> task, NSData *data) {
    for (NSUInteger offset = 0; offset < data.length; offset += kResponseChunkBytes) @autoreleasepool {
        NSUInteger length = MIN(data.length - offset, kResponseChunkBytes);
        [task didReceiveData:[data subdataWithRange:NSMakeRange(offset, length)]];
    }
    [task didFinish];
}

@implementation SPPluginScheme
- (void)webView:(WKWebView *)view startURLSchemeTask:(id<WKURLSchemeTask>)task {
    (void)view;
    NSURL *url = task.request.URL;
    if (self.allowsCoreRoot && [url.host isEqualToString:kCoreHost]) {
        [self answerCore:task];
        return;
    }
    if ([url.path isEqualToString:kBinaryUploadPath] || [url.path hasPrefix:kBinaryDownloadPrefix]) {
        [self answerBinary:task];
        return;
    }
    NSArray<NSString *> *parts = [url.path componentsSeparatedByString:@"/"];
    BOOL inside = self.root != nil && [url.host isEqualToString:self.plugin] && parts.count > 1 && parts[0].length == 0;
    for (NSUInteger index = 1; inside && index < parts.count; index++) {
        NSString *part = parts[index];
        if (part.length == 0 || [part isEqualToString:@"."] || [part isEqualToString:@".."]) inside = NO;
    }
    NSString *file = inside ? [self.root stringByAppendingPathComponent:[url.path substringFromIndex:1]] : nil;
    int descriptor = file ? open(file.fileSystemRepresentation, O_RDONLY | O_CLOEXEC | O_NONBLOCK) : -1;
    struct stat facts;
    if (descriptor < 0 || fstat(descriptor, &facts) != 0 || !S_ISREG(facts.st_mode)) {
        if (descriptor >= 0) close(descriptor);
        sp_log_error("document view", [NSString stringWithFormat:@"plugin file not found: %@", url.absoluteString].UTF8String);
        [task didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorFileDoesNotExist
            userInfo:@{ NSLocalizedDescriptionKey: [NSString stringWithFormat:@"%@ is not found", url.absoluteString] }]];
        return;
    }
    if (self.allowsCoreRoot && [url.path isEqualToString:self.viewPage]) {
        close(descriptor);
        // The length of the response is taken after the insertion, so the page is sent with the length of the page that runs.
        NSData *source = [NSData dataWithContentsOfFile:file];
        NSData *page = source ? [self viewPageData:source url:url] : nil;
        if (!page) {
            [task didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorCannotDecodeContentData
                userInfo:@{ NSLocalizedDescriptionKey: [NSString stringWithFormat:@"%@ is refused", url.absoluteString] }]];
            return;
        }
        [self respond:task status:200 type:pluginContentType(file) data:page];
        return;
    }
    NSHTTPURLResponse *response = [[[NSHTTPURLResponse alloc] initWithURL:url statusCode:200 HTTPVersion:@"HTTP/1.1"
        headerFields:@{ @"Content-Type": pluginContentType(file), @"Content-Length": @((unsigned long long)facts.st_size).stringValue }] autorelease];
    [task didReceiveResponse:response];
    [self sendFile:descriptor length:(size_t)facts.st_size url:url task:task];
    close(descriptor);
}

// Sends the open file as the body of the task, one chunk in memory at a time, and finishes the task. A file that ends before the
// length that the response declares fails the task, so the page does not take a shorter file as complete.
- (void)sendFile:(int)descriptor length:(size_t)length url:(NSURL *)url task:(id<WKURLSchemeTask>)task {
    for (size_t remaining = length; remaining > 0;) @autoreleasepool {
        size_t wanted = MIN(remaining, kResponseChunkBytes);
        void *bytes = malloc(wanted);
        ssize_t count;
        do { count = read(descriptor, bytes, wanted); } while (count < 0 && errno == EINTR);
        if (count <= 0) {
            free(bytes);
            sp_log_error("document view", [NSString stringWithFormat:@"plugin file ended before its length: %@", url.absoluteString].UTF8String);
            [task didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorCannotDecodeContentData
                userInfo:@{ NSLocalizedDescriptionKey: [NSString stringWithFormat:@"%@ ended before its length", url.absoluteString] }]];
            return;
        }
        [task didReceiveData:[NSData dataWithBytesNoCopy:bytes length:(NSUInteger)count freeWhenDone:YES]];
        remaining -= (size_t)count;
    }
    [task didFinish];
}

// Returns the view page data with the view import map inserted (docs/spec/plugin-processes.md, rule 4). A refused page is logged
// with its address and the reason, and it returns nil.
- (NSData *)viewPageData:(NSData *)data url:(NSURL *)url {
    NSString *reason = nil;
    NSString *page = nil;
    NSString *html = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (!html) {
        reason = @"view page is not UTF-8";
    } else if (!viewImportMap) {
        reason = @"the view import map is not set";
    } else {
        page = insertViewPage(html, viewImportMap, &reason);
    }
    [html release];
    if (!page) {
        sp_log_error("document view", [NSString stringWithFormat:@"view page %@: %@", url.absoluteString, reason].UTF8String);
        return nil;
    }
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    NSData *mapBytes = [viewImportMap dataUsingEncoding:NSUTF8StringEncoding];
    CC_SHA256(mapBytes.bytes, (CC_LONG)mapBytes.length, digest);
    NSMutableString *hex = [NSMutableString string];
    for (int index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) [hex appendFormat:@"%02x", digest[index]];
    sp_log_info("document view", [NSString stringWithFormat:@"view page %@ holds the import map sha256 %@", url.absoluteString, hex].UTF8String);
    return [page dataUsingEncoding:NSUTF8StringEncoding];
}

- (void)webView:(WKWebView *)view stopURLSchemeTask:(id<WKURLSchemeTask>)task {
    (void)view; (void)task;
}

// Answers a request of the core root of a view with the resolver of the application. A served file carries the header
// Access-Control-Allow-Origin of the view's plugin, so the page's module import or fetch succeeds. A refused path answers not
// found with no such header, so the page's request fails. The resolver writes the refusal to the application log.
- (void)answerCore:(id<WKURLSchemeTask>)task {
    NSURL *url = task.request.URL;
    void *bytes = NULL;
    size_t length = 0;
    char *type = NULL;
    if (!coreRootResolver || !coreRootResolver(coreRootContext, self.plugin.UTF8String, url.path.UTF8String, &bytes, &length, &type)) {
        [task didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorFileDoesNotExist
            userInfo:@{ NSLocalizedDescriptionKey: [NSString stringWithFormat:@"%@ is not found", url.absoluteString] }]];
        return;
    }
    // The data takes the buffer of the resolver, so the file has no second whole copy here.
    NSData *data = [NSData dataWithBytesNoCopy:bytes length:length freeWhenDone:YES];
    NSString *contentType = [NSString stringWithUTF8String:type];
    free(type);
    NSHTTPURLResponse *response = [[[NSHTTPURLResponse alloc] initWithURL:url statusCode:200 HTTPVersion:@"HTTP/1.1" headerFields:@{
        @"Content-Type": contentType,
        @"Content-Length": @(data.length).stringValue,
        @"Access-Control-Allow-Origin": [NSString stringWithFormat:@"soksak://%@", self.plugin],
    }] autorelease];
    [task didReceiveResponse:response];
    sendBody(task, data);
}

// Answers a request of the binary store. An upload answers {id, length}; a download answers the stored bytes and releases
// the id when the response finishes. Each refusal answers its status with {error} and writes the reason to the log.
- (void)answerBinary:(id<WKURLSchemeTask>)task {
    NSURL *url = task.request.URL;
    NSString *method = task.request.HTTPMethod;
    BOOL upload = [url.path isEqualToString:kBinaryUploadPath];
    if (!self.plugin || ![url.host isEqualToString:self.plugin]) {
        [self refuseBinary:task status:403 reason:[NSString stringWithFormat:@"%@ is not a binary path of plugin %@",
            url.absoluteString, self.plugin ?: @"none"]];
        return;
    }
    if (![method isEqualToString:upload ? @"POST" : @"GET"]) {
        [self refuseBinary:task status:405 reason:[NSString stringWithFormat:@"%@ does not take %@", url.absoluteString, method]];
        return;
    }
    if (upload) {
        NSError *error = nil;
        NSData *body = sp_document_upload_body(task.request, kBinaryUploadLimit, &error);
        if (!body) {
            [self refuseBinary:task status:400 reason:error.localizedDescription];
            return;
        }
        NSInteger status = 0;
        NSString *refusal = binaryRefusal(self.binaries, body.length, @"upload", &status);
        if (refusal) {
            [self refuseBinary:task status:status reason:refusal];
            return;
        }
        NSString *type = [task.request valueForHTTPHeaderField:@"Content-Type"] ?: @"application/octet-stream";
        NSString *identifier = [self.binaries addData:body type:type];
        NSData *answer = [NSJSONSerialization dataWithJSONObject:@{ @"id": identifier, @"length": @(body.length) } options:0 error:nil];
        [self respond:task status:200 type:@"application/json" data:answer];
        return;
    }
    NSString *identifier = [url.path substringFromIndex:kBinaryDownloadPrefix.length];
    NSDictionary *entry = isBinaryIdentifier(identifier) ? [self.binaries entryForId:identifier] : nil;
    if (!entry) {
        [self refuseBinary:task status:404 reason:[NSString stringWithFormat:@"binary id %@ is not stored", identifier]];
        return;
    }
    [self respond:task status:200 type:entry[@"type"] data:entry[@"data"]];
    [self.binaries removeId:identifier];
}

- (void)refuseBinary:(id<WKURLSchemeTask>)task status:(NSInteger)status reason:(NSString *)reason {
    sp_log_error("document view", reason.UTF8String);
    NSData *answer = [NSJSONSerialization dataWithJSONObject:@{ @"error": reason } options:0 error:nil];
    [self respond:task status:status type:@"application/json" data:answer];
}

- (void)respond:(id<WKURLSchemeTask>)task status:(NSInteger)status type:(NSString *)type data:(NSData *)data {
    NSHTTPURLResponse *response = [[[NSHTTPURLResponse alloc] initWithURL:task.request.URL statusCode:status
        HTTPVersion:@"HTTP/1.1" headerFields:@{ @"Content-Type": type, @"Content-Length": @(data.length).stringValue }] autorelease];
    [task didReceiveResponse:response];
    sendBody(task, data);
}

- (void)dealloc { [_root release]; [_plugin release]; [_binaries release]; [super dealloc]; }
@end

@implementation SPDocumentScroll
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    SPDocumentView *view = self.view;
    if ([message.name isEqualToString:kViewMessage]) {
        [view reportViewMessage:message];
        return;
    }
    if (!view || ![message.body isKindOfClass:NSDictionary.class]) return;
    NSDictionary *body = message.body;
    // The form flags come from every frame; the other messages come only from the main frame.
    if ([message.name isEqualToString:kFormMessage]) {
        if (![body[@"frame"] isKindOfClass:NSString.class] || ![body[@"edited"] isKindOfClass:NSNumber.class]) {
            sp_log_error("document view", [NSString stringWithFormat:@"form message without frame or flag: %@", body].UTF8String);
            return;
        }
        if ([body[@"edited"] boolValue]) [view.formFrames addObject:body[@"frame"]];
        else [view.formFrames removeObject:body[@"frame"]];
        return;
    }
    if (!message.frameInfo.isMainFrame) return;
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

- (BOOL)performKeyEquivalent:(NSEvent *)event {
    NSMenu *mainMenu = NSApp.mainMenu;
    if (mainMenu && [mainMenu performKeyEquivalent:event]) return YES;
    return [super performKeyEquivalent:event];
}

- (void)restoreViewportMarker {
    if (!self.viewportMarkerEnabled) return;
    CALayer *layer = self.layer;
    if (layer) {
        surfaceTransactionBegin();
        [CATransaction setDisableActions:YES];
        layer.borderColor = self.viewportMarkerOriginalBorderColor;
        layer.borderWidth = self.viewportMarkerOriginalBorderWidth;
        surfaceTransactionCommit();
    }
    if (!self.viewportMarkerOriginalWantsLayer) self.wantsLayer = NO;
    if (self.viewportMarkerOriginalBorderColor) {
        CGColorRelease(self.viewportMarkerOriginalBorderColor);
        self.viewportMarkerOriginalBorderColor = NULL;
    }
    self.viewportMarkerEnabled = NO;
}

- (void)dealloc {
    [self restoreViewportMarker];
    [_formFrames release];
    [_scroll release];
    [_failure release];
    [_link release];
    [_plugin release];
    [_binaries release];
    [_navigation release];
    [_committedURL release];
    [_countedNavigation release];
    [_replacedNavigations release];
    [_eventMonitor release];
    [_webSurface release];
    [self stopHiddenTimer];
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

- (void)stopHiddenTimer {
    self.hiddenDelay.region = nil;
    self.hiddenDelay = nil;
}

// AppKit calls viewDidHide and viewDidUnhide when the region or one of its ancestors is hidden or shown.
- (void)viewDidHide {
    [super viewDidHide];
    if (self.closed || self.hiddenDelay) return;
    SPHiddenDelay *delay = [[SPHiddenDelay new] autorelease];
    delay.region = self;
    self.hiddenDelay = delay;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(hiddenClearDelay * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        SPDocumentView *region = delay.region;
        if (!region) return;
        region.hiddenDelay = nil;
        delay.region = nil;
        [region clearBackForwardCache:@"hidden"];
    });
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

- (BOOL)acceptsFirstMouse:(NSEvent *)event {
    return self.acceptsFirstMouseClick;
}

- (void)reportViewMessage:(WKScriptMessage *)message {
    NSString *json = nil;
    if (!message.frameInfo.isMainFrame) {
        json = @"{\"error\":\"the view channel message comes from a frame that is not the main frame\"}";
    } else {
        json = sp_document_view_message_json(message.body);
    }
    if (!self.viewMessage) {
        sp_log_error("document view", "view channel message without a receiver");
        return;
    }
    self.viewMessage(self.viewMessageContext, json.UTF8String);
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
        // A C logical operator yields an int, which boxes as a JSON number; the state needs a JSON boolean.
        @"loading": (self.loading || self.navigation != nil) ? @YES : @NO,
        @"progress": @(self.estimatedProgress),
        @"canGoBack": @(self.canGoBack),
        @"canGoForward": @(self.canGoForward),
        @"error": self.failure ?: (id)NSNull.null,
        @"scroll": @{ @"x": @(self.offset.x), @"y": @(self.offset.y) },
        @"history": [self history],
        @"link": self.link ?: @"",
        @"navigations": @(self.navigations),
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
    if (self.navigation && navigation != self.navigation) {
        if (!self.replacedNavigations) self.replacedNavigations = [NSMutableSet set];
        [self.replacedNavigations addObject:self.navigation];
    }
    [self countNavigation:navigation];
    self.navigation = navigation;
    [self report];
}

// Counts a navigation once, when it starts. A nil navigation starts none.
- (void)countNavigation:(WKNavigation *)navigation {
    if (!navigation || navigation == self.countedNavigation) return;
    self.countedNavigation = navigation;
    self.navigations += 1;
}

- (BOOL)requestIfStarted:(WKNavigation *)navigation {
    if (!navigation) return NO; // silent: a nil navigation is the answer that WebKit started no load, and the caller returns it to the host
    [self request:navigation];
    return YES;
}

// The navigation finished. If it is not the navigation in progress, it is a replaced navigation and is ignored.
- (void)settle:(WKNavigation *)navigation {
    if (navigation) [self.replacedNavigations removeObject:navigation];
    if (navigation == self.navigation) self.navigation = nil;
}

// A navigation that the page or the document starts replaces the one in progress. The start of a navigation that a request
// replaced before it started is not a new navigation: it is not counted and does not take the place of the request.
- (void)webView:(WKWebView *)view didStartProvisionalNavigation:(WKNavigation *)navigation {
    if (navigation && [self.replacedNavigations containsObject:navigation]) return;
    [self countNavigation:navigation];
    self.navigation = navigation;
    self.failure = nil;
    [self report];
}

// A new document replaces the earlier one: each stream that is on sends reset, an unacknowledged snapshot is dropped, and
// the script of the new document asks for its streams again when it is installed.
// A main frame commit, a reload included, replaces every frame document, so every form flag is cleared.
- (void)webView:(WKWebView *)view didCommitNavigation:(WKNavigation *)navigation {
    if (self.pluginRootView) self.viewDocumentCommitted = YES;
    self.committedURL = view.URL;
    [self.formFrames removeAllObjects];
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
    [self.replacedNavigations removeAllObjects];
    self.committedURL = nil;
    self.failure = @"the web content process ended";
    [self report];
    if (self.viewEnded && !self.closed) self.viewEnded(self.viewEndedContext);
}

// WebKit reports that the WebContent process of this view stopped answering its responsiveness check. The notice ends neither the
// view nor its calls; the host records it (docs/spec/plugin-processes.md, rule 6). WebKit calls it through the navigation forwarder.
- (void)_webViewWebProcessDidBecomeUnresponsive:(WKWebView *)view {
    if (self.viewResponsiveness && !self.closed) self.viewResponsiveness(self.viewResponsivenessContext, false);
}

// WebKit reports that the WebContent process of this view resumed answering its responsiveness check.
- (void)_webViewWebProcessDidBecomeResponsive:(WKWebView *)view {
    if (self.viewResponsiveness && !self.closed) self.viewResponsiveness(self.viewResponsivenessContext, true);
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


// Whether a navigation action moves to a fragment of the current document: not a reload, and the same address without fragment.
static BOOL sameDocument(WKNavigationAction *action, NSURL *current) {
    NSURL *target = action.request.URL;
    if (action.navigationType == WKNavigationTypeReload || !current || target.fragment == nil) return NO; // silent: a reload, a first document or an address without a fragment is not a move within the document, and the caller refuses it
    NSURLComponents *from = [NSURLComponents componentsWithURL:current resolvingAgainstBaseURL:NO];
    NSURLComponents *to = [NSURLComponents componentsWithURL:target resolvingAgainstBaseURL:NO];
    from.fragment = nil;
    to.fragment = nil;
    return [from.URL isEqual:to.URL];
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
    // A view of a plugin keeps its first document: the main page holds the registrations of that document under the source
    // generation of the view, and a replacement document would register them again under the same generation
    // (docs/spec/native-surfaces.md#view-surfaces). A navigation within the document, to a fragment, keeps the document.
    if (self.pluginRootView && self.viewDocumentCommitted && action.targetFrame.isMainFrame && !sameDocument(action, view.URL)) {
        self.failure = [NSString stringWithFormat:@"a view keeps its first document: navigation to %@ refused",
            action.request.URL.absoluteString];
        sp_log_error("document view", self.failure.UTF8String);
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
// (page zoom), and the backing scale applies only to the WebKit raster. WebKit lays out and paints the whole points of
// the frame of a web view (it truncates the bounds to an integer size), so a document region takes the whole points inside
// its insets: the right and bottom edges move inward to the edge of its page, and no row of the region shows the backing of
// the web view. A view web view is the root of its surface and keeps the native frame of the surface, so the last device
// pixel row of the surface takes its input (docs/spec/surface-composition.md).
- (void)applyInsets {
    NSView *surface = self.webSurface;
    if (!surface) return;
    NSRect bounds = self.superview.bounds;
    NSEdgeInsets insets = self.insets;
    CGFloat width = NSWidth(bounds) - (insets.left + insets.right);
    CGFloat height = NSHeight(bounds) - (insets.top + insets.bottom);
    if (!self.pluginRootView) {
        width = floor(width);
        height = floor(height);
    }
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
// separately, so all documents of one directory use the same store. The store is kept until sp_document_store_close
// ends it; a directory whose store is ending gets no new store until the network process has removed the session.
static NSMutableDictionary<NSString *, WKWebsiteDataStore *> *dataStores(void) {
    static NSMutableDictionary<NSString *, WKWebsiteDataStore *> *stores;
    if (!stores) stores = [NSMutableDictionary new];
    return stores;
}

static NSMutableSet<NSString *> *endingStores(void) {
    static NSMutableSet<NSString *> *ending;
    if (!ending) ending = [NSMutableSet new];
    return ending;
}

// The cause of the last failed creation of a web view on the main thread (sp_document_last_error).
static NSString *documentFailure;

// Keeps the cause until the next creation replaces it; a nil cause clears it.
static void setDocumentFailure(NSString *cause) {
    [documentFailure release];
    documentFailure = [cause copy];
}

// The cause that the next creation fails with, set by sp_document_fail_creation_for_test.
static NSString *injectedCreationFailure;

// Takes the injected failure of the next creation into documentFailure and reports that the creation fails. It runs before the
// main thread assertion of the creations, so the owning unit tests of the host can run it on a test thread; no production caller
// sets the failure.
static bool takeInjectedCreationFailure(void) {
    if (!injectedCreationFailure) return false;
    setDocumentFailure(injectedCreationFailure);
    [injectedCreationFailure release];
    injectedCreationFailure = nil;
    return true;
}

void sp_document_fail_creation_for_test(const char *cause) {
    [injectedCreationFailure release];
    injectedCreationFailure = [[NSString alloc] initWithUTF8String:cause];
}

// The getter reads the cause that the creation on the main thread stored; it asserts no thread, so a caller on another thread
// after a failed creation reads the same cause.
const char *sp_document_last_error(void) {
    return documentFailure ? documentFailure.UTF8String : "";
}

static NSString *storeDirectory(const char *path) {
    NSString *directory = [NSFileManager.defaultManager stringWithFileSystemRepresentation:path length:strlen(path)];
    return directory.absolutePath ? directory : nil;
}

static WKWebsiteDataStore *storeForDirectory(const char *path) {
    NSString *directory = storeDirectory(path);
    if (!directory) {
        setDocumentFailure([NSString stringWithFormat:@"the data store directory %s is not an absolute path", path]);
        return nil;
    }
    if ([endingStores() containsObject:directory]) {
        setDocumentFailure([NSString stringWithFormat:@"the data store %@ is ending", directory]);
        return nil;
    }
    WKWebsiteDataStore *store = dataStores()[directory];
    if (store) return store;
    NSError *error = nil;
    if (![NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:&error]) {
        setDocumentFailure([NSString stringWithFormat:@"cannot create the data store directory %@: %@", directory,
            error.localizedDescription ?: @"unknown error"]);
        return nil;
    }
    _WKWebsiteDataStoreConfiguration *configuration = [[[_WKWebsiteDataStoreConfiguration alloc]
        initWithDirectory:[NSURL fileURLWithPath:directory isDirectory:YES]] autorelease];
    store = [[[WKWebsiteDataStore alloc] _initWithConfiguration:configuration] autorelease];
    if (!store) {
        setDocumentFailure([NSString stringWithFormat:@"the data store %@ cannot be initialized", directory]);
        return nil;
    }
    dataStores()[directory] = store;
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

void sp_core_root_set_resolver(sp_core_root_resolver resolver, void *context) {
    NSCAssert(NSThread.isMainThread, @"the core root belongs to the main thread");
    coreRootResolver = resolver;
    coreRootContext = context;
}

void sp_view_import_map_set(const char *map) {
    NSCAssert(NSThread.isMainThread, @"the view import map belongs to the main thread");
    [viewImportMap release];
    viewImportMap = map ? [[NSString stringWithUTF8String:map] retain] : nil;
}

bool sp_view_page_insert(const char *html, const char *map, char **output, char **error) {
    NSCAssert(output && error, @"the insertion reports its result through output and error");
    *output = NULL;
    *error = NULL;
    if (!html || !map) {
        *error = strdup(!html ? "view page is missing" : "the view import map is not set");
        return false;
    }
    NSString *reason = nil;
    NSString *page = insertViewPage([NSString stringWithUTF8String:html], [NSString stringWithUTF8String:map], &reason);
    if (!page) {
        *error = strdup(reason.UTF8String);
        return false;
    }
    *output = strdup(page.UTF8String);
    return true;
}

// Builds the web view with the configuration of a document region, or with the view configuration (isView) that a view
// surface uses (docs/spec/native-surfaces.md#view-surfaces). The view is hidden with a zero frame and
// is attached to no parent; the caller places it and owns the reference until sp_document_close.
static SPDocumentView *pluginView(const char *directory, const char *folder, const char *plugin, NSString *label,
    NSString *channelSource, bool isView, sp_document_changed changed, void *context) {
    WKWebsiteDataStore *store = storeForDirectory(directory);
    if (!store) return nil;
    NSString *applicationName = safariApplicationName();
    if (!applicationName) {
        setDocumentFailure(@"the version of /Applications/Safari.app cannot be read");
        return nil;
    }
    WKWebViewConfiguration *configuration = [[[WKWebViewConfiguration alloc] init] autorelease];
    configuration.applicationNameForUserAgent = applicationName;
    configuration.websiteDataStore = store;
    SPBinaryStore *binaries = [[SPBinaryStore new] autorelease];
    SPPluginScheme *scheme = [[SPPluginScheme new] autorelease];
    scheme.binaries = binaries;
    scheme.allowsCoreRoot = isView;
    if (folder && plugin) {
        scheme.root = [NSString stringWithUTF8String:folder];
        scheme.plugin = [NSString stringWithUTF8String:plugin];
    }
    if (label) [configuration _setProcessDisplayName:label];
    [configuration setURLSchemeHandler:scheme forURLScheme:kApplicationScheme];
    WKContentWorld *world = [WKContentWorld worldWithName:kDocumentWorld];
    SPDocumentScroll *scroll = [[SPDocumentScroll new] autorelease];
    [configuration.userContentController addScriptMessageHandler:scroll contentWorld:world name:kScrollMessage];
    [configuration.userContentController addScriptMessageHandler:scroll contentWorld:world name:kPageMessage];
    [configuration.userContentController addScriptMessageHandler:scroll contentWorld:world name:kMessageMessage];
    [configuration.userContentController addScriptMessageHandler:scroll contentWorld:world name:kFormMessage];
    if (isView) {
        // The channel script and its handler run in the page world, so the page can read the host messages through
        // window.sokView (docs/spec/native-surfaces.md#view-surfaces).
        WKContentWorld *pageWorld = WKContentWorld.pageWorld;
        [configuration.userContentController addScriptMessageHandler:scroll contentWorld:pageWorld name:kViewMessage];
        [configuration.userContentController addUserScript:[[[WKUserScript alloc] initWithSource:channelSource
            injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES inContentWorld:pageWorld] autorelease]];
    }
    [configuration.userContentController addUserScript:[[[WKUserScript alloc] initWithSource:kFormScript
        injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:NO inContentWorld:world] autorelease]];
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
    view.formFrames = [NSMutableSet set];
    view.changed = changed;
    view.context = context;
    view.plugin = folder && plugin ? scheme.plugin : nil;
    view.binaries = binaries;
    view.navigationDelegate = view;
    view.UIDelegate = view;
    view.hidden = YES;
    for (NSString *key in observedKeys()) sp_observe_key_path("document_view.state", SP_OBSERVE_COUNT, view, view, key, 0, &kStateContext);
    return view;
}

// Stores the cause of a failed creation and returns the NULL of the failure.
static void *documentCreationFails(NSString *cause) {
    setDocumentFailure(cause);
    return NULL;
}

static char kDrawCoveredKey;

// The record that a window draws its document regions while covered (sp_document_draw_covered). The window holds it as an
// associated object; the close of the window removes it, so the state ends with the window.
@interface SPDocumentDrawCovered : NSObject
@property(assign) NSWindow *window;
@end

@implementation SPDocumentDrawCovered
- (void)windowWillClose:(NSNotification *)notification {
    sp_observe_delivered("document_view.draw_covered.close");
    [[self retain] autorelease];
    [NSNotificationCenter.defaultCenter removeObserver:self];
    objc_setAssociatedObject(self.window, &kDrawCoveredKey, nil, OBJC_ASSOCIATION_RETAIN);
}
- (void)dealloc {
    [NSNotificationCenter.defaultCenter removeObserver:self];
    [super dealloc];
}
@end

static BOOL windowDrawsCovered(NSWindow *window) {
    return window && objc_getAssociatedObject(window, &kDrawCoveredKey) != nil;
}

bool sp_document_draw_covered(void *handle, bool draw) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    NSWindow *window = (NSWindow *)handle;
    if (!window) return false;
    if (draw && !windowDrawsCovered(window)) {
        SPDocumentDrawCovered *record = [[SPDocumentDrawCovered new] autorelease];
        record.window = window;
        if (!sp_observe_notification_selector("document_view.draw_covered.close", SP_OBSERVE_COUNT, record, @selector(windowWillClose:),
                NSWindowWillCloseNotification, window)) return false;
        objc_setAssociatedObject(window, &kDrawCoveredKey, record, OBJC_ASSOCIATION_RETAIN);
    } else if (!draw && windowDrawsCovered(window)) {
        SPDocumentDrawCovered *record = objc_getAssociatedObject(window, &kDrawCoveredKey);
        [NSNotificationCenter.defaultCenter removeObserver:record];
        objc_setAssociatedObject(window, &kDrawCoveredKey, nil, OBJC_ASSOCIATION_RETAIN);
    }
    bool applied = true;
    // A view renders while occluded in every state (sp_surface_place_view), so only the document regions change.
    for (SPDocumentView *view in openDocuments().allObjects) {
        if (view.closed || view.pluginRootView || view.webSurface.window != window) continue;
        applied = sp_webview_render_occluded(view, draw) && applied;
    }
    return applied;
}

void *sp_document_create(void *surfaceHandle, const char *directory, const char *folder, const char *plugin, const char *label, const char *channel,
    sp_document_changed changed, void *context) {
    setDocumentFailure(nil);
    if (takeInjectedCreationFailure()) return NULL;
    bool isView = channel != NULL;
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    NSView *surface = (NSView *)surfaceHandle;
    // Every argument and the native plane of the surface are checked before a web view is made, and each failure states
    // its condition (sp_document_last_error).
    if (!surface) return documentCreationFails(@"the surface is missing");
    if (!surface.window) return documentCreationFails(@"the surface is not in a window");
    if (!directory) return documentCreationFails(@"the data store directory is missing");
    if (!changed) return documentCreationFails(@"the change callback is missing");
    if (isView && !folder) return documentCreationFails(@"the view has no folder");
    if (isView && !plugin) return documentCreationFails(@"the view has no plugin");
    NSString *channelSource = isView ? [NSString stringWithUTF8String:channel] : nil;
    if (isView && !channelSource) return documentCreationFails(@"the channel of the view is not UTF-8");
    NSString *labelText = label ? [NSString stringWithUTF8String:label] : nil;
    if (label && !labelText) return documentCreationFails(@"the process label is not UTF-8");
    NSView *nativePlane = (NSView *)sp_surface_native_plane(surface);
    if (!nativePlane) return documentCreationFails(@"the surface has no native plane");
    SPDocumentView *view = pluginView(directory, folder, plugin, labelText, channelSource, isView, changed, context);
    if (!view) return NULL;
    view.pluginRootView = isView;
    if (!surfaceLayoutRenderAtDisplayRate(view)) {
        setDocumentFailure(@"the document webview cannot render at the display rate");
        [view release];
        return NULL;
    }
    view.webSurface = surface;
    view.appearance = surface.effectiveAppearance;
    // The input functions log the WebKit method that is missing.
    if (!webviewInputRegister(view)) {
        [view release];
        return documentCreationFails(@"the document webview cannot be registered for input");
    }
    if (!webviewIgnorePageFocus(view)) {
        webviewInputUnregister(view);
        [view release];
        return documentCreationFails(@"the document webview cannot ignore the focus changes of its page");
    }
    if (isView) {
        // A view draws its declared overlays in its own DOM, so it is placed below the plane that the overlay mask cuts.
        view.acceptsFirstMouseClick = YES;
        if (!sp_surface_place_view(surface, view)) {
            setDocumentFailure(@"the view cannot be placed in its surface");
            webviewInputUnregister(view);
            [view release];
            return NULL;
        }
    } else {
        [nativePlane addSubview:view];
        // A region created in a window that draws covered draws covered too.
        if (windowDrawsCovered(surface.window) && !sp_webview_render_occluded(view, true)) {
            [view removeFromSuperview];
            webviewInputUnregister(view);
            [view release];
            return documentCreationFails(@"the document webview cannot render while its window is occluded");
        }
    }
    [view installEventMonitor];
    sp_observe_key_path("document_view.appearance", SP_OBSERVE_RECORD, surface, view, @"effectiveAppearance", 0, &kAppearanceContext);
    view.zoom = 1;
    view.pageZoom = view.zoom;
    [view _setOverrideDeviceScaleFactor:sp_surface_scale(surface)];
    [openDocuments() addObject:view];
    return view; // The caller owns this reference until sp_document_close.
}

void sp_document_query(void *handle, sp_document_query_reply reply, void *context) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    SPDocumentView *view = (SPDocumentView *)handle;
    if (!view || view.closed) {
        reply(context, "{\"error\":\"the document region is closed\"}");
        return;
    }
    // The public requestMediaPlaybackState answers playing for a page whose media element has never played, so the audible
    // state of the page is read instead (docs/spec/plugins.md#memory-saver).
    BOOL capture = view.cameraCaptureState == WKMediaCaptureStateActive
        || view.microphoneCaptureState == WKMediaCaptureStateActive;
    NSString *json = [NSString stringWithFormat:@"{\"media\":%@,\"capture\":%@,\"form\":%@}",
        view._isPlayingAudio ? @"true" : @"false", capture ? @"true" : @"false", view.formFrames.count ? @"true" : @"false"];
    reply(context, json.UTF8String);
}

char *sp_document_interaction_state(void *handle) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    SPDocumentView *view = (SPDocumentView *)handle;
    if (!view || view.closed) return NULL;
    // A region that has loaded nothing has no history entry; WebKit still serializes an empty session history for it,
    // and the setter restores no entry from that value, so the region returns no state.
    if (!view.backForwardList.currentItem) return strdup("");
    id state = view.interactionState;
    NSString *text = [state isKindOfClass:NSData.class] ? [(NSData *)state base64EncodedStringWithOptions:0] : @"";
    return strdup(text.UTF8String);
}

const char *sp_document_restore(void *handle, const char *state) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    SPDocumentView *view = (SPDocumentView *)handle;
    if (!view || view.closed) return "the document region is closed";
    if (view.backForwardList.currentItem) return "the document region has already loaded a document";
    NSData *data = state ? [[[NSData alloc] initWithBase64EncodedString:[NSString stringWithUTF8String:state] options:0] autorelease] : nil;
    if (!data.length) return "the interactionState is not base64";
    view.interactionState = data;
    // The setter reports no result; a state that WebKit cannot decode restores no history entry.
    if (!view.backForwardList.currentItem) return "the web view refused the interactionState";
    return NULL;
}

void sp_document_set_view_ended(void *handle, sp_view_ended ended, void *context) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    SPDocumentView *view = (SPDocumentView *)handle;
    if (!view || view.closed) return;
    view.viewEnded = ended;
    view.viewEndedContext = context;
}

void sp_document_add_user_script(void *handle, const char *source) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    SPDocumentView *view = (SPDocumentView *)handle;
    if (!view || view.closed || !source) return;
    // The page world, as the view channel script runs, so the page's first script reads the value.
    WKContentWorld *pageWorld = WKContentWorld.pageWorld;
    [view.configuration.userContentController addUserScript:[[[WKUserScript alloc] initWithSource:[NSString stringWithUTF8String:source]
        injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES inContentWorld:pageWorld] autorelease]];
}

void sp_document_set_view_responsiveness(void *handle, sp_view_responsiveness receiver, void *context) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    SPDocumentView *view = (SPDocumentView *)handle;
    if (!view || view.closed) return;
    view.viewResponsiveness = receiver;
    view.viewResponsivenessContext = context;
}

void sp_document_set_view_message(void *handle, sp_view_message message, void *context) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    SPDocumentView *view = (SPDocumentView *)handle;
    if (!view || view.closed) return;
    view.viewMessage = message;
    view.viewMessageContext = context;
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
    // The post runs in the current document, so the address of the committed document decides whether it is a plugin document of
    // the region's plugin; a load that has not committed has not replaced the current document.
    NSURL *url = view.committedURL;
    if (![url.scheme.lowercaseString isEqualToString:kApplicationScheme] || ![url.host isEqualToString:view.plugin]) return false;
    // The document parses the text: converting a message into an object here and that object into a script value costs the host
    // CPU in proportion to the message size at each post.
    NSString *text = [NSString stringWithUTF8String:json];
    if (!text) return false;
    [view callAsyncJavaScript:@"window.postMessage(JSON.parse(text), location.origin);" arguments:@{ @"text": text }
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
    // A view loads its page from its plugin: the path of the load is the page that receives the view import map.
    SPPluginScheme *scheme = (SPPluginScheme *)[view.configuration urlSchemeHandlerForURLScheme:kApplicationScheme];
    if ([scheme isKindOfClass:SPPluginScheme.class] && scheme.allowsCoreRoot) scheme.viewPage = url.path;
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

static void documentViewportMarkerError(char **error, const char *message) {
    if (error) *error = strdup(message);
}

bool sp_document_viewport_marker(void *document, bool enabled, uint8_t *rgb3, double *borderWidthPt, char **error) {
    NSCAssert(NSThread.isMainThread, @"document viewport markers require the UI thread");
    if (error) *error = NULL;
    if (!error) return false;
    if (!rgb3 || !borderWidthPt) {
        documentViewportMarkerError(error, "viewport marker metadata outputs are required");
        return false;
    }
    rgb3[0] = 0;
    rgb3[1] = 255;
    rgb3[2] = 255;
    *borderWidthPt = 2;
    if (!document && !enabled) return true;
    if (!document) {
        documentViewportMarkerError(error, "the document view is required to enable the viewport marker");
        return false;
    }

    SPDocumentView *view = (SPDocumentView *)document;
    if (view.closed) {
        documentViewportMarkerError(error, "the document view is closed");
        return false;
    }
    if (!enabled) {
        [view restoreViewportMarker];
        return true;
    }
    if (view.viewportMarkerEnabled) return true;

    view.viewportMarkerOriginalWantsLayer = view.wantsLayer;
    CALayer *layer = view.layer;
    view.viewportMarkerOriginalBorderWidth = layer ? layer.borderWidth : 0;
    view.viewportMarkerOriginalBorderColor = layer && layer.borderColor ? CGColorRetain(layer.borderColor) : NULL;
    view.viewportMarkerEnabled = YES;
    if (!view.wantsLayer) view.wantsLayer = YES;
    layer = view.layer;
    if (!layer) {
        [view restoreViewportMarker];
        documentViewportMarkerError(error, "the document view cannot create a marker layer");
        return false;
    }

    CGColorRef cyan = CGColorCreateGenericRGB(0, 1, 1, 1);
    if (!cyan) {
        [view restoreViewportMarker];
        documentViewportMarkerError(error, "the cyan viewport marker color cannot be created");
        return false;
    }
    surfaceTransactionBegin();
    [CATransaction setDisableActions:YES];
    layer.borderColor = cyan;
    layer.borderWidth = 2;
    surfaceTransactionCommit();
    CGColorRelease(cyan);
    return true;
}

void sp_document_background(void *handle, bool enabled) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    NSView *view = (NSView *)handle;
    if ([view isKindOfClass:SPDocumentView.class]) {
        SPDocumentView *document = (SPDocumentView *)view;
        if (document.viewportMarkerEnabled) document.viewportMarkerOriginalWantsLayer = YES;
    }
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
    // A view out of its window never presents, so its close ends each join of it in this turn.
    surfaceLayoutViewClosed(view);
    [view restoreViewportMarker];
    // The web content process of the view lives as long as AppKit keeps the view, so the keyboard leaves it at the close.
    sp_view_give_up_keyboard(view);
    view.closed = YES;
    [view.binaries releaseAll];
    view.binaries = nil;
    [openDocuments() removeObject:view];
    sp_surface_unplace_view(view);
    [view stopHiddenTimer];
    if (view.eventMonitor) {
        [NSEvent removeMonitor:view.eventMonitor];
        view.eventMonitor = nil;
    }
    [view.webSurface removeObserver:view forKeyPath:@"effectiveAppearance" context:&kAppearanceContext];
    view.webSurface = nil;
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

const char *sp_document_binary_take(void *handle, const char *id, void **bytes, size_t *length) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    SPDocumentView *view = (SPDocumentView *)handle;
    if (!view || view.closed) return "the document region is closed";
    if (!id || !bytes || !length) return "the binary id is not given";
    NSString *identifier = [NSString stringWithUTF8String:id];
    if (!identifier) return "the binary id is not UTF-8";
    NSDictionary *entry = [view.binaries entryForId:identifier];
    if (!entry) return "the binary id is not stored";
    NSData *data = entry[@"data"];
    void *copy = malloc(data.length);
    if (!copy) return "the bytes cannot be copied";
    memcpy(copy, data.bytes, data.length);
    *bytes = copy;
    *length = data.length;
    // removeId releases the entry, and with it data, so the length is read before the id is removed.
    [view.binaries removeId:identifier];
    return NULL;
}

char *sp_document_binary_put(void *handle, const void *bytes, size_t length, const char *type, char id[33]) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    SPDocumentView *view = (SPDocumentView *)handle;
    if (!view || view.closed) return strdup("the document region is closed");
    if (!id) return strdup("the put has no id buffer");
    if (!type) return strdup("the put has no content type");
    NSString *contentType = [NSString stringWithUTF8String:type];
    if (!contentType) return strdup("the content type of the put is not UTF-8");
    NSInteger status = 0;
    NSString *refusal = binaryRefusal(view.binaries, bytes ? length : 0, @"put", &status);
    if (refusal) return strdup(refusal.UTF8String);
    NSString *identifier = [view.binaries addData:[NSData dataWithBytes:bytes length:length] type:contentType];
    memcpy(id, identifier.UTF8String, 33);
    return NULL;
}

// The domain of the errors of sp_document_upload_body; the localized description of each error is its reason.
static NSString *const kUploadBodyErrorDomain = @"SPDocumentUploadBody";

static NSError *uploadBodyError(NSString *reason) {
    return [NSError errorWithDomain:kUploadBodyErrorDomain code:1 userInfo:@{ NSLocalizedDescriptionKey: reason }];
}

// The HTTPBody of the request is returned as it is. WebKit sets HTTPBodyStream when it sends the body as a stream, and the
// stream is read into data. A stream is read to one chunk past limit at most, so an oversized body is refused without
// reading all of it. WebKit gives a body with neither form for some bodies, such as a Blob.
NSData *sp_document_upload_body(NSURLRequest *request, NSUInteger limit, NSError **error) {
    if (request.HTTPBody) return request.HTTPBody;
    NSInputStream *stream = request.HTTPBodyStream;
    if (!stream) {
        if (error) *error = uploadBodyError(@"the upload has no body that WebKit delivers as HTTPBody or HTTPBodyStream");
        return nil;
    }
    NSMutableData *data = [NSMutableData data];
    uint8_t buffer[64 * 1024];
    [stream open];
    while (data.length <= limit) {
        NSInteger count = [stream read:buffer maxLength:sizeof buffer];
        if (count < 0) {
            // A stream may fail without an error object; the reason then states that, so the text never holds "(null)".
            NSString *reason = stream.streamError
                ? [NSString stringWithFormat:@"the request body could not be read: %@", stream.streamError.localizedDescription]
                : @"the request body could not be read: the stream failed without an error";
            [stream close];
            if (error) *error = uploadBodyError(reason);
            return nil;
        }
        if (count == 0) break;
        [data appendBytes:buffer length:(NSUInteger)count];
    }
    [stream close];
    return data;
}

size_t sp_document_binary_count(void *handle) {
    SPDocumentView *view = (SPDocumentView *)handle;
    return view ? view.binaries.count : 0;
}

// The stores whose sessions the network process is removing, the stores that wait for the processes to end, and the network
// process.
static int storeRemovals;
static NSMutableArray<void (^)(const char *)> *storeEndsWaiting;
static pid_t storeEndProcess;

// Two processes write into the directory of a store after its session is removed, and WebKit gives no event for the end of
// their writes (document_store_end_test). The network process writes the records of the network cache about one second after
// a load, and clearing the disk cache does not drop them. The GPU process plays media and rewrites the media cache after the
// player of a closed document ends. Each process ends, and its exit tells that it writes nothing more. Ending the network
// process while another store removes its session fails that removal, so the processes end after the last removal. The next
// document that needs a process starts it again.
static void endStoreProcesses(void) {
    NSArray<void (^)(const char *)> *waiting = [[storeEndsWaiting copy] autorelease];
    [storeEndsWaiting removeAllObjects];
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    // The GPU process belongs to no store and a document has its own pool, so the class names the one process of the application.
    // macOS 14.4 does not have this method, so the end reports that it cannot name the process.
    BOOL named = [WKProcessPool respondsToSelector:@selector(_gpuProcessInfo)];
    const pid_t processes[] = {storeEndProcess, named ? WKProcessPool._gpuProcessInfo.pid : 0};
#pragma clang diagnostic pop
    storeEndProcess = 0;
    // The count starts at 1, so the waiting stores finish only after every process has been asked to end.
    __block NSUInteger running = 1;
    __block NSString *refusal = named ? nil : [[NSString alloc] initWithString:@"_gpuProcessInfo is unavailable"];
    void (^ended)(void) = [^{
        if (--running > 0) return;
        for (void (^finish)(const char *) in waiting) finish(refusal.UTF8String);
        [refusal release];
    } copy];
    for (size_t i = 0; i < sizeof(processes) / sizeof(processes[0]); i++) {
        pid_t process = processes[i];
        if (process <= 0) continue;
        running++;
        __block dispatch_source_t exit = NULL;
        exit = sp_observe_process_exit("document.store-end", SP_OBSERVE_RECORD, process, dispatch_get_main_queue(), ^{
            dispatch_source_cancel(exit);
            ended();
        });
        if (!exit) {
            if (!refusal) refusal = [[NSString alloc] initWithFormat:@"the exit of the process %d is not observed", process];
            ended();
            continue;
        }
        dispatch_source_set_cancel_handler(exit, ^{ dispatch_release(exit); });
        dispatch_resume(exit);
        // A process that already ended reports its exit through the source, and any other refusal is the failure of the end.
        if (kill(process, SIGKILL) != 0 && errno != ESRCH) {
            if (!refusal) refusal = [[NSString alloc] initWithFormat:@"the process %d does not end: %s", process, strerror(errno)];
            dispatch_source_cancel(exit);
            ended();
        }
    }
    ended();
    [ended release];
}

void sp_document_store_close(const char *directory, sp_document_store_closed closed, void *context) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    NSString *path = directory ? storeDirectory(directory) : nil;
    if (!path) {
        closed(context, "the store directory is not an absolute path");
        return;
    }
    if ([endingStores() containsObject:path]) {
        closed(context, "the store of the directory is already ending");
        return;
    }
    WKWebsiteDataStore *store = dataStores()[path];
    if (!store) {
        closed(context, NULL);
        return;
    }
    // A configuration read returns an autoreleased copy that keeps the store, so the reads drain their own pool.
    BOOL open = NO;
    @autoreleasepool {
        for (SPDocumentView *view in openDocuments()) open = open || view.configuration.websiteDataStore == store;
    }
    if (open) {
        closed(context, "a document of the directory is open");
        return;
    }
    storeRemovals++;
    [endingStores() addObject:path];
    // A store whose document loaded nothing can have no known network process yet, and that process then writes into the directory
    // after the end. A fetch of the records of the store starts the process and answers after it runs, so the end knows it.
    [store fetchDataRecordsOfTypes:[NSSet setWithObject:WKWebsiteDataTypeDiskCache] completionHandler:^(NSArray<WKWebsiteDataRecord *> *records) {
        (void)records;
        // WebKit removes the session of a store from the network process when the last reference to the store goes away
        // (WebsiteDataStore::~WebsiteDataStore calls NetworkProcessProxy::removeSession), and calls this handler after the
        // network process has destroyed the session and closed its storage. A closed web view can still hold its
        // configuration for a while, so the handler runs when that reference also goes away.
        // The session of the store is removed first; a process that ended
        // before that would start again for the session and open its databases in the directory.
        pid_t networkProcess = store._networkProcessIdentifier;
        if (networkProcess > 0) storeEndProcess = networkProcess;
        BOOL named = networkProcess > 0;
        [store _setCompletionHandlerForRemovalFromNetworkProcess:^(NSError *error) {
            char *failure = error ? strdup(error.localizedDescription.UTF8String)
                : named ? NULL : strdup("the network process of the store has no identifier");
            void (^finish)(const char *) = [^(const char *refusal) {
                [endingStores() removeObject:path];
                closed(context, failure ?: refusal);
                free(failure);
            } copy];
            if (!storeEndsWaiting) storeEndsWaiting = [NSMutableArray new];
            [storeEndsWaiting addObject:finish];
            [finish release];
            storeRemovals--;
            if (storeRemovals == 0) endStoreProcesses();
        }];
        [dataStores() removeObjectForKey:path];
    }];
}

bool sp_document_set_hidden_clear_delay(double seconds) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    if (!isfinite(seconds) || seconds <= 0) return false;
    hiddenClearDelay = seconds;
    return true;
}

void sp_document_memory_pressure(const char *level) {
    NSCAssert(NSThread.isMainThread, @"documents belong to the main thread");
    if (strcmp(level, "warn") != 0 && strcmp(level, "critical") != 0) return;
    for (SPDocumentView *view in openDocuments().allObjects) [view clearBackForwardCache:@"pressure"];
}
