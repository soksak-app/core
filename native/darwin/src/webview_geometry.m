#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#import "input_inject.h"
#import "input_virtual.h"
#import "application_log.h"
#import "event_ring.h"
#import "input_press_context.h"
#import "observe.h"
#import "webview_geometry.h"
#import "surface_layout.h"
#import "window_objects.h"
#import "window_facts.h"
#import "private/webkit.h"


@interface SPSurfaceCoordinates : NSView
@property CGFloat scale;
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

// When the view layout of a window changes, AppKit asks the view under the pointer with cursorUpdate: to set the
// cursor for the current position. WKWebView does not handle this message, so the default behavior of the window sets the
// arrow and overwrites the cursor that the page set (the resize cursor of a divider, the hand of an icon). WebKit
// receives the pointer position as mouseMoved: of the tracking area owner and computes the page cursor, and after layout
// it recomputes with a move at the same position by itself. Therefore the real pointer position is passed to that entry
// of the document under the pointer in root. It is not passed while a button is pressed, because that is a drag.
static void sendPointerMove(NSView *root) {
    NSWindow *window = root.window;
    if (!window || sp_input_person_buttons() != 0) return;
    // A page of a virtual key window hears only injected positions, so without one nothing is sent.
    NSPoint location = window.mouseLocationOutsideOfEventStream;
    if (sp_input_virtual_is((__bridge void *)window)) {
        double x = 0, y = 0;
        if (!sp_input_virtual_point((__bridge void *)window, &x, &y)) return;
        location = NSMakePoint(x, y);
    }
    NSView *hit = [root hitTest:[root.superview convertPoint:location fromView:nil]];
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

// A person types about 10 keys in a second, so this is about 25 seconds of keys before a region shows.
static const NSUInteger kKeptKeysLimit = 256;

static void recordKeys(const char *name, uint8_t level, NSUInteger count, const char *reason) {
    NSString *fields = reason ? [NSString stringWithFormat:@"{\"count\":%lu,\"reason\":\"%s\"}", (unsigned long)count, reason]
        : [NSString stringWithFormat:@"{\"count\":%lu}", (unsigned long)count];
    // events: native.surface.key_kept, native.surface.keys_delivered, native.surface.keys_dropped
    sp_event(SP_CLASS_INPUT, level, name, fields.UTF8String);
}

@interface SPSurfaceHost : NSView {
    id _keyboardOwner;
}
@property(nonatomic, assign) WKWebView *webview;
@property(retain) SPSurfaceNativePlane *nativePlane;
@property(nonatomic, copy) NSArray<NSValue *> *domOverlays;
// The view of the surface that last held the first responder of the window. A closed region leaves it empty.
@property(nonatomic, assign) NSView *keyboardOwner;
// The surface landed on its web view and gives the keyboard to the first image region that shows.
@property(nonatomic) BOOL keyboardWanted;
// The surface declared an image region that has not shown: the surface itself takes the keyboard instead of its page and keeps
// the keys for the region.
@property(nonatomic) BOOL awaitsRegion;
// The keys that wait for the region, oldest first. A surface holds at most kKeptKeysLimit of them.
@property(nonatomic, retain) NSMutableArray<NSEvent *> *keptKeys;
// The keys over the limit since the last delivery.
@property(nonatomic) NSUInteger droppedKeys;
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
- (void)cursorUpdate:(NSEvent *)event { sendPointerMove(self); }
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
    objc_storeWeak(&_keyboardOwner, nil);
    [_keptKeys release];
    [_nativePlane release];
    [_domOverlays release];
    [super dealloc];
}
- (NSView *)keyboardOwner { return objc_loadWeak(&_keyboardOwner); }
- (void)setKeyboardOwner:(NSView *)owner { objc_storeWeak(&_keyboardOwner, owner); }
- (BOOL)acceptsFirstResponder { return self.awaitsRegion; }
- (void)keyDown:(NSEvent *)event {
    if (!self.keptKeys) self.keptKeys = [NSMutableArray array];
    if (self.keptKeys.count >= kKeptKeysLimit) {
        self.droppedKeys++;
        if (self.droppedKeys == 1) recordKeys("native.surface.keys_dropped", SP_EVENT_WARN, 1, "full");
        return;
    }
    [self.keptKeys addObject:event];
    recordKeys("native.surface.key_kept", SP_EVENT_DEBUG, self.keptKeys.count, NULL);
}
// The release of a kept key belongs to no view: the region reads presses only.
- (void)keyUp:(NSEvent *)event { (void)event; }
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
// A web view of a surface host passes cursorUpdate: up its superviews to this container, and the view that holds the
// container decides by its hit test which view the pointer is over.
- (void)cursorUpdate:(NSEvent *)event { sendPointerMove(self.superview); }
- (void)updateScale {
    if (!self.window) return;
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
@end

static SPSurfaceHost *surfaceHost(NSView *view) {
    if ([view isKindOfClass:SPSurfaceHost.class]) return (SPSurfaceHost *)view;
    for (NSView *parent = view.superview; parent; parent = parent.superview) {
        if ([parent isKindOfClass:SPSurfaceHost.class]) return (SPSurfaceHost *)parent;
    }
    return nil;
}

// The container of the surface hosts in view. Created above the other subviews when view holds none.
static SPSurfaceCoordinates *surfaceContainer(NSView *view) {
    for (NSView *child in view.subviews) {
        if ([child isKindOfClass:SPSurfaceCoordinates.class]) return (SPSurfaceCoordinates *)child;
    }
    SPSurfaceCoordinates *coordinates = [[[SPSurfaceCoordinates alloc] initWithFrame:view.bounds] autorelease];
    coordinates.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    coordinates.autoresizesSubviews = NO;
    [view addSubview:coordinates positioned:NSWindowAbove relativeTo:nil];
    return coordinates;
}

void *sp_webview_window_composition(void *mainHandle) {
    NSCAssert(NSThread.isMainThread, @"window composition requires the UI thread");
    WKWebView *main = (WKWebView *)mainHandle;
    if (![main isKindOfClass:WKWebView.class] || !main.window || !main.superview) return NULL;
    if ([main.superview isKindOfClass:SPWindowComposition.class]) return main.superview;
    if (main == main.window.contentView) {
        sp_log_error("surface", "the main web view is the content view of its window, so no composition can wrap it");
        return NULL;
    }
    configureWebViewTransparency(main);
    NSView *parent = main.superview;
    SPWindowComposition *composition = [[[SPWindowComposition alloc] initWithFrame:main.frame] autorelease];
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
    composition.coordinates = surfaceContainer(composition);
    // The window cursor is set by WebKit, which draws the page, through its tracking areas. When the window content view has cursor rects
    // (tao of Tauri places an arrow rect on the whole content), AppKit overwrites the cursor that the page set with the arrow each time it reapplies the rects
    // (docs/features.md F95). This window does not use cursor rects, so that management is turned off.
    [main.window disableCursorRects];
    return composition;
}

static const char nativeViewKey;

void *sp_window_composition(void *window) {
    NSCAssert(NSThread.isMainThread, @"window composition requires the UI thread");
    NSView *parent = ((WKWebView *)sp_window_main_webview(window)).superview;
    if ([parent isKindOfClass:SPWindowComposition.class]) return parent;
    NSView *native = objc_getAssociatedObject((NSWindow *)window, &nativeViewKey);
    return native.window ? native : NULL;
}

void *sp_window_native_view(void *window) {
    NSCAssert(NSThread.isMainThread, @"native view requires the UI thread");
    NSView *native = objc_getAssociatedObject((NSWindow *)window, &nativeViewKey);
    if (!native) {
        native = [[[NSView alloc] initWithFrame:NSZeroRect] autorelease];
        objc_setAssociatedObject((NSWindow *)window, &nativeViewKey, native, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    return native;
}

bool sp_window_file_drop(void *mainHandle, sp_file_drop_event event, sp_file_drop_release release, void *context) {
    NSCAssert(NSThread.isMainThread, @"file drop requires the UI thread");
    NSView *parent = ((WKWebView *)mainHandle).superview;
    if (![parent isKindOfClass:SPWindowComposition.class] || !event) {
        sp_log_error("file drop", "the window has no composition or the receiver is missing");
        return false;
    }
    SPWindowComposition *composition = (SPWindowComposition *)parent;
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

static void observeKeyboardWindowClose(void);
static SPSurfaceHost *surfaceHost(NSView *view);

// Whether view holds the view of a surface, outside the web views, whose documents hold no surface.
static BOOL holdsSurface(NSView *view) {
    for (NSView *child in view.subviews) {
        if ([child isKindOfClass:SPSurfaceHost.class]) return YES;
        if (![child isKindOfClass:WKWebView.class] && holdsSurface(child)) return YES;
    }
    // silent: a view without a surface is the answer of this question, not a failure.
    return NO;
}

// A press on the workbench: a press in the content view of a window that holds a surface, outside the views of its surfaces
// (docs/spec/native-surfaces.md#keyboard-of-a-surface).
static bool pressOnWorkbench(void *owner, double x, double y) {
    NSView *content = ((NSWindow *)owner).contentView;
    if (!content || !holdsSurface(content)) return false;
    NSView *hit = [content hitTest:[content.superview convertPoint:NSMakePoint(x, y) fromView:nil]];
    return hit && !surfaceHost(hit);
}

void *sp_surface_create(void *handle) {
    NSCAssert(NSThread.isMainThread, @"surface creation requires the UI thread");
    NSView *view = (NSView *)handle;
    if (![view isKindOfClass:NSView.class] || !view.window) {
        sp_log_error("surface", "the view that holds the surface container is missing or is not in a window");
        return NULL;
    }
    observeKeyboardWindowClose();
    surfaceLayoutObserveWorkbench(^bool(void *window, double x, double y) { return pressOnWorkbench(window, x, y); });
    SPSurfaceHost *surface = [[SPSurfaceHost alloc] initWithFrame:NSZeroRect];
    surface.hidden = YES;
    [surfaceContainer(view) addSubview:surface];
    return surface;
}

void sp_view_give_up_keyboard(void *handle) {
    NSCAssert(NSThread.isMainThread, @"the keyboard belongs to the main thread");
    NSView *view = (NSView *)handle;
    NSWindow *window = view.window;
    NSResponder *first = window.firstResponder;
    if ([first isKindOfClass:NSView.class] && [(NSView *)first isDescendantOf:view]) [window makeFirstResponder:window.contentView];
}

void sp_surface_close(void *handle) {
    NSCAssert(NSThread.isMainThread, @"surface closure requires the UI thread");
    SPSurfaceHost *surface = (SPSurfaceHost *)handle;
    // The first key over the limit recorded itself, so the counts of these events add up to the keys dropped.
    NSUInteger dropped = surface.keptKeys.count + (surface.droppedKeys ? surface.droppedKeys - 1 : 0);
    if (dropped) recordKeys("native.surface.keys_dropped", SP_EVENT_WARN, dropped, "closed");
    sp_view_give_up_keyboard(surface);
    [surface removeFromSuperview];
    [surface release];
}

void *sp_surface_native_plane(void *handle) {
    return surfaceHost((NSView *)handle).nativePlane;
}

// The left press of the window that is open: a physical press that AppKit reports, or a diagnostic press of sp_input_pointer.
// While the input of the window is held for the decision of the keyboard, only a press that reached a view is open: a press
// that waits in the hold reaches its view after the keyboard moved.
static BOOL leftPressOpen(NSWindow *window) {
    // silent: a press that waits in the hold of the keyboard is not open yet, which is the answer and not a failure.
    if (surfaceLayoutKeyboardHeld(window) && !surfaceLayoutLeftPressPassed(window)) return NO;
    return (sp_input_person_buttons() & 1) != 0 || sp_input_press_open(window, 0);
}

static char keyboardPendingKey, keyboardMonitorKey, keyboardClosedKey;

// Ends the wait for the release of the press of window and returns the keyboard move that waited.
static void (^takeKeyboardWait(NSWindow *window))(void) {
    id monitor = objc_getAssociatedObject(window, &keyboardMonitorKey);
    if (monitor) {
        [NSEvent removeMonitor:monitor];
        objc_setAssociatedObject(window, &keyboardMonitorKey, nil, OBJC_ASSOCIATION_RETAIN);
    }
    void (^give)(void) = [[objc_getAssociatedObject(window, &keyboardPendingKey) retain] autorelease];
    objc_setAssociatedObject(window, &keyboardPendingKey, nil, OBJC_ASSOCIATION_COPY);
    return give;
}

// Runs the keyboard move that waits for the release of the press of window.
void sp_surface_press_released(void *handle) {
    NSCAssert(NSThread.isMainThread, @"the keyboard of a window belongs to the UI thread");
    void (^give)(void) = takeKeyboardWait((NSWindow *)handle);
    if (give) give();
}

// A window that closes gets no key, and the release of its press may never come. The views of its surfaces outlive the close
// until the host closes them, so a call could still follow the owner of a surface into the window. It drops what waits, which
// also holds the window.
static void observeKeyboardWindowClose(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        sp_observe_notification("webview_geometry.window_close", SP_OBSERVE_RECORD, NSWindowWillCloseNotification, nil, nil,
            ^(NSNotification *note) {
                objc_setAssociatedObject(note.object, &keyboardClosedKey, @YES, OBJC_ASSOCIATION_RETAIN);
                takeKeyboardWait(note.object);
            });
    });
}

// A first responder that moves during a press ends the press in the view that holds it (a framework that draws the workbench
// ends a pressed control when its view resigns), so the move waits for the release. The last move that waits replaces an earlier one.
static void giveKeyboardAfterPress(NSWindow *window, void (^give)(void)) {
    if (objc_getAssociatedObject(window, &keyboardClosedKey) && !window.isVisible) return;
    if (!leftPressOpen(window)) {
        objc_setAssociatedObject(window, &keyboardPendingKey, nil, OBJC_ASSOCIATION_COPY);
        give();
        return;
    }
    objc_setAssociatedObject(window, &keyboardPendingKey, give, OBJC_ASSOCIATION_COPY);
    if ((sp_input_person_buttons() & 1) == 0 || objc_getAssociatedObject(window, &keyboardMonitorKey)) return;
    id monitor = sp_observe_local_monitor("webview_geometry.press_release", SP_OBSERVE_RECORD, NSEventMaskLeftMouseUp, ^NSEvent *(NSEvent *event) {
        // It runs after AppKit delivered this release to the view.
        dispatch_async(dispatch_get_main_queue(), ^{ sp_surface_press_released(window); });
        return event;
    });
    objc_setAssociatedObject(window, &keyboardMonitorKey, monitor, OBJC_ASSOCIATION_RETAIN);
}

// The first image region in view that shows: a view that takes the first responder and is no web view, whose document holds
// its own keyboard.
static NSView *shownInputRegion(NSView *view) {
    for (NSView *child in view.subviews) {
        if ([child isKindOfClass:WKWebView.class] || child.isHiddenOrHasHiddenAncestor) continue;
        if (child.acceptsFirstResponder) return child;
        NSView *inside = shownInputRegion(child);
        if (inside) return inside;
    }
    return nil;
}

// Gives the keys that the surface kept to its region, in the order they came.
static void deliverKeptKeys(SPSurfaceHost *host, NSView *region) {
    // The first key over the limit recorded itself, so the counts of these events add up to the keys dropped.
    if (host.droppedKeys > 1) recordKeys("native.surface.keys_dropped", SP_EVENT_WARN, host.droppedKeys - 1, "full");
    host.droppedKeys = 0;
    NSArray<NSEvent *> *keys = [[host.keptKeys copy] autorelease];
    if (keys.count == 0) return;
    [host.keptKeys removeAllObjects];
    for (NSEvent *key in keys) [region keyDown:key];
    recordKeys("native.surface.keys_delivered", SP_EVENT_INFO, keys.count, NULL);
}

static void giveKeyboardToSurface(NSView *view) {
    SPSurfaceHost *host = surfaceHost(view);
    NSView *surface = host ?: view;
    NSWindow *window = surface.window;
    if (!window) {
        sp_log_error("surface keyboard", "the surface that takes the keyboard is not in a window");
        return;
    }
    NSResponder *first = window.firstResponder;
    // A page that holds the keyboard for want of a region holds it only until a region shows.
    if (!host.keyboardWanted && [first isKindOfClass:NSView.class] && [(NSView *)first isDescendantOf:surface]) return;
    NSView *owner = host.keyboardOwner;
    // The surface holds the keyboard only for want of a region, so it is not a view that kept the keyboard.
    NSView *target = owner && owner != host && [owner isDescendantOf:surface] && !owner.isHiddenOrHasHiddenAncestor ? owner : nil;
    if (!target && host) target = shownInputRegion(host.nativePlane);
    BOOL landed = !target;
    if (!target && host.awaitsRegion) target = host;
    // A surface without a web view of its own is a surface module of the main web view.
    if (!target) target = host.webview ?: sp_window_main_webview(window);
    if (!target) {
        sp_log_error("surface keyboard", "the surface has no view that takes the keyboard");
        return;
    }
    if (![window makeFirstResponder:target]) {
        sp_log_error("surface keyboard", [NSString stringWithFormat:@"%@ refused the keyboard", NSStringFromClass(target.class)].UTF8String);
        return;
    }
    host.keyboardWanted = landed;
    // The page took the keyboard for want of a region: nothing chose it, so it does not keep the keyboard from a region later.
    if (landed) host.keyboardOwner = nil;
    else if (target != host.webview) deliverKeptKeys(host, target);
}

static void focusSurface(NSView *view, BOOL awaitsRegion) {
    NSCAssert(NSThread.isMainThread, @"the keyboard of a surface belongs to the UI thread");
    NSWindow *window = view.window;
    if (!window) {
        sp_log_error("surface keyboard", "the surface that takes the keyboard is not in a window");
        return;
    }
    giveKeyboardAfterPress(window, ^{
        surfaceHost(view).awaitsRegion = awaitsRegion;
        giveKeyboardToSurface(view);
    });
}

void sp_surface_focus(void *handle) {
    focusSurface((NSView *)handle, NO);
}

void sp_surface_focus_for_region(void *handle) {
    focusSurface((NSView *)handle, YES);
}

void sp_surface_region_shown(void *handle) {
    NSCAssert(NSThread.isMainThread, @"the keyboard of a surface belongs to the UI thread");
    NSView *region = (NSView *)handle;
    SPSurfaceHost *host = surfaceHost(region);
    NSWindow *window = region.window;
    if (!window || region.isHiddenOrHasHiddenAncestor) return;
    NSResponder *holder = window.firstResponder;
    // The page or the surface holds the keyboard for want of a region, or AppKit gave it to the window when this region hid.
    if (!(host.keyboardWanted && (holder == host.webview || holder == host)) && !(host.keyboardOwner == region && holder == window)) {
        // The keyboard went elsewhere. The keys were typed into this surface, so its region still reads them.
        deliverKeptKeys(host, region);
        return;
    }
    // A geometry change shows a region again and again, and it does not replace a call that waits for the release.
    if (leftPressOpen(window) && objc_getAssociatedObject(window, &keyboardPendingKey)) return;
    // A press can give the region the keyboard before its release, and the region reads the kept keys all the same.
    giveKeyboardAfterPress(window, ^{
        if (window.firstResponder == holder) [window makeFirstResponder:region];
        deliverKeptKeys(host, region);
    });
}

void sp_surface_region_focus(void *handle) {
    NSCAssert(NSThread.isMainThread, @"the keyboard of a surface belongs to the UI thread");
    NSView *region = (NSView *)handle;
    NSWindow *window = region.window;
    if (!window) return;
    giveKeyboardAfterPress(window, ^{
        if (region.window == window && [window makeFirstResponder:region]) deliverKeptKeys(surfaceHost(region), region);
    });
}

void sp_surface_responder_moved(void *from, void *to) {
    NSCAssert(NSThread.isMainThread, @"the keyboard of a surface belongs to the UI thread");
    id entered = (id)to, left = (id)from;
    SPSurfaceHost *into = [entered isKindOfClass:NSView.class] ? surfaceHost(entered) : nil;
    if (into) {
        into.keyboardOwner = entered;
        if (entered != into.webview && entered != into) into.keyboardWanted = NO;
    }
    SPSurfaceHost *outOf = [left isKindOfClass:NSView.class] ? surfaceHost(left) : nil;
    if (outOf && outOf != into) outOf.keyboardWanted = NO;
}

// The view that draws the workbench of a window without a main web view: the first view in view that takes the first responder,
// outside the container of the surface hosts.
static NSView *frameworkKeyView(NSView *view) {
    if (view.acceptsFirstResponder) return view;
    for (NSView *child in view.subviews) {
        if ([child isKindOfClass:SPSurfaceCoordinates.class]) continue;
        NSView *inside = frameworkKeyView(child);
        if (inside) return inside;
    }
    return nil;
}

void sp_window_focus_workbench(void *handle) {
    NSCAssert(NSThread.isMainThread, @"the keyboard of a window belongs to the UI thread");
    NSWindow *window = (NSWindow *)handle;
    giveKeyboardAfterPress(window, ^{
        NSView *target = (NSView *)sp_window_main_webview(window) ?: frameworkKeyView(window.contentView);
        if (!target) {
            sp_log_error("surface keyboard", "the window has no view of the workbench that takes the keyboard");
            return;
        }
        if (![window makeFirstResponder:target]) {
            sp_log_error("surface keyboard", [NSString stringWithFormat:@"%@ refused the keyboard", NSStringFromClass(target.class)].UTF8String);
        }
    });
}

void sp_window_keyboard_hold(void *handle) {
    NSCAssert(NSThread.isMainThread, @"the keyboard of a window belongs to the UI thread");
    surfaceLayoutKeyboardHold(handle);
}

void sp_window_keyboard_decided(void *handle) {
    NSCAssert(NSThread.isMainThread, @"the keyboard of a window belongs to the UI thread");
    surfaceLayoutKeyboardDecided(handle);
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

void *webviewSurfaceNativePlane(void *handle) {
    NSCAssert(NSThread.isMainThread, @"webview geometry requires the UI thread");
    return surfaceHost((NSView *)handle).nativePlane;
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
@property(nonatomic, assign) BOOL landed;
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
    // The move of the first responder that the hide causes ends the wait of the page for a region.
    BOOL landed = host.keyboardWanted;
    // Native regions inspect the superview chain of the surface while applying geometry. The superview chain is settled
    // before applying again. Otherwise, after the surface is restored, that document stays hidden even after the host became visible.
    surface.hidden = hidden;
    view.hidden = hidden;
    if (owner) {
        SPHiddenResponder *held = [[SPHiddenResponder new] autorelease];
        held.owner = owner;
        held.replacement = window.firstResponder;
        held.landed = landed;
        objc_setAssociatedObject(surface, &hiddenResponderKey, held, OBJC_ASSOCIATION_RETAIN);
    }
    if (!hidden) {
        // Focus is restored only when it was not moved while hidden and the owner is still inside the surface.
        SPHiddenResponder *held = objc_getAssociatedObject(surface, &hiddenResponderKey);
        if (held) {
            NSView *owner = held.owner;
            NSResponder *replacement = held.replacement;
            BOOL heldLanded = held.landed;
            // A call that waits for the release of a press was asked for later than this restore.
            if (window && !(leftPressOpen(window) && objc_getAssociatedObject(window, &keyboardPendingKey))) {
                giveKeyboardAfterPress(window, ^{
                    if (window.firstResponder != replacement || ![owner isDescendantOf:surface]) return;
                    // Nothing chose the page that held the keyboard for want of a region, so the return lands again.
                    if (heldLanded) giveKeyboardToSurface(surface);
                    else [window makeFirstResponder:owner];
                });
            }
            objc_setAssociatedObject(surface, &hiddenResponderKey, nil, OBJC_ASSOCIATION_RETAIN);
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
    if (!host || !host.nativePlane) {
        sp_log_error("surface", "the surface to place a view in is missing or has no native plane");
        return false;
    }
    WKWebView *view = (WKWebView *)viewHandle;
    // The document of the view stays visible and runs animation frames while the window is occluded, as the document of
    // the main web view does (sp_window_set_main_webview): surface captures and paint acknowledgements wait for the
    // rendering of the view, so they must finish in an occluded window too. WebKit hides the document of an occluded
    // window and stops its animation frames otherwise.
    if (![view respondsToSelector:@selector(_setWindowOcclusionDetectionEnabled:)]) {
        sp_log_error("surface", "_setWindowOcclusionDetectionEnabled: is unavailable");
        return false;
    }
    view._windowOcclusionDetectionEnabled = NO;
    view.frame = host.bounds;
    view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    // The view draws no opaque backing from its first frame, also in a surface that is already shown.
    configureWebViewTransparency(view);
    host.webview = view;
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
