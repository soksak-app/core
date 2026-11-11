// Judges whether the document of a region is hidden while the region is placed as not visible or its window is covered by
// another window, by the events of the page and not by rates over a fixed time (docs/spec/native-surfaces.md, document
// regions). The page counts the turns of a setTimeout(0) loop and the animation frames it runs, and records each
// visibilitychange with its state and both counts. The check waits for each change, holds each hidden state for display
// refreshes of the screen, and judges that no animation frame ran between a hidden state and the next visible state. The
// timer throttle has no event of WebKit, so its turns are reported and not judged. Every wait ends by its event: the ready
// state of the listener, the load state of the document, the completion handler of a page script, a display refresh and
// NSWindowDidChangeOcclusionStateNotification. The check does not activate the application and does not focus any window:
// the window goes behind every window, as an application that is not active shows one (docs/spec/hosts.md#launch-activation),
// and draws its document regions while covered (sp_document_draw_covered), so windows of a person in front of it change
// nothing; the covering window of the check goes directly above it, and a covered region shows again when the window draws
// covered once more, because the end of a cover shows only in a window that nothing else covers.
#import <Cocoa/Cocoa.h>
#import <Network/Network.h>
#import <QuartzCore/QuartzCore.h>
#import <WebKit/WebKit.h>
#import "support/temporary_folder.h"
#import "document_view.h"
#import "webview_geometry.h"
#import "window_facts.h"

// The display refreshes for which the check holds each hidden state: a shown document runs an animation frame on each.
static const int kHiddenRefreshes = 60;

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    FILE *output = condition ? stdout : stderr;
    fprintf(output, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (fflush(output) != 0) {
        perror("fflush test result");
        failures++;
    }
    if (!condition) failures++;
}

// Ends the wait of the event loop after a callback changed what a wait looks at.
static void wake(void) {
    [NSApp postEvent:[NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0
        timestamp:0 windowNumber:0 context:nil subtype:0 data1:0 data2:0] atStart:NO];
}

// Runs the event loop until done holds. Each callback that a wait depends on calls wake, so the loop waits for events only.
static void until(BOOL (^done)(void)) {
    while (!done()) {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:NSDate.distantFuture
            inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event && event.type != NSEventTypeApplicationDefined) [NSApp sendEvent:event];
    }
}

// The page runs a setTimeout(0) loop and an animation frame loop and records each visibilitychange with its state and the
// turns of both loops; each answer also names the number of changes so far. throttle.change(n) answers the change with
// index n once it happened; throttle.frames(n) answers after n more animation frames.
static NSString *const kPage = @"<!doctype html><title>Throttle</title><body>throttle"
    "<script>window.throttle=(()=>{"
    "const counts={timer:0,frame:0};const changes=[];const waiting=[];"
    "const mark=()=>({state:document.visibilityState,timer:counts.timer,frame:counts.frame,changes:changes.length});"
    "(function timerLoop(){counts.timer++;setTimeout(timerLoop,0);})();"
    "(function frameLoop(){counts.frame++;requestAnimationFrame(frameLoop);})();"
    "document.addEventListener('visibilitychange',()=>{changes.push(mark());"
    "for(const w of waiting.splice(0)){if(changes.length>w.index)w.resolve(changes[w.index]);else waiting.push(w);}});"
    "return{"
    "change:(index)=>new Promise((resolve)=>{if(changes.length>index)resolve(changes[index]);else waiting.push({index,resolve});}),"
    "frames:(n)=>new Promise((resolve)=>{const end=counts.frame+n;"
    "(function next(){if(counts.frame>=end)resolve(mark());else requestAnimationFrame(next);})();}),"
    "};})();"
    "</script></body>";

// An HTTP server that answers every request with the page and closes the connection.
static nw_listener_t serve(void) {
    nw_parameters_t parameters = nw_parameters_create_secure_tcp(NW_PARAMETERS_DISABLE_PROTOCOL, NW_PARAMETERS_DEFAULT_CONFIGURATION);
    nw_parameters_set_local_endpoint(parameters, nw_endpoint_create_host("127.0.0.1", "0"));
    nw_listener_t listener = nw_listener_create(parameters);
    nw_listener_set_queue(listener, dispatch_get_main_queue());
    nw_listener_set_new_connection_handler(listener, ^(nw_connection_t connection) {
        nw_connection_set_queue(connection, dispatch_get_main_queue());
        nw_connection_start(connection);
        nw_connection_receive(connection, 1, 65536, ^(dispatch_data_t content, nw_content_context_t context, bool complete, nw_error_t error) {
            NSData *bytes = [kPage dataUsingEncoding:NSUTF8StringEncoding];
            NSString *head = [NSString stringWithFormat:@"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
                "Content-Length: %lu\r\nConnection: close\r\n\r\n", (unsigned long)bytes.length];
            NSMutableData *response = [[[head dataUsingEncoding:NSUTF8StringEncoding] mutableCopy] autorelease];
            [response appendData:bytes];
            dispatch_data_t out = dispatch_data_create(response.bytes, response.length, dispatch_get_main_queue(), DISPATCH_DATA_DESTRUCTOR_DEFAULT);
            nw_connection_send(connection, out, NW_CONNECTION_FINAL_MESSAGE_CONTEXT, true, ^(nw_error_t sent) {
                nw_connection_cancel(connection);
            });
        });
    });
    __block nw_listener_state_t listenerState = nw_listener_state_invalid;
    nw_listener_set_state_changed_handler(listener, ^(nw_listener_state_t state, nw_error_t error) {
        listenerState = state;
        wake();
    });
    nw_listener_start(listener);
    until(^BOOL { return listenerState == nw_listener_state_ready || listenerState == nw_listener_state_failed
        || listenerState == nw_listener_state_cancelled; });
    check(listenerState == nw_listener_state_ready, @"the test server is ready");
    return listener;
}

// Runs an async function body in the page and returns its answer once its promise settles; a failed script is a failure.
static NSDictionary *callPage(WKWebView *view, NSString *body) {
    __block BOOL done = NO;
    __block id result = nil;
    __block NSError *failure = nil;
    [view callAsyncJavaScript:body arguments:nil inFrame:nil inContentWorld:WKContentWorld.pageWorld
        completionHandler:^(id value, NSError *error) {
            result = [value retain];
            failure = [error retain];
            done = YES;
            wake();
        }];
    until(^BOOL { return done; });
    check(failure == nil && [result isKindOfClass:NSDictionary.class],
        [NSString stringWithFormat:@"the page answers %@ (%@)", body, failure.localizedDescription ?: @"no error"]);
    [failure release];
    if (![result isKindOfClass:NSDictionary.class]) {
        [result release];
        return nil;
    }
    return [result autorelease];
}

// The visibilitychange of the page with the index, once it happened.
static NSDictionary *change(WKWebView *view, long index) {
    return callPage(view, [NSString stringWithFormat:@"return await window.throttle.change(%ld);", index]);
}

// Counts display refreshes of a screen.
@interface SPRefreshes : NSObject
@property int left;
- (void)tick:(CADisplayLink *)link;
@end
@implementation SPRefreshes
- (void)tick:(CADisplayLink *)link {
    if (--self.left == 0) [link invalidate];
    wake();
}
@end

static void waitRefreshes(NSScreen *screen, int count) {
    SPRefreshes *refreshes = [[SPRefreshes new] autorelease];
    refreshes.left = count;
    [[screen displayLinkWithTarget:refreshes selector:@selector(tick:)]
        addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
    until(^BOOL { return refreshes.left == 0; });
}

// Judges one hidden state: the change into it, the change out of it, and the animation frames between them.
static void judgeHidden(NSString *name, NSDictionary *hidden, NSDictionary *visible) {
    check([hidden[@"state"] isEqual:@"hidden"],
        [NSString stringWithFormat:@"a %@ region receives visibilitychange with hidden (%@)", name, hidden[@"state"]]);
    check([visible[@"state"] isEqual:@"visible"],
        [NSString stringWithFormat:@"a %@ region that shows again receives visibilitychange with visible (%@)", name,
            visible[@"state"]]);
    long frames = [visible[@"frame"] longValue] - [hidden[@"frame"] longValue];
    long turns = [visible[@"timer"] longValue] - [hidden[@"timer"] longValue];
    check(hidden != nil && visible != nil && frames == 0,
        [NSString stringWithFormat:@"a %@ region runs no animation frame between its hidden and its visible state (%ld frames)",
            name, frames]);
    // The timer throttle has no event of WebKit, so its turns are reported and not judged.
    printf("%s: %ld timer turns during %d display refreshes while hidden\n", name.UTF8String, turns, kHiddenRefreshes);
    if (fflush(stdout) != 0) {
        perror("fflush measurement");
        failures++;
    }
}

static NSDictionary *latestState;

// Keeps the last load state that the document reports.
static void changed(void *context, const char *json) {
    (void)context;
    NSData *data = [NSData dataWithBytes:json length:strlen(json)];
    [latestState release];
    latestState = [[NSJSONSerialization JSONObjectWithData:data options:0 error:nil] retain];
    wake();
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    nw_listener_t listener = serve();
    NSString *address = [NSString stringWithFormat:@"http://127.0.0.1:%d/throttle", nw_listener_get_port(listener)];

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    main.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [window.contentView addSubview:main];
    __block BOOL windowVisible = NO;
    id occlusion = [NSNotificationCenter.defaultCenter addObserverForName:NSWindowDidChangeOcclusionStateNotification
        object:window queue:nil usingBlock:^(NSNotification *notification) {
            windowVisible = (window.occlusionState & NSWindowOcclusionStateVisible) != 0;
            wake();
        }];
    check(sp_document_draw_covered(window, true), @"the window draws its document regions while covered");
    [window orderBack:nil];
    windowVisible = (window.occlusionState & NSWindowOcclusionStateVisible) != 0;
    void *surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    check(surface != NULL, @"a logical surface is created for the document");
    webviewSetFrame(surface, 0, 0, 500, 400);
    webviewSetSurfaceHidden(surface, false);

    // The store directory is deleted when the test ends.
    NSString *stores = temporaryFolder(@"soksak-document-throttle-");
    void *document = sp_document_create(surface, [stores stringByAppendingPathComponent:@"store"].fileSystemRepresentation,
        NULL, NULL, NULL, NULL, changed, NULL);
    check(document != NULL, @"a document view is created inside the surface");
    if (!document) return 1;
    WKWebView *view = (WKWebView *)document;
    sp_document_place(document, 10, 20, 30, 40, true);
    check(sp_document_load(document, address.UTF8String), @"the local page address is accepted");
    until(^BOOL { return [latestState[@"url"] isEqual:address] && ![latestState[@"loading"] boolValue]; });

    // Shown: the region is visible in a window that draws covered and runs animation frames.
    NSDictionary *shown = callPage(view, @"return await window.throttle.frames(3);");
    check([shown[@"state"] isEqual:@"visible"] && [shown[@"frame"] longValue] >= 3,
        [NSString stringWithFormat:@"the shown document runs animation frames (%@, %@ frames)", shown[@"state"], shown[@"frame"]]);

    // Hidden: the region is placed as not visible while the window draws covered, and shown again after the refreshes.
    // A change of the window before this point, such as its first show, is counted before the first index.
    long next = [shown[@"changes"] longValue];
    sp_document_place(document, 10, 20, 30, 40, false);
    NSDictionary *hidden = change(view, next);
    waitRefreshes(window.screen, kHiddenRefreshes);
    sp_document_place(document, 10, 20, 30, 40, true);
    NSDictionary *placedVisible = change(view, next + 1);
    judgeHidden(@"hidden", hidden, placedVisible);
    NSDictionary *again = callPage(view, @"return await window.throttle.frames(1);");
    check([again[@"state"] isEqual:@"visible"], @"a region that shows again runs animation frames");
    next = [again[@"changes"] longValue];

    // Covered: the window ends drawing covered, another opaque window that this check creates covers it, and after the
    // refreshes the window draws covered again under the cover.
    check(sp_document_draw_covered(window, false), @"the window ends drawing its document regions while covered");
    NSWindow *cover = [[NSWindow alloc] initWithContentRect:NSInsetRect(window.frame, -40, -40)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    [cover setReleasedWhenClosed:NO];
    cover.backgroundColor = NSColor.blackColor;
    [cover orderWindow:NSWindowAbove relativeTo:window.windowNumber];
    until(^BOOL { return !windowVisible; });
    NSDictionary *covered = change(view, next);
    waitRefreshes(window.screen, kHiddenRefreshes);
    check(sp_document_draw_covered(window, true), @"the covered window draws its document regions again");
    NSDictionary *drawnCovered = change(view, next + 1);
    judgeHidden(@"covered", covered, drawnCovered);
    again = callPage(view, @"return await window.throttle.frames(1);");
    check([again[@"state"] isEqual:@"visible"], @"a covered region that draws covered again runs animation frames");
    check(!NSApp.isActive, @"the application stays inactive");

    [NSNotificationCenter.defaultCenter removeObserver:occlusion];
    [cover close];
    [cover release];
    sp_document_close(document);
    sp_surface_close(surface);
    nw_listener_cancel(listener);
    [window close];
    [window release];
    [latestState release];
    latestState = nil;
    printf("%s\n", failures ? "FAIL: document_throttle_test" : "PASS: document_throttle_test");
    return failures ? 1 : 0;
}}
