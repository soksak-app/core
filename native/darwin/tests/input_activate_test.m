// Checks whether, after the window is activated, a move without a button updates the hover of the page.
//
// This check activates the application and so takes the user's focus. It is not part of make test and
// runs only by make test-app-activation. The move is delivered directly to the tracking area owner, so it is independent of the real pointer position.
#import <Cocoa/Cocoa.h>
#import "input_inject.h"
#import "private/webkit.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// The activation notification arrives as an application event, so the check takes and processes events while waiting.
static void until(BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny
            untilDate:[NSDate dateWithTimeIntervalSinceNow:0.01] inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event) [NSApp sendEvent:event];
    }
    if (!done()) { fprintf(stderr, "FAIL: no answer within 10 seconds\n"); exit(1); }
}

static id evaluate(WKWebView *view, NSString *script) {
    __block BOOL done = NO;
    __block id result = nil;
    [view evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
        if (error) fprintf(stderr, "JavaScript: %s\n", error.localizedDescription.UTF8String);
        result = [value retain];
        done = YES;
    }];
    until(^BOOL { return done; });
    return [result autorelease];
}

static void drain(WKWebView *view) {
    __block BOOL done = NO;
    [view _doAfterProcessingAllPendingMouseEvents:^{ done = YES; }];
    until(^BOOL { return done; });
}

typedef struct { BOOL done; sp_activate_result result; char frontmost[256]; } SPActivation;

static void activated(void *context, sp_activate_result result, const char *frontmost) {
    SPActivation *state = context;
    state->result = result;
    snprintf(state->frontmost, sizeof state->frontmost, "%s", frontmost ?: "");
    state->done = YES;
}

static SPActivation activate(NSWindow *window) {
    __block SPActivation state = {NO, SP_ACTIVATE_DONE, ""};
    sp_input_activate(window, activated, &state);
    until(^BOOL { return state.done; });
    return state;
}

// Dispatches the events of the application for seconds, as the run loop of the application does.
static void dispatchFor(NSTimeInterval seconds) {
    NSDate *settle = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (settle.timeIntervalSinceNow > 0) {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny
            untilDate:[NSDate dateWithTimeIntervalSinceNow:0.01] inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event) [NSApp sendEvent:event];
    }
}

// A modifier change that the application receives: a key event, which ends a step that macOS refuses without an event.
static void applicationKeyEvent(void) {
    NSEvent *event = [NSEvent keyEventWithType:NSEventTypeFlagsChanged location:NSZeroPoint modifierFlags:0 timestamp:0
        windowNumber:0 context:nil characters:@"" charactersIgnoringModifiers:@"" isARepeat:NO keyCode:56];
    [NSApp sendEvent:event];
}

// A web view that does not report that the active state transmission has finished.
@interface SPStalledWebView : WKWebView
@end
@implementation SPStalledWebView
- (void)_doAfterActivityStateUpdate:(void (^)(void))completionHandler {}
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

    // The system does not activate an application whose activation is prohibited, and it sends no event for that refusal: the
    // request has no limit and ends at the next press or key event that the application receives.
    NSWindow *refused = makeWindow(NSWindow.class, nil);
    __block SPActivation state = {NO, SP_ACTIVATE_DONE, ""};
    sp_input_activate(refused, activated, &state);
    dispatchFor(1.5);
    check(!state.done, [NSString stringWithFormat:@"a refused activation has no limit (answered %d)", state.result]);
    applicationKeyEvent();
    until(^BOOL { return state.done; });
    check(state.result == SP_ACTIVATE_REFUSED && state.frontmost[0] != 0 && !NSApp.isActive,
        [NSString stringWithFormat:@"the next key event ends a refused activation with the frontmost application (%d, %s)",
            state.result, state.frontmost]);
    [refused close];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    SPStalledWebView *stalled = [[[SPStalledWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)] autorelease];
    NSWindow *pending = makeWindow(NSWindow.class, stalled);
    // The webview step has no limit: a webview that does not report its active state keeps the request waiting until an event
    // ends it, here the close of the window.
    __block SPActivation waiting = {NO, SP_ACTIVATE_DONE, ""};
    sp_input_activate(pending, activated, &waiting);
    dispatchFor(1.5);
    check(!waiting.done, [NSString stringWithFormat:@"the webview step of an activation has no limit (answered %d)", waiting.result]);
    [pending close];
    until(^BOOL { return waiting.done; });
    check(waiting.result == SP_ACTIVATE_PENDING,
        [NSString stringWithFormat:@"the close of the window ends the webview step with pending (%d)", waiting.result]);

    // A hidden document view is not an input target. While a visible window is being activated, it must not hold an explicit
    // activation request.
    SPStalledWebView *hiddenStalled = [[[SPStalledWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)] autorelease];
    hiddenStalled.hidden = YES;
    NSWindow *hiddenWindow = makeWindow(NSWindow.class, hiddenStalled);
    state = activate(hiddenWindow);
    check(state.result == SP_ACTIVATE_DONE,
        [NSString stringWithFormat:@"a hidden webview does not block activation (%d)", state.result]);

    NSWindow *other = makeWindow(NSWindow.class, nil);
    [other orderFront:nil];
    SPYieldingWebView *yielding = [[[SPYieldingWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)] autorelease];
    yielding.other = other;
    // Checks with a web view that has loaded a document, like a surface of the application.
    [yielding loadHTMLString:@"<!doctype html><script>window.probe = true</script>" baseURL:nil];
    until(^BOOL { return [evaluate(yielding, @"Boolean(window.probe)") boolValue]; });
    NSWindow *lost = makeWindow(NSWindow.class, yielding);
    state = activate(lost);
    check(state.result == SP_ACTIVATE_LOST && other.isKeyWindow,
        [NSString stringWithFormat:@"a window that loses key status before the state is applied reports lost (%d)", state.result]);

    // Activates a window that cannot become the key window while the application is active.
    state = activate(other);
    check(state.result == SP_ACTIVATE_DONE,
        [NSString stringWithFormat:@"an ordinary window activates (%d, frontmost %s)", state.result, state.frontmost]);
    // A window that cannot become key is refused in its turn: no notification would come for it.
    NSWindow *unkeyable = makeWindow(SPUnkeyableWindow.class, nil);
    NSTimeInterval unkeyableStarted = [NSDate timeIntervalSinceReferenceDate];
    state = activate(unkeyable);
    NSTimeInterval unkeyableTook = [NSDate timeIntervalSinceReferenceDate] - unkeyableStarted;
    check(state.result == SP_ACTIVATE_NOT_KEY && NSApp.isActive && unkeyableTook < 1,
        [NSString stringWithFormat:@"an active application whose window cannot become key reports not key at once (%d after %.3fs)",
            state.result, unkeyableTook]);

    for (NSWindow *window in @[pending, hiddenWindow, other, lost, unkeyable]) [window close];
}

// tests/support/no_activation.m: this check activates the application in make test-app-activation.
void sp_test_declare_activation(void);

int main(void) { @autoreleasepool {
    sp_test_declare_activation();
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
    [view loadHTMLString:html baseURL:nil];
    [window orderFront:nil];
    until(^BOOL { return [evaluate(view, @"Boolean(window.probe)") boolValue]; });

    SPActivation state = activate(window);
    check(state.result == SP_ACTIVATE_DONE,
        [NSString stringWithFormat:@"activation completes (%d, frontmost %s)", state.result, state.frontmost]);
    check(NSApp.isActive && window.isKeyWindow, @"the application is active and the window is key");

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
    until(^BOOL { return [evaluate(view, @"probe.events.some(e=>e.type==='click')") boolValue]; });
    NSArray *presses = evaluate(view, @"probe.events.filter(e=>['pointerdown','pointerup','click'].includes(e.type))");
    NSArray *types = [presses valueForKey:@"type"];
    check([types isEqual:@[@"pointerdown", @"pointerup", @"click"]] && ![[presses valueForKey:@"trusted"] containsObject:@NO]
        && [[presses valueForKey:@"x"] isEqual:@[@180, @180, @180]] && [[presses valueForKey:@"y"] isEqual:@[@120, @120, @120]],
        [NSString stringWithFormat:@"press and release reach the page of the active key window as trusted pointerdown, pointerup, and click at the point: %@", presses]);
    check([[evaluate(view, @"probe.events.filter(e=>e.type==='pointerdown'&&e.trusted).length") description] isEqual:@"1"],
        @"the page receives one trusted pointerdown for the press");
    [window close];
    return failures ? 1 : 0;
}}
