#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <stdio.h>
#import "surface_layout.h"
#import "private/webkit.h"

@interface SPLayoutRequest : NSObject
@property(nonatomic, assign) void *owner;
@property(nonatomic, assign) uint64_t ticket;
@property(nonatomic, copy) void (^ready)(int);
@end
@implementation SPLayoutRequest
- (void)dealloc { [_ready release]; [super dealloc]; }
@end

// SPSettleRequest 는 창의 배치 트랜잭션이 모두 확정되기를 기다리는 표시 대기다.
@interface SPSettleRequest : NSObject
@property(nonatomic, retain) WKWebView *main;
@property(nonatomic, copy) void (^done)(double, const char *);
@end
@implementation SPSettleRequest
- (void)dealloc { [_main release]; [_done release]; [super dealloc]; }
@end

static uint64_t preparation;
static void *activeOwner;
static NSMutableArray<SPLayoutRequest *> *waiting;
static NSMutableArray<SPSettleRequest *> *settling;
static bool injectSettledFailure;

static void releaseSettled(void);

// 진단 추적. 트랜잭션마다 ticket, begun, presented, committed 를 기록한다. 끌기 검사가 녹화 프레임의
// 지연을 단계로 나누는 데 쓴다.
static NSMutableArray<NSMutableArray<NSNumber *> *> *trace;

static void traceMark(uint64_t ticket, NSUInteger stage) {
    if (!trace) return;
    double now = CACurrentMediaTime() * 1000;
    NSMutableArray<NSNumber *> *record = nil;
    for (NSMutableArray<NSNumber *> *item in trace.reverseObjectEnumerator) {
        if (item[0].unsignedLongLongValue == ticket) { record = item; break; }
    }
    if (!record) {
        record = [NSMutableArray arrayWithObjects:@(ticket), @(NAN), @(NAN), @(NAN), nil];
        [trace addObject:record];
    }
    // 한 트랜잭션이 표시를 여러 번 확인하면 마지막 확인을 남긴다.
    record[stage] = @(now);
}

void surfaceLayoutTraceStart(void) {
    NSCAssert(NSThread.isMainThread, @"surface layout trace requires the UI thread");
    [trace release];
    trace = [[NSMutableArray alloc] init];
}

size_t surfaceLayoutTraceStop(double *out, size_t capacity) {
    NSCAssert(NSThread.isMainThread, @"surface layout trace requires the UI thread");
    size_t total = trace.count;
    size_t count = 0;
    for (NSMutableArray<NSNumber *> *record in trace) {
        if (count >= capacity) break;
        for (NSUInteger i = 0; i < 4; i++) out[count * 4 + i] = record[i].doubleValue;
        count++;
    }
    [trace release];
    trace = nil;
    return total;
}

static void startLayout(SPLayoutRequest *request) {
    if (!activeOwner) {
        [CATransaction begin];
        [CATransaction setDisableActions:YES];
        activeOwner = request.owner;
    }
    preparation = request.ticket;
    traceMark(request.ticket, 1);
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
    if (activeOwner != owner || ticket != preparation) {
        return false;
    }
    activeOwner = NULL;
    [CATransaction commit];
    traceMark(ticket, 3);
    nextLayout();
    releaseSettled();
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
    releaseSettled();
}

// SPDisplayedFrame 은 화면의 다음 갱신 목표 시각을 한 번 읽는다. 표시 갱신이 끝난 뒤 커밋된 내용은
// 늦어도 그 갱신에 화면에 나온다. 창이 가려져도 화면의 갱신은 계속되므로 화면의 링크를 쓴다.
@interface SPDisplayedFrame : NSObject
@property(nonatomic, copy) void (^done)(double, const char *);
- (void)tick:(CADisplayLink *)link;
@end
@implementation SPDisplayedFrame
- (void)dealloc { [_done release]; [super dealloc]; }
- (void)tick:(CADisplayLink *)link {
    double displayed = link.targetTimestamp * 1000;
    [link invalidate];
    self.done(displayed, NULL);
}
@end

static void afterNextFrame(NSScreen *screen, void (^done)(double, const char *)) {
    if (screen == nil) {
        done(CACurrentMediaTime() * 1000, NULL);
        return;
    }
    SPDisplayedFrame *frame = [[SPDisplayedFrame new] autorelease];
    frame.done = done;
    // 링크는 무효화될 때까지 대상을 보유한다.
    CADisplayLink *link = [screen displayLinkWithTarget:frame selector:@selector(tick:)];
    [link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
}

// WebKit 은 macOS 에서 페이지 렌더링 갱신을 60fps 근처로 묶는 기능을 기본으로 켠다. 배치 한 번은
// 앱 DOM 의 다음 표시(_doAfterNextPresentationUpdate)를 기다리므로, 120Hz 화면에서도 배치가 60Hz
// 주기로 묶이고 끌기 중 화면이 포인터보다 두 주기 이상 늦는다. 이 기능은 WebKit 의 기능 플래그
// 목록(_WKFeature)으로 켜고 끈다.
static _WKFeature *near60FPSFeature(void) {
    for (_WKFeature *feature in [WKPreferences _features]) {
        if ([feature.key isEqualToString:@"PreferPageRenderingUpdatesNear60FPSEnabled"]) return feature;
    }
    return nil;
}

bool surfaceLayoutRenderAtDisplayRate(void *handle) {
    NSCAssert(NSThread.isMainThread, @"webview configuration requires the UI thread");
    WKWebView *view = (WKWebView *)handle;
    _WKFeature *feature = near60FPSFeature();
    if (!feature) return false;
    [view.configuration.preferences _setEnabled:NO forFeature:feature];
    return true;
}

int surfaceLayoutPrefersNear60FPS(void *handle) {
    WKWebView *view = (WKWebView *)handle;
    _WKFeature *feature = near60FPSFeature();
    if (!feature) return -1;
    return [view.configuration.preferences _isEnabledForFeature:feature] ? 1 : 0;
}

void surfaceLayoutAfterPresentation(void *handle, void (^done)(void)) {
    NSCAssert(NSThread.isMainThread, @"surface presentation requires the UI thread");
    WKWebView *main = (WKWebView *)handle;
    // 모든 플러그인 DOM은 이 웹뷰에 있다. 다른 웹뷰는 독립적인 문서 콘텐츠다.
    uint64_t ticket = preparation;
    void (^finish)(void) = [[done copy] autorelease];
    [main _doAfterNextPresentationUpdate:^{
        traceMark(ticket, 2);
        finish();
    }];
}

// 창 owner 에 열렸거나 열릴 차례인 배치 트랜잭션이 있는지 반환한다. 트랜잭션이 열린 동안에는 창의
// 어떤 변경도 화면에 나가지 않는다.
static bool layoutOpen(void *owner) {
    if (activeOwner == owner) return true;
    for (SPLayoutRequest *request in waiting) {
        if (request.owner == owner) return true;
    }
    return false;
}

static void settle(WKWebView *main, void (^done)(double, const char *)) {
    void *owner = main.window;
    if (layoutOpen(owner)) {
        SPSettleRequest *request = [[SPSettleRequest new] autorelease];
        request.main = main;
        request.done = done;
        if (!settling) settling = [[NSMutableArray alloc] init];
        [settling addObject:request];
        return;
    }
        void (^finish)(double, const char *) = [[done copy] autorelease];
    [main retain];
    [main evaluateJavaScript:@"void document.documentElement.offsetWidth" completionHandler:^(id value, NSError *error) {
        if (error) {
            fprintf(stderr, "surface settle DOM completion failed: %s\\n", error.localizedDescription.UTF8String);
            done(0, error.localizedDescription.UTF8String);
            [main release];
            return;
        }
        // DOM 평가는 레이아웃만 끝낸다. 웹 콘텐츠 프로세스가 그 DOM 의 렌더링을 커밋해야 화면에 나온다.
        [main _doAfterNextPresentationUpdate:^{
            // 표시를 기다리는 사이 새 트랜잭션이 열렸으면 그 트랜잭션의 확정부터 다시 기다린다.
            if (layoutOpen(main.window)) settle(main, finish);
            else afterNextFrame(main.window.screen, finish);
            [main release];
        }];
    }];
}

static void releaseSettled(void) {
    for (SPSettleRequest *request in [[settling copy] autorelease]) {
        if (layoutOpen(request.main.window)) continue;
        [[request retain] autorelease];
        [settling removeObjectIdenticalTo:request];
        settle(request.main, request.done);
    }
}

void surfaceLayoutAfterSettled(void *handle, void (^done)(double, const char *)) {
    NSCAssert(NSThread.isMainThread, @"surface presentation requires the UI thread");
    if (injectSettledFailure) {
        injectSettledFailure = false;
        done(0, "injected native presentation failure");
        return;
    }
    settle((WKWebView *)handle, done);
}

void surfaceLayoutInjectSettledFailure(void) {
    NSCAssert(NSThread.isMainThread, @"surface presentation failure injection requires the UI thread");
    injectSettledFailure = true;
}
