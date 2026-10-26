#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#import "application_log.h"
#import "webview_geometry.h"
#import "surface_layout.h"
#import "window_objects.h"
#import "private/webkit.h"


@interface SPSurfaceCoordinates : NSView
@property CGFloat scale;
@property(nonatomic, retain) WKWebView *mainView;
@end

static void normalizeCoordinateBounds(SPSurfaceCoordinates *coordinates) {
    NSSize size = coordinates.frame.size;
    NSRect expected = NSMakeRect(0, 0, size.width, size.height);
    if (!NSEqualRects(coordinates.bounds, expected)) coordinates.bounds = expected;
}

// The DOM hit of a web view for a point of the view `from`. The web view takes the point in its superview coordinates. A hidden web view has no DOM hit.
static NSView *domHit(WKWebView *web, NSView *from, NSPoint point) {
    if (!web || web.hidden) return nil;
    return [web hitTest:[web.superview convertPoint:point fromView:from]];
}

// Native-owned boundary, one per surface. Only this view has the outer surface frame, and it clips and moves
// all native regions and DOM web views together.
@interface SPSurfaceNativePlane : NSView
@end

@implementation SPSurfaceNativePlane
- (BOOL)isFlipped { return YES; }
- (NSView *)hitTest:(NSPoint)point {
    NSView *hit = [super hitTest:point];
    return hit == self ? nil : hit;
}
@end

@interface SPSurfaceHost : NSView
@property(nonatomic, assign) WKWebView *webview;
@property(retain) SPSurfaceNativePlane *nativePlane;
@property(nonatomic, copy) NSArray<NSValue *> *domOverlays;
@end

// A surface places native regions below its view WebView. CSS transparency does not turn off the native opaque
// backing of WebKit, so every WebView above the native plane must use the same transparent backing rule.
static void configureWebViewTransparency(WKWebView *view) {
    view.underPageBackgroundColor = NSColor.clearColor;
    [view setValue:@NO forKey:@"drawsBackground"];
    view.wantsLayer = YES;
    view.layer.opaque = NO;
    view.layer.backgroundColor = NSColor.clearColor.CGColor;
}

static void reconfigureSurfaceWebviews(NSView *root) {
    if ([root isKindOfClass:SPSurfaceHost.class]) {
        SPSurfaceHost *host = (SPSurfaceHost *)root;
        if (host.webview) configureWebViewTransparency(host.webview);
    }
    for (NSView *child in root.subviews) reconfigureSurfaceWebviews(child);
}

// The only native drag target of a window. It receives files dragged from another application and reports them to the host
// with the drop point, and the host sends them to the page. The native view is placed above the DOM, so the page decides how to handle a
// dropped file from the DOM element at that point. It accepts only file URLs and returns no view in the hit test, so pointers and other drags go to the view below.
@interface SPFileDropView : NSView
@property(nonatomic, assign) sp_file_drop_event event;
@property(nonatomic, assign) sp_file_drop_release releaseContext;
@property(nonatomic, assign) void *context;
- (void)receive:(sp_file_drop_event)event release:(sp_file_drop_release)release context:(void *)context;
@end

@implementation SPFileDropView
- (BOOL)isFlipped { return YES; }
// The receiver of the host must stay alive while this view uses it, and the host must release it afterwards. release
// returns the replaced receiver and the receiver that ends together with the view.
- (void)receive:(sp_file_drop_event)event release:(sp_file_drop_release)release context:(void *)context {
    sp_file_drop_release previous = self.releaseContext;
    void *previousContext = self.context;
    self.event = event;
    self.releaseContext = release;
    self.context = context;
    if (previous) previous(previousContext);
}
- (void)dealloc {
    if (_releaseContext) _releaseContext(_context);
    [super dealloc];
}
- (NSView *)hitTest:(NSPoint)point { return nil; }
- (NSArray<NSURL *> *)fileURLs:(id<NSDraggingInfo>)sender {
    return [sender.draggingPasteboard readObjectsForClasses:@[NSURL.class]
        options:@{NSPasteboardURLReadingFileURLsOnlyKey: @YES}] ?: @[];
}
- (NSDragOperation)draggingEntered:(id<NSDraggingInfo>)sender {
    return self.event && [self fileURLs:sender].count > 0 ? NSDragOperationCopy : NSDragOperationNone;
}
- (NSDragOperation)draggingUpdated:(id<NSDraggingInfo>)sender {
    return [self draggingEntered:sender];
}
- (BOOL)performDragOperation:(id<NSDraggingInfo>)sender {
    NSArray<NSURL *> *urls = [self fileURLs:sender];
    if (!self.event || urls.count == 0) {
        sp_log_error("file drop", "the drop was refused: the view has no receiver or the pasteboard holds no file URL");
        return NO;
    }
    NSPoint point = [self convertPoint:sender.draggingLocation fromView:nil];
    NSMutableArray<NSString *> *strings = [NSMutableArray arrayWithCapacity:urls.count];
    // The file manager provides a file reference URL (file:///.file/id=...). The page and the surface use paths, so it is converted to a path URL.
    for (NSURL *url in urls) {
        NSURL *path = url.filePathURL;
        if (!path) {
            sp_log_error("file drop", [NSString stringWithFormat:@"the drop was refused: %@ is not a file path URL", url.absoluteString].UTF8String);
            return NO;
        }
        [strings addObject:path.absoluteString];
    }
    NSData *json = [NSJSONSerialization dataWithJSONObject:@{@"urls": strings, @"x": @(point.x), @"y": @(point.y)}
        options:0 error:NULL];
    if (!json) {
        sp_log_error("file drop", "the drop was refused: the dropped URLs could not be serialized");
        return NO;
    }
    NSString *text = [[[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] autorelease];
    self.event(self.context, text.UTF8String);
    return YES;
}
@end

// Selects the input ownership of one app DOM and the native plane below it.
@interface SPWindowComposition : NSView
@property(nonatomic, retain) WKWebView *mainWebview;
@property(nonatomic, assign) SPSurfaceCoordinates *coordinates;
@property(nonatomic, retain) NSArray<NSValue *> *overlays;
@property(nonatomic, assign) SPFileDropView *fileDrop;
@end

@implementation SPWindowComposition
- (id)initWithFrame:(NSRect)frame {
    if (!(self = [super initWithFrame:frame])) return nil;
    sp_window_object_change(SP_WINDOW_OBJECT_COMPOSITION, 1);
    self.wantsLayer = YES;
    self.layer.opaque = NO;
    self.layer.backgroundColor = NSColor.clearColor.CGColor;
    return self;
}
- (void)dealloc {
    sp_window_object_change(SP_WINDOW_OBJECT_COMPOSITION, -1);
    [_mainWebview release];
    [_overlays release];
    [super dealloc];
}
// The file drop view is placed at the top of the composite view. The page receives a dropped file even when a view was added later.
- (void)didAddSubview:(NSView *)subview {
    [super didAddSubview:subview];
    if (self.fileDrop && subview != self.fileDrop && self.subviews.lastObject != self.fileDrop) {
        [self.fileDrop retain];
        [self.fileDrop removeFromSuperview];
        [super addSubview:self.fileDrop positioned:NSWindowAbove relativeTo:nil];
        [self.fileDrop release];
    }
}
// When the view layout of a window changes, AppKit asks the view under the pointer with cursorUpdate: to set the
// cursor for the current position. WKWebView does not handle this message, so the default behavior of the window sets the
// arrow and overwrites the cursor that the page set (the resize cursor of a divider, the hand of an icon). WebKit
// receives the pointer position as mouseMoved: of the tracking area owner and computes the page cursor, and after layout
// it recomputes with a move at the same position by itself. Therefore the real pointer position is passed to that entry
// of the document under the pointer. It is not passed while a button is pressed, because that is a drag.
- (void)cursorUpdate:(NSEvent *)event {
    NSWindow *window = self.window;
    if (!window || NSEvent.pressedMouseButtons != 0) return;
    NSPoint location = window.mouseLocationOutsideOfEventStream;
    NSView *hit = [self hitTest:[self.superview convertPoint:location fromView:nil]];
    while (hit && ![hit isKindOfClass:WKWebView.class]) hit = hit.superview;
    if (!hit) return;
    NSEvent *moved = [NSEvent mouseEventWithType:NSEventTypeMouseMoved location:location
        modifierFlags:NSEvent.modifierFlags timestamp:NSProcessInfo.processInfo.systemUptime
        windowNumber:window.windowNumber context:nil eventNumber:0 clickCount:0 pressure:0];
    for (NSTrackingArea *area in hit.trackingAreas) {
        // The tracking area of WebKit is the whole visible rect (NSTrackingInVisibleRect), so the rect is not compared. The view was already chosen
        // by the hit test at the pointer position.
        if ((area.options & NSTrackingMouseMoved) && [area.owner respondsToSelector:@selector(mouseMoved:)]) {
            [area.owner mouseMoved:moved];
            return;
        }
    }
}
- (NSView *)hitTest:(NSPoint)point {
    if (self.hidden || self.alphaValue <= 0) return nil;
    NSPoint local = [self convertPoint:point fromView:self.superview];
    if (!NSPointInRect(local, self.bounds)) return nil;
    NSPoint domPoint = [self.mainWebview convertPoint:local fromView:self];
    for (NSValue *overlay in self.overlays) {
        if (NSPointInRect(domPoint, overlay.rectValue)) return domHit(self.mainWebview, self, local);
    }
    NSView *native = [self.coordinates hitTest:local];
    if (native) return native;
    return [super hitTest:point];
}
@end

typedef struct {
    double left, top, right, bottom;
    BOOL visible;
} SPDOMOverlay;

static void notifyScale(NSView *view) {
    if ([view respondsToSelector:@selector(surfaceScaleChanged)]) [view performSelector:@selector(surfaceScaleChanged)];
    for (NSView *child in view.subviews) notifyScale(child);
}

@implementation SPSurfaceHost
- (id)initWithFrame:(NSRect)frame {
    if (!(self = [super initWithFrame:frame])) return nil;
    sp_window_object_change(SP_WINDOW_OBJECT_SURFACE_HOST, 1);
    self.wantsLayer = YES;
    self.layer.masksToBounds = YES;
    self.nativePlane = [[[SPSurfaceNativePlane alloc] initWithFrame:self.bounds] autorelease];
    self.domOverlays = @[];
    self.nativePlane.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [self addSubview:self.nativePlane];
    return self;
}
- (void)dealloc {
    sp_window_object_change(SP_WINDOW_OBJECT_SURFACE_HOST, -1);
    [_nativePlane release];
    [_domOverlays release];
    [super dealloc];
}
- (BOOL)isFlipped { return YES; }
// Rectangles of the visible declared overlays (host coordinates). The hit test and the native mask use the same
// rectangles. Surface DOM coordinates are CSS/AppKit points. A document region can use a different pageZoom, but it is
// a subview of the native plane in the same point space, so the overlay rectangle must not be scaled.
- (NSArray<NSValue *> *)visibleOverlayRects {
    CGFloat zoom = self.webview.pageZoom > 0 ? self.webview.pageZoom : 1;
    NSMutableArray<NSValue *> *rects = [NSMutableArray array];
    for (NSValue *value in self.domOverlays) {
        SPDOMOverlay overlay;
        [value getValue:&overlay size:sizeof(overlay)];
        if (!overlay.visible) continue;
        NSRect rect = NSMakeRect(overlay.left * zoom, overlay.top * zoom,
            MAX(NSWidth(self.bounds) - (overlay.left + overlay.right) * zoom, 0),
            MAX(NSHeight(self.bounds) - (overlay.top + overlay.bottom) * zoom, 0));
        [rects addObject:[NSValue valueWithRect:rect]];
    }
    return rects;
}
// The native plane is composited above the DOM backing, so the native pixels below a visible overlay must be cut out for
// the DOM of the logically upper overlay to show (docs/spec/surface-composition.md). The plane is clipped to the shape of the whole plane minus the overlay rectangles.
- (void)applyOverlayMask {
    NSView *plane = self.nativePlane;
    if (!plane.layer) return;
    NSArray<NSValue *> *rects = [self visibleOverlayRects];
    if (rects.count == 0) {
        plane.layer.mask = nil;
        return;
    }
    CAShapeLayer *mask = [CAShapeLayer layer];
    mask.frame = plane.layer.bounds;
    mask.fillRule = kCAFillRuleEvenOdd;
    CGMutablePathRef path = CGPathCreateMutable();
    CGPathAddRect(path, NULL, plane.layer.bounds);
    for (NSValue *value in rects) {
        NSRect inPlane = [plane convertRect:value.rectValue fromView:self];
        CGPathAddRect(path, NULL, [plane convertRectToLayer:inPlane]);
    }
    mask.path = path;
    CGPathRelease(path);
    plane.layer.mask = mask;
}
- (void)setDomOverlays:(NSArray<NSValue *> *)overlays {
    if (_domOverlays == overlays) return;
    [_domOverlays release];
    _domOverlays = [overlays copy];
    [self applyOverlayMask];
}
- (void)setBounds:(NSRect)bounds {
    NSSize frameSize = self.frame.size;
    if (frameSize.width > 0 && frameSize.height > 0) {
        bounds.size = frameSize;
    }
    [super setBounds:bounds];
    self.nativePlane.frame = self.bounds;
    if (self.webview && self.webview.superview == self) self.webview.frame = self.bounds;
    [self applyOverlayMask];
}
- (NSView *)hitTest:(NSPoint)superviewPoint {
    // AppKit passes the point in the superview coordinates, and the overlay rectangles are in the local coordinates of the surface.
    NSPoint point = [self convertPoint:superviewPoint fromView:self.superview];
    if (self.hidden || self.alphaValue <= 0 || !NSPointInRect(point, self.bounds)) return nil;
    if (surfaceLayoutIsPreparing(self.window)) return nil;
    for (NSValue *rectValue in [[self visibleOverlayRects] reverseObjectEnumerator]) {
        NSRect rect = rectValue.rectValue;
        if (!NSPointInRect(point, rect)) continue;
        // A point inside a visible overlay never reaches the native plane. The DOM of a view draws its own overlays, so the
        // input under them goes to the view web view. A surface without a view web view passes the input on.
        return domHit(self.webview, self, point);
    }
    NSPoint nativePoint = [self.nativePlane convertPoint:point fromView:self];
    NSView *native = [self.nativePlane hitTest:nativePoint];
    if (native) return native;
    return domHit(self.webview, self, point);
}
- (void)setFrameSize:(NSSize)size {
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    [super setFrameSize:size];
    self.nativePlane.frame = self.bounds;
    if (self.webview && self.webview.superview == self) self.webview.frame = self.bounds;
    notifyScale(self.nativePlane);
    [self applyOverlayMask];
    [CATransaction commit];
}
@end

@implementation SPSurfaceCoordinates
- (id)initWithFrame:(NSRect)frame {
    if (!(self = [super initWithFrame:frame])) return nil;
    self.wantsLayer = YES;
    self.layer.opaque = NO;
    self.layer.backgroundColor = NSColor.clearColor.CGColor;
    return self;
}
- (BOOL)isFlipped { return YES; }
- (void)setBounds:(NSRect)bounds {
    // When a hidden surface returns, AppKit can change the size of the flipped container to backing-pixel coordinates.
    // The frame and bounds of the container are both AppKit points, and if they differ, every subview layout is scaled.
    NSSize frameSize = self.frame.size;
    if (frameSize.width > 0 && frameSize.height > 0) {
        bounds.size = frameSize;
    }
    [super setBounds:bounds];
}
- (NSView *)hitTest:(NSPoint)point {
    if (self.hidden || self.alphaValue <= 0 || NSWidth(self.frame) <= 0 || NSHeight(self.frame) <= 0) return nil;
    // AppKit passes frame-unit coordinates to the child in the hitTest: of the parent. This container has a different axis
    // direction from its parent and its bounds are larger by the device scale, so the two are converted explicitly.
    CGFloat x = NSMinX(self.bounds) + point.x * NSWidth(self.bounds) / NSWidth(self.frame);
    CGFloat yFraction = point.y / NSHeight(self.frame);
    if (self.isFlipped != self.superview.isFlipped) yFraction = 1 - yFraction;
    NSPoint local = NSMakePoint(x, NSMinY(self.bounds) + yFraction * NSHeight(self.bounds));
    if (!NSPointInRect(local, self.bounds)) return nil;
    // Asks the topmost host first, and a gap between hosts passes through to the main web view below.
    // The children are placed in the local coordinates of this view, which is the superview coordinate system of each child.
    for (NSView *child in [self.subviews reverseObjectEnumerator]) {
        NSView *hit = [child hitTest:local];
        if (hit) return hit;
    }
    return nil;
}
- (void)setFrameSize:(NSSize)size {
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    [super setFrameSize:size];
    // NSView geometry is expressed in AppKit points. The backing scale belongs to the raster size and not to frame or bounds coordinates.
    self.bounds = NSMakeRect(0, 0, size.width, size.height);
    [CATransaction commit];
}
- (void)updateScale {
    if (!self.window) return;
    if (self.mainView.superview == self.superview && ![self.superview isKindOfClass:SPWindowComposition.class]) {
        [self.superview addSubview:self positioned:NSWindowAbove relativeTo:self.mainView];
    }
    CGFloat scale = self.window.backingScaleFactor;
    // A bounds change raises the backing property notification again, so the same scale is not updated.
    if (scale == self.scale) return;
    self.scale = scale;
    self.bounds = NSMakeRect(0, 0, self.frame.size.width, self.frame.size.height);
    for (SPSurfaceHost *host in self.subviews) {
        if (![host isKindOfClass:SPSurfaceHost.class]) continue;
        // The AppKit frame and the CSS size are both points. The backing scale changes only the raster density. Zooming the
        // document would halve the CSS viewport on a 2x display.
        host.webview.pageZoom = 1;
        [host.webview _setOverrideDeviceScaleFactor:scale];
        notifyScale(host.nativePlane);
    }
}
- (void)viewDidMoveToWindow { [super viewDidMoveToWindow]; [self updateScale]; }
- (void)viewDidChangeBackingProperties { [super viewDidChangeBackingProperties]; [self updateScale]; }
- (void)dealloc {
    [_mainView release];
    [super dealloc];
}
@end

NSEvent *webviewScrollInViewUnits(NSEvent *event, NSView *view) {
    CGFloat scale = 1;
    for (NSView *parent = view; parent; parent = parent.superview) {
        if ([parent isKindOfClass:SPSurfaceCoordinates.class]) {
            scale = ((SPSurfaceCoordinates *)parent).scale;
            break;
        }
    }
    // A surface page uses AppKit points and CSS pixels 1:1. A document region expresses the native frame in the device-pixel
    // coordinate space of the surface, so pageZoom == scale is kept. The event distance conversion is needed only for that document region path.
    if ([view isKindOfClass:WKWebView.class] && ((WKWebView *)view).pageZoom <= 1.0) return event;
    if (scale <= 0 || scale == 1) return event;
    CGEventRef copy = CGEventCreateCopy(event.CGEvent);
    if (!copy) return event;
    // Converts line, point, and fixed-point deltas. NSEvent uses the point value as the delta for continuous scrolling and the fixed-point value for line scrolling.
    const CGEventField lines[2] = { kCGScrollWheelEventDeltaAxis1, kCGScrollWheelEventDeltaAxis2 };
    const CGEventField points[2] = { kCGScrollWheelEventPointDeltaAxis1, kCGScrollWheelEventPointDeltaAxis2 };
    const CGEventField fixed[2] = { kCGScrollWheelEventFixedPtDeltaAxis1, kCGScrollWheelEventFixedPtDeltaAxis2 };
    for (int axis = 0; axis < 2; axis++) {
        double line = CGEventGetDoubleValueField(copy, fixed[axis]);
        int64_t whole = CGEventGetIntegerValueField(copy, lines[axis]);
        int64_t point = CGEventGetIntegerValueField(copy, points[axis]);
        CGEventSetIntegerValueField(copy, lines[axis], llround(whole * scale));
        CGEventSetIntegerValueField(copy, points[axis], llround(point * scale));
        CGEventSetDoubleValueField(copy, fixed[axis], line * scale);
    }
    NSEvent *scaled = [NSEvent eventWithCGEvent:copy];
    CFRelease(copy);
    return scaled ?: event;
}

void webviewAttachSurface(void *handle, void *mainHandle) {
    NSCAssert(NSThread.isMainThread, @"webview geometry requires the UI thread");
    WKWebView *view = (WKWebView *)handle;
    WKWebView *main = (WKWebView *)mainHandle;
    NSCAssert([main.superview isKindOfClass:SPWindowComposition.class],
        @"the main webview must be installed in the surface composition before attaching a surface webview");
    SPWindowComposition *composition = (SPWindowComposition *)main.superview;
    NSCAssert(composition.coordinates != nil,
        @"the surface composition must own its canonical native coordinate container");
    configureWebViewTransparency(view);
    SPSurfaceCoordinates *container = composition.coordinates;
    normalizeCoordinateBounds(container);
    container.mainView = main;
    NSRect frame = [view convertRect:view.bounds toView:container];
    [view retain];
    [view removeFromSuperview];
    SPSurfaceHost *host = [[[SPSurfaceHost alloc] initWithFrame:frame] autorelease];
    host.webview = view;
    host.hidden = view.hidden;
    [container addSubview:host];
    [host addSubview:view positioned:NSWindowAbove relativeTo:host.nativePlane];
    view.frame = host.bounds;
    // Renders one local coordinate unit as one real device pixel. The CSS size is kept.
    view.pageZoom = 1;
    [view _setOverrideDeviceScaleFactor:container.scale];
    // Like the main web view, the document is not hidden when the window is occluded. The capture and drawing check of the surface must finish
    // even in an occluded window. Without this selector, the registration of the main web view (sp_window_set_main_webview) already fails, so it exists here.
    view._windowOcclusionDetectionEnabled = NO;
    [view release];
}

static SPSurfaceHost *surfaceHost(NSView *view) {
    if ([view isKindOfClass:SPSurfaceHost.class]) return (SPSurfaceHost *)view;
    for (NSView *parent = view.superview; parent; parent = parent.superview) {
        if ([parent isKindOfClass:SPSurfaceHost.class]) return (SPSurfaceHost *)parent;
    }
    return nil;
}

// Window composite view that holds the main web view. Created when it does not exist.
static SPWindowComposition *windowComposition(WKWebView *main) {
    if (![main isKindOfClass:WKWebView.class] || !main.window || !main.superview) return nil;
    configureWebViewTransparency(main);
    SPWindowComposition *composition;
    if ([main.superview isKindOfClass:SPWindowComposition.class]) {
        composition = (SPWindowComposition *)main.superview;
    } else {
        NSView *parent = main.superview;
        composition = [[[SPWindowComposition alloc] initWithFrame:main.frame] autorelease];
        // The platform host can resize the app WebView directly without depending on AppKit autoresizing. The compositor wraps
        // that WebView and must still fill its parent so that native hit testing covers the whole window content area.
        composition.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        composition.mainWebview = main;
        [main retain];
        [parent replaceSubview:main with:composition];
        main.frame = composition.bounds;
        main.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        [composition addSubview:main];
        [main release];
        SPSurfaceCoordinates *coordinates = [[[SPSurfaceCoordinates alloc] initWithFrame:composition.bounds] autorelease];
        coordinates.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        coordinates.autoresizesSubviews = NO;
        coordinates.mainView = main;
        composition.coordinates = coordinates;
        [composition addSubview:coordinates positioned:NSWindowAbove relativeTo:main];
        // The window cursor is set by WebKit, which draws the page, through its tracking areas. When the window content view has cursor rects
        // (tao of Tauri places an arrow rect on the whole content), AppKit overwrites the cursor that the page set with the arrow each time it reapplies the rects
        // (docs/features.md F95). This window does not use cursor rects, so that management is turned off.
        [main.window disableCursorRects];
    }
    return composition;
}

bool sp_window_file_drop(void *mainHandle, sp_file_drop_event event, sp_file_drop_release release, void *context) {
    NSCAssert(NSThread.isMainThread, @"file drop requires the UI thread");
    SPWindowComposition *composition = windowComposition((WKWebView *)mainHandle);
    if (!composition || !event) {
        sp_log_error("file drop", "the window has no composition or the receiver is missing");
        return false;
    }
    SPFileDropView *view = composition.fileDrop;
    if (!view) {
        view = [[[SPFileDropView alloc] initWithFrame:composition.bounds] autorelease];
        view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        [view registerForDraggedTypes:@[NSPasteboardTypeFileURL]];
        [composition addSubview:view positioned:NSWindowAbove relativeTo:nil];
        composition.fileDrop = view;
    }
    [view receive:event release:release context:context];
    return true;
}

void *sp_surface_create(void *mainHandle) {
    NSCAssert(NSThread.isMainThread, @"surface creation requires the UI thread");
    WKWebView *main = (WKWebView *)mainHandle;
    SPWindowComposition *composition = windowComposition(main);
    if (!composition) {
        sp_log_error("surface", "the main web view has no window composition to create a surface in");
        return NULL;
    }
    SPSurfaceHost *surface = [[SPSurfaceHost alloc] initWithFrame:NSZeroRect];
    surface.hidden = YES;
    [composition.coordinates addSubview:surface];
    return surface;
}

void sp_surface_close(void *handle) {
    NSCAssert(NSThread.isMainThread, @"surface closure requires the UI thread");
    SPSurfaceHost *surface = (SPSurfaceHost *)handle;
    [surface removeFromSuperview];
    [surface release];
}

void *sp_surface_native_plane(void *handle) {
    return surfaceHost((NSView *)handle).nativePlane;
}

void *sp_surface_main_webview(void *handle) {
    SPSurfaceHost *host = surfaceHost((NSView *)handle);
    return host.webview;
}

double sp_surface_scale(void *handle) {
    for (NSView *view = (NSView *)handle; view; view = view.superview) {
        if ([view isKindOfClass:SPSurfaceCoordinates.class]) {
            // The window is the reference. A hidden surface receives no view backing notification and can move between backing-scale
            // contexts. Using the cached coordinate scale then multiplies every native region by the scale of the earlier display when it is restored.
            NSWindow *window = view.window;
            CGFloat current = window ? window.backingScaleFactor : 0;
            if (current > 0) return current;
            return ((SPSurfaceCoordinates *)view).scale > 0
                ? ((SPSurfaceCoordinates *)view).scale : 1;
        }
    }
    return 1;
}

void sp_surface_set_window_overlays(void *mainHandle, const double *rects, size_t count) {
    NSCAssert(NSThread.isMainThread, @"surface input belongs to the UI thread");
    WKWebView *main = (WKWebView *)mainHandle;
    if (![main.superview isKindOfClass:SPWindowComposition.class]) return;
    SPWindowComposition *composition = (SPWindowComposition *)main.superview;
    NSMutableArray<NSValue *> *overlays = [NSMutableArray arrayWithCapacity:count];
    for (size_t index = 0; index < count; index++) {
        const double *rect = rects + index * 4;
        [overlays addObject:[NSValue valueWithRect:NSMakeRect(rect[0], rect[1], rect[2], rect[3])]];
    }
    composition.overlays = overlays;
}

void webviewDetachSurface(void *handle) {
    NSCAssert(NSThread.isMainThread, @"webview geometry requires the UI thread");
    NSView *view = (NSView *)handle;
    SPSurfaceHost *host = surfaceHost(view);
    if (!host) return;
    [view retain];
    [view removeFromSuperview];
    host.webview = nil;
    [host removeFromSuperview];
    [view release];
}

void *webviewSurfaceNativePlane(void *handle) {
    NSCAssert(NSThread.isMainThread, @"webview geometry requires the UI thread");
    return surfaceHost((NSView *)handle).nativePlane;
}

void webviewMatchSurface(void *handle, void *surfaceHandle) {
    NSCAssert(NSThread.isMainThread, @"webview geometry requires the UI thread");
    WKWebView *view = (WKWebView *)handle;
    NSView *surface = (NSView *)surfaceHandle;
    view.pageZoom = sp_surface_scale(surface);
    // Inside a surface in the device-pixel coordinate system, one local coordinate unit is rendered as one device pixel, like the surface.
    if (surfaceHost(surface)) [view _setOverrideDeviceScaleFactor:1];
}

void webviewSetFrame(void *handle, double x, double y, double width, double height) {
    NSView *view = (NSView *)handle;
    NSWindow *window = view.window;
    if (!window) return;
    NSRect frame = NSMakeRect(x, window.contentView.bounds.size.height - y - height, width, height);
    // The surface frame is a logical AppKit point. Aligning every edge inward to backing pixels would shrink the surface by
    // one device pixel at a divider at a fractional position, and a stale DOM edge would show next to a native region. The native plane
    // clips the region, so preserving the declared logical frame is the safe boundary. The image layer performs the raster conversion at that frame.
    SPSurfaceHost *host = surfaceHost(view);
    NSView *placedView = host ?: view;
    if ([placedView.superview isKindOfClass:SPSurfaceCoordinates.class]) {
        normalizeCoordinateBounds((SPSurfaceCoordinates *)placedView.superview);
    }
    NSRect placed = [placedView.superview convertRect:frame fromView:window.contentView];
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    placedView.frame = placed;
    // Setting the host frame directly does not guarantee that setFrameSize: is called. The native plane and the surface web view are placed
    // in the same coordinate space before the subordinate image region measures the raster.
    if (host) {
        host.bounds = NSMakeRect(0, 0, placed.size.width, placed.size.height);
        host.nativePlane.frame = host.bounds;
        if (view != host) view.frame = host.bounds;
        // The composition layout may have run before the host received the restored logical frame. The native regions are applied
        // again after the host and the plane are settled. Otherwise the image region keeps the earlier scale and size until the next resize.
        notifyScale(host.nativePlane);
    }
    [CATransaction commit];
}

void webviewGetFrame(void *handle, double *out) {
    NSView *view = (NSView *)handle;
    SPSurfaceHost *host = surfaceHost(view);
    if (host) view = host;
    NSView *content = view.window.contentView;
    if (!content) return;
    NSRect frame = [view convertRect:view.bounds toView:content];
    out[0] = frame.origin.x;
    out[1] = content.bounds.size.height - NSMaxY(frame);
    out[2] = frame.size.width;
    out[3] = frame.size.height;
}

// When a view that holds the first responder is hidden, AppKit moves the first responder to another view or window. The layout hides the surface only until the DOM
// is drawn, so a hidden surface records the keyboard owner and the responder that AppKit chose instead.
@interface SPHiddenResponder : NSObject
@property(nonatomic, retain) NSView *owner;
@property(nonatomic, assign) NSResponder *replacement;
@end
@implementation SPHiddenResponder
- (void)dealloc { [_owner release]; [super dealloc]; }
@end

static const char hiddenResponderKey;

void webviewSetSurfaceHidden(void *handle, bool hidden) {
    NSCAssert(NSThread.isMainThread, @"webview geometry requires the UI thread");
    NSView *view = (NSView *)handle;
    SPSurfaceHost *host = surfaceHost(view);
    NSView *surface = host ?: view;
    NSWindow *window = surface.window;
    NSResponder *first = window.firstResponder;
    NSView *owner = hidden && !surface.hidden && [first isKindOfClass:NSView.class]
        && [(NSView *)first isDescendantOf:surface] ? (NSView *)first : nil;
    // Native regions inspect the superview chain of the surface while applying geometry. The superview chain is settled
    // before applying again. Otherwise, after the surface is restored, that document stays hidden even after the host became visible.
    surface.hidden = hidden;
    view.hidden = hidden;
    if (owner) {
        SPHiddenResponder *held = [[SPHiddenResponder new] autorelease];
        held.owner = owner;
        held.replacement = window.firstResponder;
        objc_setAssociatedObject(surface, &hiddenResponderKey, held, OBJC_ASSOCIATION_RETAIN);
    }
    if (!hidden) {
        // Focus is restored only when it was not moved while hidden and the owner is still inside the surface.
        SPHiddenResponder *held = objc_getAssociatedObject(surface, &hiddenResponderKey);
        if (held) {
            if (window && window.firstResponder == held.replacement && [held.owner isDescendantOf:surface]) {
                [window makeFirstResponder:held.owner];
            }
            objc_setAssociatedObject(surface, &hiddenResponderKey, nil, OBJC_ASSOCIATION_RETAIN);
        }
        NSView *coordinates = host.superview;
        if ([coordinates isKindOfClass:SPSurfaceCoordinates.class]) {
            reconfigureSurfaceWebviews(coordinates);
        }
        // A hidden surface can miss frame/backing notifications. Reapply the view and native regions after revealing the host;
        // the view is a sibling of the native plane and may have been placed while the host was hidden.
        notifyScale(host);
    }
}

void webviewSetSurfaceAlpha(void *handle, double alpha) {
    NSCAssert(NSThread.isMainThread, @"webview geometry requires the UI thread");
    NSView *view = (NSView *)handle;
    SPSurfaceHost *host = surfaceHost(view);
    (host ?: view).alphaValue = alpha;
    if (view != host) view.alphaValue = 1;
}

bool sp_webview_kill_content_process(void *handle) {
    WKWebView *view = (WKWebView *)handle;
    if (!view || ![view respondsToSelector:@selector(_killWebContentProcessAndResetState)]) {
        sp_log_error("webview process", "_killWebContentProcessAndResetState is unavailable");
        return false;
    }
    [view _killWebContentProcessAndResetState];
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (view._webProcessIdentifier != 0 && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                 beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    return view._webProcessIdentifier == 0;
}

void sp_webview_log_process_end(void *handle, const char *kind) {
    WKWebView *view = (WKWebView *)handle;
    sp_log_error(kind, [NSString stringWithFormat:@"web content process terminated: %@", view.URL.absoluteString ?: @"(no address)"].UTF8String);
}

bool sp_webview_collect_garbage(void *handle) {
    NSCAssert(NSThread.isMainThread, @"garbage collection requests require the UI thread");
    WKWebView *view = (WKWebView *)handle;
    // The deprecation notice of WKProcessPool means that creating several pools has no effect. The collection for testing exists only in this class, so it is requested on the one pool that the web view uses.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    WKProcessPool *pool = view.configuration.processPool;
    if (!view || ![pool respondsToSelector:@selector(_garbageCollectJavaScriptObjectsForTesting)]) {
        sp_log_error("webview process", "_garbageCollectJavaScriptObjectsForTesting is unavailable");
        return false;
    }
    [pool _garbageCollectJavaScriptObjectsForTesting];
#pragma clang diagnostic pop
    return true;
}

// The script of sp_webview_count_objects: the elements of the main document with the elements of every open shadow root in
// it, nested ones too, because a surface draws in the open shadow root of its host; and the documents of the page, which are
// the document and its frames.
#define SP_COUNT_ELEMENTS @"(() => { const count = (root) => { let total = 0; for (const element of root.querySelectorAll('*')) " \
    @"total += 1 + (element.shadowRoot ? count(element.shadowRoot) : 0); return total; }; return count(document); })()"
static NSString *const kCountObjectsScript = @"[" SP_COUNT_ELEMENTS @", 1 + window.frames.length]";

void sp_webview_count_objects(void *handle, bool document, sp_page_objects_done done, void *context) {
    NSCAssert(NSThread.isMainThread, @"object count requests require the UI thread");
    WKWebView *view = (WKWebView *)handle;
    WKContentWorld *world = document ? [WKContentWorld worldWithName:@"soksak-document"] : WKContentWorld.pageWorld;
    [view evaluateJavaScript:kCountObjectsScript inFrame:nil inContentWorld:world completionHandler:^(id value, NSError *error) {
        if (error) {
            done(context, 0, 0, error.localizedDescription.UTF8String);
            return;
        }
        NSArray *counts = [value isKindOfClass:NSArray.class] ? value : nil;
        BOOL numbers = counts.count == 2;
        for (NSUInteger index = 0; numbers && index < 2; index++) numbers = [counts[index] isKindOfClass:NSNumber.class];
        if (!numbers) {
            done(context, 0, 0, "the page did not return the element and document counts");
            return;
        }
        done(context, [counts[0] longValue], [counts[1] longValue], NULL);
    }];
}

bool sp_surface_place_view(void *surfaceHandle, void *viewHandle) {
    NSCAssert(NSThread.isMainThread, @"webview geometry requires the UI thread");
    SPSurfaceHost *host = surfaceHost((NSView *)surfaceHandle);
    if (!host || !host.nativePlane) return false;
    NSView *view = (NSView *)viewHandle;
    view.frame = host.bounds;
    view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    host.webview = (WKWebView *)view;
    [host addSubview:view positioned:NSWindowBelow relativeTo:host.nativePlane];
    return true;
}

void sp_surface_unplace_view(void *viewHandle) {
    NSCAssert(NSThread.isMainThread, @"webview geometry requires the UI thread");
    SPSurfaceHost *host = surfaceHost((NSView *)viewHandle);
    // Not a surface view: the view is not the web view of its surface host, so the host keeps its state.
    if (host && host.webview == (WKWebView *)viewHandle) host.webview = nil;
}

void webviewSetSurfaceOverlays(void *handle, const double *values, size_t count) {
    NSCAssert(NSThread.isMainThread, @"webview geometry requires the UI thread");
    SPSurfaceHost *host = surfaceHost((NSView *)handle);
    if (!host) return;
    NSMutableArray<NSValue *> *overlays = [NSMutableArray arrayWithCapacity:count];
    for (size_t index = 0; index < count; index++) {
        const double *item = values + index * 5;
        SPDOMOverlay overlay = { item[0], item[1], item[2], item[3], item[4] != 0 };
        [overlays addObject:[NSValue valueWithBytes:&overlay objCType:@encode(SPDOMOverlay)]];
    }
    host.domOverlays = overlays;
}
