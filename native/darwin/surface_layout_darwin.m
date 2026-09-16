#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import "surface_layout_darwin.h"
#import <WebKit/WebKit.h>

@interface WKWebView (SPPresentation)
- (void)_doAfterNextPresentationUpdate:(void (^)(void))done;
@end

@interface SPLayoutRequest : NSObject
@property(nonatomic, assign) void *owner;
@property(nonatomic, assign) uint64_t ticket;
@property(nonatomic, copy) void (^ready)(int);
@end
@implementation SPLayoutRequest
- (void)dealloc { [_ready release]; [super dealloc]; }
@end

static uint64_t preparation;
static void *activeOwner;
static NSMutableArray<SPLayoutRequest *> *waiting;

static void startLayout(SPLayoutRequest *request) {
    if (!activeOwner) {
        [CATransaction begin];
        [CATransaction setDisableActions:YES];
        activeOwner = request.owner;
    }
    preparation = request.ticket;
    request.ready(true);
}

static void nextLayout(void) {
    while (waiting.count && (!activeOwner || waiting.firstObject.owner == activeOwner)) {
        SPLayoutRequest *request = [waiting.firstObject retain];
        [waiting removeObjectAtIndex:0];
        startLayout(request);
        [request release];
    }
}

// CATransaction은 UI 스레드 단위이므로 여러 창의 준비·표시를 직렬화한다.
void surfaceLayoutBegin(void *owner, uint64_t ticket, void (^ready)(int)) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    SPLayoutRequest *request = [[[SPLayoutRequest alloc] init] autorelease];
    request.owner = owner;
    request.ticket = ticket;
    request.ready = ready;
    if (!activeOwner || activeOwner == owner) { startLayout(request); return; }
    if (!waiting) waiting = [[NSMutableArray alloc] init];
    [waiting addObject:request];
}

bool surfaceLayoutCommit(void *owner, uint64_t ticket) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    if (activeOwner != owner || ticket != preparation) return false;
    activeOwner = NULL;
    [CATransaction commit];
    nextLayout();
    return true;
}

void surfaceLayoutCancel(void *owner) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    for (SPLayoutRequest *request in [[waiting copy] autorelease]) {
        if (request.owner != owner) continue;
        [waiting removeObjectIdenticalTo:request];
        request.ready(false);
    }
    if (activeOwner == owner) surfaceLayoutCommit(owner, preparation);
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
