// The cost of each site of the fixed list of tests/support/site_cost.m in a document region (docs/spec/native-surfaces.md#document-regions),
// which `make benchmark-site-cost [RUNS=<count>]` prints as the median, the quartiles and the interquartile range of at least five
// runs of each site. The benchmark needs the network and a window on the visible screen, and it prints numbers and asserts nothing.
//
// One run is one process of this program (--measure), so the GPU and network processes of WebKit, the caches of the data store and
// the WebContent process of the site start new in each run, and they end with that process before the next run starts. In a 1200×760
// window, a run:
//   1. opens an anchor region on a page of the benchmark below the region of the site. The anchor keeps the GPU and network processes
//      alive and is the baseline without the tab, which is read 10 seconds after the anchor loaded;
//   2. opens the 1180×400 region of the site with the element and request streams subscribed, each element snapshot acknowledged, as
//      a browser panel reads them, and reads the load time from the load request to the end of the load. The streams are what makes
//      a page that changes its tree cost anything in the region;
//   3. after 10 seconds reads the CPU of the three processes over 30 seconds with the tab shown and no input, and then their memory;
//   4. reads the input delay of 20 native presses, from the native event of each press to the first handler of the page. Each press
//      and each release is sent after the page handled the one before it, and the handlers cancel the press, so the page does not
//      follow a link;
//   5. places the region as not visible, as a tab that is not shown, and after 10 seconds reads the CPU over 30 seconds.
// The 10 seconds before a reading and the 30 seconds of a CPU reading are the measurement windows of the run; no other wait has a
// time. A run takes about two minutes, and seven sites of five runs about an hour. A step that fails ends the run with its
// measured state, and a run that fails ends the benchmark: a report has the same runs for each site.
#import <Cocoa/Cocoa.h>
#import <Network/Network.h>
#import <WebKit/WebKit.h>
#import <libproc.h>
#import <mach/mach_time.h>
#import <sys/resource.h>
#import "support/event_wait.h"
#import "support/site_cost.h"
#import "support/temporary_folder.h"
#import "document_view.h"
#import "input_inject.h"
#import "private/webkit.h"
#import "webview_geometry.h"

static const CGFloat kWindowWidth = 1200;
static const CGFloat kWindowHeight = 760;
// The margins of the region of the site in the window: left, top, right and bottom. The region is 1180×400.
static const double kSiteMargins[4] = { 10, 10, 10, 350 };
// The anchor fills the window below the region of the site.
static const double kAnchorMargins[4] = { 10, 420, 10, 10 };
// The point of each press: the middle of the region of the site, in points from the top left of the content area.
static const double kPressX = 600;
static const double kPressY = 210;
// The measurement window between the end of a load, or the hiding of the region, and the next reading, in seconds.
static const NSTimeInterval kSettleSeconds = 10;
// The measurement window of each CPU reading, in seconds.
static const NSTimeInterval kCpuSeconds = 30;
enum { kPressCount = 20 };

// Records the delay of each press and ends the press there, so the page does not act on it. The time of the event is the moment
// that sp_input_pointer made the native event, and the delay ends at the first handler that a page can have. The page counts the
// presses and the releases that it handled, and soksakHandled(type, count) resolves once the page handled count of that type.
static NSString *const kPressScript = @"const delays = []; globalThis.soksakPressDelays = delays;"
    "const handled = { pointerdown: 0, pointerup: 0 }; const waiting = [];"
    "const settle = () => { for (const wait of waiting.splice(0)) {"
    " if (handled[wait.type] >= wait.count) wait.resolve(handled[wait.type]); else waiting.push(wait); } };"
    "globalThis.soksakHandled = (type, count) => new Promise((resolve) => { waiting.push({ type, count, resolve }); settle(); });"
    "addEventListener('pointerdown', (event) => { delays.push(performance.now() - event.timeStamp);"
    " event.preventDefault(); event.stopImmediatePropagation(); handled.pointerdown++; settle(); }, true);"
    "addEventListener('pointerup', (event) => { event.preventDefault(); event.stopImmediatePropagation(); handled.pointerup++; settle(); }, true);"
    "for (const type of ['mousedown', 'mouseup', 'click'])"
    " addEventListener(type, (event) => { event.preventDefault(); event.stopImmediatePropagation(); }, true);"
    "return delays.length;";
static NSString *const kAnchorPage = @"<!doctype html><title>anchor</title>";

static double nowSeconds(void) {
    return NSDate.date.timeIntervalSince1970;
}

// Waits until done() holds, with an autorelease pool for each turn of the run loop: the condition drains the pool of the turn
// before it judges, so the objects that a turn autoreleases are released at its end, as a turn of NSApp run does. The wait
// dispatches the application events, and the window server delivers the occlusion state of a window as an application event, so
// the page does not stay at the state of the creation of the window.
static void waitTurns(NSString *what, BOOL (^done)(void)) {
    __block NSAutoreleasePool *turn = [[NSAutoreleasePool alloc] init];
    eventWait(what, ^BOOL {
        [turn drain];
        turn = [[NSAutoreleasePool alloc] init];
        return done();
    });
    [turn drain];
}

// Runs the run loop for a measurement window of the given seconds. The end of the window is a block of the main queue.
static void measureFor(NSTimeInterval seconds, NSString *what) {
    __block BOOL ended = NO;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(seconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{ ended = YES; });
    waitTurns(what, ^BOOL { return ended; });
}

// Ends the run with the step and the measured state.
static void failStep(const char *site, NSString *step, NSString *reason) {
    fprintf(stderr, "FAIL: site %s step %s: %s\n", site, step.UTF8String, reason.UTF8String);
    exit(1);
}

// The state reports of a document are not read by this benchmark.
static void documentChanged(void *context, const char *state) {
    (void)context;
    (void)state;
}

// Acknowledges each element snapshot, so that the document keeps sending snapshots.
static void streamMessage(void *context, const char *json) {
    NSDictionary *value = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json length:strlen(json)] options:0 error:nil];
    if (![value isKindOfClass:NSDictionary.class]) {
        fprintf(stderr, "FAIL: a document stream message is not a JSON object\n");
        exit(1);
    }
    NSDictionary *message = value[@"message"];
    if (![value[@"stream"] isEqualToString:@"elements"] || ![message[@"type"] isEqualToString:@"snapshot"]) return;
    unsigned long long seq = [message[@"seq"] unsignedLongLongValue];
    if (!sp_document_stream_ack(context, seq)) {
        fprintf(stderr, "FAIL: the element snapshot %llu is not acknowledged\n", seq);
        exit(1);
    }
}

// An HTTP server on the loopback address that answers a request for /tree with the page that changes its tree and any other
// request with the anchor page, and closes each connection.
static nw_listener_t serve(const char *site) {
    nw_parameters_t parameters = nw_parameters_create_secure_tcp(NW_PARAMETERS_DISABLE_PROTOCOL, NW_PARAMETERS_DEFAULT_CONFIGURATION);
    nw_parameters_set_local_endpoint(parameters, nw_endpoint_create_host("127.0.0.1", "0"));
    nw_listener_t listener = nw_listener_create(parameters);
    nw_listener_set_queue(listener, dispatch_get_main_queue());
    nw_listener_set_new_connection_handler(listener, ^(nw_connection_t connection) {
        nw_connection_set_queue(connection, dispatch_get_main_queue());
        nw_connection_start(connection);
        nw_connection_receive(connection, 1, 65536, ^(dispatch_data_t content, nw_content_context_t context, bool complete, nw_error_t error) {
            // WebKit opens connections ahead of a request and ends one that it does not use.
            if (error || !content || dispatch_data_get_size(content) == 0) {
                nw_connection_cancel(connection);
                return;
            }
            const void *buffer = NULL;
            size_t length = 0;
            dispatch_data_t map = dispatch_data_create_map(content, &buffer, &length);
            NSString *request = [[[NSString alloc] initWithBytes:buffer length:length encoding:NSUTF8StringEncoding] autorelease];
            dispatch_release(map);
            BOOL tree = [[request componentsSeparatedByString:@"\r\n"].firstObject containsString:@" /tree "];
            NSData *bytes = [(tree ? kSiteCostTreePage : kAnchorPage) dataUsingEncoding:NSUTF8StringEncoding];
            NSString *head = [NSString stringWithFormat:@"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
                "Content-Length: %lu\r\nConnection: close\r\n\r\n", (unsigned long)bytes.length];
            NSMutableData *response = [[[head dataUsingEncoding:NSUTF8StringEncoding] mutableCopy] autorelease];
            [response appendData:bytes];
            dispatch_data_t out = dispatch_data_create(response.bytes, response.length, dispatch_get_main_queue(), DISPATCH_DATA_DESTRUCTOR_DEFAULT);
            nw_connection_send(connection, out, NW_CONNECTION_FINAL_MESSAGE_CONTEXT, true, ^(nw_error_t sent) {
                if (sent) {
                    fprintf(stderr, "FAIL: the benchmark server did not send its answer: %d\n", nw_error_get_error_code(sent));
                    exit(1);
                }
                nw_connection_cancel(connection);
            });
            dispatch_release(out);
        });
    });
    __block BOOL ready = NO;
    nw_listener_set_state_changed_handler(listener, ^(nw_listener_state_t state, nw_error_t error) {
        if (state == nw_listener_state_ready) ready = YES;
    });
    nw_listener_start(listener);
    waitTurns(@"the server of the benchmark is ready", ^BOOL { return ready; });
    return listener;
}

// The rusage of the process, for the step of the failure.
static struct rusage_info_v0 readUsage(const char *site, NSString *step, pid_t process) {
    struct rusage_info_v0 info;
    if (proc_pid_rusage(process, RUSAGE_INFO_V0, (rusage_info_t *)&info) != 0) {
        failStep(site, step, [NSString stringWithFormat:@"proc_pid_rusage did not read the process %d: %s", process, strerror(errno)]);
    }
    return info;
}

// The sum of ri_user_time and ri_system_time of the processes, in mach ticks.
static uint64_t readCpuTicks(const char *site, NSString *step, const int processes[kSiteCostProcessCount]) {
    uint64_t ticks = 0;
    for (int i = 0; i < kSiteCostProcessCount; i++) {
        struct rusage_info_v0 info = readUsage(site, step, processes[i]);
        ticks += info.ri_user_time + info.ri_system_time;
    }
    return ticks;
}

// The CPU of the processes in percent of one core over kCpuSeconds.
static double measureCpu(const char *site, NSString *step, const int processes[kSiteCostProcessCount]) {
    mach_timebase_info_data_t timebase;
    if (mach_timebase_info(&timebase) != KERN_SUCCESS) failStep(site, step, @"the mach timebase cannot be read");
    uint64_t startTicks = readCpuTicks(site, step, processes);
    double started = nowSeconds();
    measureFor(kCpuSeconds, [NSString stringWithFormat:@"the CPU reading of step %@ ends", step]);
    uint64_t endTicks = readCpuTicks(site, step, processes);
    double percent = 0;
    NSString *refused = siteCostCpuPercent(startTicks, endTicks, nowSeconds() - started, timebase.numer, timebase.denom, &percent);
    if (refused) failStep(site, step, refused);
    return percent;
}

// Runs the script in the page and returns its value.
static id runScript(const char *site, NSString *step, WKWebView *view, NSString *script) {
    __block id result = nil;
    __block NSError *failure = nil;
    __block BOOL done = NO;
    [view callAsyncJavaScript:script arguments:@{} inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:^(id value, NSError *error) {
        result = [value retain];
        failure = [error retain];
        done = YES;
    }];
    waitTurns([NSString stringWithFormat:@"the page answers the script of step %@", step], ^BOOL { return done; });
    if (failure) failStep(site, step, [NSString stringWithFormat:@"the script failed: %@", failure.localizedDescription]);
    return [result autorelease];
}

// The median, in milliseconds, of the delays of the presses.
static double measureInputDelay(const char *site, NSWindow *window, WKWebView *view) {
    NSString *step = @"input";
    runScript(site, step, view, kPressScript);
    // Each press and each release is sent after the page handled the one before it, so the presses do not merge.
    for (int i = 0; i < kPressCount; i++) {
        sp_input_result down = sp_input_pointer(window, kPressX, kPressY, 1, 0, 0, 0);
        if (down != SP_INPUT_DELIVERED) failStep(site, step, [NSString stringWithFormat:@"press %d has the result %d", i + 1, down]);
        runScript(site, step, view, [NSString stringWithFormat:@"return await globalThis.soksakHandled('pointerdown', %d);", i + 1]);
        sp_input_result up = sp_input_pointer(window, kPressX, kPressY, 3, 0, 0, 0);
        if (up != SP_INPUT_DELIVERED) failStep(site, step, [NSString stringWithFormat:@"release %d has the result %d", i + 1, up]);
        runScript(site, step, view, [NSString stringWithFormat:@"return await globalThis.soksakHandled('pointerup', %d);", i + 1]);
    }
    NSArray *handled = runScript(site, step, view, @"return globalThis.soksakPressDelays ?? [];");
    if (handled.count != kPressCount) {
        failStep(site, step, [NSString stringWithFormat:@"the page handled %lu of %d presses", (unsigned long)handled.count, kPressCount]);
    }
    double delays[kPressCount];
    for (int i = 0; i < kPressCount; i++) {
        if (![handled[i] isKindOfClass:NSNumber.class]) failStep(site, step, [NSString stringWithFormat:@"the delay of press %d is not a number", i + 1]);
        delays[i] = [handled[i] doubleValue];
    }
    SiteCostSummary summary;
    NSString *refused = siteCostSummarize(delays, kPressCount, &summary);
    if (refused) failStep(site, step, refused);
    return summary.median;
}

// One open document region.
typedef struct {
    void *document;
    WKWebView *view;
} Region;

// Opens a region at the margins and starts the load of the address. Returns the time of the load request.
static Region openRegion(const char *site, NSString *step, void *surface, NSString *directory, const double margins[4], BOOL streams,
    NSString *address, double *requested) {
    Region region = { sp_document_create(surface, directory.fileSystemRepresentation, NULL, NULL, NULL, NULL, documentChanged, NULL), nil };
    if (!region.document) failStep(site, step, @"a document view is not created inside the surface");
    region.view = (WKWebView *)region.document;
    sp_document_place(region.document, margins[0], margins[1], margins[2], margins[3], true);
    if (streams) {
        sp_document_set_stream(region.document, streamMessage, region.document);
        if (!sp_document_stream_on(region.document, "elements", true) || !sp_document_stream_on(region.document, "requests", true)) {
            failStep(site, step, @"a document stream is not turned on");
        }
    }
    *requested = nowSeconds();
    if (!sp_document_load(region.document, address.UTF8String)) failStep(site, step, @"the document refuses the address");
    return region;
}

// The load has finished when the page is not loading and it has a title. Returns the time of that.
static double untilLoaded(const char *site, NSString *step, Region region) {
    WKWebView *view = region.view;
    waitTurns([NSString stringWithFormat:@"the page of step %@ finishes loading", step], ^BOOL { return !view.loading && view.title.length > 0; });
    return nowSeconds();
}

// The physical footprint of a process that may not exist yet: the baseline of a process that WebKit has not started is 0.
static long baselineFootprint(const char *site, NSString *step, pid_t process) {
    return process == 0 ? 0 : (long)readUsage(site, step, process).ri_phys_footprint;
}

// A process that the baseline read must be the process of the run, because a memory increase over another process says nothing.
static void requireSameProcess(const char *site, NSString *step, const char *name, pid_t baseline, pid_t current) {
    if (current == 0) failStep(site, step, [NSString stringWithFormat:@"the %s process does not exist", name]);
    if (baseline != 0 && baseline != current) {
        failStep(site, step, [NSString stringWithFormat:@"the %s process changed from %d to %d", name, baseline, current]);
    }
}

// Measures one run of the site and writes it to the file `output`.
static void measureRun(const SiteCostSite *site, NSString *output) {
    const char *name = site->name;
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    nw_listener_t listener = serve(name);
    NSString *origin = [NSString stringWithFormat:@"http://127.0.0.1:%d", nw_listener_get_port(listener)];
    NSString *address = site->address ? @(site->address) : [origin stringByAppendingString:@"/tree"];

    NSRect screen = NSScreen.mainScreen.visibleFrame;
    if (screen.size.width < kWindowWidth || screen.size.height < kWindowHeight) {
        failStep(name, @"window", [NSString stringWithFormat:@"the visible screen %gx%g is smaller than the %gx%g window",
            (double)screen.size.width, (double)screen.size.height, (double)kWindowWidth, (double)kWindowHeight]);
    }
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, kWindowWidth, kWindowHeight)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    NSView *content = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, kWindowWidth, kWindowHeight)] autorelease];
    window.contentView = content;
    [window setFrameTopLeftPoint:NSMakePoint(screen.origin.x, NSMaxY(screen))];
    // orderFront does not activate the application.
    [window orderFront:nil];

    // The surface is the main web view of the application: the document regions are placed inside it.
    WKWebView *mainView = [[WKWebView alloc] initWithFrame:content.bounds];
    mainView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [content addSubview:mainView];
    void *surface = sp_surface_create(mainView);
    if (!surface) failStep(name, @"surface", @"a logical surface is not created");
    webviewSetFrame(surface, 0, 0, kWindowWidth, kWindowHeight);
    webviewSetSurfaceHidden(surface, false);
    NSString *directory = [temporaryFolder(@"soksak-site-cost-") stringByAppendingPathComponent:@"documents"];

    double requested = 0;
    Region anchor = openRegion(name, @"anchor", surface, directory, kAnchorMargins, NO, [origin stringByAppendingString:@"/anchor"], &requested);
    untilLoaded(name, @"anchor", anchor);
    measureFor(kSettleSeconds, @"the window before the baseline reading ends");
    pid_t graphicsBaselineProcess = anchor.view._gpuProcessIdentifier;
    pid_t networkBaselineProcess = anchor.view._networkProcessIdentifier;
    long graphicsBaseline = baselineFootprint(name, @"baseline", graphicsBaselineProcess);
    long networkBaseline = baselineFootprint(name, @"baseline", networkBaselineProcess);

    Region region = openRegion(name, @"load", surface, directory, kSiteMargins, YES, address, &requested);
    double loaded = untilLoaded(name, @"load", region);
    SiteCostRun run;
    run.values[SiteCostLoad] = (loaded - requested) * 1000;
    fprintf(stdout, "loaded %s: title=%s elapsed %.0f ms\n", name, region.view.title.UTF8String, run.values[SiteCostLoad]);
    fflush(stdout);
    measureFor(kSettleSeconds, @"the window after the load ends");
    if (!(window.occlusionState & NSWindowOcclusionStateVisible)) failStep(name, @"rest", @"the window is occluded, so the page is not shown");

    run.processes[0] = region.view._webProcessIdentifier;
    run.processes[1] = region.view._gpuProcessIdentifier;
    run.processes[2] = region.view._networkProcessIdentifier;
    if (run.processes[0] == 0 || run.processes[0] == anchor.view._webProcessIdentifier) {
        failStep(name, @"rest", [NSString stringWithFormat:@"the region has the WebContent process %d of its own, not of the anchor", run.processes[0]]);
    }
    requireSameProcess(name, @"rest", "GPU", graphicsBaselineProcess, run.processes[1]);
    requireSameProcess(name, @"rest", "network", networkBaselineProcess, run.processes[2]);

    run.values[SiteCostCpuRest] = measureCpu(name, @"rest", run.processes);
    run.values[SiteCostContent] = siteCostIncreaseMegabytes(0, (long)readUsage(name, @"memory", run.processes[0]).ri_phys_footprint);
    run.values[SiteCostGraphics] = siteCostIncreaseMegabytes(graphicsBaseline, (long)readUsage(name, @"memory", run.processes[1]).ri_phys_footprint);
    run.values[SiteCostNetwork] = siteCostIncreaseMegabytes(networkBaseline, (long)readUsage(name, @"memory", run.processes[2]).ri_phys_footprint);
    run.values[SiteCostInputDelay] = measureInputDelay(name, window, region.view);

    sp_document_place(region.document, kSiteMargins[0], kSiteMargins[1], kSiteMargins[2], kSiteMargins[3], false);
    measureFor(kSettleSeconds, @"the window after the region is hidden ends");
    run.values[SiteCostCpuBackground] = measureCpu(name, @"background", run.processes);
    if (region.view._webProcessIdentifier != run.processes[0]) {
        failStep(name, @"background", [NSString stringWithFormat:@"the WebContent process changed from %d to %d during the run",
            run.processes[0], region.view._webProcessIdentifier]);
    }

    NSString *refused = siteCostCheckRun(&run);
    if (refused) failStep(name, @"check", refused);
    sp_document_close(region.document);
    sp_document_close(anchor.document);
    sp_surface_close(surface);
    [mainView removeFromSuperview];
    [mainView release];
    nw_listener_cancel(listener);
    [window close];
    [window release];
    NSError *error = nil;
    if (![siteCostEncodeRun(&run) writeToFile:output options:NSDataWritingAtomic error:&error]) {
        failStep(name, @"output", error.localizedDescription);
    }
}

// Waits until the process has ended, because a process that the next run would meet is a failure of the run. The exit is a
// dispatch source of the main queue that records it; a process that ended before the source was made gives no event, so a
// process that cannot be read once the source exists has ended.
static void untilProcessEnds(const char *site, int run, int process) {
    __block BOOL ended = NO;
    dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC, (uintptr_t)process, DISPATCH_PROC_EXIT,
        dispatch_get_main_queue());
    if (!source) {
        fprintf(stderr, "FAIL: site %s run %d: the exit observation of the process %d cannot start\n", site, run, process);
        exit(1);
    }
    dispatch_source_set_event_handler(source, ^{ ended = YES; });
    dispatch_resume(source);
    waitTurns([NSString stringWithFormat:@"the process %d of site %s run %d ends", process, site, run], ^BOOL {
        struct proc_bsdinfo info;
        return ended || proc_pidinfo(process, PROC_PIDTBSDINFO, 0, &info, sizeof info) != (int)sizeof info;
    });
    dispatch_source_cancel(source);
    dispatch_release(source);
}

// Runs each site `runs` times, each run in its own process, and prints each run and the report.
static void measureSites(int runs) {
    NSString *folder = temporaryFolder(@"soksak-site-cost-runs-");
    SiteCostRun *measured = calloc(kSiteCostSiteCount * runs, sizeof *measured);
    if (!measured) {
        fprintf(stderr, "FAIL: the runs cannot be held: no memory\n");
        exit(1);
    }
    for (int site = 0; site < kSiteCostSiteCount; site++) {
        const char *name = kSiteCostSites[site].name;
        for (int run = 0; run < runs; run++) {
            @autoreleasepool {
                NSString *output = [folder stringByAppendingPathComponent:[NSString stringWithFormat:@"%s-%d.json", name, run + 1]];
                fprintf(stdout, "start %s run %d of %d\n", name, run + 1, runs);
                fflush(stdout);
                NSTask *task = [[[NSTask alloc] init] autorelease];
                task.executableURL = [NSURL fileURLWithPath:NSProcessInfo.processInfo.arguments[0]];
                task.arguments = @[@"--measure", @(name), @"--output", output];
                NSError *error = nil;
                if (![task launchAndReturnError:&error]) {
                    fprintf(stderr, "FAIL: site %s run %d does not start: %s\n", name, run + 1, error.localizedDescription.UTF8String);
                    exit(1);
                }
                [task waitUntilExit];
                if (task.terminationStatus != 0) {
                    fprintf(stderr, "FAIL: site %s run %d ended with status %d\n", name, run + 1, task.terminationStatus);
                    exit(1);
                }
                SiteCostRun *read = &measured[site * runs + run];
                NSString *refused = siteCostDecodeRun([NSData dataWithContentsOfFile:output], read);
                if (refused) {
                    fprintf(stderr, "FAIL: site %s run %d: %s\n", name, run + 1, refused.UTF8String);
                    exit(1);
                }
                for (int i = 0; i < kSiteCostProcessCount; i++) untilProcessEnds(name, run + 1, read->processes[i]);
                fprintf(stdout, "run %s %d:", name, run + 1);
                for (int metric = 0; metric < SiteCostMetricCount; metric++) {
                    fprintf(stdout, " %s=%.2f", siteCostMetricName(metric), read->values[metric]);
                }
                fprintf(stdout, "\n");
                fflush(stdout);
            }
        }
    }
    NSString *error = nil;
    NSString *report = siteCostReport(measured, runs, &error);
    if (!report) {
        fprintf(stderr, "FAIL: %s\n", error.UTF8String);
        exit(1);
    }
    fprintf(stdout, "\n%s", report.UTF8String);
    fflush(stdout);
    free(measured);
}

int main(int argc, char **argv) { @autoreleasepool {
    if (argc == 3 && strcmp(argv[1], "--runs") == 0) {
        int runs = 0;
        NSString *refused = siteCostParseRuns(argv[2], &runs);
        if (refused) {
            fprintf(stderr, "FAIL: %s\n", refused.UTF8String);
            return 1;
        }
        measureSites(runs);
        return 0;
    }
    if (argc == 5 && strcmp(argv[1], "--measure") == 0 && strcmp(argv[3], "--output") == 0) {
        const SiteCostSite *site = siteCostSiteNamed(argv[2]);
        if (!site) {
            fprintf(stderr, "FAIL: %s is not a site of the list\n", argv[2]);
            return 1;
        }
        measureRun(site, @(argv[4]));
        return 0;
    }
    fprintf(stderr, "FAIL: the arguments are --runs <count>, or --measure <site> --output <file> for one run\n");
    return 1;
}}
