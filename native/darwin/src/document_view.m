// 표면 문서 안의 외부 문서 웹뷰.
//
// 상태는 WKWebView 의 KVO 속성과 WKNavigationDelegate 로 읽는다. 스크롤 위치는 문서 전용
// 콘텐츠 월드(WKContentWorld)의 스크립트가 scroll 이벤트마다 보낸다. 그 월드와 메시지
// 처리기는 문서 페이지의 스크립트에서 보이지 않는다.
#import <Cocoa/Cocoa.h>
#import <CoreImage/CoreImage.h>
#import <WebKit/WebKit.h>
#import "document_view.h"
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

static NSArray<NSString *> *observedKeys(void) {
    return @[ @"URL", @"title", @"loading", @"estimatedProgress", @"canGoBack", @"canGoForward" ];
}

@class SPDocumentView;

extern double sp_surface_scale(void *surface);

static CGFloat documentSurfaceScale(NSView *surface) {
    return sp_surface_scale(surface);
}

// 메시지 처리기. 사용자 콘텐츠 컨트롤러가 처리기를 보유하므로 뷰를 약하게 가리킨다.
@interface SPDocumentScroll : NSObject <WKScriptMessageHandler>
@property(assign) SPDocumentView *view;
@end

@interface SPDocumentView : WKWebView <WKNavigationDelegate, WKUIDelegate>
@property sp_document_changed changed;
@property void *context;
@property sp_document_event event;
@property void *eventContext;
@property(retain) id eventMonitor;
@property(retain) SPDocumentScroll *scroll;
@property(copy) NSString *failure;
// 진행 중인 주 프레임 이동. 요청하거나 시작한 때부터 끝나거나 실패할 때까지 읽는 중으로 보고한다.
// 대체된 이전 이동이 취소되면 새 이동이 시작되기 전에 WKWebView.loading 이 NO 가 되기 때문이다.
@property(retain) WKNavigation *navigation;
@property(assign) NSView *webSurface;
@property NSPoint offset;
@property NSEdgeInsets insets;
// 글자 배율(docs/spec/text-size.md). 페이지 확대로 적용한다.
@property double zoom;
@property BOOL wanted;
@property BOOL placed;
@property BOOL pending;
@property BOOL closed;
- (void)report;
- (void)request:(WKNavigation *)navigation;
- (BOOL)requestIfStarted:(WKNavigation *)navigation;
- (void)applyInsets;
- (void)surfaceScaleChanged;
- (void)surfaceAppearanceChanged:(NSNotification *)notification;
- (void)reportEvent:(const char *)json;
@end

@implementation SPDocumentScroll
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    SPDocumentView *view = self.view;
    if (!view || !message.frameInfo.isMainFrame || ![message.body isKindOfClass:NSDictionary.class]) return;
    NSDictionary *body = message.body;
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
    [_navigation release];
    [_eventMonitor release];
    [super dealloc];
}

- (void)reportEvent:(const char *)json {
    if (!self.closed && self.event) self.event(self.eventContext, json);
}

- (void)installEventMonitor {
    SPDocumentView *document = self;
    self.eventMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown
        handler:^NSEvent *(NSEvent *event) {
            NSWindow *window = event.window;
            NSView *content = window.contentView;
            NSView *hit = content ? [content hitTest:[content convertPoint:event.locationInWindow fromView:nil]] : nil;
            if (hit == document || [hit isDescendantOf:document]) [document reportEvent:"{\"type\":\"click\"}"];
            return event;
        }];
}

- (void)surfaceAppearanceChanged:(NSNotification *)notification {
    NSAppearance *appearance = self.webSurface.effectiveAppearance;
    if (appearance) self.appearance = appearance;
}

// 같은 실행 루프 차례의 여러 변경을 한 번의 보고로 묶는다.
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

// 세션 기록. 항목은 오래된 것부터이고 index 는 현재 항목의 위치다. 첫 로드 전에는 비어 있고 -1 이다.
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
    };
    NSData *data = [NSJSONSerialization dataWithJSONObject:state options:0 error:nil];
    if (!data) return;
    NSString *text = [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease];
    self.changed(self.context, text.UTF8String);
}

- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary *)change context:(void *)context {
    if (object == self) [self report];
    else if (object == self.webSurface && [keyPath isEqualToString:@"effectiveAppearance"])
        [self surfaceAppearanceChanged:nil];
}

- (void)request:(WKNavigation *)navigation {
    self.navigation = navigation;
    [self report];
}

- (BOOL)requestIfStarted:(WKNavigation *)navigation {
    if (!navigation) return NO;
    [self request:navigation];
    return YES;
}

// 이동이 끝났다. 진행 중인 이동이 아니면 대체된 이동이므로 무시한다.
- (void)settle:(WKNavigation *)navigation {
    if (navigation == self.navigation) self.navigation = nil;
}

- (void)webView:(WKWebView *)view didStartProvisionalNavigation:(WKNavigation *)navigation {
    self.navigation = navigation;
    self.failure = nil;
    [self report];
}

- (void)fail:(NSError *)error {
    // 새 이동이 이전 이동을 취소한 경우는 실패가 아니다.
    if ([error.domain isEqualToString:NSURLErrorDomain] && error.code == NSURLErrorCancelled) return;
    self.failure = error.localizedDescription;
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

// 문서 영역은 웹 주소만 연다. 앱의 스킴과 파일 주소는 거부한다.
static BOOL webAddress(NSURL *url) {
    NSString *scheme = url.scheme.lowercaseString;
    return [scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"] || [url.absoluteString isEqualToString:@"about:blank"];
}

- (void)webView:(WKWebView *)view decidePolicyForNavigationAction:(WKNavigationAction *)action
    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    if (!webAddress(action.request.URL)) {
        self.failure = [NSString stringWithFormat:@"%@ is not a web address", action.request.URL.absoluteString];
        // 거부한 주 프레임 이동은 시작되지 않는다. 진행 중인 이동은 이 결정을 받은 이동이다.
        if (action.targetFrame.isMainFrame) self.navigation = nil;
        [self report];
        decisionHandler(WKNavigationActionPolicyCancel);
        return;
    }
    decisionHandler(WKNavigationActionPolicyAllow);
}

// 새 창을 요청한 이동은 같은 영역에서 연다.
- (WKWebView *)webView:(WKWebView *)view createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
    forNavigationAction:(WKNavigationAction *)action windowFeatures:(WKWindowFeatures *)features {
    if (webAddress(action.request.URL)) [self request:[self loadRequest:action.request]];
    return nil;
}

// 여백을 표면 뷰의 AppKit point 좌표로 바꾼다. 표면 웹뷰와 문서 웹뷰는
// CSS 픽셀은 글자 배율(페이지 확대)만큼 point 보다 크고, backing 배율은 WebKit raster에만 적용한다.
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

// 표면 크기가 바뀌면 영역을 여백으로 다시 정한다. 비례 조정(autoresizing)은 표면이 여백보다
// 작아졌던 크기를 잃는다.
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
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(surfaceResized:)
        name:NSViewFrameDidChangeNotification object:self.superview];
}

- (void)surfaceResized:(NSNotification *)notification {
    if (self.placed) [self applyInsets];
}

@end

// 디렉터리마다 영구 데이터 저장소 하나. 같은 디렉터리를 쓰는 두 저장소 객체는 같은 파일을 따로 쓰므로
// 한 디렉터리의 문서는 모두 같은 저장소를 쓴다. 저장소는 프로세스가 끝날 때까지 유지한다.
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

// 영역 문서가 사용자 에이전트 뒤에 붙이는 Safari 이름. 브라우저 이름이 없는 WebKit 사용자 에이전트에는
// 사이트가 축소된 페이지를 보내고, Google 검색의 기본 페이지에는 다크 테마가 없다. 버전은 시스템 Safari 의
// 버전이며, 읽지 못하면 nil 이다.
static NSString *safariApplicationName(void) {
    NSString *version = [NSBundle bundleWithPath:@"/Applications/Safari.app"].infoDictionary[@"CFBundleShortVersionString"];
    NSArray<NSString *> *parts = [version componentsSeparatedByString:@"."];
    if (parts.count < 2) return nil;
    return [NSString stringWithFormat:@"Version/%@.%@ Safari/605.1.15", parts[0], parts[1]];
}

void *sp_document_create(void *surfaceHandle, const char *directory, sp_document_changed changed, void *context) {
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
    WKContentWorld *world = [WKContentWorld worldWithName:@"soksak-document"];
    SPDocumentScroll *scroll = [[SPDocumentScroll new] autorelease];
    [configuration.userContentController addScriptMessageHandler:scroll contentWorld:world name:kScrollMessage];
    WKUserScript *script = [[[WKUserScript alloc] initWithSource:kScrollScript
        injectionTime:WKUserScriptInjectionTimeAtDocumentEnd forMainFrameOnly:YES inContentWorld:world] autorelease];
    [configuration.userContentController addUserScript:script];

    SPDocumentView *view = [[SPDocumentView alloc] initWithFrame:NSZeroRect configuration:configuration];
    scroll.view = view;
    view.scroll = scroll;
    view.changed = changed;
    view.context = context;
    view.navigationDelegate = view;
    view.UIDelegate = view;
    view.webSurface = surface;
    view.appearance = surface.effectiveAppearance;
    view.hidden = YES;
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
    [surface addObserver:view forKeyPath:@"effectiveAppearance" options:0 context:NULL];
    view.zoom = 1;
    view.pageZoom = view.zoom;
    [view _setOverrideDeviceScaleFactor:sp_surface_scale(surface)];
    for (NSString *key in observedKeys()) [view addObserver:view forKeyPath:key options:0 context:NULL];
    return view; // sp_document_close 까지 호출자가 이 참조를 소유한다.
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
    // 표면 문서의 CSS blur(3px) 와 같은 반경이다. 뷰의 한 단위는 CSS 픽셀에 pageZoom 을 곱한 값이다.
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
    if (view.eventMonitor) {
        [NSEvent removeMonitor:view.eventMonitor];
        view.eventMonitor = nil;
    }
    [view.webSurface removeObserver:view forKeyPath:@"effectiveAppearance"];
    view.event = NULL;
    view.eventContext = NULL;
    for (NSString *key in observedKeys()) [view removeObserver:view forKeyPath:key];
    view.scroll.view = nil;
    [view.configuration.userContentController removeAllScriptMessageHandlers];
    view.navigationDelegate = nil;
    view.UIDelegate = nil;
    webviewInputUnregister(view);
    [view stopLoading];
    [view removeFromSuperview];
    [view release];
}
