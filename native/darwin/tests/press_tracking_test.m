// A press on the title bar asks the workbench no decision, and a move of the keyboard that waits for the release of a person's
// press ends also when an event tracking loop took that release out of the queue (docs/spec/native-surfaces.md#keyboard-of-a-surface).
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import "event_ring.h"
#import "image_region.h"
#import "input_inject.h"
#import "input_virtual.h"
#import "main_thread.h"
#import "support/records.h"
#import "surface_layout.h"
#import "webview_geometry.h"
#import "window_facts.h"

static int failures;
static void runDirectly(void (^work)(void)) { work(); }

static void check(BOOL ok, NSString *message) {
    fprintf(ok ? stdout : stderr, "%s: %s\n", ok ? "PASS" : "FAIL", message.UTF8String);
    if (!ok) failures++;
}

// The buttons that a person holds. The replacement stands before the library reads +[NSEvent pressedMouseButtons], so the library
// reads it as the value of AppKit, as input_virtual_test does.
static NSUInteger personButtons;
static NSUInteger testButtons(id self, SEL selector) {
    (void)self;
    (void)selector;
    return personButtons;
}

static void regionEvent(void *context, const char *json) {
    (void)context;
    (void)json;
}

// The characters of the keys that a region received while block ran, in order.
static NSString *regionKeys(void (^block)(void)) {
    NSMutableString *keys = [NSMutableString string];
    for (NSDictionary *event in capturedEvents(block)) {
        if ([event[@"name"] isEqual:@"native.input.key_down"]) [keys appendString:event[@"fields"][@"characters"]];
    }
    return keys;
}

static void typeKeys(NSWindow *window, const char *text) {
    for (const char *at = text; *at; at++) {
        char key[2] = {*at, 0};
        check(sp_input_key(window, key, key, 0, true) == SP_INPUT_DELIVERED, @"a key press is delivered");
        check(sp_input_key(window, key, key, 0, false) == SP_INPUT_DELIVERED, @"a key release is delivered");
    }
}

static void runQueuedEvents(void) {
    NSEvent *event;
    while ((event = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:NSDate.distantPast inMode:NSDefaultRunLoopMode dequeue:YES])) {
        [NSApp sendEvent:event];
    }
}

// Runs one turn of the main run loop in its default mode: the blocks performed in that mode and the main queue run in it, then the
// events that it queued are sent. The checks after it judge what that turn did, not a time.
static void runDefaultTurn(void) {
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0, false);
    runQueuedEvents();
}

static NSEvent *mouseEvent(NSWindow *window, NSEventType type, NSPoint point) {
    return [NSEvent mouseEventWithType:type location:point modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime
        windowNumber:window.windowNumber context:nil eventNumber:0 clickCount:1 pressure:type == NSEventTypeLeftMouseUp ? 0 : 1];
}

// An event tracking loop, as the title bar, a control and a text view run while they track a press: it runs the main run loop in
// the event tracking mode and takes the event of mask out of the queue without dispatching it. The event comes from a later turn, as
// the person's release does, and the person lets the button go with it when release is set.
// The main queue runs in the event tracking mode, which is a common mode, so the event is posted from a turn of the loop. A loop that
// never takes it leaves the test to the limit of its runner, which reports the stall.
static NSEvent *trackUntil(NSWindow *window, NSEventType type, NSPoint point, BOOL release) {
    NSEvent *event = mouseEvent(window, type, point);
    dispatch_async(dispatch_get_main_queue(), ^{
        if (release) personButtons = 0;
        [NSApp postEvent:event atStart:NO];
    });
    return [NSApp nextEventMatchingMask:NSEventMaskFromType(type) untilDate:NSDate.distantFuture inMode:NSEventTrackingRunLoopMode
        dequeue:YES];
}

int main(void) { @autoreleasepool {
    method_setImplementation(class_getClassMethod(NSEvent.class, @selector(pressedMouseButtons)), (IMP)testButtons);
    hostInstallMainThread(runDirectly, runDirectly);
    [NSApplication sharedApplication];
    const int8_t everything[SP_CLASS_COUNT] = {SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE};
    check(sp_event_set_policy(everything), @"the policy stores every level");

    // The content of the window runs under its title bar, as the windows of the hosts do. The workbench is the left half of the
    // content, the surface the right half.
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 800, 500)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskFullSizeContentView backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    [window orderBack:nil];
    NSRect bounds = window.contentView.bounds;
    WKWebView *main = [[[WKWebView alloc] initWithFrame:bounds] autorelease];
    [window.contentView addSubview:main];
    void *observation = sp_window_observe_responder(window, ^{});
    void *composition = sp_window_set_main_webview(window, main);
    void *host = sp_surface_create(composition);
    webviewSetFrame(host, 400, 0, 400, bounds.size.height);
    webviewSetSurfaceHidden(host, false);
    WKWebView *page = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, bounds.size.height)] autorelease];
    check(sp_surface_place_view(host, page), @"the page of the surface is placed");
    void *region = sp_region_create(host, "view", regionEvent, NULL);
    sp_region_place(region, 0, 0, 0, 0, true);
    runDefaultTurn();
    sp_window_focus_workbench(window);
    check(window.firstResponder == main, @"the workbench holds the keyboard");
    NSRect layout = window.contentLayoutRect;
    check(NSMaxY(layout) < NSMaxY(bounds),
        [NSString stringWithFormat:@"the content runs under the title bar (layout top %.0f, content top %.0f)", NSMaxY(layout), NSMaxY(bounds)]);
    // A point of the title bar over the workbench half, where the content runs under the title bar.
    NSPoint title = NSMakePoint(200, (NSMaxY(layout) + NSMaxY(bounds)) / 2);

    // A double click on the title bar zooms the window, and the application dispatches its releases. The title bar took the
    // presses, so no decision of the workbench follows them and no key waits: the key after the release reaches the region at once.
    NSString *afterTitle = regionKeys(^{
        for (int click = 0; click < 2; click++) {
            surfaceLayoutPointerPassing(window, true, title.x, title.y);
            surfaceLayoutPointerPassing(window, false, title.x, title.y);
        }
        [window makeFirstResponder:(NSResponder *)region];
        typeKeys(window, "a");
        runQueuedEvents();
    });
    check([afterTitle isEqual:@"a"],
        [NSString stringWithFormat:@"a key after a double click on the title bar reaches the region at once, got \"%@\"", afterTitle]);
    // A wait that the title bar left open ends here, so the checks below start without one.
    sp_window_keys_decided(window);
    runQueuedEvents();

    // A press on the workbench under the title bar still asks the decision: its keys wait for the decided call.
    sp_window_focus_workbench(window);
    NSString *beforeDecision = regionKeys(^{
        surfaceLayoutPointerPassing(window, true, 200, NSMidY(layout));
        surfaceLayoutPointerPassing(window, false, 200, NSMidY(layout));
        typeKeys(window, "b");
        runQueuedEvents();
    });
    check([beforeDecision isEqual:@""],
        [NSString stringWithFormat:@"a key after a press on the workbench waits for the decision, got \"%@\"", beforeDecision]);
    NSString *decided = regionKeys(^{
        sp_surface_focus(host);
        sp_window_keys_decided(window);
        runQueuedEvents();
    });
    check([decided isEqual:@"b"], [NSString stringWithFormat:@"the decided call gives the key to the region, got \"%@\"", decided]);

    // The injected keys above entered the virtual key window, in which the buttons of a person read as none. A person's press
    // is the state of AppKit, so the checks below run outside it.
    sp_input_virtual_end("test");
    check(!sp_input_virtual_any(), @"the virtual key window ended");

    // A move of the keyboard during a person's press waits for the release. The title bar tracks its press in an event tracking
    // loop, which takes the release out of the queue: no monitor sees it, and the first turn of the default mode after the loop,
    // with the button up, ends the wait.
    sp_window_focus_workbench(window);
    personButtons = 1;
    sp_surface_focus(host);
    check(window.firstResponder == main, @"the move of the keyboard waits while the left button is down");
    NSEvent *taken = trackUntil(window, NSEventTypeLeftMouseUp, title, YES);
    check(taken.type == NSEventTypeLeftMouseUp, @"the tracking loop takes the release out of the queue");
    check(window.firstResponder == main, @"nothing moves the keyboard while the loop tracks");
    runDefaultTurn();
    check(window.firstResponder == (NSResponder *)region,
        [NSString stringWithFormat:@"the move runs at the first turn of the default mode after the tracking loop took the release, got %@",
            window.firstResponder]);
    personButtons = 0;
    sp_surface_press_released(window);

    // A tracking loop that ends while the button is still down ends no wait; the release that the application then dispatches does.
    sp_window_focus_workbench(window);
    personButtons = 1;
    sp_surface_focus(host);
    NSEvent *dragged = trackUntil(window, NSEventTypeLeftMouseDragged, title, NO);
    check(dragged.type == NSEventTypeLeftMouseDragged, @"the tracking loop takes a drag");
    runDefaultTurn();
    check(window.firstResponder == main, @"a tracking loop that ends with the button down leaves the move waiting");
    personButtons = 0;
    [NSApp sendEvent:mouseEvent(window, NSEventTypeLeftMouseUp, NSMakePoint(600, NSMidY(layout)))];
    runDefaultTurn();
    check(window.firstResponder == (NSResponder *)region, @"the release that the application dispatches runs the move");

    [window close];
    sp_region_close(region);
    sp_surface_close(host);
    sp_window_end_responder_observation(observation);
    return failures ? 1 : 0;
} }
