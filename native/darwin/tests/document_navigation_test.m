// Checks that a document region opens each new document of its main frame in a new WebContent process and that the
// previous process ends (docs/spec/native-surfaces.md#document-regions). WebKit keeps a document replaced in the same
// process until memory pressure because of the querySelectorAll result cache (docs/operations/private-native-apis.md),
// so the previous document is released only when its process ends. The region loads a page that the test serves and
// loads the same address three more times. After each navigation the check requires a new process, the end of the
// previous process, a reset of the element stream and a snapshot from the region script in the new document, which
// shows that the user scripts and message handlers of the region work in the new process. The check does not activate
// the application.
#import <Cocoa/Cocoa.h>
#import <Network/Network.h>
#import <WebKit/WebKit.h>
#import <signal.h>
#import <errno.h>
#import <string.h>
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

static NSString *const kPage = @"<!doctype html><title>Region</title><body><p class=\"item\">region</p></body>";

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
    if (!pumpUntil(10, ^BOOL { return ready; })) {
        fprintf(stderr, "FAIL: a test server is ready within 10 seconds\n");
        exit(1);
    }
    return listener;
}

static void changed(void *context, const char *text) {}

// The element stream messages that the region sent.
static int resets = 0;
static int snapshots = 0;

// Counts the reset and snapshot messages of the element stream and acknowledges each snapshot.
static void streamMessage(void *context, const char *json) {
    NSData *data = [NSData dataWithBytes:json length:strlen(json)];
    NSDictionary *value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![value isKindOfClass:NSDictionary.class] || ![value[@"stream"] isEqual:@"elements"]) return;
    NSDictionary *message = value[@"message"];
    if ([message[@"type"] isEqual:@"reset"]) resets++;
    if ([message[@"type"] isEqual:@"snapshot"]) {
        snapshots++;
        if (!sp_document_stream_ack(context, [message[@"seq"] unsignedLongLongValue])) {
            check(NO, [NSString stringWithFormat:@"the region accepts the acknowledgement of snapshot %@", message[@"seq"]]);
        }
    }
}

// Ends the process and waits until it is gone.
static void endProcess(pid_t pid) {
    if (pid <= 0) return;
    if (kill(pid, SIGKILL) != 0 && errno != ESRCH) {
        check(NO, [NSString stringWithFormat:@"the WebContent process %d cannot be ended: %s", pid, strerror(errno)]);
        return;
    }
    check(pumpUntil(10, ^BOOL { return kill(pid, 0) != 0; }), [NSString stringWithFormat:@"the WebContent process %d ends", pid]);
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    nw_listener_t listener = serve();
    NSString *address = [NSString stringWithFormat:@"http://127.0.0.1:%d/region", nw_listener_get_port(listener)];
    NSString *store = [NSTemporaryDirectory() stringByAppendingPathComponent:
        [NSString stringWithFormat:@"soksak-document-navigation-%d", getpid()]];

    NSWindow *window = [[[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO] autorelease];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    main.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [window.contentView addSubview:main];
    [window orderFrontRegardless];
    void *surface = sp_surface_create(main);
    check(surface != NULL, @"a logical surface is created for the region");
    if (!surface) return 1;
    webviewSetFrame(surface, 0, 0, 500, 400);
    webviewSetSurfaceHidden(surface, false);

    void *document = sp_document_create(surface, store.fileSystemRepresentation, NULL, NULL, changed, NULL);
    check(document != NULL, @"a document region is created");
    if (!document) return 1;
    WKWebView *view = (WKWebView *)document;
    sp_document_place(document, 10, 10, 10, 10, true);
    sp_document_set_stream(document, streamMessage, document);
    check(sp_document_stream_on(document, "elements", true), @"the element stream turns on");

    check(sp_document_load(document, address.UTF8String), @"the region accepts the address");
    check(pumpUntil(10, ^BOOL { return view._webProcessIdentifier != 0 && !view.loading && [view.title isEqual:@"Region"]; }),
        @"the region loads the page within 10 seconds");
    check(pumpUntil(10, ^BOOL { return snapshots >= 1; }), @"the region sends a snapshot of the first document");

    NSMutableArray<NSNumber *> *processes = [NSMutableArray arrayWithObject:@(view._webProcessIdentifier)];
    for (int load = 1; load <= 3; load++) {
        pid_t previous = view._webProcessIdentifier;
        int resetsBefore = resets;
        int snapshotsBefore = snapshots;
        check(sp_document_load(document, address.UTF8String), [NSString stringWithFormat:@"load %d: the region accepts the address", load]);
        BOOL loaded = pumpUntil(10, ^BOOL { return view.loading; }) &&
            pumpUntil(10, ^BOOL { return !view.loading && [view.title isEqual:@"Region"]; });
        check(loaded, [NSString stringWithFormat:@"load %d: the page loads within 10 seconds", load]);
        pid_t current = view._webProcessIdentifier;
        if (current > 0 && ![processes containsObject:@(current)]) [processes addObject:@(current)];
        check(current != 0 && current != previous, [NSString stringWithFormat:
            @"load %d: the document opens in a new WebContent process (previous %d, current %d)", load, previous, current]);
        if (current != previous) {
            check(pumpUntil(10, ^BOOL { return kill(previous, 0) != 0; }), [NSString stringWithFormat:
                @"load %d: the previous WebContent process %d ends within 10 seconds", load, previous]);
        }
        check(resets == resetsBefore + 1, [NSString stringWithFormat:@"load %d: the element stream sends one reset (%d)", load,
            resets - resetsBefore]);
        check(pumpUntil(10, ^BOOL { return snapshots > snapshotsBefore; }), [NSString stringWithFormat:
            @"load %d: the region script sends a snapshot of the new document", load]);
    }
    printf("distinct WebContent processes: %lu\n", (unsigned long)processes.count);

    sp_document_close(document);
    sp_surface_close(surface);
    [window close];
    for (NSNumber *process in processes) {
        if (kill(process.intValue, 0) == 0) endProcess(process.intValue);
    }
    if (main._webProcessIdentifier != 0) endProcess(main._webProcessIdentifier);
    nw_listener_cancel(listener);
    NSError *error = nil;
    if ([NSFileManager.defaultManager fileExistsAtPath:store]) {
        check([NSFileManager.defaultManager removeItemAtPath:store error:&error],
            [NSString stringWithFormat:@"the data store directory is removed: %@", error.localizedDescription ?: @"removed"]);
    }
    printf("%s\n", failures ? "FAIL: document_navigation_test" : "PASS: document_navigation_test");
    return failures ? 1 : 0;
}}
