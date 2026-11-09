// Checks that the surface coordinate system keeps fractional surface sizes and the last device pixel at 1x and 2x
// scale and on scale changes, and that the document region inside a surface draws at the same scale as the surface.
// To run regardless of the connected displays, it changes the real backing scale of the window. Like the WebKit test
// runner, it uses -[NSWindow _setWindowResolution:] of AppKit (private, check only) and empties
// -_adjustWindowResolution so that the screen does not restore the scale. This method sends no notifications and no
// view callbacks, so the check sends the window notifications and viewDidChangeBackingProperties that AppKit sends on
// a display move. See docs/operations/private-native-apis.md. The check does not activate the application.
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <WebKit/WebKit.h>
#import "support/scaled_window.h"
#import "support/temporary_folder.h"
#import "document_view.h"
#import "input_inject.h"
#import "support/records.h"
#import "input_press_context.h"
#import "image_region.h"
#import "private/coregraphics.h"
#import "private/webkit.h"
#import "webview_input.h"
#import "webview_geometry.h"
#import "window_facts.h"
#import "surface_layout.h"
#import "support/surface_view.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Records the display state of the check window so that a failure can be narrowed to its cause.
static NSWindow *testWindow = nil;
static const char *currentStep = "setup";

static void failTimeout(const char *reason) {
    fprintf(stderr, "FAIL: %s within 10 seconds (step: %s, visible: %d, occlusion visible: %d, on active space: %d, "
        "app active: %d, AppKit mouse-button mask: %lu)\n", reason, currentStep, testWindow.isVisible,
        (testWindow.occlusionState & NSWindowOcclusionStateVisible) != 0, testWindow.isOnActiveSpace,
        NSApp.isActive, (unsigned long)NSEvent.pressedMouseButtons);
    exit(1);
}

static void until(BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    if (!done()) failTimeout("WebKit did not answer");
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

@interface SPLoaded : NSObject <WKNavigationDelegate>
@property BOOL finished;
@end
@implementation SPLoaded
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation { self.finished = YES; }
@end

static void load(WKWebView *view, NSString *html) {
    currentStep = __func__;
    SPLoaded *loaded = [[SPLoaded new] autorelease];
    view.navigationDelegate = loaded;
    [view loadHTMLString:html baseURL:nil];
    until(^BOOL { return loaded.finished; });
    view.navigationDelegate = nil;
}

// Waits until the document is laid out again with the new size and scale. If it never matches, reports the last
// value.
static NSDictionary *documentState(WKWebView *view, CGFloat scale, double width, double height) {
    currentStep = __func__;
    // WebKit exposes the CSS viewport as integer CSS pixels. Therefore a 200.5pt AppKit frame is reported as 200 CSS
    // px at 2x even when the native backing is 401px. The native geometry and the last backing row are checked
    // separately and match exactly. innerWidth and innerHeight include a classic scroll bar of the root, which
    // visualViewport excludes, so they state the frame size under both scroller styles.
    double cssHeight = floor(height);
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    NSDictionary *state = nil;
    for (;;) {
        state = evaluate(view, @"({ratio: devicePixelRatio, width: innerWidth,"
            " height: innerHeight, body: document.body?.getBoundingClientRect().height})");
        BOOL placed = [state[@"ratio"] doubleValue] == scale && [state[@"width"] doubleValue] == width
            && [state[@"height"] doubleValue] == cssHeight;
        if (placed) return state;
        if (deadline.timeIntervalSinceNow <= 0) break;
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    fprintf(stderr, "FAIL: the document did not take scale %g and CSS size %g x %g within 10 seconds: %s\n",
        scale, width, cssHeight, state.description.UTF8String);
    exit(1);
}

// Checks that the last device pixel row of the snapshot has the document color. A row that the document does not
// cover is white.
static BOOL lastRowIsDocument(WKWebView *view, CGFloat scale) {
    currentStep = __func__;
    __block NSImage *image = nil;
    WKSnapshotConfiguration *configuration = [[WKSnapshotConfiguration new] autorelease];
    [view takeSnapshotWithConfiguration:configuration completionHandler:^(NSImage *snapshot, NSError *error) {
        image = [snapshot retain];
    }];
    until(^BOOL { return image != nil; });
    NSBitmapImageRep *bitmap = [NSBitmapImageRep imageRepWithData:image.TIFFRepresentation];
    [image release];
    NSInteger rows = bitmap.pixelsHigh;
    NSColor *last = [[bitmap colorAtX:bitmap.pixelsWide / 2 y:rows - 1] colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
    return last.redComponent < 0.2 && last.greenComponent < 0.2 && last.blueComponent < 0.2;
}

// Presses the last device pixel of the surface with native input and returns the coordinates that the document
// received.
// Presses the surface at left points from its left edge and offset points below its top edge and returns the press
// that the document received.
static NSDictionary *pressSurfaceAt(NSWindow *window, WKWebView *surface, double left, double offset) {
    currentStep = __func__;
    double frame[4] = {0, 0, 0, 0};
    webviewGetFrame(surface, frame);
    double x = frame[0] + left, y = frame[1] + offset;
    NSView *content = window.contentView;
    NSPoint local = NSMakePoint(x, content.bounds.size.height - y);
    NSPoint inWindow = [content convertPoint:local toView:nil];
    NSView *hit = [content hitTest:[content convertPoint:inWindow fromView:nil]];
    BOOL surfaceHit = NO;
    for (NSView *view = hit; view; view = view.superview) if (view == surface) surfaceHit = YES;
    check(surfaceHit, [NSString stringWithFormat:@"the last surface pixel resolves to the DOM plane (hit %@)",
        NSStringFromClass(hit.class)]);
    evaluate(surface, @"window.pressed = null; null");
    // Reports the result code and the AppKit button state. While a pressed button is reported, the synthetic press is
    // not delivered (SP_INPUT_BUTTON_HELD). The document cannot receive an undelivered press, so the check fails
    // without waiting.
    NSUInteger buttons = NSEvent.pressedMouseButtons;
    sp_input_result down = sp_input_pointer(window, x, y, 1, 0, 0, 0);
    sp_input_result up = sp_input_pointer(window, x, y, 3, 0, 0, 0);
    BOOL delivered = down == SP_INPUT_DELIVERED && up == SP_INPUT_DELIVERED;
    check(delivered, [NSString stringWithFormat:@"press on the surface delivered at offset %g "
        "(down %d, up %d; AppKit button mask before %lu, after %lu)", offset, down, up,
        (unsigned long)buttons, (unsigned long)NSEvent.pressedMouseButtons]);
    if (!delivered) {
        fprintf(stderr, "FAIL: the press was not delivered (step: %s)\n", currentStep);
        exit(1);
    }
    __block NSDictionary *pressed = nil;
    until(^BOOL {
        id value = evaluate(surface, @"window.pressed");
        pressed = [value isKindOfClass:NSDictionary.class] ? value : nil;
        return pressed != nil;
    });
    return pressed;
}

// Presses the horizontal middle of the surface at offset points below its top edge.
static NSDictionary *pressSurface(NSWindow *window, WKWebView *surface, double offset) {
    double frame[4] = {0, 0, 0, 0};
    webviewGetFrame(surface, frame);
    return pressSurfaceAt(window, surface, frame[2] / 2, offset);
}

static void scrollDone(void *context, sp_input_result result, const sp_input_held *held) { *(sp_input_result *)context = result; }

static WKWebView *webViewAtTopPoint(NSWindow *window, double x, double y) {
    NSView *content = window.contentView;
    NSPoint local = NSMakePoint(x, content.bounds.size.height - y);
    NSPoint inWindow = [content convertPoint:local toView:nil];
    NSView *target = [content hitTest:[content convertPoint:inWindow fromView:nil]];
    while (target && ![target isKindOfClass:WKWebView.class]) target = target.superview;
    return (WKWebView *)target;
}

// Checks where the client origin of a scrolling root lies in the frame for a root direction. The page gives its root a
// 17 point styled scroll bar, which takes layout width under both scroller styles of AppKit. WebKit places the
// vertical scroll bar of a right-to-left root on the left, so the client origin lies the scroll bar width (innerWidth
// less the root clientWidth) right of the frame edge; for a left-to-right root it is the frame edge. The check waits
// until the layout has placed the scroll bar.
static void checkScrollBarSide(NSWindow *window, WKWebView *surface, NSString *direction) {
    load(surface, [NSString stringWithFormat:@"<!doctype html><html dir=%@ style='height:100%%'>"
        "<style>html::-webkit-scrollbar{width:17px;background:#123}</style>"
        "<body style='margin:0;height:100%%;background:#0d1a14'><div style='height:5000px'></div>"
        "<script>addEventListener('pointerup', e => window.pressed = {trusted: e.isTrusted, x: e.clientX, y: e.clientY}, true)</script>"
        "</body></html>", direction]);
    __block NSDictionary *state = nil;
    until(^BOOL {
        state = evaluate(surface, @"({inner: innerWidth, client: document.documentElement.clientWidth,"
            " direction: getComputedStyle(document.documentElement).direction})");
        return [state[@"inner"] doubleValue] - [state[@"client"] doubleValue] == 17;
    });
    double left = [direction isEqualToString:@"rtl"] ? 17 : 0;
    NSDictionary *pressed = pressSurfaceAt(window, surface, 20, 10);
    check([state[@"direction"] isEqualToString:direction] && [pressed[@"trusted"] boolValue]
        && [pressed[@"x"] doubleValue] == 20 - left,
        [NSString stringWithFormat:@"a %@ root with a 17 point scroll bar has its client origin %g points right of the frame edge (press %@; %@)",
            direction, left, pressed, state]);
}

// Waits while it takes events from the app event queue and handles them. Event monitors run when an event is taken.
// Takes and sends only the wheel events that this check queued. If every kind were taken, the app activation event
// sent by the OS (NSEventTypeAppKitDefined, activation subtype) would also be handled, and the default check would
// activate the app. On failure, reports the number of wheel events taken and sent, the mouse button mask that AppKit
// reported at the start, and the measurement returned by state.
static void pumpUntil(BOOL (^done)(void), NSString *(^state)(void)) {
    NSUInteger buttons = NSEvent.pressedMouseButtons;
    NSUInteger sent = 0;
    NSMutableArray *seen = [NSMutableArray array];
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskScrollWheel
            untilDate:[NSDate dateWithTimeIntervalSinceNow:0.01] inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event) {
            sent++;
            NSView *content = event.window.contentView;
            NSView *hit = [content hitTest:[content.superview convertPoint:event.locationInWindow fromView:nil]];
            [seen addObject:[NSString stringWithFormat:@"{delta %g,%g modifiers 0x%lx HID-system modifiers 0x%llx precise %d phase %lu momentum %lu window %d at %@ hit %@}",
                event.scrollingDeltaX, event.scrollingDeltaY, (unsigned long)event.modifierFlags,
                (unsigned long long)CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState), event.hasPreciseScrollingDeltas,
                (unsigned long)event.phase, (unsigned long)event.momentumPhase, event.window == testWindow,
                NSStringFromPoint(event.locationInWindow), hit.class]];
            [NSApp sendEvent:event];
        }
    }
    if (!done()) {
        fprintf(stderr, "wheel events dequeued and sent: %lu %s; AppKit button mask at start: %lu; %s\n",
            (unsigned long)sent, [seen componentsJoinedByString:@" "].UTF8String, (unsigned long)buttons, state().UTF8String);
        failTimeout("the event was not handled");
    }
}

// Waits until the web view finishes scrolling and returns the CSS pixels its document moved. Scrolling has finished
// when two displays report the same value. The per-display values and elapsed time of the last scroll measurement.
// The failure message reports these values.
static NSMutableString *scrollSamples = nil;

static double scrolledByView(WKWebView *view) {
    currentStep = __func__;
    NSDate *start = [NSDate date];
    [scrollSamples release];
    scrollSamples = [[NSMutableString alloc] init];
    until(^BOOL { return [evaluate(view, @"document.scrollingElement.scrollTop") doubleValue] > 0; });
    double last = -1, now = [evaluate(view, @"document.scrollingElement.scrollTop") doubleValue];
    [scrollSamples appendFormat:@"%g@%.0fms", now, -start.timeIntervalSinceNow * 1000];
    while (now != last) {
        last = now;
        __block BOOL shown = NO;
        [view _doAfterNextPresentationUpdate:^{ shown = YES; }];
        until(^BOOL { return shown; });
        now = [evaluate(view, @"document.scrollingElement.scrollTop") doubleValue];
        [scrollSamples appendFormat:@" %g@%.0fms", now, -start.timeIntervalSinceNow * 1000];
    }
    return now;
}

// Sends a 120-point scroll through the injected input path to the center of a web view and returns the CSS pixels
// the document of the view moved. The center must hit the view itself.
static double scrollViewCenter(NSWindow *window, WKWebView *view) {
    currentStep = __func__;
    evaluate(view, @"document.scrollingElement.scrollTop = 0; null");
    NSRect rect = [view convertRect:view.bounds toView:window.contentView];
    double x = NSMidX(rect), y = window.contentView.bounds.size.height - NSMidY(rect);
    WKWebView *target = webViewAtTopPoint(window, x, y);
    check(target == view, [NSString stringWithFormat:@"the center of the view at %g,%g is its own hit (got %@)", x, y, target]);
    __block BOOL shown = NO;
    [view _doAfterNextPresentationUpdate:^{ shown = YES; }];
    until(^BOOL { return shown; });
    __block sp_input_result result = SP_INPUT_REJECTED;
    sp_input_pointer_then(window, SP_INPUT_POINTER_MAIN, x, y, 4, 0, 0, 120, 1, 5, scrollDone, &result);
    until(^BOOL { return result != SP_INPUT_REJECTED; });
    check(result == SP_INPUT_DELIVERED, @"a 120-point scroll into the view is delivered");
    return scrolledByView(view);
}

// Sends a native wheel scroll to the surface and returns the CSS pixels the document moved. The wheel delta is in
// points and one CSS pixel is one point. If posted, queues a line-based wheel event (3 lines, 120 pixels) in the app
// event queue so that it passes through the app event monitor like a real event.
static double scrollBy(NSWindow *window, WKWebView *surface, BOOL posted) {
    currentStep = __func__;
    evaluate(surface, @"document.scrollingElement.scrollTop = 0; null");
    double frame[4] = {0, 0, 0, 0};
    webviewGetFrame(surface, frame);
    // Uses a point inside the top margin so that the surface receives it even after the document region (top margin
    // 20) exists.
    double x = frame[0] + frame[2] / 2, y = frame[1] + 10;
    NSView *contentForHit = window.contentView;
    NSPoint localForHit = NSMakePoint(x, contentForHit.bounds.size.height - y);
    NSPoint windowPointForHit = [contentForHit convertPoint:localForHit toView:nil];
    NSView *target = [contentForHit hitTest:[contentForHit convertPoint:windowPointForHit fromView:nil]];
    while (target && ![target isKindOfClass:WKWebView.class]) target = target.superview;
    NSView *hostForHit = surface.superview;
    BOOL insideHost = NO;
    for (NSView *view = target; view; view = view.superview) if (view == hostForHit) insideHost = YES;
    NSRect targetInHost = target ? [target convertRect:target.bounds toView:hostForHit] : NSZeroRect;
    check(target == surface, [NSString stringWithFormat:
        @"scroll target is the surface DOM plane (got %@ inside host %d, target frame %@, host frame %@)",
        target, insideHost, NSStringFromRect(targetInHost), NSStringFromRect(hostForHit.frame)]);
    __block BOOL shown = NO;
    [surface _doAfterNextPresentationUpdate:^{ shown = YES; }];
    until(^BOOL { return shown; });
    if (!posted) {
        __block sp_input_result result = SP_INPUT_REJECTED;
        sp_input_pointer_then(window, SP_INPUT_POINTER_MAIN, x, y, 4, 0, 0, 120, 1, 5, scrollDone, &result);
        until(^BOOL { return result != SP_INPUT_REJECTED; });
        check(result == SP_INPUT_DELIVERED, @"a scroll into the surface is delivered");
        return scrolledByView(surface);
    }
    NSView *content = window.contentView;
    NSPoint local = NSMakePoint(x, content.bounds.size.height - y);
    NSPoint inWindow = [content convertPoint:local toView:nil];
    NSPoint screen = [window convertPointToScreen:inWindow];
    // Counts so that the failure report states the number of wheel events that reached the document. Counts so that
    // the failure report states the number of wheel events that reached the document and the number of animation
    // frames that ran while waiting.
    evaluate(surface, @"window.wheels = 0; window.animationFrames = 0; if (!window.wheelCounted) { window.wheelCounted = true;"
        " addEventListener('wheel', () => { window.wheels++; }, {passive: true});"
        " const tick = () => { window.animationFrames++; requestAnimationFrame(tick); }; requestAnimationFrame(tick); } null");
    CGEventRef wheel = CGEventCreateScrollWheelEvent2(NULL, kCGScrollEventUnitLine, 1, -3, 0, 0);
    // An event without a source inherits the modifier keys of the real keyboard. AppKit converts the vertical
    // movement of a mouse wheel with Shift pressed into horizontal movement, so this scroll did not move the document
    // while a person held Shift (V5-25-1).
    CGEventSetFlags(wheel, 0);
    CGEventSetLocation(wheel, CGPointMake(screen.x, NSMaxY(NSScreen.screens.firstObject.frame) - screen.y));
    CGEventSetIntegerValueField(wheel, kSPEventWindowNumberField, window.windowNumber);
    CGEventSetWindowLocation(wheel, CGPointMake(inWindow.x, NSHeight(window.frame) - inWindow.y));
    [NSApp postEvent:[NSEvent eventWithCGEvent:wheel] atStart:NO];
    CFRelease(wheel);
    __block double moved = 0;
    pumpUntil(^BOOL { moved = [evaluate(surface, @"document.scrollingElement.scrollTop") doubleValue]; return moved > 0; },
        ^NSString *{ return [NSString stringWithFormat:@"last scrollTop: %g; document state: %@; scale %g; surface frame %@",
            moved, evaluate(surface, @"JSON.stringify({wheels: window.wheels, animationFrames: window.animationFrames,"
                " visibility: document.visibilityState, scrollHeight: document.scrollingElement.scrollHeight,"
                " clientHeight: document.scrollingElement.clientHeight, scrollTop: document.scrollingElement.scrollTop})"),
            window.backingScaleFactor, NSStringFromRect(surface.frame)]; });
    return scrolledByView(surface);
}

static void verify(SPScaledWindow *window, WKWebView *surface, CGFloat scale, double height, NSString *when) {
    double frame[4] = {0, 0, 0, 0};
    webviewGetFrame(surface, frame);
    check(frame[3] == height,
        [NSString stringWithFormat:@"%@: the native surface keeps the fractional height %g (got %g)", when, height, frame[3]]);
    NSDictionary *state = documentState(surface, scale, frame[2], frame[3]);
    double cssHeight = floor(frame[3]);
    check([state[@"body"] doubleValue] == cssHeight,
        [NSString stringWithFormat:@"%@: the document covers the CSS viewport quantized from native height %g (%@)", when, frame[3], state]);
    check(lastRowIsDocument(surface, scale),
        [NSString stringWithFormat:@"%@: the last device pixel row shows the document", when]);
    double injected = scrollBy(window, surface, NO);
    check(injected == 120,
        [NSString stringWithFormat:@"%@: an injected 120-point scroll moves the document by 120 CSS pixels (%g; samples %@; app active %d)", when, injected, scrollSamples, NSApp.isActive]);
    double posted = scrollBy(window, surface, YES);
    check(posted == 120,
        [NSString stringWithFormat:@"%@: a three-line scroll from the event queue moves the document by 120 CSS pixels (%g; samples %@; app active %d)", when, posted, scrollSamples, NSApp.isActive]);
    // The WebKit of macOS 15 reports whole CSS pixel pointer coordinates and a later one reports the fractional
    // point, so a press inside the surface measures the precision of this WebKit, and the press on the last device
    // pixel is expected at that precision.
    NSDictionary *inside = pressSurface(window, surface, 10.25);
    BOOL fractional = fabs([inside[@"y"] doubleValue] - 10.25) < 0.001;
    check([inside[@"trusted"] boolValue] && (fractional || [inside[@"y"] doubleValue] == 10),
        [NSString stringWithFormat:@"%@: a press at 10.25 points reports its point at the pointer precision of WebKit (%@)", when, inside]);
    NSDictionary *pressed = pressSurface(window, surface, frame[3] - 0.5 / scale);
    double expected = fractional ? frame[3] - 0.5 / scale : floor(frame[3] - 0.5 / scale);
    check([pressed[@"trusted"] boolValue] && fabs([pressed[@"y"] doubleValue] - expected) < 0.001,
        [NSString stringWithFormat:@"%@: the document receives input in the last device pixel at %g (%@)", when, expected, pressed]);
}

static void ignoreState(void *context, const char *state) {}

// Checks that the document region of the surface has its CSS size inside the margins at the same scale as the
// surface.
static void verifyRegion(WKWebView *region, CGFloat scale, double width, double height, NSString *when) {
    currentStep = __func__;
    NSDictionary *state = documentState(region, scale, width, height);
    check(state != nil, [NSString stringWithFormat:@"%@: the document region renders at scale %g with size %g x %g",
        when, scale, width, height]);
    // WebKit lays out and paints the whole points of the region frame, so a frame with a fractional size leaves its last
    // device pixel row to the backing of the web view. The region frame is the area that its page fills.
    NSSize frame = region.frame.size;
    check(frame.width == [state[@"width"] doubleValue] && frame.height == [state[@"height"] doubleValue],
        [NSString stringWithFormat:@"%@: the document region frame %g x %g is the CSS viewport of its page (%@)",
            when, frame.width, frame.height, state]);
}

static void droppedFiles(void *context, const char *json) {
    if (context) [(NSMutableArray *)context addObject:[NSString stringWithUTF8String:json]];
}

// Drag info that holds only the drag information the drop view reads (the drag pasteboard and the window
// coordinates).
@interface TestDraggingInfo : NSObject
@property(nonatomic, retain) NSPasteboard *draggingPasteboard;
@property(nonatomic, assign) NSPoint draggingLocation;
@end
@implementation TestDraggingInfo
- (void)dealloc { [_draggingPasteboard release]; [super dealloc]; }
@end

// The native view of a surface's native plane. The plane is the only subview of the surface that is not a web view.
static NSView *nativePlaneOf(NSView *surface) {
    for (NSView *child in surface.subviews) if ([NSStringFromClass(child.class) isEqualToString:@"SPSurfaceNativePlane"]) return child;
    return nil;
}

// The input that the view of a check received, in order.
static NSMutableArray<NSString *> *inputOrder;

// A native view that counts its presses. It takes the first click, because the check window is not the key window.
@interface SPPressCounter : NSView
@property(nonatomic) NSUInteger presses;
@end
@implementation SPPressCounter
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
- (BOOL)acceptsFirstResponder { return YES; }
- (void)mouseDown:(NSEvent *)event {
    self.presses++;
    [inputOrder addObject:@"press"];
}
- (void)keyDown:(NSEvent *)event { [inputOrder addObject:@"key"]; }
@end

static void pressDelivered(void *context, sp_input_result result, const sp_input_held *held) {
    *(sp_input_result *)context = result;
}

// An application that overrides sendEvent: as a framework does: it reads each event before super, and it sends a key up with
// the command key past super to the key window.
@interface SPOverridingApplication : NSApplication
@end

static NSMutableArray<NSNumber *> *overrideSights;

@implementation SPOverridingApplication
- (void)sendEvent:(NSEvent *)event {
    [overrideSights addObject:@(event.type)];
    if (event.type == NSEventTypeKeyUp && (event.modifierFlags & NSEventModifierFlagCommand)) [self.keyWindow sendEvent:event];
    else [super sendEvent:event];
}
@end

static void heldRegionEvent(void *context, const char *json) {}

// Sends the queued presses and releases of the check until done or the deadline, as the application loop does.
static void pumpInput(double seconds, BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny
            untilDate:[NSDate dateWithTimeIntervalSinceNow:0.01] inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event) [NSApp sendEvent:event];
    }
}

// Sends the queued presses of the check until done or the deadline, as the application loop does.
static void pumpPresses(double seconds, BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny
            untilDate:[NSDate dateWithTimeIntervalSinceNow:0.01] inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event) [NSApp sendEvent:event];
    }
}

// Adds a native view that covers the native plane, as a native document region does.
static NSView *addNativeView(NSView *surface) {
    NSView *plane = nativePlaneOf(surface);
    NSView *native = [[[NSView alloc] initWithFrame:plane.bounds] autorelease];
    native.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [plane addSubview:native];
    return native;
}

// A point given in the local coordinates of the surface, in the superview coordinates that AppKit passes to hitTest:.
static NSPoint superviewPoint(NSView *surface, NSPoint local) {
    return [surface convertPoint:local toView:surface.superview];
}


// Hit testing of the surface under its declared DOM overlay (20 points on each side). The surfaces are placed away from
// the origin of the window where a conversion error shows, and the overlay point is inside the overlay.
static void checkHitTesting(WKWebView *main) {
    currentStep = __func__;
    double overlay[5] = {20, 20, 20, 20, 1};
    // A surface with no web view: the point under its visible overlay is not a native hit.
    NSView *plain = (NSView *)sp_surface_create(sp_window_set_main_webview(main.window, main));
    plain.hidden = NO;
    webviewSetFrame(plain, 0, 0, 200, 150);
    addNativeView(plain);
    webviewSetSurfaceOverlays(plain, overlay, 1);
    check([plain hitTest:superviewPoint(plain, NSMakePoint(100, 80))] == nil,
        @"a point under the visible overlay of a surface without a web view is not a native hit");
    NSView *initiallyHidden = (NSView *)sp_surface_create(sp_window_set_main_webview(main.window, main));
    check(initiallyHidden.hidden, @"a new surface starts hidden");
    sp_surface_close(initiallyHidden);
    // The same kind of surface at a non-zero origin: a point outside its overlay is the native view of its plane.
    NSView *moved = (NSView *)sp_surface_create(sp_window_set_main_webview(main.window, main));
    moved.hidden = NO;
    webviewSetFrame(moved, 300, 20, 200, 150);
    NSView *movedNative = addNativeView(moved);
    webviewSetSurfaceOverlays(moved, overlay, 1);
    check([moved hitTest:superviewPoint(moved, NSMakePoint(5, 5))] == movedNative,
        [NSString stringWithFormat:@"a point outside the overlay of a surface at a non-zero origin is its native view (frame %@)",
            NSStringFromRect(moved.frame)]);
    moved.hidden = YES;
    check([moved hitTest:superviewPoint(moved, NSMakePoint(5, 5))] == nil,
        @"an explicitly hidden surface immediately stops receiving native hits");
    moved.hidden = NO;
    NSWindow *otherWindow = [[[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 120, 100)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO] autorelease];
    [otherWindow setReleasedWhenClosed:NO];
    otherWindow.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 120, 100)] autorelease];
    WKWebView *otherMain = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 120, 100)] autorelease];
    [otherWindow.contentView addSubview:otherMain];
    NSView *otherSurface = (NSView *)sp_surface_create(sp_window_set_main_webview(otherMain.window, otherMain));
    otherSurface.hidden = NO;
    webviewSetFrame(otherSurface, 0, 0, 100, 100);
    NSView *otherNative = addNativeView(otherSurface);
    __block BOOL layoutReady = NO;
    surfaceLayoutBegin(main.window, 77001, ^(int allowed) { layoutReady = allowed != 0; });
    check(layoutReady, @"the visible surface layout transaction starts synchronously");
    check(surfaceLayoutIsPreparing(main.window), @"the active window reports its layout preparation");
    check(!surfaceLayoutIsPreparing(otherWindow), @"a different window does not report the active preparation");
    check(!moved.hidden, @"layout preparation does not hide the visible surface");
    check([moved hitTest:superviewPoint(moved, NSMakePoint(5, 5))] == nil,
        @"native surface hit testing falls through while its window layout is preparing");
    NSPoint movedPointInWindow = [moved convertPoint:NSMakePoint(5, 5) toView:nil];
    NSPoint movedPointInContent = [main.window.contentView convertPoint:movedPointInWindow fromView:nil];
    NSView *fallback = [main.window.contentView hitTest:movedPointInContent];
    while (fallback && ![fallback isKindOfClass:WKWebView.class]) fallback = fallback.superview;
    check(fallback == main, @"input under a preparing surface falls through to the app DOM");
    check([otherSurface hitTest:superviewPoint(otherSurface, NSMakePoint(5, 5))] == otherNative,
        @"another window keeps native hit testing while this window is preparing");
    check(surfaceLayoutCommit(main.window, 77001), @"the visible surface layout transaction commits");
    check(!surfaceLayoutIsPreparing(main.window), @"the window no longer reports preparation after commit");
    check([moved hitTest:superviewPoint(moved, NSMakePoint(5, 5))] == movedNative,
        @"native surface hit testing resumes after its window layout commits");
    // A press under a preparing surface has no target on the screen yet, so it waits for the commit and reaches the surface.
    SPPressCounter *counter = [[[SPPressCounter alloc] initWithFrame:nativePlaneOf(moved).bounds] autorelease];
    [nativePlaneOf(moved) addSubview:counter];
    NSPoint pressInWindow = [moved convertPoint:NSMakePoint(5, 5) toView:nil];
    NSView *content = main.window.contentView;
    NSPoint pressInContent = [content convertPoint:pressInWindow fromView:nil];
    double pressY = content.isFlipped ? pressInContent.y : content.bounds.size.height - pressInContent.y;
    surfaceLayoutBegin(main.window, 77002, ^(int allowed) {});
    sp_input_result pressResult = SP_INPUT_UNRECEIVED;
    sp_input_pointer_then(main.window, SP_INPUT_POINTER_MAIN, pressInContent.x, pressY, 1, 0, 0, 0, 1, 5, pressDelivered, &pressResult);
    check(counter.presses == 0, @"an injected press does not reach the surface during its preparation");
    check(surfaceLayoutCommit(main.window, 77002), @"the layout of the injected press commits");
    pumpPresses(2, ^BOOL { return counter.presses == 1 && pressResult != SP_INPUT_UNRECEIVED; });
    check(counter.presses == 1, @"an injected press under a preparing surface reaches the surface after the commit");
    check(pressResult == SP_INPUT_DELIVERED, @"the injected press reports its delivery after the commit");
    check(sp_input_pointer(main.window, pressInContent.x, pressY, 3, 0, 0, 0) == SP_INPUT_DELIVERED,
        @"the injected press releases");
    NSEvent *press = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:pressInWindow modifierFlags:0 timestamp:0
        windowNumber:main.window.windowNumber context:nil eventNumber:0 clickCount:1 pressure:1];
    surfaceLayoutBegin(main.window, 77003, ^(int allowed) {});
    [NSApp postEvent:press atStart:NO];
    pumpPresses(0.1, ^BOOL { return NO; });
    check(counter.presses == 1, @"a press of the window system does not reach the surface during its preparation");
    check(surfaceLayoutCommit(main.window, 77003), @"the layout of the press of the window system commits");
    pumpPresses(2, ^BOOL { return counter.presses == 2; });
    check(counter.presses == 2, @"a press of the window system under a preparing surface reaches the surface after the commit");
    // A press and a release that wait for a commit reach every monitor of the application once, whatever order AppKit calls
    // the monitors in, which differs from process to process.
    NSUInteger *seen = calloc(32, sizeof(NSUInteger));
    NSUInteger *seenWhenHeld = calloc(32, sizeof(NSUInteger));
    __block BOOL holding = NO;
    NSMutableArray *watchers = [NSMutableArray array];
    for (int index = 0; index < 32; index++) {
        id watcher = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown | NSEventMaskLeftMouseUp
            handler:^NSEvent *(NSEvent *event) {
                seen[index]++;
                if (holding) seenWhenHeld[index]++;
                return event;
            }];
        [watchers addObject:watcher];
    }
    NSEvent *heldDown = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:pressInWindow modifierFlags:0 timestamp:0
        windowNumber:main.window.windowNumber context:nil eventNumber:0 clickCount:1 pressure:1];
    NSEvent *heldUp = [NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:pressInWindow modifierFlags:0 timestamp:0
        windowNumber:main.window.windowNumber context:nil eventNumber:0 clickCount:1 pressure:0];
    surfaceLayoutBegin(main.window, 77004, ^(int allowed) {});
    holding = YES;
    [NSApp postEvent:heldDown atStart:NO];
    [NSApp postEvent:heldUp atStart:NO];
    pumpInput(0.1, ^BOOL { return NO; });
    holding = NO;
    NSUInteger heldSights = 0, wrongSights = 0;
    for (int index = 0; index < 32; index++) heldSights += seenWhenHeld[index];
    check(heldSights == 0, [NSString stringWithFormat:@"no monitor sees a press or a release while it waits (%lu sights)", (unsigned long)heldSights]);
    check(surfaceLayoutCommit(main.window, 77004), @"the layout of the held press and release commits");
    pumpInput(0.5, ^BOOL { return NO; });
    for (int index = 0; index < 32; index++) wrongSights += seen[index] != 2;
    check(wrongSights == 0, [NSString stringWithFormat:@"every monitor sees a held press and release once each (%lu monitors differ)", (unsigned long)wrongSights]);
    for (id watcher in watchers) [NSEvent removeMonitor:watcher];

    // The override of the application stands behind the hold too, and input that overtakes nothing else keeps its order.
    NSEvent *commandUp = [NSEvent keyEventWithType:NSEventTypeKeyUp location:NSZeroPoint modifierFlags:NSEventModifierFlagCommand
        timestamp:0 windowNumber:main.window.windowNumber context:nil characters:@"x" charactersIgnoringModifiers:@"x"
        isARepeat:NO keyCode:7];
    NSEvent *otherDown = [NSEvent mouseEventWithType:NSEventTypeOtherMouseDown location:pressInWindow modifierFlags:0 timestamp:0
        windowNumber:main.window.windowNumber context:nil eventNumber:0 clickCount:1 pressure:1];
    NSEvent *otherUp = [NSEvent mouseEventWithType:NSEventTypeOtherMouseUp location:pressInWindow modifierFlags:0 timestamp:0
        windowNumber:main.window.windowNumber context:nil eventNumber:0 clickCount:1 pressure:0];
    NSEvent *flags = [NSEvent keyEventWithType:NSEventTypeFlagsChanged location:NSZeroPoint modifierFlags:NSEventModifierFlagShift
        timestamp:0 windowNumber:main.window.windowNumber context:nil characters:@"" charactersIgnoringModifiers:@""
        isARepeat:NO keyCode:56];
    NSEvent *heldMove = [NSEvent mouseEventWithType:NSEventTypeMouseMoved location:pressInWindow modifierFlags:0 timestamp:0
        windowNumber:main.window.windowNumber context:nil eventNumber:0 clickCount:0 pressure:0];
    NSArray<NSEvent *> *ordered = @[ heldDown, heldMove, otherDown, otherUp, flags, heldUp, commandUp ];
    surfaceLayoutBegin(main.window, 77006, ^(int allowed) {});
    overrideSights = [NSMutableArray array];
    for (NSEvent *event in ordered) [NSApp postEvent:event atStart:NO];
    pumpInput(0.1, ^BOOL { return NO; });
    check(overrideSights.count == 0,
        [NSString stringWithFormat:@"an override of the application sees no input that waits: %@", overrideSights]);
    [overrideSights removeAllObjects];
    check(surfaceLayoutCommit(main.window, 77006), @"the layout of the input held from the override commits");
    pumpInput(0.5, ^BOOL { return overrideSights.count >= ordered.count; });
    NSMutableArray<NSNumber *> *expectedSights = [NSMutableArray array];
    for (NSEvent *event in ordered) [expectedSights addObject:@(event.type)];
    check([overrideSights isEqual:expectedSights],
        [NSString stringWithFormat:@"held input comes back to the override once each and in order: %@", overrideSights]);
    overrideSights = nil;
    free(seen);
    free(seenWhenHeld);
    // Injected input keeps its order behind input that waits, whichever way it is delivered.
    [main.window makeFirstResponder:counter];
    surfaceLayoutBegin(main.window, 77007, ^(int allowed) {});
    inputOrder = [NSMutableArray array];
    sp_input_result heldPressResult = SP_INPUT_UNRECEIVED;
    sp_input_pointer_then(main.window, SP_INPUT_POINTER_MAIN, pressInContent.x, pressY, 1, 0, 0, 0, 1, 5, pressDelivered, &heldPressResult);
    check(sp_input_key(main.window, "a", "a", 0, true) == SP_INPUT_DELIVERED, @"an injected key behind an injected press is taken");
    sp_input_key(main.window, "a", "a", 0, false);
    pumpInput(0.1, ^BOOL { return NO; });
    check(inputOrder.count == 0, [NSString stringWithFormat:@"injected input behind a press that waits reaches no view: %@", inputOrder]);
    check(surfaceLayoutCommit(main.window, 77007), @"the layout of the injected press and key commits");
    pumpInput(2, ^BOOL { return inputOrder.count >= 2 && heldPressResult != SP_INPUT_UNRECEIVED; });
    check([inputOrder isEqual:(@[ @"press", @"key" ])],
        [NSString stringWithFormat:@"an injected press reaches the view before the injected key behind it: %@", inputOrder]);
    check(heldPressResult == SP_INPUT_DELIVERED, @"the injected press behind the commit reports its delivery");
    sp_input_pointer(main.window, pressInContent.x, pressY, 3, 0, 0, 0);
    [main.window makeFirstResponder:counter];
    surfaceLayoutBegin(main.window, 77008, ^(int allowed) {});
    inputOrder = [NSMutableArray array];
    [NSApp postEvent:heldDown atStart:NO];
    pumpInput(0.1, ^BOOL { return NO; });
    sp_input_key(main.window, "a", "a", 0, true);
    sp_input_key(main.window, "a", "a", 0, false);
    check(inputOrder.count == 0, [NSString stringWithFormat:@"an injected key behind a person's press that waits reaches no view: %@", inputOrder]);
    check(surfaceLayoutCommit(main.window, 77008), @"the layout of the person's press and the injected key commits");
    // A key sent right after the commit, before the press comes back from the queue, stays behind it too.
    sp_input_key(main.window, "b", "b", 0, true);
    sp_input_key(main.window, "b", "b", 0, false);
    pumpInput(2, ^BOOL { return inputOrder.count >= 3; });
    check([inputOrder isEqual:(@[ @"press", @"key", @"key" ])],
        [NSString stringWithFormat:@"a person's press reaches the view before the injected keys behind it: %@", inputOrder]);
    [NSApp postEvent:heldUp atStart:NO];
    pumpInput(0.2, ^BOOL { return NO; });
    inputOrder = nil;
    [counter removeFromSuperview];

    // A release that waits for a layout longer than the wait for its receipt does not start that wait.
    WKWebView *regionPage = [[[WKWebView alloc] initWithFrame:NSZeroRect] autorelease];
    check(SPPlaceSurfaceView(moved, regionPage), @"the page of the region that a held release is under is placed");
    webviewInputRegister(regionPage);
    load(regionPage, @"<!doctype html><body style='margin:0'></body>");
    void *heldRegion = sp_region_create(moved, "held", heldRegionEvent, NULL);
    sp_region_place(heldRegion, 0, 0, 0, 0, true);
    [NSRunLoop.mainRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
    __block BOOL originDuringHold = NO;
    surfaceLayoutBegin(main.window, 77005, ^(int allowed) {});
    NSString *heldRecords = capturedRecords(^{
        [NSApp postEvent:heldDown atStart:NO];
        pumpInput(0.1, ^BOOL { return NO; });
        originDuringHold = sp_input_press_origin_point(main.window, 0, NULL, NULL, NULL);
        [NSApp postEvent:heldUp atStart:NO];
        pumpInput(1.4, ^BOOL { return NO; });
    });
    check(!originDuringHold, @"the press origin of a press that waits is not recorded while it waits");
    check([heldRecords rangeOfString:@"receipt of pointerup"].location == NSNotFound
        && [heldRecords rangeOfString:@"paired pointer release"].location == NSNotFound,
        [NSString stringWithFormat:@"a release that waits past the receipt wait reports no lost release: %@", heldRecords]);
    check(surfaceLayoutCommit(main.window, 77005), @"the layout of the held press over a region commits");
    pumpInput(0.3, ^BOOL { return NO; });
    sp_region_close(heldRegion);
    uint64_t heldToken = 0;
    if (sp_input_press_origin_point(main.window, 0, NULL, NULL, &heldToken)) sp_input_press_origin_clear(main.window, 0, heldToken);
    sp_surface_close(otherSurface);
    // A view surface whose web view does not cover the point: the point under the overlay is not a native hit.
    WKWebView *view = [[[WKWebView alloc] initWithFrame:NSZeroRect] autorelease];
    NSView *viewSurface = (NSView *)sp_surface_create(sp_window_set_main_webview(main.window, main));
    check(SPPlaceSurfaceView(viewSurface, view), @"a view webview is placed in its surface");
    webviewSetFrame(viewSurface, 0, 0, 200, 150);
    webviewSetSurfaceHidden(viewSurface, false);
    view.frame = NSMakeRect(0, 0, 100, 100);
    addNativeView(viewSurface);
    webviewSetSurfaceOverlays(viewSurface, overlay, 1);
    check([viewSurface hitTest:superviewPoint(viewSurface, NSMakePoint(150, 100))] == nil,
        @"a point under the visible overlay of a view that its web view does not cover is not a native hit");
    // A hidden view web view under a visible overlay: the point is not a native hit.
    WKWebView *hiddenView = [[[WKWebView alloc] initWithFrame:NSZeroRect] autorelease];
    NSView *hiddenSurface = (NSView *)sp_surface_create(sp_window_set_main_webview(main.window, main));
    check(SPPlaceSurfaceView(hiddenSurface, hiddenView), @"a view webview that is hidden later is placed in its surface");
    webviewSetFrame(hiddenSurface, 0, 0, 200, 150);
    webviewSetSurfaceHidden(hiddenSurface, false);
    addNativeView(hiddenSurface);
    hiddenView.hidden = YES;
    webviewSetSurfaceOverlays(hiddenSurface, overlay, 1);
    check([hiddenSurface hitTest:superviewPoint(hiddenSurface, NSMakePoint(100, 80))] == nil,
        @"a point under the visible overlay of a hidden view web view is not a native hit");
    [plain removeFromSuperview];
    [moved removeFromSuperview];
    sp_surface_unplace_view(view);
    sp_surface_close(viewSurface);
    sp_surface_unplace_view(hiddenView);
    sp_surface_close(hiddenSurface);
}

int main(void) { @autoreleasepool {
    [SPOverridingApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    SPScaledWindow *window = [[SPScaledWindow alloc] initWithContentRect:NSMakeRect(100, 100, 600, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    testWindow = window;
    SPSetScaledWindowResolution(window, 1);
    WKWebView *main = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 600, 400)] autorelease];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 600, 400)] autorelease];
    [window.contentView addSubview:main];
    load(main, @"<!doctype html><body style='margin:0;background:#fff'></body>");
    WKWebView *page = [[[WKWebView alloc] initWithFrame:NSZeroRect] autorelease];
    [window orderBack:nil];
    // The window is behind other windows so that it does not take focus, and other windows can cover it. Records the
    // start state to interpret a failure.
    fprintf(stdout, "INFO: window occlusion visible at start: %d\n",
        (window.occlusionState & NSWindowOcclusionStateVisible) != 0);
    void *surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    check(surface != NULL, @"the main webview creates the surface");
    check(SPPlaceSurfaceView(surface, page), @"the view webview is placed in the surface");
    check(main.superview == page.superview.superview.superview,
        @"the placed view webview uses the main webview's canonical composition");
    check(page.underPageBackgroundColor.alphaComponent == 0
        && ![[page valueForKey:@"drawsBackground"] boolValue],
        @"a placed view webview does not paint an opaque backing over native regions");
    // The app event monitor (wheel unit conversion) is installed when a webview is registered for input.
    webviewInputRegister(page);
    load(page, @"<!doctype html><html style='height:100%'><body style='margin:0;height:100%;background:#0d1a14'>"
        "<div style='height:5000px'></div>"
        "<script>addEventListener('pointerup', e => window.pressed = {trusted: e.isTrusted, x: e.clientX, y: e.clientY}, true)</script>"
        "</body></html>");

    // At 2x, a half-point height lies on a device pixel boundary. At 1x, it is fitted to the inner device pixel.
    SPSetScaledWindowResolution(window, 2);
    webviewSetFrame(surface, 40, 30, 300, 200.5);
    webviewSetSurfaceHidden(surface, false);
    verify(window, page, 2, 200.5, @"at 2x");
    // The document region is a subview of the surface. Its size without the margins is 300-10-30 × 200.5-20-40. The
    // document store directory is removed when the check ends.
    NSString *store = temporaryFolder(@"soksak-geometry-store-");
    WKWebView *region = (WKWebView *)sp_document_create(surface, store.fileSystemRepresentation, NULL, NULL, NULL, NULL, ignoreState, NULL);
    check(region != NULL, @"a document region is created in the surface");
    sp_document_place(region, 10, 20, 30, 40, true);
    verifyRegion(region, 2, 260, 140.5, @"at 2x");
    // The region ends at the whole points of its page (window y 50 + 140), so the half point above its bottom inset
    // (190.5) shows the view page and not the backing of the region web view.
    check(webViewAtTopPoint(window, 180, 189.75) == region && webViewAtTopPoint(window, 180, 190.25) == page,
        @"the half point that the whole points of the region leave above its bottom inset shows the view page");
    // A view web view is the root of its surface: the host places it with no insets, and it keeps the fractional frame of
    // the surface, so the last device pixel row of the surface belongs to the view and not to the page below.
    void *rootSurface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    webviewSetFrame(rootSurface, 360, 30, 200, 100.5);
    webviewSetSurfaceHidden(rootSurface, false);
    NSString *rootFolder = temporaryFolder(@"soksak-geometry-view-");
    WKWebView *root = (WKWebView *)sp_document_create(rootSurface, store.fileSystemRepresentation,
        rootFolder.fileSystemRepresentation, "probe", NULL, "", ignoreState, NULL);
    check(root != NULL, @"a view web view is created in its surface");
    sp_document_place(root, 0, 0, 0, 0, true);
    check(NSHeight(root.frame) == 100.5 && webViewAtTopPoint(window, 460, 30 + 100.5 - 0.25) == root,
        [NSString stringWithFormat:@"the view web view keeps the fractional height of its surface and its last device pixel row (height %g)",
            NSHeight(root.frame)]);
    sp_document_close(root);
    sp_surface_close(rootSurface);
    double overlay[5] = {50, 50, 50, 50, 1};
    webviewSetSurfaceOverlays(surface, overlay, 1);
    check(webViewAtTopPoint(window, 190, 130) == page,
        @"a declared DOM overlay receives input above a native document region");
    check(webViewAtTopPoint(window, 60, 60) == region,
        @"the native document receives input outside the declared DOM overlay");
    // Cuts the native plane out of the overlay rectangle so that the DOM of the logically upper overlay is visible.
    NSView *host = page;
    while (host && ![NSStringFromClass(host.class) isEqualToString:@"SPSurfaceHost"]) host = host.superview;
    NSView *plane = nil;
    for (NSView *child in host.subviews) if ([NSStringFromClass(child.class) isEqualToString:@"SPSurfaceNativePlane"]) plane = child;
    CAShapeLayer *mask = [plane.layer.mask isKindOfClass:CAShapeLayer.class] ? (CAShapeLayer *)plane.layer.mask : nil;
    CGPoint (^layerPoint)(CGFloat, CGFloat) = ^CGPoint(CGFloat x, CGFloat y) {
        return NSPointToCGPoint([plane convertPointToLayer:[plane convertPoint:NSMakePoint(x, y) fromView:host]]);
    };
    check(mask && !CGPathContainsPoint(mask.path, NULL, layerPoint(150, 100), true)
        && CGPathContainsPoint(mask.path, NULL, layerPoint(20, 20), true),
        [NSString stringWithFormat:@"native pixels are cut out under a visible declared DOM overlay (host %@, plane %@, mask %@)", host, plane, plane.layer.mask]);
    webviewSetSurfaceOverlays(surface, NULL, 0);
    check(plane.layer.mask == nil, @"native pixels are shown again when no overlay is visible");

    SPSetScaledWindowResolution(window, 1);
    webviewSetFrame(surface, 40, 30, 300, 200.5);
    verify(window, page, 1, 200.5, @"after changing to 1x");
    verifyRegion(region, 1, 260, 140.5, @"after changing to 1x");

    SPSetScaledWindowResolution(window, 2);
    webviewSetFrame(surface, 40, 30, 300, 200.5);
    verify(window, page, 2, 200.5, @"after changing back to 2x");
    verifyRegion(region, 2, 260, 140.5, @"after changing back to 2x");

    // A document region at page zoom 1.5 on the 2x surface receives the same 120-point scroll as a web view at the same
    // page zoom and device scale that has no surface. WebKit defines the distance of the plain view, so the region must
    // move by that distance too.
    check(sp_document_zoom(region, 1.5), @"a document region takes page zoom 1.5");
    evaluate(region, @"document.body.style.margin = '0'; document.body.innerHTML = '<div style=\"height:5000px\"></div>'; null");
    until(^BOOL { return [evaluate(region, @"document.scrollingElement.scrollHeight") doubleValue] >= 5000; });
    double zoomedRegion = scrollViewCenter(window, region);
    WKWebView *plain = [[[WKWebView alloc] initWithFrame:NSMakeRect(380, 220, 200, 120)] autorelease];
    [window.contentView addSubview:plain positioned:NSWindowAbove relativeTo:main];
    plain.pageZoom = 1.5;
    [plain _setOverrideDeviceScaleFactor:2];
    load(plain, @"<!doctype html><body style='margin:0'><div style='height:5000px'></div></body>");
    double plainZoomed = scrollViewCenter(window, plain);
    check(plainZoomed > 0 && zoomedRegion == plainZoomed,
        [NSString stringWithFormat:@"a document region at page zoom 1.5 on a 2x surface scrolls by the CSS distance of a web view at the same zoom and scale without a surface (region %g, plain view %g)",
            zoomedRegion, plainZoomed]);
    [plain removeFromSuperview];
    sp_document_close(region);

    checkScrollBarSide(window, page, @"rtl");
    checkScrollBarSide(window, page, @"ltr");

    // The file drop view of the window: the only native drag target that accepts file URLs only; hit testing passes
    // to the view below.
    check(sp_window_file_drop(main, droppedFiles, NULL, NULL), @"file drop: the window composition accepts a drop handler");
    NSView *composition = main.superview;
    NSView *drop = composition.subviews.lastObject;
    check([drop.registeredDraggedTypes isEqualToArray:@[NSPasteboardTypeFileURL]],
        [NSString stringWithFormat:@"file drop: the drop view registers only file URLs (got %@)", drop.registeredDraggedTypes]);
    NSPoint inside = [composition.superview convertPoint:NSMakePoint(20, 20) fromView:composition];
    NSView *hit = [composition hitTest:inside];
    check(hit != nil && hit != drop, [NSString stringWithFormat:@"file drop: hit testing passes the drop view (got %@)", hit]);
    NSView *later = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 10, 10)] autorelease];
    [composition addSubview:later];
    check(composition.subviews.lastObject == drop, @"file drop: the drop view stays above a view added later");
    [later removeFromSuperview];
    checkHitTesting(main);
    check(sp_window_file_drop(main, droppedFiles, NULL, NULL) &&
        [composition.subviews filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(id view, NSDictionary *bindings) {
            return [view registeredDraggedTypes].count > 0 && view != main;
        }]].count == 1, @"file drop: registering again keeps one drop view");

    // The file manager places a file reference URL (file:///.file/id=…) in the drag pasteboard. The page receives a
    // path URL.
    NSString *directory = temporaryFolder(@"soksak-geometry-drop-");
    NSString *path = [directory stringByAppendingPathComponent:@"drop me.txt"];
    [@"text" writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    NSURL *reference = [NSURL fileURLWithPath:path].fileReferenceURL;
    NSPasteboard *board = [NSPasteboard pasteboardWithUniqueName];
    [board clearContents];
    [board writeObjects:@[reference]];
    TestDraggingInfo *info = [[[TestDraggingInfo alloc] init] autorelease];
    info.draggingPasteboard = board;
    info.draggingLocation = [drop convertPoint:NSMakePoint(30, 40) toView:nil];
    NSMutableArray<NSString *> *drops = [NSMutableArray array];
    sp_window_file_drop(main, droppedFiles, NULL, drops);
    BOOL performed = [(id)drop performDragOperation:(id<NSDraggingInfo>)info];
    NSDictionary *dropped = drops.count == 1 ? [NSJSONSerialization JSONObjectWithData:[drops[0] dataUsingEncoding:NSUTF8StringEncoding]
        options:0 error:NULL] : nil;
    NSArray *urls = dropped[@"urls"];
    NSURL *sent = urls.count == 1 ? [NSURL URLWithString:urls[0]] : nil;
    NSString *expected = path.stringByResolvingSymlinksInPath;
    check(performed && sent.isFileURL && !sent.isFileReferenceURL && [sent.path.stringByResolvingSymlinksInPath isEqualToString:expected] && [dropped[@"x"] doubleValue] == 30 && [dropped[@"y"] doubleValue] == 40,
        [NSString stringWithFormat:@"file drop: a file reference URL %@ is sent as a path URL of %@ at 30,40 (got %@)",
            reference.absoluteString, expected, drops]);
    [board releaseGlobally];

    [window close];
    [window release];
    return failures ? 1 : 0;
}}
