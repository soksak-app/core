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
#import "private/webkit.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Waits while it takes app events and handles them. This check activates the app, and the activation and inspector
// window events arrive as events.
static void until(BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny
            untilDate:[NSDate dateWithTimeIntervalSinceNow:0.01] inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event) [NSApp sendEvent:event];
    }
}

// The surface frame in window coordinates.
static NSRect frameOf(WKWebView *view) {
    double rect[4] = {0, 0, 0, 0};
    webviewGetFrame(view, rect);
    return NSMakeRect(rect[0], rect[1], rect[2], rect[3]);
}

static NSString *describe(NSRect rect) {
    return [NSString stringWithFormat:@"%.0f,%.0f %.0fx%.0f", rect.origin.x, rect.origin.y, rect.size.width, rect.size.height];
}

// tests/support/no_activation.m: this check activates the app in make test-activation.
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
    WKWebView *surface = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 600, 450)
        configuration:[[configuration copy] autorelease]] autorelease];
    [window.contentView addSubview:surface];
    [main loadHTMLString:@"<body style='margin:0'>main</body>" baseURL:nil];
    [surface loadHTMLString:@"<body style='margin:0'>surface</body>" baseURL:nil];
    [window makeKeyAndOrderFront:nil];
    until(^BOOL { return !main.loading && !surface.loading; });
    check(sp_surface_create(main) != NULL,
        @"the main webview creates the composition before a surface webview is attached");
    webviewAttachSurface(surface, main);
    webviewSetFrame(surface, 100, 50, 600, 450);
    NSRect placed = frameOf(surface);
    check(NSEqualRects(placed, NSMakeRect(100, 50, 600, 450)),
        [NSString stringWithFormat:@"the surface starts at its place (%@)", describe(placed)]);

    surface.inspectable = YES;
    id<SPInspector> inspector = surface._inspector;
    check(inspector != nil, @"the surface webview has an inspector");
    [NSApp activateIgnoringOtherApps:YES];
    until(^BOOL { return NSApp.isActive && window.isKeyWindow; });
    check(NSApp.isActive && window.isKeyWindow, @"the test window becomes the key window of the active application");
    [inspector connect];
    until(^BOOL { return inspector.connected; });
    [inspector show];
    until(^BOOL { return inspector.visible; });
    check(inspector.visible, @"the inspector opens");

    // Attaches the inspector to the window. A user does this with the dock button of the inspector.
    [inspector attach];
    until(^BOOL { return inspector.inspectorWebView.window == window; });
    check(inspector.inspectorWebView.window == window, [NSString stringWithFormat:
        @"the inspector attaches to the window (inspector window %@, test window %@, app active %d, key %d)",
        inspector.inspectorWebView.window, window, NSApp.isActive, window.isKeyWindow]);
    NSRect attached = frameOf(surface);
    check(NSEqualRects(attached, placed),
        [NSString stringWithFormat:@"the attached inspector leaves the surface at its place (%@)", describe(attached)]);

    [inspector close];
    until(^BOOL { return !inspector.visible; });
    NSRect closed = frameOf(surface);
    check(NSEqualRects(closed, placed),
        [NSString stringWithFormat:@"closing the inspector leaves the surface at its place (%@)", describe(closed)]);
    [window close];
    [window release];
    return failures ? 1 : 0;
}}
