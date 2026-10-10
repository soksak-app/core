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
#import "document_view.h"
#import "input_inject.h"
#import "private/coregraphics.h"
#import "private/webkit.h"
#import "webview_input.h"
#import "webview_geometry.h"

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

@interface NSWindow (SPWindowResolution)
- (void)_setWindowResolution:(CGFloat)resolution;
@end

// The check window. The scale changes only to values that the check sets.
@interface SPScaledWindow : NSWindow
@end
@implementation SPScaledWindow
- (void)_adjustWindowResolution {}
@end

static void notifyBackingChange(NSView *view) {
    [view viewDidChangeBackingProperties];
    for (NSView *child in view.subviews) notifyBackingChange(child);
}

static void setScale(SPScaledWindow *window, CGFloat scale) {
    CGFloat old = window.backingScaleFactor;
    [window _setWindowResolution:scale];
    [NSNotificationCenter.defaultCenter postNotificationName:NSWindowDidChangeBackingPropertiesNotification
        object:window userInfo:@{NSBackingPropertyOldScaleFactorKey: @(old)}];
    notifyBackingChange(window.contentView);
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
    // separately and match exactly.
    double cssHeight = floor(height);
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    NSDictionary *state = nil;
    for (;;) {
        state = evaluate(view, @"({ratio: devicePixelRatio, width: visualViewport.width,"
            " height: visualViewport.height, body: document.body?.getBoundingClientRect().height})");
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
static NSDictionary *pressLastPixel(NSWindow *window, WKWebView *surface, CGFloat scale) {
    currentStep = __func__;
    double frame[4] = {0, 0, 0, 0};
    webviewGetFrame(surface, frame);
    double x = frame[0] + frame[2] / 2, y = frame[1] + frame[3] - 0.5 / scale;
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
    check(delivered, [NSString stringWithFormat:@"press on the last device pixel delivered at scale %g "
        "(down %d, up %d; AppKit button mask before %lu, after %lu)", scale, down, up,
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

static void scrollDone(void *context, sp_input_result result, const sp_input_held *held) { *(sp_input_result *)context = result; }

static WKWebView *webViewAtTopPoint(NSWindow *window, double x, double y) {
    NSView *content = window.contentView;
    NSPoint local = NSMakePoint(x, content.bounds.size.height - y);
    NSPoint inWindow = [content convertPoint:local toView:nil];
    NSView *target = [content hitTest:[content convertPoint:inWindow fromView:nil]];
    while (target && ![target isKindOfClass:WKWebView.class]) target = target.superview;
    return (WKWebView *)target;
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

// Waits until the surface finishes scrolling and returns the CSS pixels the document moved. Scrolling has finished
// when two displays report the same value. The per-display values and elapsed time of the last scroll measurement.
// The failure message reports these values.
static NSMutableString *scrollSamples = nil;

static double scrolledBy(WKWebView *surface) {
    currentStep = __func__;
    NSDate *start = [NSDate date];
    [scrollSamples release];
    scrollSamples = [[NSMutableString alloc] init];
    until(^BOOL { return [evaluate(surface, @"document.scrollingElement.scrollTop") doubleValue] > 0; });
    double last = -1, now = [evaluate(surface, @"document.scrollingElement.scrollTop") doubleValue];
    [scrollSamples appendFormat:@"%g@%.0fms", now, -start.timeIntervalSinceNow * 1000];
    while (now != last) {
        last = now;
        __block BOOL shown = NO;
        [surface _doAfterNextPresentationUpdate:^{ shown = YES; }];
        until(^BOOL { return shown; });
        now = [evaluate(surface, @"document.scrollingElement.scrollTop") doubleValue];
        [scrollSamples appendFormat:@" %g@%.0fms", now, -start.timeIntervalSinceNow * 1000];
    }
    return now;
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
        sp_input_pointer_then(window, x, y, 4, 0, 0, 120, 5, scrollDone, &result);
        until(^BOOL { return result != SP_INPUT_REJECTED; });
        check(result == SP_INPUT_DELIVERED, @"a scroll into the surface is delivered");
        return scrolledBy(surface);
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
    return scrolledBy(surface);
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
    NSDictionary *pressed = pressLastPixel(window, surface, scale);
    double expected = frame[3] - 0.5 / scale;
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

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    SPScaledWindow *window = [[SPScaledWindow alloc] initWithContentRect:NSMakeRect(100, 100, 600, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    testWindow = window;
    setScale(window, 1);
    WKWebView *main = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 600, 400)] autorelease];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 600, 400)] autorelease];
    [window.contentView addSubview:main];
    load(main, @"<!doctype html><body style='margin:0;background:#fff'></body>");
    WKWebView *surface = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 10, 10)] autorelease];
    [window.contentView addSubview:surface positioned:NSWindowAbove relativeTo:main];
    [window orderBack:nil];
    // The window is behind other windows so that it does not take focus, and other windows can cover it. Records the
    // start state to interpret a failure.
    fprintf(stdout, "INFO: window occlusion visible at start: %d\n",
        (window.occlusionState & NSWindowOcclusionStateVisible) != 0);
    check(sp_surface_create(main) != NULL,
        @"the main webview creates the composition before a surface webview is attached");
    webviewAttachSurface(surface, main);
    check(main.superview == surface.superview.superview.superview,
        @"the attached surface webview uses the main webview's canonical composition");
    check(surface.underPageBackgroundColor.alphaComponent == 0
        && ![[surface valueForKey:@"drawsBackground"] boolValue],
        @"an attached surface webview does not paint an opaque backing over native regions");
    // The app event monitor (wheel unit conversion) is installed when a webview is registered for input.
    webviewInputRegister(surface);
    load(surface, @"<!doctype html><html style='height:100%'><body style='margin:0;height:100%;background:#0d1a14'>"
        "<div style='height:5000px'></div>"
        "<script>addEventListener('pointerup', e => window.pressed = {trusted: e.isTrusted, y: e.clientY}, true)</script>"
        "</body></html>");

    // At 2x, a half-point height lies on a device pixel boundary. At 1x, it is fitted to the inner device pixel.
    setScale(window, 2);
    webviewSetFrame(surface, 40, 30, 300, 200.5);
    verify(window, surface, 2, 200.5, @"at 2x");
    // The document region is a subview of the surface. Its size without the margins is 300-10-30 × 200.5-20-40. The
    // document store directory is removed when the check ends.
    NSString *store = [NSTemporaryDirectory() stringByAppendingPathComponent:
        [NSString stringWithFormat:@"soksak-geometry-store-%d", getpid()]];
    WKWebView *region = (WKWebView *)sp_document_create(surface, store.fileSystemRepresentation, NULL, NULL, ignoreState, NULL);
    check(region != NULL, @"a document region is created in the surface");
    sp_document_place(region, 10, 20, 30, 40, true);
    verifyRegion(region, 2, 260, 140.5, @"at 2x");
    double overlay[5] = {50, 50, 50, 50, 1};
    webviewSetSurfaceOverlays(surface, overlay, 1);
    check(webViewAtTopPoint(window, 190, 130) == surface,
        @"a declared DOM overlay receives input above a native document region");
    check(webViewAtTopPoint(window, 60, 60) == region,
        @"the native document receives input outside the declared DOM overlay");
    // Cuts the native plane out of the overlay rectangle so that the DOM of the logically upper overlay is visible.
    NSView *host = surface;
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

    setScale(window, 1);
    webviewSetFrame(surface, 40, 30, 300, 200.5);
    verify(window, surface, 1, 200.5, @"after changing to 1x");
    verifyRegion(region, 1, 260, 140.5, @"after changing to 1x");

    setScale(window, 2);
    webviewSetFrame(surface, 40, 30, 300, 200.5);
    verify(window, surface, 2, 200.5, @"after changing back to 2x");
    verifyRegion(region, 2, 260, 140.5, @"after changing back to 2x");
    sp_document_close(region);
    [NSFileManager.defaultManager removeItemAtPath:store error:NULL];

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
    check(sp_window_file_drop(main, droppedFiles, NULL, NULL) &&
        [composition.subviews filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(id view, NSDictionary *bindings) {
            return [view registeredDraggedTypes].count > 0 && view != main;
        }]].count == 1, @"file drop: registering again keeps one drop view");

    // The file manager places a file reference URL (file:///.file/id=…) in the drag pasteboard. The page receives a
    // path URL.
    NSString *directory = [NSTemporaryDirectory() stringByAppendingPathComponent:[NSUUID UUID].UUIDString];
    [NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:NULL];
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
    [NSFileManager.defaultManager removeItemAtPath:directory error:NULL];

    [window close];
    [window release];
    return failures ? 1 : 0;
}}
