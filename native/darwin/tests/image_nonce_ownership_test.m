#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <IOSurface/IOSurface.h>
#import <CoreVideo/CoreVideo.h>
#import "image_region.h"
#import "webview_geometry.h"
#import "support/surface_view.h"

static void receive(void *context, const char *event) { (void)context; (void)event; }

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 100, 100)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    WKWebView *main = [[WKWebView alloc] initWithFrame:window.contentView.bounds];
    WKWebView *view = [[WKWebView alloc] initWithFrame:NSZeroRect];
    [window.contentView addSubview:main];
    void *surface = sp_surface_create(main);
    BOOL placed = surface && SPPlaceSurfaceView(surface, view);
    webviewSetFrame(surface, 0, 0, 100, 100);
    webviewSetSurfaceHidden(surface, false);
    void *region = placed ? sp_region_create(surface, "nonce", receive, NULL) : NULL;
    if (region) sp_region_place(region, 0, 0, 0, 0, true);
    double raster[3] = {0};
    if (!placed || !region || !sp_region_raster(region, raster)) {
        fprintf(stderr, "FAIL: image nonce fixture has no raster\n");
        return 1;
    }
    IOSurfaceRef image = IOSurfaceCreate((CFDictionaryRef)@{
        (id)kIOSurfaceWidth: @((int)raster[0]), (id)kIOSurfaceHeight: @((int)raster[1]),
        (id)kIOSurfaceBytesPerElement: @4, (id)kIOSurfacePixelFormat: @(kCVPixelFormatType_32BGRA),
    });
    if (!image) { fprintf(stderr, "FAIL: nonce fixture IOSurface allocation failed\n"); return 1; }
    unsigned char nonce[16] = {1};
    CFDataRef declared = CFDataCreate(NULL, nonce, sizeof(nonce));
    IOSurfaceSetValue(image, CFSTR("soksak.frame"), declared);
    CFRelease(declared);
    CFTypeRef held = IOSurfaceCopyValue(image, CFSTR("soksak.frame"));
    CFIndex before = CFGetRetainCount(held);
    int failures = 0;
    for (int mode = 0; mode < 3; mode++) {
        unsigned char supplied[16] = {1};
        if (mode == 0) supplied[0] = 2;
        bool presented = sp_region_present(region, IOSurfaceGetID(image), supplied,
            raster[0] + (mode == 1 ? 1 : 0), raster[1], raster[2], 1, 1, mode + 1);
        CFIndex after = CFGetRetainCount(held);
        BOOL correct = presented == (mode == 2) && after == before;
        fprintf(stderr, "%s: nonce ownership mode %d retains %ld -> %ld\n",
            correct ? "PASS" : "FAIL", mode, (long)before, (long)after);
        if (!correct) failures++;
    }
    CFRelease(held);
    CFRelease(image);
    sp_region_close(region);
    sp_surface_unplace_view(view);
    [view removeFromSuperview]; [view release];
    sp_surface_close(surface);
    [main removeFromSuperview]; [main release];
    [window close]; [window release];
    return failures ? 1 : 0;
} }
