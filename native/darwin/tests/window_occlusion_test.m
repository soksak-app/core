// Checks that the registered main webview and the view pages placed in a surface keep running animation frames without
// hiding the document even when the window is occluded. Layout display and project commands wait for the next display
// of the main webview, and capture and drawing confirmation of a surface wait for the rendering of the surface, so
// they must finish in an occluded window too. The check does not activate the application.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "support/check_level.h"
#import "window_facts.h"
#import "webview_geometry.h"
#import "private/webkit.h"
#import "support/event_wait.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Occlusion state changes of the window server arrive as AppKit events, which the wait sends to the application.
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
    eventWait(@"WebKit reports the document visibility", ^BOOL { return done; });
    return [result autorelease];
}

// Waits for one animation frame in the document and returns its result.
static NSString *animationFrame(WKWebView *view) {
    __block NSString *frame = nil;
    [view callAsyncJavaScript:@"return await new Promise((resolve) => requestAnimationFrame(() => resolve('frame')));"
        arguments:nil inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:^(id value, NSError *error) {
            frame = error ? [[NSString alloc] initWithFormat:@"error: %@", error.localizedDescription] : [value copy];
        }];
    eventWait(@"the document runs an animation frame", ^BOOL { return frame != nil; });
    return [frame autorelease];
}

// Returns after WebKit has reflected the occlusion state of the window in the activity state of the web process.
static void afterActivityState(WKWebView *view) {
    __block BOOL done = NO;
    [view _doAfterActivityStateUpdate:^{ done = YES; }];
    eventWait(@"WebKit applies the activity state", ^BOOL { return done; });
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
    void *surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    check(surface != NULL, @"the main webview creates a surface");
    check(sp_window_set_main_webview(window, main), @"the main webview is registered");
    WKWebView *page = [[[WKWebView alloc] initWithFrame:NSZeroRect] autorelease];
    check(sp_surface_place_view(surface, page), @"the view page is placed in its surface");
    webviewSetFrame(surface, 20, 20, 200, 120);
    webviewSetSurfaceHidden(surface, false);
    SPNavigation *navigation = [[SPNavigation new] autorelease];
    SPNavigation *surfaceNavigation = [[SPNavigation new] autorelease];
    main.navigationDelegate = navigation;
    page.navigationDelegate = surfaceNavigation;
    [main loadHTMLString:@"<!doctype html><body>main</body>" baseURL:nil];
    [page loadHTMLString:@"<!doctype html><body>surface</body>" baseURL:nil];
    window.level = kCheckWindowLevel;
    [window orderFrontRegardless];
    eventWait(@"the main and surface pages load in a visible window", ^BOOL { return navigation.finished && surfaceNavigation.finished
        && (window.occlusionState & NSWindowOcclusionStateVisible) != 0; });
    afterActivityState(main);
    afterActivityState(page);
    check([visibility(main) isEqualToString:@"visible"], @"the uncovered document is visible");
    check([visibility(page) isEqualToString:@"visible"], @"the uncovered surface document is visible");
    check(sp_window_on_screen(window), @"the uncovered window is on screen");

    // AppKit moves a window with a title bar out of the Dock and menu bar areas, so the occluding window covers the
    // real window position.
    NSWindow *cover = [[[NSWindow alloc] initWithContentRect:NSInsetRect(window.frame, -40, -40)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO] autorelease];
    [cover setReleasedWhenClosed:NO];
    cover.backgroundColor = NSColor.blackColor;
    cover.level = kCheckWindowLevel;
    [cover orderFrontRegardless];
    eventWait([NSString stringWithFormat:@"the covering window occludes the main window (window %@ on %@ level %ld, cover %@ on %@ level %ld visible %d)",
            NSStringFromRect(window.frame), NSStringFromRect(window.screen.frame), (long)window.level,
            NSStringFromRect(cover.frame), NSStringFromRect(cover.screen.frame), (long)cover.level, cover.isVisible],
        ^BOOL { return (window.occlusionState & NSWindowOcclusionStateVisible) == 0; });
    check(!sp_window_on_screen(window), @"the covered window is not on screen");
    afterActivityState(main);
    afterActivityState(page);
    NSString *covered = visibility(main);
    check([covered isEqualToString:@"visible"], [NSString stringWithFormat:@"the covered document stays visible (actual %@)", covered]);
    NSString *frame = animationFrame(main);
    check([frame isEqualToString:@"frame"], [NSString stringWithFormat:@"the covered document runs an animation frame (result %@)", frame]);
    covered = visibility(page);
    check([covered isEqualToString:@"visible"], [NSString stringWithFormat:@"the covered surface document stays visible (actual %@)", covered]);
    frame = animationFrame(page);
    check([frame isEqualToString:@"frame"], [NSString stringWithFormat:@"the covered surface document runs an animation frame (result %@)", frame]);

    check(!NSApp.isActive, @"application stays inactive");
    [cover close];
    eventWait(@"the window is visible after the cover closed", ^BOOL { return (window.occlusionState & NSWindowOcclusionStateVisible) != 0; });
    check(sp_window_on_screen(window), @"the window is on screen again after the cover closed");
    [window orderOut:nil];
    eventWait(@"the ordered-out window is no longer visible", ^BOOL { return (window.occlusionState & NSWindowOcclusionStateVisible) == 0; });
    check(!sp_window_on_screen(window), @"the ordered-out window is not on screen");
    check(!sp_window_on_screen(NULL), @"no window is not on screen");
    [window close];
    return failures ? 1 : 0;
}}
