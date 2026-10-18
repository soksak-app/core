// The cost of the document script (docs/spec/native-surfaces.md#document-regions): the physical footprint of the WebContent
// process of a document region and the state reports that the host receives while the page changes a tree of 2000
// elements without pause. The page changes one element in each task, and each change runs the script's element walk.
// The benchmark prints the numbers and asserts nothing (docs/plans/document-streams-and-memory.md#verification).
#import <Cocoa/Cocoa.h>
#import <Network/Network.h>
#import <WebKit/WebKit.h>
#import <libproc.h>
#import <signal.h>
#import <errno.h>
#import <string.h>
#import <sys/types.h>
#import "support/temporary_folder.h"
#import "document_view.h"
#import "private/webkit.h"
#import "webview_geometry.h"

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

// Waits at most this many seconds for each step (AGENTS: a step that cannot finish is reported with its measured state).
static const NSTimeInterval stepLimit = 120;

static double nowSeconds(void) {
    return NSDate.date.timeIntervalSince1970;
}

// Pumps the run loop until done() holds or the limit passes. Returns done().
static BOOL pumpUntil(NSTimeInterval limit, BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:limit];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    return done();
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
    if (!pumpUntil(stepLimit, ^BOOL { return finished; })) {
        failStep(step, @"the page did not finish the changes within 120 seconds", view);
    }
    if (failure) failStep(step, [NSString stringWithFormat:@"the page script failed: %@", failure.localizedDescription], view);
    // The state reports of the last changes arrive after the page task that made them.
    pumpUntil(0.5, ^BOOL { return NO; });
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
    if (!pumpUntil(10, ^BOOL { return ready; })) {
        fprintf(stderr, "FAIL: the benchmark server did not start within 10 seconds\n");
        exit(1);
    }
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

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    main.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [window.contentView addSubview:main];
    [window orderBack:nil];
    void *surface = sp_surface_create(main);
    if (!surface) {
        fprintf(stderr, "FAIL: a logical surface is not created\n");
        return 1;
    }
    webviewSetFrame(surface, 0, 0, 500, 400);
    webviewSetSurfaceHidden(surface, false);

    NSString *stores = temporaryFolder(@"soksak-document-benchmark-");

    void *document = sp_document_create(surface, [stores stringByAppendingPathComponent:@"store"].fileSystemRepresentation,
        NULL, NULL, changed, NULL);
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
    if (!pumpUntil(stepLimit, ^BOOL {
        return view._webProcessIdentifier != 0 && !view.loading && [view.title isEqual:@"Benchmark"];
    })) {
        failStep(@"load", @"the benchmark page did not load within 120 seconds", view);
    }
    // The first run of the element walk and the state reports of the load arrive after the title.
    pumpUntil(0.5, ^BOOL { return NO; });
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

    // Every object that the benchmark started ends here: the document view, its WebContent process, the surface, the window,
    // the server and the store.
    pid_t process = view._webProcessIdentifier;
    sp_document_close(document);
    // WebKit keeps an idle WebContent process after its last view closes, so the benchmark ends the process it started.
    if (kill(process, SIGKILL) != 0 && errno != ESRCH) {
        fprintf(stderr, "FAIL: the WebContent process %d cannot be ended: %s\n", process, strerror(errno));
        return 1;
    }
    if (!pumpUntil(10, ^BOOL { return kill(process, 0) != 0; })) {
        fprintf(stderr, "FAIL: the WebContent process %d of the closed document remains after 10 seconds\n", process);
        return 1;
    }
    fprintf(stdout, "closed document process %d ended\n", process);
    sp_surface_close(surface);
    [window close];
    [window release];
    nw_listener_cancel(listener);
    fprintf(stdout, "end benchmark elapsed %.3f s\n", nowSeconds() - started);
    fflush(stdout);
    return 0;
}}
