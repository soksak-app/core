#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "webview_darwin.h"
#import "webview_input.h"
#import "surface_layout.h"
#import "webview_geometry.h"

extern void nativeMessage(unsigned long long identifier, char *message);

@interface SPNativeBridge : NSObject <WKScriptMessageHandler>
@property unsigned long long identifier;
@property(copy) NSString *scheme;
@property(copy) NSString *host;
@end

@implementation SPNativeBridge
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    // Only the application's own main-frame documents may call the host.
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
@property(copy) NSURL *baseURL;
@property BOOL backgroundEnabled;
@end

@implementation SPNativeWebview
- (void)webView:(WKWebView *)view didCommitNavigation:(WKNavigation *)navigation {
    [self evaluateJavaScript:self.backgroundEnabled ? @"window.__soksakBackground = true" : @"window.__soksakBackground = false" completionHandler:^(id result, NSError *error) {
        if (error) NSLog(@"surface background failed: %@", error);
    }];
}
- (void)dealloc {
    [_baseURL release];
    [super dealloc];
}
@end

// Discover the framework's main webview through the public NSView hierarchy.
// The extra views are ours, so they cannot become the source configuration.
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
    WKWebView *view = mainWebview([(NSWindow *)handle contentView]);
    if (!view) return false;
    surfaceLayoutAfterPresentation(view, ^{ nativePresentationDone(callback); });
    return true;
}

void nativeWindowPrepare(void *handle) {
    NSWindow *window = (NSWindow *)handle;
    WKWebView *root = mainWebview(window.contentView);
    if (!root) return;
    // Wails beta.16 initially creates content one point smaller than its WKWebView.
    // Set zero autoresizing margins and preserve the requested page size using
    // public layout APIs. Once corrected, future resizes keep the two identical.
    if (!NSEqualSizes(root.frame.size, window.contentView.bounds.size)) {
        NSSize requested = root.frame.size;
        root.frame = root.superview.bounds;
        [window setContentSize:requested];
    }
}

void nativeWebviewBounds(void *handle, double x, double y, double width, double height) {
    webviewSetFrame(handle, x, y, width, height);
}

void *nativeWebviewCreate(void *handle, unsigned long long identifier, const char *script,
    double x, double y, double width, double height, bool hidden, bool transparent, bool fillParent) {
    NSWindow *window = (NSWindow *)handle;
    WKWebView *root = mainWebview(window.contentView);
    if (!root || !root.URL || !webviewInputRegister(root)) return NULL;

    // The copied configuration retains the framework's public WKURLSchemeHandler,
    // process pool and data store. Replace the script controller with our own:
    // extra documents must not send Wails runtime-ready messages for the main page.
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
        } @catch (NSException *error) { [view release]; return NULL; }
    }
    if (!webviewInputRegister(view)) { [view release]; return NULL; }
    // New surfaces belong above main and below existing overlays. A modal is
    // raised when it is ready, while still hidden here.
    [window.contentView addSubview:view positioned:NSWindowAbove relativeTo:root];
    if (!transparent) webviewAttachSurface(view, root);
    nativeWebviewBounds(view, x, y, width, height);
    return view; // Go owns this retain until nativeWebviewClose.
}

bool nativeWebviewNavigate(void *handle, const char *url) {
    SPNativeWebview *view = (SPNativeWebview *)handle;
    NSURL *target = [NSURL URLWithString:[NSString stringWithUTF8String:url] relativeToURL:view.baseURL];
    if (!target) return false;
    [view loadRequest:[NSURLRequest requestWithURL:target.absoluteURL]];
    return true;
}

void nativeWebviewHidden(void *handle, bool hidden) { [(WKWebView *)handle setHidden:hidden]; }
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
    [view removeFromSuperview];
    [view release];
}

extern void nativeLayoutReady(uintptr_t callback, bool allowed);
void nativeWindowLayoutBegin(void *window, uint64_t ticket, uintptr_t callback) {
    surfaceLayoutBegin(window, ticket, ^(int allowed) { nativeLayoutReady(callback, allowed); });
}
