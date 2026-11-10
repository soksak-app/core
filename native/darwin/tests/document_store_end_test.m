// Checks the contract of sp_document_store_close (native/darwin/src/document_view.h): after the store has ended, no WebKit
// process writes into its directory, so the folder stays removed. A page loads cacheable resources over HTTP and plays media, the
// document closes and the store ends at once, while the network cache still holds writes. The WebContent process of the document,
// the network process that keeps the network cache and the GPU process that keeps the media cache are the processes that write
// into the folder. An absent write has no notification, so the check judges the folder after each of those processes has ended:
// a process that ended writes nothing more. It judges that the entries of the folder stayed the same, which the media cache of
// the closed document would change, and that the removed folder did not come back. A child that leaves its store to the removal
// of its temporary folder shows that the removal ends the store first, and a child that leaves its document open fails.
#import <Cocoa/Cocoa.h>
#import <Network/Network.h>
#import <WebKit/WebKit.h>
#include <errno.h>
#include <removefile.h>
#include <signal.h>
#import "support/event_wait.h"
#import "support/temporary_folder.h"
#import "document_view.h"
#import "private/webkit.h"
#import "webview_geometry.h"
#import "window_facts.h"

static const int resourceCount = 40;

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// The processes of a document that write into the folder of its store; 0 names a process that does not exist, such as the GPU
// process of a system that plays media in the WebContent process.
typedef struct {
    pid_t content;
    pid_t network;
    pid_t gpu;
} Writers;

// Waits for the exit of the process pid, which its dispatch source reports on the main queue.
static void awaitExit(pid_t pid, NSString *name) {
    if (pid <= 0) return;
    __block BOOL ended = NO;
    dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC, (uintptr_t)pid, DISPATCH_PROC_EXIT,
        dispatch_get_main_queue());
    dispatch_source_set_event_handler(source, ^{ ended = YES; });
    dispatch_resume(source);
    // A process that ended before the registration reports no exit, and a process that does not exist after it has ended.
    if (kill(pid, 0) != 0 && errno == ESRCH) ended = YES;
    eventWait([NSString stringWithFormat:@"the %@ process %d ends", name, pid], ^BOOL { return ended; });
    dispatch_source_cancel(source);
    dispatch_release(source);
}

// Waits until every process that wrote into the folder of the store has ended, so none of them writes anything more.
static void awaitWriters(Writers writers) {
    awaitExit(writers.content, @"WebContent");
    awaitExit(writers.network, @"network");
    awaitExit(writers.gpu, @"GPU");
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
    eventWait(@"the test server starts", ^BOOL { return ready; });
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
    void *surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    webviewSetFrame(surface, 0, 0, 500, 400);
    webviewSetSurfaceHidden(surface, false);
    return surface;
}

// Loads the page, which plays its media, and stores the processes that the loaded document writes with.
static void *loadPage(void *surface, nw_listener_t listener, NSString *store, Writers *writers) {
    void *document = sp_document_create(surface, store.fileSystemRepresentation, NULL, NULL, NULL, NULL, changed, NULL);
    check(document != NULL, @"a document region is created");
    sp_document_place(document, 0, 0, 0, 0, true);
    NSString *address = [NSString stringWithFormat:@"http://127.0.0.1:%d/page", nw_listener_get_port(listener)];
    check(sp_document_load(document, address.UTF8String), @"the page starts to load");
    eventWait(@"the page loads its resources", ^BOOL { return [latest[@"title"] isEqual:@"loaded"]; });
    WKWebView *view = (WKWebView *)document;
    *writers = (Writers){ .content = view._webProcessIdentifier, .network = view._networkProcessIdentifier, .gpu = view._gpuProcessIdentifier };
    check(writers->content > 0 && writers->network > 0,
        [NSString stringWithFormat:@"the loaded document names its WebContent and network processes (GPU %d): %d %d %d", writers->gpu,
            writers->content, writers->network, writers->gpu]);
    return document;
}

// The entries under a path, or nil while it is absent.
static NSArray<NSString *> *present(NSString *path) {
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

// A child prints its folder and then the processes of its document, and returns from main with its store open, or with its
// document also open.
static int child(BOOL leaveOpen) {
    void *surface = prepareSurface();
    nw_listener_t listener = serve();
    NSString *temporary = temporaryFolder(@"soksak-document-store-end-child-");
    printf("%s\n", temporary.fileSystemRepresentation);
    fflush(stdout);
    @autoreleasepool {
        Writers writers = {0};
        void *document = loadPage(surface, listener, [temporary stringByAppendingPathComponent:@"store"], &writers);
        printf("%d %d %d\n", writers.content, writers.network, writers.gpu);
        fflush(stdout);
        if (!leaveOpen) sp_document_close(document);
    }
    return 0;
}

static void runChild(const char *self, NSString *mode, int *status, NSString **folder, Writers *writers, NSString **message) {
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
    NSArray<NSString *> *lines = [printed componentsSeparatedByString:@"\n"];
    *folder = lines.firstObject;
    NSArray<NSString *> *pids = lines.count > 1 ? [lines[1] componentsSeparatedByString:@" "] : @[];
    *writers = pids.count == 3 ? (Writers){ .content = pids[0].intValue, .network = pids[1].intValue, .gpu = pids[2].intValue }
        : (Writers){0};
    *message = [[[NSString alloc] initWithData:errorData encoding:NSUTF8StringEncoding] autorelease];
}

int main(int argc, char **argv) { @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "--store-open") == 0) return child(NO);
    if (argc == 2 && strcmp(argv[1], "--document-open") == 0) return child(YES);
    void *surface = prepareSurface();
    nw_listener_t listener = serve();
    NSString *temporary = temporaryFolder(@"soksak-document-store-end-");
    NSString *store = [temporary stringByAppendingPathComponent:@"store"];

    Writers writers = {0};
    // The document and every autoreleased reference to it live in this pool, so the closed document and its data store are
    // released before the store ends.
    @autoreleasepool {
        sp_document_close(loadPage(surface, listener, store, &writers));
    }
    sp_document_store_close(store.fileSystemRepresentation, recordStoreClosed, NULL);
    eventWait(@"the data store ends", ^BOOL { return storeClosed; });
    check(storeError == nil, [NSString stringWithFormat:@"the data store ends without an error: %@", storeError]);
    // The entries are read at the end of the store and judged again after every process that wrote them has ended.
    NSDictionary<NSString *, NSDate *> *ended = entries(store);
    awaitWriters(writers);
    NSDictionary<NSString *, NSDate *> *afterWriters = entries(store);
    check([afterWriters isEqualToDictionary:ended],
        [NSString stringWithFormat:@"no process changes the folder of an ended store: %@ became %@", ended, afterWriters]);
    check(removefile(store.fileSystemRepresentation, NULL, REMOVEFILE_RECURSIVE) == 0, @"the folder of the ended store is removed");
    NSArray<NSString *> *written = present(store);
    check(written == nil, [NSString stringWithFormat:@"no process writes into the folder of an ended store: %@", written]);

    // A document that loads nothing starts the network process of its store, which creates the network cache after the store
    // ended when the end did not know the process yet. The end starts that process itself, so the check cannot name it before
    // the end: the end reports an error when it cannot name the process, and it reports only after the exit of the network
    // process and of the GPU process, so the folder is judged at that report.
    NSString *unloaded = [temporaryFolder(@"soksak-document-store-unloaded-") stringByAppendingPathComponent:@"store"];
    void *unloadedSurface = prepareSurface();
    @autoreleasepool {
        void *unloadedDocument = sp_document_create(unloadedSurface, unloaded.fileSystemRepresentation, NULL, NULL, NULL, NULL, changed, NULL);
        check(unloadedDocument != NULL, @"a document that loads nothing is created");
        sp_document_close(unloadedDocument);
    }
    sp_surface_close(unloadedSurface);
    storeClosed = NO;
    [storeError release];
    storeError = nil;
    sp_document_store_close(unloaded.fileSystemRepresentation, recordStoreClosed, NULL);
    eventWait(@"the data store of a document that loaded nothing ends", ^BOOL { return storeClosed; });
    check(storeError == nil, [NSString stringWithFormat:@"the data store of a document that loaded nothing ends without an error: %@", storeError]);
    check(removefile(unloaded.fileSystemRepresentation, NULL, REMOVEFILE_RECURSIVE) == 0, @"the folder of a store that loaded nothing is removed");
    NSArray<NSString *> *unloadedWritten = present(unloaded);
    check(unloadedWritten == nil, [NSString stringWithFormat:@"no process writes into the folder of a store that loaded nothing: %@", unloadedWritten]);

    // The removal of a temporary folder ends the store under it, so the folder stays removed.
    int status = 0;
    NSString *folder = nil, *message = nil;
    Writers childWriters = {0};
    runChild(argv[0], @"--store-open", &status, &folder, &childWriters, &message);
    check(status == 0 && folder.length > 0, [NSString stringWithFormat:@"a child that leaves its store open ends with 0: %d, %@", status, message]);
    check(childWriters.content > 0 && childWriters.network > 0,
        [NSString stringWithFormat:@"the child names the processes of its document: %d %d %d", childWriters.content,
            childWriters.network, childWriters.gpu]);
    awaitWriters(childWriters);
    written = present(folder);
    check(written == nil, [NSString stringWithFormat:@"the removal at exit ends the store first, so no process writes into the folder: %@", written]);
    [NSFileManager.defaultManager removeItemAtPath:folder error:nil];

    // A document that stays open keeps its store, so the removal names it instead of racing with its writes.
    runChild(argv[0], @"--document-open", &status, &folder, &childWriters, &message);
    check(status == 1 && [message containsString:@"a document of the directory is open"],
        [NSString stringWithFormat:@"a child that leaves its document open fails and names the cause: %d, %@", status, message]);
    [NSFileManager.defaultManager removeItemAtPath:folder error:nil];

    nw_listener_cancel(listener);
    printf("%s\n", failures ? "FAIL: document_store_end_test" : "PASS: document_store_end_test");
    return failures ? 1 : 0;
}}
