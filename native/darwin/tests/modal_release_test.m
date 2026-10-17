// Checks that a closed modal web view releases its input registration. The modal is created and closed with the calls that
// the host makes for a modal that fills the window (nativeWebviewCreate with fillParent, FocusModal, nativeWebviewClose).
// The count of input registrations after the close must equal the count before the modal was created. The check does not
// activate the application.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import "webview_input.h"
#import "window_facts.h"
#import "window_objects.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Runs the run loop until the condition holds. A load does not need application events, and handling them would activate the
// application.
static void until(NSString *what, BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        @autoreleasepool {
            [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
        }
    }
    if (!done()) { fprintf(stderr, "FAIL: %s within 10 seconds\n", what.UTF8String); exit(1); }
}

// Handles the application-defined events until the condition holds. The count request of sp_window_objects_when is answered
// through the queued application-defined event.
static void untilEventHandled(NSString *what, BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        @autoreleasepool {
            // Only the application-defined event is dequeued; the system activation event stays queued, so the
            // application keeps its inactive state.
            NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskApplicationDefined untilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]
                inMode:NSDefaultRunLoopMode dequeue:YES];
            if (event) [NSApp sendEvent:event];
        }
    }
    if (!done()) { fprintf(stderr, "FAIL: %s within 10 seconds\n", what.UTF8String); exit(1); }
}

// The message handler of the modal. It is the handler that the host registers under the name "soksak".
@interface SPTestBridge : NSObject <WKScriptMessageHandler>
@end
@implementation SPTestBridge
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {}
@end

// The navigation delegate of the main web view. It records the end of the first navigation.
@interface SPTestNavigation : NSObject <WKNavigationDelegate>
@property BOOL finished;
@end
@implementation SPTestNavigation
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation { self.finished = YES; }
@end

// The modal web view. It is a WKWebView subclass that is its own navigation delegate, as the host creates it.
@interface SPTestModal : WKWebView <WKNavigationDelegate>
@property BOOL finished;
@end
@implementation SPTestModal
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation { self.finished = YES; }
@end

// The state of the count request.
typedef struct { BOOL answered; BOOL reached; sp_window_objects counts; } SPCountAnswer;

static void countAnswered(void *context, const sp_window_objects *counts, bool reached) {
    SPCountAnswer *answer = context;
    answer->answered = YES;
    answer->reached = reached;
    answer->counts = *counts;
}

// Manual reference counting cannot use __weak, so the check uses the weak reference slot of the runtime. The slot
// becomes nil when the object is released.
enum { kTracked = 8 };
static id weakSlots[kTracked];
static const char *weakNames[kTracked];
static int trackedCount;

static void track(const char *name, id object) {
    if (!object) { check(NO, [NSString stringWithFormat:@"%s exists before the modal closes", name]); return; }
    weakNames[trackedCount] = name;
    objc_storeWeak(&weakSlots[trackedCount], object);
    trackedCount++;
}

// objc_loadWeak puts the object in the autorelease pool, so the read drains the pool.
static BOOL released(int index) {
    BOOL alive;
    @autoreleasepool { alive = objc_loadWeak(&weakSlots[index]) != nil; }
    return !alive;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(60, 60, 600, 400)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 600, 400)] autorelease];
    WKWebView *root = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 600, 400)] autorelease];
    [window.contentView addSubview:root];
    SPTestNavigation *rootNavigation = [[SPTestNavigation new] autorelease];
    root.navigationDelegate = rootNavigation;
    check(sp_window_set_main_webview(window, root), @"the main webview is registered");
    check(webviewInputRegister(root), @"the main webview registers for input");
    [root loadHTMLString:@"<!doctype html><body>main</body>" baseURL:nil];
    [window orderFrontRegardless];
    until(@"the main page did not load", ^BOOL { return rootNavigation.finished; });

    sp_window_objects before = sp_window_objects_count();
    check(before.inputRegistrations == 1, [NSString stringWithFormat:@"one input registration exists before the modal (%ld)", before.inputRegistrations]);

    // The modal and the objects that the calls of its lifetime autoreleased are released before the count is read.
    @autoreleasepool {
        // nativeWebviewCreate with fillParent: copy the configuration of the main web view, replace its script controller,
        // register input and ignore page focus, then add the view above the main web view without attaching it to a surface.
        WKWebViewConfiguration *configuration = [root.configuration copy];
        WKUserContentController *controller = [[WKUserContentController alloc] init];
        SPTestBridge *bridge = [[SPTestBridge alloc] init];
        [controller addScriptMessageHandler:bridge name:@"soksak"];
        [bridge release];
        WKUserScript *bootstrap = [[WKUserScript alloc] initWithSource:@"window.__modal = true;"
            injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES];
        [controller addUserScript:bootstrap];
        [bootstrap release];
        configuration.userContentController = controller;
        [controller release];
        SPTestModal *modal = [[SPTestModal alloc] initWithFrame:NSZeroRect configuration:configuration];
        track("modal WKWebView", modal);
        track("modal WKWebViewConfiguration", modal.configuration);
        [configuration release];
        modal.navigationDelegate = modal;
        modal.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        check(webviewInputRegister(modal), @"the modal registers for input");
        [window.contentView addSubview:modal positioned:NSWindowAbove relativeTo:root];
        [modal loadHTMLString:@"<!doctype html><body>modal</body>" baseURL:nil];
        until(@"the modal page did not load", ^BOOL { return modal.finished; });
        sp_window_objects open = sp_window_objects_count();
        check(open.inputRegistrations == 2, [NSString stringWithFormat:@"two input registrations exist while the modal is open (%ld)", open.inputRegistrations]);

        // FocusModal(take): the modal becomes the first responder.
        [modal.superview addSubview:modal positioned:NSWindowAbove relativeTo:nil];
        [window makeFirstResponder:modal];

        // FocusModal(false): the main web view becomes the first responder, then the modal closes.
        for (NSView *candidate in window.contentView.subviews) {
            if (candidate != modal && [candidate isKindOfClass:WKWebView.class]) {
                [window makeFirstResponder:candidate];
                break;
            }
        }

        // nativeWebviewClose: unregister input, stop loading, remove the handler, detach the surface, remove the view, release it.
        webviewInputUnregister(modal);
        [modal stopLoading];
        [modal.configuration.userContentController removeScriptMessageHandlerForName:@"soksak"];
        [modal removeFromSuperview];
        [modal release];
    }
    for (int i = 0; i < trackedCount; i++) {
        check(released(i), [NSString stringWithFormat:@"the closed modal releases its %s", weakNames[i]]);
    }

    // The count is answered after the run loop handles the events that release the autoreleased objects of the close.
    __block SPCountAnswer answer = {0};
    sp_window_objects_when(&before, 5, countAnswered, &answer);
    untilEventHandled(@"the count was not answered", ^BOOL { return answer.answered; });
    check(answer.reached && answer.counts.inputRegistrations == before.inputRegistrations,
        [NSString stringWithFormat:@"the closed modal releases its input registration (%ld, expected %ld)",
            answer.counts.inputRegistrations, before.inputRegistrations]);

    [window close];
    [window release];
    check(!NSApp.isActive, @"application stays inactive");
    return failures ? 1 : 0;
}}
