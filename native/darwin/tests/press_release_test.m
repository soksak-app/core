// A release of a press over an image region that the page does not receive reports the state of the press. A press
// that activates the application reaches no page, and a busy page answers late; each needs its own correction, and the
// record tells them apart. The application of this test is not active, so the page receives no press and the receipt
// of the release ends by its limit.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "event_ring.h"
#import "image_region.h"
#import "support/records.h"
#import "webview_geometry.h"
#import "window_facts.h"
#import "webview_input.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void testEvent(void *context, const char *json) {
    (void)context;
    (void)json;
}

static void runEvents(NSTimeInterval seconds) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (deadline.timeIntervalSinceNow > 0) {
        NSEvent *pending = [NSApp nextEventMatchingMask:NSEventMaskAny
            untilDate:[NSDate dateWithTimeIntervalSinceNow:0.02] inMode:NSDefaultRunLoopMode dequeue:YES];
        if (pending) [NSApp sendEvent:pending];
    }
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    WKWebView *page = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    [window.contentView addSubview:page];
    [window orderBack:nil];
    void *surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    check(surface != NULL, @"the main webview creates the composition");
    check(webviewInputRegister(page), @"the page registers the pointer receipt path");
    check(sp_surface_place_view(surface, page), @"the page is placed in its surface");
    webviewSetFrame(surface, 0, 0, 500, 400);
    webviewSetSurfaceHidden(surface, false);
    void *region = sp_region_create(surface, "press-release", testEvent, NULL);
    sp_region_place(region, 100, 150, 100, 50, true);

    NSView *regionView = (NSView *)region;
    NSRect frame = [regionView convertRect:regionView.bounds toView:nil];
    NSPoint point = NSMakePoint(NSMidX(frame), NSMidY(frame));
    NSString *records = capturedRecords(^{
        const NSEventType types[] = {NSEventTypeLeftMouseDown, NSEventTypeLeftMouseUp};
        for (int i = 0; i < 2; i++) {
            [NSApp postEvent:[NSEvent mouseEventWithType:types[i] location:point modifierFlags:0
                timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil
                eventNumber:1 clickCount:1 pressure:i == 0 ? 1 : 0] atStart:NO];
        }
        runEvents(1.6);
    });
    NSRegularExpression *state = [NSRegularExpression regularExpressionWithPattern:
        @"paired pointer release was not received before press-origin cleanup: button 0, "
        @"application active at the press: no, window key at the press: no" options:0 error:NULL];
    check([state firstMatchInString:records options:0 range:NSMakeRange(0, records.length)] != nil,
        [NSString stringWithFormat:@"a release that the page does not receive reports the state of its press (%@)", records]);
    return failures ? 1 : 0;
} }
