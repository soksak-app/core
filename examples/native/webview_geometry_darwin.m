#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "webview_geometry_darwin.h"

@interface WKWebView (SPSurfaceScale)
- (void)_setOverrideDeviceScaleFactor:(double)scale;
@end

@interface SPSurfaceCoordinates : NSView
@property CGFloat scale;
@end

@implementation SPSurfaceCoordinates
- (BOOL)isFlipped { return YES; }
- (NSView *)hitTest:(NSPoint)point {
    NSView *hit = [super hitTest:point];
    return hit == self ? nil : hit;
}
- (void)setFrameSize:(NSSize)size {
    [super setFrameSize:size];
    if (self.scale > 0) self.bounds = NSMakeRect(0, 0, size.width * self.scale, size.height * self.scale);
}
- (void)updateScale {
    if (!self.window) return;
    CGFloat scale = self.window.backingScaleFactor;
    // bounds 변경이 backing 속성 알림을 다시 발생시키므로 같은 배율은 갱신하지 않는다.
    if (scale == self.scale) return;
    CGFloat ratio = self.scale > 0 ? scale / self.scale : 1;
    self.scale = scale;
    self.bounds = NSMakeRect(0, 0, self.frame.size.width * scale, self.frame.size.height * scale);
    for (WKWebView *view in self.subviews) {
        NSRect frame = view.frame;
        view.frame = NSMakeRect(frame.origin.x * ratio, frame.origin.y * ratio,
            frame.size.width * ratio, frame.size.height * ratio);
        view.pageZoom = scale;
    }
}
- (void)viewDidMoveToWindow { [super viewDidMoveToWindow]; [self updateScale]; }
- (void)viewDidChangeBackingProperties { [super viewDidChangeBackingProperties]; [self updateScale]; }
@end

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
    NSRect frame = [view convertRect:view.bounds toView:container];
    [view retain];
    [view removeFromSuperview];
    [container addSubview:view];
    view.frame = frame;
    // 로컬 좌표 한 단위를 실제 장치 픽셀 하나로 렌더링한다. CSS 크기는 유지한다.
    view.pageZoom = container.scale;
    [view _setOverrideDeviceScaleFactor:1];
    [view release];
}

void webviewSetFrame(void *handle, double x, double y, double width, double height) {
    NSView *view = (NSView *)handle;
    NSWindow *window = view.window;
    if (!window) return;
    NSRect frame = NSMakeRect(x, window.contentView.bounds.size.height - y - height, width, height);
    frame = [window backingAlignedRect:frame options:NSAlignAllEdgesInward];
    view.frame = [view.superview convertRect:frame fromView:window.contentView];
}

void webviewGetFrame(void *handle, double *out) {
    NSView *view = (NSView *)handle;
    NSView *content = view.window.contentView;
    if (!content) return;
    NSRect frame = [view convertRect:view.bounds toView:content];
    out[0] = frame.origin.x;
    out[1] = content.bounds.size.height - NSMaxY(frame);
    out[2] = frame.size.width;
    out[3] = frame.size.height;
}
