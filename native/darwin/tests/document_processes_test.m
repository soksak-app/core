// Counts the WebContent processes of document regions and states the footprint of each process
// (docs/features.md F196.9.3). Four regions share one persistent data store directory, as the hosts do. The first scenario
// places two regions on one origin and two regions on another origin, and the second scenario places four regions on one
// origin. The check asserts that every region has a running process and that the footprint of each process is read; the
// process counts and the footprints are printed as measurements. The check does not activate the application.
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

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
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
    printf("region %s state event: %s\n", region->address.UTF8String, text);
    fflush(stdout);
    [region->state release];
    region->state = [state retain];
}

// Whether every region with a document has reported the end of its load. A region ends its load when a navigation fails
// (the state carries the error) or when the page is not loading and has its title. The state events also report the
// changes of the loading and title properties, and a page that is not loading can report an empty title before its title
// is set, so the title is part of the end.
static BOOL regionsLoadEnded(const Region *regions, int count) {
    for (int i = 0; i < count; i++) {
        if (!regions[i].document) continue;
        NSDictionary *state = regions[i].state;
        if (!state) return NO;
        id error = state[@"error"];
        if (error && error != NSNull.null) continue;
        if ([state[@"loading"] boolValue] || ![state[@"title"] isEqual:@"Region"]) return NO;
    }
    return YES;
}

// The state of the region that a failure names: its WebContent process, loading state, title, address and the error of
// its last navigation, which is none when the navigation did not fail.
static NSString *regionState(WKWebView *view, NSDictionary *state) {
    id error = state[@"error"];
    return [NSString stringWithFormat:@"_webProcessIdentifier %d, loading %@, title \"%@\", URL \"%@\", navigation error \"%@\"",
        view._webProcessIdentifier, view.loading ? @"YES" : @"NO", view.title ?: @"", view.URL.absoluteString ?: @"",
        (!error || error == NSNull.null) ? @"none" : error];
}

// Runs one scenario: four regions in one window, loaded with the addresses, then their processes and footprints.
static void runScenario(NSString *name, NSArray<NSString *> *addresses, NSString *store) {
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
    for (int i = 0; i < 4; i++) {
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
    // the runner.
    while (!regionsLoadEnded(regions, 4)) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    for (int i = 0; i < 4; i++) {
        WKWebView *view = (WKWebView *)regions[i].document;
        if (!view) continue;
        id error = regions[i].state[@"error"];
        if (error && error != NSNull.null) {
            check(NO, [NSString stringWithFormat:@"region %d navigation fails: %@; state: %@", i + 1, error, regionState(view, regions[i].state)]);
            continue;
        }
        BOOL loaded = ![regions[i].state[@"loading"] boolValue] && [regions[i].state[@"title"] isEqual:@"Region"];
        check(loaded, loaded ? [NSString stringWithFormat:@"region %d loads its page", i + 1]
            : [NSString stringWithFormat:@"region %d loads its page with the title Region; state: %@", i + 1, regionState(view, regions[i].state)]);
    }
    // The state of the last loads settles before the processes are read.
    pumpUntil(0.5, ^BOOL { return NO; });

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

    // Every object of the scenario ends here: the regions, the surface and the window. WebKit keeps an idle WebContent
    // process after its last view closes, so the scenario ends each of its processes; the next scenario then starts without
    // them.
    for (int i = 0; i < 4; i++) {
        if (regions[i].document) sp_document_close(regions[i].document);
        [regions[i].state release];
        regions[i].state = nil;
    }
    sp_surface_close(surface);
    [window close];
    for (NSNumber *process in processes) {
        pid_t pid = process.intValue;
        if (kill(pid, SIGKILL) != 0 && errno != ESRCH) {
            check(NO, [NSString stringWithFormat:@"the WebContent process %d cannot be ended: %s", pid, strerror(errno)]);
            continue;
        }
        check(pumpUntil(10, ^BOOL { return kill(pid, 0) != 0; }),
            [NSString stringWithFormat:@"the WebContent process %d ends after the scenario", pid]);
    }
}

int main(void) { @autoreleasepool {
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

    runScenario(@"two origins",
        @[ [originA stringByAppendingString:@"/region-1"], [originA stringByAppendingString:@"/region-2"],
           [originB stringByAppendingString:@"/region-3"], [originB stringByAppendingString:@"/region-4"] ],
        store);
    runScenario(@"one origin",
        @[ [originA stringByAppendingString:@"/region-1"], [originA stringByAppendingString:@"/region-2"],
           [originA stringByAppendingString:@"/region-3"], [originA stringByAppendingString:@"/region-4"] ],
        store);

    nw_listener_cancel(listenerA);
    nw_listener_cancel(listenerB);
    printf("%s\n", failures ? "FAIL: document_processes_test" : "PASS: document_processes_test");
    return failures ? 1 : 0;
}}
