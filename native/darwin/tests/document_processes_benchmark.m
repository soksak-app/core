// Counts the WebContent processes of document regions and states the footprint of each process
// (docs/features.md F196.9.3). Four regions share one persistent data store directory, as the hosts do. The first scenario
// places two regions on one origin and two regions on another origin, and the second scenario places four regions on one
// origin. The check asserts that every region has a running process and that the footprint of each process is read; the
// process counts and the footprints are printed as measurements. The check does not activate the application.
#import <Cocoa/Cocoa.h>
#import <Network/Network.h>
#import <WebKit/WebKit.h>
#import <libproc.h>
#import <string.h>
#import <sys/types.h>
#import "support/temporary_folder.h"
#import "document_view.h"
#import "private/webkit.h"
#import "webview_geometry.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Pumps the run loop until done() holds or the limit passes. Returns done().
static BOOL pumpUntil(NSTimeInterval limit, BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:limit];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        @autoreleasepool {
            [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
        }
    }
    return done();
}

// The physical footprint (bytes) of the process, or -1 when the process cannot be read.
static long physicalFootprint(pid_t pid) {
    struct rusage_info_v0 info;
    return proc_pid_rusage(pid, RUSAGE_INFO_V0, (rusage_info_t *)&info) == 0 ? (long)info.ri_phys_footprint : -1;
}

static NSString *const kPage = @"<!doctype html><title>Region</title><body>region</body>";

// The text of a network error for the records of the test server, or none.
static NSString *networkError(nw_error_t error) {
    if (!error) return @"none";
    CFErrorRef cf = nw_error_copy_cf_error(error);
    NSString *text = [NSString stringWithFormat:@"%@", (__bridge NSError *)cf];
    CFRelease(cf);
    return text;
}

// The number of connections that the test servers accepted, which names each connection in the records.
static int connectionCount;

// With --unanswered-region=N the servers hold the request of region N of the first scenario without an answer, so the
// region waits as a stalled region does and the test checks the stall path: the closing of the regions whose load ended
// and its record. heldConnections keeps the held connections until the scenario ends.
static int unansweredRegion;
static BOOL holdRequests;
static NSMutableArray *heldConnections;
static int stallClosedRegions;
static int stallWaitingRegions;

// An HTTP server on the loopback address that answers every request with the page and closes each connection. Each
// connection writes a record when it is accepted, when its request arrives and when its answer is sent, so a region that
// does not load shows whether its request reached the server.
static nw_listener_t serve(void) {
    nw_parameters_t parameters = nw_parameters_create_secure_tcp(NW_PARAMETERS_DISABLE_PROTOCOL, NW_PARAMETERS_DEFAULT_CONFIGURATION);
    nw_parameters_set_local_endpoint(parameters, nw_endpoint_create_host("127.0.0.1", "0"));
    nw_listener_t listener = nw_listener_create(parameters);
    nw_listener_set_queue(listener, dispatch_get_main_queue());
    nw_listener_set_new_connection_handler(listener, ^(nw_connection_t connection) {
        int number = ++connectionCount;
        nw_endpoint_t remote = nw_connection_copy_endpoint(connection);
        printf("server connection %d accepted from %s\n", number, nw_endpoint_get_hostname(remote));
        nw_release(remote);
        fflush(stdout);
        nw_connection_set_queue(connection, dispatch_get_main_queue());
        nw_connection_start(connection);
        nw_connection_receive(connection, 1, 65536, ^(dispatch_data_t content, nw_content_context_t context, bool complete, nw_error_t error) {
            size_t received = content ? dispatch_data_get_size(content) : 0;
            printf("server connection %d received %zu bytes, complete %d, error %s\n", number, received, complete, networkError(error).UTF8String);
            fflush(stdout);
            if (error || received == 0) {
                // A connection that ends without a request is closed without an answer; WebKit opens such connections ahead of
                // a request and ends one that it does not use with a close or a reset, which the server cannot prevent. Any
                // other receive error is a failure of the server.
                BOOL resetByClient = error && received == 0 && nw_error_get_error_domain(error) == nw_error_domain_posix
                    && nw_error_get_error_code(error) == ECONNRESET;
                if (resetByClient) {
                    printf("server connection %d was reset by the client before a request\n", number);
                    fflush(stdout);
                } else if (error) {
                    check(NO, [NSString stringWithFormat:@"server connection %d receives its request: %@", number, networkError(error)]);
                }
                nw_connection_cancel(connection);
                return;
            }
            if (holdRequests) {
                const void *buffer = NULL;
                size_t length = 0;
                dispatch_data_t map = dispatch_data_create_map(content, &buffer, &length);
                NSString *request = [[[NSString alloc] initWithBytes:buffer length:length encoding:NSUTF8StringEncoding] autorelease];
                dispatch_release(map);
                NSString *held = [NSString stringWithFormat:@" /region-%d ", unansweredRegion];
                if ([[request componentsSeparatedByString:@"\r\n"].firstObject containsString:held]) {
                    printf("server connection %d holds the request of region %d without an answer\n", number, unansweredRegion);
                    fflush(stdout);
                    [heldConnections addObject:(id)connection];
                    return;
                }
            }
            NSData *bytes = [kPage dataUsingEncoding:NSUTF8StringEncoding];
            NSString *head = [NSString stringWithFormat:@"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
                "Content-Length: %lu\r\nConnection: close\r\n\r\n", (unsigned long)bytes.length];
            NSMutableData *response = [[[head dataUsingEncoding:NSUTF8StringEncoding] mutableCopy] autorelease];
            [response appendData:bytes];
            dispatch_data_t out = dispatch_data_create(response.bytes, response.length, dispatch_get_main_queue(), DISPATCH_DATA_DESTRUCTOR_DEFAULT);
            nw_connection_send(connection, out, NW_CONNECTION_FINAL_MESSAGE_CONTEXT, true, ^(nw_error_t sent) {
                printf("server connection %d sent its answer, error %s\n", number, networkError(sent).UTF8String);
                fflush(stdout);
                if (sent) check(NO, [NSString stringWithFormat:@"server connection %d sends its answer: %@", number, networkError(sent)]);
                nw_connection_cancel(connection);
            });
        });
    });
    __block BOOL ready = NO;
    nw_listener_set_state_changed_handler(listener, ^(nw_listener_state_t state, nw_error_t error) {
        if (state == nw_listener_state_ready) ready = YES;
    });
    nw_listener_start(listener);
    check(pumpUntil(10, ^BOOL { return ready; }), @"a test server is ready within 10 seconds");
    return listener;
}

typedef struct {
    NSString *address;
    void *document;
    pid_t process;
    long footprint;
    // The last state that the region reported through its changed callback.
    NSDictionary *state;
} Region;

// Keeps the state that the region reports. The context is the Region that receives the state.
static void changed(void *context, const char *text) {
    Region *region = (Region *)context;
    NSData *data = [NSData dataWithBytes:text length:strlen(text)];
    NSDictionary *state = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![state isKindOfClass:NSDictionary.class]) {
        check(NO, [NSString stringWithFormat:@"the state of region %@ is a JSON object: %s", region->address, text]);
        return;
    }
    // The WebContent process of each state names whether a region that does not load has a process and whether it is a
    // process of an earlier scenario (F335-2).
    WKWebView *view = (WKWebView *)region->document;
    pid_t process = view ? view._webProcessIdentifier : 0;
    pid_t provisional = view ? view._provisionalWebProcessIdentifier : 0;
    printf("region %s process %d provisional %d state event: %s\n", region->address.UTF8String, process, provisional, text);
    fflush(stdout);
    [region->state release];
    region->state = [state retain];
}

// Whether every region with a document has reported the end of its load. A region ends its load when a navigation fails
// (the state carries the error) or when the page is not loading and has its title. The state events also report the
// changes of the loading and title properties, and a page that is not loading can report an empty title before its title
// is set, so the title is part of the end.
static BOOL regionLoadEnded(const Region *region) {
    NSDictionary *state = region->state;
    if (!state) return NO;
    id error = state[@"error"];
    if (error && error != NSNull.null) return YES;
    return ![state[@"loading"] boolValue] && [state[@"title"] isEqual:@"Region"];
}

static BOOL regionsLoadEnded(const Region *regions, int count) {
    for (int i = 0; i < count; i++) {
        if (regions[i].document && !regionLoadEnded(&regions[i])) return NO;
    }
    return YES;
}

// The wait after which a scenario whose loads have not ended is a stall. The stall closes the regions whose load ended, so
// the record shows whether the region that waits continues after their WebContent processes end; the scenario then fails.
// A run with --unanswered-region sets 10 seconds, because WebKit ends a request without an answer after about 30 seconds.
static NSTimeInterval stallSeconds = 30;

// Closes the regions whose load ended, waits up to 30 seconds until their WebContent processes end and then up to
// stallSeconds until the other regions end their loads, and writes each result as a stall record line. A region that loads
// after the processes ended waited for a resource that those processes held; a region that still waits holds the resource
// itself or waits for another process.
static void closeEndedRegions(Region *regions, int count) {
    NSMutableArray<NSNumber *> *ended = [NSMutableArray array];
    for (int i = 0; i < count; i++) {
        if (!regions[i].document || !regionLoadEnded(&regions[i])) continue;
        pid_t process = ((WKWebView *)regions[i].document)._webProcessIdentifier;
        printf("stall record: region %d ended its load in process %d and closes\n", i + 1, process);
        stallClosedRegions++;
        if (process > 0 && ![ended containsObject:@(process)]) [ended addObject:@(process)];
        @autoreleasepool {
            sp_document_close(regions[i].document);
        }
        regions[i].document = NULL;
    }
    NSDate *start = [NSDate date];
    BOOL processesEnded = pumpUntil(30, ^BOOL {
        for (NSNumber *process in ended) {
            struct proc_bsdinfo info;
            if (proc_pidinfo(process.intValue, PROC_PIDTBSDINFO, 0, &info, sizeof info) == (int)sizeof info) return NO;
        }
        return YES;
    });
    printf("stall record: the processes %s of the closed regions %s after %.3f s\n", [ended componentsJoinedByString:@","].UTF8String,
        processesEnded ? "ended" : "remain", [NSDate.date timeIntervalSinceDate:start]);
    start = [NSDate date];
    pumpUntil(stallSeconds, ^BOOL { return regionsLoadEnded(regions, count); });
    for (int i = 0; i < count; i++) {
        if (!regions[i].document) continue;
        if (!regionLoadEnded(&regions[i])) stallWaitingRegions++;
        printf("stall record: region %d %s %.3f s after the processes of the closed regions %s\n", i + 1,
            regionLoadEnded(&regions[i]) ? "ended its load" : "still waits", [NSDate.date timeIntervalSinceDate:start],
            processesEnded ? "ended" : "remained");
    }
    fflush(stdout);
}

// The state of the region that a failure names: its WebContent process, loading state, title, address and the error of
// its last navigation, which is none when the navigation did not fail.
static NSString *regionState(WKWebView *view, NSDictionary *state) {
    id error = state[@"error"];
    return [NSString stringWithFormat:@"_webProcessIdentifier %d, loading %@, title \"%@\", URL \"%@\", navigation error \"%@\"",
        view._webProcessIdentifier, view.loading ? @"YES" : @"NO", view.title ?: @"", view.URL.absoluteString ?: @"",
        (!error || error == NSNull.null) ? @"none" : error];
}

// The seconds after which a scenario whose loads have not ended writes the stall record once. The argument
// --stall-record-after=<seconds> sets it, so a run checks the record without a stall.
static NSTimeInterval stallRecordAfter = 30;

// The number of region lines that the stall records wrote, and the number of WebKit log lines that they wrote.
static int stallRecordRegions = 0;
static int stallRecordWebKitLines = 0;

// The number of WebContent processes that the stall records had to sample and the number of samples that ended with
// status 0.
static int stallRecordSampleTargets = 0;
static int stallRecordSamples = 0;

// The number of sampled processes whose open files the stall records listed.
static int stallRecordFileListings = 0;

// The time at which the test started; the stall record writes the WebKit log from this time.
static NSDate *testStart;

// Writes the output of a command of the system into the output of the test. Returns the output, or nil when the command
// cannot start.
static NSString *writeCommand(NSString *path, NSArray<NSString *> *arguments) {
    NSTask *task = [[NSTask new] autorelease];
    task.executableURL = [NSURL fileURLWithPath:path];
    task.arguments = arguments;
    NSPipe *pipe = [NSPipe pipe];
    task.standardOutput = pipe;
    task.standardError = pipe;
    NSError *error = nil;
    if (![task launchAndReturnError:&error]) {
        printf("stall record: %s cannot start: %s\n", path.UTF8String, error.localizedDescription.UTF8String);
        return nil;
    }
    NSData *output = [pipe.fileHandleForReading readDataToEndOfFile];
    [task waitUntilExit];
    printf("stall record: %s %s exit %d\n%.*s\n", path.UTF8String, [arguments componentsJoinedByString:@" "].UTF8String,
        task.terminationStatus, (int)output.length, (const char *)output.bytes);
    return [[[NSString alloc] initWithData:output encoding:NSUTF8StringEncoding] autorelease] ?: @"";
}

// Writes what each region waits for when its load has not ended: its committed and provisional WebContent process, the
// network process, the process counts of the pool, the state of each process, and the WebKit log of the test process, the
// network process and the WebContent processes since the test started. WebKit writes each step of a navigation (its load
// request, its policy decision and the services that the decision waits for) to that log with the page and navigation
// identifiers, so the log names the last step that a region that does not load reached. The record also samples the
// committed and provisional WebContent process of each region that has not ended its load, or of every region when all is
// set: a WebContent process whose log ends inside a call of the main thread shows that call in its stack (F335-2). The main
// thread of a region that did not load waited in flock of a Metal compiler cache file, so the record lists the open files of
// each sampled process and, for each open Metal cache file, every process that has the file open with its lock, and samples
// those processes too.
static void writeStallRecord(const Region *regions, int count, BOOL all) {
    NSMutableArray<NSNumber *> *samples = [NSMutableArray array];
    NSMutableArray<NSString *> *pids = [NSMutableArray array];
    for (int i = 0; i < count; i++) {
        WKWebView *view = (WKWebView *)regions[i].document;
        if (!view) continue;
        // The pool counts the WebContent processes; the declaration is deprecated because a second pool has no effect.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        WKProcessPool *pool = view.configuration.processPool;
#pragma clang diagnostic pop
        BOOL ended = regionsLoadEnded(&regions[i], 1);
        if (!ended || all) {
            for (NSNumber *pid in @[ @(view._webProcessIdentifier), @(view._provisionalWebProcessIdentifier) ]) {
                if (pid.intValue > 0 && ![samples containsObject:pid]) [samples addObject:pid];
            }
        }
        printf("stall record: region %d %s ended %d process %d provisional %d network %d pool processes %zu without prewarmed %zu with pages %zu\n",
            i + 1, regions[i].address.UTF8String, ended, view._webProcessIdentifier, view._provisionalWebProcessIdentifier,
            view._networkProcessIdentifier, pool._webProcessCount, pool._webProcessCountIgnoringPrewarmed, pool._webPageContentProcessCount);
        stallRecordRegions++;
        for (NSNumber *pid in @[ @(view._webProcessIdentifier), @(view._provisionalWebProcessIdentifier), @(view._networkProcessIdentifier) ]) {
            if (pid.intValue > 0 && ![pids containsObject:pid.stringValue]) [pids addObject:pid.stringValue];
        }
    }
    if (pids.count > 0) writeCommand(@"/bin/ps", @[ @"-o", @"pid,ppid,stat,etime,time,command", @"-p", [pids componentsJoinedByString:@","] ]);
    writeCommand(@"/bin/ps", @[ @"-axo", @"pid,ppid,stat,etime,command" ]);
    NSMutableArray<NSString *> *processes = [NSMutableArray arrayWithObject:[NSString stringWithFormat:@"processID == %d", getpid()]];
    for (NSString *pid in pids) [processes addObject:[NSString stringWithFormat:@"processID == %@", pid]];
    NSDateFormatter *format = [[NSDateFormatter new] autorelease];
    format.dateFormat = @"yyyy-MM-dd HH:mm:ss";
    NSString *predicate = [NSString stringWithFormat:@"subsystem == \"com.apple.WebKit\" AND (%@)", [processes componentsJoinedByString:@" OR "]];
    NSString *log = writeCommand(@"/usr/bin/log", @[ @"show", @"--info", @"--style", @"compact", @"--start", [format stringFromDate:testStart], @"--predicate", predicate ]);
    for (NSString *line in [log componentsSeparatedByString:@"\n"]) {
        if ([line containsString:@"[com.apple.WebKit:"]) stallRecordWebKitLines++;
    }
    NSMutableArray<NSString *> *metalFiles = [NSMutableArray array];
    for (NSNumber *pid in samples) {
        NSString *files = writeCommand(@"/usr/sbin/lsof", @[ @"-n", @"-P", @"-p", pid.stringValue ]);
        if ([files containsString:@" txt "]) stallRecordFileListings++;
        for (NSString *line in [files componentsSeparatedByString:@"\n"]) {
            NSRange path = [line rangeOfString:@" /"];
            if (path.location == NSNotFound || ![line containsString:@"com.apple.metal"]) continue;
            NSString *file = [line substringFromIndex:path.location + 1];
            if (![metalFiles containsObject:file]) [metalFiles addObject:file];
        }
    }
    for (NSString *file in metalFiles) {
        NSString *holders = writeCommand(@"/usr/sbin/lsof", @[ @"-n", @"-P", file ]);
        for (NSString *line in [holders componentsSeparatedByString:@"\n"]) {
            NSArray<NSString *> *fields = [line componentsSeparatedByCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
            fields = [fields filteredArrayUsingPredicate:[NSPredicate predicateWithFormat:@"length > 0"]];
            if (fields.count < 2 || [fields[1] intValue] <= 0) continue;
            NSNumber *holder = @([fields[1] intValue]);
            if (![samples containsObject:holder]) [samples addObject:holder];
        }
    }
    stallRecordSampleTargets += (int)samples.count;
    for (NSNumber *pid in samples) {
        NSString *sample = writeCommand(@"/usr/bin/sample", @[ pid.stringValue, @"1" ]);
        if ([sample containsString:@"Call graph:"]) stallRecordSamples++;
    }
    fflush(stdout);
}

// Runs one scenario: four regions in one window, loaded with the addresses, then their processes and footprints.
static NSArray<NSNumber *> *runScenario(NSString *name, NSArray<NSString *> *addresses, NSString *store) {
    printf("scenario %s: %lu regions\n", name.UTF8String, (unsigned long)addresses.count);
    fflush(stdout);
    NSWindow *window = [[[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO] autorelease];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    main.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [window.contentView addSubview:main];
    [window orderFrontRegardless];
    void *surface = sp_surface_create(main);
    check(surface != NULL, @"a logical surface is created for the regions");
    webviewSetFrame(surface, 0, 0, 500, 400);
    webviewSetSurfaceHidden(surface, false);

    Region regions[4];
    // Each region is created in its own pool, so the region keeps only its own references and its close releases it.
    for (int i = 0; i < 4; i++) @autoreleasepool {
        regions[i].address = addresses[i];
        regions[i].state = nil;
        regions[i].document = sp_document_create(surface, store.fileSystemRepresentation, NULL, NULL, NULL, changed, &regions[i]);
        regions[i].process = 0;
        regions[i].footprint = -1;
        check(regions[i].document != NULL, [NSString stringWithFormat:@"region %d is created", i + 1]);
        if (!regions[i].document) continue;
        CGFloat left = 10 + (i % 2) * 250;
        CGFloat top = 10 + (i / 2) * 190;
        sp_document_place(regions[i].document, left, top, 500 - left - 240, 400 - top - 180, true);
        check(sp_document_load(regions[i].document, regions[i].address.UTF8String),
            [NSString stringWithFormat:@"region %d accepts its address %@", i + 1, regions[i].address]);
    }

    // Each region reports its state through changed when a navigation finishes or fails (document_view.m, webView:
    // didFinishNavigation: and fail:) and when its loading or title changes. The wait is bounded by the per-test limit of
    // the runner. A wait longer than stallRecordAfter writes the stall record once; it does not end the wait.
    NSDate *stallAt = [NSDate dateWithTimeIntervalSinceNow:stallRecordAfter];
    NSDate *closeAt = [NSDate dateWithTimeIntervalSinceNow:stallSeconds];
    BOOL stallRecorded = NO;
    while (!regionsLoadEnded(regions, 4)) {
        if (!stallRecorded && stallAt.timeIntervalSinceNow <= 0) {
            writeStallRecord(regions, 4, NO);
            stallRecorded = YES;
        }
        if (closeAt.timeIntervalSinceNow <= 0) {
            // A region whose request the server holds is the stall that the run asked for.
            if (!holdRequests) check(NO, [NSString stringWithFormat:@"the loads of scenario %@ end within %.0f seconds", name, stallSeconds]);
            closeEndedRegions(regions, 4);
            break;
        }
        @autoreleasepool {
            [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
        }
    }
    for (int i = 0; i < 4; i++) {
        WKWebView *view = (WKWebView *)regions[i].document;
        if (!view) continue;
        id error = regions[i].state[@"error"];
        if (error && error != NSNull.null) {
            check(NO, [NSString stringWithFormat:@"region %d navigation fails: %@; state: %@", i + 1, error, regionState(view, regions[i].state)]);
            continue;
        }
        if (holdRequests && i + 1 == unansweredRegion) continue;
        BOOL loaded = ![regions[i].state[@"loading"] boolValue] && [regions[i].state[@"title"] isEqual:@"Region"];
        check(loaded, loaded ? [NSString stringWithFormat:@"region %d loads its page", i + 1]
            : [NSString stringWithFormat:@"region %d loads its page with the title Region; state: %@", i + 1, regionState(view, regions[i].state)]);
    }
    // The state of the last loads settles before the processes are read.
    pumpUntil(0.5, ^BOOL { return NO; });
    // A run with --stall-record-after=0 also writes the record after the loads end, so it samples the WebContent process of
    // every region.
    if (stallRecordAfter == 0) writeStallRecord(regions, 4, YES);

    NSMutableArray<NSNumber *> *processes = [NSMutableArray array];
    for (int i = 0; i < 4; i++) {
        WKWebView *view = (WKWebView *)regions[i].document;
        if (!view) continue;
        regions[i].process = view._webProcessIdentifier;
        regions[i].footprint = regions[i].process > 0 ? physicalFootprint(regions[i].process) : -1;
        check(regions[i].process > 0, [NSString stringWithFormat:@"region %d has a running WebContent process (pid %d)", i + 1, regions[i].process]);
        check(regions[i].footprint >= 0, [NSString stringWithFormat:@"the footprint of the process of region %d is read (%ld bytes)", i + 1, regions[i].footprint]);
        if (regions[i].process > 0 && ![processes containsObject:@(regions[i].process)]) [processes addObject:@(regions[i].process)];
    }

    printf("distinct WebContent processes: %lu\n", (unsigned long)processes.count);
    for (int i = 0; i < 4; i++) {
        printf("region %d origin %s process %d footprint_kb %ld\n", i + 1, regions[i].address.UTF8String,
            regions[i].process, regions[i].footprint / 1024);
    }
    for (NSNumber *process in processes) {
        NSMutableArray<NSString *> *sharing = [NSMutableArray array];
        long footprint = -1;
        for (int i = 0; i < 4; i++) {
            if (regions[i].process != process.intValue) continue;
            [sharing addObject:[NSString stringWithFormat:@"%d", i + 1]];
            footprint = regions[i].footprint;
        }
        printf("process %d regions %s footprint_kb %ld\n", process.intValue,
            [sharing componentsJoinedByString:@","].UTF8String, footprint / 1024);
    }
    fflush(stdout);

    // Every object of the scenario ends here: the regions, the surface and the window. WebKit ends the WebContent processes
    // of the closed regions, and main checks that they end.
    holdRequests = NO;
    for (id connection in heldConnections) nw_connection_cancel((nw_connection_t)connection);
    [heldConnections removeAllObjects];
    for (int i = 0; i < 4; i++) {
        if (regions[i].document) sp_document_close(regions[i].document);
        [regions[i].state release];
        regions[i].state = nil;
    }
    sp_surface_close(surface);
    [window close];
    return processes;
}

// Waits until each WebContent process of a scenario has ended. The scenario closed its regions through sp_document_close,
// the close of the applications, and its autoreleased references ended with its pool, so WebKit ends each process that
// serves no page; a process that stays is a region that its close did not end.
static void checkProcessesEnd(NSArray<NSNumber *> *processes) {
    for (NSNumber *process in processes) {
        pid_t pid = process.intValue;
        NSDate *start = [NSDate date];
        BOOL ended = pumpUntil(30, ^BOOL {
            struct proc_bsdinfo info;
            return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof info) != (int)sizeof info;
        });
        check(ended, [NSString stringWithFormat:@"the WebContent process %d ends after its regions close (%.3f s)", pid, -start.timeIntervalSinceNow]);
    }
}

int main(int argc, char **argv) { @autoreleasepool {
    testStart = [[NSDate date] retain];
    for (int i = 1; i < argc; i++) {
        double seconds = 0;
        int region = 0;
        if (sscanf(argv[i], "--stall-record-after=%lf", &seconds) == 1 && seconds >= 0) {
            stallRecordAfter = seconds;
        } else if (sscanf(argv[i], "--unanswered-region=%d", &region) == 1 && region >= 1 && region <= 4) {
            // The held region is the stall; the record of the full stall is not written, so the run stays within its limit.
            unansweredRegion = region;
            stallRecordAfter = 1e9;
            stallSeconds = 10;
        } else {
            fprintf(stderr, "FAIL: unknown argument %s\n", argv[i]);
            return 2;
        }
    }
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    // Origin A is 127.0.0.1 and origin B is localhost, so the origins differ by host name. Each origin has its own listener
    // on its own port.
    nw_listener_t listenerA = serve();
    nw_listener_t listenerB = serve();
    NSString *originA = [NSString stringWithFormat:@"http://127.0.0.1:%d", nw_listener_get_port(listenerA)];
    NSString *originB = [NSString stringWithFormat:@"http://localhost:%d", nw_listener_get_port(listenerB)];

    // The regions share one data store directory, as the hosts do with the document-data folder of a configuration.
    NSString *root = temporaryFolder(@"soksak-document-processes-");
    NSString *store = [root stringByAppendingPathComponent:@"document-data"];

    // Each scenario runs in its own pool, as each turn of the run loop of the applications does, so its closed regions keep no
    // autoreleased reference after it.
    NSArray<NSNumber *> *processes = nil;
    heldConnections = [[NSMutableArray alloc] init];
    holdRequests = unansweredRegion > 0;
    @autoreleasepool {
        processes = [runScenario(@"two origins",
            @[ [originA stringByAppendingString:@"/region-1"], [originA stringByAppendingString:@"/region-2"],
               [originB stringByAppendingString:@"/region-3"], [originB stringByAppendingString:@"/region-4"] ],
            store) retain];
    }
    checkProcessesEnd(processes);
    [processes release];
    @autoreleasepool {
        processes = [runScenario(@"one origin",
            @[ [originA stringByAppendingString:@"/region-1"], [originA stringByAppendingString:@"/region-2"],
               [originA stringByAppendingString:@"/region-3"], [originA stringByAppendingString:@"/region-4"] ],
            store) retain];
    }
    checkProcessesEnd(processes);
    [processes release];

    // A run with --stall-record-after=0 writes the stall record of each scenario before its loads end and after they end.
    if (stallRecordAfter == 0) {
        check(stallRecordRegions == 16, [NSString stringWithFormat:@"the 4 stall records of both scenarios name 16 regions (named %d)", stallRecordRegions]);
        check(stallRecordSampleTargets >= 8 && stallRecordSamples == stallRecordSampleTargets,
            [NSString stringWithFormat:@"the stall records sample the WebContent processes of the regions (%d of %d sampled)", stallRecordSamples, stallRecordSampleTargets]);
        check(stallRecordFileListings >= 8, [NSString stringWithFormat:@"the stall records list the open files of the sampled processes (%d listed)", stallRecordFileListings]);
        check(stallRecordWebKitLines > 0, [NSString stringWithFormat:@"the stall records write the WebKit log of the loads (%d lines)", stallRecordWebKitLines]);
    }

    if (unansweredRegion) {
        check(stallClosedRegions == 3 && stallWaitingRegions == 1, [NSString stringWithFormat:
            @"the stall closes the 3 regions whose load ended and records that region %d still waits after their processes end (closed %d, waiting %d)",
            unansweredRegion, stallClosedRegions, stallWaitingRegions]);
    }

    nw_listener_cancel(listenerA);
    nw_listener_cancel(listenerB);
    printf("%s\n", failures ? "FAIL: document_processes_benchmark" : "PASS: document_processes_benchmark");
    return failures ? 1 : 0;
}}
