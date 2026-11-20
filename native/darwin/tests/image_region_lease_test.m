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
#import "support/records.h"
#import "event_ring.h"

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
// The single record native.image.present of the events, which states the mode, the size, the bytes that the presentation copied
// and the time of each step of the present, the steps within its whole time.
static void checkPresentRecord(NSArray<NSDictionary *> *events, NSString *mode, size_t width, size_t height, size_t bytes) {
    NSArray *records = [events filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(NSDictionary *event, id bindings) {
        (void)bindings;
        return [event[@"name"] isEqual:@"native.image.present"];
    }]];
    NSDictionary *fields = records.count == 1 ? records[0][@"fields"] : nil;
    unsigned long long steps = 0;
    BOOL numbers = fields != nil;
    for (NSString *name in @[@"lookup_ns", @"check_ns", @"copy_ns", @"swap_ns", @"commit_ns"]) {
        numbers = numbers && [fields[name] isKindOfClass:NSNumber.class];
        steps += [fields[name] unsignedLongLongValue];
    }
    check(numbers && [fields[@"mode"] isEqual:mode] && [fields[@"width"] unsignedLongValue] == width &&
        [fields[@"height"] unsignedLongValue] == height && [fields[@"bytes"] unsignedLongValue] == bytes &&
        [records[0][@"class"] intValue] == SP_CLASS_FRAME && steps <= [fields[@"total_ns"] unsignedLongLongValue],
        [NSString stringWithFormat:@"a %@ present stores one record of its steps (%@)", mode, records]);
}

// Whether the region used a kept surface for the frame (the field cached of its record native.image.present): 1 or 0,
// or -1 when the frame was refused or stored no single record.
static int presentCached(void *region, IOSurfaceRef surface, const unsigned char *nonce, const double *size,
    uint64_t generation, uint64_t raster, int sequence) {
    __block bool presented = false;
    NSArray *events = capturedEvents(^{
        presented = sp_region_present(region, IOSurfaceGetID(surface), nonce, size[0], size[1], size[2], generation, raster,
            sequence);
    });
    NSArray *records = [events filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(NSDictionary *event, id bindings) {
        (void)bindings;
        return [event[@"name"] isEqual:@"native.image.present"];
    }]];
    id cached = records.count == 1 ? records[0][@"fields"][@"cached"] : nil;
    if (!presented || ![cached isKindOfClass:NSNumber.class]) return -1;
    return [cached boolValue] ? 1 : 0;
}

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
    // The records of the class frame at the level debug, which the default policy refuses (docs/spec/logging.md#policy).
    const int8_t frames[SP_CLASS_COUNT] = {SP_EVENT_ERROR, SP_EVENT_ERROR, SP_EVENT_ERROR, SP_EVENT_ERROR, SP_EVENT_DEBUG};
    check(sp_event_set_policy(frames), @"the policy stores the records of the class frame");
    // A block cannot refer to an array, so the blocks read the nonces and the raster through pointers.
    const unsigned char *firstBytes = firstNonce, *thirdBytes = thirdNonce;
    const double *size = raster;
    __block BOOL firstPresented = NO;
    NSArray *leaseEvents = capturedEvents(^{
        firstPresented = sp_region_present(lease, IOSurfaceGetID(first), firstBytes, size[0], size[1], size[2], 5, 1, 1);
    });
    check(firstPresented, @"the lease region accepts the first frame");
    checkPresentRecord(leaseEvents, @"lease", width, height, 0);
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
    __block BOOL thirdPresented = NO;
    NSArray *copyEvents = capturedEvents(^{
        thirdPresented = sp_region_present(copy, IOSurfaceGetID(third), thirdBytes, size[0], size[1], size[2], 6, 1, 1);
    });
    check(thirdPresented, @"the copy region accepts a frame");
    checkPresentRecord(copyEvents, @"copy", width, height, width * height * 4);
    check(presentedSurface(copy) != 0 && presentedSurface(copy) != IOSurfaceGetID(third),
        @"the copy region presents a host-owned copy");
    sp_region_close(copy);
    check(releases.count == 2, [NSString stringWithFormat:@"a copy region releases nothing: %@", releases]);

    // A region keeps the surfaces that it looked up for its generation and raster revision, at most 16, and presents a
    // kept surface again without a lookup (docs/spec/native-surfaces.md#darwin).
    void *kept = sp_region_create(surface, "kept", ignoreEvent, NULL);
    sp_region_place(kept, 10, 20, 120, 80, true);
    // One surface more than the region keeps.
    enum { pool = 17, last = pool - 1 };
    unsigned char nonces[pool][16];
    IOSurfaceRef surfaces[pool];
    IOSurfaceID identifiers[pool];
    for (int index = 0; index < pool; index++) {
        surfaces[index] = createSurface(width, height, nonces[index]);
        identifiers[index] = IOSurfaceGetID(surfaces[index]);
    }
    // Whether each surface of the pool still exists after the test released its own references: a surface that the
    // region keeps is found by its identifier, a dropped one is not.
    const IOSurfaceID *pooled = identifiers;
    NSString *(^alive)(void) = ^NSString *{
        NSMutableArray *found = [NSMutableArray array];
        for (int index = 0; index < pool; index++) {
            IOSurfaceRef looked = IOSurfaceLookup(pooled[index]);
            [found addObject:looked ? @1 : @0];
            if (looked) CFRelease(looked);
        }
        return [found componentsJoinedByString:@","];
    };
    int sequence = 1;
    int lookedUp = presentCached(kept, surfaces[0], nonces[0], size, 7, 1, sequence++);
    int again = presentCached(kept, surfaces[0], nonces[0], size, 7, 1, sequence++);
    check(lookedUp == 0 && again == 1,
        [NSString stringWithFormat:@"a frame of a kept surface is presented without a lookup (first %d, again %d)", lookedUp,
            again]);
    unsigned char otherNonce[16] = {1};
    check(presentCached(kept, surfaces[0], otherNonce, size, 7, 1, sequence++) == -1,
        @"a frame of a kept identifier with another nonce is looked up and refused");
    NSMutableArray *filled = [NSMutableArray array];
    for (int index = 1; index < pool; index++) {
        [filled addObject:@(presentCached(kept, surfaces[index], nonces[index], size, 7, 1, sequence++))];
    }
    // The last surface replaced the first, the first then replaced the second, and the last is still kept.
    int evicted = presentCached(kept, surfaces[0], nonces[0], size, 7, 1, sequence++);
    int latest = presentCached(kept, surfaces[last], nonces[last], size, 7, 1, sequence++);
    int replaced = presentCached(kept, surfaces[1], nonces[1], size, 7, 1, sequence++);
    check(filled.count == last && ![filled containsObject:@1] && ![filled containsObject:@-1] && evicted == 0 && latest == 1 && replaced == 0,
        [NSString stringWithFormat:@"a surface over the bound replaces the one presented least recently (filled %@, evicted %d, latest %d, "
            "replaced %d)", filled, evicted, latest, replaced]);
    int newRaster = presentCached(kept, surfaces[last], nonces[last], size, 7, 2, 1);
    int newGeneration = presentCached(kept, surfaces[last], nonces[last], size, 8, 2, 1);
    check(newGeneration == 0, [NSString stringWithFormat:@"a frame of another generation is looked up (cached %d)", newGeneration]);
    for (int index = 0; index < pool; index++) CFRelease(surfaces[index]);
    NSString *afterRaster = alive();
    NSMutableArray *onlyLast = [NSMutableArray array], *noSurface = [NSMutableArray array];
    for (int index = 0; index < pool; index++) {
        [onlyLast addObject:index == last ? @"1" : @"0"];
        [noSurface addObject:@"0"];
    }
    NSString *none = [noSurface componentsJoinedByString:@","];
    check(newRaster == 0 && [afterRaster isEqual:[onlyLast componentsJoinedByString:@","]],
        [NSString stringWithFormat:@"a frame of another raster revision drops the kept surfaces of the earlier pool (cached %d, "
            "alive %@)", newRaster, afterRaster]);
    sp_region_close(kept);
    check([alive() isEqual:none],
        [NSString stringWithFormat:@"closing the region drops its kept surfaces (alive %@)", alive()]);

    CFRelease(first);
    CFRelease(third);
    sp_surface_unplace_view(view);
    [view removeFromSuperview];
    sp_surface_close(surface);
    [window orderOut:nil];
    printf("%s\n", failures ? "FAIL: image_region_lease_test" : "PASS: image_region_lease_test");
    return failures ? 1 : 0;
}}
