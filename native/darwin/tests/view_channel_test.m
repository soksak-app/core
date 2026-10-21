// Checks the view channel of a view configuration (docs/spec/native-surfaces.md#view-surfaces): the configuration runs the
// channel script at document start, and the script's messages reach the host through the sok-view handler. A document
// region has neither the script nor the handler.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "support/temporary_folder.h"
#import "document_view.h"
#import "private/webkit.h"
#import "webview_geometry.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void until(NSString *what, BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    if (!done()) { fprintf(stderr, "FAIL: %s within 10 seconds\n", what.UTF8String); exit(1); }
}

static int viewEnded = 0;
static int unresponsiveCalls = 0;
static int responsiveCalls = 0;

static void viewResponsivenessReceiver(void *context, bool responsive) {
    (void)context;
    if (responsive) responsiveCalls++;
    else unresponsiveCalls++;
}

static void viewEndedReceiver(void *context) {
    (void)context;
    viewEnded++;
}

static NSDictionary *latest;
static NSMutableArray<NSDictionary *> *viewMessages;

static void changed(void *context, const char *text) {
    (void)context;
    latest = [[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:text length:strlen(text)] options:0 error:nil] retain];
}

static void viewMessage(void *context, const char *text) {
    (void)context;
    NSDictionary *value = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:text length:strlen(text)] options:0 error:nil];
    [viewMessages addObject:value ?: @{}];
}

static void writeFile(NSString *root, NSString *path, NSString *text) {
    NSString *file = [root stringByAppendingPathComponent:path];
    [[NSFileManager defaultManager] createDirectoryAtPath:file.stringByDeletingLastPathComponent
        withIntermediateDirectories:YES attributes:nil error:nil];
    [text writeToFile:file atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

// The channel script posts the ready message at document start through the handler of the view.
static NSString *const channelScript = @"window.webkit.messageHandlers['sok-view'].postMessage("
    "{ event: 'view.ready', plugin: 'probe', document: 'doc-1' });";

// The page reports whether the handler sok-view exists in its world, through the title. A page without any page-world handler
// has no window.webkit, which the script reads as no handler.
static NSString *const page = @"<!doctype html><meta charset=utf-8><title>loading</title>"
    "<script>const handlers = window.webkit && window.webkit.messageHandlers;"
    "document.title = 'handler ' + (handlers ? typeof handlers['sok-view'] : 'undefined');</script>";

// The theme script that the host adds to a view: the frozen theme value that the first page script reads from window.sokTheme.
static NSString *const themeScript = @"window.sokTheme = Object.freeze({\"scheme\":\"dark\",\"tokens\":{\"surface\":\"#101010\"}});";

// The page reports the scheme that its first script reads, through the title.
static NSString *const themePage = @"<!doctype html><meta charset=utf-8><title>loading</title>"
    "<script>const theme = window.sokTheme;"
    "document.title = 'theme ' + (theme ? theme.scheme : 'undefined');</script>";

static BOOL hasChannelScript(WKWebView *web) {
    for (WKUserScript *script in web.configuration.userContentController.userScripts) {
        if ([script.source isEqualToString:channelScript]) return YES;
    }
    return NO;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSString *temporary = temporaryFolder(@"soksak-view-channel-");
    NSString *folder = [temporary stringByAppendingPathComponent:@"plugin"];
    writeFile(folder, @"ui/page.html", page);

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    [window orderBack:nil];
    void *surface = sp_surface_create(main);
    webviewSetFrame(surface, 0, 0, 500, 400);
    webviewSetSurfaceHidden(surface, false);
    NSString *store = [temporary stringByAppendingPathComponent:@"store"];
    viewMessages = [NSMutableArray array];

    @autoreleasepool {
        void *view = sp_document_create(surface, store.fileSystemRepresentation, folder.fileSystemRepresentation, "probe",
            channelScript.UTF8String, changed, NULL);
        check(view != NULL, @"a view configuration is created with the channel script");
        sp_document_set_view_message(view, viewMessage, NULL);
        sp_document_place(view, 0, 0, 0, 0, true);
        check(hasChannelScript((WKWebView *)view), @"the view configuration runs the channel script at document start");
        latest = nil;
        check(sp_document_load(view, "sok://probe/ui/page.html"), @"the view loads the page of its plugin");
        until(@"the view page reports its handler", ^BOOL{ return [latest[@"title"] hasPrefix:@"handler"]; });
        check([latest[@"title"] isEqual:@"handler object"],
            [NSString stringWithFormat:@"the view page has the sok-view handler: %@", latest[@"title"]]);
        until(@"the ready message reaches the view receiver", ^BOOL{ return viewMessages.count > 0; });
        check([viewMessages[0][@"message"][@"event"] isEqual:@"view.ready"]
            && [viewMessages[0][@"message"][@"document"] isEqual:@"doc-1"],
            [NSString stringWithFormat:@"the view receives the ready message: %@", viewMessages[0]]);
        sp_document_set_view_ended(view, viewEndedReceiver, NULL);
        [(id<WKNavigationDelegate>)view webViewWebContentProcessDidTerminate:(WKWebView *)view];
        check(viewEnded == 1, [NSString stringWithFormat:@"the end of the view process calls the ended receiver once: %d", viewEnded]);
        // The responsiveness notices are delivered through the private navigation delegate selectors, invoked here as WebKit invokes them.
        SEL unresponsive = NSSelectorFromString(@"_webViewWebProcessDidBecomeUnresponsive:");
        SEL responsive = NSSelectorFromString(@"_webViewWebProcessDidBecomeResponsive:");
        sp_document_set_view_responsiveness(view, viewResponsivenessReceiver, NULL);
        check([(id)view respondsToSelector:unresponsive], @"the view responds to _webViewWebProcessDidBecomeUnresponsive:");
        check([(id)view respondsToSelector:responsive], @"the view responds to _webViewWebProcessDidBecomeResponsive:");
        if ([(id)view respondsToSelector:unresponsive]) [(id<SPNavigationDelegatePrivate>)view _webViewWebProcessDidBecomeUnresponsive:(WKWebView *)view];
        check(unresponsiveCalls == 1 && responsiveCalls == 0,
            [NSString stringWithFormat:@"the unresponsive notice calls the receiver once: %d unresponsive, %d responsive", unresponsiveCalls, responsiveCalls]);
        if ([(id)view respondsToSelector:responsive]) [(id<SPNavigationDelegatePrivate>)view _webViewWebProcessDidBecomeResponsive:(WKWebView *)view];
        check(responsiveCalls == 1 && unresponsiveCalls == 1,
            [NSString stringWithFormat:@"the responsive notice calls the receiver once: %d unresponsive, %d responsive", unresponsiveCalls, responsiveCalls]);
        check(viewEnded == 1, @"a responsiveness notice does not end the view process");
        sp_document_close(view);
    }

    @autoreleasepool {
        void *region = sp_document_create(surface, store.fileSystemRepresentation, folder.fileSystemRepresentation, "probe",
            NULL, changed, NULL);
        check(region != NULL, @"a document region is created without a channel script");
        check(!hasChannelScript((WKWebView *)region), @"the region configuration has no channel script");
        sp_document_place(region, 0, 0, 0, 0, true);
        latest = nil;
        check(sp_document_load(region, "sok://probe/ui/page.html"), @"the region loads the page of its plugin");
        until(@"the region page reports its handler", ^BOOL{ return [latest[@"title"] hasPrefix:@"handler"]; });
        check([latest[@"title"] isEqual:@"handler undefined"],
            [NSString stringWithFormat:@"the region page has no sok-view handler: %@", latest[@"title"]]);
        check(viewMessages.count == 1, @"the region sends no message to a view receiver");
        [(id<WKNavigationDelegate>)region webViewWebContentProcessDidTerminate:(WKWebView *)region];
        check(viewEnded == 1, @"the end of a document region does not call the view ended receiver");
        sp_document_close(region);
    }
    @autoreleasepool {
        writeFile(folder, @"ui/theme.html", themePage);
        void *themed = sp_document_create(surface, store.fileSystemRepresentation, folder.fileSystemRepresentation, "probe",
            channelScript.UTF8String, changed, NULL);
        check(themed != NULL, @"a themed view configuration is created");
        sp_document_set_view_message(themed, viewMessage, NULL);
        sp_document_add_user_script(themed, themeScript.UTF8String);
        sp_document_place(themed, 0, 0, 0, 0, true);
        latest = nil;
        check(sp_document_load(themed, "sok://probe/ui/theme.html"), @"the themed view loads its page");
        until(@"the theme page reports the scheme of its first script", ^BOOL{ return [latest[@"title"] hasPrefix:@"theme"]; });
        check([latest[@"title"] isEqual:@"theme dark"],
            [NSString stringWithFormat:@"the first page script reads the theme from window.sokTheme: %@", latest[@"title"]]);
        sp_document_close(themed);
    }
    @autoreleasepool {
        // A declared overlay of a view is drawn by the DOM of the view itself, so the overlay mask of the native plane must not
        // cut the view: the view is not a native region of the plane, and the input under the overlay goes to the view.
        void *overlayed = sp_document_create(surface, store.fileSystemRepresentation, folder.fileSystemRepresentation, "probe",
            channelScript.UTF8String, changed, NULL);
        check(overlayed != NULL, @"a view configuration is created for the overlay check");
        sp_document_place(overlayed, 0, 0, 0, 0, true);
        WKWebView *overlayedView = (WKWebView *)overlayed;
        NSView *plane = (NSView *)sp_surface_native_plane(surface);
        check(![overlayedView isDescendantOf:plane], @"the view web view is not inside the native plane of its surface");
        double overlay[5] = {0, 0, 0, 0, 1};
        webviewSetSurfaceOverlays(surface, overlay, 1);
        NSPoint point = [overlayedView convertPoint:NSMakePoint(20, 20) toView:nil];
        NSView *hit = [window.contentView hitTest:point];
        check(hit == overlayedView || [hit isDescendantOf:overlayedView],
            @"a visible overlay of a view leaves the input under it with the view");
        webviewSetSurfaceOverlays(surface, NULL, 0);
        sp_document_close(overlayed);
    }
    sp_surface_close(surface);
    [window close];
    if (failures) fprintf(stderr, "%d failures\n", failures);
    return failures ? 1 : 0;
}}
