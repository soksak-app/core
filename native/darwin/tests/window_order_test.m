// Checks that host.window reports the place of a window among the windows on the screen and its display, and that the raise
// and the lower of a window (host.window.raise, host.window.lower) change that place without changing the active application.
// The windows of the check stand at the normal level and start at the back of it, behind the windows that a person has on the
// screen, so the check judges only the order of its two windows relative to each other, which those windows do not change.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "support/event_wait.h"
#import "webview_geometry.h"
#import "window_facts.h"
#import "window_order.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static NSDictionary *factsOf(NSWindow *window) {
    char *text = sp_window_facts(window, sp_window_composition(window));
    if (!text) return nil;
    NSDictionary *facts = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:text length:strlen(text)] options:0 error:nil];
    sp_facts_free(text);
    return facts;
}

// The reported index of the window among the windows of its level, or -1 when the facts report no place.
static NSInteger indexOf(NSWindow *window) {
    id order = factsOf(window)[@"order"];
    return [order isKindOfClass:NSDictionary.class] ? [order[@"index"] integerValue] : -1;
}

// A window of the check with a registered app DOM web view, so its facts can be read as a host reads them.
static NSWindow *makeWindow(NSRect frame) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:frame styleMask:NSWindowStyleMaskTitled
        backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    WKWebView *main = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, frame.size.width, frame.size.height)] autorelease];
    [window.contentView addSubview:main];
    sp_window_set_main_webview(window, main);
    return window;
}

static NSDictionary *row(NSInteger number, NSInteger layer, pid_t pid, CGRect bounds, double alpha) {
    return @{ (id)kCGWindowNumber: @(number), (id)kCGWindowLayer: @(layer), (id)kCGWindowOwnerPID: @(pid),
        (id)kCGWindowBounds: CFBridgingRelease(CGRectCreateDictionaryRepresentation(bounds)), (id)kCGWindowAlpha: @(alpha) };
}

// The place among a window list of the window server: windows of other levels and windows that show nothing do not count, and
// only a window of another process in front of the window over a part of it is another window in front.
static void checkOrderOfAList(void) {
    pid_t own = 100, other = 200;
    CGRect bounds = CGRectMake(100, 100, 200, 200);
    NSArray *list = @[
        row(1, 25, other, bounds, 1),
        row(2, 0, own, CGRectMake(150, 150, 50, 50), 1),
        row(3, 0, other, CGRectMake(400, 100, 100, 100), 1),
        row(4, 0, other, CGRectMake(250, 250, 100, 100), 0),
        row(5, 0, own, bounds, 1),
        row(6, 0, other, bounds, 1),
    ];
    check([sp_window_order_in(list, 5, own) isEqual:@{ @"index": @2, @"count": @4, @"otherInFront": @NO }],
        [NSString stringWithFormat:@"a window behind its own window and a window of another process beside it has no other window "
            "in front: %@", sp_window_order_in(list, 5, own)]);
    NSArray *covered = [@[row(7, 0, other, CGRectMake(290, 290, 50, 50), 1)] arrayByAddingObjectsFromArray:list];
    check([sp_window_order_in(covered, 5, own) isEqual:@{ @"index": @3, @"count": @5, @"otherInFront": @YES }],
        [NSString stringWithFormat:@"a window of another process in front over a corner of the window is another window in front: "
            "%@", sp_window_order_in(covered, 5, own)]);
    check([sp_window_order_in(list, 6, other) isEqual:@{ @"index": @3, @"count": @4, @"otherInFront": @YES }],
        [NSString stringWithFormat:@"the window at the back of its level is counted behind the others: %@",
            sp_window_order_in(list, 6, other)]);
    check(sp_window_order_in(list, 4, other) == nil && sp_window_order_in(list, 9, own) == nil,
        @"a window that shows nothing or is not in the list has no place");
}

// The windows in front of a window over a part of it, from front to back: of every level and every process, the own process
// included, and not a window beside it, behind it or showing nothing; each with its owner, process, level and bounds.
static void checkWindowsInFrontOfAList(void) {
    pid_t own = 100, other = 200;
    CGRect bounds = CGRectMake(300, 39, 1200, 760);
    NSDictionary *(^named)(NSInteger, NSInteger, pid_t, CGRect, double, NSString *) =
        ^NSDictionary *(NSInteger number, NSInteger layer, pid_t pid, CGRect at, double alpha, NSString *owner) {
            NSMutableDictionary *entry = [[row(number, layer, pid, at, alpha) mutableCopy] autorelease];
            entry[(id)kCGWindowOwnerName] = owner;
            return entry;
        };
    NSArray *list = @[
        named(1, 25, other, CGRectMake(0, 0, 1800, 25), 1, @"Menu"),
        named(2, 0, other, CGRectMake(200, 30, 1400, 900), 1, @"Cover"),
        named(3, 0, other, CGRectMake(1600, 30, 100, 100), 1, @"Beside"),
        named(4, 0, own, CGRectMake(400, 100, 50, 20), 1, @"Self"),
        named(5, 3, other, CGRectMake(300, 39, 1200, 760), 0, @"Clear"),
        named(6, 0, own, bounds, 1, @"Self"),
        named(7, 0, other, bounds, 1, @"Behind"),
    ];
    NSArray *expected = @[
        @{ @"number": @2, @"owner": @"Cover", @"pid": @(other), @"layer": @0, @"x": @200, @"y": @30, @"width": @1400,
            @"height": @900 },
        @{ @"number": @4, @"owner": @"Self", @"pid": @(own), @"layer": @0, @"x": @400, @"y": @100, @"width": @50, @"height": @20 },
    ];
    NSArray *front = sp_window_in_front_in(list, 6);
    check([front isEqual:expected], [NSString stringWithFormat:@"the windows in front of a window are those over a part of it, of "
        "any process, from front to back, with their owner, level and bounds: %@", front]);
    check([sp_window_in_front_in(list, 1) isEqual:@[]], @"the front window has no window in front of it");
    check(sp_window_in_front_in(list, 9) == nil, @"a window that is not in the list has no windows in front of it");
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    checkOrderOfAList();
    checkWindowsInFrontOfAList();

    NSWindow *below = makeWindow(NSMakeRect(200, 200, 300, 200));
    NSWindow *above = makeWindow(NSMakeRect(260, 240, 300, 200));
    NSWindow *hidden = makeWindow(NSMakeRect(300, 300, 100, 100));
    check(!sp_window_raise(hidden) && !sp_window_lower(hidden) && !hidden.isVisible,
        @"a window that is not ordered in is neither raised nor lowered, and stays out");
    check(factsOf(hidden)[@"order"] == NSNull.null, @"a window that is not ordered in has no place");
    [above orderBack:nil];
    [below orderBack:nil];
    eventWait(@"the window sent back later stands behind the other", ^BOOL {
        return indexOf(above) >= 0 && indexOf(below) > indexOf(above);
    });

    NSDictionary *facts = factsOf(below);
    NSUInteger display = [NSScreen.screens indexOfObject:below.screen];
    check(display != NSNotFound && [facts[@"display"] isEqual:@(display)],
        [NSString stringWithFormat:@"the display of the window is its index in the screen list: %@ for %lu", facts[@"display"],
            (unsigned long)display]);
    id otherInFront = facts[@"order"][@"otherInFront"];
    check([facts[@"order"][@"count"] integerValue] >= 2
            && (otherInFront == (id)kCFBooleanTrue || otherInFront == (id)kCFBooleanFalse),
        [NSString stringWithFormat:@"the place of a window counts both windows of the check and tells whether another window is in "
            "front: %@", facts[@"order"]]);

    BOOL active = NSApp.isActive;
    pid_t frontmost = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    NSWindow *key = NSApp.keyWindow;
    check(sp_window_raise(below), @"the raise of a window that is ordered in is accepted");
    eventWait(@"the raised window stands in front of the other", ^BOOL {
        return indexOf(below) >= 0 && indexOf(below) < indexOf(above);
    });
    check(NSApp.isActive == active && NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == frontmost
            && NSApp.keyWindow == key,
        @"the raise changes neither the active application, the front application nor the key window");

    check(sp_window_lower(below), @"the lower of a window that is ordered in is accepted");
    eventWait(@"the lowered window stands behind the other", ^BOOL {
        return indexOf(above) >= 0 && indexOf(below) > indexOf(above);
    });
    check(NSApp.isActive == active && NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == frontmost
            && NSApp.keyWindow == key,
        @"the lower changes neither the active application, the front application nor the key window");

    [above close];
    [below close];
    [hidden close];
    if (failures) fprintf(stderr, "%d failure(s)\n", failures);
    return failures ? 1 : 0;
} }
