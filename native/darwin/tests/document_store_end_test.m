// Checks the contract of sp_document_store_close (native/darwin/src/document_view.h): after the store has ended, no WebKit
// process writes into its directory, so the folder stays removed. A page loads cacheable resources over HTTP and plays media, the
// document closes and the store ends at once, while the network cache still holds writes. The check removes the folder and
// watches it for longer than the network cache delays a write. Before the removal it watches the entries of the folder, which the
// media cache of the closed document would change. An absent event has no notification, so this check observes
// for a fixed time and judges only whether the folder came back. A child that leaves its store to the removal of its
// temporary folder shows that the removal ends the store first, and a child that leaves its document open fails.
#import <Cocoa/Cocoa.h>
#import <Network/Network.h>
#import <WebKit/WebKit.h>
#include <removefile.h>
#import "support/temporary_folder.h"
#import "document_view.h"
#import "webview_geometry.h"

static const int resourceCount = 40;
static const NSTimeInterval observation = 3;

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void until(NSString *what, BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:20];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    if (!done()) {
        fprintf(stderr, "FAIL: %s within 20 seconds\n", what.UTF8String);
        exit(1);
    }
}

static NSDictionary *latest;

// One second of 8-bit mono silence at 8000 Hz as a WAV file, which AVFoundation plays through the media cache of the store.
static NSData *silentWave(void) {
    const uint32_t samples = 8000;
    NSMutableData *data = [NSMutableData data];
    uint32_t chunk = 36 + samples, format = 16, rate = 8000, byteRate = 8000, size = samples;
    uint16_t pcm = 1, channels = 1, align = 1, bits = 8;
    [data appendBytes:"RIFF" length:4]; [data appendBytes:&chunk length:4]; [data appendBytes:"WAVEfmt " length:8];
    [data appendBytes:&format length:4]; [data appendBytes:&pcm length:2]; [data appendBytes:&channels length:2];
    [data appendBytes:&rate length:4]; [data appendBytes:&byteRate length:4]; [data appendBytes:&align length:2];
    [data appendBytes:&bits length:2]; [data appendBytes:"data" length:4]; [data appendBytes:&size length:4];
    [data increaseLengthBy:samples];
    return data;
}

static void changed(void *context, const char *text) {
    (void)context;
    [latest release];
    latest = [[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:text length:strlen(text)] options:0 error:nil] retain];
}

static BOOL storeClosed;
static NSString *storeError;

static void recordStoreClosed(void *context, const char *error) {
    (void)context;
    storeClosed = YES;
    if (error) storeError = [@(error) retain];
}

// The page names every resource, and each resource is a cacheable script, so the network cache stores each one.
static void respond(nw_connection_t connection, NSString *request) {
    NSArray<NSString *> *parts = [request componentsSeparatedByString:@" "];
    NSString *path = parts.count >= 2 ? parts[1] : @"";
    NSMutableString *body = [NSMutableString string];
    NSString *type = @"text/javascript";
    if ([path isEqualToString:@"/page"]) {
        type = @"text/html; charset=utf-8";
        [body appendString:@"<!doctype html><title>loading</title>"];
        for (int i = 0; i < resourceCount; i++) [body appendFormat:@"<script src=/resource%d.js></script>", i];
        [body appendString:@"<audio id=audio loop src=/silence.wav></audio><script>audio.addEventListener('playing', () => { document.title = 'loaded'; }); audio.play();</script>"];
    } else {
        [body appendFormat:@"// %@\n", path];
        for (int i = 0; i < 4096; i++) [body appendString:@"// a line of a cacheable script\n"];
    }
    NSData *content = [path isEqualToString:@"/silence.wav"] ? silentWave() : [body dataUsingEncoding:NSUTF8StringEncoding];
    if ([path isEqualToString:@"/silence.wav"]) type = @"audio/wav";
    NSString *head = [NSString stringWithFormat:@"HTTP/1.1 200 OK\r\nContent-Type: %@\r\nContent-Length: %lu\r\n"
        "Cache-Control: public, max-age=86400\r\nConnection: close\r\n\r\n", type, (unsigned long)content.length];
    NSMutableData *response = [[[head dataUsingEncoding:NSUTF8StringEncoding] mutableCopy] autorelease];
    [response appendData:content];
    dispatch_data_t out = dispatch_data_create(response.bytes, response.length, dispatch_get_main_queue(), DISPATCH_DATA_DESTRUCTOR_DEFAULT);
    nw_connection_send(connection, out, NW_CONNECTION_FINAL_MESSAGE_CONTEXT, true, ^(nw_error_t sent) {
        (void)sent;
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
            (void)context; (void)complete; (void)error;
            NSString *request = content ? [[[NSString alloc] initWithData:(NSData *)content encoding:NSUTF8StringEncoding] autorelease] : nil;
            respond(connection, request ?: @"");
        });
    });
    __block BOOL ready = NO;
    nw_listener_set_state_changed_handler(server, ^(nw_listener_state_t state, nw_error_t error) {
        (void)error;
        if (state == nw_listener_state_ready) ready = YES;
    });
    nw_listener_start(server);
    until(@"the test server starts", ^BOOL { return ready; });
    return server;
}

// The window and the server that a document needs, which stay until the process ends.
static void *prepareSurface(void) {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    [window orderBack:nil];
    void *surface = sp_surface_create(main);
    webviewSetFrame(surface, 0, 0, 500, 400);
    webviewSetSurfaceHidden(surface, false);
    return surface;
}

static void *loadPage(void *surface, nw_listener_t listener, NSString *store) {
    void *document = sp_document_create(surface, store.fileSystemRepresentation, NULL, NULL, NULL, changed, NULL);
    check(document != NULL, @"a document region is created");
    sp_document_place(document, 0, 0, 0, 0, true);
    NSString *address = [NSString stringWithFormat:@"http://127.0.0.1:%d/page", nw_listener_get_port(listener)];
    check(sp_document_load(document, address.UTF8String), @"the page starts to load");
    until(@"the page loads its resources", ^BOOL { return [latest[@"title"] isEqual:@"loaded"]; });
    return document;
}

// Watches a path for the observation time and returns the entries under it, or nil while it stays absent.
static NSArray<NSString *> *observeAbsent(NSString *path) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:observation];
    while (deadline.timeIntervalSinceNow > 0 && ![NSFileManager.defaultManager fileExistsAtPath:path]) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    return [NSFileManager.defaultManager fileExistsAtPath:path] ? ([NSFileManager.defaultManager subpathsAtPath:path] ?: @[]) : nil;
}

// The entries under a path with their modification times, which a write of any process changes.
static NSDictionary<NSString *, NSDate *> *entries(NSString *path) {
    NSMutableDictionary<NSString *, NSDate *> *found = [NSMutableDictionary dictionary];
    for (NSString *entry in [NSFileManager.defaultManager subpathsAtPath:path] ?: @[]) {
        NSString *full = [path stringByAppendingPathComponent:entry];
        NSDate *modified = [NSFileManager.defaultManager attributesOfItemAtPath:full error:nil].fileModificationDate;
        if (modified) found[entry] = modified;
    }
    return found;
}

// Watches a path for the observation time and returns its entries at the first change, or nil while they stay the same.
static NSDictionary<NSString *, NSDate *> *observeUnchanged(NSString *path, NSDictionary<NSString *, NSDate *> *before) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:observation];
    while (deadline.timeIntervalSinceNow > 0) {
        NSDictionary<NSString *, NSDate *> *now = entries(path);
        if (![now isEqualToDictionary:before]) return now;
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
    }
    return nil;
}

// A child prints its folder and returns from main with its store open, or with its document also open.
static int child(BOOL leaveOpen) {
    void *surface = prepareSurface();
    nw_listener_t listener = serve();
    NSString *temporary = temporaryFolder(@"soksak-document-store-end-child-");
    printf("%s\n", temporary.fileSystemRepresentation);
    fflush(stdout);
    @autoreleasepool {
        void *document = loadPage(surface, listener, [temporary stringByAppendingPathComponent:@"store"]);
        if (!leaveOpen) sp_document_close(document);
    }
    return 0;
}

static void runChild(const char *self, NSString *mode, int *status, NSString **folder, NSString **message) {
    NSTask *task = [[NSTask new] autorelease];
    task.executableURL = [NSURL fileURLWithPath:@(self)];
    task.arguments = @[ mode ];
    NSPipe *output = [NSPipe pipe], *errors = [NSPipe pipe];
    task.standardOutput = output;
    task.standardError = errors;
    NSError *error = nil;
    if (![task launchAndReturnError:&error]) {
        fprintf(stderr, "FAIL: the child does not start: %s\n", error.localizedDescription.UTF8String);
        exit(1);
    }
    NSData *outputData = [output.fileHandleForReading readDataToEndOfFile];
    NSData *errorData = [errors.fileHandleForReading readDataToEndOfFile];
    [task waitUntilExit];
    *status = task.terminationStatus;
    NSString *printed = [[[NSString alloc] initWithData:outputData encoding:NSUTF8StringEncoding] autorelease];
    *folder = [printed componentsSeparatedByString:@"\n"].firstObject;
    *message = [[[NSString alloc] initWithData:errorData encoding:NSUTF8StringEncoding] autorelease];
}

int main(int argc, char **argv) { @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "--store-open") == 0) return child(NO);
    if (argc == 2 && strcmp(argv[1], "--document-open") == 0) return child(YES);
    void *surface = prepareSurface();
    nw_listener_t listener = serve();
    NSString *temporary = temporaryFolder(@"soksak-document-store-end-");
    NSString *store = [temporary stringByAppendingPathComponent:@"store"];

    // The document and every autoreleased reference to it live in this pool, so the closed document and its data store are
    // released before the store ends.
    @autoreleasepool {
        sp_document_close(loadPage(surface, listener, store));
    }
    sp_document_store_close(store.fileSystemRepresentation, recordStoreClosed, NULL);
    until(@"the data store ends", ^BOOL { return storeClosed; });
    check(storeError == nil, [NSString stringWithFormat:@"the data store ends without an error: %@", storeError]);
    NSDictionary<NSString *, NSDate *> *ended = entries(store);
    NSDictionary<NSString *, NSDate *> *changedEntries = observeUnchanged(store, ended);
    check(changedEntries == nil, [NSString stringWithFormat:@"no process changes the folder of an ended store: %@ became %@", ended, changedEntries]);
    check(removefile(store.fileSystemRepresentation, NULL, REMOVEFILE_RECURSIVE) == 0, @"the folder of the ended store is removed");
    NSArray<NSString *> *written = observeAbsent(store);
    check(written == nil, [NSString stringWithFormat:@"no process writes into the folder of an ended store: %@", written]);

    // A document that loads nothing starts the network process of its store, which creates the network cache after the store
    // ended when the end did not know the process yet.
    NSString *unloaded = [temporaryFolder(@"soksak-document-store-unloaded-") stringByAppendingPathComponent:@"store"];
    void *unloadedSurface = prepareSurface();
    @autoreleasepool {
        void *unloadedDocument = sp_document_create(unloadedSurface, unloaded.fileSystemRepresentation, NULL, NULL, NULL, changed, NULL);
        check(unloadedDocument != NULL, @"a document that loads nothing is created");
        sp_document_close(unloadedDocument);
    }
    sp_surface_close(unloadedSurface);
    storeClosed = NO;
    sp_document_store_close(unloaded.fileSystemRepresentation, recordStoreClosed, NULL);
    until(@"the data store of a document that loaded nothing ended", ^{ return storeClosed; });
    check(removefile(unloaded.fileSystemRepresentation, NULL, REMOVEFILE_RECURSIVE) == 0, @"the folder of a store that loaded nothing is removed");
    NSArray<NSString *> *unloadedWritten = observeAbsent(unloaded);
    check(unloadedWritten == nil, [NSString stringWithFormat:@"no process writes into the folder of a store that loaded nothing: %@", unloadedWritten]);

    // The removal of a temporary folder ends the store under it, so the folder stays removed.
    int status = 0;
    NSString *folder = nil, *message = nil;
    runChild(argv[0], @"--store-open", &status, &folder, &message);
    check(status == 0 && folder.length > 0, [NSString stringWithFormat:@"a child that leaves its store open ends with 0: %d, %@", status, message]);
    written = observeAbsent(folder);
    check(written == nil, [NSString stringWithFormat:@"the removal at exit ends the store first, so no process writes into the folder: %@", written]);
    [NSFileManager.defaultManager removeItemAtPath:folder error:nil];

    // A document that stays open keeps its store, so the removal names it instead of racing with its writes.
    runChild(argv[0], @"--document-open", &status, &folder, &message);
    check(status == 1 && [message containsString:@"a document of the directory is open"],
        [NSString stringWithFormat:@"a child that leaves its document open fails and names the cause: %d, %@", status, message]);
    [NSFileManager.defaultManager removeItemAtPath:folder error:nil];

    nw_listener_cancel(listener);
    printf("%s\n", failures ? "FAIL: document_store_end_test" : "PASS: document_store_end_test");
    return failures ? 1 : 0;
}}
