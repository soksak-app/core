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
#import "support/event_wait.h"

static int failures;
static void runDirectly(void (^work)(void)) { work(); }

// A view that takes the first responder, as the view of a framework that draws the workbench does.
@interface SPKeyView : NSView
@end
@implementation SPKeyView
- (BOOL)acceptsFirstResponder { return YES; }
@end
// A web view that records the characters of the key downs that reach it, as a modal web view that takes the keyboard does.
@interface SPKeyWebView : WKWebView
@property(nonatomic, retain) NSMutableString *typed;
@end
@implementation SPKeyWebView
- (void)keyDown:(NSEvent *)event { [self.typed appendString:event.characters ?: @""]; }
- (void)keyUp:(NSEvent *)event { (void)event; }
- (void)dealloc { [_typed release]; [super dealloc]; }
@end
static void check(BOOL ok, const char *message) {
    fprintf(ok ? stdout : stderr, "%s: %s\n", ok ? "PASS" : "FAIL", message);
    if (!ok) failures++;
}

static void regionEvent(void *context, const char *json) {
    (void)context;
    (void)json;
}

// Notifies when the load of a page finishes.
@interface SPLoaded : NSObject <WKNavigationDelegate>
@property BOOL finished;
@end
@implementation SPLoaded
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
    (void)view;
    (void)navigation;
    self.finished = YES;
}
@end

// Runs the main loop until a block of the main queue sent now has run. The blocks that a change sent to the main queue or to
// the run loop before it have run then, and the run loop observers of AppKit and Core Animation run when that turn ends.
static void afterMainTurn(NSString *what) {
    __block BOOL ran = NO;
    dispatch_async(dispatch_get_main_queue(), ^{ ran = YES; });
    eventWait(what, ^BOOL { return ran; });
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

// A left press and its release on the workbench of window, the left half of its content.
static void releaseOnWorkbench(NSWindow *window) {
    check(sp_input_pointer(window, 200, 250, 1, 0, 0, 0) == SP_INPUT_DELIVERED, "a press on the workbench is delivered");
    check(sp_input_pointer(window, 200, 250, 3, 0, 0, 0) == SP_INPUT_DELIVERED, "its release is delivered");
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

// Runs the event queue of the application for the interval, for a hold that must outlast it. The interval is the subject of
// the check that no time ends a wait, so it is a measured window: a block of the main queue ends it.
static void runEvents(NSTimeInterval interval) {
    __block BOOL passed = NO;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(interval * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{ passed = YES; });
    eventWait([NSString stringWithFormat:@"%.1f s pass while the keys wait", interval], ^BOOL { return passed; });
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
    afterMainTurn(@"a turn of the main loop after the placement of the region");
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
    afterMainTurn(@"a turn of the main loop after the press over the frame of the hidden region");
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
    NSString *notShown = regionKeys(^{ afterMainTurn(@"a turn of the main loop after the creation of the declared region"); });
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
    afterMainTurn(@"a turn of the main loop after the region hides");
    check(window.firstResponder == window, "AppKit gives the keyboard of a region that hides to the window");
    placeRegion(hiding);
    check(window.firstResponder == (NSResponder *)hiding, "a region that shows again takes back the keyboard it lost to its hide");
    // The keyboard that moved on while the region was hidden stays where it went.
    sp_region_place(hiding, 0, 0, 0, 0, false);
    afterMainTurn(@"a turn of the main loop after the region hides again");
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

    // The keys of a window wait for the decision of the workbench from the release of a press on the workbench
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

    // A press on a surface lets no key wait: the key that follows its release reaches the region at once.
    NSString *unheld = regionKeys(^{
        sp_input_pointer(holding, 600, 250, 1, 0, 0, 0);
        sp_input_pointer(holding, 600, 250, 3, 0, 0, 0);
        [holding makeFirstResponder:(NSResponder *)heldRegion];
        typeKeys(holding, "x");
    });
    check([unheld isEqual:@"x"], "a key after the release of a press on a surface reaches the region at once");
    sp_window_focus_workbench(holding);

    // A press on a modal web view lets no key wait either: the modal takes the keyboard itself, and its document owes no decision of
    // the workbench (docs/spec/native-modals.md#keyboard). The modal stands over the workbench half, above the main web view.
    WKWebView *modal = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 500)] autorelease];
    [holding.contentView addSubview:modal positioned:NSWindowAbove relativeTo:nil];
    NSString *unheldModal = regionKeys(^{
        check(sp_input_pointer(holding, 200, 250, 1, 0, 0, 0) == SP_INPUT_DELIVERED, "a press on the modal web view is delivered");
        check(sp_input_pointer(holding, 200, 250, 3, 0, 0, 0) == SP_INPUT_DELIVERED, "its release is delivered");
        [holding makeFirstResponder:(NSResponder *)heldRegion];
        typeKeys(holding, "m");
        runQueuedEvents();
    });
    check([unheldModal isEqual:@"m"],
        [NSString stringWithFormat:@"a key after the release of a press on a modal web view reaches the region at once, got \"%@\"", unheldModal].UTF8String);
    [modal removeFromSuperview];
    // A press on a child web view of the application that no surface holds, a modal document, lets no key wait either: the
    // document of the child answers no keyboard decision of the workbench, so the release of that press asks for none
    // (webview_geometry.m pressOnWorkbench). Without this, every later key of the window waits for a decision that never comes.
    SPLoaded *holdingLoad = [[SPLoaded new] autorelease];
    holdingMain.navigationDelegate = holdingLoad;
    [holdingMain loadHTMLString:@"<html></html>" baseURL:[NSURL URLWithString:@"http://localhost/"]];
    eventWait(@"the load of the workbench page of the holding window finishes", ^BOOL { return holdingLoad.finished; });
    holdingMain.navigationDelegate = nil;
    void *child = nativeWebviewCreate((uintptr_t)holding, 77, "modal:test", "", 0, 0, 400, 500, false, false);
    check(child != NULL, "the child web view of the modal is created");
    if (child) {
        NSString *modalKeys = regionKeys(^{
            check(sp_input_pointer(holding, 200, 250, 1, 0, 0, 0) == SP_INPUT_DELIVERED, "a press on the modal child is delivered");
            check(sp_input_pointer(holding, 200, 250, 3, 0, 0, 0) == SP_INPUT_DELIVERED, "its release is delivered");
            [holding makeFirstResponder:(NSResponder *)heldRegion];
            typeKeys(holding, "z");
            runQueuedEvents();
        });
        check([modalKeys isEqual:@"z"], [NSString stringWithFormat:@"a key after the release of a press on a modal child reaches the region at once, got \"%@\"", modalKeys].UTF8String);
        check(holding.firstResponder == (NSResponder *)heldRegion, "a press on the modal child leaves the keyboard where the test put it");
        nativeWebviewClose(child);
    }
    sp_window_focus_workbench(holding);

    // R1: the keys after the release of a press on the workbench wait for the decided call and reach its target in order.
    NSString *waiting = regionKeys(^{
        releaseOnWorkbench(holding);
        typeKeys(holding, "abcdefghijklm");
        runQueuedEvents();
    });
    check([waiting isEqual:@""], [NSString stringWithFormat:@"no key reaches the region before the decision, got \"%@\"", waiting].UTF8String);
    NSString *decided = regionKeys(^{
        sp_surface_focus(heldHost);
        sp_window_keys_decided(holding);
        runQueuedEvents();
    });
    check([decided isEqual:@"abcdefghijklm"],
        [NSString stringWithFormat:@"the 13 keys reach the region of the decided surface in order, got \"%@\"", decided].UTF8String);
    NSString *after = regionKeys(^{ typeKeys(holding, "y"); });
    check([after isEqual:@"y"], "a key after the decision reaches the region at once");

    // R3: a call without the decision moves the keyboard and the keys keep waiting. R2: time does not end a wait: the keys still
    // wait more than a second later, nothing is recorded for the wait, and the decided call gives them to its target in order.
    sp_window_focus_workbench(holding);
    __block NSString *undecided = nil;
    NSArray<NSDictionary *> *heldEvents = capturedEvents(^{
        undecided = [regionKeys(^{
            releaseOnWorkbench(holding);
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
        check(![event[@"name"] hasPrefix:@"native.keyboard."],
            [NSString stringWithFormat:@"a wait records nothing, got %@", event[@"name"]].UTF8String);
    }
    check([early isEqual:@""], [NSString stringWithFormat:@"no key reaches the region 1.5 s into a wait, got \"%@\"", early].UTF8String);
    NSString *late = regionKeys(^{
        sp_window_keys_decided(holding);
        runQueuedEvents();
    });
    check([late isEqual:@"abc"], [NSString stringWithFormat:@"the decided call gives the waiting keys in order, got \"%@\"", late].UTF8String);

    // A refused surface still gives the keys: the decided call follows the move, also when the move finds no view.
    sp_window_focus_workbench(holding);
    NSString *refused = regionKeys(^{
        releaseOnWorkbench(holding);
        typeKeys(holding, "ef");
        [holding makeFirstResponder:(NSResponder *)heldRegion];
        sp_window_keys_decided(holding);
        runQueuedEvents();
    });
    check([refused isEqual:@"ef"], [NSString stringWithFormat:@"a decided call without a move gives the keys where the keyboard is, got \"%@\"", refused].UTF8String);

    // No pointer event waits for the decision: a move and a press after the release on the workbench reach their view at once.
    sp_window_focus_workbench(holding);
    releaseOnWorkbench(holding);
    NSString *moved = capturedRecords(^{ sp_input_pointer(holding, 600, 250, 0, 0, 0, 0); });
    check([moved containsString:@"\"kind\":\"pointer\""] && [moved containsString:@"\"phase\":0"],
        [NSString stringWithFormat:@"a move after the release on the workbench is delivered at once, got %@", moved].UTF8String);
    sp_input_pointer(holding, 600, 250, 1, 0, 0, 0);
    check(sp_input_press_open(holding, 0), "a press after the release on the workbench reaches its view at once");
    sp_input_pointer(holding, 600, 250, 3, 0, 0, 0);
    sp_window_keys_decided(holding);
    runQueuedEvents();
    check(!sp_input_press_open(holding, 0), "the press of the pointer check is released");
    // The press reached the page of the surface, which then holds the keyboard of the surface; the region takes it back.
    NSResponder *pressedHolder = holding.firstResponder;
    check([pressedHolder isKindOfClass:NSView.class] && [(NSView *)pressedHolder isDescendantOf:heldPage],
        "the press after the release on the workbench gives the keyboard to the page it reached");
    [holding makeFirstResponder:(NSResponder *)heldRegion];

    // A press of the window ends the wait: the keys that waited reach the view that holds the keyboard first, in their order, and
    // the press and its release follow them.
    sp_window_focus_workbench(holding);
    NSString *pressed = regionKeys(^{
        releaseOnWorkbench(holding);
        sp_surface_focus(heldHost);
        check(holding.firstResponder == (NSResponder *)heldRegion, "the call gives the keyboard to the region of the surface");
        typeKeys(holding, "gh");
        sp_input_pointer(holding, 600, 250, 1, 0, 0, 0);
        sp_input_pointer(holding, 600, 250, 3, 0, 0, 0);
        runQueuedEvents();
    });
    check([pressed isEqual:@"gh"], [NSString stringWithFormat:@"a press gives the waiting keys in order to the view that holds the keyboard, got \"%@\"", pressed].UTF8String);
    check(!sp_input_press_open(holding, 0), "the press that ended the wait and its release reached the window");
    [holding makeFirstResponder:(NSResponder *)heldRegion];
    NSString *afterPress = regionKeys(^{ typeKeys(holding, "i"); });
    check([afterPress isEqual:@"i"], [NSString stringWithFormat:@"a key after the press reaches the region at once, got \"%@\"", afterPress].UTF8String);

    // The end of the main page ends the wait: the keys go in their order to the view that holds the keyboard.
    sp_window_focus_workbench(holding);
    NSString *pageEnded = regionKeys(^{
        releaseOnWorkbench(holding);
        sp_surface_focus(heldHost);
        typeKeys(holding, "jk");
        runQueuedEvents();
        sp_window_keys_page_ended(holding);
        runQueuedEvents();
    });
    check([pageEnded isEqual:@"jk"], [NSString stringWithFormat:@"the end of the main page gives the waiting keys in order, got \"%@\"", pageEnded].UTF8String);
    NSString *noWait = regionKeys(^{
        sp_window_keys_page_ended(holding);
        typeKeys(holding, "l");
    });
    check([noWait isEqual:@"l"], "the end of a main page without a wait changes nothing");

    // No count ends a wait: 300 keys wait and all reach the decided target in order, and nothing is dropped.
    sp_window_focus_workbench(holding);
    __block NSUInteger delivered = 0;
    NSArray<NSDictionary *> *many = capturedEvents(^{
        releaseOnWorkbench(holding);
        for (int i = 0; i < 300; i++) {
            sp_input_key(holding, "k", "k", 0, true);
            sp_input_key(holding, "k", "k", 0, false);
        }
        sp_surface_focus(heldHost);
        sp_window_keys_decided(holding);
        runQueuedEvents();
    });
    BOOL anyDropped = NO;
    for (NSDictionary *event in many) {
        delivered += [event[@"name"] isEqual:@"native.input.key_down"];
        anyDropped = anyDropped || [event[@"name"] hasPrefix:@"native.keyboard."];
    }
    check(delivered == 300 && !anyDropped,
        [NSString stringWithFormat:@"300 keys that waited all reach the region and none is dropped, got %lu", (unsigned long)delivered].UTF8String);

    // M1: the keys wait from the show of a modal until the modal takes the keyboard (docs/spec/native-modals.md#keyboard). The
    // decided call of the workbench does not end the wait and does not take the keyboard from the modal: it records its target.
    // The end of the modal wait gives the keys in order to the modal that took the keyboard.
    SPKeyWebView *modalView = [[[SPKeyWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 500)] autorelease];
    modalView.typed = [NSMutableString string];
    sp_window_focus_workbench(holding);
    NSString *beforeModal = regionKeys(^{
        sp_window_modal_hold(holding);
        typeKeys(holding, "pq");
        sp_surface_focus(heldHost);
        sp_window_keys_decided(holding);
        runQueuedEvents();
    });
    check([beforeModal isEqual:@""] && modalView.typed.length == 0,
        [NSString stringWithFormat:@"no key passes before the modal takes the keyboard, also after a decided call, got \"%@\"", beforeModal].UTF8String);
    check(holding.firstResponder == holdingMain, "a decided call while the modal waits leaves the keyboard where it is");
    [holding.contentView addSubview:modalView positioned:NSWindowAbove relativeTo:nil];
    check([holding makeFirstResponder:modalView], "the modal web view takes the keyboard");
    sp_window_modal_hold_end(holding);
    runQueuedEvents();
    check([modalView.typed isEqual:@"pq"],
        [NSString stringWithFormat:@"the end of the modal wait gives the keys to the modal that took the keyboard, got \"%@\"", modalView.typed].UTF8String);

    // M3: while the modal holds the keyboard a call keeps it in the modal, and the close of the modal returns the keyboard to the
    // target of the last call.
    sp_window_focus_workbench(holding);
    sp_surface_focus(heldHost);
    check(holding.firstResponder == modalView, "a call while the modal holds the keyboard leaves it in the modal");
    check(sp_window_keyboard_after_modal(holding, modalView), "the close of the modal returns the keyboard");
    check(holding.firstResponder == (NSResponder *)heldRegion, "the close of the modal gives the keyboard to the target of the last call");
    [modalView removeFromSuperview];

    // M4: a show that fails ends the modal wait: the keyboard goes to the target of the call that came while the modal waited, and
    // the keys follow it in their order.
    sp_window_focus_workbench(holding);
    NSString *failedShow = regionKeys(^{
        sp_window_modal_hold(holding);
        sp_surface_focus(heldHost);
        typeKeys(holding, "uv");
        runQueuedEvents();
        sp_window_modal_hold_end(holding);
        runQueuedEvents();
    });
    check(holding.firstResponder == (NSResponder *)heldRegion, "the end of a modal wait without a modal gives the keyboard to the target of the call");
    check([failedShow isEqual:@"uv"], [NSString stringWithFormat:@"the keys reach that target in order, got \"%@\"", failedShow].UTF8String);

    // M2: a modal wait that ends while the decision of the workbench waits leaves the keys waiting for the decided call.
    sp_window_focus_workbench(holding);
    NSString *stillDeciding = regionKeys(^{
        releaseOnWorkbench(holding);
        sp_window_modal_hold(holding);
        typeKeys(holding, "rs");
        sp_window_modal_hold_end(holding);
        runQueuedEvents();
    });
    check([stillDeciding isEqual:@""],
        [NSString stringWithFormat:@"the keys wait for the decision after the modal wait ended, got \"%@\"", stillDeciding].UTF8String);
    NSString *bothEnded = regionKeys(^{
        sp_surface_focus(heldHost);
        sp_window_keys_decided(holding);
        runQueuedEvents();
    });
    check([bothEnded isEqual:@"rs"],
        [NSString stringWithFormat:@"the decided call gives the keys in order once the modal wait ended, got \"%@\"", bothEnded].UTF8String);
    NSString *free = regionKeys(^{
        sp_window_modal_hold_end(holding);
        typeKeys(holding, "t");
    });
    check([free isEqual:@"t"], "the end of a modal wait that a window does not have changes nothing");

    // A window that closes with a wait drops the keys, records how many, and answers each injected key that waited with its refusal.
    NSArray<NSDictionary *> *closedWait = capturedEvents(^{
        releaseOnWorkbench(holding);
        typeKeys(holding, "z");
        [holding close];
        runQueuedEvents();
    });
    NSDictionary *closedFields = eventFields(closedWait, @"native.keyboard.wait_dropped");
    check([closedFields[@"count"] intValue] == 2 && [closedFields[@"reason"] isEqual:@"closed"],
        [NSString stringWithFormat:@"a closed window drops the 2 waiting key events, got %@", closedFields].UTF8String);
    NSUInteger refusals = 0;
    for (NSDictionary *event in closedWait) {
        NSString *text = event[@"fields"][@"text"];
        if ([event[@"name"] isEqual:@"native.record.info"] && [text containsString:@"\"kind\":\"key\""]
            && [text containsString:@"\"result\":\"rejected\""]) refusals++;
    }
    check(refusals == 2, [NSString stringWithFormat:@"each dropped key answers with its refusal, got %lu", (unsigned long)refusals].UTF8String);
    sp_region_close(heldRegion);
    sp_window_end_responder_observation(holdingObservation);

    // A window without a main web view waits as well: the mygo workbench, a view of the framework, decides in the pass after
    // the release, so the keys that follow the release wait for its decided call.
    NSWindow *plain = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 800, 500)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    plain.releasedWhenClosed = NO;
    NSView *plainNative = (NSView *)sp_window_native_view(plain);
    [plain.contentView addSubview:plainNative];
    plainNative.frame = plain.contentView.bounds;
    SPKeyView *plainWorkbench = [[[SPKeyView alloc] initWithFrame:NSMakeRect(0, 0, 400, 500)] autorelease];
    [plain.contentView addSubview:plainWorkbench positioned:NSWindowAbove relativeTo:plainNative];
    void *plainObservation = sp_window_observe_responder(plain, ^{});
    void *plainHost = sp_surface_create(plainNative);
    webviewSetFrame(plainHost, 400, 0, 400, 500);
    webviewSetSurfaceHidden(plainHost, false);
    void *plainRegion = sp_region_create(plainHost, "view", regionEvent, NULL);
    placeRegion(plainRegion);
    sp_window_focus_workbench(plain);
    check(plain.firstResponder == plainWorkbench, "the view of the framework holds the keyboard of the window without a main web view");
    NSString *plainWaiting = regionKeys(^{
        releaseOnWorkbench(plain);
        typeKeys(plain, "wx");
        runQueuedEvents();
    });
    check([plainWaiting isEqual:@""], [NSString stringWithFormat:@"the keys of a window without a main web view wait for the decision, got \"%@\"", plainWaiting].UTF8String);
    NSString *plainDecided = regionKeys(^{
        sp_surface_focus(plainHost);
        sp_window_keys_decided(plain);
        runQueuedEvents();
    });
    check([plainDecided isEqual:@"wx"], [NSString stringWithFormat:@"the decided call gives them to the region in order, got \"%@\"", plainDecided].UTF8String);
    [plain close];
    sp_region_close(plainRegion);
    sp_surface_close(plainHost);
    sp_window_end_responder_observation(plainObservation);

    // A framework that draws the workbench removes its view when its window closes, while the window still shows (mygo removes it in
    // windowWillClose:). A move of the keyboard to the workbench that then arrives finds no view, and is no error: the window closes.
    NSWindow *framework = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 400, 300)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    framework.releasedWhenClosed = NO;
    SPKeyView *drawn = [[[SPKeyView alloc] initWithFrame:framework.contentView.bounds] autorelease];
    [framework.contentView addSubview:drawn];
    [framework orderBack:nil];
    sp_window_focus_workbench(framework);
    check(framework.firstResponder == drawn, "the view of a framework that draws the workbench takes the keyboard");
    __block BOOL shownWhileClosing = NO;
    __block NSArray<NSDictionary *> *closingFocus = nil;
    id closingObserver = [NSNotificationCenter.defaultCenter addObserverForName:NSWindowWillCloseNotification object:framework queue:nil
        usingBlock:^(NSNotification *note) {
            (void)note;
            [drawn removeFromSuperview];
            shownWhileClosing = framework.isVisible;
            closingFocus = [capturedEvents(^{ sp_window_focus_workbench(framework); }) retain];
        }];
    [framework close];
    [NSNotificationCenter.defaultCenter removeObserver:closingObserver];
    NSMutableArray<NSString *> *closingErrors = [NSMutableArray array];
    for (NSDictionary *event in closingFocus) {
        if ([event[@"name"] isEqual:@"native.record.error"]) [closingErrors addObject:event[@"fields"][@"text"] ?: @""];
    }
    check(shownWhileClosing, "the window still shows while it closes");
    check(closingFocus != nil && closingErrors.count == 0,
        [NSString stringWithFormat:@"a move to the workbench of a closing window whose view is gone records no error, got %@", closingErrors].UTF8String);
    [closingFocus release];

    sp_window_end_responder_observation(observation);
    return failures ? 1 : 0;
} }
