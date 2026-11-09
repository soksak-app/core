// The keyboard of a window follows the active surface of the card with the focus ring (docs/spec/native-surfaces.md#keyboard-of-a-surface).
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "host_api_webview.h"
#import "image_region.h"
#import "input_inject.h"
#import "input_press_context.h"
#import "event_ring.h"
#import "support/records.h"
#import "main_thread.h"
#import "webview_geometry.h"
#import "window_facts.h"

static int failures;
static void runDirectly(void (^work)(void)) { work(); }
static void check(BOOL ok, const char *message) {
    fprintf(ok ? stdout : stderr, "%s: %s\n", ok ? "PASS" : "FAIL", message);
    if (!ok) failures++;
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
        check(sp_input_key(window, key, key, 0, true) == SP_INPUT_DELIVERED, "a key press is delivered");
        check(sp_input_key(window, key, key, 0, false) == SP_INPUT_DELIVERED, "a key release is delivered");
    }
}

// Runs the event queue of the application until it holds no event. The input that a hold gives back takes its turns there: the
// end of a hold posts every piece of it to the queue at once, so the given input has run when the queue is empty, however long
// each turn takes.
static void runQueuedEvents(void) {
    NSEvent *event;
    while ((event = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:NSDate.distantPast inMode:NSDefaultRunLoopMode dequeue:YES])) {
        [NSApp sendEvent:event];
    }
}

// Runs the event queue of the application for the interval, for a hold that must outlast it.
static void runEvents(NSTimeInterval interval) {
    NSDate *until = [NSDate dateWithTimeIntervalSinceNow:interval];
    while (until.timeIntervalSinceNow > 0) {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]
            inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event) [NSApp sendEvent:event];
    }
}

// The fields of the first event named name in events, nil without one.
static NSDictionary *eventFields(NSArray<NSDictionary *> *events, NSString *name) {
    for (NSDictionary *event in events) {
        if ([event[@"name"] isEqual:name]) return event[@"fields"];
    }
    return nil;
}

static void placeRegion(void *region) {
    sp_region_place(region, 0, 0, 0, 0, true);
    // A region applies its geometry in a later turn of the main loop.
    [NSRunLoop.mainRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
}

int main(void) { @autoreleasepool {
    hostInstallMainThread(runDirectly, runDirectly);
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
    // The keys of a region are debug and input records, which the default policy does not store.
    const int8_t everything[SP_CLASS_COUNT] = {SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE};
    check(sp_event_set_policy(everything), "the policy stores every level");
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

    // A surface that shows again during a press takes its keyboard back at the release, as a move of the first responder would end the press.
    webviewSetSurfaceHidden(terminalHost, true);
    NSResponder *replacement = window.firstResponder;
    check(sp_input_pointer(window, 600, 250, 1, 0, 0, 0) == SP_INPUT_DELIVERED, "a press while the surface is hidden is delivered");
    check([window makeFirstResponder:replacement], "the view that took the keyboard from the hidden surface holds it during the press");
    webviewSetSurfaceHidden(terminalHost, false);
    check(window.firstResponder == replacement, "a surface that shows again during a press keeps the keyboard where it is");
    check(sp_input_pointer(window, 600, 250, 3, 0, 0, 0) == SP_INPUT_DELIVERED, "the release of that press is delivered");
    check(window.firstResponder == (NSResponder *)region, "the release gives the keyboard back to the region of the surface that showed");

    // A call that waits for the release is not replaced by a surface that shows again.
    webviewSetSurfaceHidden(terminalHost, true);
    replacement = window.firstResponder;
    check(sp_input_pointer(window, 600, 250, 1, 0, 0, 0) == SP_INPUT_DELIVERED, "a second press while the surface is hidden is delivered");
    check([window makeFirstResponder:replacement], "the view that took the keyboard holds it during the second press");
    sp_window_focus_workbench(window);
    webviewSetSurfaceHidden(terminalHost, false);
    check(sp_input_pointer(window, 600, 250, 3, 0, 0, 0) == SP_INPUT_DELIVERED, "the release of the second press is delivered");
    check(window.firstResponder == main, "the call of the press wins over the surface that showed again");

    // The focus call of a region waits for the release like the call of a surface.
    sp_surface_focus(browserHost);
    check(sp_input_pointer(window, 600, 250, 1, 0, 0, 0) == SP_INPUT_DELIVERED, "a press before the call of a region is delivered");
    sp_region_focus(region);
    check(window.firstResponder == browserPage, "a region called to focus during a press keeps the keyboard where it is");
    check(sp_input_pointer(window, 600, 250, 3, 0, 0, 0) == SP_INPUT_DELIVERED, "the release after the call of a region is delivered");
    check(window.firstResponder == (NSResponder *)region, "the release gives the keyboard to the region that asked for it");

    // A surface that hides keeps the frame of its last placement, and that frame can lie under a press elsewhere in the window. A
    // region that does not show takes no press: the view that the press reached keeps the keyboard, so the press stays open in it.
    void *hiddenHost = sp_surface_create(composition);
    webviewSetFrame(hiddenHost, 0, 0, 800, 500);
    webviewSetSurfaceHidden(hiddenHost, false);
    void *hidden = sp_region_create(hiddenHost, "hidden", regionEvent, NULL);
    check(hidden != NULL, "the image region of the surface that hides is created");
    placeRegion(hidden);
    webviewSetSurfaceHidden(hiddenHost, true);
    check(window.firstResponder == (NSResponder *)region, "a region of a hidden surface leaves the keyboard where it is");
    check(sp_input_pointer(window, 600, 250, 1, 0, 0, 0) == SP_INPUT_DELIVERED, "a press over the frame of the hidden region is delivered");
    [NSRunLoop.mainRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    check(window.firstResponder == browserPage, "a press over the frame of a hidden region stays with the view that it reached");
    check(sp_input_pointer(window, 600, 250, 3, 0, 0, 0) == SP_INPUT_DELIVERED, "the release over the frame of the hidden region is delivered");
    sp_region_close(hidden);

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

    // A surface hidden and shown again before its region shows: the page held the keyboard for want of a region, and nothing
    // chose it by the return.
    sp_window_focus_workbench(window);
    void *waitingHost = sp_surface_create(composition);
    webviewSetFrame(waitingHost, 0, 0, 400, 500);
    webviewSetSurfaceHidden(waitingHost, false);
    WKWebView *waitingPage = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 500)] autorelease];
    check(sp_surface_place_view(waitingHost, waitingPage), "the page of the surface that waits for its region is placed");
    sp_surface_focus(waitingHost);
    check(window.firstResponder == waitingPage, "the page holds the keyboard for want of a region");
    webviewSetSurfaceHidden(waitingHost, true);
    webviewSetSurfaceHidden(waitingHost, false);
    check(window.firstResponder == waitingPage, "the surface that shows again gives the keyboard back to its page");
    void *waited = sp_region_create(waitingHost, "view", regionEvent, NULL);
    placeRegion(waited);
    check(window.firstResponder == (NSResponder *)waited, "the first region that shows after a hide takes the keyboard from the page");
    sp_window_focus_workbench(window);
    sp_surface_focus(waitingHost);
    check(window.firstResponder == (NSResponder *)waited, "the keyboard returns to the region that took it after a hide");
    sp_region_close(waited);

    // The region shows while the surface is hidden, and the surface shows after it.
    sp_surface_focus(waitingHost);
    check(window.firstResponder == waitingPage, "the page holds the keyboard again for want of a region");
    webviewSetSurfaceHidden(waitingHost, true);
    void *behind = sp_region_create(waitingHost, "view", regionEvent, NULL);
    placeRegion(behind);
    webviewSetSurfaceHidden(waitingHost, false);
    check(window.firstResponder == (NSResponder *)behind, "a region that showed behind the hidden surface takes the keyboard when the surface shows");
    sp_region_close(behind);

    // A surface that declared a region takes keys before the region shows: nothing reaches the page, and the region receives
    // them in order when it shows.
    sp_window_focus_workbench(window);
    void *holdingHost = sp_surface_create(composition);
    webviewSetFrame(holdingHost, 0, 0, 400, 500);
    webviewSetSurfaceHidden(holdingHost, false);
    WKWebView *holdingPage = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 500)] autorelease];
    check(sp_surface_place_view(holdingHost, holdingPage), "the page of the surface that declared a region is placed");
    sp_surface_focus_for_region(holdingHost);
    check(window.firstResponder != holdingPage, "a surface that declared a region keeps the keyboard from its page");
    typeKeys(window, "echo");
    void *holdingRegion = sp_region_create(holdingHost, "view", regionEvent, NULL);
    check(holdingRegion != NULL, "the declared region is created");
    NSString *notShown = regionKeys(^{ [NSRunLoop.mainRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]]; });
    check(notShown.length == 0, "a region that does not show receives no key");
    NSString *received = regionKeys(^{ placeRegion(holdingRegion); });
    check(window.firstResponder == (NSResponder *)holdingRegion, "the declared region takes the keyboard when it shows");
    check([received isEqual:@"echo"], [NSString stringWithFormat:@"the region receives the keys in order (got %@)", received].UTF8String);
    NSString *following = regionKeys(^{ typeKeys(window, "x"); });
    check([following isEqual:@"x"], [NSString stringWithFormat:@"a later key follows the kept keys (got %@)", following].UTF8String);
    sp_region_close(holdingRegion);

    // The surface hides while it keeps keys, and its region shows when the surface shows again.
    void *keepingHost = sp_surface_create(composition);
    webviewSetFrame(keepingHost, 0, 0, 400, 500);
    webviewSetSurfaceHidden(keepingHost, false);
    WKWebView *keepingPage = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 500)] autorelease];
    check(sp_surface_place_view(keepingHost, keepingPage), "the page of the surface that hides with kept keys is placed");
    sp_surface_focus_for_region(keepingHost);
    typeKeys(window, "ls");
    webviewSetSurfaceHidden(keepingHost, true);
    void *keepingRegion = sp_region_create(keepingHost, "view", regionEvent, NULL);
    NSString *whileHidden = regionKeys(^{ placeRegion(keepingRegion); });
    check(whileHidden.length == 0, "a region of a hidden surface receives no kept key");
    NSString *afterHide = regionKeys(^{
        webviewSetSurfaceHidden(keepingHost, false);
        placeRegion(keepingRegion);
    });
    check(window.firstResponder == (NSResponder *)keepingRegion, "the region takes the keyboard when its surface shows again");
    check([afterHide isEqual:@"ls"], [NSString stringWithFormat:@"the region receives the keys kept through the hide (got %@)", afterHide].UTF8String);
    sp_region_close(keepingRegion);

    // The keyboard leaves before the region shows: the keys were typed into this surface, and its region still receives them.
    void *leftHost = sp_surface_create(composition);
    webviewSetFrame(leftHost, 0, 0, 400, 500);
    webviewSetSurfaceHidden(leftHost, false);
    WKWebView *leftPage = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 500)] autorelease];
    check(sp_surface_place_view(leftHost, leftPage), "the page of the surface that the keyboard leaves is placed");
    sp_surface_focus_for_region(leftHost);
    typeKeys(window, "ab");
    sp_window_focus_workbench(window);
    void *leftRegion = sp_region_create(leftHost, "view", regionEvent, NULL);
    NSString *receivedLater = regionKeys(^{ placeRegion(leftRegion); });
    check(window.firstResponder == main, "a region that shows takes no keyboard from the workbench it left to");
    check([receivedLater isEqual:@"ab"], [NSString stringWithFormat:@"the region receives the keys typed before the keyboard left (got %@)", receivedLater].UTF8String);
    sp_region_close(leftRegion);

    // A surface keeps 256 keys. The keys after them are dropped and recorded, and the region receives the first 256 in order.
    void *fullHost = sp_surface_create(composition);
    webviewSetFrame(fullHost, 0, 0, 400, 500);
    webviewSetSurfaceHidden(fullHost, false);
    WKWebView *fullPage = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 500)] autorelease];
    check(sp_surface_place_view(fullHost, fullPage), "the page of the surface that keeps too many keys is placed");
    sp_surface_focus_for_region(fullHost);
    NSArray<NSDictionary *> *filling = capturedEvents(^{
        for (int count = 0; count < 257; count++) {
            sp_input_key(window, "a", "a", 0, true);
            sp_input_key(window, "a", "a", 0, false);
        }
    });
    NSUInteger dropsWhenFull = 0;
    for (NSDictionary *event in filling) {
        if ([event[@"name"] isEqual:@"native.surface.keys_dropped"] && [event[@"fields"][@"reason"] isEqual:@"full"]) dropsWhenFull++;
    }
    check(dropsWhenFull == 1, "the first key over the limit is recorded as dropped");
    void *fullRegion = sp_region_create(fullHost, "view", regionEvent, NULL);
    NSString *keptKeys = regionKeys(^{ placeRegion(fullRegion); });
    check(keptKeys.length == 256, [NSString stringWithFormat:@"the region receives the 256 kept keys (got %lu)", (unsigned long)keptKeys.length].UTF8String);
    sp_region_close(fullRegion);

    // A surface that closes without a region drops its keys and records how many.
    void *closedHost = sp_surface_create(composition);
    webviewSetFrame(closedHost, 0, 0, 400, 500);
    webviewSetSurfaceHidden(closedHost, false);
    WKWebView *closedPage = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 500)] autorelease];
    check(sp_surface_place_view(closedHost, closedPage), "the page of the surface that closes without a region is placed");
    sp_surface_focus_for_region(closedHost);
    typeKeys(window, "abc");
    NSArray<NSDictionary *> *closingEvents = capturedEvents(^{ sp_surface_close(closedHost); });
    BOOL dropsWhenClosed = NO;
    for (NSDictionary *event in closingEvents) {
        if ([event[@"name"] isEqual:@"native.surface.keys_dropped"] && [event[@"fields"][@"reason"] isEqual:@"closed"]
            && [event[@"fields"][@"count"] intValue] == 3) dropsWhenClosed = YES;
    }
    check(dropsWhenClosed, "a surface that closes without a region records the keys it drops");
    sp_window_focus_workbench(window);

    // A press of a surface whose page holds the keyboard when its region shows, and a call that follows in the press.
    sp_surface_focus(waitingHost);
    check(window.firstResponder == waitingPage, "the page holds the keyboard before the press");
    check(sp_input_pointer(window, 600, 250, 1, 0, 0, 0) == SP_INPUT_DELIVERED, "a press while the page holds the keyboard is delivered");
    void *during = sp_region_create(waitingHost, "view", regionEvent, NULL);
    placeRegion(during);
    sp_surface_focus(waitingHost);
    check(sp_input_pointer(window, 600, 250, 3, 0, 0, 0) == SP_INPUT_DELIVERED, "the release of that press is delivered");
    check(window.firstResponder == (NSResponder *)during, "a call in a press does not undo the region that showed in it");
    sp_region_close(during);
    sp_surface_close(waitingHost);

    // A region that hides with the keyboard leaves it with the window, where no key has a view, and takes it back as it shows.
    void *hiding = sp_region_create(browserHost, "hiding", regionEvent, NULL);
    placeRegion(hiding);
    check([window makeFirstResponder:(NSResponder *)hiding], "the region takes the keyboard before it hides");
    sp_region_place(hiding, 0, 0, 0, 0, false);
    [NSRunLoop.mainRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    check(window.firstResponder == window, "AppKit gives the keyboard of a region that hides to the window");
    placeRegion(hiding);
    check(window.firstResponder == (NSResponder *)hiding, "a region that shows again takes back the keyboard it lost to its hide");
    // The keyboard that moved on while the region was hidden stays where it went.
    sp_region_place(hiding, 0, 0, 0, 0, false);
    [NSRunLoop.mainRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    sp_window_focus_workbench(window);
    placeRegion(hiding);
    check(window.firstResponder == main, "a region that shows again takes no keyboard that moved on");
    sp_region_close(hiding);

    // A window that closes takes no keyboard. The region of its surface stays alive until the host closes it, so the owner of
    // the surface is still readable: a call that follows it would put the first responder into a window that gets no key.
    NSWindow *closing = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 800, 500)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    closing.releasedWhenClosed = NO;
    WKWebView *closingMain = [[[WKWebView alloc] initWithFrame:closing.contentView.bounds] autorelease];
    [closing.contentView addSubview:closingMain];
    void *closingObservation = sp_window_observe_responder(closing, ^{});
    void *closingComposition = sp_window_set_main_webview(closing, closingMain);
    void *ownedHost = sp_surface_create(closingComposition);
    void *otherHost = sp_surface_create(closingComposition);
    webviewSetFrame(ownedHost, 0, 0, 400, 500);
    webviewSetFrame(otherHost, 400, 0, 400, 500);
    webviewSetSurfaceHidden(ownedHost, false);
    webviewSetSurfaceHidden(otherHost, false);
    WKWebView *ownedPage = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 500)] autorelease];
    WKWebView *otherPage = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 500)] autorelease];
    check(sp_surface_place_view(ownedHost, ownedPage), "the page of a surface of the second window is placed");
    check(sp_surface_place_view(otherHost, otherPage), "the page of the other surface of the second window is placed");
    void *ownedRegion = sp_region_create(ownedHost, "view", regionEvent, NULL);
    placeRegion(ownedRegion);
    sp_surface_focus(ownedHost);
    check(closing.firstResponder == (NSResponder *)ownedRegion, "the region of the second window takes the keyboard");
    sp_surface_focus(otherHost);
    check(closing.firstResponder == otherPage, "the other surface of the second window takes the keyboard");
    // A call that waits for the release of a press when the window closes.
    check(sp_input_pointer(closing, 600, 250, 1, 0, 0, 0) == SP_INPUT_DELIVERED, "a press in the second window is delivered");
    sp_surface_focus(ownedHost);
    check(closing.firstResponder == otherPage, "the press keeps the keyboard where it is");
    [closing close];
    sp_input_pointer(closing, 600, 250, 3, 0, 0, 0);
    sp_surface_press_released(closing);
    check(closing.firstResponder == otherPage, "a call that waited for the release of a press does not move in a closed window");
    sp_surface_focus(ownedHost);
    check(closing.firstResponder == otherPage, "a surface of a closed window does not take the keyboard");
    sp_surface_region_focus(ownedRegion);
    check(closing.firstResponder == otherPage, "a region of a closed window does not take the keyboard");
    // A window that shows again takes the keyboard as before.
    [closing orderBack:nil];
    sp_surface_focus(ownedHost);
    check(closing.firstResponder == (NSResponder *)ownedRegion, "a window that shows again gives the keyboard to its surface");
    [closing close];
    sp_region_close(ownedRegion);
    sp_window_end_responder_observation(closingObservation);

    // The input of a window waits for the decision of the workbench from the release of a press on the workbench
    // (docs/spec/native-surfaces.md#keyboard-of-a-surface). The workbench of this window is the left half, its surface the right.
    NSWindow *holding = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 800, 500)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    holding.releasedWhenClosed = NO;
    WKWebView *holdingMain = [[[WKWebView alloc] initWithFrame:holding.contentView.bounds] autorelease];
    [holding.contentView addSubview:holdingMain];
    void *holdingObservation = sp_window_observe_responder(holding, ^{});
    void *holdingComposition = sp_window_set_main_webview(holding, holdingMain);
    void *heldHost = sp_surface_create(holdingComposition);
    webviewSetFrame(heldHost, 400, 0, 400, 500);
    webviewSetSurfaceHidden(heldHost, false);
    WKWebView *heldPage = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 500)] autorelease];
    check(sp_surface_place_view(heldHost, heldPage), "the page of the surface of the holding window is placed");
    void *heldRegion = sp_region_create(heldHost, "view", regionEvent, NULL);
    placeRegion(heldRegion);
    sp_window_focus_workbench(holding);
    check(holding.firstResponder == holdingMain, "the workbench of the holding window holds the keyboard");

    // A press on a surface holds nothing: the key that follows its release reaches the region at once.
    NSString *unheld = regionKeys(^{
        sp_input_pointer(holding, 600, 250, 1, 0, 0, 0);
        sp_input_pointer(holding, 600, 250, 3, 0, 0, 0);
        [holding makeFirstResponder:(NSResponder *)heldRegion];
        typeKeys(holding, "x");
    });
    check([unheld isEqual:@"x"], "a key after the release of a press on a surface reaches the region at once");
    sp_window_focus_workbench(holding);

    // A press on a child web view of the application that no surface holds, a modal document, holds nothing either: the document
    // of the child answers no keyboard decision of the workbench, so the release of that press must not open the decision hold
    // (webview_geometry.m pressOnWorkbench). Without this, every later input of the window waits for a decision that never comes.
    [holdingMain loadHTMLString:@"<html></html>" baseURL:[NSURL URLWithString:@"http://localhost/"]];
    runEvents(0.2);
    void *child = nativeWebviewCreate((uintptr_t)holding, 77, "modal:test", "", 0, 0, 400, 500, false, false);
    check(child != NULL, "the child web view of the modal is created");
    if (child) {
        NSString *modal = regionKeys(^{
            check(sp_input_pointer(holding, 200, 250, 1, 0, 0, 0) == SP_INPUT_DELIVERED, "a press on the modal child is delivered");
            check(sp_input_pointer(holding, 200, 250, 3, 0, 0, 0) == SP_INPUT_DELIVERED, "its release is delivered");
            [holding makeFirstResponder:(NSResponder *)heldRegion];
            typeKeys(holding, "z");
            runQueuedEvents();
        });
        check([modal isEqual:@"z"], [NSString stringWithFormat:@"a key after the release of a press on a modal child reaches the region at once, got \"%@\"", modal].UTF8String);
        check(holding.firstResponder == (NSResponder *)heldRegion, "a press on the modal child leaves the keyboard where the test put it");
        nativeWebviewClose(child);
    }
    sp_window_focus_workbench(holding);

    // R1: the keys after the release of a press on the workbench wait for the decided call and reach its target in order.
    NSString *waiting = regionKeys(^{
        check(sp_input_pointer(holding, 200, 250, 1, 0, 0, 0) == SP_INPUT_DELIVERED, "a press on the workbench is delivered");
        check(sp_input_pointer(holding, 200, 250, 3, 0, 0, 0) == SP_INPUT_DELIVERED, "its release is delivered");
        typeKeys(holding, "abcdefghijklm");
        runQueuedEvents();
    });
    check([waiting isEqual:@""], [NSString stringWithFormat:@"no key reaches the region before the decision, got \"%@\"", waiting].UTF8String);
    NSString *decided = regionKeys(^{
        sp_surface_focus(heldHost);
        sp_window_keyboard_decided(holding);
        runQueuedEvents();
    });
    check([decided isEqual:@"abcdefghijklm"],
        [NSString stringWithFormat:@"the 13 keys reach the region of the decided surface in order, got \"%@\"", decided].UTF8String);
    NSString *after = regionKeys(^{ typeKeys(holding, "y"); });
    check([after isEqual:@"y"], "a key after the decision reaches the region at once");

    // R3: a call without the decision moves the keyboard and the keys keep waiting. R2: time does not end a hold: the keys still
    // wait more than a second later, nothing is recorded for the wait, and the decided call gives them to its target in order.
    sp_window_focus_workbench(holding);
    __block NSString *undecided = nil;
    NSArray<NSDictionary *> *heldEvents = capturedEvents(^{
        undecided = [regionKeys(^{
            sp_input_pointer(holding, 200, 250, 1, 0, 0, 0);
            sp_input_pointer(holding, 200, 250, 3, 0, 0, 0);
            typeKeys(holding, "abc");
            sp_surface_focus(heldHost);
            runQueuedEvents();
        }) retain];
        check(holding.firstResponder == (NSResponder *)heldRegion, "a call without the decision moves the keyboard");
        runEvents(1.5);
    });
    [undecided autorelease];
    check([undecided isEqual:@""], [NSString stringWithFormat:@"the keys wait after a call without the decision, got \"%@\"", undecided].UTF8String);
    NSMutableString *early = [NSMutableString string];
    for (NSDictionary *event in heldEvents) {
        if ([event[@"name"] isEqual:@"native.input.key_down"]) [early appendString:event[@"fields"][@"characters"]];
        check(![event[@"name"] hasPrefix:@"native.keyboard.hold_"],
            [NSString stringWithFormat:@"a hold that waits records nothing, got %@", event[@"name"]].UTF8String);
    }
    check([early isEqual:@""], [NSString stringWithFormat:@"no key reaches the region 1.5 s into a hold, got \"%@\"", early].UTF8String);
    NSString *late = regionKeys(^{
        sp_window_keyboard_decided(holding);
        runQueuedEvents();
    });
    check([late isEqual:@"abc"], [NSString stringWithFormat:@"the decided call gives the waiting keys in order, got \"%@\"", late].UTF8String);

    // A hold keeps 256 pieces of input and records the rest as dropped.
    sp_window_focus_workbench(holding);
    __block NSUInteger delivered = 0;
    NSArray<NSDictionary *> *overflow = capturedEvents(^{
        sp_window_keyboard_hold(holding);
        for (int i = 0; i < 150; i++) {
            sp_input_key(holding, "k", "k", 0, true);
            sp_input_key(holding, "k", "k", 0, false);
        }
        sp_surface_focus(heldHost);
        sp_window_keyboard_decided(holding);
        runQueuedEvents();
    });
    for (NSDictionary *event in overflow) delivered += [event[@"name"] isEqual:@"native.input.key_down"];
    NSDictionary *droppedFields = eventFields(overflow, @"native.keyboard.hold_dropped");
    check(delivered == 128 && [droppedFields[@"count"] intValue] == 44 && [droppedFields[@"reason"] isEqual:@"full"],
        [NSString stringWithFormat:@"a full hold gives back 128 keys and drops 44 events, got %lu and %@", (unsigned long)delivered, droppedFields].UTF8String);

    // M1: the input waits from the show of a modal until the modal takes the keyboard (docs/spec/native-modals.md#keyboard). The
    // decided call of the workbench does not end the wait; the end of the modal hold gives the keys in order to the view that
    // took the keyboard, the region here standing for the modal web view.
    sp_window_focus_workbench(holding);
    NSString *beforeModal = regionKeys(^{
        sp_window_modal_hold(holding);
        typeKeys(holding, "pq");
        sp_window_keyboard_decided(holding);
        runQueuedEvents();
    });
    check([beforeModal isEqual:@""],
        [NSString stringWithFormat:@"no key passes before the modal takes the keyboard, also after a decided call, got \"%@\"", beforeModal].UTF8String);
    NSString *modalTook = regionKeys(^{
        [holding makeFirstResponder:(NSResponder *)heldRegion];
        sp_window_modal_hold_end(holding);
        runQueuedEvents();
    });
    check([modalTook isEqual:@"pq"],
        [NSString stringWithFormat:@"the end of the modal hold gives the keys to the view that took the keyboard, got \"%@\"", modalTook].UTF8String);

    // M2: a modal hold that ends while the decision of the workbench waits leaves the keys waiting for the decided call.
    sp_window_focus_workbench(holding);
    NSString *stillDeciding = regionKeys(^{
        sp_window_keyboard_hold(holding);
        sp_window_modal_hold(holding);
        typeKeys(holding, "rs");
        sp_window_modal_hold_end(holding);
        runQueuedEvents();
    });
    check([stillDeciding isEqual:@""],
        [NSString stringWithFormat:@"the keys wait for the decision after the modal hold ended, got \"%@\"", stillDeciding].UTF8String);
    NSString *bothEnded = regionKeys(^{
        sp_surface_focus(heldHost);
        sp_window_keyboard_decided(holding);
        runQueuedEvents();
    });
    check([bothEnded isEqual:@"rs"],
        [NSString stringWithFormat:@"the decided call gives the keys in order once the modal hold ended, got \"%@\"", bothEnded].UTF8String);
    NSString *free = regionKeys(^{
        sp_window_modal_hold_end(holding);
        typeKeys(holding, "t");
    });
    check([free isEqual:@"t"], "the end of a modal hold that a window does not hold changes nothing");

    // A window that closes with a hold drops what it held.
    NSArray<NSDictionary *> *closedHold = capturedEvents(^{
        sp_window_keyboard_hold(holding);
        typeKeys(holding, "z");
        [holding close];
        runQueuedEvents();
    });
    NSDictionary *closedFields = eventFields(closedHold, @"native.keyboard.hold_dropped");
    check([closedFields[@"count"] intValue] == 2 && [closedFields[@"reason"] isEqual:@"closed"],
        [NSString stringWithFormat:@"a closed window drops the 2 held key events, got %@", closedFields].UTF8String);
    sp_region_close(heldRegion);
    sp_window_end_responder_observation(holdingObservation);

    sp_window_end_responder_observation(observation);
    return failures ? 1 : 0;
} }
