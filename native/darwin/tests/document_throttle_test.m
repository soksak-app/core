// Measures whether a document region slows down while it is hidden (placed as not visible) or covered by another window.
// The document counts the iterations of a setTimeout(0) loop and the animation frames it runs. Each state is measured for
// three seconds, and the rates are compared with the rates of the shown region (docs/features.md F196.9.1). The check
// does not activate the application and does not focus any window: the covering window is ordered front without activation.
#import <Cocoa/Cocoa.h>
#import <Network/Network.h>
#import <WebKit/WebKit.h>
#import "support/temporary_folder.h"
#import "document_view.h"
#import "webview_geometry.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Runs the application event queue and the run loop for the given time.
static void pump(NSTimeInterval seconds) {
    NSDate *end = [NSDate dateWithTimeIntervalSinceNow:seconds];
    do {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]
            inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event) [NSApp sendEvent:event];
    } while ([end timeIntervalSinceNow] > 0);
}

static void until(NSString *what, BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) pump(0.01);
    if (!done()) { fprintf(stderr, "FAIL: %s within 10 seconds\n", what.UTF8String); exit(1); }
}

// The page runs a setTimeout(0) loop and an animation frame loop, and counts the iterations of each.
static NSString *const kPage = @"<!doctype html><title>Throttle</title><body>throttle"
    "<script>window.counts={timer:0,frame:0};"
    "(function timerLoop(){window.counts.timer++;setTimeout(timerLoop,0);})();"
    "(function frameLoop(){window.counts.frame++;requestAnimationFrame(frameLoop);})();"
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
    __block BOOL ready = NO;
    nw_listener_set_state_changed_handler(listener, ^(nw_listener_state_t state, nw_error_t error) {
        if (state == nw_listener_state_ready) ready = YES;
    });
    nw_listener_start(listener);
    until(@"the test server did not start", ^BOOL { return ready; });
    return listener;
}

static id evaluate(WKWebView *view, NSString *script) {
    __block BOOL done = NO;
    __block id result = nil;
    [view evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
        result = [value retain];
        done = YES;
    }];
    until(@"JavaScript did not answer", ^BOOL { return done; });
    return [result autorelease];
}

// The counts of the page now, or nil when the page has not started its loops.
static NSDictionary *counts(WKWebView *view) {
    NSString *json = [evaluate(view, @"typeof window.counts === 'object' ? JSON.stringify(window.counts) : null") description];
    if (![json isKindOfClass:NSString.class] || [json isEqual:@"<null>"]) return nil;
    return [NSJSONSerialization JSONObjectWithData:[json dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
}

static void changed(void *context, const char *text) {}

typedef struct {
    double timerRate;
    double frameRate;
    NSString *visibility;
} Measurement;

// Measures the rates of the page over three seconds. The rates use the elapsed time that the check measures.
static Measurement measure(NSString *name, WKWebView *view) {
    NSDictionary *first = counts(view);
    NSDate *start = [NSDate date];
    while ([start timeIntervalSinceNow] > -3) pump(0.05);
    NSDate *end = [NSDate date];
    NSDictionary *last = counts(view);
    NSTimeInterval seconds = [end timeIntervalSinceDate:start];
    Measurement result = {0, 0, nil};
    if (first && last) {
        result.timerRate = ([last[@"timer"] doubleValue] - [first[@"timer"] doubleValue]) / seconds;
        result.frameRate = ([last[@"frame"] doubleValue] - [first[@"frame"] doubleValue]) / seconds;
    }
    result.visibility = [evaluate(view, @"document.visibilityState") description];
    printf("%s: timer loop %.1f per second, animation frames %.1f per second over %.2f seconds, document visibility %s\n",
        name.UTF8String, result.timerRate, result.frameRate, seconds, result.visibility.UTF8String);
    return result;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    nw_listener_t listener = serve();
    NSString *address = [NSString stringWithFormat:@"http://127.0.0.1:%d/throttle", nw_listener_get_port(listener)];

    NSWindow *window = [[[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO] autorelease];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    main.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [window.contentView addSubview:main];
    [window orderFrontRegardless];
    void *surface = sp_surface_create(main);
    check(surface != NULL, @"a logical surface is created for the document");
    webviewSetFrame(surface, 0, 0, 500, 400);
    webviewSetSurfaceHidden(surface, false);

    // The store directory is deleted when the test ends.
    NSString *stores = temporaryFolder(@"soksak-document-throttle-");
    void *document = sp_document_create(surface, [stores stringByAppendingPathComponent:@"store"].fileSystemRepresentation,
        NULL, NULL, false, changed, NULL);
    check(document != NULL, @"a document view is created inside the surface");
    WKWebView *view = (WKWebView *)document;
    sp_document_place(document, 10, 20, 30, 40, true);
    check(sp_document_load(document, address.UTF8String), @"the local page address is accepted");
    until(@"the page did not start its loops", ^BOOL { return counts(view) != nil; });

    // Shown: the region is visible in a window that nothing covers.
    Measurement shown = measure(@"shown", view);
    check(window.occlusionState & NSWindowOcclusionStateVisible, @"the window is visible before the shown measurement");
    check(shown.frameRate > 0, [NSString stringWithFormat:@"the shown document runs animation frames (%.1f per second)", shown.frameRate]);

    // Hidden: the region is placed as not visible while the window stays visible.
    sp_document_place(document, 10, 20, 30, 40, false);
    Measurement hidden = measure(@"hidden", view);
    check(hidden.frameRate <= 0.1 * shown.frameRate,
        [NSString stringWithFormat:@"a hidden region runs at most 10%% of the shown animation frame rate (%.1f against %.1f)",
            hidden.frameRate, shown.frameRate]);
    check(hidden.timerRate < shown.timerRate,
        [NSString stringWithFormat:@"a hidden region runs the timer loop slower than shown (%.1f against %.1f)",
            hidden.timerRate, shown.timerRate]);

    // Covered: the region is shown again, and another opaque window that this check creates covers the window.
    sp_document_place(document, 10, 20, 30, 40, true);
    NSWindow *cover = [[[NSWindow alloc] initWithContentRect:NSInsetRect(window.frame, -40, -40)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO] autorelease];
    [cover setReleasedWhenClosed:NO];
    cover.backgroundColor = NSColor.blackColor;
    [cover orderFrontRegardless];
    until(@"the covering window did not occlude the test window",
        ^BOOL { return (window.occlusionState & NSWindowOcclusionStateVisible) == 0; });
    Measurement covered = measure(@"covered", view);
    check(covered.frameRate <= 0.1 * shown.frameRate,
        [NSString stringWithFormat:@"a covered region runs at most 10%% of the shown animation frame rate (%.1f against %.1f)",
            covered.frameRate, shown.frameRate]);
    check(covered.timerRate < shown.timerRate,
        [NSString stringWithFormat:@"a covered region runs the timer loop slower than shown (%.1f against %.1f)",
            covered.timerRate, shown.timerRate]);
    check(!NSApp.isActive, @"the application stays inactive");

    [cover close];
    sp_document_close(document);
    sp_surface_close(surface);
    nw_listener_cancel(listener);
    [window close];
    [window release];
    printf("%s\n", failures ? "FAIL: document_throttle_test" : "PASS: document_throttle_test");
    return failures ? 1 : 0;
}}
