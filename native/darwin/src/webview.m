#include "host_api_webview.h"
#include "host_api_window.h"
#include "host_api_layout.h"
#import <Block.h>
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "application_log.h"
#import "webview_input.h"
#import "surface_layout.h"
#import "webview_geometry.h"
#import "window_fullscreen.h"
#import "input_virtual.h"
#import "window_facts.h"
#import "webview_dialogs.h"
#import "main_thread.h"
#import "view_presentation_fault.h"
#include <notify.h>
#include <stdlib.h>
#include <string.h>
#import "private/webkit.h"
#include "host_callbacks.h"


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
    hostRunOnWorker(^{ sp_host_callback_native_message(identifier, body); });
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
    hostRunOnWorker(^{ sp_host_callback_native_committed(identifier); });
    [self evaluateJavaScript:self.backgroundEnabled ? @"window.__soksakBackground = true" : @"window.__soksakBackground = false" completionHandler:^(id result, NSError *error) {
        if (error) sp_log_error("surface background", error.localizedDescription.UTF8String);
    }];
}
// The WebContent process of a modal ended; the host records it as it records the page process of a window.
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)view {
    sp_webview_log_process_end((__bridge void *)view, "surface webview");
    unsigned long long identifier = self.messageIdentifier;
    hostRunOnWorker(^{ sp_host_callback_native_terminated(identifier); });
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

static bool nativeWindowAfterPresentationOnMain(void *handle, uintptr_t callback) {
    WKWebView *view = sp_window_main_webview(handle);
    if (!view) return false;
    surfaceLayoutAfterPresentation(view, ^{ hostRunOnWorker(^{ sp_host_callback_native_presentation_done(callback); }); });
    return true;
}

// nativeWindowJoinView joins the view webview to the layout transaction of window. callback runs once: with no reason when the
// view presents, or with the reason of an end that the host did not ask for (docs/spec/native-surfaces.md#layout-transaction).
static bool nativeWindowJoinViewOnMain(void *window, uint64_t ticket, void *view, uintptr_t callback) {
    return surfaceLayoutJoinViewEnds(window, ticket, view,
        ^{ hostRunOnWorker(^{ sp_host_callback_native_join_ended(callback, NULL); }); },
        ^(const char *reason) {
            char *copied = strdup(reason);
            hostRunOnWorker(^{
                sp_host_callback_native_join_ended(callback, copied);
                free(copied);
            });
        });
}

// The block crosses main-thread steps in the hands of Go, so it is a copy that nativeWindowAfterSettled releases.
static void *nativeWindowMainPresentationOnMain(void *handle) {
    WKWebView *view = sp_window_main_webview(handle);
    return view ? Block_copy(surfaceLayoutMainPresentation(view)) : NULL;
}

static void nativeWindowAfterSettledOnMain(void *handle, void *present, uintptr_t callback) {
    surfaceLayoutAfterSettled(handle, (surfaceLayoutPresent)present, ^(double displayed, const char *error) {
        char *copy = error ? strdup(error) : NULL;
        hostRunOnWorker(^{ sp_host_callback_native_settled_done(callback, displayed, copy); });
    });
    Block_release(present);
}


// Holds the Go function of a presentation block: the block retains this object, so the function ends with the last copy of the block.
@interface SPFunctionPresentation : NSObject
@property uintptr_t present;
@end

@implementation SPFunctionPresentation
- (void)dealloc {
    uintptr_t present = self.present;
    hostRunOnWorker(^{ sp_host_callback_native_settled_present_ended(present); });
    [super dealloc];
}
@end

// The wait copies its block and asks it from the main thread, so the block hands the Go function a copy of its completion.
static void *nativeFunctionPresentationOnMain(uintptr_t present) {
    SPFunctionPresentation *function = [[SPFunctionPresentation alloc] init];
    function.present = present;
    surfaceLayoutPresent block = ^(void (^presented)(const char *error)) {
        void *kept = Block_copy(presented);
        uintptr_t value = function.present;
        hostRunOnWorker(^{ sp_host_callback_native_settled_present(value, kept); });
    };
    void *copy = Block_copy(block);
    [function release];
    return copy;
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
    return root && sp_window_set_main_webview(window, root) != NULL;
}

static void nativeWebviewBoundsOnMain(void *handle, double x, double y, double width, double height) {
    webviewSetFrame(handle, x, y, width, height);
}

static void *nativeWebviewCreateOnMain(void *handle, unsigned long long identifier, const char *name, const char *script,
    double x, double y, double width, double height, bool hidden, bool transparent) {
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
    view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    if (transparent) {
        view.underPageBackgroundColor = NSColor.clearColor;
        @try {
            [view setValue:@NO forKey:@"drawsBackground"];
            if ([[view valueForKey:@"drawsBackground"] boolValue]) { [view release]; return NULL; }
        // default: WebKit throws an exception for an unknown key, and the NULL of this function is reported by the caller as an error that the web view could not be created.
        } @catch (NSException *error) { [view release]; return NULL; }
    }
    // The page of a modal does not move the keyboard focus of the window. The main page does.
    if (!webviewInputRegister(view) || !webviewIgnorePageFocus(view)) { [view release]; return NULL; }
    // The modal renders while the window is occluded: it is raised only after it renders, and a still capture of a covered
    // window shows it.
    if (!sp_webview_render_occluded(view, true)) { [view release]; return NULL; }
    // The modal is placed directly in the window, above the main web view and below the existing modals, and fills
    // the window. It is kept hidden here and raised when it finishes rendering.
    [window.contentView addSubview:view positioned:NSWindowAbove relativeTo:root];
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
    // A view out of its window never presents, so its close ends each join of it in this turn.
    surfaceLayoutViewClosed(view);
    webviewInputUnregister(view);
    [view stopLoading];
    [view.configuration.userContentController removeScriptMessageHandlerForName:@"soksak"];
    [view removeFromSuperview];
    [view release];
}

static void nativeWindowLayoutBeginOnMain(void *window, uint64_t ticket, uintptr_t callback) {
    surfaceLayoutBegin(window, ticket, ^(int allowed) { hostRunOnWorker(^{ sp_host_callback_native_layout_ready(callback, allowed); }); });
}

static void nativeWindowStartPageOnMain(void *window, uint64_t ticket, double height, uintptr_t callback) {
    surfaceLayoutStartPage(window, ticket, height, ^(const char *failure) { hostRunOnWorker(^{ sp_host_callback_native_start_page_ready(callback, (char *)failure); }); });
}

static bool nativeWindowFullscreenOnMain(void *handle, bool on, uintptr_t callback) {
    // The message of a result is a static string, so it outlives the turn of the worker.
    return sp_window_fullscreen(handle, on, ^(int result, const char *message) {
        hostRunOnWorker(^{ sp_host_callback_native_fullscreen_done(callback, result, (char *)message); });
    });
}

static void *nativeWindowObserveResponderOnMain(void *handle, uintptr_t callback) {
    return sp_window_observe_responder(handle, ^{ hostRunOnWorker(^{ sp_host_callback_native_responder_changed(callback); }); });
}

static void *nativeWindowObserveCursorOnMain(void *handle, uintptr_t callback) {
    return sp_input_virtual_observe_cursor(handle, ^{ hostRunOnWorker(^{ sp_host_callback_native_cursor_changed(callback); }); });
}

static void *nativeWindowObserveSheetOnMain(void *handle, uintptr_t callback) {
    return sp_window_observe_sheet(handle, ^{ hostRunOnWorker(^{ sp_host_callback_native_sheet_changed(callback); }); });
}

// The functions that Go code calls. Go code runs on the worker of the framework, and each function runs its body on the main
// thread through hostRunOnMain (docs/spec/hosts.md, main thread of the Wails host).
bool nativeWindowAfterPresentation(uintptr_t handle, uintptr_t callback) {
    return ON_MAIN(bool, nativeWindowAfterPresentationOnMain((void *)handle, callback));
}
bool nativeWindowJoinView(uintptr_t window, uint64_t ticket, void *view, uintptr_t callback) {
    return ON_MAIN(bool, nativeWindowJoinViewOnMain((void *)window, ticket, view, callback));
}
// The fault point SOKSAK_FAULT_VIEW_PRESENTATION=hold of the presentation waits of web views (docs/operations/examples.md#test-kinds): the
// callback of a wait is delivered only after the real presentation update and a release that came after the wait began. The release
// is the Darwin notification of the release name of this process (view_presentation_fault.h), so a first paint that the system does not delay on demand arrives when
// the check releases it, and a release that comes before the update is not lost. The counts and the held callbacks are read and
// changed on the main thread only.
static NSMutableArray<void (^)(void)> *heldPresentations;
static NSUInteger presentationReleases;

static bool presentationHeld(void) {
    const char *fault = getenv("SOKSAK_FAULT_VIEW_PRESENTATION");
    if (fault == NULL || fault[0] == '\0') return false;
    if (strcmp(fault, "hold") != 0) {
        sp_log_error("view presentation fault", "SOKSAK_FAULT_VIEW_PRESENTATION names no fault");
        return false;
    }
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        heldPresentations = [[NSMutableArray alloc] init];
        int token = 0;
        char name[64];
        sp_view_presentation_fault_release_name(getpid(), name, sizeof name);
        uint32_t status = notify_register_dispatch(name, &token, dispatch_get_main_queue(), ^(int unused) {
            (void)unused;
            presentationReleases++;
            NSArray<void (^)(void)> *released = [[heldPresentations copy] autorelease];
            [heldPresentations removeAllObjects];
            for (void (^deliver)(void) in released) deliver();
        });
        if (status != NOTIFY_STATUS_OK) sp_log_error("view presentation fault", "the release notification could not be registered");
    });
    return true;
}

// Runs callback after the web view presented its next frame. The host waits for the first frame of a revealed modal web view
// with it (docs/spec/exposure.md, host.window.presented).
static bool nativeWebviewAfterPresentationOnMain(void *handle, uintptr_t callback) {
    WKWebView *target = (WKWebView *)handle;
    if (!target) return false;
    bool held = presentationHeld();
    NSUInteger releasesAtStart = presentationReleases;
    [target _doAfterNextPresentationUpdate:^{
        void (^deliver)(void) = ^{ hostRunOnWorker(^{ sp_host_callback_native_presentation_done(callback); }); };
        if (held && presentationReleases == releasesAtStart) [heldPresentations addObject:[[deliver copy] autorelease]];
        else deliver();
    }];
    return true;
}
bool nativeWebviewAfterPresentation(void *view, uintptr_t callback) {
    return ON_MAIN(bool, nativeWebviewAfterPresentationOnMain(view, callback));
}
void *nativeWindowMainPresentation(uintptr_t handle) {
    return ON_MAIN(void *, nativeWindowMainPresentationOnMain((void *)handle));
}
void nativeWindowAfterSettled(uintptr_t handle, void *present, uintptr_t callback) {
    hostRunOnMain(^{ nativeWindowAfterSettledOnMain((void *)handle, present, callback); });
}
void *nativeFunctionPresentation(uintptr_t present) {
    return ON_MAIN(void *, nativeFunctionPresentationOnMain(present));
}
void nativeLayoutObserve(void) {
    hostRunOnMain(^{
        surfaceLayoutObserve(^(void *window) { hostRunOnWorker(^{ sp_host_callback_native_layout_started((uintptr_t)window); }); },
            ^(void *window) { hostRunOnWorker(^{ sp_host_callback_native_layout_ended((uintptr_t)window); }); });
    });
}
void nativeWindowPrepare(uintptr_t handle) {
    hostRunOnMain(^{ nativeWindowPrepareOnMain((void *)handle); });
}
bool nativeWindowConfigureMain(uintptr_t handle, bool dark) {
    return ON_MAIN(bool, nativeWindowConfigureMainOnMain((void *)handle, dark));
}
bool nativeWindowSetMainWebview(uintptr_t handle) {
    return ON_MAIN(bool, nativeWindowSetMainWebviewOnMain((void *)handle));
}
void nativeWebviewBounds(void *handle, double x, double y, double width, double height) {
    hostRunOnMain(^{ nativeWebviewBoundsOnMain(handle, x, y, width, height); });
}
void *nativeWebviewCreate(uintptr_t handle, unsigned long long identifier, const char *name, const char *script,
    double x, double y, double width, double height, bool hidden, bool transparent) {
    return ON_MAIN(void *, nativeWebviewCreateOnMain((void *)handle, identifier, name, script, x, y, width, height, hidden,
        transparent));
}
bool nativeWebviewNavigate(void *handle, const char *url) {
    return ON_MAIN(bool, nativeWebviewNavigateOnMain(handle, url));
}
void nativeWebviewHidden(void *handle, bool hidden) {
    hostRunOnMain(^{ nativeWebviewHiddenOnMain(handle, hidden); });
}
void nativeWebviewBackground(void *handle, bool enabled) {
    hostRunOnMain(^{ nativeWebviewBackgroundOnMain(handle, enabled); });
}
void nativeWebviewEval(void *handle, const char *script) {
    hostRunOnMain(^{ nativeWebviewEvalOnMain(handle, script); });
}
void nativeWebviewClose(void *handle) {
    hostRunOnMain(^{ nativeWebviewCloseOnMain(handle); });
}
void nativeWindowLayoutBegin(uintptr_t window, uint64_t ticket, uintptr_t callback) {
    hostRunOnMain(^{ nativeWindowLayoutBeginOnMain((void *)window, ticket, callback); });
}
void nativeWindowStartPage(uintptr_t window, uint64_t ticket, double height, uintptr_t callback) {
    hostRunOnMain(^{ nativeWindowStartPageOnMain((void *)window, ticket, height, callback); });
}
bool nativeWindowFullscreen(uintptr_t handle, bool on, uintptr_t callback) {
    return ON_MAIN(bool, nativeWindowFullscreenOnMain((void *)handle, on, callback));
}
void *nativeWindowObserveResponder(uintptr_t handle, uintptr_t callback) {
    return ON_MAIN(void *, nativeWindowObserveResponderOnMain((void *)handle, callback));
}
void *nativeWindowObserveCursor(uintptr_t handle, uintptr_t callback) {
    return ON_MAIN(void *, nativeWindowObserveCursorOnMain((void *)handle, callback));
}
void *nativeWindowObserveSheet(uintptr_t handle, uintptr_t callback) {
    return ON_MAIN(void *, nativeWindowObserveSheetOnMain((void *)handle, callback));
}
// The JSON of a request is copied for the worker, which reads it after the main thread went on.
void *nativeWindowHoldDialogs(uintptr_t handle, uintptr_t callback) {
    return ON_MAIN(void *, sp_window_hold_dialogs((void *)handle, ^(uint64_t request, const char *json) {
        char *copied = strdup(json);
        hostRunOnWorker(^{ sp_host_callback_native_dialog_requested(callback, request, copied); });
        free(copied);
    }));
}
void main_sp_window_release_dialogs(void *hold) {
    hostRunOnMain(^{ sp_window_release_dialogs(hold); });
}
void nativeDialogAnswer(unsigned long long request, char **paths, size_t count, bool cancel, uintptr_t callback) {
    hostRunOnMain(^{
        sp_dialog_answer(request, (const char *const *)paths, count, cancel, ^(const char *error) {
            char *copied = error ? strdup(error) : NULL;
            hostRunOnWorker(^{ sp_host_callback_native_dialog_answered(callback, copied); });
            free(copied);
        });
    });
}
