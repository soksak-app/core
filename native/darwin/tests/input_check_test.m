// The drive of a window by a check (input_check.h, diagnostics.drag of docs/spec/endpoint.md#diagnostic-builds): while a check
// drives a window, a pointer event of a person that reaches -[NSApplication sendEvent:] for that window reaches no monitor and no
// view and is counted, a button that a person holds neither refuses a synthetic press nor is read as a button of a person, and a
// key event of the window, an event of another window and the synthetic input of input_inject.h pass. A synthetic event that a
// layout wait gives back passes once. The end answers the count and the window takes the input of a person again; the close of a
// window ends its drive.
//
// The test process is never active and orders its windows behind every other window, as input_inject_test does. The events of a person are sent through
// -[NSApplication sendEvent:], the path on which the window server and AppKit deliver them, and the buttons of a person are a
// replacement of pressedMouseButtons set before input_inject.h replaces it, so input_inject.h reads it as AppKit.
#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import <stdio.h>
#import "input_check.h"
#import "input_inject.h"

static int failures;

static void check(BOOL condition, NSString *what) {
    FILE *output = condition ? stdout : stderr;
    fprintf(output, "%s: %s\n", condition ? "PASS" : "FAIL", what.UTF8String);
    if (!condition) failures++;
}

// A view that records the pointer events that reach it.
@interface RecordingView : NSView
@property(retain) NSMutableArray<NSString *> *events;
@end

@implementation RecordingView
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
- (void)mouseDown:(NSEvent *)event { [self.events addObject:@"mouseDown"]; }
- (void)mouseDragged:(NSEvent *)event { [self.events addObject:@"mouseDragged"]; }
- (void)mouseUp:(NSEvent *)event { [self.events addObject:@"mouseUp"]; }
- (void)rightMouseDown:(NSEvent *)event { [self.events addObject:@"rightMouseDown"]; }
- (void)mouseMoved:(NSEvent *)event { [self.events addObject:@"mouseMoved"]; }
@end

static NSWindow *recordingWindow(void) {
    NSWindow *window = [[[NSWindow alloc] initWithContentRect:NSMakeRect(40, 40, 300, 200)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO] autorelease];
    window.releasedWhenClosed = NO;
    RecordingView *view = [[[RecordingView alloc] initWithFrame:NSMakeRect(0, 0, 300, 200)] autorelease];
    view.events = [NSMutableArray array];
    window.contentView = view;
    [window orderBack:nil];
    return window;
}

static NSMutableArray<NSString *> *viewEvents(NSWindow *window) {
    return ((RecordingView *)window.contentView).events;
}

// A pointer event of a person at the point of the window, as the window server delivers it.
static NSEvent *personEvent(NSWindow *window, NSEventType type, NSPoint point) {
    if (type == NSEventTypeMouseEntered || type == NSEventTypeMouseExited) {
        return [NSEvent enterExitEventWithType:type location:point modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime
            windowNumber:window.windowNumber context:nil eventNumber:0 trackingNumber:0 userData:NULL];
    }
    BOOL press = type == NSEventTypeLeftMouseDown || type == NSEventTypeRightMouseDown;
    return [NSEvent mouseEventWithType:type location:point modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime
        windowNumber:window.windowNumber context:nil eventNumber:0 clickCount:press ? 1 : 0 pressure:press ? 1 : 0];
}

// A modifier change of a person in the window, a key event that the drive lets pass.
static NSEvent *personModifierChange(NSWindow *window) {
    return [NSEvent keyEventWithType:NSEventTypeFlagsChanged location:NSZeroPoint modifierFlags:NSEventModifierFlagShift
        timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil characters:@""
        charactersIgnoringModifiers:@"" isARepeat:NO keyCode:56];
}

// The events of each window that the local monitors of the application see.
static NSMutableDictionary<NSNumber *, NSMutableArray<NSNumber *> *> *monitored;

static NSUInteger seen(NSWindow *window) {
    return monitored[@(window.windowNumber)].count;
}

// The buttons of a person, in place of AppKit.
static NSUInteger personButtons;
static NSUInteger testButtons(id self, SEL selector) { return personButtons; }

// The pointer events of a person that the drive drops. A press that reached AppKit could make the window key or order it, so the
// presses are sent only to a driven window, where no press reaches AppKit; a window that no check drives receives the moves.
static const NSEventType personTypes[] = {
    NSEventTypeMouseMoved, NSEventTypeMouseEntered, NSEventTypeMouseExited, NSEventTypeLeftMouseDown,
    NSEventTypeLeftMouseDragged, NSEventTypeLeftMouseUp, NSEventTypeRightMouseDown, NSEventTypeRightMouseUp,
};
static const NSUInteger personTypeCount = sizeof personTypes / sizeof personTypes[0];
static const NSUInteger personMoveCount = 3;

static void sendPersonEvents(NSWindow *window, NSUInteger count) {
    for (NSUInteger index = 0; index < count; index++) {
        [NSApp sendEvent:personEvent(window, personTypes[index], NSMakePoint(150, 100))];
    }
}

int main(void) { @autoreleasepool {
    setvbuf(stdout, NULL, _IOLBF, 0);
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    method_setImplementation(class_getClassMethod(NSEvent.class, @selector(pressedMouseButtons)), (IMP)testButtons);

    monitored = [NSMutableDictionary dictionary];
    const NSEventMask watched = NSEventMaskLeftMouseDown | NSEventMaskLeftMouseUp | NSEventMaskLeftMouseDragged
        | NSEventMaskRightMouseDown | NSEventMaskRightMouseUp | NSEventMaskMouseMoved | NSEventMaskMouseEntered
        | NSEventMaskMouseExited | NSEventMaskFlagsChanged;
    id monitor = [NSEvent addLocalMonitorForEventsMatchingMask:watched handler:^NSEvent *(NSEvent *event) {
        NSNumber *key = @(event.windowNumber);
        if (!monitored[key]) monitored[key] = [NSMutableArray array];
        [monitored[key] addObject:@(event.type)];
        return event;
    }];

    NSWindow *driven = recordingWindow(), *other = recordingWindow();

    sendPersonEvents(driven, personMoveCount);
    check(seen(driven) == personMoveCount, [NSString stringWithFormat:
        @"before the drive the moves of a person reach the application (%lu of %lu)",
        (unsigned long)seen(driven), (unsigned long)personMoveCount]);
    check(sp_input_check_end(driven) == 0, @"the end of a window that no check drives answers 0");

    check(sp_input_check_begin(driven), @"the drive of a window starts");
    check(sp_input_check_driven(driven) && !sp_input_check_driven(other) && sp_input_check_any(),
        @"the drive holds the driven window and no other");
    check(!sp_input_check_begin(driven), @"a window that a check already drives refuses a second drive");

    [monitored removeAllObjects];
    [viewEvents(driven) removeAllObjects];
    sendPersonEvents(driven, personTypeCount);
    check(seen(driven) == 0 && viewEvents(driven).count == 0, [NSString stringWithFormat:
        @"a pointer event of a person in the driven window reaches no monitor and no view (monitor %lu, view %@)",
        (unsigned long)seen(driven), viewEvents(driven)]);
    [NSApp sendEvent:personModifierChange(driven)];
    check(seen(driven) == 1, @"a key event of the driven window passes");
    sendPersonEvents(other, personMoveCount);
    check(seen(other) == personMoveCount, [NSString stringWithFormat:
        @"a pointer event of a person in another window reaches the application (%lu of %lu)",
        (unsigned long)seen(other), (unsigned long)personMoveCount]);

    // A synthetic event that a layout wait gives back passes once; the same content again is an event of a person.
    NSEvent *returned = personEvent(driven, NSEventTypeMouseMoved, NSMakePoint(120, 90));
    sp_input_check_returning(returned);
    [monitored removeAllObjects];
    [NSApp sendEvent:returned];
    check(seen(driven) == 1, @"a synthetic event that a layout wait gives back passes the drive");
    [NSApp sendEvent:returned];
    check(seen(driven) == 1, @"the mark of a returned event passes it once");

    // The synthetic input of a check passes, and a button that a person holds neither refuses it nor is read as a person's.
    personButtons = 1;
    check(sp_input_person_buttons() == 0, @"no button of a person is read while a check drives a window");
    [viewEvents(driven) removeAllObjects];
    sp_input_result press = sp_input_pointer(driven, 150, 100, 1, 0, 0, 0);
    sp_input_result drag = sp_input_pointer(driven, 160, 100, 2, 0, 0, 0);
    sp_input_result release = sp_input_pointer(driven, 160, 100, 3, 0, 0, 0);
    check(press == SP_INPUT_DELIVERED && drag == SP_INPUT_DELIVERED && release == SP_INPUT_DELIVERED, [NSString stringWithFormat:
        @"the synthetic press, drag and release of a check are delivered while a person holds a button (%d, %d, %d)",
        press, drag, release]);
    check([viewEvents(driven) isEqualToArray:@[ @"mouseDown", @"mouseDragged", @"mouseUp" ]], [NSString stringWithFormat:
        @"the synthetic gesture reaches the view of the driven window (%@)", viewEvents(driven)]);

    uint64_t dropped = sp_input_check_end(driven);
    check(dropped == personTypeCount + 1, [NSString stringWithFormat:
        @"the end answers the pointer events of a person that the window did not take (%llu, expected %lu)",
        (unsigned long long)dropped, (unsigned long)personTypeCount + 1]);
    check(!sp_input_check_driven(driven) && !sp_input_check_any(), @"the end releases the window");
    check(sp_input_person_buttons() == 1, @"after the drive the buttons of a person are read again");
    personButtons = 0;
    [monitored removeAllObjects];
    sendPersonEvents(driven, personMoveCount);
    check(seen(driven) == personMoveCount, @"after the drive the window takes the input of a person again");

    NSWindow *closing = recordingWindow();
    check(sp_input_check_begin(closing), @"the drive of a window that closes starts");
    [closing close];
    check(!sp_input_check_driven(closing) && !sp_input_check_any(), @"the close of a window ends its drive");

    [NSEvent removeMonitor:monitor];
    printf("%s\n", failures ? "FAIL: input_check_test" : "PASS: input_check_test");
    return failures ? 1 : 0;
} }
