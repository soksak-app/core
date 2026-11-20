// The diagnostic action of a person (input_person.h). Each event is the event that the window server gives the application, and it
// is dispatched as the run loop of the application dispatches such an event.
#import <Cocoa/Cocoa.h>
#include <stdlib.h>
#include <string.h>
#import "input_person.h"
#import "input_virtual.h"
#import "private/coregraphics.h"

static bool refuse(char **error, const char *message) {
    *error = strdup(message);
    return false;
}

static NSEvent *mouse(NSWindow *window, NSEventType type, NSPoint point, NSInteger clicks, float pressure) {
    return [NSEvent mouseEventWithType:type location:point modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime
        windowNumber:window.windowNumber context:nil eventNumber:0 clickCount:clicks pressure:pressure];
}

// A scroll carries its window in the window number field and its window location, as the window server sets them; no public
// interface creates a scroll NSEvent with a window (docs/operations/private-native-apis.md).
static NSEvent *scroll(NSWindow *window, NSPoint point) {
    CGEventRef event = CGEventCreateScrollWheelEvent2(NULL, kCGScrollEventUnitPixel, 2, -4, 0, 0);
    if (!event) return nil;
    CGEventSetFlags(event, 0);
    NSPoint screen = [window convertPointToScreen:point];
    CGEventSetLocation(event, CGPointMake(screen.x, NSMaxY(NSScreen.screens.firstObject.frame) - screen.y));
    CGEventSetIntegerValueField(event, kSPEventWindowNumberField, window.windowNumber);
    CGEventSetWindowLocation(event, CGPointMake(point.x, NSHeight(window.frame) - point.y));
    NSEvent *result = [NSEvent eventWithCGEvent:event];
    CFRelease(event);
    return result.window == window ? result : nil;
}

bool sp_input_person(void *handle, const char *action, double x, double y, char **error) {
    NSWindow *window = (__bridge NSWindow *)handle;
    if (!window || !NSThread.isMainThread) return refuse(error, "no window or not the main thread");
    bool press = action && strcmp(action, "press") == 0, move = action && strcmp(action, "move") == 0;
    bool wheel = action && strcmp(action, "scroll") == 0;
    if (!press && !move && !wheel) return refuse(error, "action must be press, move or scroll");
    if (!window.isVisible || window.isMiniaturized) return refuse(error, "the window is not shown");
    // AppKit activates the application at a press in a window that is not the key window (-[NSWindow sendEvent:]); the virtual key
    // window and the key window of an application that is really active take a press without an activation.
    if (press && !sp_input_virtual_is(handle) && !sp_input_virtual_real_key(handle)) {
        return refuse(error, "a press of a person reaches only the key window");
    }
    NSView *content = window.contentView;
    NSPoint point = [content convertPoint:NSMakePoint(x, content.isFlipped ? y : NSHeight(content.bounds) - y) toView:nil];
    if (press) {
        [NSApp sendEvent:mouse(window, NSEventTypeLeftMouseDown, point, 1, 1)];
        [NSApp sendEvent:mouse(window, NSEventTypeLeftMouseUp, point, 1, 0)];
    } else if (move) {
        [NSApp sendEvent:mouse(window, NSEventTypeMouseMoved, point, 0, 0)];
    } else {
        NSEvent *event = scroll(window, point);
        if (!event) return refuse(error, "the scroll event has no window");
        [NSApp sendEvent:event];
    }
    return true;
}
