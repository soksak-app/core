// The back-forward cache of a document region (docs/spec/native-surfaces.md#document-regions). A document region navigates
// from page 1 to page 2 of a local site. Each page stores a random load identifier when it loads, so going back shows the same
// identifier when WebKit restores the page from its back-forward cache and a new identifier when it loads the page again.
// The check first requires a restore from the cache, then requires that a region hidden for the hidden clear delay and a
// region under memory pressure clear the cache, record the event native.document.backforward_cleared with its reason, and load
// page 1 again on going back, and that a report of the normal level keeps the cache. The pressure reports come from the fault
// injection of the memory pressure owner (memory_pressure.h). The check does not activate the application.
#import <Cocoa/Cocoa.h>
#import <Network/Network.h>
#import <WebKit/WebKit.h>
#import <errno.h>
#import <signal.h>
#import <string.h>
#import "support/temporary_folder.h"
#import "document_view.h"
#import "event_ring.h"
#import "memory_pressure.h"
#import "private/webkit.h"
#import "support/records.h"
#import "webview_geometry.h"

static const NSTimeInterval stepLimit = 20;
static const double hiddenDelay = 0.5;

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static BOOL pumpUntil(NSTimeInterval limit, BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:limit];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    return done();
}

static NSDictionary *latest;
static WKWebView *view;
static void *document;
static NSMutableSet<NSNumber *> *processes;

static void changed(void *context, const char *text) {
    NSData *data = [NSData dataWithBytes:text length:strlen(text)];
    [latest release];
    latest = [[NSJSONSerialization JSONObjectWithData:data options:0 error:nil] retain];
    if (view && view._webProcessIdentifier) [processes addObject:@(view._webProcessIdentifier)];
}

static void failStep(NSString *step, NSString *reason) {
    fprintf(stderr, "FAIL: step %s: %s (title=%s loading=%s url=%s)\n", step.UTF8String, reason.UTF8String,
        [latest[@"title"] description].UTF8String, [latest[@"loading"] description].UTF8String, [latest[@"url"] description].UTF8String);
    for (NSNumber *pid in processes) kill(pid.intValue, SIGKILL);
    exit(1);
}

static id evaluate(NSString *script) {
    __block BOOL done = NO;
    __block id result = nil;
    [view evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
        result = [value retain];
        done = YES;
    }];
    if (!pumpUntil(10, ^BOOL { return done; })) failStep(@"evaluate", @"JavaScript did not answer within 10 seconds");
    return [result autorelease];
}

// Waits until the region shows the page and has ended loading, and returns the load identifier of the page.
static NSString *waitForPage(NSString *step, int page) {
    NSString *title = [NSString stringWithFormat:@"Page %d", page];
    if (!pumpUntil(stepLimit, ^BOOL { return [latest[@"title"] isEqual:title] && ![latest[@"loading"] boolValue]; })) {
        failStep(step, [NSString stringWithFormat:@"the region did not show %@ within %.0f seconds", title, stepLimit]);
    }
    NSString *identifier = evaluate(@"window.loadId");
    fprintf(stdout, "%s: page %d load identifier %s\n", step.UTF8String, page, identifier.UTF8String);
    return identifier;
}

static void go(NSString *step, int action) {
    if (!sp_document_go(document, action, 0)) failStep(step, @"the history move is refused");
}

// The reasons of the native.document.backforward_cleared events of the list.
static NSArray<NSString *> *clearReasons(NSArray<NSDictionary *> *events) {
    NSMutableArray<NSString *> *reasons = [NSMutableArray array];
    for (NSDictionary *event in events) {
        if (![event[@"name"] isEqualToString:@"native.document.backforward_cleared"]) continue;
        check([event[@"class"] intValue] == SP_CLASS_LIFECYCLE && [event[@"level"] intValue] == SP_EVENT_INFO,
            @"the clear is stored in the lifecycle class at info");
        [reasons addObject:event[@"fields"][@"reason"] ?: @""];
    }
    return reasons;
}

static void respond(nw_connection_t connection, NSString *request) {
    NSArray<NSString *> *parts = [request componentsSeparatedByString:@" "];
    NSString *path = parts.count >= 2 ? parts[1] : @"";
    int number = 0;
    NSString *status = @"404 Not Found";
    NSString *body = @"";
    if (sscanf(path.UTF8String, "/page/%d", &number) == 1 && (number == 1 || number == 2)) {
        status = @"200 OK";
        body = [NSString stringWithFormat:@"<!doctype html><title>Page %d</title><body>page %d"
            "<script>window.loadId = String(Math.random());</script></body>", number, number];
    }
    NSData *bytes = [body dataUsingEncoding:NSUTF8StringEncoding];
    NSString *head = [NSString stringWithFormat:@"HTTP/1.1 %@\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: %lu\r\n"
        "Connection: close\r\n\r\n", status, (unsigned long)bytes.length];
    NSMutableData *response = [NSMutableData dataWithData:[head dataUsingEncoding:NSUTF8StringEncoding]];
    [response appendData:bytes];
    dispatch_data_t out = dispatch_data_create(response.bytes, response.length, dispatch_get_main_queue(), DISPATCH_DATA_DESTRUCTOR_DEFAULT);
    nw_connection_send(connection, out, NW_CONNECTION_FINAL_MESSAGE_CONTEXT, true, ^(nw_error_t sent) {
        nw_connection_cancel(connection);
    });
}

static nw_listener_t serve(void) {
    nw_parameters_t parameters = nw_parameters_create_secure_tcp(NW_PARAMETERS_DISABLE_PROTOCOL, NW_PARAMETERS_DEFAULT_CONFIGURATION);
    nw_parameters_set_local_endpoint(parameters, nw_endpoint_create_host("127.0.0.1", "0"));
    nw_listener_t server = nw_listener_create(parameters);
    nw_listener_set_queue(server, dispatch_get_main_queue());
    nw_listener_set_new_connection_handler(server, ^(nw_connection_t connection) {
        nw_connection_set_queue(connection, dispatch_get_main_queue());
        nw_connection_start(connection);
        nw_connection_receive(connection, 1, 65536, ^(dispatch_data_t content, nw_content_context_t context, bool complete, nw_error_t error) {
            NSString *request = content ? [[[NSString alloc] initWithData:(NSData *)content encoding:NSUTF8StringEncoding] autorelease] : @"";
            respond(connection, request ?: @"");
        });
    });
    __block BOOL ready = NO;
    nw_listener_set_state_changed_handler(server, ^(nw_listener_state_t state, nw_error_t error) {
        if (state == nw_listener_state_ready) ready = YES;
    });
    nw_listener_start(server);
    if (!pumpUntil(10, ^BOOL { return ready; })) {
        fprintf(stderr, "FAIL: the test server did not start within 10 seconds\n");
        exit(1);
    }
    return server;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    const int8_t everything[SP_CLASS_COUNT] = {SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE};
    check(sp_event_set_policy(everything), @"the policy stores every level of every class");
    check(!sp_document_set_hidden_clear_delay(0) && !sp_document_set_hidden_clear_delay(NAN),
        @"a delay that is not a finite positive number is refused");
    check(sp_document_set_hidden_clear_delay(hiddenDelay), @"the hidden clear delay is set");
    processes = [[NSMutableSet alloc] init];
    check(sp_memory_pressure_start(^(const char *level, unsigned long long seq) {}), @"the memory pressure owner starts");

    nw_listener_t listener = serve();
    NSString *base = [NSString stringWithFormat:@"http://127.0.0.1:%d/", nw_listener_get_port(listener)];
    NSString *page1 = [base stringByAppendingString:@"page/1"];
    NSString *page2 = [base stringByAppendingString:@"page/2"];

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    [window orderFrontRegardless];
    void *surface = sp_surface_create(main);
    if (!surface) failStep(@"surface", @"a logical surface is not created");
    webviewSetFrame(surface, 0, 0, 500, 400);
    webviewSetSurfaceHidden(surface, false);

    NSString *storeDirectory = temporaryFolder(@"soksak-document-backforward-");
    document = sp_document_create(surface, [storeDirectory stringByAppendingPathComponent:@"store"].fileSystemRepresentation,
        NULL, NULL, NULL, changed, NULL);
    if (!document) failStep(@"create", @"a document view is not created inside the surface");
    view = (WKWebView *)document;
    sp_document_place(document, 10, 20, 30, 40, true);

    // Control: a shown region restores page 1 from the back-forward cache.
    sp_document_load(document, page1.UTF8String);
    NSString *first = waitForPage(@"load page 1", 1);
    sp_document_load(document, page2.UTF8String);
    waitForPage(@"load page 2", 2);
    go(@"back to page 1", 0);
    NSString *restored = waitForPage(@"back to page 1", 1);
    check([restored isEqualToString:first], [NSString stringWithFormat:
        @"a shown region restores page 1 from the back-forward cache (identifier %@, before %@)", restored, first]);

    // A region hidden for the delay clears the cache.
    go(@"forward to page 2", 1);
    waitForPage(@"forward to page 2", 2);
    NSArray<NSDictionary *> *hiddenEvents = capturedEvents(^{
        sp_document_place(document, 10, 20, 30, 40, false);
        pumpUntil(hiddenDelay * 4, ^BOOL { return NO; });
    });
    NSArray<NSString *> *hiddenReasons = clearReasons(hiddenEvents);
    check([hiddenReasons isEqualToArray:@[ @"hidden" ]], [NSString stringWithFormat:
        @"the region hidden for %.1f seconds records one clear with the reason hidden (%@)", hiddenDelay, hiddenReasons]);
    sp_document_place(document, 10, 20, 30, 40, true);
    go(@"back after hidden", 0);
    NSString *afterHidden = waitForPage(@"back after hidden", 1);
    check(![afterHidden isEqualToString:restored], [NSString stringWithFormat:
        @"going back after the hidden clear loads page 1 again (identifier %@, cached %@)", afterHidden, restored]);

    // A region shown for less than the delay keeps the cache.
    go(@"forward before short hide", 1);
    waitForPage(@"forward before short hide", 2);
    NSArray<NSDictionary *> *shortEvents = capturedEvents(^{
        sp_document_place(document, 10, 20, 30, 40, false);
        pumpUntil(hiddenDelay / 4, ^BOOL { return NO; });
        sp_document_place(document, 10, 20, 30, 40, true);
        pumpUntil(hiddenDelay * 2, ^BOOL { return NO; });
    });
    check(clearReasons(shortEvents).count == 0, @"a region shown again before the delay records no clear");
    go(@"back after short hide", 0);
    NSString *afterShort = waitForPage(@"back after short hide", 1);
    check([afterShort isEqualToString:afterHidden], [NSString stringWithFormat:
        @"a region shown again before the delay restores page 1 from the cache (identifier %@, cached %@)", afterShort, afterHidden]);

    // Memory pressure at warn clears the cache of a shown region.
    go(@"forward before pressure", 1);
    waitForPage(@"forward before pressure", 2);
    NSArray<NSDictionary *> *pressureEvents = capturedEvents(^{
        check(sp_memory_pressure_inject("warn"), @"the warn report is injected");
    });
    NSArray<NSString *> *pressureReasons = clearReasons(pressureEvents);
    check([pressureReasons isEqualToArray:@[ @"pressure" ]], [NSString stringWithFormat:
        @"memory pressure records one clear with the reason pressure (%@)", pressureReasons]);
    go(@"back after pressure", 0);
    NSString *afterPressure = waitForPage(@"back after pressure", 1);
    check(![afterPressure isEqualToString:afterShort], [NSString stringWithFormat:
        @"going back after the pressure clear loads page 1 again (identifier %@, cached %@)", afterPressure, afterShort]);

    // A report of the normal level keeps the cache.
    go(@"forward before normal", 1);
    waitForPage(@"forward before normal", 2);
    NSArray<NSDictionary *> *normalEvents = capturedEvents(^{
        check(sp_memory_pressure_inject("normal"), @"the normal report is injected");
    });
    check(clearReasons(normalEvents).count == 0, [NSString stringWithFormat:
        @"a report of the normal level records no clear (%@)", clearReasons(normalEvents)]);
    go(@"back after normal", 0);
    NSString *afterNormal = waitForPage(@"back after normal", 1);
    check([afterNormal isEqualToString:afterPressure], [NSString stringWithFormat:
        @"going back after the normal report restores page 1 from the cache (identifier %@, cached %@)", afterNormal, afterPressure]);
    check(!NSApp.isActive, @"the application stays inactive");

    sp_document_close(document);
    for (NSNumber *pid in processes) {
        if (kill(pid.intValue, SIGKILL) != 0 && errno != ESRCH) {
            fprintf(stderr, "FAIL: the WebContent process %d cannot be ended: %s\n", pid.intValue, strerror(errno));
            failures++;
        }
    }
    sp_surface_close(surface);
    [window close];
    [window release];
    nw_listener_cancel(listener);
    printf("%s\n", failures ? "FAIL: document_backforward_test" : "PASS: document_backforward_test");
    return failures ? 1 : 0;
}}
