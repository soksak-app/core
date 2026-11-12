// A release of a press over an image region that the page does not receive reports the state of the press. A press
// that activates the application reaches no page, and a busy page answers late; each needs its own correction, and the
// record tells them apart. The application of this test is not active, so the page receives no press and the receipt
// of the release ends by its limit.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import "event_ring.h"
#import "image_region.h"
#import "input_inject.h"
#import "input_press_context.h"
#import "input_virtual.h"
#import "support/event_wait.h"
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

// Runs the main queue and the application events until a marker block queued after every block already on the main queue has run.
static void drainMainQueue(NSString *what) {
    __block BOOL passed = NO;
    dispatch_async(dispatch_get_main_queue(), ^{ passed = YES; });
    eventWait(what, ^BOOL { return passed; });
}

// Whether the press origin of the left button of window has ended. The monitor of the press origin clears it when the receipt
// of the paired release ends, after it wrote the record of a release that the page did not receive.
static BOOL pressOriginEnded(NSWindow *window) { return !sp_input_press_origin_point(window, 0, NULL, NULL, NULL); }
// The navigation delegate of a page that a check loads. It is kept on its web view, which does not retain its delegate.
@interface SPPageLoad : NSObject <WKNavigationDelegate>
@property BOOL finished;
@end
@implementation SPPageLoad
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
    (void)view;
    (void)navigation;
    self.finished = YES;
}
@end
static char pageLoadKey;

// Loads html into view and keeps a navigation delegate that hears when the navigation finishes.
static void loadPage(WKWebView *view, NSString *html) {
    SPPageLoad *load = [[[SPPageLoad alloc] init] autorelease];
    objc_setAssociatedObject(view, &pageLoadKey, load, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    view.navigationDelegate = load;
    [view loadHTMLString:html baseURL:nil];
}

// Waits until the navigation that loadPage started on view finishes, so the scripts of the document have run.
static void awaitLoad(WKWebView *view) {
    SPPageLoad *load = objc_getAssociatedObject(view, &pageLoadKey);
    eventWait(@"the navigation of the page finishes", ^BOOL { return load.finished; });
    view.navigationDelegate = nil;
}


// The real activation, which this test gives in place of AppKit.
static BOOL reallyActive;
static BOOL testIsActive(id self, SEL selector) { return reallyActive; }

// A press and a release that reach their page answer nothing wrong, also with a hidden surface whose region lies at the point.
// The key window of the application that is really active passes the application, whose monitor waits for the release in the
// page of the region at the press.
@interface SPKeyWindow : NSWindow
@end
@implementation SPKeyWindow
- (BOOL)isKeyWindow { return YES; }
@end
@interface SPFirstClickPage : WKWebView
@end
@implementation SPFirstClickPage
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
@end
static void pressDone(void *context, sp_input_result result, const sp_input_held *held) {
    int *out = context;
    *out = result + 1;
    eventWake();
}
static void checkHiddenSurfaceRegion(void) {
    reallyActive = YES;
    NSWindow *window = [[SPKeyWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    [window orderBack:nil];
    void *root = sp_window_set_main_webview(main.window, main);
    WKWebView *page = [[[SPFirstClickPage alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    [window.contentView addSubview:page];
    void *shown = sp_surface_create(root);
    webviewInputRegister(page);
    sp_surface_place_view(shown, page);
    loadPage(page, @"<!doctype html><style>html,body{margin:0;height:100%}</style>");
    webviewSetFrame(shown, 0, 0, 500, 400);
    webviewSetSurfaceHidden(shown, false);
    sp_region_place(sp_region_create(shown, "shown", testEvent, NULL), 100, 150, 100, 50, true);
    // The live regions have no order, so several hidden surfaces leave no order that hides the fault.
    for (int i = 0; i < 6; i++) {
        WKWebView *other = [[[SPFirstClickPage alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
        [window.contentView addSubview:other];
        void *surface = sp_surface_create(root);
        webviewInputRegister(other);
        sp_surface_place_view(surface, other);
        webviewSetFrame(surface, 0, 0, 500, 400);
        webviewSetSurfaceHidden(surface, false);
        sp_region_place(sp_region_create(surface, "hidden", testEvent, NULL), 100, 150, 100, 50, true);
        drainMainQueue(@"the blocks that the shown surface queued run");
        webviewSetSurfaceHidden(surface, true);
    }
    awaitLoad(page);
    int down = 0, up = 0;
    int *downAnswer = &down, *upAnswer = &up;
    NSString *records = capturedRecords(^{
        sp_input_pointer_then(window, SP_INPUT_POINTER_MAIN, 150, 175, 1, 0, 0, 0, 1, pressDone, downAnswer);
        eventWait(@"the press answers", ^BOOL { return *downAnswer != 0; });
        sp_input_pointer_then(window, SP_INPUT_POINTER_MAIN, 150, 175, 3, 0, 0, 0, 1, pressDone, upAnswer);
        // A record of a release that waited for a page is written before the receipt of that release ends and the press origin
        // ends, so the records are judged after the release answered and its press origin ended.
        eventWait(@"the release answers and its press origin ends", ^BOOL { return *upAnswer != 0 && pressOriginEnded(window); });
    });
    check(down == SP_INPUT_DELIVERED + 1 && up == SP_INPUT_DELIVERED + 1, [NSString stringWithFormat:@"the press and the release reach their page (%d, %d)", down, up]);
    check(![records containsString:@"paired pointer release"] && ![records containsString:@"receipt of pointerup did not arrive"],
        [NSString stringWithFormat:@"the release does not wait for the page of a hidden surface (%@)", records]);
    [window close];
    reallyActive = NO;
}

// A view over the edge of an image region, as a boundary between cards, that takes the press itself.
@interface SPBoundary : NSView
@property int presses;
@property int releases;
@end
@implementation SPBoundary
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
- (void)mouseDown:(NSEvent *)event { self.presses++; }
- (void)mouseUp:(NSEvent *)event { self.releases++; }
@end

// A press that a view over the edge of a region takes reaches neither the page of the region nor, with it, its release, so
// the release waits for no receipt of that page and leaves no record of a release that the page did not receive.
static void checkBoundaryOverRegion(void) {
    reallyActive = YES;
    NSWindow *window = [[SPKeyWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    [window orderBack:nil];
    void *root = sp_window_set_main_webview(main.window, main);
    WKWebView *page = [[[SPFirstClickPage alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    [window.contentView addSubview:page];
    void *surface = sp_surface_create(root);
    webviewInputRegister(page);
    sp_surface_place_view(surface, page);
    loadPage(page, @"<!doctype html><style>html,body{margin:0;height:100%}</style>");
    webviewSetFrame(surface, 0, 0, 500, 400);
    webviewSetSurfaceHidden(surface, false);
    sp_region_place(sp_region_create(surface, "edge", testEvent, NULL), 100, 150, 100, 50, true);
    awaitLoad(page);
    // The boundary covers the band from 170 to 180 of the region, whose top is at 150, on top of every other view.
    SPBoundary *boundary = [[[SPBoundary alloc] initWithFrame:NSMakeRect(100, 400 - 180, 100, 10)] autorelease];
    [window.contentView addSubview:boundary positioned:NSWindowAbove relativeTo:nil];
    int down = 0, up = 0;
    int *downAnswer = &down, *upAnswer = &up;
    NSString *records = capturedRecords(^{
        sp_input_pointer_then(window, SP_INPUT_POINTER_MAIN, 150, 175, 1, 0, 0, 0, 1, pressDone, downAnswer);
        eventWait(@"the press answers", ^BOOL { return *downAnswer != 0; });
        sp_input_pointer_then(window, SP_INPUT_POINTER_MAIN, 150, 175, 3, 0, 0, 0, 1, pressDone, upAnswer);
        eventWait(@"the release answers and its press origin ends", ^BOOL { return *upAnswer != 0 && pressOriginEnded(window); });
    });
    check(down == SP_INPUT_DELIVERED + 1 && up == SP_INPUT_DELIVERED + 1 && boundary.presses == 1 && boundary.releases == 1,
        [NSString stringWithFormat:@"the press and the release reach the boundary over the region (%d, %d, %d, %d)", down, up,
            boundary.presses, boundary.releases]);
    check(![records containsString:@"paired pointer release"] && ![records containsString:@"wait for pointerup ended"],
        [NSString stringWithFormat:@"a release of a press that a boundary over a region took waits for no receipt of the page "
            @"of the region (%@)", records]);
    [window close];
    reallyActive = NO;
}

int main(void) { @autoreleasepool {
    method_setImplementation(class_getInstanceMethod(NSApplication.class, @selector(isActive)), (IMP)testIsActive);
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
    // Hears when the application delivers the posted release.
    __block BOOL released = NO;
    id releaseMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseUp handler:^NSEvent *(NSEvent *event) {
        released = YES;
        return event;
    }];
    NSString *records = capturedRecords(^{
        const NSEventType types[] = {NSEventTypeLeftMouseDown, NSEventTypeLeftMouseUp};
        for (int i = 0; i < 2; i++) {
            [NSApp postEvent:[NSEvent mouseEventWithType:types[i] location:point modifierFlags:0
                timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil
                eventNumber:1 clickCount:1 pressure:i == 0 ? 1 : 0] atStart:NO];
        }
        // The record of the release that the page does not receive is written when the receipt of the release ends, before
        // the press origin ends.
        eventWait(@"the posted release is delivered and its press origin ends", ^BOOL { return released && pressOriginEnded(window); });
    });
    [NSEvent removeMonitor:releaseMonitor];
    NSRegularExpression *state = [NSRegularExpression regularExpressionWithPattern:
        @"paired pointer release was not received before press-origin cleanup: button 0, "
        @"application active at the press: no, window key at the press: no, virtual key window at the press: no" options:0 error:NULL];
    check([state firstMatchInString:records options:0 range:NSMakeRange(0, records.length)] != nil,
        [NSString stringWithFormat:@"a release that the page does not receive reports the state of its press (%@)", records]);

    // The virtual key window answers isActive and isKeyWindow as the key window of an active application. The state of a press
    // in it keeps the real states, no and no, apart from the virtual key window, yes.
    check(sp_input_virtual_enter(window), @"the window becomes the virtual key window");
    check(NSApp.isActive && window.isKeyWindow, @"the virtual key window answers as the key window of an active application");
    uint64_t token = sp_input_press_origin_set(window, 0, point.x, point.y);
    bool active = true, key = true, virtualKey = false;
    check(sp_input_press_origin_state(window, 0, &active, &key, &virtualKey) && !active && !key && virtualKey,
        [NSString stringWithFormat:@"a press of the virtual key window keeps the real states apart from the virtual key window "
            @"(active %d, key %d, virtual %d)", active, key, virtualKey]);
    sp_input_press_origin_clear(window, 0, token);
    sp_input_virtual_end("the check of the press state ended");
    checkHiddenSurfaceRegion();
    checkBoundaryOverRegion();
    return failures ? 1 : 0;
} }
