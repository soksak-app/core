// Checks that the closed window, its webviews, and all native objects that the shared library attached to the window
// and webviews are released. In the order in which the host does it for a project window, attaches main webview
// registration, first display wait, input registration, file drop, occlusion observation, logical surface, attached
// surface webview, modal webview, document region, drawing region, layout transaction, and display wait. Then only
// the handles owned by the host (drawing region, document region, attached surface webview, logical surface) are
// closed with the close functions of the library. The main webview and the modal webview are only removed from the
// view hierarchy and released, as the framework that created the window does, and their input registration is not
// released. A webview that is not released does not end the web content process. The check does not activate the
// application.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import "support/temporary_folder.h"
#import "document_view.h"
#import "image_region.h"
#import "surface_layout.h"
#import "webview_geometry.h"
#import "webview_input.h"
#import "window_facts.h"
#import "window_reveal.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void until(NSString *what, BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        @autoreleasepool {
            [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
        }
    }
    if (!done()) { fprintf(stderr, "FAIL: %s within 10 seconds\n", what.UTF8String); exit(1); }
}

// Manual reference counting cannot use __weak, so the check uses the weak reference slot of the runtime. The slot
// becomes nil when the object is released.
enum { kTracked = 32 };
static id weakSlots[kTracked];
static const char *weakNames[kTracked];
static int trackedCount;

static void track(const char *name, id object) {
    if (!object) { check(NO, [NSString stringWithFormat:@"%s exists before the window closes", name]); return; }
    weakNames[trackedCount] = name;
    objc_storeWeak(&weakSlots[trackedCount], object);
    trackedCount++;
}

// objc_loadWeak extends the lifetime by putting the object in the autorelease pool, so the check drains the pool
// after every read.
static BOOL released(int index) {
    BOOL alive;
    @autoreleasepool { alive = objc_loadWeak(&weakSlots[index]) != nil; }
    return !alive;
}

static BOOL allReleased(void) {
    for (int i = 0; i < trackedCount; i++) {
        if (!released(i)) return NO;
    }
    return YES;
}

static NSView *subviewOfClass(NSView *parent, NSString *name) {
    for (NSView *child in parent.subviews) {
        if ([NSStringFromClass(child.class) isEqualToString:name]) return child;
    }
    return nil;
}

@interface SPNavigation : NSObject <WKNavigationDelegate>
@property BOOL finished;
@end

@implementation SPNavigation
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation { self.finished = YES; }
@end

static void documentChanged(void *context, const char *state) {}
static void regionEvent(void *context, const char *json) {}
static void fileDropped(void *context, const char *json) {}

// The receiver that the drop view dropped. The host releases the receiver here.
static NSMutableArray<NSString *> *releasedReceivers;
static void fileDropReleased(void *context) { [releasedReceivers addObject:(NSString *)context]; }

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSString *store = temporaryFolder(@"soksak-window-release-");

    NSWindow *window;
    void *surface;
    void *document;
    void *region;
    WKWebView *attached;
    @autoreleasepool {
        window = [[NSWindow alloc] initWithContentRect:NSMakeRect(60, 60, 600, 400)
            styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
        window.releasedWhenClosed = NO;
        window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 600, 400)] autorelease];
        WKWebView *main = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 600, 400)] autorelease];
        [window.contentView addSubview:main];
        SPNavigation *navigation = [[SPNavigation new] autorelease];
        main.navigationDelegate = navigation;
        check(sp_window_set_main_webview(window, main), @"the main webview is registered");
        char *error = NULL;
        check(sp_window_reveal_after_load(window, &error), @"the window waits for the first page");
        free(error);
        check(webviewInputRegister(main), @"the main webview registers for input");
        [main loadHTMLString:@"<!doctype html><body>main</body>" baseURL:nil];
        [window orderFrontRegardless];
        until(@"the main page did not load", ^BOOL { return navigation.finished; });
        until(@"the window was not revealed after the first page", ^BOOL { return window.alphaValue == 1; });
        releasedReceivers = [[NSMutableArray alloc] init];
        check(sp_window_file_drop(main, fileDropped, fileDropReleased, @"first"), @"the window receives file drops");
        check(sp_window_file_drop(main, fileDropped, fileDropReleased, @"second"), @"the window replaces its file drop receiver");
        check([releasedReceivers isEqualToArray:@[@"first"]],
            [NSString stringWithFormat:@"a replaced file drop receiver is released once (released %@)", releasedReceivers]);
        // Objects that the block of the occlusion observation captured are released only when the observation ends.
        NSObject *occlusionCapture = [[NSObject new] autorelease];
        check(sp_window_observe_occlusion(window, ^{ [occlusionCapture self]; }), @"the window occlusion is observed");

        surface = sp_surface_create(main);
        check(surface != NULL, @"a logical surface is created");
        webviewSetFrame(surface, 10, 10, 400, 300);
        webviewSetSurfaceHidden(surface, false);
        document = sp_document_create(surface, store.fileSystemRepresentation, NULL, NULL, NULL, documentChanged, NULL);
        check(document != NULL, @"a document region is created");
        sp_document_place(document, 10, 10, 10, 10, true);
        region = sp_region_create(surface, "region", regionEvent, NULL);
        check(region != NULL, @"an image region is created");
        sp_region_place(region, 20, 20, 20, 20, true);

        attached = [[WKWebView alloc] initWithFrame:NSMakeRect(20, 20, 200, 120)];
        [window.contentView addSubview:attached positioned:NSWindowAbove relativeTo:nil];
        check(webviewInputRegister(attached) && webviewIgnorePageFocus(attached), @"an attached surface webview registers for input");
        webviewAttachSurface(attached, main);
        // A webview that fills the window, like a modal. It registers input but is not attached to a surface.
        WKWebView *modal = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 600, 400)] autorelease];
        [window.contentView addSubview:modal positioned:NSWindowAbove relativeTo:nil];
        check(webviewInputRegister(modal) && webviewIgnorePageFocus(modal), @"a modal webview registers for input");

        __block BOOL ready = NO;
        surfaceLayoutBegin(window, 1, ^(int allowed) { ready = allowed != 0; });
        check(ready, @"the layout transaction opens");
        check(surfaceLayoutCommit(window, 1), @"the layout transaction commits");
        __block BOOL settled = NO;
        surfaceLayoutAfterSettled(main, ^(double displayed, const char *failure) { settled = YES; });
        until(@"the main page did not settle", ^BOOL { return settled; });

        NSView *composition = main.superview;
        NSView *coordinates = subviewOfClass(composition, @"SPSurfaceCoordinates");
        track("NSWindow", window);
        track("main WKWebView", main);
        track("main WKUserContentController", main.configuration.userContentController);
        track("SPWindowComposition", composition);
        track("SPSurfaceCoordinates", coordinates);
        track("SPFileDropView", subviewOfClass(composition, @"SPFileDropView"));
        track("occlusion observation block capture", occlusionCapture);
        track("logical SPSurfaceHost", (id)surface);
        track("logical SPSurfaceNativePlane", (id)sp_surface_native_plane(surface));
        track("SPDocumentView", (id)document);
        track("document WKUserContentController", ((WKWebView *)document).configuration.userContentController);
        track("SPImageRegion", (id)region);
        track("attached surface WKWebView", attached);
        track("attached surface WKUserContentController", attached.configuration.userContentController);
        track("attached SPSurfaceHost", attached.superview);
        track("attached SPSurfaceNativePlane", (id)webviewSurfaceNativePlane(attached));
        track("modal WKWebView", modal);
        track("modal WKUserContentController", modal.configuration.userContentController);
        [modal removeFromSuperview];
    }

    // Cleanup that the host does when it closes a window: closes the regions and documents, attached webviews, and
    // surfaces, cancels the layout, and then closes the window.
    @autoreleasepool {
        sp_region_close(region);
        sp_document_close(document);
        webviewInputUnregister(attached);
        webviewDetachSurface(attached);
        [attached removeFromSuperview];
        [attached release];
        sp_surface_close(surface);
        surfaceLayoutCancel(window);
        [window close];
        [window release];
    }
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!allReleased() && deadline.timeIntervalSinceNow > 0) {
        @autoreleasepool {
            [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
        }
    }
    check([releasedReceivers isEqualToArray:@[@"first", @"second"]],
        [NSString stringWithFormat:@"the closed window releases its file drop receiver once (released %@)", releasedReceivers]);
    for (int i = 0; i < trackedCount; i++) {
        check(released(i), [NSString stringWithFormat:@"the closed window releases its %s", weakNames[i]]);
    }
    check(!NSApp.isActive, @"application stays inactive");
    return failures ? 1 : 0;
}}
