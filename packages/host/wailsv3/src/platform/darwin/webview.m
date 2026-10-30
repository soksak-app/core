//go:build darwin

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "application_log.h"
#import "webview_input.h"
#import "surface_layout.h"
#import "webview_geometry.h"
#import "window_fullscreen.h"
#import "window_facts.h"
#import "main_thread.h"

extern void goNativeMessage(unsigned long long identifier, char *message);
extern void goNativeCommitted(unsigned long long identifier);
extern void goNativeTerminated(unsigned long long identifier);

@interface SPNativeBridge : NSObject <WKScriptMessageHandler>
@property unsigned long long identifier;
@property(copy) NSString *scheme;
@property(copy) NSString *host;
@end

@implementation SPNativeBridge
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    // Only a main frame document of the application origin can call the host.
    WKSecurityOrigin *origin = message.frameInfo.securityOrigin;
    if (!message.frameInfo.isMainFrame || ![origin.protocol isEqualToString:self.scheme]
        || ![origin.host isEqualToString:self.host] || ![message.body isKindOfClass:NSString.class]) return;
    unsigned long long identifier = self.identifier;
    char *body = (char *)[message.body UTF8String];
    wailsRunOnWorker(^{ goNativeMessage(identifier, body); });
}
- (void)dealloc {
    [_scheme release]; [_host release];
    [super dealloc];
}
@end

@interface SPNativeWebview : WKWebView <WKNavigationDelegate>
// The number that the host attaches to the messages of this web view. It differs from the identifier of the NSView.
@property unsigned long long messageIdentifier;
@property(copy) NSURL *baseURL;
@property BOOL backgroundEnabled;
@end

@implementation SPNativeWebview
- (void)webView:(WKWebView *)view didCommitNavigation:(WKNavigation *)navigation {
    unsigned long long identifier = self.messageIdentifier;
    wailsRunOnWorker(^{ goNativeCommitted(identifier); });
    [self evaluateJavaScript:self.backgroundEnabled ? @"window.__soksakBackground = true" : @"window.__soksakBackground = false" completionHandler:^(id result, NSError *error) {
        if (error) sp_log_error("surface background", error.localizedDescription.UTF8String);
    }];
}
// The WebContent process of a surface or a modal ended; the host records it as it records the page process of a window.
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)view {
    sp_webview_log_process_end((__bridge void *)view, "surface webview");
    unsigned long long identifier = self.messageIdentifier;
    wailsRunOnWorker(^{ goNativeTerminated(identifier); });
}
- (void)dealloc {
    [_baseURL release];
    [super dealloc];
}
@end

// Finds the main web view of the framework in the public NSView hierarchy.
// Web views that the app added are excluded, so they are not selected as the source of the configuration.
static WKWebView *mainWebview(NSView *parent) {
    if ([parent isKindOfClass:WKWebView.class] && ![parent isKindOfClass:SPNativeWebview.class]) return (WKWebView *)parent;
    for (NSView *child in parent.subviews) {
        WKWebView *found = mainWebview(child);
        if (found) return found;
    }
    return nil;
}

extern void goNativePresentationDone(uintptr_t callback);
static bool nativeWindowAfterPresentationOnMain(void *handle, uintptr_t callback) {
    WKWebView *view = sp_window_main_webview(handle);
    if (!view) return false;
    surfaceLayoutAfterPresentation(view, ^{ wailsRunOnWorker(^{ goNativePresentationDone(callback); }); });
    return true;
}

// nativeWindowJoinView joins the view webview to the layout transaction of window. callback runs when the view presents.
static bool nativeWindowJoinViewOnMain(void *window, uint64_t ticket, void *view, uintptr_t callback) {
    return surfaceLayoutJoinView(window, ticket, view, ^{ wailsRunOnWorker(^{ goNativePresentationDone(callback); }); });
}

extern void goNativeSettledDone(uintptr_t callback, double displayed, char *error);
static bool nativeWindowAfterSettledOnMain(void *handle, uintptr_t callback) {
    WKWebView *view = sp_window_main_webview(handle);
    if (!view) return false;
    surfaceLayoutAfterSettled(view, ^(double displayed, const char *error) {
        char *copy = error ? strdup(error) : NULL;
        wailsRunOnWorker(^{ goNativeSettledDone(callback, displayed, copy); });
    });
    return true;
}

static void nativeWindowPrepareOnMain(void *handle) {
    NSWindow *window = (NSWindow *)handle;
    WKWebView *root = sp_window_main_webview(handle);
    if (!root) return;
    // Wails v3.0.0-beta.27 makes the content view 1pt smaller than the WKWebView.
    // The public layout API sets the autoresizing margins to 0 and fits the main web view to the content bounds.
    // It does not propagate the window size back to the previous size of the web view, so the later window size is also kept.
    if (!NSEqualSizes(root.frame.size, window.contentView.bounds.size)) {
        root.frame = root.superview.bounds;
    }
}

static bool nativeWindowConfigureMainOnMain(void *handle, bool dark) {
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

static bool nativeWindowSetMainWebviewOnMain(void *handle) {
    NSWindow *window = (NSWindow *)handle;
    if (sp_window_main_webview(handle)) return true;
    WKWebView *root = mainWebview(window.contentView);
    return root && sp_window_set_main_webview(window, root);
}

static void nativeWebviewBoundsOnMain(void *handle, double x, double y, double width, double height) {
    webviewSetFrame(handle, x, y, width, height);
}

static void *nativeWebviewCreateOnMain(void *handle, unsigned long long identifier, const char *name, const char *script,
    double x, double y, double width, double height, bool hidden, bool transparent, bool fillParent) {
    NSWindow *window = (NSWindow *)handle;
    WKWebView *root = sp_window_main_webview(handle);
    if (!root || !root.URL || !webviewInputRegister(root)) return NULL;

    // The copied configuration keeps the public WKURLSchemeHandler, the process pool and the data store of the framework.
    // The script controller is replaced with the one of the app. An additional document must not send the Wails
    // runtime-ready message of the main page.
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
        // default: WebKit throws an exception for an unknown key, and the NULL of this function is reported by the caller as an error that the web view could not be created.
        } @catch (NSException *error) { [view release]; return NULL; }
    }
    // The pages of surfaces and modals do not move the keyboard focus of the window. The main page does.
    if (!webviewInputRegister(view) || !webviewIgnorePageFocus(view)) { [view release]; return NULL; }
    // A new surface is placed above the main web view and below the existing modals. A modal is kept hidden here
    // and raised when it finishes rendering.
    [window.contentView addSubview:view positioned:NSWindowAbove relativeTo:root];
    // A modal with fillParent is placed directly in the window, and every surface is attached to
    // SurfaceHost regardless of transparency. The native plane must be below the DOM web view of a mixed surface.
    if (!fillParent) webviewAttachSurface(view, root);
    nativeWebviewBoundsOnMain(view, x, y, width, height);
    return view; // Go owns this reference until nativeWebviewClose.
}

static bool nativeWebviewNavigateOnMain(void *handle, const char *url) {
    SPNativeWebview *view = (SPNativeWebview *)handle;
    NSURL *target = [NSURL URLWithString:[NSString stringWithUTF8String:url] relativeToURL:view.baseURL];
    if (!target) return false;
    [view loadRequest:[NSURLRequest requestWithURL:target.absoluteURL]];
    return true;
}

static void nativeWebviewHiddenOnMain(void *handle, bool hidden) { webviewSetSurfaceHidden(handle, hidden); }
static void nativeWebviewBackgroundOnMain(void *handle, bool enabled) {
    SPNativeWebview *view = handle;
    view.backgroundEnabled = enabled;
    [view evaluateJavaScript:enabled ? @"window.__soksakBackground = true" : @"window.__soksakBackground = false" completionHandler:nil];
}
static void nativeWebviewEvalOnMain(void *handle, const char *script) {
    [(WKWebView *)handle evaluateJavaScript:[NSString stringWithUTF8String:script] completionHandler:nil];
}
static void nativeWebviewCloseOnMain(void *handle) {
    WKWebView *view = (WKWebView *)handle;
    webviewInputUnregister(view);
    [view stopLoading];
    [view.configuration.userContentController removeScriptMessageHandlerForName:@"soksak"];
    webviewDetachSurface(view);
    [view removeFromSuperview];
    [view release];
}

extern void goNativeLayoutReady(uintptr_t callback, bool allowed);
static void nativeWindowLayoutBeginOnMain(void *window, uint64_t ticket, uintptr_t callback) {
    surfaceLayoutBegin(window, ticket, ^(int allowed) { wailsRunOnWorker(^{ goNativeLayoutReady(callback, allowed); }); });
}

extern void goNativeStartPageReady(uintptr_t callback, const char *failure);
static void nativeWindowStartPageOnMain(void *window, uint64_t ticket, double height, uintptr_t callback) {
    surfaceLayoutStartPage(window, ticket, height, ^(const char *failure) { wailsRunOnWorker(^{ goNativeStartPageReady(callback, failure); }); });
}

extern void goNativeFullscreenDone(uintptr_t callback);
static bool nativeWindowFullscreenOnMain(void *handle, bool on, uintptr_t callback) {
    return sp_window_fullscreen(handle, on, ^{ wailsRunOnWorker(^{ goNativeFullscreenDone(callback); }); });
}

extern void goNativeResponderChanged(uintptr_t callback);
static void *nativeWindowObserveResponderOnMain(void *handle, uintptr_t callback) {
    return sp_window_observe_responder(handle, ^{ wailsRunOnWorker(^{ goNativeResponderChanged(callback); }); });
}

// The functions that Go code calls. Go code runs on the worker of the framework, and each function runs its body on the main
// thread through wailsRunOnMain (docs/spec/hosts.md, main thread of the Wails host).
bool nativeWindowAfterPresentation(void *handle, uintptr_t callback) {
    return ON_MAIN(bool, nativeWindowAfterPresentationOnMain(handle, callback));
}
bool nativeWindowJoinView(void *window, uint64_t ticket, void *view, uintptr_t callback) {
    return ON_MAIN(bool, nativeWindowJoinViewOnMain(window, ticket, view, callback));
}
bool nativeWindowAfterSettled(void *handle, uintptr_t callback) {
    return ON_MAIN(bool, nativeWindowAfterSettledOnMain(handle, callback));
}
void nativeWindowPrepare(void *handle) {
    wailsRunOnMain(^{ nativeWindowPrepareOnMain(handle); });
}
bool nativeWindowConfigureMain(void *handle, bool dark) {
    return ON_MAIN(bool, nativeWindowConfigureMainOnMain(handle, dark));
}
bool nativeWindowSetMainWebview(void *handle) {
    return ON_MAIN(bool, nativeWindowSetMainWebviewOnMain(handle));
}
void nativeWebviewBounds(void *handle, double x, double y, double width, double height) {
    wailsRunOnMain(^{ nativeWebviewBoundsOnMain(handle, x, y, width, height); });
}
void *nativeWebviewCreate(void *handle, unsigned long long identifier, const char *name, const char *script,
    double x, double y, double width, double height, bool hidden, bool transparent, bool fillParent) {
    return ON_MAIN(void *, nativeWebviewCreateOnMain(handle, identifier, name, script, x, y, width, height, hidden,
        transparent, fillParent));
}
bool nativeWebviewNavigate(void *handle, const char *url) {
    return ON_MAIN(bool, nativeWebviewNavigateOnMain(handle, url));
}
void nativeWebviewHidden(void *handle, bool hidden) {
    wailsRunOnMain(^{ nativeWebviewHiddenOnMain(handle, hidden); });
}
void nativeWebviewBackground(void *handle, bool enabled) {
    wailsRunOnMain(^{ nativeWebviewBackgroundOnMain(handle, enabled); });
}
void nativeWebviewEval(void *handle, const char *script) {
    wailsRunOnMain(^{ nativeWebviewEvalOnMain(handle, script); });
}
void nativeWebviewClose(void *handle) {
    wailsRunOnMain(^{ nativeWebviewCloseOnMain(handle); });
}
void nativeWindowLayoutBegin(void *window, uint64_t ticket, uintptr_t callback) {
    wailsRunOnMain(^{ nativeWindowLayoutBeginOnMain(window, ticket, callback); });
}
void nativeWindowStartPage(void *window, uint64_t ticket, double height, uintptr_t callback) {
    wailsRunOnMain(^{ nativeWindowStartPageOnMain(window, ticket, height, callback); });
}
bool nativeWindowFullscreen(void *handle, bool on, uintptr_t callback) {
    return ON_MAIN(bool, nativeWindowFullscreenOnMain(handle, on, callback));
}
void *nativeWindowObserveResponder(void *handle, uintptr_t callback) {
    return ON_MAIN(void *, nativeWindowObserveResponderOnMain(handle, callback));
}
