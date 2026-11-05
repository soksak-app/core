// Checks that a backing scale change of the window keeps the shown size of a presented image
// (docs/spec/native-surfaces.md#image-regions): the image stays at the density it was drawn at until a frame of the new
// raster replaces it, because the pixels of the earlier scale would otherwise cover half or twice the region. It opens a
// window behind the other windows and does not activate the application.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <IOSurface/IOSurface.h>
#import <CoreVideo/CoreVideo.h>
#import "image_region.h"
#import "webview_geometry.h"
#import "support/scaled_window.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void ignoreEvent(void *context, const char *json) {
    (void)context; (void)json;
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

static CGFloat shownScale(void *region) {
    return ((NSView *)region).layer.sublayers.firstObject.contentsScale;
}

static BOOL presentFrame(void *region, int sequence) {
    double raster[3] = {0};
    check(sp_region_raster(region, raster), @"the region reports its native raster");
    unsigned char nonce[16];
    IOSurfaceRef frame = createSurface((size_t)raster[0], (size_t)raster[1], nonce);
    BOOL presented = sp_region_present(region, IOSurfaceGetID(frame), nonce, raster[0], raster[1], raster[2], 5, 1, sequence);
    CFRelease(frame);
    return presented;
}

int main(int argc, char **argv) { @autoreleasepool {
    (void)argc; (void)argv;
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    SPScaledWindow *window = [[SPScaledWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    SPSetScaledWindowResolution(window, 1);
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    WKWebView *surface = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    [window.contentView addSubview:surface];
    [window orderBack:nil];
    check(sp_surface_create(main) != NULL, @"the main webview creates the composition");
    webviewAttachSurface(surface, main);
    webviewSetFrame(surface, 0, 0, 500, 400);

    void *region = sp_region_create(surface, "scale", ignoreEvent, NULL);
    sp_region_place(region, 10, 20, 120, 80, true);
    check(presentFrame(region, 1), @"a frame of scale 1 is presented");
    check(shownScale(region) == 1, [NSString stringWithFormat:@"a frame of scale 1 is shown at scale 1 (got %g)", shownScale(region)]);

    SPSetScaledWindowResolution(window, 2);
    check(shownScale(region) == 1, [NSString stringWithFormat:
        @"a frame of scale 1 keeps its shown size when the window moves to scale 2 (got %g)", shownScale(region)]);
    sp_region_place(region, 10, 20, 120, 80, true);
    check(shownScale(region) == 1, [NSString stringWithFormat:
        @"placing the region does not change the density of the frame it shows (got %g)", shownScale(region)]);
    check(presentFrame(region, 2), @"a frame of scale 2 is presented");
    check(shownScale(region) == 2, [NSString stringWithFormat:@"a frame of scale 2 is shown at scale 2 (got %g)", shownScale(region)]);

    SPSetScaledWindowResolution(window, 1);
    check(shownScale(region) == 2, [NSString stringWithFormat:
        @"a frame of scale 2 keeps its shown size when the window moves to scale 1 (got %g)", shownScale(region)]);
    check(presentFrame(region, 3), @"a frame of scale 1 is presented again");
    check(shownScale(region) == 1, [NSString stringWithFormat:@"the later frame is shown at scale 1 (got %g)", shownScale(region)]);

    sp_region_close(region);
    [window close];
    return failures == 0 ? 0 : 1;
} }
