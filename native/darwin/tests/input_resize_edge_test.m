// Checks that a synthetic press on the resize edge of a window is refused and returns: AppKit tracks a press there as a window
// resize in -[NSWindow _hitTestWithHysteresisCheck:forEvent:allowWindowDragging:], which waits on the main thread for the next
// mouse event without an expiration, and the release of a synthetic gesture is sent only after its press returns
// (docs/spec/exposure.md#methods).
//
// The window is ordered behind the windows of a person and the application is never active: the press of the virtual key window
// passes -[NSApplication sendEvent:] as a person's press does, and the press of a window that is not the key window goes directly
// to the view at the point. Both paths are checked.
#import <Cocoa/Cocoa.h>
#include <stdatomic.h>
#import "event_ring.h"
#import "input_inject.h"
#import "support/event_wait.h"
#import "support/records.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// The limit of one synthetic press. A press that AppKit holds in its tracking loop never returns, so the check names the press and
// ends the process at the limit instead of waiting for the limit of the runner.
static const int64_t pressLimitSeconds = 10;

// The press whose call has not returned, or NULL. It is written on the main thread and read by the limit on another queue.
static _Atomic(const char *) pendingPress = NULL;

static void watchPress(const char *what) {
    atomic_store(&pendingPress, what);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, pressLimitSeconds * NSEC_PER_SEC), dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        if (atomic_load(&pendingPress) != what) return;
        fprintf(stderr, "FAIL: %s did not return within %lld s; the main thread is inside an AppKit tracking loop\n", what,
            (long long)pressLimitSeconds);
        _exit(1);
    });
}

static void pressReturned(void) { atomic_store(&pendingPress, NULL); }

@interface SPPressedView : NSView
@property(nonatomic) NSUInteger downs;
@property(nonatomic) NSUInteger ups;
@end
@implementation SPPressedView
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
- (void)mouseDown:(NSEvent *)event { self.downs++; }
- (void)mouseUp:(NSEvent *)event { self.ups++; }
@end

// The window is placed away from the real pointer, whose moves would otherwise reach it.
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

typedef struct {
    BOOL done;
    sp_input_result result;
    char reason[256];
} SPAnswer;

static void answered(void *context, sp_input_result result, const sp_input_held *held, void *view) {
    SPAnswer *answer = context;
    answer->result = result;
    snprintf(answer->reason, sizeof answer->reason, "%s", held && held->reason ? held->reason : "");
    answer->done = YES;
    eventWake();
}

// Sends one input of the pointer main and returns its answer. A press is watched by the limit until its call returns.
static SPAnswer input(NSWindow *window, double x, double y, int phase) {
    __block SPAnswer answer = {NO, SP_INPUT_REJECTED, ""};
    NSString *what = [NSString stringWithFormat:@"the press at (%g, %g)", x, y];
    if (phase == 1) watchPress(strdup(what.UTF8String));
    sp_input_pointer_then(window, SP_INPUT_POINTER_MAIN, x, y, phase, 0, 0, 0, 1, answered, &answer);
    if (phase == 1) pressReturned();
    eventWait([NSString stringWithFormat:@"the answer of phase %d at (%g, %g)", phase, x, y], ^BOOL { return answer.done; });
    return answer;
}

typedef struct { BOOL done; sp_activate_result result; } SPActivation;

static void activated(void *context, sp_activate_result result, const char *frontmost) {
    (void)frontmost;
    SPActivation *state = context;
    state->result = result;
    state->done = YES;
    eventWake();
}

// The points of a 400 by 300 window on its resize edges, in points from the top left of the content, which fills the window,
// and the edge that each lies on.
static const struct { double x, y; const char *edge; } edges[] = {
    {200, 299, "bottom"},
    {1, 150, "left"},
    {399, 150, "right"},
    {200, 1, "top"},
    {399, 299, "bottom right"},
    {1, 299, "bottom left"},
};

static void checkEdges(NSWindow *window, SPPressedView *view, NSString *path) {
    for (size_t index = 0; index < sizeof edges / sizeof edges[0]; index++) {
        double x = edges[index].x, y = edges[index].y;
        NSUInteger downs = view.downs;
        __block SPAnswer answer;
        NSString *records = capturedRecords(^{ answer = input(window, x, y, 1); });
        NSString *want = [NSString stringWithFormat:@"the point (%g, %g) lies on the %s resize edge of the window, where AppKit "
            "tracks a press as a window resize; the synthetic press was not delivered", x, y, edges[index].edge];
        check(answer.result == SP_INPUT_RESIZE_EDGE && [@(answer.reason) isEqual:want] && view.downs == downs,
            [NSString stringWithFormat:@"%@: the press at (%g, %g) is refused with the %s resize edge (result %d, reason \"%s\", downs %lu)",
                path, x, y, edges[index].edge, answer.result, answer.reason, (unsigned long)(view.downs - downs)]);
        check([records containsString:@"\"result\":\"resize edge\""] && [records containsString:want],
            [NSString stringWithFormat:@"%@: the refusal at (%g, %g) is recorded with its reason (got %@)", path, x, y, records]);
    }
    // A press inside the edges is delivered, and its release follows it.
    NSUInteger downs = view.downs, ups = view.ups;
    SPAnswer down = input(window, 200, 150, 1);
    SPAnswer up = input(window, 200, 150, 3);
    check(down.result == SP_INPUT_DELIVERED && up.result == SP_INPUT_DELIVERED && view.downs == downs + 1 && view.ups == ups + 1,
        [NSString stringWithFormat:@"%@: a press and a release inside the edges are delivered (%d %d, downs %lu, ups %lu)", path,
            down.result, up.result, (unsigned long)(view.downs - downs), (unsigned long)(view.ups - ups)]);
}

static NSWindow *resizableWindow(SPPressedView **view) {
    NSWindowStyleMask style = NSWindowStyleMaskTitled | NSWindowStyleMaskResizable | NSWindowStyleMaskClosable
        | NSWindowStyleMaskFullSizeContentView;
    NSWindow *window = [[NSWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(400, 300)) styleMask:style
        backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.titlebarAppearsTransparent = YES;
    *view = [[[SPPressedView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)] autorelease];
    window.contentView = *view;
    [window orderBack:nil];
    return [window autorelease];
}

int main(void) { @autoreleasepool {
    // The refusal is recorded at the level info, which the default policy refuses (docs/spec/logging.md#policy).
    const int8_t everything[SP_CLASS_COUNT] = {SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE};
    check(sp_event_set_policy(everything), @"the policy stores every level of every class");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];

    // A window that is not the key window: the press goes to the view at the point, where a person's press resizes the window.
    SPPressedView *directView = nil;
    NSWindow *direct = resizableWindow(&directView);
    checkEdges(direct, directView, @"direct delivery");
    [direct close];

    // The virtual key window: the press passes -[NSApplication sendEvent:], and AppKit tracks a press on the edge as a resize.
    SPPressedView *keyView = nil;
    NSWindow *key = resizableWindow(&keyView);
    __block SPActivation activation = {NO, SP_ACTIVATE_DONE};
    sp_input_activate(key, activated, &activation);
    eventWait(@"the activation answers", ^BOOL { return activation.done; });
    check(activation.result == SP_ACTIVATE_DONE && key.isKeyWindow,
        [NSString stringWithFormat:@"the window becomes the virtual key window (%d)", activation.result]);
    checkEdges(key, keyView, @"virtual key window");

    // A window that cannot be resized has no resize edge, and its press at the same point is delivered.
    key.styleMask &= ~NSWindowStyleMaskResizable;
    NSUInteger downs = keyView.downs;
    SPAnswer down = input(key, 200, 299, 1);
    SPAnswer up = input(key, 200, 299, 3);
    check(down.result == SP_INPUT_DELIVERED && up.result == SP_INPUT_DELIVERED && keyView.downs == downs + 1,
        [NSString stringWithFormat:@"a press at the bottom of a window that cannot be resized is delivered (%d %d)", down.result, up.result]);
    [key close];
    return failures ? 1 : 0;
}}
