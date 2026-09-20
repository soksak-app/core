#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#import "webview_geometry.h"
#import "private/webkit.h"

static void holdFrame(NSView *view, NSRect frame);

@interface SPSurfaceCoordinates : NSView
@property CGFloat scale;
@property(nonatomic, assign) WKWebView *mainView;
@end

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
@property(retain) SPSurfaceNativePlane *nativePlane;
@property(retain) NSArray<NSValue *> *domOverlays;
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
- (NSView *)hitTest:(NSPoint)point {
    CGFloat zoom = self.webview.pageZoom > 0 ? self.webview.pageZoom : 1;
    for (NSValue *value in [self.domOverlays reverseObjectEnumerator]) {
        SPDOMOverlay overlay;
        [value getValue:&overlay size:sizeof(overlay)];
        if (!overlay.visible) continue;
        NSRect rect = NSMakeRect(overlay.left * zoom, overlay.top * zoom,
            MAX(NSWidth(self.bounds) - (overlay.left + overlay.right) * zoom, 0),
            MAX(NSHeight(self.bounds) - (overlay.top + overlay.bottom) * zoom, 0));
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
    if (self.webview && self.webview.superview == self) {
        holdFrame(self.webview, self.bounds);
        self.webview.frame = self.bounds;
    }
    notifyScale(self.nativePlane);
    [CATransaction commit];
}
@end

@implementation SPSurfaceCoordinates
- (BOOL)isFlipped { return YES; }
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
    if (self.scale > 0) self.bounds = NSMakeRect(0, 0, size.width * self.scale, size.height * self.scale);
    [CATransaction commit];
}
- (void)updateScale {
    if (!self.window) return;
    if (self.mainView.superview == self.superview) {
        [self.superview addSubview:self positioned:NSWindowAbove relativeTo:self.mainView];
    }
    CGFloat scale = self.window.backingScaleFactor;
    // bounds 변경이 backing 속성 알림을 다시 발생시키므로 같은 배율은 갱신하지 않는다.
    if (scale == self.scale) return;
    CGFloat ratio = self.scale > 0 ? scale / self.scale : 1;
    self.scale = scale;
    self.bounds = NSMakeRect(0, 0, self.frame.size.width * scale, self.frame.size.height * scale);
    for (SPSurfaceHost *host in self.subviews) {
        if (![host isKindOfClass:SPSurfaceHost.class]) continue;
        NSRect frame = host.frame;
        NSRect next = NSMakeRect(frame.origin.x * ratio, frame.origin.y * ratio,
            frame.size.width * ratio, frame.size.height * ratio);
        holdFrame(host, next);
        host.frame = next;
        WKWebView *view = host.webview;
        view.pageZoom = scale;
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
    NSView *content = main.window.contentView;
    SPSurfaceCoordinates *container = nil;
    for (NSView *child in content.subviews) {
        if ([child isKindOfClass:SPSurfaceCoordinates.class]) { container = (SPSurfaceCoordinates *)child; break; }
    }
    if (!container) {
        container = [[[SPSurfaceCoordinates alloc] initWithFrame:content.bounds] autorelease];
        container.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        container.autoresizesSubviews = NO;
        [content addSubview:container positioned:NSWindowAbove relativeTo:main];
    }
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
    view.pageZoom = container.scale;
    [view _setOverrideDeviceScaleFactor:1];
    [view release];
}

static SPSurfaceHost *surfaceHost(NSView *view) {
    for (NSView *parent = view.superview; parent; parent = parent.superview) {
        if ([parent isKindOfClass:SPSurfaceHost.class]) return (SPSurfaceHost *)parent;
    }
    return nil;
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
    WKWebView *surface = (WKWebView *)surfaceHandle;
    view.pageZoom = surface.pageZoom;
    // 장치 픽셀 좌표계의 표면 안에서는 표면과 같이 로컬 좌표 한 단위를 장치 픽셀 하나로 렌더링한다.
    if (surfaceHost(surface)) [view _setOverrideDeviceScaleFactor:1];
}

// SPHeldFrame 은 호스트가 정한 프레임을 지킨다. 웹 인스펙터를 창에 붙이면 WebKit 이 검사 대상
// 뷰를 창의 남은 자리로 옮기고 인스펙터를 닫아도 되돌리지 않는다. 표면과 모달의 자리는 페이지가
// 정하므로 밖에서 바뀐 프레임은 마지막으로 정한 값으로 되돌린다.
@interface SPHeldFrame : NSObject
@property(nonatomic, assign) NSView *view;
@property(nonatomic) NSRect frame;
@end

@implementation SPHeldFrame
- (instancetype)initWithView:(NSView *)view {
    if ((self = [super init])) {
        _view = view;
        view.postsFrameChangedNotifications = YES;
        [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(frameChanged:)
            name:NSViewFrameDidChangeNotification object:view];
    }
    return self;
}
- (void)dealloc {
    [NSNotificationCenter.defaultCenter removeObserver:self];
    [super dealloc];
}
- (void)frameChanged:(NSNotification *)notification {
    if (NSEqualRects(self.view.frame, self.frame)) return;
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    self.view.frame = self.frame;
    [CATransaction commit];
}
@end

static const char kHeldFrame;

static void holdFrame(NSView *view, NSRect frame) {
    SPHeldFrame *held = objc_getAssociatedObject(view, &kHeldFrame);
    if (!held) {
        held = [[[SPHeldFrame alloc] initWithView:view] autorelease];
        objc_setAssociatedObject(view, &kHeldFrame, held, OBJC_ASSOCIATION_RETAIN);
    }
    held.frame = frame;
}

void webviewSetFrame(void *handle, double x, double y, double width, double height) {
    NSView *view = (NSView *)handle;
    NSWindow *window = view.window;
    if (!window) return;
    NSRect frame = NSMakeRect(x, window.contentView.bounds.size.height - y - height, width, height);
    frame = [window backingAlignedRect:frame options:NSAlignAllEdgesInward];
    SPSurfaceHost *host = surfaceHost(view);
    NSView *placedView = host ?: view;
    NSRect placed = [placedView.superview convertRect:frame fromView:window.contentView];
    // 표면만 프레임을 지킨다. 창 크기를 따라가는 모달은 창이 그 크기를 바꾼다.
    if (host) {
        holdFrame(host, placed);
        holdFrame(view, NSMakeRect(0, 0, placed.size.width, placed.size.height));
    }
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    placedView.frame = placed;
    // Setting the host frame directly does not reliably invoke setFrameSize:
    // keep the native plane and the surface webview in the same coordinate
    // space before any child image region measures its raster.
    if (host) {
        host.bounds = NSMakeRect(0, 0, placed.size.width, placed.size.height);
        host.nativePlane.frame = host.bounds;
        view.frame = host.bounds;
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

void webviewSetSurfaceHidden(void *handle, bool hidden) {
    NSCAssert(NSThread.isMainThread, @"webview geometry requires the UI thread");
    NSView *view = (NSView *)handle;
    SPSurfaceHost *host = surfaceHost(view);
    (host ?: view).hidden = hidden;
    view.hidden = hidden;
}

void webviewSetSurfaceAlpha(void *handle, double alpha) {
    NSCAssert(NSThread.isMainThread, @"webview geometry requires the UI thread");
    NSView *view = (NSView *)handle;
    SPSurfaceHost *host = surfaceHost(view);
    (host ?: view).alphaValue = alpha;
    view.alphaValue = 1;
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
