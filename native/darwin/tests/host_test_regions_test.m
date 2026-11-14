// Checks the reads of the production library that the host test API declares (tests/support/host_test_api.h): the number of image
// region views of a window, the key wait of a window, the present of a frame into a lease region and the end of a data store. It links the production library
// and the host test API into one process, as a Go host test does. It opens a window behind the other windows and does not activate the
// application.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include <removefile.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <unistd.h>
#import "document_view.h"
#import "event_ring.h"
#import "image_region.h"
#import "surface_layout.h"
#import "webview_geometry.h"
#import "window_facts.h"
#import "support/host_test_api.h"
#import "support/surface_view.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void ignoreEvent(void *context, const char *json) { (void)context; (void)json; }

static NSMutableArray<NSString *> *releases;

// Ends the data store of directory through the host test API on a thread that is not the main thread, as a Go host test does from
// its goroutine, and runs the main run loop, which runs the end, until the call returned. Returns NULL or a copy of the error that
// the caller releases with free.
static char *endStore(const char *directory) {
    __block char *failure = NULL;
    __block atomic_bool returned = false;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        const char *refusal = sp_host_test_document_store_close(directory);
        failure = refusal ? strdup(refusal) : NULL;
        atomic_store(&returned, true);
        // The block on the main queue is the source whose handling ends the run of the loop below after the return.
        dispatch_async(dispatch_get_main_queue(), ^{});
    });
    while (!atomic_load(&returned)) CFRunLoopRunInMode(kCFRunLoopDefaultMode, 1e10, true);
    return failure;
}

static void released(void *context, uint64_t generation, uint64_t raster, int sequence) {
    (void)context;
    [releases addObject:[NSString stringWithFormat:@"%llu/%llu/%d", generation, raster, sequence]];
}

int main(int argc, char **argv) { @autoreleasepool {
    (void)argc; (void)argv;
    releases = [NSMutableArray array];
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
    WKWebView *view = [[[WKWebView alloc] initWithFrame:NSZeroRect] autorelease];
    [window orderBack:nil];
    bool waitingBefore = false, decisionBefore = false, modalBefore = false;
    check(sp_host_test_window_keys_wait((uintptr_t)window, &waitingBefore, &decisionBefore, &modalBefore) != NULL,
        @"a read before the production functions are installed is refused");
    check(sp_host_test_install_production_functions((uintptr_t)surfaceLayoutKeysWaitState, (uintptr_t)surfaceLayoutKeysWaitOpen,
        (uintptr_t)sp_region_raster, (uintptr_t)sp_region_present, (uintptr_t)sp_event, 0) != NULL, @"a missing production function is refused");
    check(sp_host_test_install_production_functions((uintptr_t)surfaceLayoutKeysWaitState, (uintptr_t)surfaceLayoutKeysWaitOpen,
        (uintptr_t)sp_region_raster, (uintptr_t)sp_region_present, (uintptr_t)sp_event, (uintptr_t)sp_document_store_close) == NULL, @"the production functions install");
    check(sp_host_test_install_production_functions((uintptr_t)surfaceLayoutKeysWaitState, (uintptr_t)surfaceLayoutKeysWaitOpen,
        (uintptr_t)sp_region_raster, (uintptr_t)sp_region_present, (uintptr_t)sp_event, (uintptr_t)sp_document_store_close) != NULL, @"a second installation is refused");
    void *surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    check(surface != NULL && SPPlaceSurfaceView(surface, view), @"the main webview creates the surface and the view web view is placed in it");
    webviewSetFrame(surface, 0, 0, 500, 400);
    webviewSetSurfaceHidden(surface, false);

    // The count of the image region views.
    uint64_t count = 99;
    check(sp_host_test_window_image_regions((uintptr_t)window, &count) == NULL && count == 0, @"a window without an image region holds none");
    void *lease = sp_region_create(surface, "lease", ignoreEvent, NULL);
    sp_region_lease(lease, released, NULL);
    check(sp_host_test_window_image_regions((uintptr_t)window, &count) == NULL && count == 1, @"a window holds the image region that it created");
    check(sp_host_test_window_image_regions((uintptr_t)0, &count) != NULL && sp_host_test_window_image_regions((uintptr_t)window, NULL) != NULL,
        @"the count refuses a missing window and a missing address");

    // The present of a lease frame.
    check(sp_host_test_region_present_lease(lease, 5, 1, 1) != NULL, @"a region that is not placed has no raster, and the present is refused");
    sp_region_place(lease, 10, 20, 120, 80, true);
    check(sp_host_test_region_present_lease(lease, 5, 1, 1) == NULL, @"the placed lease region accepts the frame of the test");
    check(releases.count == 0, [NSString stringWithFormat:@"the presented frame is not released: %@", releases]);
    check(sp_host_test_region_present_lease(lease, 5, 1, 2) == NULL && [releases isEqual:@[@"5/1/1"]],
        [NSString stringWithFormat:@"a later frame releases the identity of the frame that it replaced: %@", releases]);
    check(sp_host_test_region_present_lease(NULL, 5, 1, 3) != NULL, @"the present refuses a missing region");

    // The key wait.
    bool waiting = true, decision = true, modal = true;
    check(sp_host_test_window_keys_wait((uintptr_t)window, &waiting, &decision, &modal) == NULL && !waiting && !decision && !modal,
        @"a window without a key wait reports none");
    surfaceLayoutKeysWaitForModal(window);
    check(sp_host_test_window_keys_wait((uintptr_t)window, &waiting, &decision, &modal) == NULL && waiting && !decision && modal,
        @"the wait for a modal is a key wait that does not wait for the decision");
    surfaceLayoutKeysModalEnded(window);
    check(sp_host_test_window_keys_wait((uintptr_t)window, &waiting, &decision, &modal) == NULL && !waiting && !modal,
        @"the end of the wait for the modal ends the key wait");
    // A press outside the surfaces is a press on the workbench.
    webviewSetFrame(surface, 0, 0, 300, 400);
    surfaceLayoutPointerPassing(window, true, 450, 200);
    surfaceLayoutPointerPassing(window, false, 450, 200);
    check(sp_host_test_window_keys_wait((uintptr_t)window, &waiting, &decision, &modal) == NULL && waiting && decision && !modal,
        @"the release of a press on the workbench opens the wait for the decision");
    surfaceLayoutKeysDecided(window);
    check(sp_host_test_window_keys_wait((uintptr_t)window, &waiting, &decision, &modal) == NULL && !waiting && !decision,
        @"the decided call ends the wait for the decision");
    check(sp_host_test_window_open_key_wait((uintptr_t)window, true) == NULL
        && sp_host_test_window_keys_wait((uintptr_t)window, &waiting, &decision, &modal) == NULL && waiting && decision && !modal,
        @"the opener of the test opens the wait for the decision as a press and release does");
    surfaceLayoutKeysDecided(window);
    check(sp_host_test_window_open_key_wait((uintptr_t)window, false) == NULL
        && sp_host_test_window_keys_wait((uintptr_t)window, &waiting, &decision, &modal) == NULL && waiting && !decision && !modal,
        @"the opener of the test opens a wait that does not wait for the decision");
    surfaceLayoutKeysDecided(window);
    check(sp_host_test_window_open_key_wait((uintptr_t)0, true) != NULL, @"the opener refuses a missing window");
    check(sp_host_test_window_keys_wait((uintptr_t)0, &waiting, &decision, &modal) != NULL && sp_host_test_window_keys_wait((uintptr_t)window, NULL, &decision, &modal) != NULL,
        @"the key wait read refuses a missing window and a missing address");

    // The end of a data store.
    check(sp_host_test_document_store_close("/tmp") != NULL, @"the end of a data store refuses the main thread, which runs the end");
    NSString *template = [NSTemporaryDirectory() stringByAppendingPathComponent:@"soksak-host-test-store-XXXXXX"];
    char *store = strdup(template.fileSystemRepresentation);
    check(mkdtemp(store) != NULL, @"the folder of the data store is created");
    char *failure = NULL;
    // The store ends when the last reference to it goes, so the references that the document autoreleases go with this pool.
    @autoreleasepool {
        void *document = sp_document_create(surface, store, NULL, NULL, NULL, NULL, ignoreEvent, NULL);
        check(document != NULL, @"a document of the data store is created");
        failure = endStore(store);
        check(failure != NULL && strstr(failure, "a document of the directory is open") != NULL,
            [NSString stringWithFormat:@"the end of a data store with an open document reports the refusal: %s", failure ?: "none"]);
        free(failure);
        sp_document_close(document);
    }
    failure = endStore(store);
    check(failure == NULL, [NSString stringWithFormat:@"the data store of the closed document ends: %s", failure ?: "none"]);
    free(failure);
    check(removefile(store, NULL, REMOVEFILE_RECURSIVE) == 0 && access(store, F_OK) != 0, @"the folder of the ended data store is removed");
    failure = endStore("relative");
    check(failure != NULL && strstr(failure, "not an absolute path") != NULL,
        [NSString stringWithFormat:@"the end of a data store reports the refusal of a relative directory: %s", failure ?: "none"]);
    free(failure);
    free(store);

    sp_region_close(lease);
    check([releases isEqual:@[@"5/1/1", @"5/1/2"]], [NSString stringWithFormat:@"the close releases the identity that the test presented: %@", releases]);
    check(sp_host_test_window_image_regions((uintptr_t)window, &count) == NULL && count == 0, @"the closed region leaves the window");
    return failures ? 1 : 0;
}}
