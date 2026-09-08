#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import "surface_layout_darwin.h"
#import <WebKit/WebKit.h>

@interface WKWebView (SPPresentation)
- (void)_doAfterNextPresentationUpdate:(void (^)(void))done;
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

static void applicationViews(NSView *parent, WKWebView *main, NSMutableArray<WKWebView *> *views) {
    NSURL *origin = main.URL;
    for (NSView *candidate in parent.subviews) {
        if (candidate == main || candidate.isHiddenOrHasHiddenAncestor) continue;
        if (![candidate isKindOfClass:WKWebView.class]) {
            applicationViews(candidate, main, views);
            continue;
        }
        WKWebView *view = (WKWebView *)candidate;
        NSURL *url = view.URL;
        if (![url.scheme isEqualToString:origin.scheme] || ![url.host isEqualToString:origin.host]
            || !(url.port == origin.port || [url.port isEqual:origin.port])) continue;
        [views addObject:view];
    }
}

void surfaceLayoutAfterPresentation(void *handle, void (^done)(void)) {
    NSCAssert(NSThread.isMainThread, @"surface presentation requires the UI thread");
    WKWebView *main = (WKWebView *)handle;
    NSMutableArray<WKWebView *> *views = [NSMutableArray arrayWithObject:main];
    applicationViews(main.window.contentView, main, views);
    // 앱 문서의 새 크기 표시를 확인한다. 외부 문서의 렌더링은 기다리지 않는다.
    __block NSUInteger pending = views.count;
    for (WKWebView *view in views) {
        [view _doAfterNextPresentationUpdate:^{ if (--pending == 0) done(); }];
    }
}
