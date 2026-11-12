// Checks that the app DOM presentation wait excludes independent webviews and that a layout transaction can join a
// resized plugin root webview. A busy document must not block the app DOM layout. The check does not activate the app.
#import <Cocoa/Cocoa.h>
#import <IOSurface/IOSurface.h>
#import <QuartzCore/QuartzCore.h>
#import "surface_layout.h"
#import "capture.h"
#import "image_region.h"
#import "input_inject.h"
#import "support/capture_frame.m"
#import "support/event_wait.h"
#import "webview_geometry.h"
#import "window_facts.h"
#import "private/webkit.h"
#import "support/surface_view.h"
#import "support/temporary_folder.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Returns the same empty document for every requested address. The host of the address sets the origin. It holds a
// request of the path /hold, which a busy script makes synchronously, so the web process of that script stays busy until
// the check answers it.
@interface SPPageScheme : NSObject <WKURLSchemeHandler>
@property(retain) id<WKURLSchemeTask> held;
- (void)answerHeld;
@end
@implementation SPPageScheme
- (void)webView:(WKWebView *)view startURLSchemeTask:(id<WKURLSchemeTask>)task {
    if ([task.request.URL.path isEqualToString:@"/hold"]) {
        self.held = task;
        return;
    }
    NSData *body = [@"<!doctype html><body style='margin:0'></body>" dataUsingEncoding:NSUTF8StringEncoding];
    NSURLResponse *response = [[[NSURLResponse alloc] initWithURL:task.request.URL MIMEType:@"text/html"
        expectedContentLength:(NSInteger)body.length textEncodingName:@"utf-8"] autorelease];
    [task didReceiveResponse:response];
    [task didReceiveData:body];
    [task didFinish];
}
- (void)webView:(WKWebView *)view stopURLSchemeTask:(id<WKURLSchemeTask>)task {
    if (task == self.held) self.held = nil;
}
// Answers the held request, which ends the busy script.
- (void)answerHeld {
    id<WKURLSchemeTask> task = [[self.held retain] autorelease];
    self.held = nil;
    NSData *body = [@"released" dataUsingEncoding:NSUTF8StringEncoding];
    NSURLResponse *response = [[[NSURLResponse alloc] initWithURL:task.request.URL MIMEType:@"text/plain"
        expectedContentLength:(NSInteger)body.length textEncodingName:@"utf-8"] autorelease];
    [task didReceiveResponse:response];
    [task didReceiveData:body];
    [task didFinish];
}
- (void)dealloc {
    [_held release];
    [super dealloc];
}
@end

// Counts a fixed number of display refreshes and calls done, when it is set, with the target time (ms) of the last one.
@interface SPFrames : NSObject
@property int left;
@property (copy) void (^done)(double target);
- (void)tick:(CADisplayLink *)link;
@end
@implementation SPFrames
- (void)tick:(CADisplayLink *)link {
    if (--self.left != 0) return;
    // The link releases its target when it is invalidated, so the block is kept until it has run.
    void (^done)(double) = [[self.done retain] autorelease];
    double target = link.targetTimestamp * 1000;
    [link invalidate];
    if (done) done(target);
}
- (void)dealloc {
    [_done release];
    [super dealloc];
}
@end

// Calls done on the main thread after count refreshes of screen.
static SPFrames *afterFrames(NSScreen *screen, int count, void (^done)(double target)) {
    SPFrames *frames = [[SPFrames new] autorelease];
    frames.left = count;
    frames.done = done;
    // A link retains its target until it is invalidated.
    [[screen displayLinkWithTarget:frames selector:@selector(tick:)]
        addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
    return frames;
}

static void waitFrames(NSScreen *screen, int count) {
    SPFrames *frames = [afterFrames(screen, count, nil) retain];
    eventWait([NSString stringWithFormat:@"the display refreshes %d times", count], ^BOOL { return frames.left == 0; });
    [frames release];
}

// Runs the run loop until the next presentation of view that comes after every earlier presentation request of view. A check that
// a callback did not come is made after this marker, so no check of this file decides by time
// (docs/spec/native-surfaces.md#layout-transaction).
static void untilMarker(WKWebView *view) {
    __block BOOL marked = NO;
    surfaceLayoutAfterPresentation(view, ^{ marked = YES; });
    eventWait(@"the presentation of the view after its earlier presentation requests", ^BOOL { return marked; });
}

// A display that finishes while the layout transaction of the window is open does not end the wait. If a newer
// request extends the transaction that an earlier request opened, the commit of the earlier request fails, and the
// wait ends after the newer request commits.
static void checkSettledWaitsForLayout(NSWindow *window, WKWebView *main) {
    __block int order = 0;
    __block int settledAt = 0;
    surfaceLayoutBegin(window, 101, ^(int allowed) {});
    surfaceLayoutAfterSettled(main.window, surfaceLayoutMainPresentation(main), ^(double displayed, const char *error) {
        check(error == NULL, @"a settled layout has no DOM error");
        settledAt = ++order;
    });
    surfaceLayoutBegin(window, 102, ^(int allowed) {});
    check(!surfaceLayoutCommit(window, 101), @"an older request does not commit an extended layout transaction");
    untilMarker(main);
    check(settledAt == 0, @"a presentation inside the open layout transaction does not end the settled wait");
    check(surfaceLayoutCommit(window, 102), @"the newest request commits the layout transaction");
    int committedAt = ++order;
    eventWait(@"the settled wait ends after the layout transaction commits", ^BOOL { return settledAt != 0; });
    check(settledAt > committedAt,
        [NSString stringWithFormat:@"the settled wait ends after the open layout transaction commits (settled %d, committed %d)",
            settledAt, committedAt]);
}

// A web view that holds the completion of its next presentation until the check releases it.
@interface SPHeldPresentation : WKWebView
@property(nonatomic, copy) void (^held)(void);
@end
@implementation SPHeldPresentation
- (void)_doAfterNextPresentationUpdate:(void (^)(void))completion { self.held = completion; }
- (void)dealloc { [_held release]; [super dealloc]; }
@end

// A shown modal is drawn by its own web view, so the settled wait ends after the modal has presented. A hidden modal
// shows nothing and is not waited for.
static void checkSettledWaitsForModal(NSWindow *window, WKWebView *main, WKWebViewConfiguration *configuration) {
    SPHeldPresentation *modal = [[[SPHeldPresentation alloc] initWithFrame:window.contentView.bounds
        configuration:configuration] autorelease];
    [window.contentView addSubview:modal];
    __block BOOL settled = NO;
    surfaceLayoutAfterSettled(main.window, surfaceLayoutMainPresentation(main), ^(double displayed, const char *error) {
        check(error == NULL, @"the settled wait with a shown modal has no error");
        settled = YES;
    });
    eventWait(@"the settled wait ends or asks the shown modal for its presentation", ^BOOL { return settled || modal.held != nil; });
    check(!settled && modal.held != nil, @"the settled wait does not end before a shown modal has presented");
    if (modal.held) modal.held();
    eventWait(@"the settled wait ends after the shown modal presents", ^BOOL { return settled; });
    check(settled, @"the settled wait ends when the shown modal has presented");

    modal.held = nil;
    modal.hidden = YES;
    settled = NO;
    surfaceLayoutAfterSettled(main.window, surfaceLayoutMainPresentation(main), ^(double displayed, const char *error) {
        check(error == NULL, @"the settled wait with a hidden modal has no error");
        settled = YES;
    });
    eventWait(@"the settled wait with a hidden modal ends", ^BOOL { return settled; });
    check(modal.held == nil, @"the settled wait does not ask a hidden modal for its presentation");
    [modal removeFromSuperview];
}

// Notifies when the document load finishes.
@interface SPLoaded : NSObject <WKNavigationDelegate>
@property BOOL finished;
@end
@implementation SPLoaded
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation { self.finished = YES; }
@end

static WKWebView *page(NSWindow *window, WKWebViewConfiguration *configuration, NSRect frame, NSString *address) {
    WKWebView *view = [[[WKWebView alloc] initWithFrame:frame configuration:configuration] autorelease];
    [window.contentView addSubview:view];
    SPLoaded *loaded = [[SPLoaded new] autorelease];
    view.navigationDelegate = loaded;
    [view loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:address]]];
    eventWait(@"the navigation of the page finishes", ^BOOL { return loaded.finished; });
    view.navigationDelegate = nil;
    return view;
}

static BOOL snapshotShowsMarkerAtX(NSImage *image, CGFloat x) {
    NSRect proposed = NSZeroRect;
    CGImageRef cgImage = [image CGImageForProposedRect:&proposed context:nil hints:nil];
    if (cgImage == NULL || image.size.width <= 0) return NO;
    NSBitmapImageRep *bitmap = [[[NSBitmapImageRep alloc] initWithCGImage:cgImage] autorelease];
    CGFloat scale = bitmap.pixelsWide / image.size.width;
    NSInteger px = (NSInteger)floor(x * scale);
    if (px < 0 || px >= bitmap.pixelsWide) return NO;
    NSInteger markerRows = 0;
    for (NSInteger py = 0; py < bitmap.pixelsHigh; py++) {
        NSColor *color = [[bitmap colorAtX:px y:py] colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
        // WebKit snapshots convert CSS colors when they create the bitmap, so identify the fixture's blue marker by its channel range.
        if (color != nil && color.redComponent < 0.05 && color.greenComponent > 0.35 && color.greenComponent < 0.45
            && color.blueComponent > 0.65 && color.blueComponent < 0.85) markerRows++;
    }
    return markerRows >= (NSInteger)ceil(60 * scale);
}

static BOOL captureFrameHasColorAtPoint(NSData *data, CGFloat x, CGFloat y, double *displayed) {
    if (data.length < sizeof(uint32_t) * 3 + sizeof(double) * 7) return NO;
    uint32_t head[3] = {0};
    double info[7] = {0};
    [data getBytes:head length:sizeof(head)];
    [data getBytes:info range:NSMakeRange(sizeof(head), sizeof(info))];
    if (head[0] == 0 || head[1] == 0 || head[2] < head[0] * 4 || info[4] <= 0 || info[5] <= 0
        || data.length != sizeof(head) + sizeof(info) + (size_t)head[2] * head[1]) return NO;
    if (displayed) *displayed = info[6];
    double scale = info[4] * info[5];
    size_t px = (size_t)floor(info[0] * info[5] + x * scale);
    size_t py = (size_t)floor(info[1] * info[5] + y * scale);
    if (px >= head[0] || py >= head[1]) return NO;
    const uint8_t *pixels = (const uint8_t *)data.bytes + sizeof(head) + sizeof(info);
    const uint8_t *pixel = pixels + py * head[2] + px * 4;
    return abs((int)pixel[2]) <= 3 && abs((int)pixel[1] - 160) <= 3 && abs((int)pixel[0] - 210) <= 3;
}

static BOOL bitmapContainsFirstShowMarker(NSBitmapImageRep *bitmap) {
    if (bitmap == nil) return NO;
    for (NSInteger y = 0; y < bitmap.pixelsHigh; y++) {
        for (NSInteger x = 0; x < bitmap.pixelsWide; x++) {
            NSColor *color = [[bitmap colorAtX:x y:y] colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
            if (color != nil && fabs(color.redComponent) <= 0.03 && fabs(color.greenComponent - 160.0/255) <= 0.03
                && fabs(color.blueComponent - 210.0/255) <= 0.03) return YES;
        }
    }
    return NO;
}

// A joined plugin root webview presents its resized content while its window transaction remains open, then the
// transaction commits and allows the next layout request to start.
static void checkRootViewResizeJoin(WKWebViewConfiguration *configuration) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 520, 400, 200)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    WKWebView *view = page(window, configuration, NSMakeRect(0, 0, 400, 200), @"sptest://app/root-resize");
    [window orderFrontRegardless];
    __block BOOL installed = NO;
    [view evaluateJavaScript:@"document.head.innerHTML='<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}#marker{position:fixed;right:0;top:20px;width:8px;height:80px;background:rgb(0,80,180)}</style>';document.body.innerHTML='<div id=marker></div>'"
        completionHandler:^(id value, NSError *error) {
            check(error == nil, @"the root resize fixture installs a right-anchored marker"); installed = YES;
        }];
    eventWait(@"the root resize fixture installs its marker", ^BOOL { return installed; });
    __block BOOL fixtureStateRead = NO;
    [view evaluateJavaScript:@"({viewport:[innerWidth,innerHeight],marker:(()=>{const r=document.querySelector('#marker').getBoundingClientRect(),s=getComputedStyle(document.querySelector('#marker'));return {rect:[r.x,r.y,r.width,r.height],background:s.backgroundColor}})()})"
        completionHandler:^(id value, NSError *error) {
            NSDictionary *state = [value isKindOfClass:NSDictionary.class] ? value : @{};
            NSDictionary *marker = [state[@"marker"] isKindOfClass:NSDictionary.class] ? state[@"marker"] : @{};
            check(error == nil && [state[@"viewport"] isEqual:@[@400, @200]]
                    && [marker[@"rect"] isEqual:@[@392, @20, @8, @80]]
                    && [marker[@"background"] isEqual:@"rgb(0, 80, 180)"],
                [NSString stringWithFormat:@"the root resize fixture reports its expected viewport and marker geometry (%@, %@)", value, error]);
            fixtureStateRead = YES;
        }];
    eventWait(@"the script reads the state of the root resize fixture", ^BOOL { return fixtureStateRead; });
    __block BOOL initialPresented = NO;
    surfaceLayoutAfterPresentation(view, ^{ initialPresented = YES; });
    eventWait(@"the root view presents", ^BOOL { return initialPresented; });
    __block BOOL initialSnapshotFinished = NO;
    __block BOOL initialPixels = NO;
    WKSnapshotConfiguration *initialSnapshotConfiguration = [[[WKSnapshotConfiguration alloc] init] autorelease];
    [view takeSnapshotWithConfiguration:initialSnapshotConfiguration completionHandler:^(NSImage *image, NSError *error) {
        check(error == nil && image != nil, @"the initial root snapshot completes");
        initialPixels = error == nil && image != nil && snapshotShowsMarkerAtX(image, 396);
        initialSnapshotFinished = YES;
    }];
    eventWait(@"the snapshot of the root view before the resize finishes", ^BOOL { return initialSnapshotFinished; });
    check(initialPixels, @"the initial root snapshot contains the marker at its original right edge");

    __block BOOL presented = NO;
    __block BOOL blockedAtPresentation = NO;
    __block BOOL blockedDuringSnapshot = NO;
    __block BOOL resizedPixels = NO;
    surfaceLayoutBegin(window, 309, ^(int allowed) { check(allowed, @"the root resize transaction starts"); });
    NSRect resizedFrame = view.frame;
    resizedFrame.size.width = 320;
    view.frame = resizedFrame;
    check(surfaceLayoutJoinView(window, 309, view, ^{
        blockedAtPresentation = surfaceLayoutIsPreparing(window);
        __block BOOL snapshotFinished = NO;
        WKSnapshotConfiguration *snapshotConfiguration = [[[WKSnapshotConfiguration alloc] init] autorelease];
        snapshotConfiguration.afterScreenUpdates = NO;
        [view takeSnapshotWithConfiguration:snapshotConfiguration
            completionHandler:^(NSImage *image, NSError *error) {
                check(error == nil && image != nil,
                    [NSString stringWithFormat:@"the joined root snapshot completes before commit (%@)", error]);
                blockedDuringSnapshot = surfaceLayoutIsPreparing(window);
                resizedPixels = error == nil && image != nil && snapshotShowsMarkerAtX(image, 316);
                snapshotFinished = YES;
            }];
        eventWait(@"the snapshot of the resized root view finishes", ^BOOL { return snapshotFinished; });
        presented = YES;
    }), @"the resized root view joins its open layout transaction");
    BOOL deferred = surfaceLayoutCommit(window, 309);
    check(deferred, @"the root resize commit defers until its presentation callback");
    check(surfaceLayoutIsPreparing(window), @"the root resize transaction stays open for resized root pixels");
    if (deferred) eventWait(@"the resized root presents and its transaction commits", ^BOOL {
        return presented && !surfaceLayoutIsPreparing(window);
    });
    surfaceLayoutCancel(window);
    check(blockedAtPresentation, @"the resized root pixels arrive before the transaction commits");
    check(blockedDuringSnapshot, @"the transaction stays open while the resized snapshot completes");
    check(resizedPixels, @"the joined snapshot contains the marker at the resized right edge");
    [window close];
    [window release];
}

// A layout transaction that joins a view waits for the view's presentation before it commits. The transaction of another
// owner does not wait for that commit. An end without presentation (surfaceLayoutAbandonView) releases the deferred
// commit, and a presentation that comes after the abandon is not reported.
static void checkViewJoin(WKWebViewConfiguration *configuration) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 520, 400, 200)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    WKWebView *view = page(window, configuration, NSMakeRect(0, 0, 400, 200), @"sptest://app/view-join");
    [window orderFrontRegardless];
    int otherOwner = 0;
    __block int presented = 0;
    __block BOOL otherStarted = NO;
    check(!surfaceLayoutJoinView(window, 301, view, ^{ presented++; }), @"a view join needs an open transaction of its ticket");
    surfaceLayoutBegin(window, 301, ^(int allowed) {});
    check(surfaceLayoutJoinView(window, 301, view, ^{ presented++; }), @"a view joins the open transaction");
    check(surfaceLayoutViewJoinCount(window) == 1, @"the transaction counts the joined view");
    surfaceLayoutBegin(&otherOwner, 302, ^(int allowed) { otherStarted = allowed; });
    check(otherStarted, @"a transaction of another window starts while the transaction of the window is open");
    BOOL committed = surfaceLayoutCommit(window, 301);
    check(committed, @"the transaction with a joined view commits");
    if (committed) eventWait(@"the joined view presents", ^BOOL { return presented != 0; });
    check(presented == 1, @"the joined view reports its presentation once");
    check(surfaceLayoutCommit(&otherOwner, 302), @"the transaction of the other window commits");

    otherStarted = NO;
    surfaceLayoutBegin(window, 303, ^(int allowed) {});
    check(surfaceLayoutJoinView(window, 303, view, ^{ presented++; }), @"the view joins the next transaction");
    check(surfaceLayoutCommit(window, 303), @"the transaction joined to the view commits");
    surfaceLayoutBegin(&otherOwner, 304, ^(int allowed) { otherStarted = allowed; });
    check(otherStarted, @"a transaction of another window starts while the commit waits for a joined view");
    check(surfaceLayoutAbandonView(window, view), @"the abandon ends the view wait");
    check(!surfaceLayoutAbandonView(window, view), @"a second abandon of the view has no join to end");
    untilMarker(view);
    check(presented == 1, @"a presentation after the abandon is not reported");
    check(surfaceLayoutCommit(&otherOwner, 304), @"the transaction after the abandon commits");

    __block BOOL replacementStarted = NO;
    surfaceLayoutBegin(window, 305, ^(int allowed) { check(allowed, @"the ticket-scoped cancellation fixture starts its original ticket"); });
    check(surfaceLayoutJoinView(window, 305, view, ^{}), @"the ticket-scoped cancellation fixture joins its view");
    check(surfaceLayoutCommit(window, 305), @"the original ticket waits for its joined view");
    surfaceLayoutBegin(window, 306, ^(int allowed) { replacementStarted = allowed; });
    check(!replacementStarted, @"the replacement ticket waits for the original joined view");
    check(surfaceLayoutAbandonView(window, view), @"abandoning the original ticket releases its last join");
    surfaceLayoutCancelTicket(window, 305);
    check(replacementStarted && surfaceLayoutCommit(window, 306),
        @"cancelling the original ticket after abandonment preserves the replacement ticket");

    surfaceLayoutBegin(window, 307, ^(int allowed) { check(allowed, @"the preparation replacement starts its older ticket"); });
    surfaceLayoutBegin(window, 308, ^(int allowed) { check(allowed, @"the preparation replacement starts its newer ticket"); });
    surfaceLayoutCancelTicket(window, 307);
    check(surfaceLayoutCommit(window, 308), @"cancelling a superseded ticket leaves the active preparation open");

    __block BOOL afterActiveCancelStarted = NO;
    __block int canceledJoinPresented = 0;
    surfaceLayoutBegin(window, 309, ^(int allowed) { check(allowed, @"the active ticket cancellation fixture starts"); });
    check(surfaceLayoutJoinView(window, 309, view, ^{ canceledJoinPresented++; }),
        @"the active ticket cancellation fixture joins its view");
    check(surfaceLayoutCommit(window, 309), @"the active ticket cancellation fixture defers its commit");
    surfaceLayoutBegin(&otherOwner, 310, ^(int allowed) { afterActiveCancelStarted = allowed; });
    check(afterActiveCancelStarted, @"another owner does not wait for the joined view of the ticket");
    surfaceLayoutCancelTicket(window, 309);
    check(surfaceLayoutViewJoinCount(window) == 0, @"canceling the exact open ticket releases its joined wait");
    check(surfaceLayoutCommit(&otherOwner, 310), @"the owner after the canceled active ticket commits");
    untilMarker(view);
    check(canceledJoinPresented == 0, @"the canceled active ticket does not report a later presentation");

    // The check leaves no transaction of its owners behind for the next check, whatever its outcome.
    surfaceLayoutCancel(window);
    surfaceLayoutCancel(&otherOwner);
    [window close];
    [window release];
}

// Each window owns its transaction: a cancel of one ticket of a window refuses only that waiting request of the window, and no
// owner waits for another (docs/spec/native-surfaces.md#layout-transaction).
static void checkQueuedTicketCancel(WKWebViewConfiguration *configuration) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 520, 400, 200)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    WKWebView *view = page(window, configuration, NSMakeRect(0, 0, 400, 200), @"sptest://app/ticket-cancel");
    [window orderFrontRegardless];
    int activeOwner = 0, otherOwner = 0;
    __block int canceledAllowed = -1;
    __block BOOL targetTicketStarted = NO;
    __block BOOL otherOwnerStarted = NO;
    surfaceLayoutBegin(&activeOwner, 401, ^(int allowed) { check(allowed, @"the cancellation fixture starts the other owner"); });
    surfaceLayoutBegin(window, 400, ^(int allowed) { check(allowed, @"the cancellation fixture starts its window"); });
    check(surfaceLayoutJoinView(window, 400, view, ^{}), @"the cancellation fixture joins its view");
    check(surfaceLayoutCommit(window, 400), @"the cancellation fixture waits for its joined view");
    surfaceLayoutBegin(window, 402, ^(int allowed) { canceledAllowed = allowed; });
    surfaceLayoutBegin(window, 403, ^(int allowed) { targetTicketStarted = allowed; });
    surfaceLayoutBegin(&otherOwner, 404, ^(int allowed) { otherOwnerStarted = allowed; });
    check(otherOwnerStarted, @"an owner starts at once while other owners hold transactions");
    surfaceLayoutCancelTicket(window, 402);
    check(canceledAllowed == 0, @"canceling a waiting exact ticket resolves that request as denied");
    check(!targetTicketStarted, @"the other waiting ticket of the window waits for the deferred commit of its window");
    check(surfaceLayoutAbandonView(window, view), @"the abandon ends the deferred commit of the window");
    check(targetTicketStarted, @"the preserved ticket of the window starts when its deferred commit ends");
    check(surfaceLayoutCommit(window, 403), @"the preserved ticket of the canceled owner commits");
    check(surfaceLayoutCommit(&activeOwner, 401), @"the other owner commits");
    check(surfaceLayoutCommit(&otherOwner, 404), @"the third owner commits");
    // The check leaves no transaction of its owners behind for the next check, whatever its outcome.
    surfaceLayoutAbandonView(window, view);
    surfaceLayoutCancel(window);
    surfaceLayoutCancel(&activeOwner);
    surfaceLayoutCancel(&otherOwner);
    [window close];
    [window release];
}

// The composition of the real DOM bounds and the native region must keep both bounds during preparation. Controls the
// commit after the display confirmation and also records the frames of the transaction in progress. With pageChange NO the
// page draws nothing and the transaction narrows only the native plane, committed at once: a control that the recording
// delivers the frame of a commit without a drawing of the page at the first refresh after the settled presentation, so a
// failure of the check with the page tells a late composition of the commit and not a late recording (docs/features.md, F752).
static void checkRecordedComposition(WKWebViewConfiguration *configuration, BOOL pageChange) {
    int failed = failures;
    NSString *variant = pageChange ? @"composition" : @"native plane only";
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 120, 400, 200)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    // A window background far from the color of the native plane, so the area that a narrower plane leaves shows in the frames
    // whatever the page or the window draws there.
    if (!pageChange) window.backgroundColor = [NSColor colorWithSRGBRed:1 green:0 blue:0 alpha:1];
    WKWebView *main = page(window, configuration, NSMakeRect(0, 0, 400, 200), @"sptest://app/composition");
    check(sp_window_set_main_webview(window, main), @"the composition fixture registers its main DOM");
    void *surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    check(surface != NULL, @"the composition fixture creates its native surface");
    if (surface == NULL) { [window close]; [window release]; return; }
    webviewSetFrame(surface, 40, 40, 260, 120);
    webviewSetSurfaceHidden(surface, false);
    NSView *region = (NSView *)sp_surface_native_plane(surface);
    region.wantsLayer = YES;
    region.layer.backgroundColor = [NSColor colorWithSRGBRed:25.0/255 green:27.0/255 blue:36.0/255 alpha:1].CGColor;
    __block BOOL loaded = NO;
    [main evaluateJavaScript:@"document.head.innerHTML='<style>body{margin:0;isolation:isolate}body::before{content:\"\";position:fixed;inset:0;z-index:-1;background:rgb(25,27,36);clip-path:path(\"M0,0H400V200H0ZM40,40v120h260v-120Z\")}</style>';"
        "document.body.innerHTML='<div id=box style=\"position:absolute;left:39px;top:39px;width:260px;height:120px;border:1px solid rgb(43,46,61)\"></div>'"
        completionHandler:^(id value, NSError *error) {
            check(error == nil, @"the composition fixture installs its DOM border"); loaded = YES;
        }];
    eventWait(@"the composition fixture installs its DOM border", ^BOOL { return loaded; });
    [window orderFrontRegardless];
    __block double shown = 0;
    surfaceLayoutAfterSettled(main.window, surfaceLayoutMainPresentation(main), ^(double at, const char *error) {
        check(error == NULL, @"the initial composition fixture is presented"); shown = at;
    });
    eventWait(@"the settled wait of the initial composition ends", ^BOOL { return shown != 0; });
    NSString *folder = temporaryFolder(@"soksak-composition-test-");
    char *operationError = NULL;
    BOOL opened = sp_capture_open(window.windowNumber, false, 0, &operationError);
    BOOL started = NO;
    if (opened) {
        free(operationError);
        operationError = NULL;
        started = sp_capture_start(folder.fileSystemRepresentation, false, &operationError);
    }
    check(started, [NSString stringWithFormat:@"the composition recording starts (%s)", operationError == NULL ? "" : operationError]);
    free(operationError);
    if (started) {
        check(sp_capture_wait(0) > 0, @"the composition recording contains its initial frame");
        surfaceLayoutTraceStart();
        surfaceLayoutBegin(window, 107, ^(int allowed) { check(allowed, @"the composition transaction starts"); });
        webviewSetFrame(surface, 40, 40, 250, 120);
        if (pageChange) {
            __block BOOL ready = NO;
            [main evaluateJavaScript:@"document.getElementById('box').style.width='250px'"
                completionHandler:^(id value, NSError *error) {
                    check(error == nil, @"the composition DOM border moves during preparation");
                    surfaceLayoutAfterPresentation(main, ^{ ready = YES; });
                }];
            eventWait(@"the app DOM presents the moved border", ^BOOL { return ready; });
            waitFrames(window.screen, 1);
            __block BOOL clipped = NO;
            [main evaluateJavaScript:@"document.styleSheets[0].cssRules[1].style.clipPath='path(\"M0,0H400V200H0ZM40,40v120h250v-120Z\")'"
                completionHandler:^(id value, NSError *error) {
                    check(error == nil, @"the composition paint clip changes while the native transaction is pending");
                    surfaceLayoutAfterPresentation(main, ^{ clipped = YES; });
                }];
            eventWait(@"the app DOM presents the changed paint clip", ^BOOL { return clipped; });
            waitFrames(window.screen, 5);
        }
        check(surfaceLayoutCommit(window, 107), [NSString stringWithFormat:@"%@: the controlled transaction commits", variant]);
        shown = 0;
        surfaceLayoutAfterSettled(main.window, surfaceLayoutMainPresentation(main), ^(double at, const char *error) {
            check(error == NULL, @"the final composition fixture is presented"); shown = at;
        });
        eventWait(@"the settled wait of the final composition ends", ^BOOL { return shown != 0; });
        int count = sp_capture_stop(shown, 0);
        const char *captureError = sp_capture_error();
        check(count >= 2 && !sp_capture_limited() && captureError[0] == '\0', [NSString stringWithFormat:
            @"%@: the recording includes initial and final frames without truncation or errors "
            "(%d frames, limited %d, stop after %.3f, error %s)", variant, count, sp_capture_limited(), shown, captureError]);
        double timeline[SURFACE_LAYOUT_TRACE_STAGES] = {0};
        check(surfaceLayoutTraceStop(timeline, 1) == 1, @"the composition recording contains its transaction timeline");
        // The capture numbers its frames across the recordings of the process, so the frames of this recording are the
        // files of its folder in their order.
        NSMutableArray<NSString *> *frameNames = [NSMutableArray array];
        for (NSString *name in [NSFileManager.defaultManager contentsOfDirectoryAtPath:folder error:NULL])
            if ([name.pathExtension isEqualToString:@"bgra"]) [frameNames addObject:name];
        [frameNames sortUsingSelector:@selector(compare:)];
        check((int)frameNames.count == count, [NSString stringWithFormat:@"%@: the recording folder holds every recorded frame "
            "(%lu files, %d reported)", variant, (unsigned long)frameNames.count, count]);
        for (int index = 1; index <= (int)frameNames.count; index++) {
            NSData *data = readCaptureFrame([NSData dataWithContentsOfFile:
                [folder stringByAppendingPathComponent:frameNames[index - 1]]]);
            uint32_t head[3] = {0}; double info[7] = {0};
            BOOL valid = data.length >= sizeof(head) + sizeof(info);
            if (valid) {
                [data getBytes:head length:sizeof(head)];
                [data getBytes:info range:NSMakeRange(sizeof(head), sizeof(info))];
                valid = head[0] > 0 && head[1] > 0 && head[2] >= head[0] * 4 &&
                    data.length == sizeof(head) + sizeof(info) + (size_t)head[2] * head[1] &&
                    info[4] > 0 && info[5] > 0;
            }
            check(valid, [NSString stringWithFormat:@"%@ frame %d has complete pixels and metadata", variant, index]);
            if (!valid) continue;
            const uint8_t *pixels = (const uint8_t *)data.bytes + sizeof(head) + sizeof(info);
            double scale = info[4] * info[5];
            BOOL preCommit = index == 1 || info[6] < timeline[3];
            if (!pageChange) {
                // The column at x 295 lies inside the native plane before the commit and outside the narrower plane after it.
                size_t px = (size_t)floor((info[0] + 295) * scale), py = (size_t)floor((info[1] + 100) * scale);
                const uint8_t *rgb = px < head[0] && py < head[1] ? pixels + py * head[2] + px * 4 : NULL;
                BOOL narrowed = rgb != NULL && (abs((int)rgb[2] - 25) > 6 || abs((int)rgb[1] - 27) > 6 || abs((int)rgb[0] - 36) > 6);
                if (preCommit)
                    check(!narrowed, [NSString stringWithFormat:@"%@: a pre-commit frame shows the native plane at x 295", variant]);
                if (index == count)
                    check(narrowed, [NSString stringWithFormat:@"%@: the final frame shows the narrower native plane (x 295 rgb %d,%d,%d, "
                        "display %.3f, committed %.3f)", variant, rgb ? rgb[2] : -1, rgb ? rgb[1] : -1, rgb ? rgb[0] : -1, info[6],
                        timeline[3]]);
                continue;
            }
            BOOL found = NO;
            double borderAt = NAN;
            for (double x = 290; x <= 302 && !found; x += 0.5) {
                BOOL matches = YES;
                for (int offset = -12; offset <= 12; offset += 6) {
                    size_t px = (size_t)floor((info[0] + x) * scale);
                    size_t py = (size_t)floor((info[1] + 100 + offset) * scale);
                    if (px >= head[0] || py >= head[1]) { matches = NO; break; }
                    const uint8_t *rgb = pixels + py * head[2] + px * 4;
                    if (abs((int)rgb[2] - 43) > 3 || abs((int)rgb[1] - 46) > 3 || abs((int)rgb[0] - 61) > 3)
                        matches = NO;
                }
                found = matches;
                if (matches) borderAt = x;
            }
            check(found, [NSString stringWithFormat:@"composition frame %d/%d preserves the right DOM border "
                "(display %.3f, begun %.3f, presented %.3f, committed %.3f)",
                index, count, info[6], timeline[1], timeline[2], timeline[3]]);
            if (preCommit)
                check(borderAt >= 300 && borderAt < 301, [NSString stringWithFormat:
                    @"a pre-commit composition frame retains the initial border (x %.1f)", borderAt]);
            if (index == count)
                check(borderAt >= 290 && borderAt < 291, [NSString stringWithFormat:
                    @"the final composition frame contains the moved border (x %.1f)", borderAt]);
        }
    }
    // The folder of a failing check holds its frames and the status and display time of every callback of the stream
    // (callback-status.jsonl); a passing check removes its folder at once.
    if (failures > failed) keepTemporaryFolder(folder);
    else removeTemporaryFolder(folder);
    sp_surface_close(surface);
    [window close]; [window release];
}

// A commit that follows the presentation callback of its DOM change shows that DOM in the first frame the display presents
// at or after the commit (docs/spec/native-surfaces.md#layout-transaction). No frame is waited for before the commit.
// The column in [from, to] whose pixels in the rows of the box differ from the background of the page, or NAN.
static double borderColumn(NSBitmapImageRep *still, double from, double to) {
    double scale = (double)still.pixelsWide / 400;
    for (double x = from; x <= to; x += 1) {
        BOOL matches = YES;
        for (int offset = -12; offset <= 12; offset += 6) {
            NSColor *color = [[still colorAtX:(NSInteger)floor(x * scale) y:(NSInteger)floor((100 + offset) * scale)]
                colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
            if (color == nil || (fabs(color.redComponent - 33.0/255) < 0.03 && fabs(color.greenComponent - 36.0/255) < 0.03
                && fabs(color.blueComponent - 48.0/255) < 0.03)) matches = NO;
        }
        if (matches) return x;
    }
    return NAN;
}

typedef struct { BOOL done; sp_input_result result; } PointerDone;

static void pointerDone(void *context, sp_input_result result, const sp_input_held *held) {
    PointerDone *state = context;
    state->result = result;
    state->done = YES;
}

// Counts the messages that the page sends after it draws a pointer move. The host starts the presentation wait at each one.
@interface SPCommitDrawn : NSObject <WKScriptMessageHandler>
@property (nonatomic, assign) NSInteger count;
@end
@implementation SPCommitDrawn
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    self.count++;
}
@end

static void ignoreRegionEvent(void *context, const char *json) { (void)context; (void)json; }

// Presents to region a raster of its current device-pixel size in the color of the native plane, as the supplier of an image
// region answers the raster size of a placement. Returns false when the region has no raster size or rejects the raster.
static BOOL presentRegionRaster(void *region, uint64_t raster) {
    double size[3] = {0};
    if (!sp_region_raster(region, size) || size[0] < 1 || size[1] < 1) return NO;
    size_t width = (size_t)size[0], height = (size_t)size[1];
    IOSurfaceRef surface = IOSurfaceCreate((CFDictionaryRef)@{
        (id)kIOSurfaceWidth: @(width), (id)kIOSurfaceHeight: @(height),
        (id)kIOSurfaceBytesPerElement: @4, (id)kIOSurfacePixelFormat: @(kCVPixelFormatType_32BGRA),
    });
    if (!surface) return NO;
    unsigned char nonce[16];
    arc4random_buf(nonce, sizeof nonce);
    IOSurfaceSetValue(surface, CFSTR("soksak.frame"), [NSData dataWithBytes:nonce length:sizeof nonce]);
    IOSurfaceLock(surface, 0, NULL);
    uint8_t *base = IOSurfaceGetBaseAddress(surface);
    size_t stride = IOSurfaceGetBytesPerRow(surface);
    for (size_t y = 0; y < height; y++) {
        for (size_t x = 0; x < width; x++) {
            uint8_t *pixel = base + y * stride + x * 4;
            pixel[0] = 36; pixel[1] = 27; pixel[2] = 25; pixel[3] = 255;
        }
    }
    IOSurfaceUnlock(surface, 0, NULL);
    BOOL presented = sp_region_present(region, IOSurfaceGetID(surface), nonce, width, height, size[2], 1, raster, 1);
    CFRelease(surface);
    return presented;
}

// A drag of the main page through the input path of the host: each move opens a transaction, the page moves its DOM border
// in its pointermove handler, the transaction waits for the presentation of that DOM, commits, and the window after one refresh
// of the screen must show the border beside the native placement of that move. The conditions of the application are added one
// at a time (docs/features.md, F752): ownTab gives the joined tab view a web process of its own, as a plugin view has, and
// rasterRefreshes keeps the transaction open for that many refreshes after the presentation callback of the DOM, as the raster
// wait of the image regions keeps it before the host commits; with imageRegion the surface holds an image region whose raster of
// the new size is presented after those refreshes, inside the transaction, as the raster wait of the host ends at that
// presentation.
static void checkCommitFrame(WKWebViewConfiguration *configuration, NSString *variant, BOOL ownTab, int rasterRefreshes,
    BOOL imageRegion) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 120, 400, 200)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    SPCommitDrawn *drawn = [[SPCommitDrawn new] autorelease];
    [configuration.userContentController addScriptMessageHandler:drawn name:@"commitDrawn"];
    WKWebView *main = page(window, configuration, NSMakeRect(0, 0, 400, 200), @"sptest://app/commit-frame");
    WKWebView *tab = page(window, ownTab ? [[configuration copy] autorelease] : configuration, NSMakeRect(0, 0, 20, 20),
        @"sptest://app/commit-frame-tab");
    __block int tabPresented = 0;
    check(sp_window_set_main_webview(window, main), @"the commit frame fixture registers its main DOM");
    void *surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    check(surface != NULL, @"the commit frame fixture creates its native surface");
    if (surface == NULL) { [window close]; [window release]; return; }
    webviewSetFrame(surface, 40, 40, 260, 120);
    webviewSetSurfaceHidden(surface, false);
    NSView *region = (NSView *)sp_surface_native_plane(surface);
    region.wantsLayer = YES;
    region.layer.backgroundColor = [NSColor colorWithSRGBRed:25.0/255 green:27.0/255 blue:36.0/255 alpha:1].CGColor;
    void *image = imageRegion ? sp_region_create(surface, "commit-frame", ignoreRegionEvent, NULL) : NULL;
    if (imageRegion) {
        check(image != NULL, @"the commit frame image region is created in the surface");
        if (image) sp_region_place(image, 0, 0, 0, 0, true);
        check(image && presentRegionRaster(image, 1), @"the commit frame image region presents its first raster");
    }
    __block BOOL loaded = NO;
    // The page moves its border to the x of each pointer move: the border is the column just right of the surface.
    [main evaluateJavaScript:@"document.head.innerHTML='<style>body{margin:0;isolation:isolate}body::before{content:\"\";position:fixed;inset:0;z-index:-1;background:rgb(25,27,36);clip-path:path(\"M0,0H400V200H0ZM40,40v120h260v-120Z\")}</style>';"
        "document.body.innerHTML='<div id=box style=\"position:absolute;left:39px;top:39px;width:260px;height:120px;border:1px solid rgb(43,46,61)\"></div>';"
        "window.addEventListener('pointermove',function(e){if(e.buttons!==1)return;var w=e.clientX-40;"
        "document.getElementById('box').style.width=w+'px';"
        "document.styleSheets[0].cssRules[1].style.clipPath='path(\"M0,0H400V200H0ZM40,40v120h'+w+'v-120Z\")';"
        "window.webkit.messageHandlers.commitDrawn.postMessage(w);},true);"
        completionHandler:^(id value, NSError *error) {
            check(error == nil, @"the commit frame fixture installs its DOM border"); loaded = YES;
        }];
    eventWait(@"the commit frame fixture installs its DOM border", ^BOOL { return loaded; });
    [window orderFrontRegardless];
    __block double shown = 0;
    surfaceLayoutAfterSettled(main.window, surfaceLayoutMainPresentation(main), ^(double at, const char *error) {
        check(error == NULL, @"the initial commit frame fixture is presented"); shown = at;
    });
    eventWait(@"the settled wait of the initial commit frame fixture ends", ^BOOL { return shown != 0; });
    const char *directory = temporaryFolder(@"soksak-commit-frame-test-").fileSystemRepresentation;
    char *operationError = NULL;
    BOOL opened = sp_capture_open(window.windowNumber, false, 0, &operationError);
    BOOL started = NO;
    if (opened) { free(operationError); operationError = NULL; started = sp_capture_start(directory, false, &operationError); }
    check(started, [NSString stringWithFormat:@"the commit frame recording starts (%s)", operationError == NULL ? "" : operationError]);
    free(operationError);
    check(started && sp_capture_wait(0) > 0, @"the commit frame recording contains its initial frame");
    // The press starts the drag on the main page, left of the surface.
    PointerDone press = {NO, SP_INPUT_REJECTED};
    sp_input_pointer_then(window, SP_INPUT_POINTER_MAIN, 20, 100, 1, 0, 0, 0, 1, pointerDone, &press);
    eventWait(@"the press of the drag is delivered", ^BOOL { return press.done; });
    check(press.result == SP_INPUT_DELIVERED, @"the press of the drag is delivered to the main page");
    double timeline[SURFACE_LAYOUT_TRACE_STAGES] = {0};
    const int moves = 4;
    for (int move = 0; move < moves; move++) {
        double x = 160 + 20 * move;
        uint64_t ticket = 108 + move;
        surfaceLayoutTraceStart();
        surfaceLayoutBegin(window, ticket, ^(int allowed) { check(allowed, @"the commit frame transaction starts"); });
        check(surfaceLayoutJoinView(window, ticket, tab, ^{ tabPresented++; }), @"the commit frame transaction joins the tab view");
        PointerDone drag = {NO, SP_INPUT_REJECTED};
        sp_input_pointer_then(window, SP_INPUT_POINTER_MAIN, x, 100, 2, 0, 0, 0, 1, pointerDone, &drag);
        eventWait(@"the drag move is delivered", ^BOOL { return drag.done; });
        check(drag.result == SP_INPUT_DELIVERED, [NSString stringWithFormat:@"the drag move to x %.0f is delivered", x]);
        webviewSetFrame(surface, 40, 40, x - 40, 120);
        tab.frame = NSMakeRect(0, 0, 20 + move, 20);
        // The page draws the move and posts its message; the presentation wait starts at that message, as the host does.
        eventWait(@"the app DOM draws the moved border", ^BOOL { return drawn.count == move + 1; });
        __block BOOL ready = NO;
        surfaceLayoutAfterPresentation(main, ^{ ready = YES; });
        eventWait(@"the app DOM presents the moved border", ^BOOL { return ready; });
        if (rasterRefreshes > 0) waitFrames(window.screen, rasterRefreshes);
        if (image) check(presentRegionRaster(image, 2 + move), [NSString stringWithFormat:
            @"the image region presents its raster of move %d inside the transaction", move]);
        check(surfaceLayoutCommit(window, ticket), [NSString stringWithFormat:
            @"%@: the commit frame transaction commits after the presentation callback", variant]);
        eventWait(@"the joined tab view presents before the move is read", ^BOOL { return tabPresented == move + 1; });
        // The trace keeps running until the still is taken, so the send of a commit that was nested in another transaction is
        // recorded even when it comes after the refresh.
        // The commit reaches the screen at the first refresh after it, so the screen is read at that refresh.
        SPFrames *refreshes = [afterFrames(window.screen, 1, nil) retain];
        eventWait(@"the display refreshes once after the commit", ^BOOL { return refreshes.left == 0; });
        [refreshes release];
        NSString *stillPath = [[NSString stringWithUTF8String:directory] stringByAppendingPathComponent:
            [NSString stringWithFormat:@"after-move-%d.png", move]];
        char *stillError = NULL;
        double stillRequested = CACurrentMediaTime() * 1000;
        BOOL captured = sp_capture_still((long[]){window.windowNumber}, 1, stillPath.fileSystemRepresentation, 0, &stillError);
        double stillCompleted = CACurrentMediaTime() * 1000;
        check(surfaceLayoutTraceStop(timeline, SURFACE_LAYOUT_TRACE_STAGES) == 1, @"the commit frame trace records its transaction");
        check(captured && stillError == NULL, [NSString stringWithFormat:@"the window is captured after move %d (%s)", move,
            stillError == NULL ? "no error" : stillError]);
        free(stillError);
        NSBitmapImageRep *after = captured ? [NSBitmapImageRep imageRepWithData:[NSData dataWithContentsOfFile:stillPath]] : nil;
        check(after != nil, [NSString stringWithFormat:@"the still after move %d decodes", move]);
        if (after != nil) {
            double borderAt = borderColumn(after, x, x);
            check(!isnan(borderAt) && fabs(borderAt - x) < 0.5, [NSString stringWithFormat:
                @"%@: after move %d the window shows the moved DOM border beside the native placement (expected x %.0f, found %.1f, "
                "begun %.3f, presented %.3f, committed %.3f, flushed %.3f, still requested %.3f, completed %.3f)", variant, move, x,
                borderAt, timeline[1], timeline[2], timeline[3], timeline[7], stillRequested, stillCompleted]);
        }
    }
    PointerDone release = {NO, SP_INPUT_REJECTED};
    sp_input_pointer_then(window, SP_INPUT_POINTER_MAIN, 220, 100, 3, 0, 0, 0, 1, pointerDone, &release);
    eventWait(@"the release of the drag is delivered", ^BOOL { return release.done; });
    check(release.result == SP_INPUT_DELIVERED, [NSString stringWithFormat:@"%@: the release of the drag is delivered to the main page "
        "(result %d)", variant, (int)release.result]);
    int count = sp_capture_stop(timeline[3], 0);
    const char *captureError = sp_capture_error();
    check(count >= 1 && !sp_capture_limited() && captureError[0] == '\0', [NSString stringWithFormat:
        @"the commit frame recording stops without dropped frames or errors (%d frames, limited %d, error %s)",
        count, sp_capture_limited(), captureError]);
    [configuration.userContentController removeScriptMessageHandlerForName:@"commitDrawn"];
    if (image) sp_region_close(image);
    sp_surface_close(surface);
    [window close]; [window release];
}


// A loaded root webview stays unpublished while its initially hidden surface is prepared, then appears at its placed geometry after commit.
static void checkFirstShowPublication(WKWebViewConfiguration *configuration) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(160, 160, 400, 200)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    WKWebView *main = page(window, configuration, NSMakeRect(0, 0, 400, 200), @"sptest://app/first-show");
    check(sp_window_set_main_webview(window, main), @"the first-show fixture registers its app DOM");
    void *compositionSurface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    check(compositionSurface != NULL, @"the first-show fixture creates the native composition");
    if (compositionSurface == NULL) { [window close]; [window release]; return; }
    // The root starts with no size as sp_document_create makes it, so its only size change is the frame of its surface.
    // A root loaded at its target size would shrink to the empty surface first, and a read right after the frame would
    // reach the page before the second size does.
    WKWebView *root = page(window, [[configuration copy] autorelease], NSZeroRect, @"sptest://plugin/first-show");
    __block BOOL markerLoaded = NO;
    [root evaluateJavaScript:@"document.documentElement.style.cssText='margin:0;width:100%;height:100%';"
        "document.body.style.cssText='margin:0;width:100%;height:100%';"
        "document.body.innerHTML='<div style=\"position:absolute;left:20px;top:20px;width:40px;height:40px;"
        "background:rgb(0,160,210)\"></div>'"
        completionHandler:^(id value, NSError *error) {
            check(error == nil, @"the first-show marker loads before its surface is revealed"); markerLoaded = YES;
        }];
    eventWait(@"the first-show marker loads", ^BOOL { return markerLoaded; });
    check(SPPlaceSurfaceView(compositionSurface, root), @"the first-show root is placed in its hidden surface");
    webviewSetFrame(compositionSurface, 40, 40, 180, 100);
    __block BOOL fixtureStateRead = NO;
    [root evaluateJavaScript:@"({viewport:[innerWidth,innerHeight],marker:(()=>{const r=document.querySelector('div').getBoundingClientRect();"
        "return {rect:[r.x,r.y,r.width,r.height],background:getComputedStyle(document.querySelector('div')).backgroundColor}})()})"
        completionHandler:^(id value, NSError *error) {
            NSDictionary *state = [value isKindOfClass:NSDictionary.class] ? value : @{};
            NSDictionary *marker = [state[@"marker"] isKindOfClass:NSDictionary.class] ? state[@"marker"] : @{};
            check(error == nil && [state[@"viewport"] isEqual:@[@180, @100]]
                    && [marker[@"rect"] isEqual:@[@20, @20, @40, @40]]
                    && [marker[@"background"] isEqual:@"rgb(0, 160, 210)"],
                [NSString stringWithFormat:@"the hidden root reports its target viewport and marker geometry (%@, %@)", value, error]);
            fixtureStateRead = YES;
        }];
    eventWait(@"the script reads the state of the first-show fixture", ^BOOL { return fixtureStateRead; });
    [window makeFirstResponder:main];
    check(window.firstResponder == main, @"the app DOM owns keyboard focus before the first show");
    [window orderFrontRegardless];
    __block double shown = 0;
    surfaceLayoutAfterSettled(main.window, surfaceLayoutMainPresentation(main), ^(double at, const char *error) {
        check(error == NULL, @"the first-show baseline is presented"); shown = at;
    });
    eventWait(@"the settled wait of the first-show baseline ends", ^BOOL { return shown != 0; });
    const char *directory = temporaryFolder(@"soksak-first-show-test-").fileSystemRepresentation;
    char *operationError = NULL;
    BOOL opened = sp_capture_open(window.windowNumber, false, 0, &operationError);
    BOOL started = NO;
    if (opened) { free(operationError); operationError = NULL; started = sp_capture_start(directory, false, &operationError); }
    check(started, [NSString stringWithFormat:@"the first-show recording starts (%s)", operationError == NULL ? "" : operationError]);
    free(operationError);
    if (started) {
        check(sp_capture_wait(0) > 0, @"the hidden-root recording contains its initial frame");
        surfaceLayoutTraceStart();
        __block BOOL prepared = NO;
        surfaceLayoutBegin(window, 108, ^(int allowed) { prepared = allowed != 0; });
        check(prepared, @"the first-show layout transaction starts");
        webviewSetFrame(compositionSurface, 40, 40, 180, 100);
        webviewSetSurfaceHidden(compositionSurface, false);
        check(!((NSView *)root.superview).hidden && !root.hidden,
            @"the first-show root is made visible during preparation");
        check(window.firstResponder == main,
            @"the first show does not take keyboard focus from the app DOM");
        __block BOOL rootPresented = NO;
        check(surfaceLayoutJoinView(window, 108, root, ^{ rootPresented = YES; }),
            @"the first-show root joins its open layout transaction");
        __block BOOL appDOMBarrierPending = YES;
        __block BOOL appDOMPresented = NO;
        surfaceLayoutAfterPresentation(main, ^{ appDOMPresented = YES; });
        eventWait(@"the root view and the app DOM present", ^BOOL { return rootPresented && appDOMPresented; });
        untilMarker(main);
        check(appDOMBarrierPending && surfaceLayoutIsPreparing(window),
            @"the controlled app-DOM barrier remains pending after both presentation callbacks");
        check(window.firstResponder == main,
            @"root presentation while the app-DOM barrier is pending keeps the existing keyboard owner");
        NSString *pendingStillPath = [[NSString stringWithUTF8String:directory] stringByAppendingPathComponent:@"pending.png"];
        char *stillError = NULL;
        BOOL stillCaptured = sp_capture_still((long[]){window.windowNumber}, 1, pendingStillPath.fileSystemRepresentation, 0, &stillError);
        check(stillCaptured, [NSString stringWithFormat:@"the pending first-show window is captured (%s)",
            stillError == NULL ? "no error" : stillError]);
        free(stillError);
        if (stillCaptured) {
            NSBitmapImageRep *pendingBitmap = [NSBitmapImageRep imageRepWithData:
                [NSData dataWithContentsOfFile:pendingStillPath]];
            check(pendingBitmap != nil && !bitmapContainsFirstShowMarker(pendingBitmap),
                @"the actual pending SCK image contains no pixels from the hidden root marker");
        }
        appDOMBarrierPending = NO;
        check(surfaceLayoutCommit(window, 108), @"the first-show transaction commits after both presentation barriers");
        shown = 0;
        surfaceLayoutAfterSettled(main.window, surfaceLayoutMainPresentation(main), ^(double at, const char *error) {
            check(error == NULL, @"the first-show marker is displayed after commit"); shown = at;
        });
        eventWait(@"the settled wait after the first-show commit ends", ^BOOL { return shown != 0; });
        int count = sp_capture_stop(shown, 0);
        const char *captureError = sp_capture_error();
        check(count >= 2 && !sp_capture_limited() && captureError[0] == '\0',
            [NSString stringWithFormat:@"the first-show recording completes without dropped frames or errors "
                "(%d frames, limited %d, error %s)", count, sp_capture_limited(), captureError ?: ""]);
        double timeline[SURFACE_LAYOUT_TRACE_STAGES] = {0};
        check(surfaceLayoutTraceStop(timeline, 1) == 1 && timeline[0] == 108 && timeline[1] <= timeline[2]
                && timeline[2] <= timeline[3],
            @"the first-show trace orders begin, app-DOM presentation, and commit");
        BOOL precommitFrame = NO;
        BOOL precommitMarkerAbsent = YES;
        BOOL postcommitFrame = NO;
        BOOL finalMarkerPresent = NO;
        NSError *listingError = nil;
        NSArray<NSString *> *contents = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:
            [NSString stringWithUTF8String:directory] error:&listingError];
        NSMutableArray<NSString *> *frameNames = [NSMutableArray array];
        for (NSString *name in contents) if ([name.pathExtension isEqualToString:@"bgra"]) [frameNames addObject:name];
        [frameNames sortUsingSelector:@selector(compare:)];
        check(listingError == nil && (int)frameNames.count == count,
            [NSString stringWithFormat:@"the first-show directory contains every recorded frame (%lu files, %d reported, %@)",
                (unsigned long)frameNames.count, count, listingError]);
        for (NSUInteger index = 0; index < frameNames.count; index++) {
            NSString *path = [[NSString stringWithUTF8String:directory] stringByAppendingPathComponent:frameNames[index]];
            NSData *data = readCaptureFrame([NSData dataWithContentsOfFile:path]);
            check(data != nil, [NSString stringWithFormat:@"first-show frame %@ decodes completely", frameNames[index]]);
            double display = 0;
            BOOL marker = data != nil && captureFrameHasColorAtPoint(data, 70, 70, &display);
            if (display < timeline[3]) {
                precommitFrame = YES;
                if (marker) precommitMarkerAbsent = NO;
            }
            if (display >= timeline[3]) postcommitFrame = YES;
            if (index + 1 == frameNames.count) finalMarkerPresent = marker;
        }
        check(precommitFrame, @"the recording contains a decoded frame before commit");
        check(precommitMarkerAbsent, @"the first-show marker remains unpublished in every recorded pre-commit frame");
        check(postcommitFrame && finalMarkerPresent,
            @"the final post-commit frame contains the first-show marker at its declared geometry");
    }
    sp_surface_unplace_view(root);
    [root removeFromSuperview];
    sp_surface_close(compositionSurface);
    [window close]; [window release];
}

typedef struct {
    NSTimeInterval took;
    BOOL heldAtEnd;
    double requested;
    double finished;
    double displayed;
    double nextRefresh;
} SPWait;

// Holds the web process of busy in a synchronous request that the scheme holds, resizes the main webview, and returns the
// time until the display wait ends, whether busy was still held when that wait ended, and the target time of the refresh
// after the one that ended the wait. The result is decided by order, so it does not depend on machine load. A wait that
// busy does not own ends while busy is held, and the request is answered when the wait ends. When busy owns the wait
// (ownsWait), the wait cannot end while busy is held, so the request is answered at a later event after which a wait that
// did not need busy would have ended: probe, a web view that is not held, presents after the wait started, a block of the
// main queue sent then runs after the blocks that the presentations of that update sent, and the screen refreshes twice
// after it, which is after the refresh at which such a wait ends.
static SPWait waitWhileBusy(WKWebView *main, WKWebView *busy, SPPageScheme *scheme, BOOL ownsWait, WKWebView *probe) {
    __block BOOL released = NO;
    __block BOOL presented = NO;
    [busy evaluateJavaScript:@"{const request = new XMLHttpRequest(); request.open('GET', '/hold', false); request.send();} true"
        completionHandler:^(id value, NSError *error) { (void)value; (void)error; released = YES; }];
    eventWait(@"the busy script holds its web process in its synchronous request", ^BOOL { return scheme.held != nil; });
    NSRect frame = main.frame;
    frame.size.width -= 1;
    main.frame = frame;
    __block NSTimeInterval took = 0;
    __block double displayed = 0;
    __block double finished = 0;
    __block double nextRefresh = 0;
    __block BOOL heldAtEnd = NO;
    // The request, completion, and display times are all measured with the same clock (CACurrentMediaTime).
    double requested = CACurrentMediaTime() * 1000;
    surfaceLayoutAfterSettled(main.window, surfaceLayoutMainPresentation(main), ^(double at, const char *error) {
        check(error == NULL, @"a displayed frame has no DOM error");
        finished = CACurrentMediaTime() * 1000;
        took = (finished - requested) / 1000;
        displayed = at;
        heldAtEnd = scheme.held != nil;
        presented = YES;
        afterFrames(main.window.screen ?: NSScreen.mainScreen, 1, ^(double target) { nextRefresh = target; });
    });
    if (ownsWait) {
        __block BOOL later = NO;
        [probe _doAfterNextPresentationUpdate:^{
            dispatch_async(dispatch_get_main_queue(), ^{
                afterFrames(main.window.screen ?: NSScreen.mainScreen, 2, ^(double target) { (void)target; later = YES; });
            });
        }];
        eventWait(@"two refreshes after a later presentation of a document that is not held", ^BOOL { return later; });
    } else {
        eventWait(@"the settled wait ends while the busy script is held", ^BOOL { return presented; });
    }
    [scheme answerHeld];
    eventWait(@"the busy script ends and the settled wait ends", ^BOOL { return presented && released && nextRefresh != 0; });
    return (SPWait){ took, heldAtEnd, requested, finished, displayed, nextRefresh };
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 120, 600, 300)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    SPPageScheme *scheme = [[SPPageScheme new] autorelease];
    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration new] autorelease];
    [configuration setURLSchemeHandler:scheme forURLScheme:@"sptest"];
    // Creates documents of the same origin as separate configurations so that each webview uses its own web process.
    WKWebView *main = page(window, configuration, NSMakeRect(0, 0, 200, 300), @"sptest://app/main");
    WKWebView *sameOrigin = page(window, [[configuration copy] autorelease], NSMakeRect(200, 0, 200, 300), @"sptest://app/document");
    WKWebView *external = page(window, [[configuration copy] autorelease], NSMakeRect(400, 0, 200, 300), @"sptest://external/page");
    // A document lives inside a surface of the composition and never directly in the content view.
    NSView *composition = [[[NSView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:composition];
    [composition addSubview:sameOrigin];
    [composition addSubview:external];
    [window orderBack:nil];
    __block BOOL painted = NO;
    [main _doAfterNextPresentationUpdate:^{ painted = YES; }];
    eventWait(@"the main page presents", ^BOOL { return painted; });

    checkRecordedComposition([[configuration copy] autorelease], YES);
    checkRecordedComposition([[configuration copy] autorelease], NO);
    checkCommitFrame([[configuration copy] autorelease], @"tab of the main process", NO, 0, NO);
    checkCommitFrame([[configuration copy] autorelease], @"tab of its own process", YES, 0, NO);
    checkCommitFrame([[configuration copy] autorelease], @"tab of its own process, two refreshes of raster wait", YES, 2, NO);
    checkCommitFrame([[configuration copy] autorelease], @"tab of its own process, an image region raster after two refreshes",
        YES, 2, YES);
    checkFirstShowPublication([[configuration copy] autorelease]);
    checkSettledWaitsForLayout(window, main);
    checkSettledWaitsForModal(window, main, [[configuration copy] autorelease]);
    checkViewJoin([[configuration copy] autorelease]);
    checkQueuedTicketCancel([[configuration copy] autorelease]);
    checkRootViewResizeJoin([[configuration copy] autorelease]);

    // In an open transaction, the new layout confirmation of the web process must also complete before the wait can
    // occur before the commit. The diagnostic trace records the start of this transaction, the app DOM display
    // confirmation, and the commit time on the same clock as the recorded frames.
    surfaceLayoutTraceStart();
    double traceBegan = CACurrentMediaTime() * 1000;
    __block BOOL prepared = NO;
    __block BOOL mainReady = NO;
    surfaceLayoutBegin(window, 103, ^(int allowed) { prepared = allowed; });
    check(prepared, @"a presentation preparation starts");
    sameOrigin.frame = NSMakeRect(180, 0, 220, 300);
    [main evaluateJavaScript:@"document.body.style.width='180px'" completionHandler:^(id value, NSError *error) {
        check(error == nil, @"the main DOM changes during preparation");
        surfaceLayoutAfterPresentation(main, ^{ mainReady = YES; });
    }];
    eventWait(@"the app DOM presents its new layout", ^BOOL { return mainReady; });
    check(surfaceLayoutCommit(window, 103), @"the app DOM confirms its new layout before native commit");
    // The commit of the hold sends nothing to the render server while another transaction of the thread is open; the flush
    // sends the transaction that carries it.
    [CATransaction flush];
    double traceEnded = CACurrentMediaTime() * 1000;
    double trace[4 * SURFACE_LAYOUT_TRACE_STAGES];
    size_t traced = surfaceLayoutTraceStop(trace, 4);
    check(traced == 1 && trace[0] == 103 && traceBegan <= trace[1] && trace[1] <= trace[4] && trace[4] <= trace[2] &&
        trace[2] <= trace[3] && trace[3] <= traceEnded,
        [NSString stringWithFormat:@"the trace records ticket 103 begun <= requested <= presented <= committed within the "
            "transaction (%zu records: ticket %.0f, begun %.3f, requested %.3f, presented %.3f, committed %.3f within %.3f..%.3f)",
            traced, trace[0], trace[1], trace[4], trace[2], trace[3], traceBegan, traceEnded]);
    check(traced == 1 && trace[5] == SURFACE_LAYOUT_COMMIT_PRESENT && trace[6] == 0,
        [NSString stringWithFormat:@"the trace names the presentation commit of ticket 103 with no other pair open "
            "(path %.0f, open %.0f)", trace[5], trace[6]]);
    // A commit that is the outermost transaction sends it inside the commit, so its flushed time is not later than the
    // committed time, which is taken when the commit returns.
    check(traced == 1 && trace[2] <= trace[7] && trace[7] <= traceEnded,
        [NSString stringWithFormat:@"the trace records when the transaction that carried the commit of ticket 103 was sent to "
            "the render server, after the presentation and by the flush (presented %.3f, committed %.3f, flushed %.3f, "
            "flush ended %.3f)", trace[2], trace[3], trace[7], traceEnded]);
    surfaceLayoutBegin(window, 104, ^(int allowed) {});
    check(surfaceLayoutCommit(window, 104) && surfaceLayoutTraceStop(trace, 4) == 0,
        @"a stopped trace records nothing");
    surfaceLayoutTraceStart();
    surfaceLayoutBegin(window, 105, ^(int allowed) {});
    check(surfaceLayoutCommit(window, 105), @"the first capacity fixture commits");
    surfaceLayoutBegin(window, 106, ^(int allowed) {});
    check(surfaceLayoutCommit(window, 106), @"the second capacity fixture commits");
    size_t capacityCount = surfaceLayoutTraceStop(trace, 1);
    check(capacityCount == 2, [NSString stringWithFormat:
        @"the trace reports all records when output capacity is exceeded (got %zu, expected 2)", capacityCount]);
    // A layout transaction that commits inside another CATransaction pair of this code records that pair as open.
    surfaceLayoutTraceStart();
    surfaceLayoutBegin(window, 109, ^(int allowed) {});
    surfaceTransactionBegin();
    BOOL nestedCommitted = surfaceLayoutCommit(window, 109);
    double outerClosed = CACurrentMediaTime() * 1000;
    surfaceTransactionCommit();
    [CATransaction flush];
    size_t nestedCount = surfaceLayoutTraceStop(trace, 4);
    check(nestedCommitted && nestedCount == 1 && trace[0] == 109 && trace[5] == SURFACE_LAYOUT_COMMIT_PRESENT && trace[6] == 1,
        [NSString stringWithFormat:@"the trace records one other pair open at a nested commit (%zu records: ticket %.0f, "
            "path %.0f, open %.0f)", nestedCount, trace[0], trace[5], trace[6]]);
    // A nested commit reaches the render server only with the outermost transaction, so its record tells the two apart.
    check(nestedCount == 1 && trace[3] < outerClosed && outerClosed <= trace[7],
        [NSString stringWithFormat:@"the trace records a nested commit as sent to the render server when the outer pair "
            "closes, not at the commit (committed %.3f, outer pair closed at %.3f, flushed %.3f)", trace[3], outerClosed,
            trace[7]]);

    SPWait externalWait = waitWhileBusy(main, external, scheme, NO, nil);
    check(externalWait.heldAtEnd,
        [NSString stringWithFormat:@"a busy external document does not delay the presentation wait (%.3fs)", externalWait.took]);

    SPWait visibleWait = waitWhileBusy(main, sameOrigin, scheme, NO, nil);
    check(visibleWait.heldAtEnd,
        [NSString stringWithFormat:@"a same-origin document does not own the app DOM presentation wait (%.3fs)", visibleWait.took]);
    // The display time is later than the request and is not later than the target time of the first refresh after the wait
    // ended, so it is the refresh that ended the wait. The display time is the target time of a display link tick. If the
    // main thread is late, the tick arrives after its target time, so the display time can precede the completion time.
    // Being later than the completion is not guaranteed.
    check(visibleWait.displayed > visibleWait.requested && visibleWait.displayed <= visibleWait.nextRefresh,
        [NSString stringWithFormat:@"the wait reports the display time of the presented frame (requested %.1fms, finished %.1fms, "
            "displayed %.1fms, next refresh %.1fms)", visibleWait.requested, visibleWait.finished, visibleWait.displayed,
            visibleWait.nextRefresh]);

    sameOrigin.hidden = YES;
    SPWait hiddenWait = waitWhileBusy(main, sameOrigin, scheme, NO, nil);
    check(hiddenWait.heldAtEnd,
        [NSString stringWithFormat:@"a hidden document of the main origin does not delay the wait (%.3fs)", hiddenWait.took]);

    SPWait mainWait = waitWhileBusy(main, main, scheme, YES, external);
    check(!mainWait.heldAtEnd, @"the app DOM must still confirm its own presentation");

    [window close];
    [window release];
    return failures ? 1 : 0;
}}
