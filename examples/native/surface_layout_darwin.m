#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import "surface_layout_darwin.h"
#import <WebKit/WebKit.h>

@interface WKWebView (SPPresentation)
- (void)_doAfterNextPresentationUpdate:(void (^)(void))done;
- (BOOL)_drawsBackground;
- (NSColor *)_backgroundColor;
- (void)_setBackgroundColor:(NSColor *)color;
@end

static uint64_t preparation;
static BOOL active;

void surfaceLayoutBegin(uint64_t ticket) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    if (!active) {
        [CATransaction begin];
        [CATransaction setDisableActions:YES];
        active = YES;
    }
    preparation = ticket;
}

bool surfaceLayoutCommit(uint64_t ticket) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    if (!active || ticket != preparation) return false;
    active = NO;
    [CATransaction commit];
    return true;
}

void surfaceLayoutCancel(void) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    if (!active) return;
    active = NO;
    [CATransaction commit];
}

void surfaceLayoutAfterPresentation(void *handle, void (^done)(void)) {
    NSCAssert(NSThread.isMainThread, @"surface presentation requires the UI thread");
    WKWebView *main = (WKWebView *)handle;
    NSURL *origin = main.URL;
    NSMutableArray<WKWebView *> *views = [NSMutableArray arrayWithObject:main];
    for (NSView *candidate in main.superview.subviews) {
        if (candidate == main || ![candidate isKindOfClass:WKWebView.class]
            || candidate.isHiddenOrHasHiddenAncestor) continue;
        WKWebView *view = (WKWebView *)candidate;
        NSURL *url = view.URL;
        if (![url.scheme isEqualToString:origin.scheme] || ![url.host isEqualToString:origin.host]
            || !(url.port == origin.port || [url.port isEqual:origin.port])) continue;
        [views addObject:view];
    }
    // 앱 문서의 새 크기 표시를 확인한다. 외부 문서의 렌더링은 기다리지 않는다.
    __block NSUInteger pending = views.count;
    for (WKWebView *view in views) {
        [view _doAfterNextPresentationUpdate:^{
            // 소수점 크기에서 문서 밖 한 픽셀도 문서 배경색으로 표시한다.
            NSColor *color = view.underPageBackgroundColor;
            if ([view _drawsBackground] && ![[view _backgroundColor] isEqual:color])
                [view _setBackgroundColor:color];
            if (--pending == 0) done();
        }];
    }
}
