// The keyboard of a window follows the active surface of the card with the focus ring (docs/spec/native-surfaces.md#keyboard-of-a-surface).
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "image_region.h"
#import "input_inject.h"
#import "input_press_context.h"
#import "webview_geometry.h"
#import "window_facts.h"

static int failures;
static void check(BOOL ok, const char *message) {
    fprintf(ok ? stdout : stderr, "%s: %s\n", ok ? "PASS" : "FAIL", message);
    if (!ok) failures++;
}

static void regionEvent(void *context, const char *json) {
    (void)context;
    (void)json;
}

static void placeRegion(void *region) {
    sp_region_place(region, 0, 0, 0, 0, true);
    // A region applies its geometry in a later turn of the main loop.
    [NSRunLoop.mainRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 800, 500)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    NSView *content = [[NSView alloc] initWithFrame:window.contentView.bounds];
    content.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [window.contentView addSubview:content];
    WKWebView *main = [[WKWebView alloc] initWithFrame:content.bounds];
    [content addSubview:main];
    void *composition = sp_window_set_main_webview(window, main);
    void *observation = sp_window_observe_responder(window, ^{});
    check(observation != NULL, "the first responder of the window is observed");

    void *terminalHost = sp_surface_create(composition);
    void *browserHost = sp_surface_create(composition);
    webviewSetFrame(terminalHost, 0, 0, 400, 500);
    webviewSetFrame(browserHost, 400, 0, 400, 500);
    webviewSetSurfaceHidden(terminalHost, false);
    webviewSetSurfaceHidden(browserHost, false);
    WKWebView *terminalPage = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 500)] autorelease];
    WKWebView *browserPage = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 500)] autorelease];
    check(sp_surface_place_view(terminalHost, terminalPage), "the page of the first surface is placed");
    check(sp_surface_place_view(browserHost, browserPage), "the page of the second surface is placed");

    // A surface that is not ready: the page takes the keyboard, and the first image region that shows takes it from the page.
    sp_surface_focus(terminalHost);
    check(window.firstResponder == terminalPage, "a surface without a region gives the keyboard to its page");
    void *region = sp_region_create(terminalHost, "view", regionEvent, NULL);
    check(region != NULL, "the image region of the surface is created");
    check(window.firstResponder == terminalPage, "a region that does not show takes no keyboard");
    placeRegion(region);
    check(window.firstResponder == (NSResponder *)region, "the first image region that shows receives the keyboard of its surface");

    // The surface gives the keyboard to the other surface and takes it back.
    sp_surface_focus(browserHost);
    check(window.firstResponder == browserPage, "the keyboard moves to the page of the other surface");
    sp_surface_focus(terminalHost);
    check(window.firstResponder == (NSResponder *)region, "the keyboard returns to the region that held it in the surface");

    // What holds the keyboard inside the surface keeps it: a person pressed the page of a surface that has a region.
    check([window makeFirstResponder:terminalPage], "the page of the surface takes the keyboard from its region");
    sp_surface_focus(terminalHost);
    check(window.firstResponder == terminalPage, "a call for the surface leaves what holds the keyboard inside it");

    // The workbench takes the keyboard for a card without a surface.
    sp_window_focus_workbench(window);
    check(window.firstResponder == main, "the main web view takes the keyboard of a card without a surface");
    sp_surface_focus(browserHost);

    // A later move replaces a move that waits, and a press delays both until its release.
    check(sp_input_pointer(window, 600, 250, 1, 0, 0, 0) == SP_INPUT_DELIVERED, "a press on the page that holds the keyboard is delivered");
    sp_surface_focus(terminalHost);
    check(window.firstResponder == browserPage, "an open press keeps the keyboard where it is");
    sp_window_focus_workbench(window);
    sp_surface_focus(terminalHost);
    check(window.firstResponder == browserPage, "a second call during the press waits too");
    check(sp_input_pointer(window, 600, 250, 3, 0, 0, 0) == SP_INPUT_DELIVERED, "the release of that press is delivered");
    check(window.firstResponder == terminalPage, "the release gives the keyboard to the last surface that asked for it");
    sp_surface_press_released(window);
    check(window.firstResponder == terminalPage, "a release without a waiting move changes nothing");

    // The origin of a press outlives its release until the page received the release, and no press is open meanwhile.
    sp_surface_focus(browserHost);
    uint64_t kept = sp_input_press_origin_set(window, 0, 10, 10);
    sp_surface_focus(terminalHost);
    check(window.firstResponder == terminalPage, "an origin that outlives its release does not hold the keyboard");
    sp_input_press_origin_clear(window, 0, kept);

    // A surface hidden with the keyboard keeps its owner for the next call.
    sp_surface_focus(browserHost);
    check(window.firstResponder == browserPage, "the other surface takes the keyboard");
    sp_surface_focus(terminalHost);
    check([window makeFirstResponder:(NSResponder *)region], "the region takes the keyboard");
    webviewSetSurfaceHidden(terminalHost, true);
    sp_surface_focus(browserHost);
    webviewSetSurfaceHidden(terminalHost, false);
    sp_surface_focus(terminalHost);
    check(window.firstResponder == (NSResponder *)region, "a surface that was hidden gives the keyboard back to its region");

    // A closed region leaves no owner, and the surface lands on its page.
    sp_region_close(region);
    sp_surface_focus(browserHost);
    sp_surface_focus(terminalHost);
    check(window.firstResponder == terminalPage, "a closed region takes no keyboard");

    // The page holds the keyboard only because no region showed. The keyboard goes to the workbench and comes back, as a press on
    // a tab of the page does, and a region showed meanwhile: the region takes it, as nothing chose the page.
    sp_window_focus_workbench(window);
    void *later = sp_region_create(terminalHost, "later", regionEvent, NULL);
    check(later != NULL, "the later image region of the surface is created");
    placeRegion(later);
    check(window.firstResponder == main, "a region that shows takes no keyboard from the workbench");
    sp_surface_focus(terminalHost);
    check(window.firstResponder == (NSResponder *)later, "a page that took the keyboard for want of a region does not keep it from a region");

    // A page that a person chose keeps the keyboard across the same return.
    check([window makeFirstResponder:terminalPage], "the page of the surface takes the keyboard from the later region");
    sp_window_focus_workbench(window);
    sp_surface_focus(terminalHost);
    check(window.firstResponder == terminalPage, "a page that held the keyboard by a press takes it back");
    sp_region_close(later);

    sp_window_end_responder_observation(observation);
    return failures ? 1 : 0;
} }
