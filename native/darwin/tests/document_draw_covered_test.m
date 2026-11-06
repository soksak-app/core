// A document region of a covered window shows its document while the window draws covered (sp_document_draw_covered), so a
// still capture of the covered window holds the document as the capture before the cover does. The state is set once before
// the cover and once while the window is already covered; a region created later in the window takes it; the region of another
// window keeps hiding its document while covered; and after the state ends, the covered region hides its document again
// (docs/spec/native-surfaces.md#document-regions). The check does not activate the application and focuses no window: the
// windows and the cover are ordered front without activation.
#import <Cocoa/Cocoa.h>
#import <Network/Network.h>
#import <WebKit/WebKit.h>
#import "support/temporary_folder.h"
#import "capture.h"
#import "document_view.h"
#import "private/webkit.h"
#import "webview_geometry.h"
#import "window_facts.h"

static int failures = 0;
static const CGFloat kWidth = 500, kHeight = 400;
static const uint32_t kPageColor = 0xc83232, kChangedColor = 0x3278c8;
// The changes run in an animation frame, which a document that WebKit hides does not run, so a capture shows a change only
// when the document draws.
static NSString *const kBlue = @"requestAnimationFrame(() => document.body.style.background = '#3278c8')";
static NSString *const kRed = @"requestAnimationFrame(() => document.body.style.background = '#c83232')";

static void check(BOOL condition, NSString *message) {
    FILE *output = condition ? stdout : stderr;
    fprintf(output, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (fflush(output) != 0) {
        perror("fflush test result");
        failures++;
    }
    if (!condition) failures++;
}

// Runs the application event queue and the run loop for the given time.
static void pump(NSTimeInterval seconds) {
    NSDate *end = [NSDate dateWithTimeIntervalSinceNow:seconds];
    do {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]
            inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event) [NSApp sendEvent:event];
    } while ([end timeIntervalSinceNow] > 0);
}

// Pumps until done answers YES or seconds pass, and returns the last answer.
static BOOL within(NSTimeInterval seconds, BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (!done() && deadline.timeIntervalSinceNow > 0) pump(0.05);
    return done();
}

static void until(NSString *what, BOOL (^done)(void)) {
    if (!within(10, done)) { fprintf(stderr, "FAIL: %s within 10 seconds\n", what.UTF8String); exit(1); }
}

// The page is one static colour.
static NSString *const kPage = @"<!doctype html><title>Covered</title><style>html,body{margin:0;height:100%;background:#c83232}</style>";

// An HTTP server that answers every request with the page and closes the connection.
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
    until(@"the test server did not start", ^BOOL { return ready; });
    return listener;
}

static id evaluate(WKWebView *view, NSString *script) {
    __block BOOL done = NO;
    __block id result = nil;
    [view evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
        result = [value retain];
        done = YES;
    }];
    until(@"JavaScript did not answer", ^BOOL { return done; });
    return [result autorelease];
}

static NSString *visibility(WKWebView *view) {
    return [evaluate(view, @"document.visibilityState") description];
}

// Waits until the document has the visibility, and reports whether it has it.
static BOOL becomes(WKWebView *view, NSString *state) {
    return within(10, ^BOOL { return [visibility(view) isEqual:state]; });
}

static void waitForPresentation(WKWebView *view) {
    __block BOOL presented = NO;
    [view _doAfterNextPresentationUpdate:^{ presented = YES; }];
    check(within(10, ^BOOL { return presented; }), @"the document presents");
    pump(0.5);
}

static void changed(void *context, const char *text) {}

typedef struct {
    NSWindow *window;
    void *surface;
} Window;

// A window with a registered main web view and a shown surface over its whole content.
static Window openWindow(NSRect frame) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:frame styleMask:NSWindowStyleMaskTitled
        backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, kWidth, kHeight)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    main.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [window.contentView addSubview:main];
    [window orderFrontRegardless];
    void *surface = sp_surface_create(sp_window_set_main_webview(window, main));
    check(surface != NULL, @"a surface is created in the window");
    webviewSetFrame(surface, 0, 0, kWidth, kHeight);
    webviewSetSurfaceHidden(surface, false);
    return (Window){window, surface};
}

// A shown document region with the margins (left, top, right, bottom) that loads the page.
static WKWebView *openDocument(Window window, NSString *store, NSString *address, double left, double top, double right,
    double bottom) {
    void *document = sp_document_create(window.surface, store.fileSystemRepresentation, NULL, NULL, NULL, NULL, changed, NULL);
    check(document != NULL, @"a document region is created in the surface");
    if (!document) exit(1);
    sp_document_place(document, left, top, right, bottom, true);
    check(sp_document_load(document, address.UTF8String), @"the local page address is accepted");
    WKWebView *view = (WKWebView *)document;
    until(@"the page did not load", ^BOOL {
        return [[evaluate(view, @"document.readyState") description] isEqual:@"complete"];
    });
    return view;
}

typedef struct { size_t width, height; uint8_t *bytes; } Image;

static Image capture(NSWindow *window, NSString *directory, NSString *name) {
    NSString *path = [directory stringByAppendingPathComponent:[name stringByAppendingString:@".png"]];
    char *error = NULL;
    bool written = sp_capture_still((long[]){window.windowNumber}, 1, path.fileSystemRepresentation, &error);
    check(written && error == NULL, [NSString stringWithFormat:@"the %@ capture has no error (%s)", name, error ?: ""]);
    free(error);
    Image image = {0, 0, NULL};
    if (!written) return image;
    CGImageSourceRef source = CGImageSourceCreateWithData((CFDataRef)[NSData dataWithContentsOfFile:path], NULL);
    CGImageRef decoded = CGImageSourceCreateImageAtIndex(source, 0, NULL);
    image.width = CGImageGetWidth(decoded);
    image.height = CGImageGetHeight(decoded);
    image.bytes = calloc(image.width * image.height, 4);
    CGColorSpaceRef srgb = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(image.bytes, image.width, image.height, 8, image.width * 4, srgb,
        (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
    CGContextSetBlendMode(context, kCGBlendModeCopy);
    CGContextDrawImage(context, CGRectMake(0, 0, image.width, image.height), decoded);
    CGContextRelease(context);
    CGColorSpaceRelease(srgb);
    CGImageRelease(decoded);
    CFRelease(source);
    return image;
}

// x and y are points in the content view from its top left.
static uint32_t pixelAt(Image image, CGFloat scale, CGFloat x, CGFloat y) {
    if (image.bytes == NULL) return 0xffffffff;
    size_t top = image.height - (size_t)(kHeight * scale);
    const uint8_t *p = image.bytes + ((top + (size_t)(y * scale)) * image.width + (size_t)(x * scale)) * 4;
    return (uint32_t)p[0] << 16 | (uint32_t)p[1] << 8 | p[2];
}

// The content view of two captures is the same, byte for byte. The window controls of the title bar draw differently while the
// window is covered, so the title bar is not compared.
static BOOL sameContent(Image a, Image b, CGFloat scale) {
    if (a.bytes == NULL || b.bytes == NULL || a.width != b.width || a.height != b.height) return NO;
    size_t top = a.height - (size_t)(kHeight * scale);
    return memcmp(a.bytes + top * a.width * 4, b.bytes + top * b.width * 4, (a.height - top) * a.width * 4) == 0;
}

// The number of pixels of the content view that differ and the first one, for a failure.
static NSString *differences(Image a, Image b, CGFloat scale) {
    if (a.bytes == NULL || b.bytes == NULL) return @"a capture is missing";
    if (a.width != b.width || a.height != b.height) return [NSString stringWithFormat:@"sizes %zux%zu and %zux%zu", a.width, a.height, b.width, b.height];
    size_t top = a.height - (size_t)(kHeight * scale), count = 0;
    long firstRow = -1, firstColumn = -1;
    for (size_t y = top; y < a.height; y++) {
        for (size_t x = 0; x < a.width; x++) {
            size_t at = (y * a.width + x) * 4;
            if (memcmp(a.bytes + at, b.bytes + at, 4) == 0) continue;
            if (firstRow < 0) { firstRow = y; firstColumn = x; }
            count++;
        }
    }
    return [NSString stringWithFormat:@"%zu pixels differ, the first at row %ld column %ld", count, firstRow, firstColumn];
}

static BOOL occluded(NSWindow *window) {
    return (window.occlusionState & NSWindowOcclusionStateVisible) == 0;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    nw_listener_t listener = serve();
    NSString *address = [NSString stringWithFormat:@"http://127.0.0.1:%d/covered", nw_listener_get_port(listener)];
    // The store directories and the captures are deleted when the test ends.
    NSString *folder = temporaryFolder(@"soksak-document-draw-covered-");
    NSString *store = [folder stringByAppendingPathComponent:@"store"];

    Window first = openWindow(NSMakeRect(120, 120, kWidth, kHeight));
    Window other = openWindow(NSMakeRect(200, 160, kWidth, kHeight));
    // The region of the first window spans x 40 to 280 and y 60 to 260 of the content view.
    WKWebView *region = openDocument(first, store, address, 40, 60, 220, 140);
    WKWebView *otherRegion = openDocument(other, store, address, 40, 60, 220, 140);
    until(@"the windows did not come on screen", ^BOOL { return !occluded(first.window) && !occluded(other.window); });
    check([visibility(region) isEqual:@"visible"] && [visibility(otherRegion) isEqual:@"visible"],
        @"the regions of the uncovered windows show their documents");
    waitForPresentation(region);
    CGFloat scale = first.window.backingScaleFactor;
    // The window controls of a window that has just appeared can still change, so the capture before the cover is taken
    // after they settle.
    pump(3);
    Image uncovered = capture(first.window, folder, @"uncovered");
    check(pixelAt(uncovered, scale, 160, 160) == kPageColor,
        [NSString stringWithFormat:@"the uncovered capture holds the document (%06x)", pixelAt(uncovered, scale, 160, 160)]);

    // Set before the cover.
    check(sp_document_draw_covered(first.window, true), @"the first window draws its document regions while covered");
    NSWindow *cover = [[[NSWindow alloc] initWithContentRect:NSInsetRect(NSUnionRect(first.window.frame, other.window.frame), -40, -40)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO] autorelease];
    [cover setReleasedWhenClosed:NO];
    cover.animationBehavior = NSWindowAnimationBehaviorNone;
    cover.backgroundColor = NSColor.blackColor;
    [cover orderFrontRegardless];
    until(@"the cover did not occlude the windows", ^BOOL { return occluded(first.window) && occluded(other.window); });
    check(becomes(otherRegion, @"hidden"), @"the region of the other covered window hides its document");
    // WebKit hides the document of an occluded window after a delay, so the region stays shown past it.
    pump(3);
    check([visibility(region) isEqual:@"visible"], @"the region of the covered window shows its document when the state was set before the cover");
    waitForPresentation(region);
    Image before = capture(first.window, folder, @"covered-set-before");
    check(sameContent(uncovered, before, scale), [NSString stringWithFormat:
        @"the covered capture with the state set before the cover equals the uncovered capture (%@)", differences(uncovered, before, scale)]);

    // The state ends while the window is covered: the region hides its document and does not draw a change.
    check(sp_document_draw_covered(first.window, false), @"the first window ends drawing its document regions while covered");
    check(becomes(region, @"hidden"), @"the covered region hides its document after the state ends");
    evaluate(region, kBlue);
    pump(1);
    Image ended = capture(first.window, folder, @"covered-ended");
    check(pixelAt(ended, scale, 160, 160) == kPageColor, [NSString stringWithFormat:
        @"the covered capture after the state ends does not show the change of the hidden document (%06x)", pixelAt(ended, scale, 160, 160)]);

    // Set while the window is already covered: the region shows its document and draws the change.
    check(sp_document_draw_covered(first.window, true), @"the covered first window draws its document regions again");
    check(becomes(region, @"visible"), @"the region shows its document when the state is set while the window is covered");
    waitForPresentation(region);
    Image during = capture(first.window, folder, @"covered-set-during");
    check(pixelAt(during, scale, 160, 160) == kChangedColor, [NSString stringWithFormat:
        @"the covered capture with the state set during the cover shows the change (%06x)", pixelAt(during, scale, 160, 160)]);
    evaluate(region, kRed);
    waitForPresentation(region);
    Image restored = capture(first.window, folder, @"covered-restored");
    check(sameContent(uncovered, restored, scale), [NSString stringWithFormat:
        @"the covered capture with the state set during the cover equals the uncovered capture (%@)", differences(uncovered, restored, scale)]);

    // A region created later in the covered window takes the state; the other window keeps hiding its region.
    WKWebView *later = openDocument(first, store, address, 300, 60, 20, 140);
    pump(3);
    check([visibility(later) isEqual:@"visible"], @"a region created while the state is on shows its document while covered");
    waitForPresentation(later);
    Image created = capture(first.window, folder, @"covered-created");
    check(pixelAt(created, scale, 390, 160) == kPageColor,
        [NSString stringWithFormat:@"the covered capture holds the region created later (%06x)", pixelAt(created, scale, 390, 160)]);
    check([visibility(otherRegion) isEqual:@"hidden"], @"the region of the other window still hides its document");

    // A region that already hides its document in a covered window shows it and draws the change made while it was hidden when
    // its window takes the state.
    evaluate(otherRegion, kBlue);
    check(sp_document_draw_covered(other.window, true), @"the other covered window draws its document regions");
    check(becomes(otherRegion, @"visible"), @"the hidden region of the covered window shows its document when the state is set");
    waitForPresentation(otherRegion);
    Image shown = capture(other.window, folder, @"other-shown");
    check(pixelAt(shown, scale, 160, 160) == kChangedColor, [NSString stringWithFormat:
        @"the capture of the other covered window shows the change of its document (%06x)", pixelAt(shown, scale, 160, 160)]);
    check(sp_document_draw_covered(other.window, false), @"the state of the other window ends");
    check(becomes(otherRegion, @"hidden"), @"the region of the other window hides its document again");
    check([visibility(region) isEqual:@"visible"] && [visibility(later) isEqual:@"visible"],
        @"the regions of the first window keep showing their documents");
    check(occluded(first.window) && occluded(other.window), @"the windows stay covered through the check");

    check(sp_document_draw_covered(first.window, false), @"the state of the first window ends");
    check(!NSApp.isActive, @"the application stays inactive");
    [cover close];
    sp_document_close(later);
    sp_document_close(region);
    sp_document_close(otherRegion);
    sp_surface_close(first.surface);
    sp_surface_close(other.surface);
    nw_listener_cancel(listener);
    [first.window close];
    [other.window close];
    [first.window release];
    [other.window release];
    free(uncovered.bytes); free(before.bytes); free(ended.bytes); free(during.bytes); free(restored.bytes); free(created.bytes); free(shown.bytes);
    printf("%s\n", failures ? "FAIL: document_draw_covered_test" : "PASS: document_draw_covered_test");
    return failures ? 1 : 0;
}}
