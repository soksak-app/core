// Checks the emulated activation: the window becomes the key window of an application that answers as active, the stage at
// which an activation stopped is reported, and after the activation a move without a button updates the hover of the page and a
// press passes the application.
//
// The activation asks the system for nothing, so the process never becomes active (tests/support/no_activation.m) and its windows
// stay behind the windows of a person. The move is delivered directly to the tracking area owner, so it is independent of the
// real pointer position.
#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import "input_inject.h"
#import "private/webkit.h"
#import "support/event_wait.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// The activation notification arrives as an application event, which eventWait dispatches while it waits.
static id evaluate(WKWebView *view, NSString *script) {
    __block BOOL done = NO;
    __block id result = nil;
    [view evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
        if (error) fprintf(stderr, "JavaScript: %s\n", error.localizedDescription.UTF8String);
        result = [value retain];
        done = YES;
    }];
    eventWait([@"JavaScript answers " stringByAppendingString:script], ^BOOL { return done; });
    return [result autorelease];
}

static void drain(WKWebView *view) {
    __block BOOL done = NO;
    [view _doAfterProcessingAllPendingMouseEvents:^{ done = YES; }];
    eventWait(@"WebKit has processed the pending mouse events", ^BOOL { return done; });
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

typedef struct { BOOL done; sp_activate_result result; char frontmost[256]; } SPActivation;

static void activated(void *context, sp_activate_result result, const char *frontmost) {
    SPActivation *state = context;
    state->result = result;
    snprintf(state->frontmost, sizeof state->frontmost, "%s", frontmost ?: "");
    state->done = YES;
    // The answer can come from the timer of the activation limit, which does not end a turn of the run loop.
    eventWake();
}

static SPActivation activate(NSWindow *window) {
    __block SPActivation state = {NO, SP_ACTIVATE_DONE, ""};
    sp_input_activate(window, activated, &state);
    eventWait(@"the activation answers", ^BOOL { return state.done; });
    return state;
}

// Runs the main queue until a marker block that it enqueues now has run: the point at which a check sees what the turns
// before it decided, with no time in the check.
static void runMarker(void) {
    __block BOOL ran = NO;
    dispatch_async(dispatch_get_main_queue(), ^{ ran = YES; });
    eventWait(@"the marker block runs", ^BOOL { return ran; });
}

// A web view that does not report that the active state transmission has finished.
@interface SPStalledWebView : WKWebView
// Set when the activation asks the web view to report its active state: the webview step has begun.
@property(nonatomic) BOOL asked;
@end
@implementation SPStalledWebView
- (void)_doAfterActivityStateUpdate:(void (^)(void))completionHandler { self.asked = YES; }
@end

// A web view for which another window becomes the key window while it waits for the active state transmission.
@interface SPYieldingWebView : WKWebView
@property(assign) NSWindow *other;
@end
@implementation SPYieldingWebView
- (void)_doAfterActivityStateUpdate:(void (^)(void))completionHandler {
    [super _doAfterActivityStateUpdate:completionHandler];
    [self.other makeKeyWindow];
}
@end

// A window that cannot become the key window.
@interface SPUnkeyableWindow : NSWindow
@end
@implementation SPUnkeyableWindow
- (BOOL)canBecomeKeyWindow { return NO; }
@end

static NSWindow *makeWindow(Class type, NSView *content) {
    NSWindow *window = [[type alloc] initWithContentRect:NSMakeRect(120, 120, 400, 300)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.ignoresMouseEvents = YES;
    if (content) window.contentView = content;
    return [window autorelease];
}

// Creates conditions to check that the stage at which activation stopped is reported in the result.
static void checkFailures(void) {
    check(activate(nil).result == SP_ACTIVATE_REJECTED, @"activating without a window is rejected");

    // The activation of an application whose activation the system prohibits completes: it asks the system for nothing.
    NSWindow *behind = makeWindow(NSWindow.class, nil);
    [behind orderBack:nil];
    SPActivation state = activate(behind);
    check(state.result == SP_ACTIVATE_DONE && NSApp.isActive && behind.isKeyWindow && !NSRunningApplication.currentApplication.active,
        [NSString stringWithFormat:@"an activation completes without the system (%d, frontmost %s)", state.result, state.frontmost]);
    [behind close];

    // A web view with no page has no process to send the active state to (the next case), so the stalled web view has a page.
    SPStalledWebView *stalled = [[[SPStalledWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)] autorelease];
    loadPage(stalled, @"<!doctype html><title>stalled</title>");
    awaitLoad(stalled);
    NSWindow *pending = makeWindow(NSWindow.class, stalled);
    // The webview step has no limit: a webview that does not report its active state keeps the request waiting until an event
    // ends it, here the close of the window.
    __block SPActivation waiting = {NO, SP_ACTIVATE_DONE, ""};
    sp_input_activate(pending, activated, &waiting);
    eventWait(@"the activation asks the web view for its active state", ^BOOL { return stalled.asked || waiting.done; });
    runMarker();
    check(stalled.asked && !waiting.done,
        [NSString stringWithFormat:@"the webview step of an activation waits for an event (answered %d)", waiting.result]);
    [pending close];
    eventWait(@"the close of the window ends the webview step", ^BOOL { return waiting.done; });
    check(waiting.result == SP_ACTIVATE_PENDING,
        [NSString stringWithFormat:@"the close of the window ends the webview step with pending (%d)", waiting.result]);

    // A visible web view that has loaded no page has no WebContent process, so no active state is sent and WebKit never reports
    // the transmission: it does not hold the activation. The process that a later load starts reads the active state when it starts.
    WKWebView *unloaded = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)] autorelease];
    NSWindow *unloadedWindow = makeWindow(NSWindow.class, unloaded);
    [unloadedWindow orderBack:nil];
    state = activate(unloadedWindow);
    check(state.result == SP_ACTIVATE_DONE && unloaded._webProcessIdentifier == 0,
        [NSString stringWithFormat:@"a web view without a page does not block activation (%d, process %d)", state.result,
            unloaded._webProcessIdentifier]);

    // A hidden document view is not an input target. While a visible window is being activated, it must not hold an explicit
    // activation request.
    SPStalledWebView *hiddenStalled = [[[SPStalledWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)] autorelease];
    hiddenStalled.hidden = YES;
    NSWindow *hiddenWindow = makeWindow(NSWindow.class, hiddenStalled);
    state = activate(hiddenWindow);
    check(state.result == SP_ACTIVATE_DONE,
        [NSString stringWithFormat:@"a hidden webview does not block activation (%d)", state.result]);

    NSWindow *other = makeWindow(NSWindow.class, nil);
    [other orderBack:nil];
    SPYieldingWebView *yielding = [[[SPYieldingWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)] autorelease];
    yielding.other = other;
    // Checks with a web view that has loaded a document, like a surface of the application.
    loadPage(yielding, @"<!doctype html><script>window.probe = true</script>");
    awaitLoad(yielding);
    NSWindow *lost = makeWindow(NSWindow.class, yielding);
    state = activate(lost);
    check(state.result == SP_ACTIVATE_LOST && other.isKeyWindow,
        [NSString stringWithFormat:@"a window that loses key status before the state is applied reports lost (%d)", state.result]);

    // Activates the window that became key while the activation of another window waited.
    state = activate(other);
    check(state.result == SP_ACTIVATE_DONE,
        [NSString stringWithFormat:@"an ordinary window activates (%d, frontmost %s)", state.result, state.frontmost]);
    // A window that cannot become key is refused in its turn: no notification would come for it.
    NSWindow *unkeyable = makeWindow(SPUnkeyableWindow.class, nil);
    state = (SPActivation){NO, SP_ACTIVATE_DONE, ""};
    sp_input_activate(unkeyable, activated, &state);
    runMarker();
    check(state.done && state.result == SP_ACTIVATE_NOT_KEY && NSApp.isActive,
        [NSString stringWithFormat:@"an active application whose window cannot become key reports not key in its turn (done %d, %d)",
            state.done, state.result]);

    for (NSWindow *window in @[pending, unloadedWindow, hiddenWindow, other, lost, unkeyable]) [window close];
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    checkFailures();
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 120, 400, 300)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.ignoresMouseEvents = YES;
    WKWebView *view = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)];
    window.contentView = view;
    NSString *html = @"<!doctype html><style>html,body{margin:0;width:100%;height:100%}"
        "#target{position:absolute;left:100px;top:50px;width:200px;height:200px}"
        "#target:hover{background:rgb(255,0,0)}</style><div id='target'></div><script>"
        "window.probe={events:[]};"
        "for (const type of ['pointerover','pointermove','pointerdown','pointerup','click'])"
        " addEventListener(type,e=>probe.events.push({type,trusted:e.isTrusted,x:e.clientX,y:e.clientY}),true);"
        "</script>";
    loadPage(view, html);
    [window orderBack:nil];
    awaitLoad(view);

    SPActivation state = activate(window);
    check(state.result == SP_ACTIVATE_DONE,
        [NSString stringWithFormat:@"activation completes (%d, frontmost %s)", state.result, state.frontmost]);
    check(NSApp.isActive && window.isKeyWindow, @"the application answers as active and the window as key");

    check(sp_input_pointer(window, 150, 100, 0, 0, 0, 0) == SP_INPUT_DELIVERED, @"move delivered");
    check(sp_input_pointer(window, 170, 110, 0, 0, 0, 0) == SP_INPUT_DELIVERED, @"second move delivered");
    drain(view);
    NSArray *moves = evaluate(view, @"probe.events.filter(e=>e.type==='pointermove')");
    check(moves.count >= 2 && ![[moves valueForKey:@"trusted"] containsObject:@NO]
        && [moves.lastObject[@"x"] doubleValue] == 170 && [moves.lastObject[@"y"] doubleValue] == 110,
        [NSString stringWithFormat:@"moves reach the page as trusted pointermove at the requested point: %@", moves]);
    check([evaluate(view, @"probe.events.some(e=>e.type==='pointerover'&&e.trusted)") boolValue], @"the target receives a trusted pointerover");
    check([evaluate(view, @"getComputedStyle(document.getElementById('target')).backgroundColor") isEqual:@"rgb(255, 0, 0)"],
        @"the :hover style applies to the element under the point");

    // The press of an active key window passes the application as a person's press does, and AppKit moves the first responder.
    __block NSUInteger monitorDowns = 0, monitorUps = 0;
    __block NSResponder *responderAtDown = nil;
    id monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown | NSEventMaskLeftMouseUp handler:^NSEvent *(NSEvent *event) {
        if (event.type == NSEventTypeLeftMouseDown) { monitorDowns++; responderAtDown = event.window.firstResponder; }
        else monitorUps++;
        return event;
    }];
    [window makeFirstResponder:nil];
    // V5-5: Even in an active key window the injected press and release reach the page (the default check uses the same call in an inactive window).
    check(sp_input_pointer(window, 180, 120, 1, 0, 0, 0) == SP_INPUT_DELIVERED
        && sp_input_pointer(window, 180, 120, 3, 0, 0, 0) == SP_INPUT_DELIVERED,
        @"press and release are delivered to the active key window");
    check(monitorDowns == 1 && monitorUps == 1,
        [NSString stringWithFormat:@"a local monitor sees the press and the release of the active key window once (%lu, %lu)", (unsigned long)monitorDowns, (unsigned long)monitorUps]);
    check(responderAtDown == window && window.firstResponder == view,
        [NSString stringWithFormat:@"AppKit moves the first responder, not the driver (at the press %@, after it %@)", responderAtDown, window.firstResponder]);
    [NSEvent removeMonitor:monitor];
    awaitPage(view, @"the page receives the click", @"click", @"probe.events.some(e=>e.type==='click')");
    NSArray *presses = evaluate(view, @"probe.events.filter(e=>['pointerdown','pointerup','click'].includes(e.type))");
    NSArray *types = [presses valueForKey:@"type"];
    check([types isEqual:@[@"pointerdown", @"pointerup", @"click"]] && ![[presses valueForKey:@"trusted"] containsObject:@NO]
        && [[presses valueForKey:@"x"] isEqual:@[@180, @180, @180]] && [[presses valueForKey:@"y"] isEqual:@[@120, @120, @120]],
        [NSString stringWithFormat:@"press and release reach the page of the active key window as trusted pointerdown, pointerup, and click at the point: %@", presses]);
    check([[evaluate(view, @"probe.events.filter(e=>e.type==='pointerdown'&&e.trusted).length") description] isEqual:@"1"],
        @"the page receives one trusted pointerdown for the press");
    [window close];
    check(!NSRunningApplication.currentApplication.active, @"the system does not hold the application as active");
    return failures ? 1 : 0;
}}
