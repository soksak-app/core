// The response of a document region to memory pressure (docs/features.md F196.9.2). The same scenario runs twice: once in a
// document region and once in a plain WKWebView with the default configuration, in a window of the same frame. A local page
// allocates about 200 MB of JavaScript objects and DOM and holds them until the check releases every reference (the page then
// reports the title Released). The physical footprint of the WebContent process is read before the pressure and after the
// system runs `memory_pressure -S -l warn` and then `-S -l critical`, each awaited to its end. Each drop is reported as a share of the
// freeable size, which is the footprint the page added while it held the objects (the footprint of the held page minus the
// footprint of the blank page). The engine's own response is measured with the same scenario in a plain WKWebView, and the
// region's drop must be at least 0.8 times the plain view's drop. The absolute drop is not asserted, because the engine drops
// only about 6% of the freeable size in both paths. The check does not activate the application. It refuses to judge when the
// 1-minute load is above 20. Its cleanup always runs `memory_pressure -S -l normal`. Before and after the pressure it prints
// the rows of `footprint -p` and the malloc zone rows of `vmmap -summary` of the WebContent process, which attribute the kept
// footprint by allocation kind, and whether the engine has collected the released array (a WeakRef of the page); these
// rows are printed and not asserted.
#import <Cocoa/Cocoa.h>
#import <Network/Network.h>
#import <WebKit/WebKit.h>
#import <errno.h>
#import <libproc.h>
#import <signal.h>
#import <stdlib.h>
#import <string.h>
#import <sys/sysctl.h>
#import "support/event_wait.h"
#import "support/temporary_folder.h"
#import "document_view.h"
#import "private/webkit.h"
#import "webview_geometry.h"
#import "window_facts.h"

static const int objectCount = 1800000;
static const int elementCount = 50000;
// The interval between two readings of the footprint, which the settled footprint compares (a measurement window).
static const NSTimeInterval settleInterval = 1.0;
static const double loadLimit = 20;
static const long minimumFreeable = 150L * 1024 * 1024;

typedef struct { long freeable; long before; long after; } Drop;

static int failures = 0;
static WKWebView *view;
static void *document;
static void *surface;
static NSWindow *window;
static nw_listener_t listener;
static NSString *storeDirectory;
static NSMutableSet<NSNumber *> *processes;
static pid_t processAtStart;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// The physical footprint (bytes) of the process, or -1 when the process cannot be read.
static long physicalFootprint(pid_t pid) {
    struct rusage_info_v0 info;
    return proc_pid_rusage(pid, RUSAGE_INFO_V0, (rusage_info_t *)&info) == 0 ? (long)info.ri_phys_footprint : -1;
}

static void changed(void *context, const char *text) {}

// Closes the document region, surface and window of the current scenario.
static void closeScenario(void) {
    if (document) sp_document_close(document);
    document = NULL;
    if (surface) sp_surface_close(surface);
    surface = NULL;
    if (window) [window close];
    window = nil;
    view = nil;
}

// Checks that each WebContent process of the scenario ends after the scenario closed its views and its pool ended, as
// WebKit ends a process that serves no page, and forgets the processes.
static void checkScenarioProcessesEnd(void) {
    for (NSNumber *pid in processes) {
        NSDate *start = [NSDate date];
        // The dispatch source reports the exit on the main queue; a process that ended before the registration reports no exit,
        // and a process that does not exist after it has ended.
        __block BOOL exited = NO;
        dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC, (uintptr_t)pid.intValue, DISPATCH_PROC_EXIT,
            dispatch_get_main_queue());
        dispatch_source_set_event_handler(source, ^{ exited = YES; });
        dispatch_resume(source);
        if (kill(pid.intValue, 0) != 0 && errno == ESRCH) exited = YES;
        eventWait([NSString stringWithFormat:@"the WebContent process %d ends", pid.intValue], ^BOOL { return exited; });
        dispatch_source_cancel(source);
        dispatch_release(source);
        struct proc_bsdinfo info;
        BOOL ended = proc_pidinfo(pid.intValue, PROC_PIDTBSDINFO, 0, &info, sizeof info) != (int)sizeof info;
        check(ended, [NSString stringWithFormat:@"the WebContent process %d ends after its scenario closes (%.3f s)", pid.intValue, -start.timeIntervalSinceNow]);
    }
    [processes removeAllObjects];
}

// Runs `sudo -n /usr/bin/memory_pressure -S -l <level>` and waits for its end. Returns YES when it exits with status 0.
static BOOL runPressure(NSString *level) {
    NSTask *task = [[[NSTask alloc] init] autorelease];
    NSPipe *pipe = [[[NSPipe alloc] init] autorelease];
    task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/sudo"];
    task.arguments = @[@"-n", @"/usr/bin/memory_pressure", @"-S", @"-l", level];
    task.standardOutput = pipe;
    task.standardError = pipe;
    NSError *error = nil;
    if (![task launchAndReturnError:&error]) {
        fprintf(stderr, "FAIL: memory_pressure -S -l %s did not start: %s\n", level.UTF8String, error.localizedDescription.UTF8String);
        return NO;
    }
    NSData *output = [pipe.fileHandleForReading readDataToEndOfFile];
    [task waitUntilExit];
    NSString *text = [[[NSString alloc] initWithData:output encoding:NSUTF8StringEncoding] autorelease];
    printf("memory_pressure -S -l %s: exit status %d\n", level.UTF8String, task.terminationStatus);
    if (text.length) printf("  output: %s", text.UTF8String);
    return task.terminationReason == NSTaskTerminationReasonExit && task.terminationStatus == 0;
}

// Ends the check: closes the scenario, runs `memory_pressure -S -l normal`. Each step reports its failure.
static void finish(void) {
    closeScenario();
    if (!runPressure(@"normal")) {
        fprintf(stderr, "FAIL: memory_pressure -S -l normal did not end with status 0\n");
        failures++;
    }
}

// Ends the check at the step that cannot run, after the cleanup, and exits with status 1.
static void fail(NSString *step, NSString *reason) {
    fprintf(stderr, "FAIL: step %s: %s\n", step.UTF8String, reason.UTF8String);
    if (view) fprintf(stderr, "  state: pid=%d title=%s\n", view._webProcessIdentifier, view.title.UTF8String ?: "(nil)");
    finish();
    fprintf(stdout, "FAIL: document_pressure_test\n");
    exit(1);
}

// The WebContent process of the view. Its change is a failure, because its footprint would not be the one measured before.
static pid_t currentProcess(void) {
    pid_t process = view._webProcessIdentifier;
    if (process == 0) fail(@"process", @"the view has no WebContent process");
    if (process != processAtStart) {
        fail(@"process", [NSString stringWithFormat:@"the WebContent process changed from %d to %d", processAtStart, process]);
    }
    [processes addObject:@(process)];
    return process;
}

// Prints whether the engine has collected the released array, read through a WeakRef that the page holds. The read does not
// allocate and does not request a collection.
static void printCollected(NSString *label) {
    __block BOOL answered = NO;
    __block NSString *result = nil;
    [view evaluateJavaScript:@"window.collected()" completionHandler:^(id value, NSError *error) {
        result = [[value description] retain];
        answered = YES;
    }];
    eventWait([label stringByAppendingString:@" collected script answers"], ^BOOL { return answered; });
    printf("  %s released array: %s\n", label.UTF8String, result.UTF8String);
    [result release];
}

// Runs a tool with the arguments and returns its standard output, or fails the step when it does not end with status 0.
static NSString *toolOutput(NSString *path, NSArray<NSString *> *arguments, NSString *step) {
    NSTask *task = [[[NSTask alloc] init] autorelease];
    NSPipe *pipe = [[[NSPipe alloc] init] autorelease];
    task.executableURL = [NSURL fileURLWithPath:path];
    task.arguments = arguments;
    task.standardOutput = pipe;
    task.standardError = [NSFileHandle fileHandleWithNullDevice];
    NSError *error = nil;
    if (![task launchAndReturnError:&error]) fail(step, [NSString stringWithFormat:@"%@ did not start: %@", path, error.localizedDescription]);
    NSData *output = [pipe.fileHandleForReading readDataToEndOfFile];
    [task waitUntilExit];
    if (task.terminationStatus != 0) fail(step, [NSString stringWithFormat:@"%@ ended with status %d", path, task.terminationStatus]);
    return [[[NSString alloc] initWithData:output encoding:NSUTF8StringEncoding] autorelease];
}

// Prints the category rows of `footprint -p` and the malloc zone rows of `vmmap -summary` of the WebContent process.
static void printBreakdown(NSString *label) {
    pid_t process = currentProcess();
    NSString *pid = [NSString stringWithFormat:@"%d", process];
    NSString *step = [label stringByAppendingString:@" breakdown"];
    for (NSString *line in [toolOutput(@"/usr/bin/footprint", @[@"-p", pid], step) componentsSeparatedByString:@"\n"]) {
        if ([line rangeOfString:@" B "].location != NSNotFound || [line containsString:@"TOTAL"]) {
            printf("  %s footprint: %s\n", label.UTF8String, line.UTF8String);
        }
    }
    BOOL zones = NO;
    for (NSString *line in [toolOutput(@"/usr/bin/vmmap", @[@"-summary", pid], step) componentsSeparatedByString:@"\n"]) {
        if ([line hasPrefix:@"MALLOC ZONE"]) zones = YES;
        if (zones && line.length) printf("  %s vmmap: %s\n", label.UTF8String, line.UTF8String);
    }
}

// Reads the footprint of the process once per settle interval, while the run loop handles the events of the interval, until two
// readings one interval apart agree within 1% of the value. The interval is the window of the measurement: the footprint of
// another process changes without an event, so the readings sample it at a fixed time apart. Each reading is printed.
static long settledFootprint(NSString *label) {
    NSMutableArray<NSNumber *> *readings = [NSMutableArray array];
    while (YES) {
        // A block of the main queue ends the window, and the run loop handles every event that arrives before it.
        __block BOOL elapsed = NO;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(settleInterval * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            elapsed = YES;
        });
        eventWait([NSString stringWithFormat:@"the %@ reading window of the footprint ends", label], ^BOOL { return elapsed; });
        long value = physicalFootprint(currentProcess());
        if (value < 0) fail(label, @"proc_pid_rusage did not read the WebContent process");
        [readings addObject:@(value)];
        printf("  %s reading %lu: %ld bytes\n", label.UTF8String, (unsigned long)readings.count, value);
        if (readings.count >= 2) {
            long previous = [readings[readings.count - 2] longValue];
            if (labs(value - previous) <= value / 100) return value;
        }
    }
}

// Loads a local page in the view and waits until its title is the given title.
static void load(NSString *path, NSString *title) {
    NSString *address = [NSString stringWithFormat:@"http://127.0.0.1:%d%@", nw_listener_get_port(listener), path];
    if (document) {
        if (!sp_document_load(document, address.UTF8String)) fail(path, @"the local page address is refused");
    } else {
        [view loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:address]]];
    }
    eventWait([NSString stringWithFormat:@"the title of %@ becomes %@", path, title], ^BOOL { return [view.title isEqual:title]; });
}

// Runs the scenario in the current view: blank baseline, held page, released page, then warn and critical pressure.
static Drop runScenario(NSString *name) {
    load(@"/blank", @"Blank");
    processAtStart = view._webProcessIdentifier;
    currentProcess();
    long baseline = settledFootprint([name stringByAppendingString:@" blank"]);

    load(@"/pressure", @"Allocated");
    long peak = settledFootprint([name stringByAppendingString:@" held"]);
    long freeable = peak - baseline;
    printf("%s held: footprint %ld bytes, blank %ld bytes, freeable %ld bytes (%.1f MB)\n", name.UTF8String, peak, baseline,
        freeable, freeable / 1048576.0);
    check(freeable >= minimumFreeable, [NSString stringWithFormat:@"the %@ page adds at least 150 MB (%.1f MB)", name,
        freeable / 1048576.0]);

    __block BOOL releaseAnswered = NO;
    __block id releaseResult = nil;
    [view evaluateJavaScript:@"window.release()" completionHandler:^(id value, NSError *error) {
        releaseResult = [value retain];
        releaseAnswered = YES;
    }];
    eventWait([name stringByAppendingString:@" release script answers"], ^BOOL { return releaseAnswered; });
    if (![releaseResult isEqual:@"released"]) fail(name, [NSString stringWithFormat:@"the release script answered %@", releaseResult]);
    [releaseResult release];
    eventWait([name stringByAppendingString:@" page reports Released"], ^BOOL { return [view.title isEqual:@"Released"]; });
    long before = settledFootprint([name stringByAppendingString:@" before"]);
    printBreakdown([name stringByAppendingString:@" before"]);
    printCollected([name stringByAppendingString:@" before"]);

    if (!runPressure(@"warn")) fail([name stringByAppendingString:@" pressure warn"], @"memory_pressure -S -l warn did not end with status 0");
    if (!runPressure(@"critical")) fail([name stringByAppendingString:@" pressure critical"], @"memory_pressure -S -l critical did not end with status 0");
    long after = settledFootprint([name stringByAppendingString:@" after"]);
    printBreakdown([name stringByAppendingString:@" after"]);
    printCollected([name stringByAppendingString:@" after"]);

    long drop = before - after;
    printf("%s: before %ld bytes, after %ld bytes, drop %ld bytes (%.1f MB), freeable %ld bytes (%.1f MB)\n", name.UTF8String,
        before, after, drop, drop / 1048576.0, freeable, freeable / 1048576.0);
    Drop result = { freeable, before, after };
    return result;
}

// Creates a window of the test frame with a WKWebView in its content and returns the web view.
static WKWebView *makeWindow(void) {
    window = [[[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO] autorelease];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *web = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    web.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [window.contentView addSubview:web];
    [window orderFrontRegardless];
    return web;
}

// Answers the request line of one connection with a page or 404, and closes the connection after the response.
static void respond(nw_connection_t connection, NSString *request) {
    NSArray<NSString *> *parts = [request componentsSeparatedByString:@" "];
    NSString *path = parts.count >= 2 ? parts[1] : @"";
    NSString *status = @"404 Not Found";
    NSString *body = @"";
    if ([path isEqual:@"/blank"]) {
        status = @"200 OK";
        body = @"<!doctype html><title>Blank</title><body>blank</body>";
    } else if ([path isEqual:@"/pressure"]) {
        status = @"200 OK";
        body = [NSString stringWithFormat:@"<!doctype html><title>Allocating</title><body><script>"
            "var keep = [];"
            "for (var i = 0; i < %d; i++) keep.push({index: i, label: 'row ' + i});"
            "for (var j = 0; j < %d; j++) { var e = document.createElement('div'); e.textContent = 'item ' + j; document.body.appendChild(e); }"
            "var probe = new WeakRef(keep);"
            "window.collected = function () { return probe.deref() === undefined ? 'collected' : 'alive'; };"
            "window.release = function () { keep = null; e = null; document.body.textContent = ''; document.title = 'Released'; return 'released'; };"
            "document.title = 'Allocated';"
            "</script></body>", objectCount, elementCount];
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

// The listener serves the pages of this check for every request.
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
    // Unbuffered stdout keeps each line whole when stderr receives a failure during the run.
    setvbuf(stdout, NULL, _IOLBF, 0);
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    processes = [NSMutableSet set];

    // The 1-minute load is read before any pressure is raised. A load above the limit is not judged.
    struct loadavg load;
    size_t loadSize = sizeof load;
    if (sysctlbyname("vm.loadavg", &load, &loadSize, NULL, 0) != 0) fail(@"load", @"sysctl vm.loadavg cannot be read");
    double load1 = (double)load.ldavg[0] / load.fscale;
    printf("load average at start (vm.loadavg): %.2f %.2f %.2f\n", load1,
        (double)load.ldavg[1] / load.fscale, (double)load.ldavg[2] / load.fscale);
    if (load1 > loadLimit) {
        fail(@"load", [NSString stringWithFormat:@"load too high: the 1-minute load %.2f is above %.0f, the measurement is not judged",
            load1, loadLimit]);
    }

    listener = serve();

    // Each scenario runs in its own pool, as each turn of the run loop of the applications does, so its closed views keep no
    // autoreleased reference after it. Document region of the test frame.
    Drop region;
    @autoreleasepool {
    WKWebView *main = makeWindow();
    surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    if (!surface) fail(@"surface", @"a logical surface is not created for the document");
    webviewSetFrame(surface, 0, 0, 500, 400);
    webviewSetSurfaceHidden(surface, false);
    storeDirectory = temporaryFolder(@"soksak-document-pressure-");
    document = sp_document_create(surface, [storeDirectory stringByAppendingPathComponent:@"store"].fileSystemRepresentation,
        NULL, NULL, NULL, NULL, changed, NULL);
    if (!document) fail(@"document", @"a document view is not created inside the surface");
    view = (WKWebView *)document;
    sp_document_place(document, 10, 20, 30, 40, true);
    region = runScenario(@"region");
    closeScenario();
    }
    checkScenarioProcessesEnd();

    // Plain web view of the same frame and the default configuration.
    Drop plain;
    @autoreleasepool {
    view = makeWindow();
    plain = runScenario(@"plain");
    closeScenario();
    }
    checkScenarioProcessesEnd();

    long regionDrop = region.before - region.after;
    long plainDrop = plain.before - plain.after;
    printf("drops: region %ld bytes (%.1f MB), plain %ld bytes (%.1f MB), region freeable %ld bytes (%.1f MB)\n",
        regionDrop, regionDrop / 1048576.0, plainDrop, plainDrop / 1048576.0, region.freeable, region.freeable / 1048576.0);
    if (plainDrop <= 0) {
        check(NO, [NSString stringWithFormat:@"the engine released nothing; the comparison has no baseline (plain drop %.1f MB)",
            plainDrop / 1048576.0]);
    } else {
        long required = (long)(0.8 * (double)plainDrop);
        check(regionDrop >= required,
            [NSString stringWithFormat:@"the region drop is at least 0.8 times the plain drop (region %.1f MB, plain %.1f MB, required %.1f MB)",
                regionDrop / 1048576.0, plainDrop / 1048576.0, required / 1048576.0]);
    }

    finish();
    check(!NSApp.isActive, @"the application stays inactive");
    printf("%s\n", failures ? "FAIL: document_pressure_test" : "PASS: document_pressure_test");
    return failures ? 1 : 0;
}}
