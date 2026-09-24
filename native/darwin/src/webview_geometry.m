#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#import "webview_geometry.h"
#import "private/webkit.h"


@interface SPSurfaceCoordinates : NSView
@property CGFloat scale;
@property(nonatomic, assign) WKWebView *mainView;
@end

static void normalizeCoordinateBounds(SPSurfaceCoordinates *coordinates) {
    NSSize size = coordinates.frame.size;
    NSRect expected = NSMakeRect(0, 0, size.width, size.height);
    if (!NSEqualRects(coordinates.bounds, expected)) coordinates.bounds = expected;
}

// 표면마다 하나인 네이티브 소유 경계. 이 뷰만 바깥 표면 프레임을 가지며 모든 네이티브
// 영역과 DOM 웹뷰를 함께 자르고 이동한다.
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
@property(nonatomic, assign) WKWebView *mainWebview;
@property(retain) SPSurfaceNativePlane *nativePlane;
@property(retain) NSArray<NSValue *> *domOverlays;
@end

// Hybrid surfaces place native regions below a WebView. CSS transparency does
// not disable WebKit's native opaque backing, so every WebView above a native
// plane must use the same transparent backing rule.
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

// 하나의 앱 DOM과 그 아래 네이티브 평면의 입력 소유권을 선택한다.
@interface SPWindowComposition : NSView
@property(nonatomic, assign) WKWebView *mainWebview;
@property(nonatomic, assign) SPSurfaceCoordinates *coordinates;
@property(nonatomic, retain) NSArray<NSValue *> *overlays;
@end

@implementation SPWindowComposition
- (id)initWithFrame:(NSRect)frame {
    if (!(self = [super initWithFrame:frame])) return nil;
    self.wantsLayer = YES;
    self.layer.opaque = NO;
    self.layer.backgroundColor = NSColor.clearColor.CGColor;
    return self;
}
- (void)dealloc { [_overlays release]; [super dealloc]; }
- (NSView *)hitTest:(NSPoint)point {
    if (self.hidden || self.alphaValue <= 0) return nil;
    NSPoint local = [self convertPoint:point fromView:self.superview];
    if (!NSPointInRect(local, self.bounds)) return nil;
    NSPoint domPoint = [self.mainWebview convertPoint:local fromView:self];
    for (NSValue *overlay in self.overlays) {
        if (NSPointInRect(domPoint, overlay.rectValue)) return [self.mainWebview hitTest:local];
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
    self.wantsLayer = YES;
    self.layer.masksToBounds = YES;
    self.nativePlane = [[[SPSurfaceNativePlane alloc] initWithFrame:self.bounds] autorelease];
    self.domOverlays = @[];
    self.nativePlane.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [self addSubview:self.nativePlane];
    return self;
}
- (void)dealloc {
    [_nativePlane release];
    [_domOverlays release];
    [super dealloc];
}
- (BOOL)isFlipped { return YES; }
- (void)setBounds:(NSRect)bounds {
    NSSize frameSize = self.frame.size;
    if (frameSize.width > 0 && frameSize.height > 0) {
        bounds.size = frameSize;
    }
    [super setBounds:bounds];
    self.nativePlane.frame = self.bounds;
    if (self.webview && self.webview.superview == self) self.webview.frame = self.bounds;
}
- (NSView *)hitTest:(NSPoint)point {
    if (self.hidden || self.alphaValue <= 0 || !NSPointInRect(point, self.bounds)) return nil;
    // Surface DOM coordinates are CSS/AppKit points. A document region may
    // use a different pageZoom, but it is a child of the same point-space
    // native plane and must not scale the surface overlay rectangles.
    CGFloat zoom = self.webview.pageZoom > 0 ? self.webview.pageZoom : 1;
    for (NSValue *value in [self.domOverlays reverseObjectEnumerator]) {
        SPDOMOverlay overlay;
        [value getValue:&overlay size:sizeof(overlay)];
        if (!overlay.visible) continue;
        NSRect rect = NSMakeRect(overlay.left * zoom, overlay.top * zoom,
            MAX(NSWidth(self.bounds) - (overlay.left + overlay.right) * zoom, 0),
            MAX(NSHeight(self.bounds) - (overlay.top + overlay.bottom) * zoom, 0));
        if (NSPointInRect(point, rect) && self.mainWebview) return nil;
        if (NSPointInRect(point, rect) && self.webview && !self.webview.hidden) {
            NSPoint domPoint = [self.webview convertPoint:point fromView:self];
            NSView *dom = [self.webview hitTest:domPoint];
            if (dom) return dom;
        }
    }
    NSPoint nativePoint = [self.nativePlane convertPoint:point fromView:self];
    NSView *native = [self.nativePlane hitTest:nativePoint];
    if (native) return native;
    if (self.webview && !self.webview.hidden) {
        NSPoint domPoint = [self.webview convertPoint:point fromView:self];
        NSView *dom = [self.webview hitTest:domPoint];
        if (dom) return dom;
    }
    return nil;
}
- (void)setFrameSize:(NSSize)size {
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    [super setFrameSize:size];
    self.nativePlane.frame = self.bounds;
    if (self.webview && self.webview.superview == self) self.webview.frame = self.bounds;
    notifyScale(self.nativePlane);
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
    // AppKit may resize a flipped container in backing-pixel coordinates when
    // a hidden surface returns. The container's frame and bounds are both
    // AppKit points; allowing them to diverge scales every child placement.
    NSSize frameSize = self.frame.size;
    if (frameSize.width > 0 && frameSize.height > 0) {
        bounds.size = frameSize;
    }
    [super setBounds:bounds];
}
- (NSView *)hitTest:(NSPoint)point {
    if (self.hidden || self.alphaValue <= 0 || NSWidth(self.frame) <= 0 || NSHeight(self.frame) <= 0) return nil;
    // AppKit 은 부모의 hitTest: 에서 자식에게 frame 단위 좌표를 넘긴다. 이 컨테이너는
    // 부모와 축 방향이 다르고 bounds 도 장치 배율만큼 크므로 둘을 명시적으로 변환한다.
    CGFloat x = NSMinX(self.bounds) + point.x * NSWidth(self.bounds) / NSWidth(self.frame);
    CGFloat yFraction = point.y / NSHeight(self.frame);
    if (self.isFlipped != self.superview.isFlipped) yFraction = 1 - yFraction;
    NSPoint local = NSMakePoint(x, NSMinY(self.bounds) + yFraction * NSHeight(self.bounds));
    if (!NSPointInRect(local, self.bounds)) return nil;
    // 위쪽 호스트부터 묻고 호스트 사이의 빈 곳은 아래 메인 웹뷰로 통과한다.
    for (NSView *child in [self.subviews reverseObjectEnumerator]) {
        NSPoint childPoint = [child convertPoint:local fromView:self];
        NSView *hit = [child hitTest:childPoint];
        if (hit) return hit;
    }
    return nil;
}
- (void)setFrameSize:(NSSize)size {
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    [super setFrameSize:size];
    // NSView geometry is expressed in AppKit points. The backing scale belongs
    // to raster dimensions, not to frame or bounds coordinates.
    self.bounds = NSMakeRect(0, 0, size.width, size.height);
    [CATransaction commit];
}
- (void)updateScale {
    if (!self.window) return;
    if (self.mainView.superview == self.superview && ![self.superview isKindOfClass:SPWindowComposition.class]) {
        [self.superview addSubview:self positioned:NSWindowAbove relativeTo:self.mainView];
    }
    CGFloat scale = self.window.backingScaleFactor;
    // bounds 변경이 backing 속성 알림을 다시 발생시키므로 같은 배율은 갱신하지 않는다.
    if (scale == self.scale) return;
    self.scale = scale;
    self.bounds = NSMakeRect(0, 0, self.frame.size.width, self.frame.size.height);
    for (SPSurfaceHost *host in self.subviews) {
        if (![host isKindOfClass:SPSurfaceHost.class]) continue;
        // AppKit frames and CSS dimensions are both points. The backing scale
        // changes raster density only; zooming the document would halve its
        // CSS viewport on a 2x display.
        host.webview.pageZoom = 1;
        [host.webview _setOverrideDeviceScaleFactor:scale];
        notifyScale(host.nativePlane);
    }
}
- (void)viewDidMoveToWindow { [super viewDidMoveToWindow]; [self updateScale]; }
- (void)viewDidChangeBackingProperties { [super viewDidChangeBackingProperties]; [self updateScale]; }
@end

NSEvent *webviewScrollInViewUnits(NSEvent *event, NSView *view) {
    CGFloat scale = 1;
    for (NSView *parent = view; parent; parent = parent.superview) {
        if ([parent isKindOfClass:SPSurfaceCoordinates.class]) {
            scale = ((SPSurfaceCoordinates *)parent).scale;
            break;
        }
    }
    // Surface pages use AppKit points and CSS pixels 1:1. Document regions
    // retain pageZoom == scale because their native frame is expressed in the
    // surface's device-pixel coordinate space. Only that latter path needs
    // event-distance conversion.
    if ([view isKindOfClass:WKWebView.class] && ((WKWebView *)view).pageZoom <= 1.0) return event;
    if (scale <= 0 || scale == 1) return event;
    CGEventRef copy = CGEventCreateCopy(event.CGEvent);
    if (!copy) return event;
    // 줄, 포인트, 고정소수점 이동량을 모두 바꾼다. NSEvent 는 연속 스크롤에서 포인트 값을,
    // 줄 단위 스크롤에서 고정소수점 값을 이동량으로 쓴다.
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
    // 로컬 좌표 한 단위를 실제 장치 픽셀 하나로 렌더링한다. CSS 크기는 유지한다.
    view.pageZoom = 1;
    [view _setOverrideDeviceScaleFactor:container.scale];
    [view release];
}

static SPSurfaceHost *surfaceHost(NSView *view) {
    if ([view isKindOfClass:SPSurfaceHost.class]) return (SPSurfaceHost *)view;
    for (NSView *parent = view.superview; parent; parent = parent.superview) {
        if ([parent isKindOfClass:SPSurfaceHost.class]) return (SPSurfaceHost *)parent;
    }
    return nil;
}

void *sp_surface_create(void *mainHandle) {
    NSCAssert(NSThread.isMainThread, @"surface creation requires the UI thread");
    WKWebView *main = (WKWebView *)mainHandle;
    if (![main isKindOfClass:WKWebView.class] || !main.window || !main.superview) return NULL;
    configureWebViewTransparency(main);
    SPWindowComposition *composition;
    if ([main.superview isKindOfClass:SPWindowComposition.class]) {
        composition = (SPWindowComposition *)main.superview;
    } else {
        NSView *parent = main.superview;
        composition = [[[SPWindowComposition alloc] initWithFrame:main.frame] autorelease];
        composition.autoresizingMask = main.autoresizingMask;
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
    }
    SPSurfaceHost *surface = [[SPSurfaceHost alloc] initWithFrame:NSZeroRect];
    surface.mainWebview = main;
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
    return host.mainWebview ?: host.webview;
}

double sp_surface_scale(void *handle) {
    for (NSView *view = (NSView *)handle; view; view = view.superview) {
        if ([view isKindOfClass:SPSurfaceCoordinates.class]) {
            // The window is the source of truth. A hidden surface can move
            // between backing-scale contexts without receiving a view backing
            // notification; using the cached coordinate scale then multiplies
            // every native region by the old display scale on restore.
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
    // 장치 픽셀 좌표계의 표면 안에서는 표면과 같이 로컬 좌표 한 단위를 장치 픽셀 하나로 렌더링한다.
    if (surfaceHost(surface)) [view _setOverrideDeviceScaleFactor:1];
}

void webviewSetFrame(void *handle, double x, double y, double width, double height) {
    NSView *view = (NSView *)handle;
    NSWindow *window = view.window;
    if (!window) return;
    NSRect frame = NSMakeRect(x, window.contentView.bounds.size.height - y - height, width, height);
    // Surface frames are logical AppKit points. Aligning every edge inward to
    // backing pixels shrinks a surface by one device pixel at fractional
    // divider positions, leaving a stale DOM edge visible beside the native
    // region. The native plane clips the region, so preserving the declared
    // logical frame is the safe boundary; its image layer performs the raster
    // conversion from that frame.
    SPSurfaceHost *host = surfaceHost(view);
    NSView *placedView = host ?: view;
    if ([placedView.superview isKindOfClass:SPSurfaceCoordinates.class]) {
        normalizeCoordinateBounds((SPSurfaceCoordinates *)placedView.superview);
    }
    NSRect placed = [placedView.superview convertRect:frame fromView:window.contentView];
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    placedView.frame = placed;
    // Setting the host frame directly does not reliably invoke setFrameSize:
    // keep the native plane and the surface webview in the same coordinate
    // space before any child image region measures its raster.
    if (host) {
        host.bounds = NSMakeRect(0, 0, placed.size.width, placed.size.height);
        host.nativePlane.frame = host.bounds;
        if (view != host) view.frame = host.bounds;
        // Composition placement may have run before the host received its
        // restored logical frame. Re-apply native regions after the host and
        // plane are authoritative, otherwise an old scale/size remains on
        // the image region until the next resize.
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

// 첫 응답자를 담은 뷰를 숨기면 AppKit 은 첫 응답자를 다른 뷰나 창으로 옮긴다. 배치는 DOM 이
// 그려질 때까지만 표면을 숨기므로, 숨긴 표면은 키보드 소유자와 AppKit 이 대신 정한 응답자를 기록한다.
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
    // Native regions inspect the surface ancestry while applying geometry. Make
    // the ancestry authoritative before reapplying it; otherwise restoring a
    // surface leaves its documents hidden after the host becomes visible.
    surface.hidden = hidden;
    view.hidden = hidden;
    if (owner) {
        SPHiddenResponder *held = [[SPHiddenResponder new] autorelease];
        held.owner = owner;
        held.replacement = window.firstResponder;
        objc_setAssociatedObject(surface, &hiddenResponderKey, held, OBJC_ASSOCIATION_RETAIN);
    }
    if (!hidden) {
        // 숨긴 동안 포커스가 옮겨지지 않았고 소유자가 아직 표면 안에 있을 때만 되돌린다.
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
        // A hidden surface can miss frame/backing notifications while the
        // window is restored. Re-apply every native region's logical geometry
        // before exposing the surface so stale scale-dependent frames never
        // become visible.
        notifyScale(host.nativePlane);
    }
}

void webviewSetSurfaceAlpha(void *handle, double alpha) {
    NSCAssert(NSThread.isMainThread, @"webview geometry requires the UI thread");
    NSView *view = (NSView *)handle;
    SPSurfaceHost *host = surfaceHost(view);
    (host ?: view).alphaValue = alpha;
    if (view != host) view.alphaValue = 1;
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
