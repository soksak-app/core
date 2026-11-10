// The document streams of a page that a document region restores from the back-forward cache
// (docs/spec/native-surfaces.md#document-streams). A region with both streams on loads page 1 and then page 2 of a local
// site, and goes back. Each page stores a random load identifier when it loads, so the same identifier after going back shows
// that WebKit restored page 1 from its back-forward cache. A proxy in front of the navigation delegate of the region records
// each delegate call of the history move and forwards it. The check requires that each stream sends `reset` for the restored
// document and then its data: the element stream a snapshot, and the request stream the navigation entry and the style sheet
// entry of page 1. It prints the delegate calls, which are what WebKit does and not a contract of the region, and the stream
// messages of the move. The check does not activate the application.
#import <Cocoa/Cocoa.h>
#import <Network/Network.h>
#import <WebKit/WebKit.h>
#import <errno.h>
#import <libproc.h>
#import <signal.h>
#import <string.h>
#import "support/event_wait.h"
#import "support/temporary_folder.h"
#import "document_view.h"
#import "private/webkit.h"
#import "webview_geometry.h"
#import "window_facts.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Waits for the exit of the process pid, which its dispatch source reports on the main queue.
static void awaitExit(pid_t pid) {
    __block BOOL exited = NO;
    dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC, (uintptr_t)pid, DISPATCH_PROC_EXIT,
        dispatch_get_main_queue());
    dispatch_source_set_event_handler(source, ^{ exited = YES; });
    dispatch_resume(source);
    // A process that ended before the registration reports no exit, and a process that does not exist after it has ended.
    if (kill(pid, 0) != 0 && errno == ESRCH) exited = YES;
    eventWait([NSString stringWithFormat:@"the WebContent process %d ends", pid], ^BOOL { return exited; });
    dispatch_source_cancel(source);
    dispatch_release(source);
}

// The navigation delegate calls of the region since the proxy was installed, by selector name.
static NSMutableArray<NSString *> *calls;

// Forwards every message to the navigation delegate of the region and records each navigation delegate call.
@interface RecordingDelegate : NSProxy
@property(nonatomic, assign) id target;
@end

@implementation RecordingDelegate
- (BOOL)respondsToSelector:(SEL)selector {
    return [self.target respondsToSelector:selector];
}
- (NSMethodSignature *)methodSignatureForSelector:(SEL)selector {
    return [self.target methodSignatureForSelector:selector];
}
- (void)forwardInvocation:(NSInvocation *)invocation {
    NSString *name = NSStringFromSelector(invocation.selector);
    if ([name hasPrefix:@"webView:"]) [calls addObject:name];
    [invocation invokeWithTarget:self.target];
}
@end

static NSDictionary *latest;
static WKWebView *view;
static void *document;
static NSMutableSet<NSNumber *> *processes;
// The stream messages of the region in the order they arrived, each {stream, message}.
static NSMutableArray<NSDictionary *> *streamed;

static void changed(void *context, const char *text) {
    NSData *data = [NSData dataWithBytes:text length:strlen(text)];
    [latest release];
    latest = [[NSJSONSerialization JSONObjectWithData:data options:0 error:nil] retain];
    if (view && view._webProcessIdentifier) [processes addObject:@(view._webProcessIdentifier)];
}

static void stream(void *context, const char *text) {
    NSData *data = [NSData dataWithBytes:text length:strlen(text)];
    id message = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if ([message isKindOfClass:NSDictionary.class]) [streamed addObject:message];
    else fprintf(stderr, "FAIL: the stream message is not a JSON object: %s\n", text);
}

static void failStep(NSString *step, NSString *reason) {
    fprintf(stderr, "FAIL: step %s: %s (title=%s loading=%s url=%s)\n", step.UTF8String, reason.UTF8String,
        [latest[@"title"] description].UTF8String, [latest[@"loading"] description].UTF8String, [latest[@"url"] description].UTF8String);
    // The close of the document ends its page; its WebContent processes end with the process of the test.
    if (document) sp_document_close(document);
    document = NULL;
    exit(1);
}

static id evaluate(NSString *script) {
    __block BOOL done = NO;
    __block id result = nil;
    [view evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
        result = [value retain];
        done = YES;
    }];
    eventWait(@"JavaScript answers", ^BOOL { return done; });
    return [result autorelease];
}

// Waits until the region shows the page and has ended loading, and returns the load identifier of the page.
static NSString *waitForPage(NSString *step, int page) {
    NSString *title = [NSString stringWithFormat:@"Page %d", page];
    eventWait([NSString stringWithFormat:@"the region shows %@ at the %@ step", title, step], ^BOOL {
        return [latest[@"title"] isEqual:title] && ![latest[@"loading"] boolValue];
    });
    NSString *identifier = evaluate(@"window.loadId");
    fprintf(stdout, "%s: page %d load identifier %s\n", step.UTF8String, page, identifier.UTF8String);
    return identifier;
}

// The index after the last reset of the stream name from index from on, or from when the stream sent no reset since.
static NSUInteger afterReset(NSString *name, NSUInteger from) {
    NSUInteger start = from;
    for (NSUInteger i = from; i < streamed.count; i++) {
        if ([streamed[i][@"stream"] isEqual:name] && [streamed[i][@"message"][@"type"] isEqual:@"reset"]) start = i + 1;
    }
    return start;
}

// Whether the stream name sent a reset from index from on.
static BOOL resetSince(NSString *name, NSUInteger from) {
    return afterReset(name, from) > from;
}

// The last snapshot of the element stream from index from on, or nil.
static NSDictionary *snapshotSince(NSUInteger from) {
    NSDictionary *found = nil;
    for (NSUInteger i = from; i < streamed.count; i++) {
        if ([streamed[i][@"stream"] isEqual:@"elements"] && [streamed[i][@"message"][@"type"] isEqual:@"snapshot"]) found = streamed[i][@"message"];
    }
    return found;
}

// The URLs of the request entries from index from on, in their order.
static NSArray<NSString *> *entriesSince(NSUInteger from) {
    NSMutableArray<NSString *> *urls = [NSMutableArray array];
    for (NSUInteger i = from; i < streamed.count; i++) {
        if (![streamed[i][@"stream"] isEqual:@"requests"] || ![streamed[i][@"message"][@"type"] isEqual:@"entries"]) continue;
        for (NSDictionary *entry in streamed[i][@"message"][@"entries"]) [urls addObject:entry[@"url"] ?: @""];
    }
    return urls;
}

// Acknowledges the last snapshot from index from on, so the element stream sends the next one.
static void acknowledge(NSString *step, NSUInteger from) {
    NSDictionary *snapshot = snapshotSince(from);
    if (!snapshot) failStep(step, @"the element stream sent no snapshot");
    if (!sp_document_stream_ack(document, [snapshot[@"seq"] unsignedLongLongValue])) {
        failStep(step, [NSString stringWithFormat:@"the acknowledgement of snapshot %@ is refused", snapshot[@"seq"]]);
    }
}

// Waits until the streams sent the data of page since index from: a snapshot and the entries of the page and its style sheet.
static void waitForData(NSString *step, int page, NSString *base, NSUInteger from) {
    NSString *address = [NSString stringWithFormat:@"%@page/%d", base, page];
    NSString *style = [NSString stringWithFormat:@"%@style/%d.css", base, page];
    eventWait([NSString stringWithFormat:@"the streams send the data of page %d at the %@ step", page, step], ^BOOL {
        NSArray<NSString *> *urls = entriesSince(from);
        return snapshotSince(from) && [urls containsObject:address] && [urls containsObject:style];
    });
}

// Prints the stream messages from index from on, one line each.
static void printMessages(NSString *step, NSUInteger from) {
    for (NSUInteger i = from; i < streamed.count; i++) {
        NSDictionary *message = streamed[i][@"message"];
        NSString *detail = @"";
        if ([message[@"type"] isEqual:@"snapshot"]) detail = [NSString stringWithFormat:@" seq %@ total %@", message[@"seq"], message[@"total"]];
        if ([message[@"type"] isEqual:@"entries"]) {
            NSMutableArray<NSString *> *urls = [NSMutableArray array];
            for (NSDictionary *entry in message[@"entries"]) [urls addObject:entry[@"url"] ?: @""];
            detail = [NSString stringWithFormat:@" %@", [urls componentsJoinedByString:@" "]];
        }
        fprintf(stdout, "%s: stream %s %s%s\n", step.UTF8String, [streamed[i][@"stream"] UTF8String], [message[@"type"] UTF8String],
            detail.UTF8String);
    }
}

static void respond(nw_connection_t connection, NSString *request) {
    NSArray<NSString *> *parts = [request componentsSeparatedByString:@" "];
    NSString *path = parts.count >= 2 ? parts[1] : @"";
    int number = 0;
    NSString *status = @"404 Not Found";
    NSString *type = @"text/plain";
    NSString *body = @"";
    if (sscanf(path.UTF8String, "/page/%d", &number) == 1 && (number == 1 || number == 2)) {
        status = @"200 OK";
        type = @"text/html; charset=utf-8";
        body = [NSString stringWithFormat:@"<!doctype html><title>Page %d</title><link rel=\"stylesheet\" href=\"/style/%d.css\">"
            "<body><p>page %d</p><script>window.loadId = String(Math.random());</script></body>", number, number, number];
    } else if (sscanf(path.UTF8String, "/style/%d.css", &number) == 1 && (number == 1 || number == 2)) {
        status = @"200 OK";
        type = @"text/css";
        body = @"p { margin: 0; }";
    }
    NSData *bytes = [body dataUsingEncoding:NSUTF8StringEncoding];
    NSString *head = [NSString stringWithFormat:@"HTTP/1.1 %@\r\nContent-Type: %@\r\nContent-Length: %lu\r\n"
        "Connection: close\r\n\r\n", status, type, (unsigned long)bytes.length];
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
    eventWait(@"the test server starts", ^BOOL { return ready; });
    return server;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    processes = [[NSMutableSet alloc] init];
    streamed = [[NSMutableArray alloc] init];
    calls = [[NSMutableArray alloc] init];

    nw_listener_t listener = serve();
    NSString *base = [NSString stringWithFormat:@"http://127.0.0.1:%d/", nw_listener_get_port(listener)];
    NSString *page1 = [base stringByAppendingString:@"page/1"];
    NSString *page2 = [base stringByAppendingString:@"page/2"];

    // The steps run in their own pool, as each turn of the run loop of the applications does, so the closed document keeps no
    // autoreleased reference after it.
    @autoreleasepool {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    [window orderFrontRegardless];
    void *surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    if (!surface) failStep(@"surface", @"a logical surface is not created");
    webviewSetFrame(surface, 0, 0, 500, 400);
    webviewSetSurfaceHidden(surface, false);

    NSString *storeDirectory = temporaryFolder(@"soksak-document-page-cache-");
    document = sp_document_create(surface, [storeDirectory stringByAppendingPathComponent:@"store"].fileSystemRepresentation,
        NULL, NULL, NULL, NULL, changed, NULL);
    if (!document) failStep(@"create", @"a document view is not created inside the surface");
    view = (WKWebView *)document;
    sp_document_set_stream(document, stream, NULL);
    sp_document_place(document, 10, 20, 30, 40, true);
    // The hosts turn the request stream on at the attach of a region and the element stream at its first subscription.
    check(sp_document_stream_on(document, "requests", true), @"the request stream is turned on");
    check(sp_document_stream_on(document, "elements", true), @"the element stream is turned on");

    sp_document_load(document, page1.UTF8String);
    NSString *first = waitForPage(@"load page 1", 1);
    waitForData(@"load page 1", 1, base, 0);
    acknowledge(@"load page 1", 0);
    NSUInteger second = streamed.count;
    sp_document_load(document, page2.UTF8String);
    waitForPage(@"load page 2", 2);
    waitForData(@"load page 2", 2, base, afterReset(@"requests", second));
    acknowledge(@"load page 2", afterReset(@"elements", second));

    RecordingDelegate *recorder = [RecordingDelegate alloc];
    recorder.target = view.navigationDelegate;
    view.navigationDelegate = (id<WKNavigationDelegate>)recorder;
    NSUInteger mark = streamed.count;
    if (!sp_document_go(document, 0, 0)) failStep(@"back to page 1", @"the history move is refused");
    NSString *restored = waitForPage(@"back to page 1", 1);
    check([restored isEqualToString:first], [NSString stringWithFormat:
        @"the region restores page 1 from the back-forward cache (identifier %@, before %@)", restored, first]);
    NSString *style = [base stringByAppendingString:@"style/1.css"];
    // The checks below judge the reset of each stream; a restored page whose streams send no reset still ends this wait with
    // its data, so the checks find the missing reset.
    eventWait(@"the streams send the data of the restored page 1", ^BOOL {
        NSArray<NSString *> *urls = entriesSince(afterReset(@"requests", mark));
        return snapshotSince(afterReset(@"elements", mark)) && [urls containsObject:page1] && [urls containsObject:style];
    });
    fprintf(stdout, "back to page 1: delegate calls %s\n", [calls componentsJoinedByString:@" "].UTF8String);
    printMessages(@"back to page 1", mark);
    check(resetSince(@"elements", mark) && resetSince(@"requests", mark), @"each stream sends reset for the restored page");
    check(snapshotSince(afterReset(@"elements", mark)) != nil, @"the element stream sends a snapshot of the restored page after its reset");
    NSArray<NSString *> *entries = entriesSince(afterReset(@"requests", mark));
    check([entries containsObject:page1] && [entries containsObject:style], [NSString stringWithFormat:
        @"the request stream sends the navigation and style sheet entries of the restored page after its reset (entries: %@)", entries]);

    view.navigationDelegate = recorder.target;
    [recorder release];
    sp_document_close(document);
    document = NULL;
    view = nil;
    sp_surface_close(surface);
    [window close];
    [window release];
    }
    // The close of the document is the end of its page, so WebKit ends each WebContent process that served the document,
    // the processes of the back-forward cache included.
    for (NSNumber *pid in processes) {
        NSDate *start = [NSDate date];
        awaitExit(pid.intValue);
        struct proc_bsdinfo info;
        BOOL ended = proc_pidinfo(pid.intValue, PROC_PIDTBSDINFO, 0, &info, sizeof info) != (int)sizeof info;
        check(ended, [NSString stringWithFormat:@"the WebContent process %d ends after the document closes (%.3f s)", pid.intValue, -start.timeIntervalSinceNow]);
    }
    nw_listener_cancel(listener);
    printf("%s\n", failures ? "FAIL: document_page_cache_test" : "PASS: document_page_cache_test");
    return failures ? 1 : 0;
}}
