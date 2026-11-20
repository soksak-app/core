// Checks that the press, the move and the scroll of a person end the synthetic gestures of the application at once: each open synthetic press is released
// on its view at its last point before the press of the person reaches a view, the buttons that +[NSEvent pressedMouseButtons]
// answers are those of the person outside the delivery of a synthetic event, and the next drag or release of an ended gesture
// answers the interruption with the press of the person (docs/spec/exposure.md#named-pointers).
//
// The press of the person is an event that the application dispatches through -[NSApplication sendEvent:] and that the library did
// not send: the check dispatches it in its own process, so no input of the system and no cursor of a person is touched. It lands
// on the virtual key window, which answers as the key window of an active application, so AppKit asks the system for no
// activation. The application is never active.
#import <Cocoa/Cocoa.h>
#import "event_ring.h"
#import "input_inject.h"
#import "private/coregraphics.h"
#import "support/event_wait.h"
#import "support/records.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Records each mouse event that reaches it: its kind, its point in the content of the window and the buttons that
// +[NSEvent pressedMouseButtons] answers while the view receives it, which WebKit reads as the buttons of a page event.
@interface SPRecordingView : NSView
@property(nonatomic, retain) NSMutableArray<NSString *> *seen;
@end
@implementation SPRecordingView
- (instancetype)initWithFrame:(NSRect)frame {
    self = [super initWithFrame:frame];
    _seen = [[NSMutableArray alloc] init];
    return self;
}
- (void)dealloc { [_seen release]; [super dealloc]; }
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
- (BOOL)isFlipped { return YES; }
- (void)record:(NSString *)kind event:(NSEvent *)event {
    NSPoint at = [self convertPoint:event.locationInWindow fromView:nil];
    [self.seen addObject:[NSString stringWithFormat:@"%@ %.0f,%.0f buttons %lu", kind, at.x, at.y, (unsigned long)NSEvent.pressedMouseButtons]];
    eventWake();
}
- (void)mouseDown:(NSEvent *)event { [self record:@"down" event:event]; }
- (void)mouseDragged:(NSEvent *)event { [self record:@"dragged" event:event]; }
- (void)mouseUp:(NSEvent *)event { [self record:@"up" event:event]; }
@end

// The window is placed away from the real pointer, whose moves would otherwise reach it.
static NSRect awayFromPointer(NSSize size, CGFloat shift) {
    NSPoint pointer = NSEvent.mouseLocation;
    NSRect screen = NSScreen.mainScreen.visibleFrame;
    for (NSScreen *candidate in NSScreen.screens) {
        if (NSPointInRect(pointer, candidate.frame)) screen = candidate.visibleFrame;
    }
    CGFloat left = pointer.x < NSMidX(screen) ? NSMaxX(screen) - size.width - 20 - shift : NSMinX(screen) + 20 + shift;
    CGFloat bottom = pointer.y < NSMidY(screen) ? NSMaxY(screen) - size.height - 60 : NSMinY(screen) + 20;
    return NSMakeRect(left, bottom, size.width, size.height);
}

static NSWindow *makeWindow(CGFloat shift, SPRecordingView **view) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(300, 200), shift)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    *view = [[[SPRecordingView alloc] initWithFrame:NSMakeRect(0, 0, 300, 200)] autorelease];
    window.contentView = *view;
    [window orderBack:nil];
    return [window autorelease];
}

typedef struct {
    BOOL done;
    sp_input_result result;
    char reason[512];
} SPAnswer;

static void answered(void *context, sp_input_result result, const sp_input_held *held, void *view) {
    SPAnswer *answer = context;
    answer->result = result;
    snprintf(answer->reason, sizeof answer->reason, "%s", held && held->reason ? held->reason : "");
    answer->done = YES;
    eventWake();
}

static SPAnswer input(NSWindow *window, const char *pointer, double x, double y, int phase) {
    __block SPAnswer answer = {NO, SP_INPUT_REJECTED, ""};
    sp_input_pointer_then(window, pointer, x, y, phase, 0, 0, 0, 1, answered, &answer);
    eventWait([NSString stringWithFormat:@"the answer of phase %d of pointer %s", phase, pointer], ^BOOL { return answer.done; });
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

// Dispatches the press and the release of a person at the point of the content of window through -[NSApplication sendEvent:], as the
// run loop of the application dispatches the events that the system gives it.
static void personClicks(NSWindow *window, double x, double y) {
    NSPoint point = [window.contentView convertPoint:NSMakePoint(x, y) toView:nil];
    NSEventType types[] = {NSEventTypeLeftMouseDown, NSEventTypeLeftMouseUp};
    for (int index = 0; index < 2; index++) {
        [NSApp sendEvent:[NSEvent mouseEventWithType:types[index] location:point modifierFlags:0
            timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil eventNumber:0
            clickCount:1 pressure:index == 0 ? 1 : 0]];
    }
}

// Dispatches a move of a person at the point of the content of window through -[NSApplication sendEvent:].
static void personMoves(NSWindow *window, double x, double y) {
    NSPoint point = [window.contentView convertPoint:NSMakePoint(x, y) toView:nil];
    [NSApp sendEvent:[NSEvent mouseEventWithType:NSEventTypeMouseMoved location:point modifierFlags:0
        timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil eventNumber:0 clickCount:0
        pressure:0]];
}

// Dispatches a scroll of a person at the point of the content of window through -[NSApplication sendEvent:], with the window that
// the window server gives a scroll of a person.
static void personScrolls(NSWindow *window, double x, double y) {
    NSPoint point = [window.contentView convertPoint:NSMakePoint(x, y) toView:nil];
    CGEventRef scroll = CGEventCreateScrollWheelEvent2(NULL, kCGScrollEventUnitPixel, 2, -4, 0, 0);
    NSPoint screen = [window convertPointToScreen:point];
    CGEventSetLocation(scroll, CGPointMake(screen.x, NSMaxY(NSScreen.screens.firstObject.frame) - screen.y));
    CGEventSetIntegerValueField(scroll, kSPEventWindowNumberField, window.windowNumber);
    CGEventSetWindowLocation(scroll, CGPointMake(point.x, NSHeight(window.frame) - point.y));
    [NSApp sendEvent:[NSEvent eventWithCGEvent:scroll]];
    CFRelease(scroll);
}

static void checkSeen(SPRecordingView *view, NSArray<NSString *> *want, NSString *what) {
    check([view.seen isEqualToArray:want], [NSString stringWithFormat:@"%@: %@ (want %@)", what,
        [view.seen componentsJoinedByString:@"; "], [want componentsJoinedByString:@"; "]]);
}

int main(void) { @autoreleasepool {
    // The interruption is recorded at the level info, which the default policy refuses (docs/spec/logging.md#policy).
    const int8_t everything[SP_CLASS_COUNT] = {SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE};
    check(sp_event_set_policy(everything), @"the policy stores every level of every class");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];

    SPRecordingView *keyView = nil, *otherView = nil;
    NSWindow *key = makeWindow(0, &keyView);
    NSWindow *other = makeWindow(340, &otherView);
    __block SPActivation activation = {NO, SP_ACTIVATE_DONE};
    sp_input_activate(key, activated, &activation);
    eventWait(@"the activation answers", ^BOOL { return activation.done; });
    check(activation.result == SP_ACTIVATE_DONE && key.isKeyWindow,
        [NSString stringWithFormat:@"the first window becomes the virtual key window (%d)", activation.result]);

    // Pointer b presses the window that is not the key window, whose press goes directly to the view, and pointer a presses the
    // virtual key window, whose press passes -[NSApplication sendEvent:]; that synthetic press ends no gesture.
    check(input(other, "b", 40, 40, 1).result == SP_INPUT_DELIVERED && input(other, "b", 45, 45, 2).result == SP_INPUT_DELIVERED,
        @"pointer b presses and drags the other window");
    check(input(key, "a", 50, 50, 1).result == SP_INPUT_DELIVERED && input(key, "a", 60, 50, 2).result == SP_INPUT_DELIVERED,
        @"pointer a presses and drags the virtual key window");
    check(sp_input_pointer_buttons("a") == 1 && sp_input_pointer_buttons("b") == 1,
        [NSString stringWithFormat:@"a synthetic press ends no synthetic gesture (a %lu, b %lu)", sp_input_pointer_buttons("a"),
            sp_input_pointer_buttons("b")]);
    check(NSEvent.pressedMouseButtons == sp_input_physical_buttons(), [NSString stringWithFormat:
        @"outside a delivery AppKit answers the buttons of a person while synthetic presses are open (%lu, person %lu)",
        (unsigned long)NSEvent.pressedMouseButtons, sp_input_physical_buttons()]);

    NSString *records = [capturedRecords(^{ personClicks(key, 100, 80); }) retain];
    checkSeen(keyView, @[@"down 50,50 buttons 1", @"dragged 60,50 buttons 1", @"up 60,50 buttons 0", @"down 100,80 buttons 0",
        @"up 100,80 buttons 0"], @"the press of the person releases the gesture of pointer a before it reaches the view");
    checkSeen(otherView, @[@"down 40,40 buttons 1", @"dragged 45,45 buttons 1", @"up 45,45 buttons 0"],
        @"the press of the person releases the gesture of pointer b in the other window");
    check(sp_input_pointer_buttons("a") == 0 && sp_input_pointer_buttons("b") == 0,
        [NSString stringWithFormat:@"the press of the person ends every synthetic press (a %lu, b %lu)", sp_input_pointer_buttons("a"),
            sp_input_pointer_buttons("b")]);
    NSString *wantA = @"a person's down of the left button at (100, 80) in the window of the gesture ended the synthetic gesture of "
        "pointer a, whose press was released at (60, 50)";
    NSString *wantB = @"a person's down of the left button at (100, 80) in another window ended the synthetic gesture of pointer b, "
        "whose press was released at (45, 45)";
    check([records containsString:@"\"kind\":\"interruption\""] && [records containsString:wantA] && [records containsString:wantB],
        [NSString stringWithFormat:@"each interruption is recorded with its message (got %@)", records]);
    [records release];

    SPAnswer drag = input(key, "a", 70, 50, 2);
    check(drag.result == SP_INPUT_INTERRUPTED && [@(drag.reason) isEqual:wantA],
        [NSString stringWithFormat:@"the next drag of pointer a answers the interruption (%d, \"%s\")", drag.result, drag.reason]);
    SPAnswer up = input(key, "a", 70, 50, 3);
    check(up.result == SP_INPUT_REJECTED, [NSString stringWithFormat:@"the interruption is answered once (%d, \"%s\")", up.result, up.reason]);
    SPAnswer release = input(other, "b", 45, 45, 3);
    check(release.result == SP_INPUT_INTERRUPTED && [@(release.reason) isEqual:wantB],
        [NSString stringWithFormat:@"the next release of pointer b answers the interruption (%d, \"%s\")", release.result, release.reason]);

    // A new gesture starts after the interruption.
    [keyView.seen removeAllObjects];
    check(input(key, "a", 30, 30, 1).result == SP_INPUT_DELIVERED && input(key, "a", 30, 30, 3).result == SP_INPUT_DELIVERED,
        @"pointer a presses and releases again");
    checkSeen(keyView, @[@"down 30,30 buttons 1", @"up 30,30 buttons 0"], @"the new gesture reaches the view with its button");

    // A move of a person ends the gesture of the window it moves over, and a scroll of a person ends the gesture of another window.
    [keyView.seen removeAllObjects];
    [otherView.seen removeAllObjects];
    check(input(key, "a", 30, 30, 1).result == SP_INPUT_DELIVERED && input(key, "a", 40, 30, 2).result == SP_INPUT_DELIVERED,
        @"pointer a presses and drags the virtual key window again");
    personMoves(key, 120, 90);
    checkSeen(keyView, @[@"down 30,30 buttons 1", @"dragged 40,30 buttons 1", @"up 40,30 buttons 0"],
        @"the move of the person releases the gesture of pointer a");
    SPAnswer moved = input(key, "a", 50, 30, 2);
    NSString *wantMove = @"a person's move at (120, 90) in the window of the gesture ended the synthetic gesture of pointer a, whose "
        "press was released at (40, 30)";
    check(moved.result == SP_INPUT_INTERRUPTED && [@(moved.reason) isEqual:wantMove],
        [NSString stringWithFormat:@"the next drag after the move answers the interruption (%d, \"%s\")", moved.result, moved.reason]);
    check(input(other, "b", 40, 40, 1).result == SP_INPUT_DELIVERED, @"pointer b presses the other window again");
    personScrolls(key, 100, 80);
    checkSeen(otherView, @[@"down 40,40 buttons 1", @"up 40,40 buttons 0"], @"the scroll of the person releases the gesture of pointer b");
    SPAnswer scrolled = input(other, "b", 40, 40, 3);
    NSString *wantScroll = @"a person's scroll at (100, 80) in another window ended the synthetic gesture of pointer b, whose press "
        "was released at (40, 40)";
    check(scrolled.result == SP_INPUT_INTERRUPTED && [@(scrolled.reason) isEqual:wantScroll],
        [NSString stringWithFormat:@"the next release after the scroll answers the interruption (%d, \"%s\")", scrolled.result,
            scrolled.reason]);
    [key close];
    [other close];
    return failures ? 1 : 0;
}}
