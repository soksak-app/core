// The caches of a document region (docs/features.md F196.9.4): one document region navigates through 60 pages of one site,
// each with about 2 MB of DOM and a 1 MB image. The physical footprint of the WebContent process of the region is read after
// pages 10, 20, 40 and 60. WebKit caches (the back-forward cache and the memory cache) are bounded, so the footprint after 60
// pages stays below 1.5 times the footprint after 20 pages. The check does not activate the application.
#import <Cocoa/Cocoa.h>
#import <Network/Network.h>
#import <WebKit/WebKit.h>
#import <libproc.h>
#import <string.h>
#import "support/temporary_folder.h"
#import "document_view.h"
#import "private/webkit.h"
#import "webview_geometry.h"
#import "window_facts.h"
#import "support/event_wait.h"

static const int pageCount = 60;
static const int rowsPerPage = 22500;
static const int imageWidth = 512;
static const int imageHeight = 683;
static const double growthLimit = 1.5;

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static double nowSeconds(void) {
    return NSDate.date.timeIntervalSince1970;
}

// Waits as eventWait does and drains the references that the turns autoreleased before each judgment, as each turn of the run
// loop of an application does, so an object that a turn releases ends during the wait.
static void waitDrained(NSString *what, BOOL (^done)(void)) {
    __block NSAutoreleasePool *pool = [NSAutoreleasePool new];
    eventWait(what, ^BOOL {
        [pool drain];
        pool = [NSAutoreleasePool new];
        return done();
    });
    [pool drain];
}

// Waits for the exit of a process that is not a child of the test: a dispatch source of the main queue reports the exit, and a
// process that ended before the source was registered is absent after the registration.
static void waitForExit(pid_t pid) {
    __block BOOL exited = NO;
    dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC, (uintptr_t)pid, DISPATCH_PROC_EXIT,
        dispatch_get_main_queue());
    if (!source) {
        fprintf(stderr, "FAIL: the exit observation of the process %d cannot start\n", pid);
        exit(1);
    }
    dispatch_source_set_event_handler(source, ^{ exited = YES; });
    dispatch_resume(source);
    struct proc_bsdinfo info;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof info) != (int)sizeof info) exited = YES;
    waitDrained([NSString stringWithFormat:@"the WebContent process %d exits", pid], ^BOOL { return exited; });
    dispatch_source_cancel(source);
    dispatch_release(source);
}

// The physical footprint (bytes) of the process, or -1 when the process cannot be read.
static long physicalFootprint(pid_t pid) {
    struct rusage_info_v0 info;
    return proc_pid_rusage(pid, RUSAGE_INFO_V0, (rusage_info_t *)&info) == 0 ? (long)info.ri_phys_footprint : -1;
}

// The latest state report of the document region.
static NSDictionary *latest;

static void changed(void *context, const char *text) {
    NSData *data = [NSData dataWithBytes:text length:strlen(text)];
    [latest release];
    latest = [[NSJSONSerialization JSONObjectWithData:data options:0 error:nil] retain];
}

// The WebContent processes that the document region used, in the order they were first seen. They end when the document
// closes.
static NSMutableArray<NSNumber *> *processes;
static NSString *storeDirectory;
static WKWebView *view;
static void *document;
static void *surface;
static NSWindow *window;
static nw_listener_t listener;

// Closes the document, whose WebContent processes end with the process of the test, then exits with status 1; the store
// is removed at exit.
static void cleanupAndExit(void) {
    if (document) sp_document_close(document);
    document = NULL;
    exit(1);
}

// Exits with the step and the measured state when a step cannot run.
static void failStep(NSString *step, NSString *reason) {
    pid_t process = view ? view._webProcessIdentifier : 0;
    fprintf(stderr, "FAIL: step %s: %s\n", step.UTF8String, reason.UTF8String);
    NSString *state = [NSString stringWithFormat:@"pid=%d footprint=%ld title=%@ loading=%@ url=%@", process,
        process ? physicalFootprint(process) : -1L, latest[@"title"], latest[@"loading"], latest[@"url"]];
    fprintf(stderr, "  state: %s\n", state.UTF8String);
    cleanupAndExit();
}

static id evaluate(WKWebView *web, NSString *script) {
    __block BOOL done = NO;
    __block id result = nil;
    [web evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
        result = [value retain];
        done = YES;
    }];
    waitDrained(@"JavaScript answers", ^BOOL { return done; });
    return [result autorelease];
}

// Waits until the page decoded its image and its fonts are ready, so the footprint counts the allocations of the load.
static void settle(NSString *step) {
    __block BOOL done = NO;
    __block NSError *failure = nil;
    [view callAsyncJavaScript:@"if (document.images.length) await document.images[0].decode(); await document.fonts.ready;"
        arguments:nil inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:^(id value, NSError *error) {
            (void)value;
            failure = [error retain];
            done = YES;
        }];
    waitDrained(@"the page decodes its image", ^BOOL { return done; });
    if (failure) failStep(step, [NSString stringWithFormat:@"the page does not decode its image: %@", failure.localizedDescription]);
}

// The HTML of one page: an image of the page, and about 2 MB of rows of text.
static NSData *pageBody(int page) {
    NSMutableString *html = [NSMutableString stringWithFormat:
        @"<!doctype html><title>Page %d</title><body><img src=\"/image/%d.png\" width=\"%d\" height=\"%d\">",
        page, page, imageWidth, imageHeight];
    for (int row = 0; row < rowsPerPage; row++) {
        [html appendFormat:@"<p class=\"r\">Page %d row %05d lorem ipsum dolor sit amet consectetur adipiscing elit</p>\n",
            page, row];
    }
    [html appendString:@"</body>"];
    return [html dataUsingEncoding:NSUTF8StringEncoding];
}

// A PNG of 1 MB of pseudo-random pixels. The seed is the page number, so the images of the pages differ.
static NSData *imageBody(int page) {
    NSBitmapImageRep *rep = [[[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:imageWidth pixelsHigh:imageHeight
        bitsPerSample:8 samplesPerPixel:3 hasAlpha:NO isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0]
        autorelease];
    unsigned char *pixels = rep.bitmapData;
    uint32_t state = 2654435761u * (uint32_t)(page + 1);
    for (NSInteger i = 0; i < (NSInteger)imageWidth * imageHeight * 3; i++) {
        state = state * 1664525u + 1013904223u;
        pixels[i] = (unsigned char)(state >> 24);
    }
    return [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
}

// Answers the request line of one connection with a page, an image, or 404, and closes the connection after the response.
static void respond(nw_connection_t connection, NSString *request) {
    NSArray<NSString *> *parts = [request componentsSeparatedByString:@" "];
    NSString *path = parts.count >= 2 ? parts[1] : @"";
    int number = 0;
    NSString *status = @"404 Not Found";
    NSString *type = @"text/plain";
    NSData *body = [NSData data];
    if (sscanf(path.UTF8String, "/page/%d", &number) == 1 && number >= 1 && number <= pageCount) {
        status = @"200 OK";
        type = @"text/html; charset=utf-8";
        body = pageBody(number);
    } else if (sscanf(path.UTF8String, "/image/%d.png", &number) == 1 && number >= 1 && number <= pageCount) {
        status = @"200 OK";
        type = @"image/png";
        body = imageBody(number);
    }
    NSString *head = [NSString stringWithFormat:@"HTTP/1.1 %@\r\nContent-Type: %@\r\nContent-Length: %lu\r\nConnection: close\r\n\r\n",
        status, type, (unsigned long)body.length];
    NSMutableData *response = [NSMutableData dataWithData:[head dataUsingEncoding:NSUTF8StringEncoding]];
    [response appendData:body];
    dispatch_data_t out = dispatch_data_create(response.bytes, response.length, dispatch_get_main_queue(), DISPATCH_DATA_DESTRUCTOR_DEFAULT);
    nw_connection_send(connection, out, NW_CONNECTION_FINAL_MESSAGE_CONTEXT, true, ^(nw_error_t sent) {
        nw_connection_cancel(connection);
    });
}

// The listener serves the pages of the site for every request.
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
    waitDrained(@"the test server is ready", ^BOOL { return ready; });
    return server;
}

// Records the WebContent process of the region and returns it. The process changes are printed.
static pid_t currentProcess(int page) {
    pid_t process = view._webProcessIdentifier;
    if (process == 0) failStep([NSString stringWithFormat:@"page %d", page], @"the document has no WebContent process");
    NSNumber *known = processes.lastObject;
    if (!known || known.intValue != process) {
        if (known) fprintf(stdout, "process changed at page %d: %d -> %d\n", page, known.intValue, process);
        [processes addObject:@(process)];
    }
    return process;
}

// The decoded width of the first image of the page, or -1 when the page has no image.
static long decodedImageWidth(void) {
    NSNumber *width = evaluate(view, @"document.images.length ? document.images[0].naturalWidth : -1");
    return [width longValue];
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    processes = [[NSMutableArray alloc] init];

    listener = serve();
    NSString *base = [NSString stringWithFormat:@"http://127.0.0.1:%d/", nw_listener_get_port(listener)];
    fprintf(stdout, "site: %d pages, %d rows of text per page, a %dx%d image per page\n", pageCount, rowsPerPage, imageWidth, imageHeight);
    fprintf(stdout, "page 1 document bytes: %lu\n", (unsigned long)pageBody(1).length);
    fprintf(stdout, "page 1 image bytes: %lu\n", (unsigned long)imageBody(1).length);
    fflush(stdout);

    // The steps run in their own pool, as each turn of the run loop of the applications does, so the closed document keeps no
    // autoreleased reference after it.
    @autoreleasepool {
    window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    main.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [window.contentView addSubview:main];
    [window orderFrontRegardless];
    surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    if (!surface) {
        fprintf(stderr, "FAIL: a logical surface is not created\n");
        return 1;
    }
    webviewSetFrame(surface, 0, 0, 500, 400);
    webviewSetSurfaceHidden(surface, false);

    storeDirectory = temporaryFolder(@"soksak-document-caches-");
    document = sp_document_create(surface, [storeDirectory stringByAppendingPathComponent:@"store"].fileSystemRepresentation,
        NULL, NULL, NULL, NULL, changed, NULL);
    if (!document) {
        fprintf(stderr, "FAIL: a document view is not created inside the surface\n");
        cleanupAndExit();
    }
    view = (WKWebView *)document;
    sp_document_place(document, 10, 20, 30, 40, true);

    NSMutableDictionary<NSNumber *, NSNumber *> *footprints = [NSMutableDictionary dictionary];
    for (int page = 1; page <= pageCount; page++) {
        NSString *step = [NSString stringWithFormat:@"navigate page %d", page];
        fprintf(stdout, "start %s\n", step.UTF8String);
        fflush(stdout);
        double started = nowSeconds();
        NSString *url = [base stringByAppendingFormat:@"page/%d", page];
        if (!sp_document_load(document, url.UTF8String)) failStep(step, @"the page address is refused");
        NSString *title = [NSString stringWithFormat:@"Page %d", page];
        waitDrained([NSString stringWithFormat:@"the region shows %@", title], ^BOOL {
            return latest && [latest[@"title"] isEqual:title] && ![latest[@"loading"] boolValue];
        });
        fprintf(stdout, "end %s elapsed %.3f s\n", step.UTF8String, nowSeconds() - started);
        fflush(stdout);
        pid_t process = currentProcess(page);

        if (page == 10 || page == 20 || page == 40 || page == 60) {
            // The page decodes its image before the footprint is read, so that the allocations of the load are counted.
            settle([NSString stringWithFormat:@"settle page %d", page]);
            process = currentProcess(page);
            long footprint = physicalFootprint(process);
            if (footprint < 0) failStep([NSString stringWithFormat:@"footprint page %d", page], @"proc_pid_rusage did not read the process");
            long width = decodedImageWidth();
            fprintf(stdout, "footprint page %d: pid %d footprint_kb %ld image_width %ld\n", page, process, footprint / 1024, width);
            fflush(stdout);
            footprints[@(page)] = @(footprint);
        }
    }

    long at20 = [footprints[@20] longValue];
    long at60 = [footprints[@60] longValue];
    double ratio = (double)at60 / (double)at20;
    fprintf(stdout, "footprint page 10: %ld KB, page 20: %ld KB, page 40: %ld KB, page 60: %ld KB\n",
        [footprints[@10] longValue] / 1024, at20 / 1024, [footprints[@40] longValue] / 1024, at60 / 1024);
    fprintf(stdout, "growth from page 20 to page 60: %ld KB (ratio %.3f, limit %.2f)\n", (at60 - at20) / 1024, ratio, growthLimit);
    check(at60 < growthLimit * at20,
        [NSString stringWithFormat:@"the footprint after 60 pages is below 1.5 times the footprint after 20 pages (%ld KB against %ld KB, ratio %.3f)",
            at60 / 1024, at20 / 1024, ratio]);
    check(!NSApp.isActive, @"the application stays inactive");

    // Cleanup: the document, its surface and window, and the server; the store is removed at exit.
    sp_document_close(document);
    document = NULL;
    view = nil;
    sp_surface_close(surface);
    [window close];
    [window release];
    }
    // The close of the document is the end of its page, so WebKit ends every WebContent process that the region used.
    fprintf(stdout, "closed document processes: %s\n", [processes componentsJoinedByString:@" "].UTF8String);
    for (NSNumber *pid in processes) {
        NSDate *start = [NSDate date];
        waitForExit(pid.intValue);
        check(YES, [NSString stringWithFormat:@"the WebContent process %d ends after the document closes (%.3f s)", pid.intValue, -start.timeIntervalSinceNow]);
    }
    nw_listener_cancel(listener);
    printf("%s\n", failures ? "FAIL: document_caches_test" : "PASS: document_caches_test");
    return failures ? 1 : 0;
}}
