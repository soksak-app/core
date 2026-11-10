// Checks the spare presentation copy of an image region in the copy mode (docs/spec/native-surfaces.md#image-regions): frames
// that arrive within the spare delay keep it, it goes when no frame arrives for the delay, the frame on screen stays, and a
// frame after the release allocates its copy within the time of one frame: before the display refresh after its own. A surface whose last reference is released can no
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
#import "support/event_wait.h"
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

// Counts the refreshes of the display, keeps the time of the last one and the time that it names for the refresh after it.
@interface SPRefreshes : NSObject
@property long count;
@property CFTimeInterval timestamp;
@property CFTimeInterval next;
@end

@implementation SPRefreshes
- (void)refresh:(CADisplayLink *)link {
    self.timestamp = link.timestamp;
    self.next = link.targetTimestamp;
    self.count++;
}
@end

static SPRefreshes *refreshes;

// Waits for the next refresh of the display, the cadence at which a supplier sends its frames.
static void nextRefresh(NSString *what) {
    long seen = refreshes.count;
    eventWait(what, ^BOOL { return refreshes.count > seen; });
}

// The spare delay that runs for the region, nil when none runs.
static id runningSpareDelay(void) {
    return [(NSObject *)region valueForKey:@"runningSpareDelay"];
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
    // The display link keeps running for the whole check: each refresh is a source of the run loop, so a wait for a copy that
    // the compositor still holds judges again at every refresh.
    refreshes = [[SPRefreshes new] autorelease];
    CADisplayLink *link = [(window.screen ?: NSScreen.mainScreen) displayLinkWithTarget:refreshes selector:@selector(refresh:)];
    [link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
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

    // Frames that arrive within the delay keep the spare, for longer than the delay in all: a frame arrives at each refresh of
    // the display until the delay that the second frame started has ended and runs again for the rest. The delay would have
    // released the spare when it ended, so the spare and the running delay are judged after that end.
    id firstDelay = [[runningSpareDelay() retain] autorelease];
    check(firstDelay != nil, @"the frame that makes a spare starts the spare delay");
    __block IOSurfaceID lastSpare = 0;
    __block long within = 0;
    __block long presentedWithin = 0;
    NSArray<NSDictionary *> *withinEvents = capturedEvents(^{
        while (firstDelay && runningSpareDelay() == firstDelay) {
            nextRefresh(@"the display refresh of the next frame within the delay");
            lastSpare = shownCopy();
            within++;
            if (presentFrame()) presentedWithin++;
        }
    });
    check(within > 0 && presentedWithin == within,
        [NSString stringWithFormat:@"every frame within the delay is presented (%ld of %ld)", presentedWithin, within]);
    check(runningSpareDelay() != nil, @"the delay that ends while frames arrive runs again for the rest");
    check(copyLives(lastSpare), @"frames within the delay keep the spare");
    NSUInteger releasesWithin = 0;
    for (NSDictionary *event in withinEvents) {
        if ([event[@"name"] isEqualToString:@"native.image.spare_released"]) releasesWithin++;
    }
    check(releasesWithin == 0,
        [NSString stringWithFormat:@"frames within the delay release no spare (%lu releases)", (unsigned long)releasesWithin]);
    IOSurfaceID lastCopy = shownCopy();

    // No frame arrives: the spare goes, the frame on screen stays, and the release is an event.
    NSArray<NSDictionary *> *events = capturedEvents(^{
        eventWait(@"the spare delay ends without a frame and the spare copy is gone", ^BOOL { return !copyLives(lastSpare); });
    });
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

    // The frame after the release against a frame that reuses the spare. A timed frame is presented at a refresh of the display
    // and is in time when the refresh after it is the one that the display named as the next: presenting it skipped no
    // refresh. More than half of the timed frames in time is the median of them within one frame, which one slow frame of a
    // loaded machine does not move.
    check(sp_region_set_spare_delay(0.05), @"the delay is shortened for the timed frames");
    NSMutableArray<NSNumber *> *resumed = [NSMutableArray array];
    int timedFrames = 15, inTime = 0;
    for (int frame = 0; frame < timedFrames; frame++) {
        IOSurfaceID previous = shownCopy();
        check(presentFrame(), @"a frame before a timed frame is presented");
        eventWait(@"the spare delay ends and the spare copy before a timed frame is gone",
            ^BOOL { return !copyLives(previous); });
        check(!copyLives(previous), @"the spare before a timed frame is released");
        nextRefresh(@"the display refresh of a timed frame");
        CFTimeInterval named = refreshes.next, period = refreshes.next - refreshes.timestamp;
        CFTimeInterval start = CACurrentMediaTime();
        BOOL shown = presentFrame();
        [resumed addObject:@((CACurrentMediaTime() - start) * 1000)];
        check(shown, @"a timed frame after the release is presented");
        nextRefresh(@"the display refresh after a timed frame");
        if (refreshes.timestamp < named + period / 2) inTime++;
    }
    double resumedMedian = medianOf(resumed);
    check(sp_region_set_spare_delay(300), @"the delay is lengthened for the steady frames");
    NSMutableArray<NSNumber *> *steady = [NSMutableArray array];
    NSMutableSet<NSNumber *> *copies = [NSMutableSet set];
    for (int frame = 0; frame < 120; frame++) {
        nextRefresh(@"the display refresh of the next steady frame");
        CFTimeInterval start = CACurrentMediaTime();
        BOOL shown = presentFrame();
        [steady addObject:@((CACurrentMediaTime() - start) * 1000)];
        check(shown, @"a steady frame is presented");
        [copies addObject:@(shownCopy())];
    }
    printf("MEASURE: raster %.0fx%.0f: frame after the release, median %.3f ms (%.3f to %.3f); steady frame, median %.3f ms, %lu copies in %lu frames\n",
        raster[0], raster[1], resumedMedian, resumed.firstObject.doubleValue, resumed.lastObject.doubleValue,
        medianOf(steady), (unsigned long)copies.count, (unsigned long)steady.count);
    check(inTime * 2 > timedFrames, [NSString stringWithFormat:
        @"a frame after the release is presented before the display refresh after its own (%d of %d frames)", inTime, timedFrames]);

    // Closing with the delay running ends it, and the region releases its copies.
    check(sp_region_set_spare_delay(0.05), @"the delay is shortened for the close");
    check(presentFrame(), @"a frame before the close is presented");
    IOSurfaceID closedCopy = shownCopy();
    check(presentFrame(), @"a second frame before the close is presented");
    sp_region_close(region);
    eventWait(@"the close releases the spare copy", ^BOOL { return !copyLives(closedCopy); });
    check(!copyLives(closedCopy), @"closing releases the spare");

    [link invalidate];
    CFRelease(source);
    sp_surface_unplace_view(view);
    [view removeFromSuperview];
    sp_surface_close(surface);
    [window orderOut:nil];
    printf("%s\n", failures ? "FAIL: image_region_spare_test" : "PASS: image_region_spare_test");
    return failures ? 1 : 0;
}}
