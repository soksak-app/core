// The container of the surface hosts lives in any NSView: sp_surface_create makes it in the view that it is given, and no
// main web view is needed for the placement, the backing scale or the pointer of the web views in it.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "private/webkit.h"
#import "webview_geometry.h"
#import "window_facts.h"

static int failures;

static void check(BOOL ok, NSString *message) {
    fprintf(ok ? stdout : stderr, "%s: %s\n", ok ? "PASS" : "FAIL", message.UTF8String);
    if (!ok) failures++;
}

// A window whose backing scale the check chooses.
@interface SPScaledWindow : NSWindow
@property(nonatomic, assign) CGFloat chosenScale;
@end
@implementation SPScaledWindow
- (CGFloat)backingScaleFactor { return self.chosenScale; }
@end

// A web view that records the device scale that it receives.
@interface SPScaleRecordingView : WKWebView
@property(nonatomic, assign) double recordedScale;
@end
@implementation SPScaleRecordingView
- (void)_setOverrideDeviceScaleFactor:(double)scale {
    self.recordedScale = scale;
    [super _setOverrideDeviceScaleFactor:scale];
}
@end

// The owner of a tracking area. It counts the pointer moves that it receives.
@interface SPPointerOwner : NSObject
@property(nonatomic, assign) int moves;
@property(nonatomic, assign) NSPoint location;
@end
@implementation SPPointerOwner
- (void)mouseMoved:(NSEvent *)event {
    self.moves++;
    self.location = event.locationInWindow;
}
@end

static NSDictionary *parsed(char *json) {
    if (!json) return nil;
    NSDictionary *value = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json length:strlen(json)] options:0 error:nil];
    sp_facts_free(json);
    return value;
}

static SPScaledWindow *makeWindow(NSRect frame, CGFloat scale) {
    SPScaledWindow *window = [[SPScaledWindow alloc] initWithContentRect:frame styleMask:NSWindowStyleMaskBorderless
        backing:NSBackingStoreBuffered defer:NO];
    window.chosenScale = scale;
    window.releasedWhenClosed = NO;
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    return window;
}

// The window is not put on screen, and the view that holds the container has an origin of its own in the content view.
static void checkPlacement(void) {
    SPScaledWindow *window = makeWindow(NSMakeRect(0, 0, 400, 300), 2);
    NSView *holder = [[[NSView alloc] initWithFrame:NSMakeRect(30, 20, 360, 270)] autorelease];
    [window.contentView addSubview:holder];
    void *surface = sp_surface_create(holder);
    check(surface != NULL, @"a surface host is created in an NSView that is not a web view");
    if (surface == NULL) { [window release]; return; }
    NSView *host = (NSView *)surface;
    NSView *container = host.superview;
    check(container.superview == holder && NSEqualRects(container.frame, holder.bounds),
        [NSString stringWithFormat:@"the container fills the view that holds it (superview %@, frame %@)",
            container.superview, NSStringFromRect(container.frame)]);
    void *second = sp_surface_create(holder);
    check(((NSView *)second).superview == container && holder.subviews.count == 1,
        @"a second surface host uses the container that the view already holds");
    webviewSetFrame(surface, 50, 60, 200, 100);
    webviewSetSurfaceHidden(surface, false);
    double rect[4] = {0};
    webviewGetFrame(surface, rect);
    check(rect[0] == 50 && rect[1] == 60 && rect[2] == 200 && rect[3] == 100,
        [NSString stringWithFormat:@"a surface host is placed from window content coordinates (%g, %g, %g, %g)",
            rect[0], rect[1], rect[2], rect[3]]);
    [holder setFrameSize:NSMakeSize(300, 200)];
    check(NSEqualRects(container.frame, holder.bounds), @"the container follows the size of the view that holds it");
    check(sp_surface_create(window) == NULL, @"a window is rejected: it is not the view that holds the container");
    check(sp_surface_create(NULL) == NULL, @"a missing view is rejected");
    NSView *outside = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 10, 10)] autorelease];
    check(sp_surface_create(outside) == NULL && outside.subviews.count == 0,
        @"a view outside a window is rejected and gets no container");
    NSDictionary *facts = parsed(sp_window_facts(window, holder));
    check([facts[@"nativeSurfaces"] count] == 2, [NSString stringWithFormat:@"the window facts of a window without a main web view report its surface hosts (%@)", facts[@"nativeSurfaces"]]);
    check([facts[@"pageProcess"] intValue] == 0, @"a window without a main web view has no page process");
    check(sp_window_facts(window, NULL) == NULL, @"the window facts refuse a missing view");
    check(sp_window_facts(window, outside) == NULL, @"the window facts refuse a view of no window");
    check(sp_window_hit(window, NULL, 10, 10) == NULL, @"the hit test refuses a missing view");
    check(sp_window_hit(window, outside, 10, 10) == NULL, @"the hit test refuses a view of no window");
    sp_surface_close(second);
    sp_surface_close(surface);
    [window close];
    [window release];
}

// The composition wraps the main web view in the content view, so a web view that is the content view cannot be registered.
static void checkContentViewIsRefused(void) {
    SPScaledWindow *window = makeWindow(NSMakeRect(0, 0, 400, 300), 2);
    WKWebView *main = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)] autorelease];
    window.contentView = main;
    check(sp_window_set_main_webview(window, main) == NULL && sp_window_main_webview(window) == NULL && window.contentView == main,
        @"a main web view that is the content view is refused and stays in its window");
    [window close];
    [window release];
}

// The container applies the backing scale of its window to the web views of its surface hosts.
static void checkScale(void) {
    SPScaledWindow *first = makeWindow(NSMakeRect(0, 0, 400, 300), 1);
    SPScaledWindow *second = makeWindow(NSMakeRect(0, 0, 400, 300), 3);
    NSView *holder = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)] autorelease];
    [first.contentView addSubview:holder];
    void *surface = sp_surface_create(holder);
    check(surface != NULL, @"the scale fixture creates its surface host");
    if (surface == NULL) { [first release]; [second release]; return; }
    SPScaleRecordingView *web = [[[SPScaleRecordingView alloc] initWithFrame:NSZeroRect] autorelease];
    check(sp_surface_place_view(surface, web), @"the scale fixture places its web view");
    web.pageZoom = 2;
    [second.contentView addSubview:holder];
    check(web.recordedScale == 3 && web.pageZoom == 1,
        [NSString stringWithFormat:@"the web view of a surface host takes the backing scale of the window of the container (scale %g, zoom %g)",
            web.recordedScale, web.pageZoom]);
    sp_surface_unplace_view(web);
    [web removeFromSuperview];
    sp_surface_close(surface);
    [first close];
    [second close];
    [first release];
    [second release];
}

// AppKit sends cursorUpdate: to the view under the pointer. The window is placed around the pointer, so the check moves no pointer.
static void checkCursorUpdate(void) {
    NSPoint pointer = NSEvent.mouseLocation;
    SPScaledWindow *window = makeWindow(NSMakeRect(pointer.x - 200, pointer.y - 150, 400, 300), 2);
    NSView *holder = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)] autorelease];
    [window.contentView addSubview:holder];
    void *surface = sp_surface_create(holder);
    check(surface != NULL, @"the pointer fixture creates its surface host");
    if (surface == NULL) { [window release]; return; }
    webviewSetFrame(surface, 0, 0, 400, 300);
    webviewSetSurfaceHidden(surface, false);
    WKWebView *web = [[[WKWebView alloc] initWithFrame:NSZeroRect] autorelease];
    check(sp_surface_place_view(surface, web), @"the pointer fixture places its web view");
    for (NSTrackingArea *area in [[web.trackingAreas copy] autorelease]) [web removeTrackingArea:area];
    NSDictionary *hit = parsed(sp_window_hit(window, holder, 200, 150));
    check([hit[@"view"] unsignedLongLongValue] == (uintptr_t)web && ![hit[@"main"] boolValue],
        [NSString stringWithFormat:@"the hit test of a window without a main web view finds the web view of a surface host (%@)", hit]);
    SPPointerOwner *owner = [[SPPointerOwner new] autorelease];
    NSTrackingArea *area = [[[NSTrackingArea alloc] initWithRect:NSZeroRect
        options:NSTrackingMouseMoved | NSTrackingActiveAlways | NSTrackingInVisibleRect owner:owner userInfo:nil] autorelease];
    [web addTrackingArea:area];
    NSPoint location = window.mouseLocationOutsideOfEventStream;
    NSEvent *update = [NSEvent enterExitEventWithType:NSEventTypeCursorUpdate location:location modifierFlags:0
        timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil eventNumber:0
        trackingNumber:0 userData:NULL];
    if (NSEvent.pressedMouseButtons != 0) {
        check(NO, @"the pointer check needs no pressed mouse button");
    } else {
        [web cursorUpdate:update];
        check(owner.moves == 1 && NSEqualPoints(owner.location, location),
            [NSString stringWithFormat:@"a cursorUpdate: of a web view of a surface host reaches the tracking area owner of that web view as a pointer move at the current position (%d moves at %@, pointer %@)",
                owner.moves, NSStringFromPoint(owner.location), NSStringFromPoint(location)]);
    }
    sp_surface_unplace_view(web);
    [web removeFromSuperview];
    sp_surface_close(surface);
    [window close];
    [window release];
}

// A window without a main web view has its native view as the view of its surface hosts: one view for the life of the window, and
// a frame in the content coordinates of the window lands there.
static void checkNativeView(void) {
    SPScaledWindow *window = makeWindow(NSMakeRect(0, 0, 400, 300), 2);
    check(sp_window_composition(window) == NULL, @"a window without a native view has no view for its surface hosts");
    NSView *native = (NSView *)sp_window_native_view(window);
    check(native != nil && sp_window_native_view(window) == native, @"a window has one native view");
    check(native.window == nil, @"the framework puts the native view in the window");
    [window.contentView addSubview:native];
    native.frame = window.contentView.bounds;
    check(sp_window_composition(window) == native, @"the native view holds the surface hosts of the window");
    void *surface = sp_surface_create(sp_window_composition(window));
    check(surface != NULL, @"a surface host is created in the native view");
    webviewSetFrame(surface, 10, 20, 100, 50);
    NSRect placed = [((NSView *)surface).superview convertRect:((NSView *)surface).frame toView:nil];
    check(NSEqualRects(placed, NSMakeRect(10, 230, 100, 50)),
        [NSString stringWithFormat:@"the frame is in the content coordinates of the window (%@)", NSStringFromRect(placed)]);
    sp_surface_close(surface);
    [native removeFromSuperview];
    [window close];
    [window release];
}

// A window without a main web view draws its workbench in the views outside the view that holds its surface hosts: a hit there is the
// workbench, and a hit on a surface host or on the view that holds them is not (docs/spec/native-surfaces.md#surface-host-container).
static void checkWorkbenchHit(void) {
    SPScaledWindow *window = makeWindow(NSMakeRect(0, 0, 400, 300), 2);
    NSView *native = (NSView *)sp_window_native_view(window);
    [window.contentView addSubview:native];
    native.frame = window.contentView.bounds;
    // The view of the workbench stands over the native view and leaves the right half to it, as a hole over a surface does.
    NSView *workbench = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 200, 300)] autorelease];
    [window.contentView addSubview:workbench positioned:NSWindowAbove relativeTo:native];
    void *surface = sp_surface_create(native);
    check(surface != NULL, @"the workbench hit fixture creates its surface host");
    if (surface == NULL) { [native removeFromSuperview]; [window close]; [window release]; return; }
    webviewSetFrame(surface, 300, 0, 100, 300);
    webviewSetSurfaceHidden(surface, false);
    WKWebView *web = [[[WKWebView alloc] initWithFrame:NSZeroRect] autorelease];
    check(sp_surface_place_view(surface, web), @"the workbench hit fixture places its web view");
    NSDictionary *drawn = parsed(sp_window_hit(window, native, 100, 150));
    check([drawn[@"main"] boolValue] && [drawn[@"view"] unsignedLongLongValue] == 0,
        [NSString stringWithFormat:@"a hit on the workbench of a window without a main web view is the workbench (%@)", drawn]);
    NSDictionary *document = parsed(sp_window_hit(window, native, 350, 150));
    check(![document[@"main"] boolValue] && [document[@"view"] unsignedLongLongValue] == (uintptr_t)web,
        [NSString stringWithFormat:@"a hit on the web view of a surface host is not the workbench (%@)", document]);
    NSDictionary *hole = parsed(sp_window_hit(window, native, 250, 150));
    check(![hole[@"main"] boolValue],
        [NSString stringWithFormat:@"a hit on the view that holds the surface hosts is not the workbench (%@)", hole]);
    sp_surface_unplace_view(web);
    [web removeFromSuperview];
    sp_surface_close(surface);
    [workbench removeFromSuperview];
    [native removeFromSuperview];
    [window close];
    [window release];
}

// contract: surface-host.dialog-host-stays-on-top
// The dialog host stays above every other surface host of its container: a surface host created while it is in the container is
// inserted below it, and the hosts created before it stay below it (docs/spec/native-surfaces.md#surface-host-container).
static void checkDialogHostOrder(void) {
    SPScaledWindow *window = makeWindow(NSMakeRect(0, 0, 400, 300), 2);
    NSView *holder = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)] autorelease];
    [window.contentView addSubview:holder];
    NSView *before = (NSView *)sp_surface_create(holder);
    NSView *dialog = (NSView *)sp_surface_create(holder);
    sp_surface_mark_dialog(dialog);
    NSView *after = (NSView *)sp_surface_create(holder);
    NSView *later = (NSView *)sp_surface_create(holder);
    NSArray<NSView *> *order = dialog.superview.subviews;
    check([order isEqualToArray:@[before, after, later, dialog]],
        [NSString stringWithFormat:@"the surface hosts created after the dialog host stand below it (order %@)", order]);
    sp_surface_close(dialog);
    NSView *free = (NSView *)sp_surface_create(holder);
    check(free.superview.subviews.lastObject == free, @"without a dialog host a new surface host stands above the others");
    sp_surface_close(before);
    sp_surface_close(after);
    sp_surface_close(later);
    sp_surface_close(free);
    [window close];
    [window release];
}

// contract: surface-host.settings-container-over-modal
// The settings surface host stands in the settings container directly above the modal web view of the settings window, which
// clips it to the pane; a point inside the clip is the host, a point of the modal outside it is the modal, and a view added above
// the container later leaves the container directly above the modal at the next seat (docs/spec/native-modals.md#settings-surface).
static void checkSettingsContainer(void) {
    SPScaledWindow *window = makeWindow(NSMakeRect(0, 0, 400, 300), 2);
    NSView *content = window.contentView;
    NSView *holder = [[[NSView alloc] initWithFrame:content.bounds] autorelease];
    [content addSubview:holder];
    NSView *modal = [[[NSView alloc] initWithFrame:content.bounds] autorelease];
    [content addSubview:modal positioned:NSWindowAbove relativeTo:holder];
    void *surface = sp_surface_create(holder);
    NSView *host = (NSView *)surface;
    WKWebView *web = [[[WKWebView alloc] initWithFrame:NSZeroRect] autorelease];
    check(sp_surface_place_view(surface, web), @"the settings container fixture places its web view");
    check(sp_surface_seat_over_modal(surface, modal, 50, 40, 200, 100), @"the settings surface host is seated over the modal");
    NSView *over = host.superview;
    check(over.superview == content && [content.subviews indexOfObjectIdenticalTo:over] == [content.subviews indexOfObjectIdenticalTo:modal] + 1,
        [NSString stringWithFormat:@"the settings container stands directly above the modal (subviews %@)", content.subviews]);
    check(NSEqualRects(over.frame, NSMakeRect(50, 300 - 40 - 100, 200, 100)),
        [NSString stringWithFormat:@"the settings container has the frame of the clip (%@)", NSStringFromRect(over.frame)]);
    webviewSetFrame(surface, 50, 20, 200, 300);
    webviewSetSurfaceHidden(surface, false);
    double rect[4] = {0};
    webviewGetFrame(surface, rect);
    check(rect[0] == 50 && rect[1] == 20 && rect[2] == 200 && rect[3] == 300,
        [NSString stringWithFormat:@"the seated host keeps its frame in window content coordinates (%g, %g, %g, %g)", rect[0], rect[1], rect[2], rect[3]]);
    NSView *(^hit)(double, double) = ^NSView *(double x, double y) {
        NSView *found = [content hitTest:[content convertPoint:NSMakePoint(x, 300 - y) toView:content.superview]];
        while (found && found != modal && ![found isKindOfClass:WKWebView.class]) found = found.superview;
        return found;
    };
    check(hit(100, 80) == web, [NSString stringWithFormat:@"a point inside the clip is the settings surface (%@)", hit(100, 80)]);
    check(hit(100, 30) == modal, [NSString stringWithFormat:@"a point of the host outside the clip is the modal (%@)", hit(100, 30)]);
    check(hit(300, 80) == modal, [NSString stringWithFormat:@"a point outside the host is the modal (%@)", hit(300, 80)]);
    NSView *later = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 10, 10)] autorelease];
    [content addSubview:later];
    check(sp_surface_seat_over_modal(surface, modal, 60, 40, 200, 100) && host.superview == over && host.window == window,
        @"a second seat keeps the host in the settings container");
    check([content.subviews isEqualToArray:@[holder, modal, over, later]],
        [NSString stringWithFormat:@"the settings container stands again directly above the modal (subviews %@)", content.subviews]);
    NSView *outside = [[[NSView alloc] initWithFrame:NSZeroRect] autorelease];
    check(!sp_surface_seat_over_modal(surface, outside, 0, 0, 10, 10), @"a modal outside the content view is refused");
    sp_surface_unplace_view(web);
    [web removeFromSuperview];
    sp_surface_close(surface);
    [window close];
    [window release];
}

// A window without a main page shows the surfaces below its settings window in the holes that it draws, so the settings surface
// host fills itself with the background of its window, which the workbench sets to the color of the pane, and fills itself again when
// the window changes its background; a host that stops filling shows what is below it again (docs/spec/native-surfaces.md#settings-seat).
static void checkWindowBackgroundFill(void) {
    SPScaledWindow *window = makeWindow(NSMakeRect(0, 0, 400, 300), 2);
    NSView *content = window.contentView;
    window.backgroundColor = [NSColor colorWithSRGBRed:1 green:0 blue:0 alpha:1];
    void *surface = sp_surface_create(content);
    NSView *host = (NSView *)surface;
    BOOL (^filledWith)(NSColor *) = ^BOOL(NSColor *color) {
        return host.layer.backgroundColor && CGColorEqualToColor(host.layer.backgroundColor, color.CGColor);
    };
    sp_surface_fill_window_background(surface, true);
    check(filledWith(window.backgroundColor), @"the host fills itself with the background of its window");
    window.backgroundColor = [NSColor colorWithSRGBRed:0 green:0 blue:1 alpha:1];
    sp_window_fill_surface_backgrounds((__bridge void *)window);
    check(filledWith(window.backgroundColor), @"the host fills itself again with the changed background of its window");
    sp_surface_fill_window_background(surface, false);
    check(host.layer.backgroundColor == NULL, @"a host that stops filling has no background");
    window.backgroundColor = NSColor.greenColor;
    sp_window_fill_surface_backgrounds((__bridge void *)window);
    check(host.layer.backgroundColor == NULL, @"a host that does not fill keeps no background when the window changes its background");
    sp_surface_close(surface);
    [window close];
    [window release];
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    checkPlacement();
    checkContentViewIsRefused();
    checkScale();
    checkCursorUpdate();
    checkNativeView();
    checkWorkbenchHit();
    checkDialogHostOrder();
    checkSettingsContainer();
    checkWindowBackgroundFill();
    return failures == 0 ? 0 : 1;
} }
