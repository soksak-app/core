// Checks that the registered main webview and the attached surface webviews keep running animation frames without
// hiding the document even when the window is occluded. Layout display and project commands wait for the next display
// of the main webview, and capture and drawing confirmation of a surface wait for the rendering of the surface, so
// they must finish in an occluded window too. The check does not activate the application.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "window_facts.h"
#import "webview_geometry.h"
#import "private/webkit.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Occlusion state changes of the window server arrive as AppKit events. Application activation events are not taken.
static void pump(void) {
    NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAppKitDefined untilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]
        inMode:NSDefaultRunLoopMode dequeue:NO];
    if (event && event.subtype != NSEventSubtypeApplicationActivated && event.subtype != NSEventSubtypeApplicationDeactivated) {
        [NSApp sendEvent:[NSApp nextEventMatchingMask:NSEventMaskAppKitDefined untilDate:nil inMode:NSDefaultRunLoopMode dequeue:YES]];
    }
    [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
}

static void until(BOOL (^done)(void), NSString *what) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) pump();
    if (!done()) { fprintf(stderr, "FAIL: %s within 10 seconds\n", what.UTF8String); exit(1); }
}

@interface SPNavigation : NSObject <WKNavigationDelegate>
@property BOOL finished;
@end

@implementation SPNavigation
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation { self.finished = YES; }
@end

static NSString *visibility(WKWebView *view) {
    __block NSString *result = nil;
    __block BOOL done = NO;
    [view evaluateJavaScript:@"document.visibilityState" completionHandler:^(id value, NSError *error) {
        result = error ? [NSString stringWithFormat:@"error: %@", error.localizedDescription] : [value copy];
        done = YES;
    }];
    until(^BOOL { return done; }, @"WebKit did not report document visibility");
    return [result autorelease];
}

// Waits for one animation frame in the document. It is nil if none arrives within 5 seconds.
static NSString *animationFrame(WKWebView *view) {
    __block NSString *frame = nil;
    [view callAsyncJavaScript:@"return await new Promise((resolve) => requestAnimationFrame(() => resolve('frame')));"
        arguments:nil inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:^(id value, NSError *error) {
            frame = error ? [[NSString alloc] initWithFormat:@"error: %@", error.localizedDescription] : [value copy];
        }];
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:5];
    while (!frame && deadline.timeIntervalSinceNow > 0) pump();
    return [frame autorelease];
}

// Returns after WebKit has reflected the occlusion state of the window in the activity state of the web process.
static void afterActivityState(WKWebView *view) {
    __block BOOL done = NO;
    [view _doAfterActivityStateUpdate:^{ done = YES; }];
    until(^BOOL { return done; }, @"WebKit did not apply the activity state");
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSWindow *window = [[[NSWindow alloc] initWithContentRect:NSMakeRect(60, 60, 400, 300)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO] autorelease];
    [window setReleasedWhenClosed:NO];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)] autorelease];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)] autorelease];
    [window.contentView addSubview:main];
    check(sp_surface_create(main) != NULL, @"the main webview creates the surface composition");
    check(sp_window_set_main_webview(window, main), @"the main webview is registered");
    WKWebView *surface = [[[WKWebView alloc] initWithFrame:NSMakeRect(20, 20, 200, 120)] autorelease];
    [window.contentView addSubview:surface positioned:NSWindowAbove relativeTo:main];
    webviewAttachSurface(surface, main);
    SPNavigation *navigation = [[SPNavigation new] autorelease];
    SPNavigation *surfaceNavigation = [[SPNavigation new] autorelease];
    main.navigationDelegate = navigation;
    surface.navigationDelegate = surfaceNavigation;
    [main loadHTMLString:@"<!doctype html><body>main</body>" baseURL:nil];
    [surface loadHTMLString:@"<!doctype html><body>surface</body>" baseURL:nil];
    [window orderFrontRegardless];
    until(^BOOL { return navigation.finished && surfaceNavigation.finished
        && (window.occlusionState & NSWindowOcclusionStateVisible) != 0; },
        @"the main and surface pages did not load in a visible window");
    afterActivityState(main);
    afterActivityState(surface);
    check([visibility(main) isEqualToString:@"visible"], @"the uncovered document is visible");
    check([visibility(surface) isEqualToString:@"visible"], @"the uncovered surface document is visible");

    // AppKit moves a window with a title bar out of the Dock and menu bar areas, so the occluding window covers the
    // real window position.
    NSWindow *cover = [[[NSWindow alloc] initWithContentRect:NSInsetRect(window.frame, -40, -40)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO] autorelease];
    [cover setReleasedWhenClosed:NO];
    cover.backgroundColor = NSColor.blackColor;
    [cover orderFrontRegardless];
    until(^BOOL { return (window.occlusionState & NSWindowOcclusionStateVisible) == 0; },
        [NSString stringWithFormat:@"the covering window did not occlude the main window (window %@ on %@ level %ld, cover %@ on %@ level %ld visible %d)",
            NSStringFromRect(window.frame), NSStringFromRect(window.screen.frame), (long)window.level,
            NSStringFromRect(cover.frame), NSStringFromRect(cover.screen.frame), (long)cover.level, cover.isVisible]);
    afterActivityState(main);
    afterActivityState(surface);
    NSString *covered = visibility(main);
    check([covered isEqualToString:@"visible"], [NSString stringWithFormat:@"the covered document stays visible (actual %@)", covered]);
    NSString *frame = animationFrame(main);
    check([frame isEqualToString:@"frame"], [NSString stringWithFormat:@"the covered document runs an animation frame (result %@)", frame ?: @"none within 5 seconds"]);
    covered = visibility(surface);
    check([covered isEqualToString:@"visible"], [NSString stringWithFormat:@"the covered surface document stays visible (actual %@)", covered]);
    frame = animationFrame(surface);
    check([frame isEqualToString:@"frame"], [NSString stringWithFormat:@"the covered surface document runs an animation frame (result %@)", frame ?: @"none within 5 seconds"]);

    check(!NSApp.isActive, @"application stays inactive");
    [cover close];
    [window close];
    return failures ? 1 : 0;
}}
