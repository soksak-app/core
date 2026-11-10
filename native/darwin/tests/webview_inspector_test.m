// Checks that opening the web inspector of a surface webview leaves the surface at the position the host set.
// Attaching the inspector to the window makes WebKit move the inspected view into the remaining space of the window
// and not move it back when the inspector closes. The page sets the position of the surface, so that move breaks the
// display.
//
// The inspector is opened through the private WKWebView member `_inspector` (check only, see
// docs/operations/private-native-apis.md). The inspector window opens, so the check activates the application.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "webview_geometry.h"
#import "window_facts.h"
#import "private/webkit.h"
#import "support/surface_view.h"
#import "support/event_wait.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// The surface frame in window coordinates.
static NSRect frameOf(void *surface) {
    double rect[4] = {0, 0, 0, 0};
    webviewGetFrame(surface, rect);
    return NSMakeRect(rect[0], rect[1], rect[2], rect[3]);
}

static NSString *describe(NSRect rect) {
    return [NSString stringWithFormat:@"%.0f,%.0f %.0fx%.0f", rect.origin.x, rect.origin.y, rect.size.width, rect.size.height];
}

// tests/support/no_activation.m: this check activates the app in make test-app-activation.
void sp_test_declare_activation(void);

int main(void) { @autoreleasepool {
    sp_test_declare_activation();
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    [NSApp finishLaunching];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(200, 200, 1000, 700)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    // The inspector opens only in a page with developer tools enabled. The debug build of the application also
    // enables this value.
    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration new] autorelease];
    [configuration.preferences setValue:@YES forKey:@"developerExtrasEnabled"];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds
        configuration:configuration] autorelease];
    [window.contentView addSubview:main];
    WKWebView *view = [[[WKWebView alloc] initWithFrame:NSZeroRect
        configuration:[[configuration copy] autorelease]] autorelease];
    [main loadHTMLString:@"<body style='margin:0'>main</body>" baseURL:nil];
    [view loadHTMLString:@"<body style='margin:0'>surface</body>" baseURL:nil];
    [window makeKeyAndOrderFront:nil];
    eventWait(@"both documents finish loading", ^BOOL { return !main.loading && !view.loading; });
    void *surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    check(surface != NULL, @"the main webview creates the surface");
    check(SPPlaceSurfaceView(surface, view), @"the surface webview is placed in the surface");
    webviewSetFrame(surface, 100, 50, 600, 450);
    webviewSetSurfaceHidden(surface, false);
    NSRect placed = frameOf(surface);
    check(NSEqualRects(placed, NSMakeRect(100, 50, 600, 450)),
        [NSString stringWithFormat:@"the surface starts at its place (%@)", describe(placed)]);

    view.inspectable = YES;
    id<SPInspector> inspector = view._inspector;
    check(inspector != nil, @"the surface webview has an inspector");
    [NSApp activateIgnoringOtherApps:YES];
    eventWait(@"the application becomes active with the test window as key window", ^BOOL {
        return NSApp.isActive && window.isKeyWindow;
    });
    check(NSApp.isActive && window.isKeyWindow, @"the test window becomes the key window of the active application");
    [inspector connect];
    eventWait(@"the inspector connects", ^BOOL { return inspector.connected; });
    [inspector show];
    eventWait(@"the inspector becomes visible", ^BOOL { return inspector.visible; });
    check(inspector.visible, @"the inspector opens");

    // Attaches the inspector to the window. A user does this with the dock button of the inspector.
    [inspector attach];
    eventWait(@"the inspector attaches to the test window", ^BOOL { return inspector.inspectorWebView.window == window; });
    check(inspector.inspectorWebView.window == window, [NSString stringWithFormat:
        @"the inspector attaches to the window (inspector window %@, test window %@, app active %d, key %d)",
        inspector.inspectorWebView.window, window, NSApp.isActive, window.isKeyWindow]);
    NSRect attached = frameOf(surface);
    check(NSEqualRects(attached, placed),
        [NSString stringWithFormat:@"the attached inspector leaves the surface at its place (%@)", describe(attached)]);

    [inspector close];
    eventWait(@"the inspector closes", ^BOOL { return !inspector.visible; });
    NSRect closed = frameOf(surface);
    check(NSEqualRects(closed, placed),
        [NSString stringWithFormat:@"closing the inspector leaves the surface at its place (%@)", describe(closed)]);
    sp_surface_unplace_view(view);
    [view removeFromSuperview];
    sp_surface_close(surface);
    [window close];
    [window release];
    return failures ? 1 : 0;
}}
