// Checks the virtual key window: with another application in front, a window at the back answers as the key window inside the
// application, hover, a press and a key reach its page as trusted events, the system key window stays, and the application does
// not take the front.
//
// The test process is never active. The value of the real activation is a replacement of isActive and the buttons of a person
// a replacement of pressedMouseButtons, both set before the virtual state replaces them, so these are what it reads as AppKit.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import "event_ring.h"
#import "input_inject.h"
#import "input_virtual.h"
#import "private/webkit.h"
#import "support/event_wait.h"
#import "support/records.h"
#import "webview_geometry.h"
#import "webview_input.h"
#import "window_facts.h"
#import "window_reveal.h"
#include <unistd.h>

// Sets the flag when the object that holds it ends, and wakes the wait of the main thread, since the end can come in a turn
// that does not end the wait by itself.
@interface EndWatch : NSObject
@property(assign) BOOL *ended;
@end
@implementation EndWatch
- (void)dealloc { *self.ended = YES; eventWake(); [super dealloc]; }
@end

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}
static id evaluate(WKWebView *view, NSString *script) {
    __block id out = nil;
    __block BOOL done = NO;
    [view evaluateJavaScript:script completionHandler:^(id result, NSError *error) { out = [(error ? error.localizedDescription : result) retain]; done = YES; }];
    eventWait([@"JavaScript answers " stringByAppendingString:script], ^BOOL { return done; });
    return [out autorelease];
}
// Waits until WebKit has given the page every mouse event that its view received before.
static void drain(WKWebView *view) {
    __block BOOL done = NO;
    [view _doAfterProcessingAllPendingMouseEvents:^{ done = YES; }];
    eventWait(@"WebKit has processed the pending mouse events", ^BOOL { return done; });
}
// Runs the main queue until a marker block queued after every block already on it has run.
static void drainMainQueue(NSString *what) {
    __block BOOL passed = NO;
    dispatch_async(dispatch_get_main_queue(), ^{ passed = YES; });
    eventWait(what, ^BOOL { return passed; });
}
static sp_input_result lastResult;
static BOOL lastDone;
// The answer can come from the timer of the receipt limit, which does not end a turn of the run loop.
static void onDone(void *context, sp_input_result result, const sp_input_held *held) { lastResult = result; lastDone = YES; eventWake(); }
static sp_input_result pointer(NSWindow *window, double x, double y, int phase) {
    lastDone = NO;
    sp_input_pointer_then(window, SP_INPUT_POINTER_MAIN, x, y, phase, 0, 0, 0, 1, 2, onDone, NULL);
    eventWait(@"the pointer input answers", ^BOOL { return lastDone; });
    return lastResult;
}

// The answers that this test gives in place of AppKit.
static BOOL reallyActive;
static NSUInteger personButtons;
static BOOL testIsActive(id self, SEL selector) { return reallyActive; }
static NSUInteger testButtons(id self, SEL selector) { return personButtons; }

static NSRect awayFromPointer(NSSize size, CGFloat shift) {
    NSRect screen = NSScreen.mainScreen.visibleFrame;
    NSPoint at = NSEvent.mouseLocation;
    CGFloat left = at.x < NSMidX(screen) ? NSMaxX(screen) - size.width - 20 - shift : NSMinX(screen) + 20 + shift;
    CGFloat bottom = at.y < NSMidY(screen) ? NSMaxY(screen) - size.height - 60 : NSMinY(screen) + 20;
    return NSMakeRect(left, bottom, size.width, size.height);
}
static NSWindow *makeWindow(CGFloat shift) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(420, 300), shift)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    return window;
}
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

// Waits until the page of view holds condition, a JavaScript expression. The page judges condition at once and again at each
// event of the type named type that reaches its window, after the listeners that the page added before, so the wait ends at
// the event of the page that makes condition hold.
static void awaitPage(WKWebView *view, NSString *what, NSString *type, NSString *condition) {
    NSString *body = [NSString stringWithFormat:@"if (%@) return true;"
        "await new Promise(resolve => {"
        " const heard = () => { if (%@) { removeEventListener(eventType, heard, true); resolve(); } };"
        " addEventListener(eventType, heard, true); });"
        "return true;", condition, condition];
    __block BOOL done = NO;
    [view callAsyncJavaScript:body arguments:@{ @"eventType": type } inFrame:nil inContentWorld:WKContentWorld.pageWorld
        completionHandler:^(id value, NSError *error) {
            (void)value;
            if (error) fprintf(stderr, "JavaScript: %s\n", error.localizedDescription.UTF8String);
            done = YES;
        }];
    eventWait(what, ^BOOL { return done; });
}

static NSString *const PAGE = @"<!doctype html><style>html,body{margin:0;height:100%}</style>"
    "<input id='field' style='position:absolute;left:10px;top:10px;width:200px;height:30px'>"
    "<button id='target' style='position:absolute;left:10px;top:60px;width:100px;height:40px'>x</button><script>"
    "window.events=[];for(const t of ['pointermove','pointerdown','pointerup','click','keydown','input'])"
    "addEventListener(t,e=>events.push({type:t,trusted:e.isTrusted,x:e.clientX,y:e.clientY,buttons:e.buttons,key:e.key}),true);</script>";
static WKWebView *makePage(NSWindow *window) {
    WKWebView *view = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 420, 300)] autorelease];
    [window.contentView addSubview:view];
    check(sp_window_set_main_webview(window, view) != NULL, @"the page is the main web view of its window");
    check(webviewInputRegister(view), @"the page registers for pointer input");
    loadPage(view, PAGE);
    return view;
}
// Waits until the page has loaded, so its listeners record the input that follows. A press after it answers at the receipt of
// the document, and a move or a key is judged at a later event of the page.
static void pageReady(WKWebView *view) { awaitLoad(view); }
// The types of the events that the page received, read after WebKit has given the page every mouse event that its view
// received before.
static NSArray *eventTypes(WKWebView *view) {
    drain(view);
    return evaluate(view, @"events.map(e=>e.type)");
}
// The facts of host.window; nil for a window without its composition, which has none (window_facts.h).
static NSDictionary *factsOf(NSWindow *window) {
    char *json = sp_window_facts(window, sp_window_composition(window));
    if (!json) return nil;
    NSDictionary *value = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json length:strlen(json)] options:0 error:NULL];
    free(json);
    return value;
}
static NSDictionary *facts(NSWindow *window) {
    NSDictionary *value = factsOf(window);
    check(value != nil, @"the window has facts");
    return value;
}
// Whether this process stayed behind: it is not the frontmost application and the system does not hold it as active. Which other
// application is in front belongs to the other processes, so the check judges only this process (docs/spec/exposure.md).
static BOOL stayedBehind(void) {
    return NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != getpid()
        && !NSRunningApplication.currentApplication.isActive;
}
// The events native.input.virtual that block writes with the given phase and reason.
static NSUInteger count(void (^block)(void), NSString *reason) {
    NSUInteger found = 0;
    for (NSDictionary *event in capturedEvents(block)) {
        if ([event[@"name"] isEqual:@"native.input.virtual"] && (!reason || [event[@"fields"][@"reason"] isEqual:reason])) found++;
    }
    return found;
}

// The methods that the virtual state replaces, and their implementations before the first entry.
static const SEL *windowSelectors(void) {
    static SEL selectors[5];
    selectors[0] = @selector(isKeyWindow);
    selectors[1] = @selector(isMainWindow);
    selectors[2] = @selector(orderFront:);
    selectors[3] = @selector(makeKeyAndOrderFront:);
    selectors[4] = @selector(orderFrontRegardless);
    return selectors;
}
static const SEL *applicationSelectors(void) {
    static SEL selectors[3];
    selectors[0] = @selector(isActive);
    selectors[1] = @selector(keyWindow);
    selectors[2] = @selector(mainWindow);
    return selectors;
}
static IMP windowMethods[5], applicationMethods[3], viewInputContext;
static BOOL unchanged(void) {
    if (viewInputContext != method_getImplementation(class_getInstanceMethod(NSView.class, @selector(inputContext)))) return NO;
    for (int i = 0; i < 5; i++) if (windowMethods[i] != method_getImplementation(class_getInstanceMethod(NSWindow.class, windowSelectors()[i]))) return NO;
    for (int i = 0; i < 3; i++) if (applicationMethods[i] != method_getImplementation(class_getInstanceMethod(NSApplication.class, applicationSelectors()[i]))) return NO;
    return YES;
}

int main(void) { @autoreleasepool {
    setvbuf(stdout, NULL, _IOLBF, 0);
    const int8_t everything[SP_CLASS_COUNT] = {SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE};
    check(sp_event_set_policy(everything), @"the policy stores every level of every class");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    method_setImplementation(class_getInstanceMethod(NSApplication.class, @selector(isActive)), (IMP)testIsActive);
    method_setImplementation(class_getClassMethod(NSEvent.class, @selector(pressedMouseButtons)), (IMP)testButtons);

    for (int i = 0; i < 5; i++) windowMethods[i] = method_getImplementation(class_getInstanceMethod(NSWindow.class, windowSelectors()[i]));
    for (int i = 0; i < 3; i++) applicationMethods[i] = method_getImplementation(class_getInstanceMethod(NSApplication.class, applicationSelectors()[i]));
    viewInputContext = method_getImplementation(class_getInstanceMethod(NSView.class, @selector(inputContext)));

    // A window that registered no page has no facts, and reading them fails the check instead of the process.
    NSWindow *bare = makeWindow(0);
    check(factsOf(bare) == nil, @"a window without its composition answers no facts");
    [bare release];

    NSWindow *window = makeWindow(0), *cover = makeWindow(0), *second = makeWindow(440);
    WKWebView *view = makePage(window);
    [window orderBack:nil];
    [cover orderBack:nil];
    [window orderWindow:NSWindowBelow relativeTo:cover.windowNumber];
    pageReady(view);
    const NSInteger orderBefore = window.orderedIndex;

    // Before the first entry nothing is replaced, and a press of a window at the back keeps direct delivery.
    check(pointer(window, 120, 80, 1) == SP_INPUT_DELIVERED && pointer(window, 120, 80, 3) == SP_INPUT_DELIVERED, @"a press and a release before the virtual state are delivered");
    check(unchanged(), @"a press does not replace a method");
    reallyActive = YES;
    NSUInteger refused = count(^{
        check(sp_input_pointer(window, 30, 30, 0, 0, 0, 0) == SP_INPUT_INACTIVE, @"an application that is really active answers 1006 for a window that is not its key window");
    }, nil);
    check(!sp_input_virtual_is(window) && unchanged(), @"real state wins: a refused move replaces no method");
    check(refused == 0, @"a refused move writes no virtual event");
    reallyActive = NO;
    check(!window.isKeyWindow && !NSApp.isActive && NSApp.keyWindow == nil, @"before the first entry AppKit answers");

    // Hover. WebKit updates :hover only for a page of the key window.
    evaluate(view, @"events.length=0;null");
    check(!NSPointInRect(NSEvent.mouseLocation, window.frame), @"the real pointer is outside the window");
    check(pointer(window, 300, 250, 0) == SP_INPUT_DELIVERED, @"a move of a window at the back enters the virtual state");
    check(!unchanged(), @"the first entry replaces the methods");
    check(window.isKeyWindow && window.isMainWindow && NSApp.isActive && NSApp.keyWindow == window && NSApp.mainWindow == window, @"the window answers as the key and main window of an active application");
    check(!cover.isKeyWindow && !second.isKeyWindow, @"another window does not answer as key");
    pointer(window, 40, 80, 0);
    pointer(window, 42, 82, 0);
    drain(view);
    check([evaluate(view, @"document.getElementById('target').matches(':hover')") boolValue], @"hover reaches the element under the point");
    NSArray *moves = evaluate(view, @"events.filter(e=>e.type==='pointermove')");
    check(moves.count > 0 && ![[moves valueForKey:@"trusted"] containsObject:@NO], [NSString stringWithFormat:@"moves are trusted page events (%lu)", (unsigned long)moves.count]);
    check([moves.lastObject[@"x"] doubleValue] == 42 && [moves.lastObject[@"y"] doubleValue] == 82, [NSString stringWithFormat:@"a move carries the injected point (%@)", moves.lastObject]);

    // The system state.
    NSDictionary *fact = facts(window);
    check([fact[@"key"] boolValue] == NO && [fact[@"active"] boolValue] == NO && [fact[@"virtualKey"] boolValue], [NSString stringWithFormat:@"host.window reports the system state and the virtual state: key %@ active %@ virtualKey %@", fact[@"key"], fact[@"active"], fact[@"virtualKey"]]);
    NSPoint screen = [window convertPointToScreen:NSMakePoint(42, 300 - 82)];
    check(fabs([fact[@"pointer"][@"x"] doubleValue] - screen.x) < 1, [NSString stringWithFormat:@"the pointer of host.window is the injected position (%@)", fact[@"pointer"]]);
    check(!sp_input_virtual_real_active() && !sp_input_virtual_real_key(window), @"AppKit keeps its answers");
    check(!sp_application_active(), @"sp_application_active reports the system state");
    check(stayedBehind(), [NSString stringWithFormat:@"the application does not take the front (frontmost pid %d, this pid %d)",
        NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier, getpid()]);

    // A real move does not reach the page; it passes the application as a person's move does.
    evaluate(view, @"events.length=0;null");
    [NSApp sendEvent:[NSEvent mouseEventWithType:NSEventTypeMouseMoved location:NSMakePoint(200, 40) modifierFlags:0
        timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil eventNumber:0 clickCount:0 pressure:0]];
    check([eventTypes(view) count] == 0, @"a move that passes the application does not reach a page of the virtual key window");

    // A press, focus and a key. The path through the application would drop each of them.
    __block NSUInteger monitored = 0;
    id monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown | NSEventMaskLeftMouseUp | NSEventMaskKeyDown handler:^NSEvent *(NSEvent *event) { monitored++; return event; }];
    evaluate(view, @"events.length=0;null");
    check(pointer(window, 100, 25, 1) == SP_INPUT_DELIVERED, @"a press reaches the page within its limit");
    check(pointer(window, 100, 25, 3) == SP_INPUT_DELIVERED, @"a release reaches the page within its limit");
    NSArray *gesture = eventTypes(view);
    check([gesture containsObject:@"pointerdown"] && [gesture containsObject:@"pointerup"] && [gesture containsObject:@"click"], [NSString stringWithFormat:@"the gesture reaches the page (%@)", [gesture componentsJoinedByString:@","]]);
    check([evaluate(view, @"document.activeElement.id") isEqual:@"field"], @"the press focuses the field");
    check(sp_input_key(window, "a", "a", 0, true) == SP_INPUT_DELIVERED && sp_input_key(window, "a", "a", 0, false) == SP_INPUT_DELIVERED, @"a key is delivered");
    awaitPage(view, @"the field takes the text a", @"input", @"document.getElementById('field').value === 'a'");
    check([evaluate(view, @"document.getElementById('field').value") isEqual:@"a"], [NSString stringWithFormat:@"the key types into the page (%@)", evaluate(view, @"document.getElementById('field').value")]);
    check(monitored == 0, @"input of a virtual key window does not pass the application");
    [NSEvent removeMonitor:monitor];

    // A real button does not enter a page event, and does not refuse a press.
    personButtons = 1;
    evaluate(view, @"events.length=0;null");
    check(sp_input_physical_buttons() == 1, @"the buttons of a person stay known");
    check(sp_input_person_buttons() == 0 && NSEvent.pressedMouseButtons == 0, @"no real button is seen while the state is open");
    check(pointer(window, 200, 200, 0) == SP_INPUT_DELIVERED, @"a move is delivered while a person holds a button");
    check(pointer(window, 200, 200, 1) == SP_INPUT_DELIVERED && pointer(window, 200, 200, 3) == SP_INPUT_DELIVERED, @"a press is delivered while a person holds a button");
    NSArray *held = evaluate(view, @"events.filter(e=>e.type==='pointermove'||e.type==='pointerup').map(e=>e.buttons)");
    check(held.count > 0 && ![held containsObject:@1], [NSString stringWithFormat:@"no page event carries the real button (%@)", held]);
    personButtons = 0;

    // Any order to the front keeps the window where it is. An order of a window reaches the window server in the call, as the
    // order of cover below shows, so the index is judged after the calls.
    [window orderFront:nil];
    [window makeKeyAndOrderFront:nil];
    [window orderFrontRegardless];
    check(window.orderedIndex == orderBefore, [NSString stringWithFormat:@"a virtual key window is not ordered to the front (%ld, %ld)", (long)window.orderedIndex, (long)orderBefore]);
    NSInteger coverBefore = cover.orderedIndex;
    [cover orderFront:nil];
    check(cover.orderedIndex <= coverBefore, @"another window still orders to the front");
    [window orderWindow:NSWindowBelow relativeTo:cover.windowNumber];

    // One window at a time.
    WKWebView *secondView = makePage(second);
    [second orderBack:nil];
    pageReady(secondView);
    check(sp_input_key(second, "b", "b", 0, true) == SP_INPUT_DELIVERED, @"a key of another window is delivered");
    sp_input_key(second, "b", "b", 0, false);
    check(second.isKeyWindow && !window.isKeyWindow && NSApp.keyWindow == second, @"at most one window answers as key");
    check(sp_input_pointer(window, 30, 30, 0, 0, 0, 0) == SP_INPUT_DELIVERED && window.isKeyWindow && !second.isKeyWindow, @"a move takes the state back");

    // A real activation ends the state at once and with one event.
    NSUInteger activated = count(^{
        reallyActive = YES;
        check(!sp_input_virtual_is(window) && !window.isKeyWindow && NSApp.keyWindow == nil, @"real state wins from the moment of the activation");
        [NSNotificationCenter.defaultCenter postNotificationName:NSApplicationDidBecomeActiveNotification object:NSApp];
        [NSNotificationCenter.defaultCenter postNotificationName:NSApplicationDidBecomeActiveNotification object:NSApp];
    }, @"activation");
    check(activated == 1, [NSString stringWithFormat:@"a real activation writes one event (%lu)", (unsigned long)activated]);
    NSDictionary *afterActivation = facts(window);
    check(![afterActivation[@"virtualKey"] boolValue] && [afterActivation[@"active"] boolValue], @"host.window reports the activation");
    reallyActive = NO;

    // A window that closes ends the state, and a closed window answers nothing.
    check(sp_input_pointer(window, 30, 30, 0, 0, 0, 0) == SP_INPUT_DELIVERED && window.isKeyWindow, @"a later move enters again");
    // A surface that closes with the keyboard ends with it: nothing keeps its page.
    static BOOL closedPageEnded;
    @autoreleasepool {
        void *surface = sp_surface_create(sp_window_set_main_webview(window, view));
        WKWebView *closing = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 420, 300)] autorelease];
        loadPage(closing, @"<!doctype html><script>window.ups=0;addEventListener('keyup',()=>ups++,true);</script>");
        EndWatch *watch = [[EndWatch new] autorelease];
        watch.ended = &closedPageEnded;
        static char watchKey;
        objc_setAssociatedObject(closing, &watchKey, watch, OBJC_ASSOCIATION_RETAIN);
        check(sp_surface_place_view(surface, closing), @"the page of a surface is placed");
        webviewSetFrame(surface, 0, 0, 420, 300);
        webviewSetSurfaceHidden(surface, false);
        awaitLoad(closing);
        check([window makeFirstResponder:closing], @"the page of the surface holds the keyboard");
        check(sp_input_key(window, "c", "c", 0, true) == SP_INPUT_DELIVERED && sp_input_key(window, "c", "c", 0, false) == SP_INPUT_DELIVERED, @"a key reaches the page of the surface");
        awaitPage(closing, @"the page of the surface receives the key up", @"keyup", @"ups > 0");
        sp_surface_close(surface);
    }
    eventWait(@"the page of the closed surface ends", ^BOOL { return closedPageEnded; });
    check(closedPageEnded, @"the page of a surface that closes with the keyboard ends");

    NSUInteger closed = count(^{ [window close]; }, @"closed");
    check(closed == 1, [NSString stringWithFormat:@"a window that closes ends the state with one event (%lu)", (unsigned long)closed]);
    check(!sp_input_virtual_any() && !NSApp.isActive && NSApp.keyWindow == nil && NSApp.mainWindow == nil, @"after the close AppKit answers again");

    sp_input_virtual_end("no state");

    // A window that the host shows while another window is the virtual key window becomes the key window of AppKit, and the
    // application is still not active. A press and a move of that window are input of an application that is not active: a
    // press goes directly to the view, and a move makes the window the virtual key window.
    check(pointer(second, 30, 30, 0) == SP_INPUT_DELIVERED && sp_input_virtual_is(second), @"a move makes a window the virtual key window");
    NSWindow *shown = makeWindow(880);
    WKWebView *shownView = makePage(shown);
    sp_window_show(shown);
    pageReady(shownView);
    check(sp_input_virtual_real_key(shown) && !sp_input_virtual_real_active(),
        @"a window shown beside the virtual key window is the key window of AppKit in an application that is not active");
    __block NSUInteger shownMonitored = 0;
    id shownMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown | NSEventMaskLeftMouseUp
        handler:^NSEvent *(NSEvent *event) { shownMonitored++; return event; }];
    evaluate(shownView, @"events.length=0;null");
    check(pointer(shown, 100, 25, 1) == SP_INPUT_DELIVERED && pointer(shown, 100, 25, 3) == SP_INPUT_DELIVERED,
        @"a press and a release of the shown window are delivered");
    NSArray *shownGesture = eventTypes(shownView);
    check([shownGesture containsObject:@"pointerdown"] && [shownGesture containsObject:@"click"],
        [NSString stringWithFormat:@"the gesture reaches the page of the shown window (%@)", [shownGesture componentsJoinedByString:@","]]);
    check(shownMonitored == 0, @"a press of the shown window does not pass the application");
    [NSEvent removeMonitor:shownMonitor];
    check(pointer(shown, 300, 250, 0) == SP_INPUT_DELIVERED && sp_input_virtual_is(shown) && !sp_input_virtual_is(second),
        @"a move of the key window of an application that is not active makes it the virtual key window");
    check([facts(shown)[@"virtualKey"] boolValue], @"host.window of the shown window reports the virtual key window");
    [shown close];
    [shown release];
    drainMainQueue(@"the blocks that the close of the shown window queued run");

    sp_input_virtual_end("no state");
    [second close];
    [cover close];
    // An activation that the closes caused is decided in the closes or in the blocks that they queued, so the front is judged
    // after those blocks.
    drainMainQueue(@"the blocks that the closes of the windows queued run");
    check(stayedBehind(), @"the application has not taken the front at the end");
    return failures ? 1 : 0;
} }
