//go:build darwin

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "application_log.h"
#import "webview_input.h"
#import "surface_layout.h"
#import "webview_geometry.h"
#import "window_fullscreen.h"
#import "window_facts.h"

extern void nativeMessage(unsigned long long identifier, char *message);
extern void nativeCommitted(unsigned long long identifier);

@interface SPNativeBridge : NSObject <WKScriptMessageHandler>
@property unsigned long long identifier;
@property(copy) NSString *scheme;
@property(copy) NSString *host;
@end

@implementation SPNativeBridge
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    // 애플리케이션 출처의 메인 프레임 문서만 호스트를 호출할 수 있다.
    WKSecurityOrigin *origin = message.frameInfo.securityOrigin;
    if (!message.frameInfo.isMainFrame || ![origin.protocol isEqualToString:self.scheme]
        || ![origin.host isEqualToString:self.host] || ![message.body isKindOfClass:NSString.class]) return;
    nativeMessage(self.identifier, (char *)[message.body UTF8String]);
}
- (void)dealloc {
    [_scheme release]; [_host release];
    [super dealloc];
}
@end

@interface SPNativeWebview : WKWebView <WKNavigationDelegate>
// 호스트가 이 웹뷰의 메시지에 붙이는 번호. NSView 의 identifier 와 다르다.
@property unsigned long long messageIdentifier;
@property(copy) NSURL *baseURL;
@property BOOL backgroundEnabled;
@end

@implementation SPNativeWebview
- (void)webView:(WKWebView *)view didCommitNavigation:(WKNavigation *)navigation {
    nativeCommitted(self.messageIdentifier);
    [self evaluateJavaScript:self.backgroundEnabled ? @"window.__soksakBackground = true" : @"window.__soksakBackground = false" completionHandler:^(id result, NSError *error) {
        if (error) sp_log_error("surface background", error.localizedDescription.UTF8String);
    }];
}
- (void)dealloc {
    [_baseURL release];
    [super dealloc];
}
@end

// 공개 NSView 계층에서 프레임워크의 메인 웹뷰를 찾는다.
// 앱이 추가한 웹뷰는 제외하므로 설정 원본으로 선택되지 않는다.
static WKWebView *mainWebview(NSView *parent) {
    if ([parent isKindOfClass:WKWebView.class] && ![parent isKindOfClass:SPNativeWebview.class]) return (WKWebView *)parent;
    for (NSView *child in parent.subviews) {
        WKWebView *found = mainWebview(child);
        if (found) return found;
    }
    return nil;
}

extern void nativePresentationDone(uintptr_t callback);
bool nativeWindowAfterPresentation(void *handle, uintptr_t callback) {
    WKWebView *view = sp_window_main_webview(handle);
    if (!view) return false;
    surfaceLayoutAfterPresentation(view, ^{ nativePresentationDone(callback); });
    return true;
}

extern void nativeSettledDone(uintptr_t callback, double displayed, char *error);
bool nativeWindowAfterSettled(void *handle, uintptr_t callback) {
    WKWebView *view = sp_window_main_webview(handle);
    if (!view) return false;
    surfaceLayoutAfterSettled(view, ^(double displayed, const char *error) {
        nativeSettledDone(callback, displayed, error ? strdup(error) : NULL);
    });
    return true;
}

void nativeWindowPrepare(void *handle) {
    NSWindow *window = (NSWindow *)handle;
    WKWebView *root = sp_window_main_webview(handle);
    if (!root) return;
    // Wails v3.0.0-beta.27 은 콘텐츠 뷰를 WKWebView 보다 1pt 작게 만든다.
    // 공개 배치 API 로 자동 크기 조정 여백을 0 으로 만들고 메인 웹뷰를 콘텐츠 bounds에 맞춘다.
    // 창 크기를 웹뷰의 이전 크기로 역전파하지 않으므로 이후 창 크기도 그대로 유지된다.
    if (!NSEqualSizes(root.frame.size, window.contentView.bounds.size)) {
        root.frame = root.superview.bounds;
    }
}

bool nativeWindowConfigureMain(void *handle, bool dark) {
    NSWindow *window = (NSWindow *)handle;
    WKWebView *root = sp_window_main_webview(handle);
    if (!root) return false;
    NSAppearance *appearance = [NSAppearance appearanceNamed:(dark ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua)];
    if (!appearance) return false;
    root.underPageBackgroundColor = NSColor.clearColor;
    [root setValue:@NO forKey:@"drawsBackground"];
    window.appearance = appearance;
    return true;
}

bool nativeWindowSetMainWebview(void *handle) {
    NSWindow *window = (NSWindow *)handle;
    if (sp_window_main_webview(handle)) return true;
    WKWebView *root = mainWebview(window.contentView);
    return root && sp_window_set_main_webview(window, root);
}

void nativeWebviewBounds(void *handle, double x, double y, double width, double height) {
    webviewSetFrame(handle, x, y, width, height);
}

void *nativeWebviewCreate(void *handle, unsigned long long identifier, const char *name, const char *script,
    double x, double y, double width, double height, bool hidden, bool transparent, bool fillParent) {
    NSWindow *window = (NSWindow *)handle;
    WKWebView *root = sp_window_main_webview(handle);
    if (!root || !root.URL || !webviewInputRegister(root)) return NULL;

    // 복사한 설정은 프레임워크의 공개 WKURLSchemeHandler, 프로세스 풀과 데이터 저장소를 유지한다.
    // 스크립트 컨트롤러는 앱의 것으로 교체한다. 추가 문서가 메인 페이지의 Wails
    // runtime-ready 메시지를 보내면 안 된다.
    WKWebViewConfiguration *configuration = [root.configuration copy];
    WKUserContentController *controller = [[WKUserContentController alloc] init];
    SPNativeBridge *bridge = [[SPNativeBridge alloc] init];
    bridge.identifier = identifier;
    bridge.scheme = root.URL.scheme;
    bridge.host = root.URL.host;
    [controller addScriptMessageHandler:bridge name:@"soksak"];
    [bridge release];
    WKUserScript *bootstrap = [[WKUserScript alloc] initWithSource:[NSString stringWithUTF8String:script]
        injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES];
    [controller addUserScript:bootstrap];
    [bootstrap release];
    configuration.userContentController = controller;
    [controller release];
    SPNativeWebview *view = [[SPNativeWebview alloc] initWithFrame:NSZeroRect configuration:configuration];
	view.messageIdentifier = identifier;
	if (name != NULL && name[0] != '\0') view.identifier = [NSString stringWithUTF8String:name];
    [configuration release];
    view.baseURL = root.URL;
    view.UIDelegate = root.UIDelegate;
    view.navigationDelegate = view;
    view.hidden = hidden;
    view.autoresizingMask = fillParent ? NSViewWidthSizable | NSViewHeightSizable : NSViewMinYMargin;
    if (transparent) {
        view.underPageBackgroundColor = NSColor.clearColor;
        @try {
            [view setValue:@NO forKey:@"drawsBackground"];
            if ([[view valueForKey:@"drawsBackground"] boolValue]) { [view release]; return NULL; }
        // 기본값: 키를 모르는 WebKit 은 예외를 던지고, 이 함수의 NULL 은 호출자가 웹뷰를 만들지 못한 오류로 알린다.
        } @catch (NSException *error) { [view release]; return NULL; }
    }
    // 표면과 모달의 페이지는 창의 키보드 초점을 옮기지 않는다. 메인 페이지는 옮긴다.
    if (!webviewInputRegister(view) || !webviewIgnorePageFocus(view)) { [view release]; return NULL; }
    // 새 표면은 메인 웹뷰 위, 기존 모달 아래에 둔다. 모달은 여기서 숨긴 상태로 두고
    // 렌더링을 마치면 위로 올린다.
    [window.contentView addSubview:view positioned:NSWindowAbove relativeTo:root];
    // fillParent 인 모달은 창에 직접 놓고, 모든 표면은 투명 여부와 관계없이
    // SurfaceHost에 붙인다. 혼합 표면의 DOM 웹뷰 아래에 네이티브 평면이 있어야 한다.
    if (!fillParent) webviewAttachSurface(view, root);
    nativeWebviewBounds(view, x, y, width, height);
    return view; // nativeWebviewClose 까지 Go 가 이 참조를 소유한다.
}

bool nativeWebviewNavigate(void *handle, const char *url) {
    SPNativeWebview *view = (SPNativeWebview *)handle;
    NSURL *target = [NSURL URLWithString:[NSString stringWithUTF8String:url] relativeToURL:view.baseURL];
    if (!target) return false;
    [view loadRequest:[NSURLRequest requestWithURL:target.absoluteURL]];
    return true;
}

void nativeWebviewHidden(void *handle, bool hidden) { webviewSetSurfaceHidden(handle, hidden); }
void nativeWebviewBackground(void *handle, bool enabled) {
    SPNativeWebview *view = handle;
    view.backgroundEnabled = enabled;
    [view evaluateJavaScript:enabled ? @"window.__soksakBackground = true" : @"window.__soksakBackground = false" completionHandler:nil];
}
void nativeWebviewEval(void *handle, const char *script) {
    [(WKWebView *)handle evaluateJavaScript:[NSString stringWithUTF8String:script] completionHandler:nil];
}
void nativeWebviewClose(void *handle) {
    WKWebView *view = (WKWebView *)handle;
    webviewInputUnregister(view);
    [view stopLoading];
    [view.configuration.userContentController removeScriptMessageHandlerForName:@"soksak"];
    webviewDetachSurface(view);
    [view removeFromSuperview];
    [view release];
}

extern void nativeLayoutReady(uintptr_t callback, bool allowed);
void nativeWindowLayoutBegin(void *window, uint64_t ticket, uintptr_t callback) {
    surfaceLayoutBegin(window, ticket, ^(int allowed) { nativeLayoutReady(callback, allowed); });
}

extern void nativeStartPageReady(uintptr_t callback, const char *failure);
void nativeWindowStartPage(void *window, uint64_t ticket, double height, uintptr_t callback) {
    surfaceLayoutStartPage(window, ticket, height, ^(const char *failure) { nativeStartPageReady(callback, failure); });
}

extern void nativeFullscreenDone(uintptr_t callback);
bool nativeWindowFullscreen(void *handle, bool on, uintptr_t callback) {
    return sp_window_fullscreen(handle, on, ^{ nativeFullscreenDone(callback); });
}
