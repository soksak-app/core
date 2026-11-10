// The cost of the document script (docs/spec/native-surfaces.md#document-regions): the physical footprint of the WebContent
// process of a document region and the state reports that the host receives while the page changes a tree of 2000
// elements without pause. The page changes one element in each task. No stream is subscribed, so the region posts no
// element data (docs/spec/native-surfaces.md#document-streams). The benchmark prints the numbers and asserts nothing.
#import <Cocoa/Cocoa.h>
#import <Network/Network.h>
#import <WebKit/WebKit.h>
#import <libproc.h>
#import <string.h>
#import <sys/types.h>
#import "support/event_wait.h"
#import "support/temporary_folder.h"
#import "document_view.h"
#import "private/webkit.h"
#import "webview_geometry.h"
#import "window_facts.h"

// The page builds the tree and exposes runChanges(count), which resolves after count changes. Each change runs in its own
// task through a MessageChannel, because a hidden view throttles timers.
static NSString *const kPage = @"<!doctype html><title>Benchmark</title><body><script>"
    "(() => {"
    "const count = 2000;"
    "const elements = [];"
    "for (let i = 0; i < count; i++) {"
    "  const element = document.createElement('div');"
    "  element.id = 'n' + i;"
    "  document.body.appendChild(element);"
    "  elements.push(element);"
    "}"
    "const channel = new MessageChannel();"
    "window.runChanges = (changes) => new Promise((resolve) => {"
    "  let done = 0;"
    "  channel.port1.onmessage = () => {"
    "    if (done === changes) { resolve(done); return; }"
    "    elements[done % count].setAttribute('class', 'c' + done);"
    "    done++;"
    "    channel.port2.postMessage(null);"
    "  };"
    "  channel.port2.postMessage(null);"
    "});"
    "})();"
    "</script></body>";

// Waits until done() holds, with an autorelease pool for each turn of the run loop: the condition drains the pool of the turn
// before it judges, so the objects that a turn autoreleases are released at its end, as a turn of NSApp run does.
static void waitTurns(NSString *what, BOOL (^done)(void)) {
    __block NSAutoreleasePool *turn = [[NSAutoreleasePool alloc] init];
    eventWait(what, ^BOOL {
        [turn drain];
        turn = [[NSAutoreleasePool alloc] init];
        return done();
    });
    [turn drain];
}

static double nowSeconds(void) {
    return NSDate.date.timeIntervalSince1970;
}

// Waits for a round trip of JavaScript to the WebContent process of the view. The process sends its messages to the host in
// order, so every message that the page posted before the round trip has arrived when its answer arrives.
static void roundTrip(WKWebView *view, NSString *what) {
    __block BOOL answered = NO;
    [view evaluateJavaScript:@"0" completionHandler:^(id value, NSError *error) {
        (void)value;
        (void)error;
        answered = YES;
    }];
    waitTurns(what, ^BOOL { return answered; });
}

// Waits until the process ends. Its exit is a dispatch source of the main queue; a process that ended before the source was
// made gives no event, so a process that cannot be read once the source exists has ended.
static void waitProcessEnd(pid_t process, NSString *what) {
    __block BOOL ended = NO;
    dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC, (uintptr_t)process, DISPATCH_PROC_EXIT,
        dispatch_get_main_queue());
    if (!source) {
        fprintf(stderr, "FAIL: the exit observation of the process %d cannot start\n", process);
        exit(1);
    }
    dispatch_source_set_event_handler(source, ^{ ended = YES; });
    dispatch_resume(source);
    waitTurns(what, ^BOOL {
        struct proc_bsdinfo info;
        return ended || proc_pidinfo(process, PROC_PIDTBSDINFO, 0, &info, sizeof info) != (int)sizeof info;
    });
    dispatch_source_cancel(source);
    dispatch_release(source);
}

// The physical footprint (bytes) of the process, or -1 when the process cannot be read.
static long physicalFootprint(pid_t pid) {
    struct rusage_info_v0 info;
    return proc_pid_rusage(pid, RUSAGE_INFO_V0, (rusage_info_t *)&info) == 0 ? (long)info.ri_phys_footprint : -1;
}

// Reports of the document state, counted when they arrive on the main thread.
static long reports;
static long reportBytes;

static void changed(void *context, const char *text) {
    reports++;
    reportBytes += (long)strlen(text);
}

// Exits with the step and the measured state when a step cannot run.
static void failStep(NSString *step, NSString *reason, WKWebView *view) {
    fprintf(stderr, "FAIL: step %s: %s\n", step.UTF8String, reason.UTF8String);
    fprintf(stderr, "  state: reports=%ld report_bytes=%ld pid=%d footprint=%ld\n", reports, reportBytes,
        view ? view._webProcessIdentifier : 0, view ? physicalFootprint(view._webProcessIdentifier) : -1L);
    exit(1);
}

// Runs one step that changes the page by count changes. Each step reports its start and its end with the elapsed time.
static void runStep(WKWebView *view, long changes) {
    NSString *step = [NSString stringWithFormat:@"runChanges(%ld)", changes];
    fprintf(stdout, "start %s\n", step.UTF8String);
    fflush(stdout);
    double started = nowSeconds();
    __block BOOL finished = NO;
    __block NSError *failure = nil;
    [view callAsyncJavaScript:@"return await window.runChanges(count);" arguments:@{ @"count": @(changes) }
        inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:^(id value, NSError *error) {
        failure = [error retain];
        finished = YES;
    }];
    waitTurns(@"the page finishes the changes", ^BOOL { return finished; });
    if (failure) failStep(step, [NSString stringWithFormat:@"the page script failed: %@", failure.localizedDescription], view);
    // The state reports of the last changes are posted by the page before the round trip that follows them.
    roundTrip(view, @"the state reports of the last changes arrive");
    fprintf(stdout, "end %s elapsed %.3f s\n", step.UTF8String, nowSeconds() - started);
    fflush(stdout);
}

// A sample of the numbers at one total of changes.
typedef struct { long changes; long footprint; long reports; long reportBytes; } Sample;

static Sample measure(WKWebView *view, long changes) {
    pid_t process = view._webProcessIdentifier;
    if (process == 0) failStep(@"measure", @"the document has no WebContent process", view);
    long footprint = physicalFootprint(process);
    if (footprint < 0) failStep(@"measure", @"proc_pid_rusage did not read the WebContent process", view);
    Sample sample = { changes, footprint, reports, reportBytes };
    fprintf(stdout, "changes=%ld footprint_kb=%ld reports=%ld report_bytes=%ld\n", changes, footprint / 1024, reports, reportBytes);
    fflush(stdout);
    return sample;
}

// The listener serves the benchmark page for every request and closes each connection after one response.
static nw_listener_t serve(void) {
    nw_parameters_t parameters = nw_parameters_create_secure_tcp(NW_PARAMETERS_DISABLE_PROTOCOL, NW_PARAMETERS_DEFAULT_CONFIGURATION);
    nw_endpoint_t local = nw_endpoint_create_host("127.0.0.1", "0");
    nw_parameters_set_local_endpoint(parameters, local);
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
    waitTurns(@"the benchmark server is ready", ^BOOL { return ready; });
    return listener;
}

int main(void) { @autoreleasepool {
    double started = nowSeconds();
    fprintf(stdout, "start benchmark\n");
    fflush(stdout);
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    nw_listener_t listener = serve();
    NSString *base = [NSString stringWithFormat:@"http://127.0.0.1:%d/", nw_listener_get_port(listener)];

    // The steps run in their own pool, as each turn of the run loop of the applications does, so the closed document keeps no
    // autoreleased reference after it.
    pid_t process = 0;
    @autoreleasepool {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    main.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [window.contentView addSubview:main];
    [window orderBack:nil];
    void *surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    if (!surface) {
        fprintf(stderr, "FAIL: a logical surface is not created\n");
        return 1;
    }
    webviewSetFrame(surface, 0, 0, 500, 400);
    webviewSetSurfaceHidden(surface, false);

    NSString *stores = temporaryFolder(@"soksak-document-benchmark-");

    void *document = sp_document_create(surface, [stores stringByAppendingPathComponent:@"store"].fileSystemRepresentation,
        NULL, NULL, NULL, NULL, changed, NULL);
    if (!document) {
        fprintf(stderr, "FAIL: a document view is not created inside the surface\n");
        return 1;
    }
    WKWebView *view = (WKWebView *)document;
    sp_document_place(document, 10, 20, 30, 40, true);

    // The page loads with the first state report that carries its title.
    fprintf(stdout, "start load\n");
    fflush(stdout);
    if (!sp_document_load(document, base.UTF8String)) {
        fprintf(stderr, "FAIL: the benchmark address is refused\n");
        return 1;
    }
    double loadStarted = nowSeconds();
    waitTurns(@"the benchmark page loads", ^BOOL {
        return view._webProcessIdentifier != 0 && !view.loading && [view.title isEqual:@"Benchmark"];
    });
    // The state reports of the load arrive after the title, before the round trip that follows the load.
    roundTrip(view, @"the state reports of the load arrive");
    fprintf(stdout, "end load elapsed %.3f s\n", nowSeconds() - loadStarted);
    fflush(stdout);

    // Totals of changes since the load: 0, 1000, 5000 and 10000.
    long totals[] = { 0, 1000, 5000, 10000 };
    Sample samples[4];
    long previous = 0;
    for (int i = 0; i < 4; i++) {
        if (totals[i] > previous) runStep(view, totals[i] - previous);
        previous = totals[i];
        samples[i] = measure(view, totals[i]);
    }

    Sample first = samples[0], last = samples[3];
    double kilobytesPer1000 = (double)(last.footprint - first.footprint) / 1024.0 / ((double)(last.changes - first.changes) / 1000.0);
    double bytesPerChange = (double)(last.reportBytes - first.reportBytes) / (double)(last.changes - first.changes);
    double reportsPerChange = (double)(last.reports - first.reports) / (double)(last.changes - first.changes);
    fprintf(stdout, "growth_kb_per_1000_changes=%.1f\n", kilobytesPer1000);
    fprintf(stdout, "report_bytes_per_change=%.1f\n", bytesPerChange);
    fprintf(stdout, "reports_per_change=%.3f\n", reportsPerChange);

    // Every object that the benchmark started ends here: the document view, the surface, the window, the server and the
    // store; WebKit then ends the WebContent process of the closed document.
    process = view._webProcessIdentifier;
    sp_document_close(document);
    sp_surface_close(surface);
    [window close];
    [window release];
    }
    waitProcessEnd(process, [NSString stringWithFormat:@"the WebContent process %d of the closed document ends", process]);
    fprintf(stdout, "closed document process %d ended\n", process);
    nw_listener_cancel(listener);
    fprintf(stdout, "end benchmark elapsed %.3f s\n", nowSeconds() - started);
    fflush(stdout);
    return 0;
}}
