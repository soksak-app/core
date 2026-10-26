#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import "surface_layout.h"
#import "application_log.h"
#import "observe.h"
#import "window_controls.h"
#import "window_facts.h"
#import "private/webkit.h"

@interface SPLayoutRequest : NSObject
@property(nonatomic, assign) void *owner;
@property(nonatomic, assign) uint64_t ticket;
@property(nonatomic, copy) void (^ready)(int);
@end
@implementation SPLayoutRequest
- (void)dealloc { [_ready release]; [super dealloc]; }
@end

// SPSettleRequest is a presentation wait for every layout transaction of the window to be settled.
@interface SPSettleRequest : NSObject
@property(nonatomic, retain) WKWebView *main;
@property(nonatomic, copy) void (^done)(double, const char *);
@end
@implementation SPSettleRequest
- (void)dealloc { [_main release]; [_done release]; [super dealloc]; }
@end

// SPViewJoin is a view that the open layout transaction waits for. It ends once: by its presentation or by an abandon.
@interface SPViewJoin : NSObject
@property(nonatomic, retain) WKWebView *view;
@property(nonatomic, assign) BOOL resolved;
@end
@implementation SPViewJoin
- (void)dealloc { [_view release]; [super dealloc]; }
@end

static uint64_t preparation;
// The views that the open transaction waits for. Joins are added only while the transaction of activeOwner is open.
static NSMutableArray<SPViewJoin *> *viewJoins;
// YES while the open transaction waits for its joined views before the CATransaction commit.
static BOOL committing;
static void *activeOwner;
static NSMutableArray<SPLayoutRequest *> *waiting;
static NSMutableArray<SPSettleRequest *> *settling;
static bool injectSettledFailure;

static void releaseSettled(void);

// Diagnostic trace. Records ticket, begun, presented, and committed for each transaction. The drag check uses it to divide the delay of the recording frames into stages.
static NSMutableArray<NSMutableArray<NSNumber *> *> *trace;

static void traceMark(uint64_t ticket, NSUInteger stage) {
    if (!trace) return;
    double now = CACurrentMediaTime() * 1000;
    NSMutableArray<NSNumber *> *record = nil;
    for (NSMutableArray<NSNumber *> *item in trace.reverseObjectEnumerator) {
        if (item[0].unsignedLongLongValue == ticket) { record = item; break; }
    }
    if (!record) {
        record = [NSMutableArray arrayWithObjects:@(ticket), @(NAN), @(NAN), @(NAN), @(NAN), nil];
        [trace addObject:record];
    }
    // When one transaction checks the presentation several times, the last check is kept.
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
        for (NSUInteger i = 0; i < SURFACE_LAYOUT_TRACE_STAGES; i++) out[count * SURFACE_LAYOUT_TRACE_STAGES + i] = record[i].doubleValue;
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
    while (waiting.count && (!activeOwner || (waiting.firstObject.owner == activeOwner && !committing))) {
        SPLayoutRequest *request = [waiting.firstObject retain];
        [waiting removeObjectAtIndex:0];
        startLayout(request);
        [request release];
    }
}

// CATransaction is per UI thread, so the preparation and presentation of several windows are serialized.
void surfaceLayoutBegin(void *owner, uint64_t ticket, void (^ready)(int)) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    SPLayoutRequest *request = [[[SPLayoutRequest alloc] init] autorelease];
    request.owner = owner;
    request.ticket = ticket;
    request.ready = ready;
    if (!activeOwner || (activeOwner == owner && !committing)) { startLayout(request); return; }
    if (!waiting) waiting = [[NSMutableArray alloc] init];
    [waiting addObject:request];
}

// Ends the open transaction: the CATransaction commits, and the next waiting layout starts.
static void finishTransaction(void) {
    uint64_t ticket = preparation;
    committing = NO;
    activeOwner = NULL;
    [CATransaction commit];
    traceMark(ticket, 3);
    nextLayout();
    releaseSettled();
}

// Detaches a join from the open transaction. It returns false when the join already ended, so each join ends once.
static bool detachViewJoin(SPViewJoin *join) {
    if (join.resolved) return false;
    join.resolved = YES;
    [viewJoins removeObjectIdenticalTo:join];
    return true;
}

// Finishes a deferred commit once the last joined view has ended.
static void finishDeferredCommit(void) {
    if (committing && viewJoins.count == 0) finishTransaction();
}

// Ends every view wait of the open transaction without a presentation.
static void dropViewJoins(void) {
    for (SPViewJoin *join in [[viewJoins copy] autorelease]) detachViewJoin(join);
}

bool surfaceLayoutCommit(void *owner, uint64_t ticket) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    if (activeOwner != owner || ticket != preparation || committing) {
        return false;
    }
    if (viewJoins.count) {
        committing = YES;
        return true;
    }
    finishTransaction();
    return true;
}

bool surfaceLayoutIsPreparing(void *owner) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    return owner != NULL && activeOwner == owner;
}

void surfaceLayoutCancel(void *owner) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    for (SPLayoutRequest *request in [[waiting copy] autorelease]) {
        if (request.owner != owner) continue;
        [waiting removeObjectIdenticalTo:request];
        request.ready(false);
    }
    if (activeOwner == owner) {
        dropViewJoins();
        if (committing) finishTransaction();
        else surfaceLayoutCommit(owner, preparation);
    }
    releaseSettled();
}

void surfaceLayoutCancelTicket(void *owner, uint64_t ticket) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    for (SPLayoutRequest *request in [[waiting copy] autorelease]) {
        if (request.owner != owner || request.ticket != ticket) continue;
        [waiting removeObjectIdenticalTo:request];
        request.ready(false);
    }
    if (activeOwner == owner && preparation == ticket) {
        dropViewJoins();
        if (committing) finishTransaction();
        else surfaceLayoutCommit(owner, ticket);
    }
    releaseSettled();
}

// SPDisplayedFrame reads the target time of the next display refresh once. Content committed after a presentation
// update finishes appears on the screen by that refresh at the latest. The refresh of the screen continues even when the window is occluded, so the display link is used.
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
    // A link retains its target until it is invalidated.
    CADisplayLink *link = [screen displayLinkWithTarget:frame selector:@selector(tick:)];
    [link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
}

// On macOS, WebKit enables by default the feature that limits page rendering updates to about 60 fps. One layout
// waits for the next presentation of the app DOM (_doAfterNextPresentationUpdate), so even on a 120 Hz display the
// layout is limited to a 60 Hz cycle and during a drag the screen lags the pointer by two or more cycles. This feature is turned on and off with the feature flag list of WebKit (_WKFeature).
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
    // The app DOM is a separate web view; plugin roots and nested document regions are independent web views.
    uint64_t ticket = preparation;
    // Time at which the presentation check of the DOM drawn by the page was requested. This time and presented measure whether the wait
    // for presentation waits for the update of the frame that was drawn or for the update after it (docs/features.md F92).
    traceMark(ticket, 4);
    void (^finish)(void) = [[done copy] autorelease];
    [main _doAfterNextPresentationUpdate:^{
        traceMark(ticket, 2);
        finish();
    }];
}

// Returns whether the window owner has a layout transaction that is open or waiting to open. While a transaction is open,
// no change of the window reaches the screen.
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
            sp_log_error("surface settle", [NSString stringWithFormat:@"DOM completion failed: %@", error.localizedDescription].UTF8String);
            done(0, error.localizedDescription.UTF8String);
            [main release];
            return;
        }
        // DOM evaluation only finishes layout. The web content process must commit the rendering of that DOM before it appears on the screen.
        [main _doAfterNextPresentationUpdate:^{
            // When a new transaction opened while waiting for presentation, the wait starts again from the settlement of that transaction.
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

// SPStartCommit commits the start transaction at the next presentation update after the read of the new page finishes,
// and releases itself. This is the same time at which window_reveal.m reveals a new window. When a new preparation of
// the same window took over the transaction in the meantime, the ticket changed, so SPStartCommit does not commit and the presentation of that preparation commits.
@interface SPStartCommit : NSObject {
    WKWebView *_webview;
    void *_owner;
    uint64_t _ticket;
    BOOL _started;
}
- (instancetype)initWithWebview:(WKWebView *)webview owner:(void *)owner ticket:(uint64_t)ticket;
@end

@implementation SPStartCommit

- (instancetype)initWithWebview:(WKWebView *)webview owner:(void *)owner ticket:(uint64_t)ticket {
    if ((self = [super init])) {
        _webview = [webview retain];
        _owner = owner;
        _ticket = ticket;
        // The start document is requested during the read of the new page, so the read has already started.
        _started = webview.loading;
    }
    return self;
}

- (void)start {
    if (!_webview.loading) {
        [self commitAfterPresentation];
        return;
    }
    sp_observe_key_path("surface_layout.loading", SP_OBSERVE_RECORD, _webview, self, @"loading", 0, NULL);
}

- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary *)change context:(void *)context {
    sp_observe_delivered("surface_layout.loading");
    if (_webview.loading) {
        _started = YES;
        return;
    }
    if (!_started) return;
    [_webview removeObserver:self forKeyPath:@"loading"];
    [self commitAfterPresentation];
}

- (void)commitAfterPresentation {
    [_webview _doAfterNextPresentationUpdate:^{
        surfaceLayoutCommit(self->_owner, self->_ticket);
        [self release];
    }];
}

- (void)dealloc {
    [_webview release];
    [super dealloc];
}

@end

void surfaceLayoutStartPage(void *owner, uint64_t ticket, double height, void (^ready)(const char *failure)) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    NSWindow *window = (NSWindow *)owner;
    WKWebView *main = (WKWebView *)sp_window_main_webview(window);
    if (main == nil) {
        ready("the start title bar needs a registered main webview");
        return;
    }
    char *failure = NULL;
    // A window that is not visible has no previous page. A new window is transparent until the first page presents (window_reveal.h).
    if (!window.isVisible || window.alphaValue == 0) {
        bool set = windowSetTitlebarHeight(window, height, &failure);
        ready(set ? NULL : failure);
        free(failure);
        return;
    }
    void (^finish)(const char *) = [[ready copy] autorelease];
    [main retain];
    surfaceLayoutBegin(owner, ticket, ^(int allowed) {
        if (!allowed) {
            finish("the window closed before the start transaction began");
            [main release];
            return;
        }
        char *problem = NULL;
        if (!windowSetTitlebarHeight(window, height, &problem)) {
            surfaceLayoutCancel(owner);
            finish(problem);
            free(problem);
            [main release];
            return;
        }
        // The observer releases itself when it commits.
        [[[SPStartCommit alloc] initWithWebview:main owner:owner ticket:ticket] start];
        finish(NULL);
        [main release];
    });
}

// Joins the view webview to the open layout transaction of owner. The commit waits until the view presents or is abandoned.
bool surfaceLayoutJoinView(void *owner, uint64_t ticket, void *handle, void (^presented)(void)) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    WKWebView *view = (WKWebView *)handle;
    if (!view || activeOwner != owner || ticket != preparation || committing) return false;
    SPViewJoin *join = [[[SPViewJoin alloc] init] autorelease];
    join.view = view;
    if (!viewJoins) viewJoins = [[NSMutableArray alloc] init];
    [viewJoins addObject:join];
    void (^finish)(void) = [[presented copy] autorelease];
    [view _doAfterNextPresentationUpdate:^{
        if (!detachViewJoin(join)) return;
        finish();
        finishDeferredCommit();
    }];
    return true;
}

// Ends the view wait of the open transaction of owner without a presentation.
bool surfaceLayoutAbandonView(void *owner, void *handle) {
    NSCAssert(NSThread.isMainThread, @"surface layout requires the UI thread");
    if (activeOwner != owner) return false;
    SPViewJoin *found = nil;
    for (SPViewJoin *join in viewJoins) {
        if ((void *)join.view == handle) { found = join; break; }
    }
    if (!found) return false;
    detachViewJoin(found);
    finishDeferredCommit();
    return true;
}

size_t surfaceLayoutViewJoinCount(void *owner) {
    return activeOwner == owner ? viewJoins.count : 0;
}
