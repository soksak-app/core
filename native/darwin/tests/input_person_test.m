// Checks the diagnostic action of a person (input_person.h): each action reaches -[NSApplication sendEvent:] as the event that the
// window server gives the application, at the point of the content, and is refused where it would ask the system for an
// activation or reach no window. The check sends nothing to the system: the events are dispatched in its own process, and the
// application is never active.
#import <Cocoa/Cocoa.h>
#include <stdlib.h>
#import "input_inject.h"
#import "input_person.h"
#import "input_virtual.h"
#import "surface_layout.h"
#import "support/event_wait.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Records each mouse event that reaches it with its kind and its point in the content.
@interface SPPersonView : NSView
@property(nonatomic, retain) NSMutableArray<NSString *> *seen;
@end
@implementation SPPersonView
- (instancetype)initWithFrame:(NSRect)frame {
    self = [super initWithFrame:frame];
    _seen = [[NSMutableArray alloc] init];
    return self;
}
- (void)dealloc { [_seen release]; [super dealloc]; }
- (BOOL)isFlipped { return YES; }
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
- (void)record:(NSString *)kind event:(NSEvent *)event {
    NSPoint at = [self convertPoint:event.locationInWindow fromView:nil];
    [self.seen addObject:[NSString stringWithFormat:@"%@ %.0f,%.0f", kind, at.x, at.y]];
}
- (void)mouseDown:(NSEvent *)event { [self record:@"down" event:event]; }
- (void)mouseUp:(NSEvent *)event { [self record:@"up" event:event]; }
- (void)scrollWheel:(NSEvent *)event { [self record:@"scroll" event:event]; }
@end

// The presses, moves and scrolls that reach -[NSApplication sendEvent:] in the window of the check, by kind and point in its content.
static NSMutableArray<NSString *> *dispatched;
static NSWindow *checked;

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

static NSWindow *makeWindow(CGFloat shift, SPPersonView **view) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:awayFromPointer(NSMakeSize(300, 200), shift)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    *view = [[[SPPersonView alloc] initWithFrame:NSMakeRect(0, 0, 300, 200)] autorelease];
    window.contentView = *view;
    [window orderBack:nil];
    return [window autorelease];
}

typedef struct { BOOL done; sp_activate_result result; } SPActivation;

static void activated(void *context, sp_activate_result result, const char *frontmost) {
    (void)frontmost;
    SPActivation *state = context;
    state->result = result;
    state->done = YES;
    eventWake();
}

// Runs the action and returns its error, or nil after the dispatch.
static NSString *person(NSWindow *window, const char *action, double x, double y) {
    char *error = NULL;
    bool done = sp_input_person((__bridge void *)window, action, x, y, &error);
    NSString *message = error ? @(error) : nil;
    free(error);
    if (done && message) return [@"a dispatch that also reported " stringByAppendingString:message];
    if (!done && !message) return @"a refusal without a message";
    return message;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    dispatched = [[NSMutableArray alloc] init];
    // The device of the actions of the user tells the press, the move and the scroll of a person that reach
    // -[NSApplication sendEvent:] (docs/spec/native-surfaces.md#layout-transaction).
    void (^record)(NSEvent *) = ^(NSEvent *event) {
        if (event.window != checked) return;
        NSPoint at = [event.window.contentView convertPoint:event.locationInWindow fromView:nil];
        [dispatched addObject:[NSString stringWithFormat:@"%lu %.0f,%.0f", (unsigned long)event.type, at.x, at.y]];
    };
    surfaceInputActionObserve(record);
    surfaceInputPointerObserve(record);

    SPPersonView *keyView = nil, *otherView = nil;
    NSWindow *key = makeWindow(0, &keyView);
    NSWindow *other = makeWindow(340, &otherView);
    __block SPActivation activation = {NO, SP_ACTIVATE_DONE};
    sp_input_activate(key, activated, &activation);
    eventWait(@"the activation answers", ^BOOL { return activation.done; });
    check(activation.result == SP_ACTIVATE_DONE && key.isKeyWindow, @"the first window becomes the virtual key window");

    checked = key;
    NSString *error = person(key, "press", 100, 80);
    check(error == nil, [NSString stringWithFormat:@"a press of the virtual key window is dispatched (%@)", error]);
    error = person(key, "move", 120, 90);
    check(error == nil, [NSString stringWithFormat:@"a move is dispatched (%@)", error]);
    error = person(key, "scroll", 130, 95);
    check(error == nil, [NSString stringWithFormat:@"a scroll is dispatched (%@)", error]);
    NSArray *want = @[[NSString stringWithFormat:@"%lu 100,80", (unsigned long)NSEventTypeLeftMouseDown],
        [NSString stringWithFormat:@"%lu 120,90", (unsigned long)NSEventTypeMouseMoved],
        [NSString stringWithFormat:@"%lu 130,95", (unsigned long)NSEventTypeScrollWheel]];
    check([dispatched isEqualToArray:want], [NSString stringWithFormat:@"each action reaches -[NSApplication sendEvent:] at its point (%@)",
        [dispatched componentsJoinedByString:@"; "]]);
    check([keyView.seen isEqualToArray:@[@"down 100,80", @"up 100,80", @"scroll 130,95"]],
        [NSString stringWithFormat:@"the view at the point receives the press and the scroll (%@)", [keyView.seen componentsJoinedByString:@"; "]]);
    check(!sp_input_virtual_real_active(), @"the application stays inactive");

    checked = other;
    [dispatched removeAllObjects];
    error = person(other, "press", 40, 40);
    check([error isEqual:@"a press of a person reaches only the key window"] && dispatched.count == 0 && otherView.seen.count == 0,
        [NSString stringWithFormat:@"a press of a window that is not the key window is refused (%@, %@)", error, dispatched]);
    error = person(other, "move", 40, 40);
    check(error == nil && dispatched.count == 1, [NSString stringWithFormat:@"a move of a window that is not the key window is dispatched (%@)", error]);
    error = person(key, "drag", 40, 40);
    check([error isEqual:@"action must be press, move or scroll"], [NSString stringWithFormat:@"another action is refused (%@)", error]);
    error = person(nil, "move", 40, 40);
    check([error isEqual:@"no window or not the main thread"], [NSString stringWithFormat:@"no window is refused (%@)", error]);
    [other orderOut:nil];
    error = person(other, "move", 40, 40);
    check([error isEqual:@"the window is not shown"], [NSString stringWithFormat:@"a window that is not shown is refused (%@)", error]);
    [key close];
    [other close];
    return failures ? 1 : 0;
}}
