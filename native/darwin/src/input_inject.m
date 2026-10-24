// Creates native input events and delivers them to the views of a window.
//
// Key events are delivered to the responder of the window with -[NSWindow sendEvent:]. When a window is not active,
// AppKit treats a pointer event as the first click and does not deliver it to the view, so the view at the coordinates
// is hit-tested and receives the press, and a drag and a release are delivered to the press target. A move is
// delivered to the owner of the tracking area that contains the coordinates. In every case the web view receives the
// native event and delivers a trusted event to the page. A scroll is created as an event that carries window
// information and is delivered with -[NSWindow sendEvent:]. The system cursor does not move, and no function except
// sp_input_activate activates the application.
//
// WebKit updates hover from a move without a button only when the page is active (the window is the key window)
// (WebFrame::handleMouseEvent). A move in a window that is not the key window is therefore rejected with
// SP_INPUT_INACTIVE, and a caller that needs hover activates the window with sp_input_activate before sending the move.
#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import "input_inject.h"
#import "input_press_context.h"
#import "observe.h"
#import "application_log.h"
#import "webview_input.h"
#import "webview_geometry.h"
#import "private/coregraphics.h"
#import "private/webkit.h"

static _Thread_local sp_input_press_context *currentPressContext = NULL;

void sp_input_press_context_push(sp_input_press_context *context, void *window, double x, double y) {
    NSCAssert(NSThread.isMainThread, @"synthetic press contexts belong to the main thread");
    context->previous = currentPressContext;
    context->window = window;
    context->x = x;
    context->y = y;
    currentPressContext = context;
}

void sp_input_press_context_pop(sp_input_press_context *context) {
    NSCAssert(NSThread.isMainThread, @"synthetic press contexts belong to the main thread");
    NSCAssert(currentPressContext == context, @"synthetic press contexts must be restored in nested order");
    currentPressContext = context->previous;
    context->previous = NULL;
}

bool sp_input_press_context_point(void *window, double *x, double *y) {
    NSCAssert(NSThread.isMainThread, @"synthetic press contexts belong to the main thread");
    for (sp_input_press_context *context = currentPressContext; context; context = context->previous) {
        if (context->window != window) continue;
        if (x) *x = context->x;
        if (y) *y = context->y;
        return true;
    }
    return false;
}

// Converts coordinates relative to the top-left of the content area into window coordinates. Follows the coordinate system direction of the content view.
static NSPoint windowPoint(NSWindow *window, double x, double y) {
    NSView *content = window.contentView;
    NSPoint local = NSMakePoint(x, content.isFlipped ? y : content.bounds.size.height - y);
    return [content convertPoint:local toView:nil];
}

static NSEventModifierFlags flags(unsigned modifiers) {
    NSEventModifierFlags result = 0;
    if (modifiers & 1) result |= NSEventModifierFlagShift;
    if (modifiers & 2) result |= NSEventModifierFlagControl;
    if (modifiers & 4) result |= NSEventModifierFlagOption;
    if (modifiers & 8) result |= NSEventModifierFlagCommand;
    return result;
}

static NSView *hitView(NSWindow *window, NSPoint point) {
    NSView *content = window.contentView;
    return [content hitTest:[content.superview convertPoint:point fromView:nil]];
}

// The view that received the press of a window and button receives the same gesture until the release.
static char leftPressedViewKey, rightPressedViewKey;
static const void *pressedViewKey(int button) {
    return button == 1 ? &rightPressedViewKey : &leftPressedViewKey;
}
static NSView *pointerTarget(NSWindow *window, NSPoint point, int phase, int button) {
    return phase == 2 || phase == 3 ? objc_getAssociatedObject(window, pressedViewKey(button)) : hitView(window, point);
}

static NSEvent *mouseEvent(NSWindow *window, NSEventType type, NSPoint point, NSInteger clicks, float pressure) {
    return [NSEvent mouseEventWithType:type location:point modifierFlags:0
        timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
        context:nil eventNumber:0 clickCount:clicks pressure:pressure];
}

// Delivers a move to the owner of the tracking area that contains the coordinates. With overlapping views, only the topmost view receives it.
static bool moveTo(NSWindow *window, NSPoint point) {
    NSView *hit = hitView(window, point);
    if (!hit) return false;
    NSEvent *event = mouseEvent(window, NSEventTypeMouseMoved, point, 0, 0);
    for (NSView *view = hit; view; view = view.superview) {
        [view updateTrackingAreas];
        for (NSTrackingArea *area in view.trackingAreas) {
            if (!(area.options & NSTrackingMouseMoved)) continue;
            if (!NSPointInRect([view convertPoint:point fromView:nil], area.rect) && !(area.options & NSTrackingInVisibleRect)) continue;
            [area.owner mouseMoved:event];
            return true;
        }
    }
    return false;
}

// Measurement of the turn rejected with SP_INPUT_BUTTON_HELD. front is a retained reference that heldDone releases.
typedef struct {
    NSUInteger buttons;
    NSRunningApplication *front;
    // Reason for the rejection; an empty string when the input was delivered.
    const char *why;
} SPHeld;

// When the result is SP_INPUT_BUTTON_HELD, held receives the mask of the rejected turn and the frontmost application.
static sp_input_result pointerInput(void *handle, double x, double y, int phase, int button, double deltaX, double deltaY,
    SPHeld *held) {
    NSWindow *window = (__bridge NSWindow *)handle;
    held->why = "";
    if (!window || !NSThread.isMainThread) { held->why = "no window or not the main thread"; return SP_INPUT_REJECTED; }
    NSPoint point = windowPoint(window, x, y);
    if (phase == 0) {
        if (!window.isKeyWindow) { held->why = "the window is not the key window"; return SP_INPUT_INACTIVE; }
        if (!moveTo(window, point)) { held->why = "no tracking area at the point"; return SP_INPUT_REJECTED; }
        return SP_INPUT_DELIVERED;
    }
    if (phase == 4) {
        // The public API has no way to create a scroll event that carries window information. Setting the window number
        // (field 51) and the window location (CGEventSetWindowLocation) on a CGEvent yields an NSEvent with a window and
        // locationInWindow, and -[NSWindow sendEvent:] delivers it to the view at the coordinates. Both are CoreGraphics
        // features that are not public, so they are recorded in docs/operations/private-native-apis.md and
        // tests/input_inject_test.m checks that the scroll actually happens.
        CGEventRef scroll = CGEventCreateScrollWheelEvent2(NULL, kCGScrollEventUnitPixel, 2,
            (int32_t)-deltaY, (int32_t)-deltaX, 0);
        if (!scroll) { held->why = "the scroll event cannot be created"; return SP_INPUT_REJECTED; }
        // An event without a source inherits the real modifier key state. Pointer input takes no modifier keys, so the state is cleared.
        CGEventSetFlags(scroll, 0);
        NSPoint screen = [window convertPointToScreen:point];
        CGFloat top = NSMaxY(NSScreen.screens.firstObject.frame);
        CGEventSetLocation(scroll, CGPointMake(screen.x, top - screen.y));
        CGEventSetIntegerValueField(scroll, kSPEventWindowNumberField, window.windowNumber);
        CGEventSetWindowLocation(scroll, CGPointMake(point.x, NSHeight(window.frame) - point.y));
        NSEvent *event = [NSEvent eventWithCGEvent:scroll];
        CFRelease(scroll);
        if (event.window != window) { held->why = "the scroll event has another window"; return SP_INPUT_REJECTED; }
        // The event monitor of the application converts a real wheel event to surface coordinate units. sendEvent does not pass through the monitor.
        [window sendEvent:webviewScrollInViewUnits(event, hitView(window, point))];
        return SP_INPUT_DELIVERED;
    }
    NSView *hit = pointerTarget(window, point, phase, button);
    if (!hit) { held->why = phase == 2 || phase == 3 ? "no open press for the drag or release" : "no view at the point"; return SP_INPUT_REJECTED; }
    if (hit.window != window) {
        objc_setAssociatedObject(window, pressedViewKey(button), nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        held->why = "the target view left the window";
        return SP_INPUT_REJECTED;
    }
    // WebKit reads the pressed buttons of a mouse event from +[NSEvent pressedMouseButtons], not from the event.
    // While AppKit reports a pressed button, WebKit can handle a press and a release as pointermove instead of pointerdown
    // or pointerup, so they are not delivered and the rejection is reported. This state alone does not identify the cause
    // of the button state, so the mask and the frontmost application are measured in the same rejected turn and reported together.
    NSUInteger buttons = NSEvent.pressedMouseButtons;
    if ((phase == 1 || phase == 3) && buttons != 0) {
        held->buttons = buttons;
        held->front = [NSWorkspace.sharedWorkspace.frontmostApplication retain];
        held->why = "AppKit reports a pressed mouse button";
        return SP_INPUT_BUTTON_HELD;
    }
    BOOL right = button == 1;
    switch (phase) {
        case 1:
            // A delivered release ends an open press. A rejected release leaves the press open, so the next press reports that fact.
            if (objc_getAssociatedObject(window, pressedViewKey(button))) { held->why = "a press of this button is still open"; return SP_INPUT_PRESS_OPEN; }
            objc_setAssociatedObject(window, pressedViewKey(button), hit, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
            // -[NSApplication sendEvent:] is not used because it fails to deliver a synthetic first click to an inactive
            // window. The explicit context lets click-through native regions classify the synchronous responder change
            // without changing NSApp.currentEvent.
            sp_input_press_context context = {0};
            sp_input_press_context_push(&context, window, point.x, point.y);
            @try {
                // -[NSWindow sendEvent:] normally makes the pressed view first responder before the press. This path
                // delivers directly to the view, so it follows that order without activating the window or application.
                if (hit != window.firstResponder && hit.acceptsFirstResponder) [window makeFirstResponder:hit];
                if (right) [hit rightMouseDown:mouseEvent(window, NSEventTypeRightMouseDown, point, 1, 1)];
                else [hit mouseDown:mouseEvent(window, NSEventTypeLeftMouseDown, point, 1, 1)];
            } @finally {
                sp_input_press_context_pop(&context);
            }
            return SP_INPUT_DELIVERED;
        case 2:
            if (right) [hit rightMouseDragged:mouseEvent(window, NSEventTypeRightMouseDragged, point, 0, 1)];
            else [hit mouseDragged:mouseEvent(window, NSEventTypeLeftMouseDragged, point, 0, 1)];
            return SP_INPUT_DELIVERED;
        case 3:
            if (right) [hit rightMouseUp:mouseEvent(window, NSEventTypeRightMouseUp, point, 1, 0)];
            else [hit mouseUp:mouseEvent(window, NSEventTypeLeftMouseUp, point, 1, 0)];
            objc_setAssociatedObject(window, pressedViewKey(button), nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
            return SP_INPUT_DELIVERED;
        default:
            held->why = "unknown phase";
            return SP_INPUT_REJECTED;
    }
}

// Name of the result of the injected input.
static const char *resultName(sp_input_result result) {
    switch (result) {
        case SP_INPUT_DELIVERED: return "delivered";
        case SP_INPUT_REJECTED: return "rejected";
        case SP_INPUT_INACTIVE: return "inactive";
        case SP_INPUT_UNRECEIVED: return "unreceived";
        case SP_INPUT_BUTTON_HELD: return "button held";
        case SP_INPUT_PRESS_OPEN: return "press open";
    }
    return "unknown";
}

// Records one injected pointer input with its arguments, result, and rejection reason. Every path by which the caller receives a result uses it.
static void logPointer(double x, double y, int phase, int button, double deltaX, double deltaY,
    sp_input_result result, const char *why) {
    NSString *text = [NSString stringWithFormat:
        @"{\"kind\":\"pointer\",\"x\":%g,\"y\":%g,\"phase\":%d,\"button\":%d,\"deltaX\":%g,\"deltaY\":%g,\"result\":\"%s\",\"reason\":\"%s\"}",
        x, y, phase, button, deltaX, deltaY, resultName(result), why ?: ""];
    sp_log_info("input inject", text.UTF8String);
}

sp_input_result sp_input_pointer(void *handle, double x, double y, int phase, int button, double deltaX, double deltaY) {
    SPHeld held = {0, nil, ""};
    sp_input_result result = pointerInput(handle, x, y, phase, button, deltaX, deltaY, &held);
    logPointer(x, y, phase, button, deltaX, deltaY, result, held.why);
    [held.front release];
    return result;
}

// Calls done and releases the reference of held. held is reported only when result is SP_INPUT_BUTTON_HELD.
static void heldDone(sp_input_done done, void *context, sp_input_result result, SPHeld held) {
    if (result != SP_INPUT_BUTTON_HELD) {
        [held.front release];
        done(context, result, NULL);
        return;
    }
    sp_input_held report = {
        .mask = held.buttons,
        .pid = held.front ? held.front.processIdentifier : -1,
        .bundleIdentifier = held.front.bundleIdentifier.UTF8String,
    };
    done(context, result, &report);
    [held.front release];
}

// Delivers the input and reports the result to done immediately.
static void pointerNow(void *handle, double x, double y, int phase, int button, double deltaX, double deltaY,
    sp_input_done done, void *context) {
    SPHeld held = {0, nil, ""};
    sp_input_result result = pointerInput(handle, x, y, phase, button, deltaX, deltaY, &held);
    logPointer(x, y, phase, button, deltaX, deltaY, result, held.why);
    heldDone(done, context, result, held);
}

// Innermost web view that receives the event at the coordinates.
static WKWebView *webViewAt(NSWindow *window, double x, double y) {
    NSView *view = hitView(window, windowPoint(window, x, y));
    while (view && ![view isKindOfClass:WKWebView.class]) view = view.superview;
    return (WKWebView *)view;
}

void sp_input_pointer_then(void *handle, double x, double y, int phase, int button, double deltaX, double deltaY,
    double timeoutSeconds, sp_input_done done, void *context) {
    NSWindow *window = (__bridge NSWindow *)handle;
    NSView *pressed = window && NSThread.isMainThread ? pointerTarget(window, windowPoint(window, x, y), phase, button) : nil;
    while (pressed && ![pressed isKindOfClass:WKWebView.class]) pressed = pressed.superview;
    WKWebView *target = (WKWebView *)pressed;
    if (phase == 4 && target) {
        // A wheel event received before the scroll tree of a new document is rendered does not move the document. The event is
        // delivered after the target web view has rendered its current state. When it does not render within the timeout, the event is not delivered and the failure is reported.
        __block BOOL finished = NO;
        [target _doAfterNextPresentationUpdate:^{
            if (finished) return;
            finished = YES;
            pointerNow(handle, x, y, phase, button, deltaX, deltaY, done, context);
        }];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeoutSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            if (finished) return;
            finished = YES;
            logPointer(x, y, phase, button, deltaX, deltaY, SP_INPUT_UNRECEIVED, "the scroll target did not present within the limit");
            done(context, SP_INPUT_UNRECEIVED, NULL);
        });
        return;
    }
    if (phase != 1 && phase != 3) {
        pointerNow(handle, x, y, phase, button, deltaX, deltaY, done, context);
        return;
    }
    if (!target) {
        pointerNow(handle, x, y, phase, button, deltaX, deltaY, done, context);
        return;
    }
    // Completes after the document has received pointerdown or pointerup. After receipt, it waits for the pending mouse
    // handling of WebKit, so the click that a release creates is also processed before the next request.
    __block sp_input_result result = SP_INPUT_REJECTED;
    __block SPHeld held = {0, nil, "the press or release was not sent"};
    webviewInputSendThen(target, phase == 3 ? @"pointerup" : @"pointerdown", timeoutSeconds, ^BOOL {
        result = pointerInput(handle, x, y, phase, button, deltaX, deltaY, &held);
        return result == SP_INPUT_DELIVERED;
    }, ^(BOOL received) {
        sp_input_result final = result == SP_INPUT_DELIVERED && received ? SP_INPUT_DELIVERED :
            result == SP_INPUT_DELIVERED ? SP_INPUT_UNRECEIVED : result;
        logPointer(x, y, phase, button, deltaX, deltaY, final,
            final == SP_INPUT_UNRECEIVED ? "the document did not receive the press or release within the limit" : held.why);
        heldDone(done, context, final, held);
    });
}

static void collectVisibleWebViews(NSView *view, NSMutableArray<WKWebView *> *found, BOOL ancestorVisible) {
    BOOL visible = ancestorVisible && !view.hidden && view.alphaValue > 0 && view.window != nil;
    if (visible && [view isKindOfClass:WKWebView.class]) [found addObject:(WKWebView *)view];
    for (NSView *child in view.subviews) collectVisibleWebViews(child, found, visible);
}

// Calls done after every web view in the window has sent its activity state to the web process. When WebKit receives
// the key window notification, it schedules the activity state transmission, and _doAfterActivityStateUpdate: is called
// after the scheduled transmission finishes (immediately when none is scheduled). The registration is made in the next
// main queue turn so that it runs after every other observer of the notification has run.
static void afterWebViewsActive(NSWindow *window, WKWebView *target, BOOL waitForAll, void (^done)(void)) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (target) {
            [target _doAfterActivityStateUpdate:done];
            return;
        }
        if (!waitForAll) { done(); return; }
        NSMutableArray<WKWebView *> *views = [NSMutableArray array];
        collectVisibleWebViews(window.contentView.superview ?: window.contentView, views, YES);
        __block NSUInteger pending = views.count;
        if (pending == 0) { done(); return; }
        for (WKWebView *view in views) {
            [view _doAfterActivityStateUpdate:^{
                if (--pending == 0) done();
            }];
        }
    });
}

static void report(sp_activate_done done, void *context, sp_activate_result result) {
    if (result == SP_ACTIVATE_DONE) { done(context, result, NULL); return; }
    NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
    NSString *name = front.bundleIdentifier ?: front.localizedName;
    done(context, result, name.UTF8String);
}

static void activateWindow(NSWindow *window, WKWebView *target, BOOL waitForAll, double timeoutSeconds, sp_activate_done done, void *context) {
    if (!window || !NSThread.isMainThread) { report(done, context, SP_ACTIVATE_REJECTED); return; }
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    __block bool finished = false;
    __block bool waiting = true;
    __block id keyObserver = nil;
    __block id appObserver = nil;
    void (^stopWaiting)(void) = ^{
        if (!waiting) return;
        waiting = false;
        [center removeObserver:keyObserver];
        [center removeObserver:appObserver];
    };
    void (^finish)(sp_activate_result) = ^(sp_activate_result result) {
        if (finished) return;
        finished = true;
        stopWaiting();
        report(done, context, result);
    };
    // Checks that the window is still active after the web view sent its activity state. Another application or window can take focus in between.
    void (^applied)(void) = ^{
        finish(NSApp.isActive && window.isKeyWindow ? SP_ACTIVATE_DONE : SP_ACTIVATE_LOST);
    };
    // The order of the key window notification and the application activation notification is not defined, so the check runs on both notifications.
    void (^check)(void) = ^{
        if (!waiting || !NSApp.isActive || !window.isKeyWindow) return;
        stopWaiting();
        afterWebViewsActive(window, target, waitForAll, applied);
    };
    // The system can refuse an activation request (cooperative activation in macOS 14), and the user can move focus to
    // another application right after activation. The timeout applies to the whole of activation and web view state transmission, so the stage at which it stopped is always reported.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeoutSeconds * NSEC_PER_SEC)),
        dispatch_get_main_queue(), ^{
            if (!waiting) finish(SP_ACTIVATE_PENDING);
            else finish(NSApp.isActive ? SP_ACTIVATE_NOT_KEY : SP_ACTIVATE_REFUSED);
        });
    if (NSApp.isActive && window.isKeyWindow) {
        waiting = false;
        afterWebViewsActive(window, target, waitForAll, applied);
        return;
    }
    keyObserver = sp_observe_notification("input_inject.key_window", SP_OBSERVE_RECORD, NSWindowDidBecomeKeyNotification, window, nil,
        ^(NSNotification *note) { check(); });
    appObserver = sp_observe_notification("input_inject.app_active", SP_OBSERVE_RECORD, NSApplicationDidBecomeActiveNotification, NSApp, nil,
        ^(NSNotification *note) { check(); });
    [window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

void sp_input_activate(void *handle, double timeoutSeconds, sp_activate_done done, void *context) {
    activateWindow((__bridge NSWindow *)handle, nil, YES, timeoutSeconds, done, context);
}

void sp_input_activate_at(void *handle, double x, double y, double timeoutSeconds, sp_activate_done done, void *context) {
    NSWindow *window = (__bridge NSWindow *)handle;
    WKWebView *target = window && NSThread.isMainThread ? webViewAt(window, x, y) : nil;
    activateWindow(window, target, NO, timeoutSeconds, done, context);
}

typedef struct { const char *name; unsigned short code; } SPKey;

// macOS key code of a named key. AppKit derives a character from the key code and the current input source.
static const SPKey keys[] = {
    {"Enter", 36}, {"Tab", 48}, {"Escape", 53}, {"Backspace", 51},
    {"Delete", 117}, {"Space", 49},
    {"ArrowLeft", 123}, {"ArrowRight", 124},
    {"ArrowDown", 125}, {"ArrowUp", 126},
    {"Home", 115}, {"End", 119},
    {"PageUp", 116}, {"PageDown", 121},
};

// An NSEvent that carries only a character has no physical key identity. NSTextInputContext needs a key code to
// apply the current keyboard input source, and Korean composition is included. The code below converts the
// character specified by the endpoint to a macOS ANSI keyboard position, and rejects an unknown character instead of
// replacing it with a guessed code.
static unsigned short characterKeyCode(unichar character) {
    static const char *letters = "abcdefghijklmnopqrstuvwxyz";
    static const unsigned short letterCodes[] = {0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46, 45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7, 16, 6};
    for (NSUInteger i = 0; i < 26; i++) if (character == letters[i]) return letterCodes[i];
    static const char digits[] = "1234567890";
    static const unsigned short digitCodes[] = {18, 19, 20, 21, 23, 22, 26, 28, 25, 29};
    for (NSUInteger i = 0; i < 10; i++) if (character == digits[i]) return digitCodes[i];
    return USHRT_MAX;
}

static CGEventFlags cgFlags(unsigned modifiers) {
    CGEventFlags result = 0;
    if (modifiers & 1) result |= kCGEventFlagMaskShift;
    if (modifiers & 2) result |= kCGEventFlagMaskControl;
    if (modifiers & 4) result |= kCGEventFlagMaskAlternate;
    if (modifiers & 8) result |= kCGEventFlagMaskCommand;
    return result;
}

static sp_input_result keyInput(void *handle, const char *key, const char *text, unsigned modifiers, bool down,
    const char **why) {
    NSWindow *window = (__bridge NSWindow *)handle;
    *why = "";
    if (!window || !key || !NSThread.isMainThread) { *why = "no window, no key or not the main thread"; return SP_INPUT_REJECTED; }
    NSString *name = [NSString stringWithUTF8String:key];
    unsigned short code = USHRT_MAX;
    for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); i++) {
        if (strcmp(keys[i].name, key) == 0) {
            code = keys[i].code;
            break;
        }
    }
    if (code == USHRT_MAX) {
        if (name.length != 1) { *why = "unknown key name"; return SP_INPUT_REJECTED; }
        code = characterKeyCode([name characterAtIndex:0]);
        if (code == USHRT_MAX) { *why = "unknown key name"; return SP_INPUT_REJECTED; }
    }
    NSString *characters = text ? [NSString stringWithUTF8String:text] : nil;
    NSEvent *event = nil;
    if (!text) {
        // AppKit derives the character from the physical key and the current input source. The same applies to a named key.
        // An event with a character inserted directly from the caller does not pass through the input method (for example Backspace during composition).
        CGEventRef raw = CGEventCreateKeyboardEvent(NULL, code, down);
        if (raw) {
            CGEventSetFlags(raw, cgFlags(modifiers));
            CGEventSetIntegerValueField(raw, kSPEventWindowNumberField, window.windowNumber);
            event = [NSEvent eventWithCGEvent:raw];
            CFRelease(raw);
        }
    } else {
        event = [NSEvent keyEventWithType:down ? NSEventTypeKeyDown : NSEventTypeKeyUp
            location:NSZeroPoint modifierFlags:flags(modifiers)
            timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
            context:nil characters:characters charactersIgnoringModifiers:characters
            isARepeat:NO keyCode:code];
    }
    if (!event) { *why = "the key event cannot be created"; return SP_INPUT_REJECTED; }
    // A human key goes only to the key window. When another window is the key window, the key is not delivered to the target window and the rejection is reported.
    NSWindow *keyWindow = NSApp.keyWindow;
    if (keyWindow && keyWindow != window) { *why = "another window is the key window"; return SP_INPUT_INACTIVE; }
    // When the target window is the key window, the key is dispatched with -[NSApplication sendEvent:] like a human key.
    // AppKit also decides the menu key equivalents (Command+C, Command+V). An inactive application with no key window
    // receives no human key, so the key is sent to the target window for checks that do not activate the window.
    if (keyWindow == window) [NSApp sendEvent:event];
    else [window sendEvent:event];
    return SP_INPUT_DELIVERED;
}

// JSON string of text; null when text is NULL.
static NSString *jsonText(const char *text) {
    if (!text) return @"null";
    NSData *data = [NSJSONSerialization dataWithJSONObject:[NSString stringWithUTF8String:text]
        options:NSJSONWritingFragmentsAllowed error:NULL];
    return data ? [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease] : @"null";
}

sp_input_result sp_input_key(void *handle, const char *key, const char *text, unsigned modifiers, bool down) {
    const char *why = "";
    // The view that holds the keyboard when the key is sent receives it; the record names it with the key window.
    NSWindow *window = (__bridge NSWindow *)handle;
    NSResponder *responder = window.firstResponder;
    NSString *responderName = responder ? NSStringFromClass(responder.class) : @"none";
    sp_input_result result = keyInput(handle, key, text, modifiers, down, &why);
    NSString *record = [NSString stringWithFormat:
        @"{\"kind\":\"key\",\"key\":%@,\"text\":%@,\"modifiers\":%u,\"down\":%s,\"result\":\"%s\",\"reason\":\"%s\","
        "\"responder\":\"%@\",\"keyWindow\":%s}",
        jsonText(key), jsonText(text), modifiers, down ? "true" : "false", resultName(result), why, responderName,
        window.isKeyWindow ? "true" : "false"];
    sp_log_info("input inject", record.UTF8String);
    return result;
}
