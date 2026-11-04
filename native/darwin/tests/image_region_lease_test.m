// Checks the lease presentation mode of an image region (docs/spec/native-surfaces.md#image-regions): the image layer
// presents the IOSurface of the supplier itself, and the region reports each surface that it stops holding, once, when a
// later frame replaces it or the region closes; a refused frame is never reported, and a region in the copy mode keeps
// presenting a host-owned copy. It opens a window behind the other windows and does not activate the application.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <IOSurface/IOSurface.h>
#import <CoreVideo/CoreVideo.h>
#import "image_region.h"
#import "webview_geometry.h"
#import "window_facts.h"
#import "support/surface_view.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void ignoreEvent(void *context, const char *json) {
    (void)context; (void)json;
}

static NSMutableArray<NSString *> *releases;

static void released(void *context, uint64_t generation, uint64_t raster, int sequence) {
    (void)context;
    [releases addObject:[NSString stringWithFormat:@"%llu/%llu/%d", generation, raster, sequence]];
}

static IOSurfaceRef createSurface(size_t width, size_t height, unsigned char *nonce) {
    IOSurfaceRef surface = IOSurfaceCreate((CFDictionaryRef)@{
        (id)kIOSurfaceWidth: @(width),
        (id)kIOSurfaceHeight: @(height),
        (id)kIOSurfaceBytesPerElement: @4,
        (id)kIOSurfacePixelFormat: @(kCVPixelFormatType_32BGRA),
    });
    if (!surface) return NULL;
    arc4random_buf(nonce, 16);
    CFDataRef nonceData = CFDataCreate(NULL, nonce, 16);
    IOSurfaceSetValue(surface, CFSTR("soksak.frame"), nonceData);
    CFRelease(nonceData);
    return surface;
}

// The identifier of the IOSurface that the image layer of the region presents, or 0 when it presents none.
static IOSurfaceID presentedSurface(void *region) {
    CALayer *imageLayer = ((NSView *)region).layer.sublayers.firstObject;
    id contents = imageLayer.contents;
    if (!contents || CFGetTypeID((__bridge CFTypeRef)contents) != IOSurfaceGetTypeID()) return 0;
    return IOSurfaceGetID((__bridge IOSurfaceRef)contents);
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
    void *surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    check(surface != NULL, @"the main webview creates the surface");
    check(SPPlaceSurfaceView(surface, view), @"the view web view is placed in the surface");
    webviewSetFrame(surface, 0, 0, 500, 400);
    webviewSetSurfaceHidden(surface, false);

    // The lease mode: the layer presents the surface of the supplier, and a replaced surface is reported once.
    void *lease = sp_region_create(surface, "lease", ignoreEvent, NULL);
    sp_region_lease(lease, released, NULL);
    sp_region_place(lease, 10, 20, 120, 80, true);
    double raster[3] = {0};
    check(sp_region_raster(lease, raster), @"the lease region reports its native raster");
    size_t width = (size_t)raster[0], height = (size_t)raster[1];
    unsigned char firstNonce[16], secondNonce[16], thirdNonce[16];
    IOSurfaceRef first = createSurface(width, height, firstNonce);
    IOSurfaceRef second = createSurface(width, height, secondNonce);
    IOSurfaceRef third = createSurface(width, height, thirdNonce);
    check(sp_region_present(lease, IOSurfaceGetID(first), firstNonce, raster[0], raster[1], raster[2], 5, 1, 1),
        @"the lease region accepts the first frame");
    check(presentedSurface(lease) == IOSurfaceGetID(first),
        [NSString stringWithFormat:@"the image layer presents the surface of the supplier without a copy (presented %u, sent %u)",
            presentedSurface(lease), IOSurfaceGetID(first)]);
    check(releases.count == 0, [NSString stringWithFormat:@"the presented surface is not released: %@", releases]);

    unsigned char wrongNonce[16] = {0};
    check(!sp_region_present(lease, IOSurfaceGetID(second), wrongNonce, raster[0], raster[1], raster[2], 5, 1, 2),
        @"a frame with a wrong nonce is refused");
    check(releases.count == 0 && presentedSurface(lease) == IOSurfaceGetID(first),
        [NSString stringWithFormat:@"a refused frame takes no reference and releases nothing: %@", releases]);

    check(sp_region_present(lease, IOSurfaceGetID(second), secondNonce, raster[0], raster[1], raster[2], 5, 1, 3),
        @"the lease region accepts the second frame");
    check([releases isEqual:@[@"5/1/1"]] && presentedSurface(lease) == IOSurfaceGetID(second),
        [NSString stringWithFormat:@"a later frame releases exactly the surface that it replaced: %@", releases]);

    // The region holds the presented surface while the supplier holds no reference of its own.
    CFRelease(second);
    check(presentedSurface(lease) != 0, @"the presented surface stays while the supplier dropped its reference");

    sp_region_close(lease);
    check([releases isEqual:@[@"5/1/1", @"5/1/3"]],
        [NSString stringWithFormat:@"closing the region releases the surface that it presented: %@", releases]);

    // The copy mode: the layer presents a host-owned copy and nothing is released.
    void *copy = sp_region_create(surface, "copy", ignoreEvent, NULL);
    sp_region_place(copy, 10, 20, 120, 80, true);
    check(sp_region_present(copy, IOSurfaceGetID(third), thirdNonce, raster[0], raster[1], raster[2], 6, 1, 1),
        @"the copy region accepts a frame");
    check(presentedSurface(copy) != 0 && presentedSurface(copy) != IOSurfaceGetID(third),
        @"the copy region presents a host-owned copy");
    sp_region_close(copy);
    check(releases.count == 2, [NSString stringWithFormat:@"a copy region releases nothing: %@", releases]);

    CFRelease(first);
    CFRelease(third);
    sp_surface_unplace_view(view);
    [view removeFromSuperview];
    sp_surface_close(surface);
    [window orderOut:nil];
    printf("%s\n", failures ? "FAIL: image_region_lease_test" : "PASS: image_region_lease_test");
    return failures ? 1 : 0;
}}
