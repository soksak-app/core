// Checks that the app DOM presentation wait excludes independent webviews and that a layout transaction can join a
// resized plugin root webview. A busy document must not block the app DOM layout. The check does not activate the app.
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import "surface_layout.h"
#import "capture.h"
#import "support/capture_frame.m"
#import "webview_geometry.h"
#import "window_facts.h"
#import "private/webkit.h"

static const NSTimeInterval kBusy = 3;

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Leaves no recording file even if the process is terminated by a callback timeout.
static NSString *compositionDirectory;
static void cleanupCompositionRecording(void) {
    if (compositionDirectory == nil) return;
    NSError *error = nil;
    if (![[NSFileManager defaultManager] removeItemAtPath:compositionDirectory error:&error])
        fprintf(stderr, "FAIL: composition recording cleanup: %s\n", error.localizedDescription.UTF8String);
    [compositionDirectory release]; compositionDirectory = nil;
}

static void until(BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                               beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    if (!done()) { fprintf(stderr, "FAIL: WebKit did not answer within 10 seconds\n"); exit(1); }
}

// Returns the same empty document for every requested address. The host of the address sets the origin.
@interface SPPageScheme : NSObject <WKURLSchemeHandler>
@end
@implementation SPPageScheme
- (void)webView:(WKWebView *)view startURLSchemeTask:(id<WKURLSchemeTask>)task {
    NSData *body = [@"<!doctype html><body style='margin:0'></body>" dataUsingEncoding:NSUTF8StringEncoding];
    NSURLResponse *response = [[[NSURLResponse alloc] initWithURL:task.request.URL MIMEType:@"text/html"
        expectedContentLength:(NSInteger)body.length textEncodingName:@"utf-8"] autorelease];
    [task didReceiveResponse:response];
    [task didReceiveData:body];
    [task didFinish];
}
- (void)webView:(WKWebView *)view stopURLSchemeTask:(id<WKURLSchemeTask>)task {}
@end

// Receives the message that the busy script has started.
@interface SPBusySignal : NSObject <WKScriptMessageHandler>
@property BOOL started;
@end
@implementation SPBusySignal
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    self.started = YES;
}
@end

// Counts a fixed number of display refreshes.
@interface SPFrames : NSObject
@property int left;
- (void)tick:(CADisplayLink *)link;
@end
@implementation SPFrames
- (void)tick:(CADisplayLink *)link {
    if (--self.left == 0) [link invalidate];
}
@end

static void waitFrames(NSScreen *screen, int count) {
    SPFrames *frames = [[SPFrames new] autorelease];
    frames.left = count;
    [[screen displayLinkWithTarget:frames selector:@selector(tick:)]
        addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
    until(^BOOL { return frames.left == 0; });
}

// A display that finishes while the layout transaction of the window is open does not end the wait. If a newer
// request extends the transaction that an earlier request opened, the commit of the earlier request fails, and the
// wait ends after the newer request commits.
static void checkSettledWaitsForLayout(NSWindow *window, WKWebView *main) {
    __block int order = 0;
    __block int settledAt = 0;
    surfaceLayoutBegin(window, 101, ^(int allowed) {});
    surfaceLayoutAfterSettled(main, ^(double displayed, const char *error) {
        check(error == NULL, @"a settled layout has no DOM error");
        settledAt = ++order;
    });
    surfaceLayoutBegin(window, 102, ^(int allowed) {});
    check(!surfaceLayoutCommit(window, 101), @"an older request does not commit an extended layout transaction");
    waitFrames(window.screen, 5);
    check(surfaceLayoutCommit(window, 102), @"the newest request commits the layout transaction");
    int committedAt = ++order;
    until(^BOOL { return settledAt != 0; });
    check(settledAt > committedAt,
        [NSString stringWithFormat:@"the settled wait ends after the open layout transaction commits (settled %d, committed %d)",
            settledAt, committedAt]);
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
    until(^BOOL { return loaded.finished; });
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
    until(^BOOL { return installed; });
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
    until(^BOOL { return fixtureStateRead; });
    __block BOOL initialPresented = NO;
    surfaceLayoutAfterPresentation(view, ^{ initialPresented = YES; });
    until(^BOOL { return initialPresented; });
    __block BOOL initialSnapshotFinished = NO;
    __block BOOL initialPixels = NO;
    WKSnapshotConfiguration *initialSnapshotConfiguration = [[[WKSnapshotConfiguration alloc] init] autorelease];
    [view takeSnapshotWithConfiguration:initialSnapshotConfiguration completionHandler:^(NSImage *image, NSError *error) {
        check(error == nil && image != nil, @"the initial root snapshot completes");
        initialPixels = error == nil && image != nil && snapshotShowsMarkerAtX(image, 396);
        initialSnapshotFinished = YES;
    }];
    until(^BOOL { return initialSnapshotFinished; });
    check(initialPixels, @"the initial root snapshot contains the marker at its original right edge");

    int otherOwner = 0;
    __block BOOL otherStarted = NO;
    __block BOOL presented = NO;
    __block BOOL blockedAtPresentation = NO;
    __block BOOL blockedDuringSnapshot = NO;
    __block BOOL resizedPixels = NO;
    surfaceLayoutBegin(window, 309, ^(int allowed) { check(allowed, @"the root resize transaction starts"); });
    NSRect resizedFrame = view.frame;
    resizedFrame.size.width = 320;
    view.frame = resizedFrame;
    check(surfaceLayoutJoinView(window, 309, view, ^{
        blockedAtPresentation = !otherStarted;
        __block BOOL snapshotFinished = NO;
        WKSnapshotConfiguration *snapshotConfiguration = [[[WKSnapshotConfiguration alloc] init] autorelease];
        snapshotConfiguration.afterScreenUpdates = NO;
        [view takeSnapshotWithConfiguration:snapshotConfiguration
            completionHandler:^(NSImage *image, NSError *error) {
                check(error == nil && image != nil,
                    [NSString stringWithFormat:@"the joined root snapshot completes before commit (%@)", error]);
                blockedDuringSnapshot = !otherStarted;
                resizedPixels = error == nil && image != nil && snapshotShowsMarkerAtX(image, 316);
                snapshotFinished = YES;
            }];
        until(^BOOL { return snapshotFinished; });
        presented = YES;
    }), @"the resized root view joins its open layout transaction");
    check(surfaceLayoutCommit(window, 309), @"the root resize commit defers until its presentation callback");
    surfaceLayoutBegin(&otherOwner, 310, ^(int allowed) { otherStarted = allowed; });
    check(!otherStarted, @"the next layout request waits for resized root pixels");
    until(^BOOL { return presented && otherStarted; });
    check(blockedAtPresentation, @"the resized root pixels arrive before transaction commit and next request start");
    check(blockedDuringSnapshot, @"the next request remains blocked while the resized snapshot completes");
    check(resizedPixels, @"the joined snapshot contains the marker at the resized right edge");
    check(surfaceLayoutCommit(&otherOwner, 310), @"the layout after the root resize commits");
    [window close];
    [window release];
}

// A layout transaction that joins a view waits for the view's presentation before it commits. The transaction of another
// owner starts only after that commit. An end without presentation (surfaceLayoutAbandonView) releases the deferred
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
    check(surfaceLayoutCommit(window, 301), @"the transaction with a joined view commits");
    check(!otherStarted, @"the next transaction waits for the joined view to present or end");
    until(^BOOL { return presented != 0; });
    check(presented == 1, @"the joined view reports its presentation once");
    check(otherStarted, @"the next transaction starts after the joined view presents");
    check(surfaceLayoutCommit(&otherOwner, 302), @"the next transaction commits");

    otherStarted = NO;
    surfaceLayoutBegin(window, 303, ^(int allowed) {});
    check(surfaceLayoutJoinView(window, 303, view, ^{ presented++; }), @"the view joins the next transaction");
    check(surfaceLayoutCommit(window, 303), @"the transaction joined to the view commits");
    surfaceLayoutBegin(&otherOwner, 304, ^(int allowed) { otherStarted = allowed; });
    check(!otherStarted, @"the next transaction waits for the view before the abandon");
    check(surfaceLayoutAbandonView(window, view), @"the abandon ends the view wait");
    check(otherStarted, @"the next transaction starts after the abandon");
    check(!surfaceLayoutAbandonView(window, view), @"a second abandon of the view has no join to end");
    waitFrames(window.screen, 3);
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
    check(!afterActiveCancelStarted, @"the next owner waits for the active ticket join");
    surfaceLayoutCancelTicket(window, 309);
    check(afterActiveCancelStarted, @"canceling the exact active ticket releases its joined wait");
    check(surfaceLayoutCommit(&otherOwner, 310), @"the owner after the canceled active ticket commits");
    waitFrames(window.screen, 3);
    check(canceledJoinPresented == 0, @"the canceled active ticket does not report a later presentation");

    [window close];
    [window release];
}

static void checkQueuedTicketCancel(void) {
    int activeOwner = 0, targetOwner = 0, otherOwner = 0;
    __block int canceledAllowed = -1;
    __block BOOL targetTicketStarted = NO;
    __block BOOL otherOwnerStarted = NO;
    surfaceLayoutBegin(&activeOwner, 401, ^(int allowed) { check(allowed, @"the queued cancellation fixture starts its blocker"); });
    surfaceLayoutBegin(&targetOwner, 402, ^(int allowed) { canceledAllowed = allowed; });
    surfaceLayoutBegin(&targetOwner, 403, ^(int allowed) { targetTicketStarted = allowed; });
    surfaceLayoutBegin(&otherOwner, 404, ^(int allowed) { otherOwnerStarted = allowed; });
    surfaceLayoutCancelTicket(&targetOwner, 402);
    check(canceledAllowed == 0, @"canceling a queued exact ticket resolves that request as denied");
    check(surfaceLayoutCommit(&activeOwner, 401), @"the queued cancellation fixture releases its blocker");
    check(targetTicketStarted && !otherOwnerStarted,
        @"canceling one queued ticket preserves the other ticket of its owner and the next owner");
    check(surfaceLayoutCommit(&targetOwner, 403), @"the preserved ticket of the canceled owner commits");
    check(otherOwnerStarted, @"the preserved other owner starts after the target ticket commits");
    check(surfaceLayoutCommit(&otherOwner, 404), @"the preserved other owner commits");
}

// The composition of the real DOM bounds and the native region must keep both bounds during preparation. Controls the
// commit after the display confirmation and also records the frames of the transaction in progress.
static void checkRecordedComposition(WKWebViewConfiguration *configuration) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 120, 400, 200)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    WKWebView *main = page(window, configuration, NSMakeRect(0, 0, 400, 200), @"sptest://app/composition");
    check(sp_window_set_main_webview(window, main), @"the composition fixture registers its main DOM");
    void *surface = sp_surface_create(main);
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
    until(^BOOL { return loaded; });
    [window orderFrontRegardless];
    __block double shown = 0;
    surfaceLayoutAfterSettled(main, ^(double at, const char *error) {
        check(error == NULL, @"the initial composition fixture is presented"); shown = at;
    });
    until(^BOOL { return shown != 0; });
    char directory[] = "/tmp/soksak-composition-test-XXXXXX";
    BOOL created = mkdtemp(directory) != NULL;
    check(created, @"the composition recording directory is created");
    if (!created) { sp_surface_close(surface); [window close]; [window release]; return; }
    compositionDirectory = [[NSString stringWithUTF8String:directory] copy];
    char *operationError = NULL;
    BOOL opened = sp_capture_open(window.windowNumber, false, &operationError);
    BOOL started = NO;
    if (opened) { free(operationError); operationError = NULL; started = sp_capture_start(directory, false, &operationError); }
    check(started, [NSString stringWithFormat:@"the composition recording starts (%s)", operationError == NULL ? "" : operationError]);
    free(operationError);
    if (started) {
        check(sp_capture_wait() > 0, @"the composition recording contains its initial frame");
        surfaceLayoutTraceStart();
        surfaceLayoutBegin(window, 107, ^(int allowed) { check(allowed, @"the composition transaction starts"); });
        webviewSetFrame(surface, 40, 40, 250, 120);
        __block BOOL ready = NO;
        [main evaluateJavaScript:@"document.getElementById('box').style.width='250px'"
            completionHandler:^(id value, NSError *error) {
                check(error == nil, @"the composition DOM border moves during preparation");
                surfaceLayoutAfterPresentation(main, ^{ ready = YES; });
            }];
        until(^BOOL { return ready; });
        waitFrames(window.screen, 1);
        __block BOOL clipped = NO;
        [main evaluateJavaScript:@"document.styleSheets[0].cssRules[1].style.clipPath='path(\"M0,0H400V200H0ZM40,40v120h250v-120Z\")'"
            completionHandler:^(id value, NSError *error) {
                check(error == nil, @"the composition paint clip changes while the native transaction is pending");
                surfaceLayoutAfterPresentation(main, ^{ clipped = YES; });
            }];
        until(^BOOL { return clipped; });
        waitFrames(window.screen, 5);
        check(surfaceLayoutCommit(window, 107), @"the controlled composition transaction commits");
        shown = 0;
        surfaceLayoutAfterSettled(main, ^(double at, const char *error) {
            check(error == NULL, @"the final composition fixture is presented"); shown = at;
        });
        until(^BOOL { return shown != 0; });
        int count = sp_capture_stop(shown);
        check(count >= 2 && !sp_capture_limited(), @"the composition recording includes initial and final frames without truncation");
        double timeline[SURFACE_LAYOUT_TRACE_STAGES] = {0};
        check(surfaceLayoutTraceStop(timeline, 1) == 1, @"the composition recording contains its transaction timeline");
        for (int index = 1; index <= count; index++) {
            NSString *path = [[NSString stringWithUTF8String:directory] stringByAppendingPathComponent:
                [NSString stringWithFormat:@"frame-%04d.bgra", index]];
            NSData *data = readCaptureFrame([NSData dataWithContentsOfFile:path]);
            uint32_t head[3] = {0}; double info[7] = {0};
            BOOL valid = data.length >= sizeof(head) + sizeof(info);
            if (valid) {
                [data getBytes:head length:sizeof(head)];
                [data getBytes:info range:NSMakeRange(sizeof(head), sizeof(info))];
                valid = head[0] > 0 && head[1] > 0 && head[2] >= head[0] * 4 &&
                    data.length == sizeof(head) + sizeof(info) + (size_t)head[2] * head[1] &&
                    info[4] > 0 && info[5] > 0;
            }
            check(valid, [NSString stringWithFormat:@"composition frame %d has complete pixels and metadata", index]);
            if (!valid) continue;
            const uint8_t *pixels = (const uint8_t *)data.bytes + sizeof(head) + sizeof(info);
            double scale = info[4] * info[5];
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
            if (index == 1 || info[6] < timeline[3])
                check(borderAt >= 300 && borderAt < 301, [NSString stringWithFormat:
                    @"a pre-commit composition frame retains the initial border (x %.1f)", borderAt]);
            if (index == count)
                check(borderAt >= 290 && borderAt < 291, [NSString stringWithFormat:
                    @"the final composition frame contains the moved border (x %.1f)", borderAt]);
        }
    }
    NSError *cleanupError = nil;
    check([[NSFileManager defaultManager] removeItemAtPath:[NSString stringWithUTF8String:directory] error:&cleanupError],
        [NSString stringWithFormat:@"the composition recording is removed (%@)", cleanupError]);
    if (cleanupError == nil) { [compositionDirectory release]; compositionDirectory = nil; }
    sp_surface_close(surface);
    [window close]; [window release];
}

typedef struct { NSTimeInterval took; BOOL beforeRelease; double requested; double finished; double displayed; } SPWait;

// Holds the web process of busy, resizes the main webview, and returns the time until the display wait ends and
// whether that wait ended before the script of busy ended. The result is decided by order, so it does not depend on
// machine load.
static SPWait waitWhileBusy(WKWebView *main, WKWebView *busy, SPBusySignal *signal) {
    signal.started = NO;
    __block BOOL released = NO;
    __block BOOL presented = NO;
    __block BOOL beforeRelease = NO;
    [busy evaluateJavaScript:[NSString stringWithFormat:
        @"webkit.messageHandlers.busy.postMessage(0); {const end=Date.now()+%d; while(Date.now()<end){}} true",
        (int)(kBusy * 1000)] completionHandler:^(id value, NSError *error) { beforeRelease = presented; released = YES; }];
    until(^BOOL { return signal.started; });
    NSRect frame = main.frame;
    frame.size.width -= 1;
    main.frame = frame;
    NSDate *start = [NSDate date];
    __block NSTimeInterval took = 0;
    __block double displayed = 0;
    __block double finished = 0;
    // The request, completion, and display times are all measured with the same clock (CACurrentMediaTime).
    double requested = CACurrentMediaTime() * 1000;
    surfaceLayoutAfterSettled(main, ^(double at, const char *error) {
        check(error == NULL, @"a displayed frame has no DOM error");
        took = -start.timeIntervalSinceNow;
        finished = CACurrentMediaTime() * 1000;
        displayed = at;
        presented = YES;
    });
    until(^BOOL { return presented && released; });
    return (SPWait){ took, beforeRelease, requested, finished, displayed };
}

int main(void) { @autoreleasepool {
    atexit(cleanupCompositionRecording);
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 120, 600, 300)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    SPPageScheme *scheme = [[SPPageScheme new] autorelease];
    SPBusySignal *signal = [[SPBusySignal new] autorelease];
    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration new] autorelease];
    [configuration setURLSchemeHandler:scheme forURLScheme:@"sptest"];
    [configuration.userContentController addScriptMessageHandler:signal name:@"busy"];
    // Creates documents of the same origin as separate configurations so that each webview uses its own web process.
    WKWebView *main = page(window, configuration, NSMakeRect(0, 0, 200, 300), @"sptest://app/main");
    WKWebView *sameOrigin = page(window, [[configuration copy] autorelease], NSMakeRect(200, 0, 200, 300), @"sptest://app/document");
    WKWebView *external = page(window, [[configuration copy] autorelease], NSMakeRect(400, 0, 200, 300), @"sptest://external/page");
    [window orderBack:nil];
    __block BOOL painted = NO;
    [main _doAfterNextPresentationUpdate:^{ painted = YES; }];
    until(^BOOL { return painted; });

    checkRecordedComposition([[configuration copy] autorelease]);
    checkSettledWaitsForLayout(window, main);
    checkViewJoin([[configuration copy] autorelease]);
    checkQueuedTicketCancel();
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
    until(^BOOL { return mainReady; });
    check(surfaceLayoutCommit(window, 103), @"the app DOM confirms its new layout before native commit");
    double traceEnded = CACurrentMediaTime() * 1000;
    double trace[4 * SURFACE_LAYOUT_TRACE_STAGES];
    size_t traced = surfaceLayoutTraceStop(trace, 4);
    check(traced == 1 && trace[0] == 103 && traceBegan <= trace[1] && trace[1] <= trace[4] && trace[4] <= trace[2] &&
        trace[2] <= trace[3] && trace[3] <= traceEnded,
        [NSString stringWithFormat:@"the trace records ticket 103 begun <= requested <= presented <= committed within the "
            "transaction (%zu records: ticket %.0f, begun %.3f, requested %.3f, presented %.3f, committed %.3f within %.3f..%.3f)",
            traced, trace[0], trace[1], trace[4], trace[2], trace[3], traceBegan, traceEnded]);
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

    SPWait externalWait = waitWhileBusy(main, external, signal);
    check(externalWait.beforeRelease,
        [NSString stringWithFormat:@"a busy external document does not delay the presentation wait (%.3fs)", externalWait.took]);

    SPWait visibleWait = waitWhileBusy(main, sameOrigin, signal);
    check(visibleWait.beforeRelease,
        [NSString stringWithFormat:@"a same-origin document does not own the app DOM presentation wait (%.3fs)", visibleWait.took]);
    // The display time is later than the request and within one display refresh of the moment the wait ended. The
    // display time is the target time of a display link tick. If the main thread is late, the tick arrives after its
    // target time, so the display time can precede the completion time. Being later than the completion is not
    // guaranteed.
    check(visibleWait.displayed > visibleWait.requested && visibleWait.displayed < visibleWait.finished + 100,
        [NSString stringWithFormat:@"the wait reports the display time of the presented frame (requested %.1fms, finished %.1fms, displayed %.1fms)",
            visibleWait.requested, visibleWait.finished, visibleWait.displayed]);

    sameOrigin.hidden = YES;
    SPWait hiddenWait = waitWhileBusy(main, sameOrigin, signal);
    check(hiddenWait.beforeRelease,
        [NSString stringWithFormat:@"a hidden document of the main origin does not delay the wait (%.3fs)", hiddenWait.took]);

    SPWait mainWait = waitWhileBusy(main, main, signal);
    check(!mainWait.beforeRelease, @"the app DOM must still confirm its own presentation");

    [window close];
    [window release];
    return failures ? 1 : 0;
}}
