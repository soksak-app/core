// Checks the spare presentation copy of an image region in the copy mode (docs/spec/native-surfaces.md#image-regions): frames
// that arrive within the spare delay keep it, it goes when no frame arrives for the delay, the frame on screen stays, and a
// frame after the release allocates its copy within the time of one frame. A surface whose last reference is released can no
// longer be looked up, so the check reads the state of the spare from the surface itself. The region has the raster of a
// terminal card, so the times are those of that raster. It opens a window behind the other windows and does not activate the
// application.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <IOSurface/IOSurface.h>
#import <QuartzCore/QuartzCore.h>
#include <math.h>
#import "event_ring.h"
#import "image_region.h"
#import "support/layer_contents.h"
#import "support/records.h"
#import "support/surface_view.h"
#import "webview_geometry.h"
#import "window_facts.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void ignoreEvent(void *context, const char *json) {
    (void)context; (void)json;
}

static void *region;
static CALayer *layer;
static IOSurfaceRef source;
static unsigned char nonce[16];
static double raster[3];
static int sequence;

static BOOL presentFrame(void) {
    return sp_region_present(region, IOSurfaceGetID(source), nonce, raster[0], raster[1], raster[2], 1, 1, ++sequence);
}

// The identifier of the copy that the layer shows. The pool ends the reference that reading the contents leaves.
static IOSurfaceID shownCopy(void) {
    @autoreleasepool {
        id contents = layer.contents;
        return contents ? IOSurfaceGetID((__bridge IOSurfaceRef)contents) : 0;
    }
}

static BOOL copyLives(IOSurfaceID identifier) {
    IOSurfaceRef found = IOSurfaceLookup(identifier);
    if (found) CFRelease(found);
    return found != NULL;
}

// Runs the main run loop, one pool per turn, for the time or until the copy is gone.
static void pump(NSTimeInterval limit, IOSurfaceID goneCopy) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:limit];
    while (!(goneCopy && !copyLives(goneCopy)) && deadline.timeIntervalSinceNow > 0) {
        @autoreleasepool {
            [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.005]];
        }
    }
}

// The median of the times, which one slow frame of a loaded machine does not move.
static double medianOf(NSMutableArray<NSNumber *> *times) {
    [times sortUsingSelector:@selector(compare:)];
    return times[times.count / 2].doubleValue;
}

int main(int argc, char **argv) { @autoreleasepool {
    (void)argc; (void)argv;
    const int8_t everything[SP_CLASS_COUNT] = {SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE};
    check(sp_event_set_policy(everything), @"the policy stores every level of every class");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 1200, 760)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 1200, 760)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    WKWebView *view = [[[WKWebView alloc] initWithFrame:NSZeroRect] autorelease];
    [window orderBack:nil];
    void *surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    check(surface != NULL, @"the main webview creates the surface");
    check(SPPlaceSurfaceView(surface, view), @"the view web view is placed in the surface");
    webviewSetFrame(surface, 0, 0, 1200, 760);
    webviewSetSurfaceHidden(surface, false);

    region = sp_region_create(surface, "spare", ignoreEvent, NULL);
    sp_region_place(region, 220, 200, 220, 274, true);
    check(sp_region_raster(region, raster), @"the region reports its native raster");
    layer = ((NSView *)region).layer.sublayers.firstObject;
    arc4random_buf(nonce, sizeof nonce);
    source = IOSurfaceCreate((CFDictionaryRef)@{
        (id)kIOSurfaceWidth: @((size_t)raster[0]),
        (id)kIOSurfaceHeight: @((size_t)raster[1]),
        (id)kIOSurfaceBytesPerElement: @4,
        (id)kIOSurfacePixelFormat: @(kCVPixelFormatType_32BGRA),
    });
    CFDataRef nonceData = CFDataCreate(NULL, nonce, sizeof nonce);
    IOSurfaceSetValue(source, CFSTR("soksak.frame"), nonceData);
    CFRelease(nonceData);
    IOSurfaceLock(source, 0, NULL);
    uint32_t *sourcePixels = IOSurfaceGetBaseAddress(source);
    sourcePixels[0] = 0xFFFF0000;
    sourcePixels[(size_t)raster[0] - 1] = 0xFF00FF00;
    IOSurfaceUnlock(source, 0, NULL);

    check(sp_region_set_spare_delay(0.5), @"the delay takes a positive number of seconds");
    check(!sp_region_set_spare_delay(0) && !sp_region_set_spare_delay(NAN), @"the delay refuses any other number");
    check(presentFrame(), @"the first frame is presented");
    IOSurfaceID firstCopy = shownCopy();
    check(presentFrame(), @"the second frame is presented");
    check(copyLives(firstCopy), @"the replaced copy is kept for the next frame");

    // Frames that arrive within the delay keep the spare, for longer than the delay in all.
    IOSurfaceID lastSpare = 0;
    for (int frame = 0; frame < 8; frame++) {
        pump(0.1, 0);
        lastSpare = shownCopy();
        check(presentFrame(), @"a frame within the delay is presented");
    }
    check(copyLives(lastSpare), @"frames within the delay keep the spare");
    IOSurfaceID lastCopy = shownCopy();

    // No frame arrives: the spare goes, the frame on screen stays, and the release is an event.
    NSArray<NSDictionary *> *events = capturedEvents(^{ pump(10, lastSpare); });
    check(!copyLives(lastSpare), @"the spare is released when no frame arrives for the delay");
    check(copyLives(lastCopy) && shownCopy() == lastCopy, @"the release keeps the frame on screen");
    NSUInteger releases = 0;
    for (NSDictionary *event in events) {
        if (![event[@"name"] isEqualToString:@"native.image.spare_released"]) continue;
        releases++;
        check([event[@"class"] intValue] == SP_CLASS_LIFECYCLE && [event[@"level"] intValue] == SP_EVENT_DEBUG,
            @"the release is stored in the lifecycle class at debug");
        check([event[@"fields"][@"bytes"] longLongValue] >= (long long)(raster[0] * raster[1] * 4),
            [NSString stringWithFormat:@"the release names the bytes of the spare (%@)", event[@"fields"]]);
    }
    check(releases == 1, [NSString stringWithFormat:@"one release is one event (%lu)", (unsigned long)releases]);

    // The frame after the release shows the pixels of the supplier.
    check(presentFrame(), @"the frame after the release is presented");
    check(shownCopy() != lastCopy, @"the frame after the release replaces the frame on screen");
    @autoreleasepool {
        CGImageRef image = layerContentsImage(layer);
        CFDataRef bytes = image ? CGDataProviderCopyData(CGImageGetDataProvider(image)) : NULL;
        const uint32_t *pixels = bytes ? (const uint32_t *)CFDataGetBytePtr(bytes) : NULL;
        check(pixels && pixels[0] == 0xFFFF0000 && pixels[(size_t)raster[0] - 1] == 0xFF00FF00,
            @"the frame after the release shows the pixels of the supplier");
        if (bytes) CFRelease(bytes);
    }

    // The frame after the release against a frame that reuses the spare.
    check(sp_region_set_spare_delay(0.05), @"the delay is shortened for the timed frames");
    NSMutableArray<NSNumber *> *resumed = [NSMutableArray array];
    for (int frame = 0; frame < 15; frame++) {
        IOSurfaceID previous = shownCopy();
        check(presentFrame(), @"a frame before a timed frame is presented");
        pump(5, previous);
        check(!copyLives(previous), @"the spare before a timed frame is released");
        CFTimeInterval start = CACurrentMediaTime();
        BOOL shown = presentFrame();
        [resumed addObject:@((CACurrentMediaTime() - start) * 1000)];
        check(shown, @"a timed frame after the release is presented");
        pump(0.1, 0);
    }
    double resumedMedian = medianOf(resumed);
    check(sp_region_set_spare_delay(300), @"the delay is lengthened for the steady frames");
    NSMutableArray<NSNumber *> *steady = [NSMutableArray array];
    NSMutableSet<NSNumber *> *copies = [NSMutableSet set];
    for (int frame = 0; frame < 120; frame++) {
        pump(0.016, 0);
        CFTimeInterval start = CACurrentMediaTime();
        BOOL shown = presentFrame();
        [steady addObject:@((CACurrentMediaTime() - start) * 1000)];
        check(shown, @"a steady frame is presented");
        [copies addObject:@(shownCopy())];
    }
    printf("MEASURE: raster %.0fx%.0f: frame after the release, median %.3f ms (%.3f to %.3f); steady frame, median %.3f ms, %lu copies in %lu frames\n",
        raster[0], raster[1], resumedMedian, resumed.firstObject.doubleValue, resumed.lastObject.doubleValue,
        medianOf(steady), (unsigned long)copies.count, (unsigned long)steady.count);
    check(resumedMedian < 1000.0 / 60,
        [NSString stringWithFormat:@"a frame after the release takes less than one frame at 60 Hz (%.3f ms)", resumedMedian]);

    // Closing with the delay running ends it, and the region releases its copies.
    check(sp_region_set_spare_delay(0.05), @"the delay is shortened for the close");
    check(presentFrame(), @"a frame before the close is presented");
    IOSurfaceID closedCopy = shownCopy();
    check(presentFrame(), @"a second frame before the close is presented");
    sp_region_close(region);
    pump(5, closedCopy);
    check(!copyLives(closedCopy), @"closing releases the spare");

    CFRelease(source);
    sp_surface_unplace_view(view);
    [view removeFromSuperview];
    sp_surface_close(surface);
    [window orderOut:nil];
    printf("%s\n", failures ? "FAIL: image_region_spare_test" : "PASS: image_region_spare_test");
    return failures ? 1 : 0;
}}
