// Checks that each web view whose document must render while its window is occluded has the occlusion detection of WebKit
// turned off through sp_webview_render_occluded: a modal web view that a host places directly in the content view, the
// registered main web view and a view page placed in a surface. WebKit hides the document of a web view in an occluded
// window and stops its rendering otherwise, so a modal of a covered window would not render and a still capture would hold
// the workbench without it. A web view that nothing configures keeps the detection, so the checks see the change of the
// function. The check does not activate the application.
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

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSWindow *window = [[[NSWindow alloc] initWithContentRect:NSMakeRect(60, 60, 400, 300)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO] autorelease];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)] autorelease];
    [window.contentView addSubview:main];
    WKWebView *modal = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)] autorelease];
    [window.contentView addSubview:modal positioned:NSWindowAbove relativeTo:main];
    WKWebView *page = [[[WKWebView alloc] initWithFrame:NSZeroRect] autorelease];

    check(main._windowOcclusionDetectionEnabled && modal._windowOcclusionDetectionEnabled && page._windowOcclusionDetectionEnabled,
        @"a web view that nothing configured detects the occlusion of its window");

    check(sp_webview_render_occluded(modal), @"the modal web view is configured to render while its window is occluded");
    check(!modal._windowOcclusionDetectionEnabled, @"the modal web view does not detect the occlusion of its window");
    check(sp_webview_render_occluded(modal), @"a second call on the same web view succeeds");
    check(!modal._windowOcclusionDetectionEnabled, @"the modal web view still does not detect the occlusion after a second call");

    void *composition = sp_window_set_main_webview(window, main);
    check(composition != NULL, @"the main web view is registered");
    check(!main._windowOcclusionDetectionEnabled, @"the registered main web view does not detect the occlusion of its window");

    void *surface = sp_surface_create(composition);
    check(surface != NULL, @"the main web view creates a surface");
    check(sp_surface_place_view(surface, page), @"the view page is placed in its surface");
    check(!page._windowOcclusionDetectionEnabled, @"the placed view page does not detect the occlusion of its window");

    check(!NSApp.isActive, @"application stays inactive");
    sp_surface_unplace_view(page);
    sp_surface_close(surface);
    [window close];
    return failures ? 1 : 0;
}}
