// Checks that the main web view that nativeWindowSetMainWebview finds, the call of the Wails host, takes the input registration of
// the native library, so a release into the main page answers after the document received it (docs/spec/exposure.md#methods). A
// double click is a press and a release with the click count 1, then a press and a release with the click count 2; WebKit
// dispatches the `dblclick` of the second release in the handling of that release, so the document has run its `dblclick`
// listeners when the release answers. The window stands behind the windows of the person, and the check does not activate the
// application.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "host_api_webview.h"
#import "input_inject.h"
#import "main_thread.h"
#import "support/event_wait.h"
#import "webview_geometry.h"
#import "window_objects.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void runDirectly(void (^call)(void)) { call(); }

// The window is placed away from the real pointer, whose moves would otherwise reach the page too.
static NSRect awayFromPointer(NSSize size) {
    NSPoint pointer = NSEvent.mouseLocation;
    NSRect screen = NSScreen.mainScreen.visibleFrame;
    for (NSScreen *candidate in NSScreen.screens) {
        if (NSPointInRect(pointer, candidate.frame)) screen = candidate.visibleFrame;
    }
    CGFloat left = pointer.x < NSMidX(screen) ? NSMaxX(screen) - size.width - 20 : NSMinX(screen) + 20;
    CGFloat bottom = pointer.y < NSMidY(screen) ? NSMaxY(screen) - size.height - 60 : NSMinY(screen) + 20;
    return NSMakeRect(left, bottom, size.width, size.height);
}

// The navigation delegate of the main page, which hears when its navigation finishes.
@interface SPMainLoad : NSObject <WKNavigationDelegate>
@property BOOL finished;
@end
@implementation SPMainLoad
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
    (void)view;
    (void)navigation;
    self.finished = YES;
}
@end

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

// The answer of one pointer input and what the document had received when it answered: the numbers of its pointerup and
// dblclick events, which the answer reads before any later input reaches the web process.
typedef struct { BOOL done; sp_input_result result; WKWebView *view; NSString *seen; } SPAnswer;

static void answered(void *context, sp_input_result result, const sp_input_held *held, void *view) {
    (void)held;
    (void)view;
    SPAnswer *answer = context;
    answer->result = result;
    answer->seen = [evaluate(answer->view, @"`${probe.up} ${probe.dblclick}`") copy];
    answer->done = YES;
    // The answer can come from a callback that does not end a turn of the run loop.
    eventWake();
}

int main(void) { @autoreleasepool {
    hostInstallMainThread(runDirectly, runDirectly);
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    // The window holds the main web view inside its content view, as the window of the Wails framework does.
    NSWindow *window = [[NSWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(300, 200))
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 300, 200)] autorelease];
    WKWebView *page = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 300, 200)] autorelease];
    [window.contentView addSubview:page];
    check(sp_webview_render_occluded(page, true), @"the main web view renders while its window is covered");
    SPMainLoad *load = [[SPMainLoad new] autorelease];
    page.navigationDelegate = load;
    [page loadHTMLString:@"<!doctype html><body style='margin:0;height:200px'><script>window.probe={up:0,dblclick:0};"
        "addEventListener('pointerup',()=>probe.up++,true);addEventListener('dblclick',()=>probe.dblclick++,true);</script>"
        baseURL:[NSURL URLWithString:@"http://localhost/"]];
    eventWait(@"the main page loads", ^BOOL { return load.finished; });
    page.navigationDelegate = nil;
    [window orderBack:nil];

    long before = sp_window_objects_count().inputRegistrations;
    check(nativeWindowSetMainWebview((uintptr_t)window), @"the main web view of the window is set");
    long after = sp_window_objects_count().inputRegistrations;
    check(after == before + 1, [NSString stringWithFormat:@"the main web view takes an input registration (%ld before, %ld after)",
        before, after]);

    // A double click on the main page: at the answer of each release the document has received it, and at the answer of the
    // second release it has run its dblclick listeners.
    const int phases[] = {1, 3, 1, 3};
    const int clicks[] = {1, 1, 2, 2};
    NSString *const expected[] = {@"0 0", @"1 0", @"1 0", @"2 1"};
    for (int step = 0; step < 4; step++) {
        SPAnswer answer = {NO, SP_INPUT_REJECTED, page, nil};
        SPAnswer *state = &answer;
        sp_input_pointer_then(window, SP_INPUT_POINTER_MAIN, 150, 100, phases[step], 0, 0, 0, clicks[step], answered, state);
        eventWait(@"the pointer input answers", ^BOOL { return state->done; });
        check(answer.result == SP_INPUT_DELIVERED && [answer.seen isEqual:expected[step]],
            [NSString stringWithFormat:@"step %d of the double click (phase %d, clicks %d) answers after the document received it: "
                "result %d, pointerup and dblclick seen \"%@\", expected \"%@\"", step + 1, phases[step], clicks[step], answer.result,
                answer.seen, expected[step]]);
        [answer.seen release];
    }

    [window close];
    [window release];
    check(!NSApp.isActive, @"the application stays inactive");
    return failures ? 1 : 0;
}}
