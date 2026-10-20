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

// An HTTP server on the loopback address that answers every request with the page and closes each connection.
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
    check(pumpUntil(10, ^BOOL { return ready; }), @"a test server is ready within 10 seconds");
    return listener;
}

static void changed(void *context, const char *text) {}

typedef struct {
    NSString *address;
    void *document;
    pid_t process;
    long footprint;
} Region;

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
        regions[i].document = sp_document_create(surface, store.fileSystemRepresentation, NULL, NULL, false, changed, NULL);
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

    for (int i = 0; i < 4; i++) {
        WKWebView *view = (WKWebView *)regions[i].document;
        if (!view) continue;
        BOOL loaded = pumpUntil(10, ^BOOL { return view._webProcessIdentifier != 0 && !view.loading && [view.title isEqual:@"Region"]; });
        check(loaded, [NSString stringWithFormat:@"region %d loads its page within 10 seconds", i + 1]);
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
