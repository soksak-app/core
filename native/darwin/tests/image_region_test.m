#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <IOSurface/IOSurface.h>
#import <objc/runtime.h>
#include <unistd.h>
#import "event_ring.h"
#import "image_region.h"
#import "image_capture_match.h"
#import "capture_frame_identity.h"
#import "input_inject.h"
#import "input_press_context.h"
#import "support/records.h"
#import "webview_geometry.h"

/// An input context that takes every key and answers nothing, as the input method does for a key outside the key window
/// of the active application after the application was active once.
@interface SilentInputContext : NSTextInputContext
@end

@implementation SilentInputContext
- (BOOL)handleEvent:(NSEvent *)event {
    return YES;
}
@end


static int failures = 0;
static NSUInteger countedSurfaceObserverRegistrations = 0;
static IMP originalAddObserverImplementation = NULL;

static BOOL jsonBooleanMatches(id value, BOOL expected) {
    return [value isKindOfClass:NSNumber.class]
        && CFGetTypeID((CFTypeRef)value) == CFBooleanGetTypeID()
        && [value boolValue] == expected;
}

static void countSurfaceObserverRegistration(id self, SEL selector, id observer, SEL observerSelector,
    NSString *name, id object) {
    if ([name isEqual:NSViewFrameDidChangeNotification] && [observer isKindOfClass:NSClassFromString(@"SPImageRegion")]) {
        countedSurfaceObserverRegistrations++;
    }
    ((void (*)(id, SEL, id, SEL, NSString *, id))originalAddObserverImplementation)(self, selector,
        observer, observerSelector, name, object);
}

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Collects events in JSON form
static NSMutableArray *collectedEvents = nil;
// Separate collectors used to tell apart the focus change between two regions (A->B check of V5-114).
static NSMutableArray *eventsA16 = nil;
static NSMutableArray *eventsB16 = nil;

static void testEvent(void *context, const char *json) {
    if (context == (void *)1) {
        if (!eventsA16) eventsA16 = [NSMutableArray new];
        [eventsA16 addObject:[NSString stringWithUTF8String:json]];
        return;
    }
    if (context == (void *)2) {
        if (!eventsB16) eventsB16 = [NSMutableArray new];
        [eventsB16 addObject:[NSString stringWithUTF8String:json]];
        return;
    }
    if (!collectedEvents) collectedEvents = [NSMutableArray new];
    [collectedEvents addObject:[NSString stringWithUTF8String:json]];
}

// The reports as dictionaries without their `cids` member; a report that has no single correlation identifier is NSNull.
static NSArray *reportsWithoutCids(NSArray<NSString *> *reports) {
    NSMutableArray *plain = [NSMutableArray array];
    for (NSString *report in reports) {
        NSMutableDictionary *parsed = [[NSJSONSerialization JSONObjectWithData:[report dataUsingEncoding:NSUTF8StringEncoding] options:NSJSONReadingMutableContainers error:NULL] mutableCopy];
        if (!parsed || [parsed[@"cids"] count] != 1) {
            [plain addObject:NSNull.null];
            continue;
        }
        [parsed removeObjectForKey:@"cids"];
        [plain addObject:parsed];
    }
    return plain;
}

// List of committed insert actions in input transactions after from.
static NSArray *committedTexts(NSUInteger from) {
    NSMutableArray *texts = [NSMutableArray array];
    for (NSUInteger i = from; i < collectedEvents.count; i++) {
        NSDictionary *event = [NSJSONSerialization JSONObjectWithData:[collectedEvents[i] dataUsingEncoding:NSUTF8StringEncoding]
            options:0 error:NULL];
        for (NSDictionary *action in event[@"actions"]) {
            if ([action[@"type"] isEqual:@"insert"]) [texts addObject:action[@"text"] ?: NSNull.null];
        }
    }
    return texts;
}

// Composition string of the last input transaction after from. nil if there is none.
static NSString *lastPreedit(NSUInteger from) {
    NSString *text = nil;
    for (NSUInteger i = from; i < collectedEvents.count; i++) {
        NSDictionary *event = [NSJSONSerialization JSONObjectWithData:[collectedEvents[i] dataUsingEncoding:NSUTF8StringEncoding]
            options:0 error:NULL];
        if ([event[@"type"] isEqual:@"input"]) text = event[@"preedit"][@"text"];
    }
    return text;
}

// Creates a global IOSurface with the four corners painted in different colors
static IOSurfaceRef createColoredGlobalSurface(size_t width, size_t height, unsigned char *nonce) {
    IOSurfaceRef surface = IOSurfaceCreate((CFDictionaryRef)@{
        (id)kIOSurfaceWidth: @(width),
        (id)kIOSurfaceHeight: @(height),
        (id)kIOSurfaceBytesPerElement: @4,
        (id)kIOSurfacePixelFormat: @(kCVPixelFormatType_32BGRA),
    });

    if (!surface) return NULL;

    // Creates and sets the nonce
    arc4random_buf(nonce, 16);
    CFDataRef nonceData = CFDataCreate(NULL, nonce, 16);
    IOSurfaceSetValue(surface, CFSTR("soksak.frame"), nonceData);
    CFRelease(nonceData);

    // Accesses the buffer and paints the four corners differently
    IOSurfaceLock(surface, 0, NULL);
    void *ptr = IOSurfaceGetBaseAddress(surface);
    size_t pitch = IOSurfaceGetBytesPerRow(surface);
    if (ptr) {
        uint32_t *pixels = (uint32_t *)ptr;
        // Top left: red
        pixels[0] = 0xFFFF0000;
        // Top right: green
        pixels[width - 1] = 0xFF00FF00;
        // Bottom left
        uint32_t *bottomLeft = (uint32_t *)((char *)ptr + (height - 1) * pitch);
        bottomLeft[0] = 0xFF0000FF;
        // Bottom right
        bottomLeft[width - 1] = 0xFFFFFF00;
    }
    IOSurfaceUnlock(surface, 0, NULL);

    return surface;
}

void sp_test_declare_activation(void);

int main(int argc, char **argv) { @autoreleasepool {
    // activation activates the application and checks whether a press in the OS event queue makes the web view the first responder.
    // Used only by make test-activation.
    BOOL activation = argc > 1 && strcmp(argv[1], "--activation") == 0;
    if (activation) sp_test_declare_activation();
    // The records of the input method are info and debug events, which the default policy refuses (docs/spec/logging.md#policy):
    // the policy that stores every level is set here, and the default policy is tested in event_ring_test.
    const int8_t everything[SP_CLASS_COUNT] = {SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE};
    check(sp_event_set_policy(everything), @"the policy stores every level of every class");
    // The correlation identifiers of the inputs are <boot>.<n>; the host gives the boot identifier of its run.
    check(sp_event_set_boot("native-test"), @"the boot identifier of the run is accepted");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    main.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [window.contentView addSubview:main];
    WKWebView *surface = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    [window.contentView addSubview:surface];
    [window orderBack:nil];
    check(sp_surface_create(main) != NULL,
        @"the main webview creates the composition before a surface webview is attached");
    webviewAttachSurface(surface, main);
    webviewSetFrame(surface, 0, 0, 500, 400);
    NSView *nativePlane = (NSView *)webviewSurfaceNativePlane(surface);

    // TEST 1: orientation and size - checks layer properties and surface ID
    {
        [collectedEvents removeAllObjects];
        Class notificationCenterClass = NSNotificationCenter.class;
        Method addObserverMethod = class_getInstanceMethod(notificationCenterClass,
            @selector(addObserver:selector:name:object:));
        originalAddObserverImplementation = method_getImplementation(addObserverMethod);
        method_setImplementation(addObserverMethod, (IMP)countSurfaceObserverRegistration);
        // The registry must outlive the autorelease pool of the create call (V5-116-4-1).
        void *bootstrapRegion = NULL;
        @autoreleasepool {
            bootstrapRegion = sp_region_create(surface, "pool-lifetime", testEvent, NULL);
            check(bootstrapRegion != NULL, @"region registry initializes inside a short-lived autorelease pool");
        }
        void *region1 = sp_region_create(surface, "test1", testEvent, NULL);
        check(region1 != NULL, @"region registry survives the first creation autorelease pool drain");
        sp_region_close(bootstrapRegion);
        check(region1 != NULL, @"TEST 1: region created");

        countedSurfaceObserverRegistrations = 0;
        sp_region_place(region1, 10, 20, 30, 40, true);
        for (NSUInteger placement = 0; placement < 20; placement++) {
            sp_region_place(region1, 10 + placement, 20, 30, 40, true);
        }
        check(countedSurfaceObserverRegistrations == 1,
            [NSString stringWithFormat:@"TEST 1: repeated placement keeps one frame observer (got %lu registrations)",
                (unsigned long)countedSurfaceObserverRegistrations]);
        method_setImplementation(addObserverMethod, originalAddObserverImplementation);
        originalAddObserverImplementation = NULL;
        double raster1[3] = {0};
        check(sp_region_raster(region1, raster1), @"TEST 1: placed region reports its native raster");
        unsigned char nonce1[16];
        IOSurfaceRef testSurface1 = createColoredGlobalSurface((size_t)raster1[0], (size_t)raster1[1], nonce1);
        check(testSurface1 != NULL, @"TEST 1: IOSurface created with global flag");
        BOOL presented = sp_region_present(region1, IOSurfaceGetID(testSurface1), nonce1,
            raster1[0], raster1[1], raster1[2], 41, 7, 1);
        check(presented, @"TEST 1: sp_region_present succeeded");
        const char *facts1 = sp_region_facts(region1);
        check(facts1 && strstr(facts1, "\"generation\":41") && strstr(facts1, "\"raster\":7") &&
            strstr(facts1, "\"sequence\":1"), @"TEST 1: native snapshot facts retain the exact source frame identity");
        free((void *)facts1);

        // Finds the layer and checks its properties
        NSView *regionView = (NSView *)region1;
        [regionView updateTrackingAreas];
        NSUInteger cursorAreas = 0;
        for (NSTrackingArea *area in regionView.trackingAreas) {
            if (area.options & NSTrackingCursorUpdate) cursorAreas++;
        }
        check(cursorAreas == 0, [NSString stringWithFormat:@"TEST 1: image input view has no cursor tracking area (%lu)",
            (unsigned long)cursorAreas]);
        // In the implementation, imageLayer is a sublayer of SPImageRegion
        NSArray *sublayers = regionView.layer.sublayers;
        CALayer *imageLayer = [sublayers firstObject];
        check(imageLayer != NULL, @"TEST 1: image layer found");

        if (imageLayer) {
            check([imageLayer.contentsGravity isEqualToString:kCAGravityTopLeft],
                @"TEST 1: terminal pixels are never scaled to fill a pending geometry");
            CGImageRef snapshot = (CGImageRef)imageLayer.contents;
            check(snapshot != NULL && CGImageGetWidth(snapshot) == (size_t)raster1[0]
                && CGImageGetHeight(snapshot) == (size_t)raster1[1],
                @"TEST 1: layer owns a copied snapshot at the exact native raster");
            CGColorSpaceRef snapshotColorSpace = snapshot ? CGImageGetColorSpace(snapshot) : NULL;
            CFStringRef snapshotColorSpaceName = snapshotColorSpace ? CGColorSpaceGetName(snapshotColorSpace) : NULL;
            char snapshotColorSpaceBuffer[128] = {0};
            check(snapshotColorSpaceName && CFStringGetCString(snapshotColorSpaceName, snapshotColorSpaceBuffer,
                sizeof(snapshotColorSpaceBuffer), kCFStringEncodingUTF8)
                && strcmp(snapshotColorSpaceBuffer, "kCGColorSpaceDeviceRGB") == 0,
                @"TEST 1: an IOSurface without a color-space tag keeps the DeviceRGB display interpretation");
            check((CFTypeRef)snapshot != (CFTypeRef)testSurface1,
                @"TEST 1: layer does not point at the supplier IOSurface");
            IOSurfaceLock(testSurface1, 0, NULL);
            *(uint32_t *)IOSurfaceGetBaseAddress(testSurface1) = 0;
            IOSurfaceUnlock(testSurface1, 0, NULL);
            CFDataRef copied = CGDataProviderCopyData(CGImageGetDataProvider(snapshot));
            uint32_t firstPixel = *(const uint32_t *)CFDataGetBytePtr(copied);
            check(firstPixel == 0xFFFF0000,
                @"TEST 1: mutating the transfer IOSurface does not change the presented snapshot");
            CFRelease(copied);

            // The number of device pixels that one layer unit covers must be equal, so that one pixel of the image becomes one device pixel.
            NSView *regionView1 = (NSView *)region1;
            CGFloat perUnit = NSWidth([regionView1 convertRectToBacking:regionView1.bounds]) / NSWidth(regionView1.bounds);
            check(imageLayer.contentsScale == perUnit,
                [NSString stringWithFormat:@"TEST 1: contentsScale is backing pixels per unit %g (got %g)", perUnit, imageLayer.contentsScale]);

            check([imageLayer.magnificationFilter isEqualToString:kCAFilterNearest],
                [NSString stringWithFormat:@"TEST 1: magnificationFilter is Nearest (got %@)", imageLayer.magnificationFilter]);
        }

        sp_region_close(region1);
        CFRelease(testSurface1);
    }

    // TEST 1A: opt-in image identity tagging keeps the raw source and tags only the reserved corner.
    {
        void *identityRegion = sp_region_create(surface, "identity", testEvent, NULL);
        sp_region_place(identityRegion, 0, 0, 0, 0, true);
        double identityRaster[3] = {0};
        check(sp_region_raster(identityRegion, identityRaster), @"TEST 1A: identity region reports its raster");
        unsigned char identityToken[16];
        IOSurfaceRef identitySurface = createColoredGlobalSurface((size_t)identityRaster[0],
            (size_t)identityRaster[1], identityToken);
        CGRect tagROI = CGRectMake(identityRaster[0] - 192, 0, 192, 192);
        CGRect measuredGlyphROI = CGRectMake(identityRaster[0] / 2 - 16, identityRaster[1] / 2 - 16, 32, 32);
        check(identitySurface != NULL && !CGRectIntersectsRect(tagROI, measuredGlyphROI),
            @"TEST 1A: the reserved top-right tag ROI is outside the measured glyph ROI");
        BOOL initialPresented = identitySurface && sp_region_present(identityRegion, IOSurfaceGetID(identitySurface),
            identityToken, identityRaster[0], identityRaster[1], identityRaster[2], 91, 10, 1);
        check(initialPresented, @"TEST 1A: the original source snapshot is presented before tagging");
        CALayer *identityLayer = (CALayer *)((NSView *)identityRegion).layer.sublayers.firstObject;
        CGImageRef rawSnapshot = identityLayer ? (CGImageRef)identityLayer.contents : NULL;
        if (rawSnapshot) CGImageRetain(rawSnapshot);
        sp_image_capture_match_begin(NULL, NULL);
        char *identityError = NULL;
        check(sp_image_capture_match_identity_session_begin(&identityError) && identityError == NULL,
            @"TEST 1A: the fixture starts an opt-in identity session");
        free(identityError); identityError = NULL;
        BOOL taggedPresented = identitySurface && sp_region_present(identityRegion, IOSurfaceGetID(identitySurface),
            identityToken, identityRaster[0], identityRaster[1], identityRaster[2], 91, 10, 1);
        check(taggedPresented, @"TEST 1A: the tagged snapshot keeps the native presentation call successful");
        CGImageRef taggedSnapshot = identityLayer ? (CGImageRef)identityLayer.contents : NULL;
        check(rawSnapshot != NULL && taggedSnapshot != NULL && rawSnapshot != taggedSnapshot,
            @"TEST 1A: the layer receives a tagged image separate from the raw source snapshot");
        NSSet<NSString *> *issuedPayloads = nil;
        bool copiedIssued = sp_image_capture_match_identity_copy_payloads(identityToken, &issuedPayloads, &identityError);
        check(copiedIssued && identityError == NULL && issuedPayloads.count == 1,
            @"TEST 1A: the presented region exposes exactly its issued decode payload");
        free(identityError); identityError = NULL;
        SPCaptureFrameIdentity taggedIdentity = {0};
        NSString *unknownReason = nil, *decodeError = nil;
        bool decodedTag = taggedSnapshot && sp_capture_frame_identity_decode(taggedSnapshot, tagROI, issuedPayloads,
            &taggedIdentity, &unknownReason, &decodeError);
        check(decodedTag && taggedIdentity.generation == 91 && taggedIdentity.raster == 10
            && taggedIdentity.sequence == 1 && unknownReason == nil && decodeError == nil,
            @"TEST 1A: Vision decodes the exact identity embedded in the presented layer inside its reserved ROI");
        [issuedPayloads release]; [unknownReason release]; [decodeError release];
        if (rawSnapshot && taggedSnapshot) {
            CFDataRef rawBytes = CGDataProviderCopyData(CGImageGetDataProvider(rawSnapshot));
            CFDataRef taggedBytes = CGDataProviderCopyData(CGImageGetDataProvider(taggedSnapshot));
            size_t rawStride = CGImageGetBytesPerRow(rawSnapshot), taggedStride = CGImageGetBytesPerRow(taggedSnapshot);
            BOOL unchangedOutsideROI = rawBytes && taggedBytes;
            for (size_t y = 0; unchangedOutsideROI && y < CGImageGetHeight(rawSnapshot); y++) {
                for (size_t x = 0; x < CGImageGetWidth(rawSnapshot); x++) {
                    if (x >= (size_t)tagROI.origin.x && x < (size_t)CGRectGetMaxX(tagROI)
                        && y < (size_t)CGRectGetMaxY(tagROI)) continue;
                    if (memcmp((const uint8_t *)CFDataGetBytePtr(rawBytes) + y * rawStride + x * 4,
                        (const uint8_t *)CFDataGetBytePtr(taggedBytes) + y * taggedStride + x * 4, 4) != 0) {
                        unchangedOutsideROI = NO; break;
                    }
                }
            }
            check(unchangedOutsideROI, @"TEST 1A: the tagged image preserves every source pixel outside the reserved ROI");
            if (rawBytes) CFRelease(rawBytes);
            if (taggedBytes) CFRelease(taggedBytes);
        }
        if (rawSnapshot) CGImageRelease(rawSnapshot);
        sp_image_capture_match_identity_session_end();
        sp_image_capture_match_end();
        sp_region_close(identityRegion);
        if (identitySurface) CFRelease(identitySurface);

        void *smallIdentityRegion = sp_region_create(surface, "small-identity", testEvent, NULL);
        sp_region_place(smallIdentityRegion, 0, 0, 0, 330, true);
        double smallRaster[3] = {0};
        check(sp_region_raster(smallIdentityRegion, smallRaster) && smallRaster[1] < 192,
            @"TEST 1A: the undersized identity raster cannot contain the reserved ROI");
        unsigned char smallToken[16];
        IOSurfaceRef smallSurface = createColoredGlobalSurface((size_t)smallRaster[0],
            (size_t)smallRaster[1], smallToken);
        char directoryTemplate[] = "/tmp/soksak-frame-identity-failure-XXXXXX";
        char *identityDirectory = mkdtemp(directoryTemplate);
        dispatch_queue_t identityWriter = dispatch_queue_create("test.frame-identity.writer", DISPATCH_QUEUE_SERIAL);
        check(identityDirectory != NULL, @"TEST 1A: the failed-tag artifact directory is created");
        sp_image_capture_match_begin(identityDirectory, identityWriter);
        identityError = NULL;
        check(sp_image_capture_match_identity_session_begin(&identityError) && identityError == NULL,
            @"TEST 1A: the undersized-raster fixture starts an identity session");
        free(identityError); identityError = NULL;
        BOOL smallPresented = smallSurface && sp_region_present(smallIdentityRegion, IOSurfaceGetID(smallSurface),
            smallToken, smallRaster[0], smallRaster[1], smallRaster[2], 92, 10, 1);
        check(smallPresented, @"TEST 1A: an undersized tag ROI does not block raw image presentation");
        check(!sp_image_capture_match_identity_session_active(),
            @"TEST 1A: an untaggable source marks the opt-in identity session failed");
        char *identityFailure = sp_image_capture_match_identity_session_error_copy();
        check(identityFailure != NULL && strstr(identityFailure, "ROI") != NULL,
            @"TEST 1A: the failed identity session preserves the explicit ROI error");
        free(identityFailure);
        BOOL failureManifest = identityDirectory
            && sp_image_capture_match_write_manifest(identityDirectory);
        check(!failureManifest, @"TEST 1A: finalizing an untaggable identity session reports failure");
        NSString *failureManifestPath = [[NSString stringWithUTF8String:identityDirectory ?: ""]
            stringByAppendingPathComponent:@"frame-identities/manifest.json"];
        NSDictionary *failureMetadata = [NSJSONSerialization JSONObjectWithData:
            [NSData dataWithContentsOfFile:failureManifestPath] options:0 error:NULL];
        check([failureMetadata[@"identityFailure"] isKindOfClass:NSString.class],
            @"TEST 1A: the tagged artifact manifest records why identity capture failed");
        sp_image_capture_match_end();
        dispatch_release(identityWriter);
        sp_region_close(smallIdentityRegion);
        if (smallSurface) CFRelease(smallSurface);
        if (identityDirectory) [[NSFileManager defaultManager] removeItemAtPath:
            [NSString stringWithUTF8String:identityDirectory] error:NULL];
    }

    // TEST 2: nonce mismatch - false return and "forbidden" event
    {
        [collectedEvents removeAllObjects];
        unsigned char nonce2[16];
        unsigned char wrongNonce[16];
        IOSurfaceRef testSurface2 = createColoredGlobalSurface(100, 100, nonce2);
        IOSurfaceID sid2 = IOSurfaceGetID(testSurface2);
        arc4random_buf(wrongNonce, 16);

        void *region2 = sp_region_create(surface, "test2", testEvent, NULL);
        BOOL presented = sp_region_present(region2, sid2, wrongNonce, 100, 100, window.backingScaleFactor, 42, 7, 1);
        check(!presented, @"TEST 2: sp_region_present returns false with wrong nonce");

        check([collectedEvents count] > 0, @"TEST 2: event received");
        if ([collectedEvents count] > 0) {
            NSString *eventStr = [collectedEvents objectAtIndex:0];
            check([eventStr rangeOfString:@"\"reason\":\"forbidden\""].location != NSNotFound,
                [NSString stringWithFormat:@"TEST 2: event contains 'forbidden' reason (got: %@)", eventStr]);
        }

        sp_region_close(region2);
        CFRelease(testSurface2);
    }

    // TEST 3: unknown ID - false return and "notFound" event
    {
        [collectedEvents removeAllObjects];
        unsigned char nonce3[16];
        arc4random_buf(nonce3, 16);

        void *region3 = sp_region_create(surface, "test3", testEvent, NULL);
        BOOL presented = sp_region_present(region3, 0xdeadbeef, nonce3, 100, 100, window.backingScaleFactor, 43, 7, 1);
        check(!presented, @"TEST 3: sp_region_present returns false with non-existent ID");

        check([collectedEvents count] > 0, @"TEST 3: event received");
        if ([collectedEvents count] > 0) {
            NSString *eventStr = [collectedEvents objectAtIndex:0];
            check([eventStr rangeOfString:@"\"reason\":\"notFound\""].location != NSNotFound,
                [NSString stringWithFormat:@"TEST 3: event contains 'notFound' reason (got: %@)", eventStr]);
        }

        sp_region_close(region3);
    }

    // TEST 4: size mismatch - false return and "size" event
    {
        [collectedEvents removeAllObjects];
        unsigned char nonce4[16];
        IOSurfaceRef testSurface4 = createColoredGlobalSurface(100, 100, nonce4);
        IOSurfaceID sid4 = IOSurfaceGetID(testSurface4);

        void *region4 = sp_region_create(surface, "test4", testEvent, NULL);
        BOOL presented = sp_region_present(region4, sid4, nonce4, 200, 200, window.backingScaleFactor, 44, 7, 1);  // Wrong size
        check(!presented, @"TEST 4: sp_region_present returns false with wrong size");

        check([collectedEvents count] > 0, @"TEST 4: event received");
        if ([collectedEvents count] > 0) {
            NSString *eventStr = [collectedEvents objectAtIndex:0];
            check([eventStr rangeOfString:@"\"reason\":\"size\""].location != NSNotFound,
                [NSString stringWithFormat:@"TEST 4: event contains 'size' reason (got: %@)", eventStr]);
        }

        sp_region_close(region4);
        CFRelease(testSurface4);
    }

    // TEST 5: placement - margins are kept
    {
        [collectedEvents removeAllObjects];

        void *region5 = sp_region_create(surface, "test5", testEvent, NULL);
        sp_region_place(region5, 50, 60, 70, 80, true);

        double frame[6] = {0};
        sp_region_frame(region5, frame);
        // Initial: 500x400, margins L:50, T:60, R:70, B:80 -> actual size: 500-50-70=380, 400-60-80=260
        check(frame[0] == 50 && frame[1] == 60 && frame[2] == 380 && frame[3] == 260,
            [NSString stringWithFormat:@"TEST 5: initial frame has correct insets (%.0f, %.0f, %.0f, %.0f)",
                frame[0], frame[1], frame[2], frame[3]]);

        // Changes the window size
        [window setContentSize:NSMakeSize(600, 500)];
        // The contentView of the window may not be resized automatically, so it is set explicitly
        webviewSetFrame(surface, 0, 0, 600, 500);
        // Runs the run loop so that the frame change notification is delivered
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
        sp_region_frame(region5, frame);
        // 600x500, margins kept: 600-50-70=480, 500-60-80=360
        check(frame[0] == 50 && frame[1] == 60 && frame[2] == 480 && frame[3] == 360,
            [NSString stringWithFormat:@"TEST 5: frame follows surface size (%.0f, %.0f, %.0f, %.0f)",
                frame[0], frame[1], frame[2], frame[3]]);

        // Returns the window to its original size
        [window setContentSize:NSMakeSize(500, 400)];
        webviewSetFrame(surface, 0, 0, 500, 400);

        sp_region_close(region5);
    }

    // TEST 5A: the prepared frame uses the exact size of the new raster.
    {
        [collectedEvents removeAllObjects];

        void *region5a = sp_region_create(surface, "test5a", testEvent, NULL);
        sp_region_place(region5a, 50, 60, 70, 80, true);
        double raster5a[3] = {0};
        check(sp_region_raster(region5a, raster5a), @"TEST 5A: initial raster exists");
        unsigned char nonce5a[16];
        IOSurfaceRef testSurface5a = createColoredGlobalSurface((size_t)raster5a[0], (size_t)raster5a[1], nonce5a);
        check(sp_region_present(region5a, IOSurfaceGetID(testSurface5a), nonce5a,
            raster5a[0], raster5a[1], raster5a[2], 45, 8, 1), @"TEST 5A: initial snapshot is presented");
        check(!sp_region_present(region5a, IOSurfaceGetID(testSurface5a), nonce5a,
            raster5a[0] + 1, raster5a[1], raster5a[2], 45, 99, 99),
            @"TEST 5A: a rejected frame does not replace the source identity");
        const char *initialFacts5a = sp_region_facts(region5a);
        check(initialFacts5a && strstr(initialFacts5a, "\"generation\":45") && strstr(initialFacts5a, "\"raster\":8") &&
            strstr(initialFacts5a, "\"sequence\":1"), @"TEST 5A: rejected frame leaves the previous identity intact");
        free((void *)initialFacts5a);

        // During real presentation, the open CATransaction of SurfaceHost
        // hides this prepared geometry, and the host commits it at once together with the matching raster.
        sp_region_place(region5a, 100, 40, 20, 30, true);
        double frame5a[6] = {0};
        sp_region_frame(region5a, frame5a);
        check(frame5a[0] == 100 && frame5a[1] == 40 && frame5a[2] == 380 && frame5a[3] == 330,
            [NSString stringWithFormat:@"TEST 5A: prepared frame follows new insets (%.0f, %.0f, %.0f, %.0f)",
                frame5a[0], frame5a[1], frame5a[2], frame5a[3]]);

        double raster5aNew[3] = {0};
        check(sp_region_raster(region5a, raster5aNew), @"TEST 5A: new raster dimensions are measured");
        unsigned char nonce5aNew[16];
        IOSurfaceRef testSurface5aNew = createColoredGlobalSurface(
            (size_t)raster5aNew[0], (size_t)raster5aNew[1], nonce5aNew);
        check(sp_region_present(region5a, IOSurfaceGetID(testSurface5aNew), nonce5aNew,
            raster5aNew[0], raster5aNew[1], raster5aNew[2], 45, 9, 2),
            @"TEST 5A: matching raster commits new frame");
        const char *facts5a = sp_region_facts(region5a);
        check(facts5a && strstr(facts5a, "\"generation\":45") && strstr(facts5a, "\"raster\":9") &&
            strstr(facts5a, "\"sequence\":2"), @"TEST 5A: snapshot replacement updates its source frame identity");
        free((void *)facts5a);
        sp_region_frame(region5a, frame5a);
        check(frame5a[0] == 100 && frame5a[1] == 40 && frame5a[2] == 380 && frame5a[3] == 330,
            [NSString stringWithFormat:@"TEST 5A: matching raster commits new insets (%.0f, %.0f, %.0f, %.0f)",
                frame5a[0], frame5a[1], frame5a[2], frame5a[3]]);

        sp_region_close(region5a);
        CFRelease(testSurface5a);
        CFRelease(testSurface5aNew);
    }

    // TEST 6: pointer input is still owned by the DOM anchor.
    {
        [collectedEvents removeAllObjects];

        void *region6 = sp_region_create(surface, "test6", testEvent, NULL);
        sp_region_place(region6, 10, 10, 10, 10, true);

        NSView *regionView = (NSView *)region6;
        NSPoint testPoint = NSMakePoint(20, 20);  // A point inside the region
        NSView *hitView = [regionView hitTest:testPoint];
        check(hitView == nil, @"TEST 6: hitTest returns nil so the DOM receives pointer input");

        sp_region_close(region6);
    }

    // TEST 7: focus - focus event and hasFocus state
    {
        [collectedEvents removeAllObjects];

        void *region7 = sp_region_create(surface, "test7", testEvent, NULL);
        sp_region_place(region7, 10, 10, 10, 10, true);

        sp_region_focus(region7);

        double frame[6] = {0};
        sp_region_frame(region7, frame);
        check(frame[5] == 1, @"TEST 7: region frame out[5] (focused) is 1");

        check([collectedEvents count] > 0, @"TEST 7: focus event received");
        BOOL foundFocusEvent = NO;
        for (NSString *eventStr in collectedEvents) {
            if ([eventStr rangeOfString:@"\"type\":\"focus\""].location != NSNotFound &&
                [eventStr rangeOfString:@"\"focused\":true"].location != NSNotFound) {
                foundFocusEvent = YES;
                break;
            }
        }
        check(foundFocusEvent, @"TEST 7: focus event has correct format");

        sp_region_close(region7);
    }

    // TEST 8: the input client stores only marked text and reports committed transactions.
    {
        void *region8 = sp_region_create(surface, "test8", testEvent, NULL);
        sp_region_place(region8, 10, 10, 10, 10, true);
        sp_region_focus(region8);
        NSView *regionView = (NSView *)region8;
        id<NSTextInputClient> client = (id<NSTextInputClient>)region8;

        check([regionView validRequestorForSendType:NSPasteboardTypeString returnType:NSPasteboardTypeString] == nil
            && [regionView validRequestorForSendType:NSPasteboardTypeString returnType:nil] == nil,
            @"TEST 8: Services cannot read or replace the marked-text buffer");
        check([regionView hitTest:NSMakePoint(1, 1)] == nil,
            @"TEST 8: the native input client does not receive pointer input");

        NSUInteger beforePlainInsert = collectedEvents.count;
        [client insertText:@"\"a\" -- (c) teh" replacementRange:NSMakeRange(NSNotFound, 0)];
        check([committedTexts(beforePlainInsert) isEqualToArray:@[@"\"a\" -- (c) teh"]]
            && [lastPreedit(beforePlainInsert) isEqual:@""],
            [NSString stringWithFormat:@"TEST 8: insertText preserves exact plain text without substitutions (got %@)",
                [collectedEvents subarrayWithRange:NSMakeRange(beforePlainInsert, collectedEvents.count - beforePlainInsert)]]);

        [client setMarkedText:@"a😀c" selectedRange:NSMakeRange(3, 0)
            replacementRange:NSMakeRange(NSNotFound, 0)];
        check([client hasMarkedText] && NSEqualRanges([client markedRange], NSMakeRange(0, 4))
            && NSEqualRanges([client selectedRange], NSMakeRange(3, 0))
            && [lastPreedit(collectedEvents.count - 1) isEqual:@"a😀c"],
            @"TEST 8: marked and selected ranges use UTF-16 offsets in the pending buffer");
        NSRange actualRange = NSMakeRange(NSNotFound, 0);
        NSAttributedString *substring = [client attributedSubstringForProposedRange:NSMakeRange(1, 2)
            actualRange:&actualRange];
        check([substring.string isEqual:@"😀"] && NSEqualRanges(actualRange, NSMakeRange(1, 2)),
            [NSString stringWithFormat:@"TEST 8: substring queries return the requested UTF-16 range (got %@ at %@)",
                substring.string, NSStringFromRange(actualRange)]);

        BOOL activeBeforeCallback = NSApp.isActive;
        BOOL keyWindowBeforeCallback = regionView.window.isKeyWindow;
        NSArray<NSDictionary *> *stateRecords = capturedEvents(^{
            [client setMarkedText:@"a😀c" selectedRange:NSMakeRange(3, 0)
                replacementRange:NSMakeRange(NSNotFound, 0)];
        });
        NSDictionary *stateCallback = nil;
        for (NSDictionary *event in stateRecords) {
            if ([event[@"name"] isEqual:@"native.input.callback"]
                && [event[@"fields"][@"call"] isEqual:@"setMarkedText"]) stateCallback = event[@"fields"];
        }
        NSDictionary *stateBefore = stateCallback[@"before"];
        NSDictionary *stateAfter = stateCallback[@"after"];
        check(stateCallback != nil
            && jsonBooleanMatches(stateBefore[@"active"], activeBeforeCallback)
            && jsonBooleanMatches(stateBefore[@"keyWindow"], keyWindowBeforeCallback)
            && jsonBooleanMatches(stateAfter[@"active"], NSApp.isActive)
            && jsonBooleanMatches(stateAfter[@"keyWindow"], regionView.window.isKeyWindow),
            [NSString stringWithFormat:@"TEST 8: callback before/after state records AppKit active and key-window booleans (got %@)",
                stateCallback]);

        NSUInteger beforePartialReplace = collectedEvents.count;
        [client setMarkedText:@"x" selectedRange:NSMakeRange(1, 0)
            replacementRange:NSMakeRange(1, 2)];
        check([client hasMarkedText] && NSEqualRanges([client markedRange], NSMakeRange(0, 3))
            && NSEqualRanges([client selectedRange], NSMakeRange(2, 0))
            && [lastPreedit(beforePartialReplace) isEqual:@"axc"],
            [NSString stringWithFormat:@"TEST 8: partial replacement updates only the selected UTF-16 span (got %@)",
                [collectedEvents subarrayWithRange:NSMakeRange(beforePartialReplace, collectedEvents.count - beforePartialReplace)]]);

        NSUInteger beforeInvalidRange = collectedEvents.count;
        [client setMarkedText:@"z" selectedRange:NSMakeRange(2, 0)
            replacementRange:NSMakeRange(NSNotFound, 0)];
        BOOL rejectedSelection = NO;
        for (NSUInteger index = beforeInvalidRange; index < collectedEvents.count; index++) {
            NSDictionary *event = [NSJSONSerialization JSONObjectWithData:[collectedEvents[index] dataUsingEncoding:NSUTF8StringEncoding]
                options:0 error:NULL];
            for (NSDictionary *error in event[@"errors"]) {
                if ([error[@"reason"] containsString:@"selected range"]) rejectedSelection = YES;
            }
        }
        check(rejectedSelection && [client hasMarkedText]
            && [lastPreedit(beforeInvalidRange) isEqual:@"axc"],
            [NSString stringWithFormat:@"TEST 8: invalid selection reports an error and preserves the last valid buffer (got %@)",
                [collectedEvents subarrayWithRange:NSMakeRange(beforeInvalidRange, collectedEvents.count - beforeInvalidRange)]]);

        NSUInteger beforeUnmark = collectedEvents.count;
        [client unmarkText];
        check([committedTexts(beforeUnmark) isEqualToArray:@[@"axc"]]
            && ![client hasMarkedText] && NSEqualRanges([client markedRange], NSMakeRange(NSNotFound, 0))
            && [lastPreedit(beforeUnmark) isEqual:@""],
            [NSString stringWithFormat:@"TEST 8: unmarkText commits the buffer once and clears marked state (got %@)",
                [collectedEvents subarrayWithRange:NSMakeRange(beforeUnmark, collectedEvents.count - beforeUnmark)]]);
        NSUInteger afterUnmark = collectedEvents.count;
        [client unmarkText];
        check(collectedEvents.count == afterUnmark,
            @"TEST 8: unmarkText without marked text emits no duplicate transaction");

        NSUInteger beforeCommand = collectedEvents.count;
        [client doCommandBySelector:@selector(deleteForward:)];
        check(collectedEvents.count == beforeCommand + 1
            && [collectedEvents.lastObject containsString:@"deleteForward:"],
            @"TEST 8: doCommandBySelector reports the command selector");

        NSArray<NSDictionary *> *captured = capturedEvents(^{
            [client setMarkedText:@"pending" selectedRange:NSMakeRange(7, 0)
                replacementRange:NSMakeRange(NSNotFound, 0)];
            [client insertText:@42 replacementRange:NSMakeRange(NSNotFound, 0)];
        });
        BOOL markedCallbackRecorded = NO;
        BOOL invalidInsertRecorded = NO;
        for (NSDictionary *event in captured) {
            NSDictionary *fields = event[@"fields"];
            if ([event[@"name"] isEqual:@"native.input.callback"]
                && [fields[@"call"] isEqual:@"setMarkedText"] && [fields[@"after"][@"markedText"] isEqual:@"pending"])
                markedCallbackRecorded = YES;
            if ([event[@"name"] isEqual:@"native.input.callback"]
                && [fields[@"call"] isEqual:@"insertText"] && [fields[@"dropped"] isEqual:@"not text"])
                invalidInsertRecorded = YES;
        }
        check(markedCallbackRecorded && invalidInsertRecorded,
            [NSString stringWithFormat:@"TEST 8: callbacks record buffer state and reject non-text input (got %@)", captured]);

        [regionView retain];
        sp_region_close(region8);
        NSArray<NSDictionary *> *closedEvents = capturedEvents(^{
            [client insertText:@"x" replacementRange:NSMakeRange(NSNotFound, 0)];
        });
        [regionView release];
        BOOL droppedClosedReport = NO;
        for (NSDictionary *event in closedEvents) {
            if ([event[@"name"] isEqual:@"native.input.report"] && [event[@"fields"][@"dropped"] isEqual:@YES])
                droppedClosedReport = YES;
        }
        check(droppedClosedReport,
            [NSString stringWithFormat:@"TEST 8: reporting through a closed region is recorded as dropped (got %@)", closedEvents]);
    }

    // TEST 9: accessibility and caret
    {
        [collectedEvents removeAllObjects];

        void *region9 = sp_region_create(surface, "test9", testEvent, NULL);
        sp_region_place(region9, 10, 10, 10, 10, true);

        id regionView = (id)region9;

        // Sets the accessibility text
        const char *testText = "Hello 접근성";
        sp_region_text(region9, testText);

        // Checks the accessibility value
        NSString *accessibilityValue = [regionView accessibilityValue];
        check([accessibilityValue isEqualToString:@"Hello 접근성"],
            [NSString stringWithFormat:@"TEST 9: accessibility text matches (got: %@)", accessibilityValue]);

        // Checks the role
        NSAccessibilityRole role = [regionView accessibilityRole];
        check([role isEqualToString:NSAccessibilityTextAreaRole],
            [NSString stringWithFormat:@"TEST 9: accessibility role is TextAreaRole (got: %@)", role]);

        // Sets and checks the caret position
        sp_region_caret(region9, 25, 30, 2, 16);
        NSRange charRange = NSMakeRange(0, 1);
        NSRect caretRect = [(id<NSTextInputClient>)regionView firstRectForCharacterRange:charRange actualRange:NULL];
        // The size that was set must come back unchanged (a check of "is not 0" also passes when a constant is returned).
        check(caretRect.size.width == 2 && caretRect.size.height == 16,
            [NSString stringWithFormat:@"TEST 9: caret rect keeps the size we set (x:%.0f y:%.0f w:%.0f h:%.0f)",
                caretRect.origin.x, caretRect.origin.y, caretRect.size.width, caretRect.size.height]);

        // When a different caret is set, the result moves accordingly.
        NSRect first = caretRect;
        sp_region_caret(region9, 25, 60, 3, 20);
        NSRect second = [(id<NSTextInputClient>)regionView firstRectForCharacterRange:charRange actualRange:NULL];
        check(second.size.width == 3 && second.size.height == 20 && second.origin.y != first.origin.y,
            @"TEST 9: a new caret replaces the reported rect");

        // Each query of the input method is an event with the name of the query and its answer.
        NSArray<NSDictionary *> *queryEvents = capturedEvents(^{
            [(id<NSTextInputClient>)regionView firstRectForCharacterRange:charRange actualRange:NULL];
            [(id<NSTextInputClient>)regionView markedRange];
            [(id<NSTextInputClient>)regionView selectedRange];
            [(id<NSTextInputClient>)regionView hasMarkedText];
            [(id<NSTextInputClient>)regionView characterIndexForPoint:NSMakePoint(1, 2)];
        });
        NSMutableArray<NSString *> *queried = [NSMutableArray array];
        for (NSDictionary *event in queryEvents) {
            if ([event[@"name"] isEqual:@"native.input.query"]) [queried addObject:event[@"fields"][@"call"]];
        }
        NSArray *wantQueries = @[@"firstRectForCharacterRange", @"markedRange", @"selectedRange", @"hasMarkedText", @"characterIndexForPoint"];
        check([queried isEqualToArray:wantQueries], [NSString stringWithFormat:@"TEST 9: the queries of the input method are events (got: %@)", queried]);

        sp_region_close(region9);
    }

    // TEST 10: key event - up arrow
    {
        [collectedEvents removeAllObjects];

        void *region10 = sp_region_create(surface, "test10", testEvent, NULL);
        sp_region_place(region10, 10, 10, 10, 10, true);
        sp_region_focus(region10);

        id regionView = (id)region10;
        NSEvent *upEvent = [NSEvent keyEventWithType:NSEventTypeKeyDown
            location:NSZeroPoint
            modifierFlags:0
            timestamp:0
            windowNumber:0
            context:nil
            characters:@""
            charactersIgnoringModifiers:@""  // NSUpArrowFunctionKey
            isARepeat:NO
            keyCode:126];

        [collectedEvents removeAllObjects];
        [regionView keyDown:upEvent];

        check([collectedEvents count] == 1,
            [NSString stringWithFormat:@"TEST 10: exactly 1 event for Up arrow (got %lu)", [collectedEvents count]]);
        if ([collectedEvents count] > 0) {
            NSString *eventStr = [collectedEvents objectAtIndex:0];
            NSDictionary *keyTransaction = [NSJSONSerialization JSONObjectWithData:[eventStr dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL];
            NSDictionary *keyAction = [keyTransaction[@"actions"] firstObject];
            BOOL isKeyEvent = [keyTransaction[@"type"] isEqual:@"input"] && [keyAction[@"type"] isEqual:@"key"];
            BOOL hasKeyUp = [eventStr rangeOfString:@"\"key\":\"Up\""].location != NSNotFound;
            BOOL noInsert = [eventStr rangeOfString:@"\"insert\""].location == NSNotFound;
            BOOL correctFlags = [keyAction[@"shift"] isEqual:@NO] && [keyAction[@"alt"] isEqual:@NO]
                && [keyAction[@"ctrl"] isEqual:@NO];
            check(isKeyEvent && hasKeyUp && noInsert && correctFlags,
                [NSString stringWithFormat:@"TEST 10: event is correct key event (got: %@)", eventStr]);
        }

        sp_region_close(region10);
    }

    // TEST 11: key event - Return
    {
        [collectedEvents removeAllObjects];

        void *region11 = sp_region_create(surface, "test11", testEvent, NULL);
        sp_region_place(region11, 10, 10, 10, 10, true);
        sp_region_focus(region11);

        id regionView = (id)region11;
        NSEvent *returnEvent = [NSEvent keyEventWithType:NSEventTypeKeyDown
            location:NSZeroPoint
            modifierFlags:0
            timestamp:0
            windowNumber:0
            context:nil
            characters:@"\r"
            charactersIgnoringModifiers:@"\r"
            isARepeat:NO
            keyCode:36];

        [collectedEvents removeAllObjects];
        [regionView keyDown:returnEvent];

        check([collectedEvents count] == 1,
            [NSString stringWithFormat:@"TEST 11: exactly 1 event for Return (got %lu)", [collectedEvents count]]);
        if ([collectedEvents count] > 0) {
            NSString *eventStr = [collectedEvents objectAtIndex:0];
            BOOL hasKeyEnter = [eventStr rangeOfString:@"\"key\":\"Enter\""].location != NSNotFound;
            check(hasKeyEnter,
                [NSString stringWithFormat:@"TEST 11: event has key:Enter (got: %@)", eventStr]);
        }

        // The first layer that sees the key assigns the correlation identifier: the key event, the report and the event that
        // the page receives carry the same one.
        NSUInteger beforeKey = [collectedEvents count];
        NSArray<NSDictionary *> *keyEvents = capturedEvents(^{ [regionView keyDown:returnEvent]; });
        NSDictionary *keyDown = nil, *keyReport = nil;
        for (NSDictionary *event in keyEvents) {
            if ([event[@"name"] isEqual:@"native.input.key_down"]) keyDown = event;
            if ([event[@"name"] isEqual:@"native.input.report"] && [event[@"fields"][@"report"] containsString:@"\"key\":\"Enter\""]) keyReport = event;
        }
        NSDictionary *pageKey = collectedEvents.count > beforeKey
            ? [NSJSONSerialization JSONObjectWithData:[collectedEvents[beforeKey] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL] : nil;
        check(keyDown && [keyDown[@"cids"] count] == 1 && [keyDown[@"level"] intValue] == SP_EVENT_INFO
                && [keyDown[@"fields"][@"keyCode"] isEqual:@36] && [keyDown[@"fields"][@"characters"] isEqual:@"\r"]
                && [keyDown[@"fields"][@"before"][@"markedText"] isEqual:@""],
            [NSString stringWithFormat:@"TEST 11: a key is the event native.input.key_down with its code, characters and one identifier (got %@)", keyEvents]);
        check(keyDown && keyReport && [keyReport[@"cids"] isEqualToArray:keyDown[@"cids"]] && [pageKey[@"cids"] isEqualToArray:keyDown[@"cids"]]
                && [keyDown[@"cids"][0] hasPrefix:@"native-test."],
            [NSString stringWithFormat:@"TEST 11: the key event, its report and the event of the page carry the identifier <boot>.<n> (got %@ and %@)", keyEvents, pageKey]);
        NSArray<NSDictionary *> *again = capturedEvents(^{ [regionView keyDown:returnEvent]; });
        NSDictionary *secondKey = nil;
        for (NSDictionary *event in again) if ([event[@"name"] isEqual:@"native.input.key_down"]) secondKey = event;
        check(secondKey && ![secondKey[@"cids"] isEqualToArray:keyDown[@"cids"]], @"TEST 11: the next key is another input with another identifier");

        sp_region_close(region11);
    }

    // Like pointer input, drag and drop also passes the region and goes to the page. The region does not register drag types.
    {
        void *region = sp_region_create(surface, "drag", testEvent, NULL);
        sp_region_place(region, 10, 10, 10, 10, true);
        NSArray *types = [(NSView *)region registeredDraggedTypes];
        check(types.count == 0, [NSString stringWithFormat:@"drag: the region registers no dragged types (got %@)", types]);
        sp_region_focus(region);
        types = [(NSView *)region registeredDraggedTypes];
        check(types.count == 0, [NSString stringWithFormat:@"drag: a focused region registers no dragged types (got %@)", types]);
        sp_region_close(region);
    }

    // Numeric keypad keys are reported by keypad key name without going through the input method. The sidecar determines the encoding of the application keypad mode.
    {
        void *region = sp_region_create(surface, "keypad", testEvent, NULL);
        sp_region_place(region, 10, 10, 10, 10, true);
        sp_region_focus(region);
        id regionView = (id)region;
        NSArray *cases = @[@[@"5", @87, @"Keypad5"], @[@".", @65, @"KeypadDecimal"], @[@"+", @69, @"KeypadPlus"],
            @[@"\x03", @76, @"KeypadEnter"], @[@"=", @81, @"KeypadEquals"]];
        for (NSArray *item in cases) {
            NSString *characters = [item[0] isEqualToString:@"\x03"] ? [NSString stringWithFormat:@"%C", (unichar)0x03] : item[0];
            NSEvent *event = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint
                modifierFlags:NSEventModifierFlagNumericPad timestamp:0 windowNumber:0 context:nil
                characters:characters charactersIgnoringModifiers:characters isARepeat:NO keyCode:[item[1] unsignedShortValue]];
            [collectedEvents removeAllObjects];
            [regionView keyDown:event];
            NSString *expected = [NSString stringWithFormat:@"\"key\":\"%@\"", item[2]];
            check(collectedEvents.count == 1 && [collectedEvents[0] rangeOfString:expected].location != NSNotFound,
                [NSString stringWithFormat:@"keypad: keyCode %@ reports %@ (got %@)", item[1], item[2], collectedEvents]);
        }
        sp_region_close(region);
    }

    // A key goes to the input method when it is a normal character or when the input client holds marked text; when the
    // input method does not answer (outside the key window of the active application), the key is reported as an error
    // instead of being dropped without a report. The test gives the region an input context that answers nothing.
    for (NSString *marked in @[@"", @"\u3139"]) {
        void *region = sp_region_create(surface, "silent", testEvent, NULL);
        sp_region_place(region, 10, 10, 10, 10, true);
        sp_region_focus(region);
        NSView *regionView = (NSView *)region;
        id<NSTextInputClient> client = (id<NSTextInputClient>)region;
        SilentInputContext *silent = [[[SilentInputContext alloc] initWithClient:client] autorelease];
        sp_region_set_input_context(region, silent);
        if (marked.length > 0) {
            [client setMarkedText:marked selectedRange:NSMakeRange(1, 0)
                replacementRange:NSMakeRange(NSNotFound, 0)];
        }
        check([client hasMarkedText] == (marked.length > 0),
            [NSString stringWithFormat:@"silent input method: the marked buffer holds \"%@\" when the key arrives", marked]);
        NSEvent *event = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:0
            windowNumber:0 context:nil characters:@"\u3147" charactersIgnoringModifiers:@"\u3147" isARepeat:NO keyCode:2];
        [collectedEvents removeAllObjects];
        NSArray<NSDictionary *> *captured = capturedEvents(^{ [regionView keyDown:event]; });
        BOOL reported = NO;
        for (NSString *report in collectedEvents) {
            if ([report containsString:@"input method did not answer native keyCode=2"]) reported = YES;
        }
        check(reported, [NSString stringWithFormat:@"silent input method: a key with marked text \"%@\" that the input method does not answer is reported as an error (got %@)", marked, collectedEvents]);
        // The error carries the identifier of the key, so the chain of the key ends at the error.
        NSArray *keyCids = nil, *errorCids = nil;
        for (NSDictionary *record in captured) {
            if ([record[@"name"] isEqual:@"native.input.key_down"]) keyCids = record[@"cids"];
            if ([record[@"name"] isEqual:@"native.record.error"]) errorCids = record[@"cids"];
        }
        check(keyCids.count == 1 && [errorCids isEqual:keyCids],
            [NSString stringWithFormat:@"silent input method: the error with marked text \"%@\" carries the identifier of the key (got %@)", marked, captured]);
        sp_region_close(region);
    }

    // TEST 12: key event - Backspace
    {
        [collectedEvents removeAllObjects];

        void *region12 = sp_region_create(surface, "test12", testEvent, NULL);
        sp_region_place(region12, 10, 10, 10, 10, true);
        sp_region_focus(region12);

        id regionView = (id)region12;
        NSEvent *backspaceEvent = [NSEvent keyEventWithType:NSEventTypeKeyDown
            location:NSZeroPoint
            modifierFlags:0
            timestamp:0
            windowNumber:0
            context:nil
            characters:@"\x7f"
            charactersIgnoringModifiers:@"\x7f"
            isARepeat:NO
            keyCode:51];

        [collectedEvents removeAllObjects];
        [regionView keyDown:backspaceEvent];

        check([collectedEvents count] == 1,
            [NSString stringWithFormat:@"TEST 12: exactly 1 event for Backspace (got %lu)", [collectedEvents count]]);
        if ([collectedEvents count] > 0) {
            NSString *eventStr = [collectedEvents objectAtIndex:0];
            BOOL hasKeyBackspace = [eventStr rangeOfString:@"\"key\":\"Backspace\""].location != NSNotFound;
            check(hasKeyBackspace,
                [NSString stringWithFormat:@"TEST 12: event has key:Backspace (got: %@)", eventStr]);
        }

        sp_region_close(region12);
    }

    // TEST 13: key event - Ctrl+C
    {
        [collectedEvents removeAllObjects];

        void *region13 = sp_region_create(surface, "test13", testEvent, NULL);
        sp_region_place(region13, 10, 10, 10, 10, true);
        sp_region_focus(region13);

        id regionView = (id)region13;
        NSEvent *ctrlCEvent = [NSEvent keyEventWithType:NSEventTypeKeyDown
            location:NSZeroPoint
            modifierFlags:NSEventModifierFlagControl
            timestamp:0
            windowNumber:0
            context:nil
            characters:@"c"
            charactersIgnoringModifiers:@"c"
            isARepeat:NO
            keyCode:8];

        [collectedEvents removeAllObjects];
        [regionView keyDown:ctrlCEvent];

        check([collectedEvents count] == 1,
            [NSString stringWithFormat:@"TEST 13: exactly 1 event for Ctrl+C (got %lu)", [collectedEvents count]]);
        if ([collectedEvents count] > 0) {
            NSString *eventStr = [collectedEvents objectAtIndex:0];
            BOOL isKeyEvent = [eventStr rangeOfString:@"\"type\":\"key\""].location != NSNotFound;
            BOOL hasKeyChar = [eventStr rangeOfString:@"\"key\":\"Char\""].location != NSNotFound;
            BOOL hasTextC = [eventStr rangeOfString:@"\"text\":\"c\""].location != NSNotFound;
            BOOL hasCtrl = [eventStr rangeOfString:@"\"ctrl\":true"].location != NSNotFound;
            BOOL noInsert = [eventStr rangeOfString:@"\"insert\""].location == NSNotFound;
            check(isKeyEvent && hasKeyChar && hasTextC && hasCtrl && noInsert,
                [NSString stringWithFormat:@"TEST 13: event is correct Ctrl+C event (got: %@)", eventStr]);
        }

        sp_region_close(region13);
    }

    // TEST 13a: Even when a Korean input source character arrives, the Ctrl key is delivered as a physical ANSI key
    {
        [collectedEvents removeAllObjects];

        void *region13a = sp_region_create(surface, "test13a", testEvent, NULL);
        sp_region_place(region13a, 10, 10, 10, 10, true);
        sp_region_focus(region13a);

        id regionView = (id)region13a;
        NSEvent *ctrlUEvent = [NSEvent keyEventWithType:NSEventTypeKeyDown
            location:NSZeroPoint
            modifierFlags:NSEventModifierFlagControl
            timestamp:0
            windowNumber:0
            context:nil
            characters:@"ㅕ"
            charactersIgnoringModifiers:@"ㅕ"
            isARepeat:NO
            keyCode:32];

        [collectedEvents removeAllObjects];
        [regionView keyDown:ctrlUEvent];

        check([collectedEvents count] == 1,
            [NSString stringWithFormat:@"TEST 13a: exactly 1 event for Ctrl+U (got %lu)", [collectedEvents count]]);
        if ([collectedEvents count] > 0) {
            NSString *eventStr = [collectedEvents objectAtIndex:0];
            BOOL hasKeyChar = [eventStr rangeOfString:@"\"key\":\"Char\""].location != NSNotFound;
            BOOL hasTextU = [eventStr rangeOfString:@"\"text\":\"u\""].location != NSNotFound;
            BOOL hasCtrl = [eventStr rangeOfString:@"\"ctrl\":true"].location != NSNotFound;
            check(hasKeyChar && hasTextU && hasCtrl,
                [NSString stringWithFormat:@"TEST 13a: Korean character payload maps by physical ANSI key (got: %@)", eventStr]);
        }

        sp_region_close(region13a);
    }

    // TEST 13b: An unsupported physical Ctrl key reports the native key and the received scalar
    {
        [collectedEvents removeAllObjects];

        void *region13b = sp_region_create(surface, "test13b", testEvent, NULL);
        sp_region_place(region13b, 10, 10, 10, 10, true);
        sp_region_focus(region13b);
        [collectedEvents removeAllObjects];

        id regionView = (id)region13b;
        NSEvent *unsupportedCtrlEvent = [NSEvent keyEventWithType:NSEventTypeKeyDown
            location:NSZeroPoint
            modifierFlags:NSEventModifierFlagControl
            timestamp:0
            windowNumber:0
            context:nil
            characters:@"ㅕ"
            charactersIgnoringModifiers:@"ㅕ"
            isARepeat:NO
            keyCode:104];

        [regionView keyDown:unsupportedCtrlEvent];

        check([collectedEvents count] == 1,
            [NSString stringWithFormat:@"TEST 13b: exactly 1 explicit error for unsupported Ctrl key (got %lu)", [collectedEvents count]]);
        if ([collectedEvents count] > 0) {
            NSString *eventStr = [collectedEvents objectAtIndex:0];
            NSDictionary *errorTransaction = [NSJSONSerialization JSONObjectWithData:[eventStr dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL];
            BOOL isError = [errorTransaction[@"type"] isEqual:@"input"] && [(NSArray *)errorTransaction[@"errors"] count] == 1;
            BOOL hasKeyCode = [eventStr rangeOfString:@"native keyCode=104"].location != NSNotFound;
            BOOL hasScalar = [eventStr rangeOfString:@"character=U+3155"].location != NSNotFound;
            BOOL noKeyFallback = [(NSArray *)errorTransaction[@"actions"] count] == 0;
            check(isError && hasKeyCode && hasScalar && noKeyFallback,
                [NSString stringWithFormat:@"TEST 13b: unsupported Ctrl input reports its physical key and character without forwarding a substitute (got: %@)", eventStr]);
        }

        sp_region_close(region13b);
    }

    // TEST 14: key event - ordinary character 'a'
    {
        [collectedEvents removeAllObjects];

        void *region14 = sp_region_create(surface, "test14", testEvent, NULL);
        sp_region_place(region14, 10, 10, 10, 10, true);
        sp_region_focus(region14);

        id regionView = (id)region14;
        NSEvent *aEvent = [NSEvent keyEventWithType:NSEventTypeKeyDown
            location:NSZeroPoint
            modifierFlags:0
            timestamp:0
            windowNumber:0
            context:nil
            characters:@"a"
            charactersIgnoringModifiers:@"a"
            isARepeat:NO
            keyCode:0];

        [collectedEvents removeAllObjects];
        [regionView keyDown:aEvent];
        [window makeFirstResponder:nil];

        BOOL noKeyEvent = YES;
        for (NSString *eventStr in collectedEvents) {
            if ([eventStr rangeOfString:@"\"type\":\"key\""].location != NSNotFound) noKeyEvent = NO;
        }
        check([committedTexts(0) isEqualToArray:@[@"a"]] && noKeyEvent,
            [NSString stringWithFormat:@"TEST 14: 'a' is committed once as text, not as a key event (got %@)", collectedEvents]);

        sp_region_close(region14);
    }

    // TEST 15: key event - Shift+Tab
    {
        [collectedEvents removeAllObjects];

        void *region15 = sp_region_create(surface, "test15", testEvent, NULL);
        sp_region_place(region15, 10, 10, 10, 10, true);
        sp_region_focus(region15);

        id regionView = (id)region15;
        NSEvent *backTabEvent = [NSEvent keyEventWithType:NSEventTypeKeyDown
            location:NSZeroPoint
            modifierFlags:NSEventModifierFlagShift
            timestamp:0
            windowNumber:0
            context:nil
            characters:@"\x19"  // NSBackTabCharacter
            charactersIgnoringModifiers:@"\x19"
            isARepeat:NO
            keyCode:48];

        [collectedEvents removeAllObjects];
        [regionView keyDown:backTabEvent];

        check([collectedEvents count] == 1,
            [NSString stringWithFormat:@"TEST 15: exactly 1 event for Shift+Tab (got %lu)", [collectedEvents count]]);
        if ([collectedEvents count] > 0) {
            NSString *eventStr = [collectedEvents objectAtIndex:0];
            BOOL hasKeyTab = [eventStr rangeOfString:@"\"key\":\"Tab\""].location != NSNotFound;
            BOOL hasShift = [eventStr rangeOfString:@"\"shift\":true"].location != NSNotFound;
            check(hasKeyTab && hasShift,
                [NSString stringWithFormat:@"TEST 15: event has key:Tab and shift:true (got: %@)", eventStr]);
        }

        sp_region_close(region15);
    }

    // TEST 16: Return during composition - no key event
    {
        [collectedEvents removeAllObjects];

        void *region16 = sp_region_create(surface, "test16", testEvent, NULL);
        sp_region_place(region16, 10, 10, 10, 10, true);
        sp_region_focus(region16);

        id regionView = (id)region16;

        // Starts composition
        [(id<NSTextInputClient>)regionView setMarkedText:@"ㅎ" selectedRange:NSMakeRange(1, 0) replacementRange:NSMakeRange(NSNotFound, 0)];
        [collectedEvents removeAllObjects];

        // Return during composition
        NSEvent *returnEvent = [NSEvent keyEventWithType:NSEventTypeKeyDown
            location:NSZeroPoint
            modifierFlags:0
            timestamp:0
            windowNumber:0
            context:nil
            characters:@"\r"
            charactersIgnoringModifiers:@"\r"
            isARepeat:NO
            keyCode:36];

        [regionView keyDown:returnEvent];

        BOOL foundKeyEvent = NO;
        for (NSString *eventStr in collectedEvents) {
            if ([eventStr rangeOfString:@"\"type\":\"key\""].location != NSNotFound) {
                foundKeyEvent = YES;
                break;
            }
        }
        check(!foundKeyEvent,
            [NSString stringWithFormat:@"TEST 16: no key event during composition (got %lu events)", [collectedEvents count]]);

        sp_region_close(region16);
    }

    // TEST 17: Command+C - no key/insert event
    {
        [collectedEvents removeAllObjects];

        void *region17 = sp_region_create(surface, "test17", testEvent, NULL);
        sp_region_place(region17, 10, 10, 10, 10, true);
        sp_region_focus(region17);

        id regionView = (id)region17;
        NSEvent *cmdCEvent = [NSEvent keyEventWithType:NSEventTypeKeyDown
            location:NSZeroPoint
            modifierFlags:NSEventModifierFlagCommand
            timestamp:0
            windowNumber:0
            context:nil
            characters:@"c"
            charactersIgnoringModifiers:@"c"
            isARepeat:NO
            keyCode:8];

        [collectedEvents removeAllObjects];
        [regionView keyDown:cmdCEvent];

        BOOL foundKeyOrInsert = NO;
        for (NSString *eventStr in collectedEvents) {
            if ([eventStr rangeOfString:@"\"type\":\"key\""].location != NSNotFound ||
                [eventStr rangeOfString:@"\"type\":\"insert\""].location != NSNotFound) {
                foundKeyOrInsert = YES;
                break;
            }
        }
        check(!foundKeyOrInsert,
            [NSString stringWithFormat:@"TEST 17: no key or insert event for Command+C (got %lu events)", [collectedEvents count]]);

        sp_region_close(region17);
    }

    // TEST 18: checks that the clip view is below the DOM plane within the native plane of SurfaceHost
    {
        [collectedEvents removeAllObjects];

        void *region18 = sp_region_create(surface, "test18", testEvent, NULL);
        check(region18 != NULL, @"TEST 18: region created");

        sp_region_place(region18, 10, 10, 10, 10, true);

        NSView *regionView = (NSView *)region18;
        NSView *clipView = regionView.superview;
        check(clipView != nil && ![clipView isKindOfClass:[WKWebView class]],
            @"TEST 18: region has a non-WebView superview (clipView)");

        NSView *surfaceSuperSuperview = clipView.superview;
        check(surfaceSuperSuperview == nativePlane && nativePlane.superview == surface.superview,
            @"TEST 18: clipView is inside the surface host native plane");

        // Inside SurfaceHost the DOM web view is above the native plane,
        // and in the outer compositor the whole SurfaceHost is above the application DOM backing.
        NSArray *subviews = surface.superview.subviews;
        NSUInteger surfaceIndex = [subviews indexOfObject:surface];
        NSUInteger nativeIndex = [subviews indexOfObject:nativePlane];
        check(nativeIndex != NSNotFound && surfaceIndex != NSNotFound && nativeIndex < surfaceIndex,
            [NSString stringWithFormat:@"TEST 18: native plane is below DOM plane inside SurfaceHost (native:%lu, DOM:%lu)",
                (unsigned long)nativeIndex, (unsigned long)surfaceIndex]);

        sp_region_close(region18);
    }

    // TEST 19: checks that the scale of the displayed image is set to the actual window backing scale.
    {
        [collectedEvents removeAllObjects];
        void *region19 = sp_region_create(surface, "test19", testEvent, NULL);
        // Sets large insets so that the region size is about 100x80
        // 500 - 200 - 200 = 100, 400 - 160 - 160 = 80
        sp_region_place(region19, 200, 160, 200, 160, true);
        double raster19[3] = {0};
        CGFloat backingScale19 = window.backingScaleFactor;
        check(backingScale19 > 0, @"TEST 19: window reports a positive backing scale");
        check(sp_region_raster(region19, raster19), @"TEST 19: region reports its backing-scale raster");
        unsigned char nonce19[16];
        IOSurfaceRef testSurface19 = createColoredGlobalSurface((size_t)raster19[0], (size_t)raster19[1], nonce19);
        BOOL presented = sp_region_present(region19, IOSurfaceGetID(testSurface19), nonce19,
            raster19[0], raster19[1], raster19[2], 49, 1, 1);
        check(presented, @"TEST 19: image presented with scale 2");

        NSView *regionView = (NSView *)region19;
        NSView *clipView = regionView.superview;

        // The local unit of SurfaceHost is the AppKit point, and the backing scale is applied only to the layer.
        // A 100x80 point region is 200x160 device pixels in the raster.
        double clipWidth = NSWidth(clipView.bounds);
        double clipHeight = NSHeight(clipView.bounds);
        check(clipWidth == 100 && clipHeight == 80,
            [NSString stringWithFormat:@"TEST 19: clipView bounds are point units (expected 100x80, got %.0f x%.0f)",
                clipWidth, clipHeight]);

        // The same holds for the bounds of imageLayer
        CALayer *imageLayer = [regionView.layer.sublayers firstObject];
        double layerWidth = NSWidth(imageLayer.bounds);
        double layerHeight = NSHeight(imageLayer.bounds);
        check(layerWidth == 100 && layerHeight == 80,
            [NSString stringWithFormat:@"TEST 19: imageLayer bounds are point units (expected 100x80, got %.0f x%.0f)",
                layerWidth, layerHeight]);

        check(fabs(imageLayer.contentsScale - backingScale19) < 0.000001,
            [NSString stringWithFormat:@"TEST 19: contentsScale is the window backing scale %g (got %g)",
                backingScale19, imageLayer.contentsScale]);

        sp_region_close(region19);
        CFRelease(testSurface19);
    }

    // TEST 20: the wanted flag of the region works
    {
        [collectedEvents removeAllObjects];

        void *region20 = sp_region_create(surface, "test20", testEvent, NULL);
        sp_region_place(region20, 10, 10, 10, 10, true);  // visible=true

        NSView *regionView = (NSView *)region20;
        check(!regionView.isHidden, @"TEST 20: region is visible initially");

        // Updates the placement to hide the region (visible=false)
        sp_region_place(region20, 10, 10, 10, 10, false);

        check(regionView.isHidden,
            @"TEST 20: region is hidden when placed with visible=false");

        // Shows it again
        sp_region_place(region20, 10, 10, 10, 10, true);

        check(!regionView.isHidden,
            @"TEST 20: region is visible again when placed with visible=true");

        sp_region_close(region20);
    }

    // TEST 21: In device pixel coordinates of SurfaceHost, one pixel of the image is one device pixel.
    {
        void *region21 = sp_region_create(surface, "test21", testEvent, NULL);
        sp_region_place(region21, 0, 0, 0, 0, true);
        double raster21[3] = {0};
        check(sp_region_raster(region21, raster21), @"TEST 21: full region reports its native raster");
        size_t pixelWidth = (size_t)raster21[0], pixelHeight = (size_t)raster21[1];
        unsigned char nonce21[16];
        IOSurfaceRef testSurface21 = createColoredGlobalSurface(pixelWidth, pixelHeight, nonce21);
        bool presented = sp_region_present(region21, IOSurfaceGetID(testSurface21), nonce21,
            pixelWidth, pixelHeight, raster21[2], 51, 1, 1);
        check(presented, @"TEST 21: image is presented in SurfaceHost coordinates");

        NSView *regionView = (NSView *)region21;
        CALayer *imageLayer = regionView.layer.sublayers.firstObject;
        CGFloat shownPixels = NSWidth([regionView convertRectToBacking:regionView.bounds]);
        CGFloat layerPixels = NSWidth(imageLayer.bounds) * imageLayer.contentsScale;
        check(shownPixels == pixelWidth && layerPixels == pixelWidth,
            [NSString stringWithFormat:@"TEST 21: region covers %zu device pixels and the layer maps them one to one (region %g, layer %g)",
                pixelWidth, shownPixels, layerPixels]);

        sp_region_close(region21);
        CFRelease(testSurface21);
    }

    // TEST 22: A region placed on a hidden surface is shown together when the surface is shown again.
    {
        void *region22 = sp_region_create(surface, "test22", testEvent, NULL);
        [surface setHidden:YES];
        sp_region_place(region22, 10, 10, 10, 10, true);
        NSView *regionView = (NSView *)region22;
        check(!regionView.hidden, @"TEST 22: region keeps its wanted visibility while its surface is hidden");
        [surface setHidden:NO];
        check(!regionView.isHiddenOrHasHiddenAncestor,
            @"TEST 22: region becomes visible when its surface is shown again");
        sp_region_close(region22);
    }

    // TEST 22: An image drawn at a scale different from the window scale is not displayed (the text size would be wrong).
    {
        [collectedEvents removeAllObjects];
        void *region22 = sp_region_create(surface, "test22", testEvent, NULL);
        sp_region_place(region22, 0, 0, 0, 0, true);
        double raster22[3] = {0};
        check(sp_region_raster(region22, raster22), @"TEST 22: full region reports its native raster");
        unsigned char nonce22[16];
        IOSurfaceRef testSurface22 = createColoredGlobalSurface((size_t)raster22[0], (size_t)raster22[1], nonce22);
        bool presented = sp_region_present(region22, IOSurfaceGetID(testSurface22), nonce22,
            raster22[0], raster22[1], raster22[2] + 1, 52, 1, 1);
        BOOL reported = NO;
        for (NSString *event in collectedEvents) if ([event containsString:@"\"reason\":\"scale\""]) reported = YES;
        check(!presented && reported, @"TEST 22: an image drawn at another scale is refused with reason scale");
        const char *failedFacts = sp_region_facts(region22);
        check(failedFacts && strstr(failedFacts, "\"error\":\"scale\""),
            @"TEST 22: host facts retain the actual presentation error");
        free((void *)failedFacts);
        check(sp_region_present(region22, IOSurfaceGetID(testSurface22), nonce22,
            raster22[0], raster22[1], raster22[2], 52, 1, 2), @"TEST 22: a valid frame presents after an error");
        const char *recoveredFacts = sp_region_facts(region22);
        check(recoveredFacts && strstr(recoveredFacts, "\"error\":null"),
            @"TEST 22: only successful presentation clears the error");
        free((void *)recoveredFacts);
        sp_region_close(region22);
        CFRelease(testSurface22);
    }

    // TEST 23: accepted IOSurface snapshots preserve declared color metadata.
    {
        void *region23 = sp_region_create(surface, "test23", testEvent, NULL);
        sp_region_place(region23, 0, 0, 0, 0, true);
        double raster23[3] = {0};
        check(sp_region_raster(region23, raster23), @"TEST 23: region reports its native raster");
        unsigned char nonce23[16];
        IOSurfaceRef testSurface23 = createColoredGlobalSurface((size_t)raster23[0], (size_t)raster23[1], nonce23);
        CGColorSpaceRef srgb23 = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
        CFPropertyListRef srgbProperties23 = srgb23 ? CGColorSpaceCopyPropertyList(srgb23) : NULL;
        BOOL tagged23 = testSurface23 && srgbProperties23;
        if (tagged23) IOSurfaceSetValue(testSurface23, kIOSurfaceColorSpace, srgbProperties23);
        if (srgbProperties23) CFRelease(srgbProperties23);
        if (srgb23) CGColorSpaceRelease(srgb23);
        check(tagged23, @"TEST 23: fixture IOSurface declares its sRGB color space");
        BOOL presented23 = tagged23 && sp_region_present(region23, IOSurfaceGetID(testSurface23), nonce23,
            raster23[0], raster23[1], raster23[2], 53, 1, 1);
        check(presented23, @"TEST 23: sRGB-tagged IOSurface is accepted");
        NSView *regionView23 = (NSView *)region23;
        CALayer *imageLayer23 = regionView23.layer.sublayers.firstObject;
        CGColorSpaceRef snapshotSpace23 = imageLayer23 ? CGImageGetColorSpace((CGImageRef)imageLayer23.contents) : NULL;
        CFStringRef snapshotName23 = snapshotSpace23 ? CGColorSpaceGetName(snapshotSpace23) : NULL;
        char snapshotNameBuffer23[128] = {0};
        BOOL preservesSpace23 = snapshotName23 && CFStringGetCString(snapshotName23, snapshotNameBuffer23,
            sizeof(snapshotNameBuffer23), kCFStringEncodingUTF8)
            && strcmp(snapshotNameBuffer23, "kCGColorSpaceSRGB") == 0;
        check(preservesSpace23, @"TEST 23: accepted snapshot preserves the IOSurface sRGB color-space tag");

        unsigned char invalidNonce23[16];
        IOSurfaceRef invalidSurface23 = createColoredGlobalSurface((size_t)raster23[0], (size_t)raster23[1], invalidNonce23);
        if (invalidSurface23) IOSurfaceSetValue(invalidSurface23, kIOSurfaceColorSpace,
            CFSTR("invalid color-space property list"));
        BOOL invalidRejected23 = invalidSurface23 && !sp_region_present(region23, IOSurfaceGetID(invalidSurface23),
            invalidNonce23, raster23[0], raster23[1], raster23[2], 54, 1, 2);
        const char *facts23 = sp_region_facts(region23);
        check(invalidRejected23 && facts23 && strstr(facts23, "\"error\":\"presentFailed\"")
            && strstr(facts23, "\"generation\":53"),
            @"TEST 23: invalid declared color metadata rejects the frame and preserves the prior snapshot");
        free((void *)facts23);
        sp_region_close(region23);
        if (invalidSurface23) CFRelease(invalidSurface23);
        if (testSurface23) CFRelease(testSurface23);
    }

    // Right after the outer surface changes, the region and the raster must have the same size without a page placement notification.
    {
        void *region = sp_region_create(surface, "fractional-resize", testEvent, NULL);
        sp_region_place(region, 0, 0, 0, 0, true);
        const double widths[] = { 597.5, 96, 751.5, 598, 96.5, 800 };
        for (size_t n = 0; n < sizeof(widths)/sizeof(widths[0]); n++) {
            webviewSetFrame(surface, 7.5, 33, widths[n], 286.5);
            double outer[4] = {0}, inner[6] = {0}, raster[3] = {0};
            webviewGetFrame(surface, outer);
            sp_region_frame(region, inner);
            check(inner[2] == outer[2] && inner[3] == outer[3],
                @"fractional resize: native region follows the prepared outer surface synchronously");
            check(sp_region_raster(region, raster) && raster[0] == round(outer[2]*raster[2])
                && raster[1] == round(outer[3]*raster[2]),
                @"fractional resize: raster dimensions match the actual native frame");
        }
        sp_region_close(region);
    }

    // Paste from the Edit menu goes to the page paste command, not to the input method document (V5-42).
    {
        void *region = sp_region_create(surface, "edit-actions", testEvent, NULL);
        sp_region_place(region, 0, 0, 0, 0, true);
        NSView *regionView = (NSView *)region;
        NSUInteger before = collectedEvents.count;
        [NSApp sendAction:@selector(paste:) to:regionView from:nil];
        [NSApp sendAction:@selector(pasteAsPlainText:) to:regionView from:nil];
        NSArray *reported = [collectedEvents subarrayWithRange:NSMakeRange(before, collectedEvents.count - before)];
        check([reportsWithoutCids(reported) isEqualToArray:@[@{@"type": @"action", @"name": @"paste"}, @{@"type": @"action", @"name": @"paste"}]],
            [NSString stringWithFormat:@"edit actions: paste reports one paste action per command (got %@)", reported]);
        // Copy goes to the page command that copies the selection and does not write the input method document to the pasteboard.
        NSInteger changes = NSPasteboard.generalPasteboard.changeCount;
        NSUInteger beforeCopy = collectedEvents.count;
        [NSApp sendAction:@selector(copy:) to:regionView from:nil];
        NSArray *copied = [collectedEvents subarrayWithRange:NSMakeRange(beforeCopy, collectedEvents.count - beforeCopy)];
        check([reportsWithoutCids(copied) isEqualToArray:@[@{@"type": @"action", @"name": @"copy"}]]
            && NSPasteboard.generalPasteboard.changeCount == changes,
            [NSString stringWithFormat:@"edit actions: copy reports one copy action and leaves the pasteboard unchanged (got %@)", copied]);
        NSMenuItem *item = [[[NSMenuItem alloc] initWithTitle:@"" action:@selector(copy:) keyEquivalent:@""] autorelease];
        id<NSUserInterfaceValidations> validator = (id<NSUserInterfaceValidations>)regionView;
        check([validator validateUserInterfaceItem:item], @"edit actions: Copy is enabled for a terminal region");
        item.action = @selector(paste:);
        check([validator validateUserInterfaceItem:item], @"edit actions: Paste is enabled for a terminal region");
        for (NSString *name in @[@"cut:", @"selectAll:", @"delete:"]) {
            item.action = NSSelectorFromString(name);
            check(![validator validateUserInterfaceItem:item],
                [NSString stringWithFormat:@"edit actions: %@ is disabled for a terminal region", name]);
        }
        sp_region_close(region);
    }

    // The region of a surface that has not received its first placement has no raster size and reports that the surface is not placed.
    // When the surface is placed, both values appear together.
    {
        WKWebView *unplaced = [[[WKWebView alloc] initWithFrame:NSZeroRect] autorelease];
        [window.contentView addSubview:unplaced];
        webviewAttachSurface(unplaced, main);
        void *region = sp_region_create(unplaced, "unplaced", testEvent, NULL);
        sp_region_place(region, 0, 0, 0, 0, true);
        double raster[3] = {0};
        check(!sp_region_raster(region, raster) && !sp_region_surface_placed(region),
            @"unplaced surface: a shown region has no raster geometry and reports its surface as not placed");
        webviewSetFrame(unplaced, 0, 0, 200, 100);
        CGFloat backingScale = window.backingScaleFactor;
        double expectedWidth = 200 * backingScale;
        double expectedHeight = 100 * backingScale;
        check(sp_region_raster(region, raster) && sp_region_surface_placed(region)
            && raster[0] == expectedWidth && raster[1] == expectedHeight,
            [NSString stringWithFormat:@"unplaced surface: placing the surface gives the region a %.0fx%.0f raster (got %.0fx%.0f)",
                expectedWidth, expectedHeight, raster[0], raster[1]]);
        sp_region_close(region);
    }

    // A pointer press inside the region frame is not reported as image region focus loss. The pointer passes through this view
    // to the page (hitTest is nil), so WebKit makes the pressed web view the first responder, and the page focus
    // command returns it to the region. If the resign of that round trip were reported to the ?1004 child, the child would cancel a drag
    // in progress, so a resign while the press point is inside the region is not a focus change.
    if (activation) {
        void *region15 = sp_region_create(surface, "test15", testEvent, NULL);
        sp_region_place(region15, 100, 150, 100, 50, true);
        sp_region_focus(region15);
        check(window.firstResponder == (NSResponder *)region15,
            @"press focus: the focused region starts as the window first responder");
        [collectedEvents removeAllObjects];

        [NSApp activateIgnoringOtherApps:YES];
        [window makeKeyAndOrderFront:nil];
        NSView *regionView15 = (NSView *)region15;
        NSRect frame15 = [regionView15 convertRect:regionView15.bounds toView:nil];
        NSPoint inside15 = NSMakePoint(NSMidX(frame15), NSMidY(frame15));
        NSEvent *down15 = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:inside15
            modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
            context:nil eventNumber:1 clickCount:1 pressure:1];
        NSEvent *up15 = [NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:inside15
            modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
            context:nil eventNumber:1 clickCount:1 pressure:0];
        [NSApp postEvent:down15 atStart:NO];
        [NSApp postEvent:up15 atStart:NO];
        NSDate *drain15 = [NSDate dateWithTimeIntervalSinceNow:2.0];
        while ([drain15 timeIntervalSinceNow] > 0) {
            NSEvent *pending = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]
                inMode:NSDefaultRunLoopMode dequeue:YES];
            if (pending) [NSApp sendEvent:pending];
        }

        BOOL reportedLoss15 = NO;
        for (NSString *eventStr in collectedEvents) {
            if ([eventStr rangeOfString:@"\"type\":\"focus\""].location != NSNotFound &&
                [eventStr rangeOfString:@"\"focused\":false"].location != NSNotFound) reportedLoss15 = YES;
        }
        check(!reportedLoss15,
            [NSString stringWithFormat:@"press focus: a pointer press inside the region frame does not report a focus loss (events %@)",
                collectedEvents]);
        check(window.firstResponder == (NSResponder *)region15,
            @"press focus: the pass-through press does not leave the page webview holding the terminal responder");

        // A press outside the region is a real focus move, so it is reported as is. This is a control against over-suppression.
        [collectedEvents removeAllObjects];
        NSPoint outside15 = NSMinX(frame15) - 40 > 0 ? NSMakePoint(NSMinX(frame15) - 40, NSMidY(frame15))
            : NSMakePoint(NSMaxX(frame15) + 40, NSMidY(frame15));
        NSEvent *downOut15 = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:outside15
            modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
            context:nil eventNumber:2 clickCount:1 pressure:1];
        NSEvent *upOut15 = [NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:outside15
            modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
            context:nil eventNumber:2 clickCount:1 pressure:0];
        [NSApp postEvent:downOut15 atStart:NO];
        [NSApp postEvent:upOut15 atStart:NO];
        NSDate *drainOut15 = [NSDate dateWithTimeIntervalSinceNow:2.0];
        while ([drainOut15 timeIntervalSinceNow] > 0) {
            NSEvent *pending = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]
                inMode:NSDefaultRunLoopMode dequeue:YES];
            if (pending) [NSApp sendEvent:pending];
        }
        BOOL reportedOutsideLoss15 = NO;
        for (NSString *eventStr in collectedEvents) {
            if ([eventStr rangeOfString:@"\"type\":\"focus\""].location != NSNotFound &&
                [eventStr rangeOfString:@"\"focused\":false"].location != NSNotFound) reportedOutsideLoss15 = YES;
        }
        check(reportedOutsideLoss15,
            @"press focus: a pointer press outside the region frame still reports the focus loss");

        sp_region_close(region15);
    }

    // When region A has focus and another region B is pressed inside its frame, the press passes through B to the page
    // web view, and NSWindow makes the web view the first responder. During this interval the page obtains keyboard focus
    // and focus fires again on the browser address bar that is the activeElement (the V5-114 jump). Correct
    // behavior: A reports focus loss (a real transition) and the responder moves to B directly; there must be no interval in which the page
    // web view holds the responder.
    if (activation) {
        // If the last mouse-up of the previous section remains in the queue and is processed in the middle of this section, the responder change happens
        // during a release, not a press. The queue is drained first to measure only changes during a press.
        while (YES) {
            NSEvent *pending = [NSApp nextEventMatchingMask:NSEventMaskAny
                untilDate:[NSDate dateWithTimeIntervalSinceNow:0.1] inMode:NSDefaultRunLoopMode dequeue:YES];
            if (!pending) break;
            [NSApp sendEvent:pending];
        }
        void *regionA16 = sp_region_create(surface, "testA16", testEvent, (void *)1);
        void *regionB16 = sp_region_create(surface, "testB16", testEvent, (void *)2);
        // The placement arguments are insets (left, top, right, bottom). B is at the same position as test15 (coordinates whose press routing was
        // verified), and A is placed in the lower band so that they do not overlap.
        sp_region_place(regionA16, 100, 20, 100, 340, true);
        sp_region_place(regionB16, 100, 150, 100, 50, true);
        // Finish activation and the preceding window first and then focus A; if activation sets the responder again,
        // the resign of A happens at a place other than a press and the reproduction is disturbed.
        [NSApp activateIgnoringOtherApps:YES];
        [window makeKeyAndOrderFront:nil];
        NSDate *settleB16 = [NSDate dateWithTimeIntervalSinceNow:0.3];
        while ([settleB16 timeIntervalSinceNow] > 0) {
            NSEvent *pending = [NSApp nextEventMatchingMask:NSEventMaskAny
                untilDate:[NSDate dateWithTimeIntervalSinceNow:0.05] inMode:NSDefaultRunLoopMode dequeue:YES];
            if (pending) [NSApp sendEvent:pending];
        }
        sp_region_focus(regionA16);
        check(window.firstResponder == (NSResponder *)regionA16,
            @"press focus A->B: region A starts as the window first responder");
        [collectedEvents removeAllObjects];

        NSView *regionViewB16 = (NSView *)regionB16;
        NSRect frameB16 = [regionViewB16 convertRect:regionViewB16.bounds toView:nil];
        NSPoint insideB16 = NSMakePoint(NSMidX(frameB16), NSMidY(frameB16));
        NSEvent *downB16 = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:insideB16
            modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
            context:nil eventNumber:3 clickCount:1 pressure:1];
        NSEvent *upB16 = [NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:insideB16
            modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
            context:nil eventNumber:3 clickCount:1 pressure:0];
        [NSApp postEvent:downB16 atStart:NO];
        [NSApp postEvent:upB16 atStart:NO];
        NSDate *drainB16 = [NSDate dateWithTimeIntervalSinceNow:2.0];
        while ([drainB16 timeIntervalSinceNow] > 0) {
            NSEvent *pending = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]
                inMode:NSDefaultRunLoopMode dequeue:YES];
            if (pending) [NSApp sendEvent:pending];
        }
        // Runs the queue once more so that the asynchronous return (makeFirstResponder) flows.
        NSDate *drainB16b = [NSDate dateWithTimeIntervalSinceNow:0.3];
        while ([drainB16b timeIntervalSinceNow] > 0) {
            NSEvent *pending = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]
                inMode:NSDefaultRunLoopMode dequeue:YES];
            if (pending) [NSApp sendEvent:pending];
        }

        BOOL reportedA16Loss = NO;
        BOOL reportedB16Gain = NO;
        for (NSString *eventStr in eventsA16) {
            if ([eventStr rangeOfString:@"\"focused\":false"].location != NSNotFound) reportedA16Loss = YES;
        }
        for (NSString *eventStr in eventsB16) {
            if ([eventStr rangeOfString:@"\"focused\":true"].location != NSNotFound) reportedB16Gain = YES;
        }
        check(reportedA16Loss,
            [NSString stringWithFormat:@"press focus A->B: region A reports its focus loss (A events %@ B events %@)", eventsA16, eventsB16]);
        NSString *who = window.firstResponder == (NSResponder *)regionA16 ? @"A"
            : (window.firstResponder == (NSResponder *)regionB16 ? @"B" : @"other");
        check(window.firstResponder == (NSResponder *)regionB16,
            [NSString stringWithFormat:@"press focus A->B: the responder moves to the pressed region B, not the page webview (responder %@ at point %@)",
                who, NSStringFromPoint(insideB16)]);
        check(reportedB16Gain,
            [NSString stringWithFormat:@"press focus A->B: region B reports its focus gain (events %@)", collectedEvents]);
        sp_region_close(regionA16);
        sp_region_close(regionB16);
    }

    // Diagnostic pointer dispatch calls the hit view directly, so the pressed view must retain the region's focus
    // context without relying on NSApp.currentEvent.
    {
        void *region17 = sp_region_create(surface, "direct-pointer-focus", testEvent, NULL);
        sp_region_place(region17, 100, 150, 100, 50, true);
        sp_region_focus(region17);
        [collectedEvents removeAllObjects];
        sp_input_press_context outer17 = {0}, inner17 = {0};
        double contextX17 = 0, contextY17 = 0;
        sp_input_press_context_push(&outer17, window, 11, 12);
        BOOL foundOuter17 = sp_input_press_context_point(window, &contextX17, &contextY17)
            && contextX17 == 11 && contextY17 == 12;
        sp_input_press_context_push(&inner17, window, 31, 32);
        BOOL foundInner17 = sp_input_press_context_point(window, &contextX17, &contextY17)
            && contextX17 == 31 && contextY17 == 32;
        sp_input_press_context_pop(&inner17);
        BOOL restoredOuter17 = sp_input_press_context_point(window, &contextX17, &contextY17)
            && contextX17 == 11 && contextY17 == 12;
        sp_input_press_context_pop(&outer17);
        check(foundOuter17 && foundInner17 && restoredOuter17 && !sp_input_press_context_point(window, NULL, NULL),
            @"direct pointer focus: nested synthetic press context restores the previous point");
        NSEvent *currentEvent17 = NSApp.currentEvent;
        double facts17[6] = {0};
        sp_region_frame(region17, facts17);
        double x17 = facts17[0] + facts17[2] / 2;
        double y17 = facts17[1] + facts17[3] / 2;
        __block BOOL nextMainTurn17 = NO;
        NSArray *inputRecords17 = capturedEvents(^{
            check(sp_input_pointer(window, x17, y17, 1, 0, 0, 0) == SP_INPUT_DELIVERED,
                @"direct pointer focus: the press reaches the hit view");
            check(sp_input_pointer(window, x17, y17, 3, 0, 0, 0) == SP_INPUT_DELIVERED,
                @"direct pointer focus: the release reaches the pressed view");
            dispatch_async(dispatch_get_main_queue(), ^{ nextMainTurn17 = YES; });
            NSDate *deadline17 = [NSDate dateWithTimeIntervalSinceNow:1.0];
            while (!nextMainTurn17 && deadline17.timeIntervalSinceNow > 0) {
                [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
            }
        });
        check(nextMainTurn17, @"direct pointer focus: the responder restoration turn completed");
        check(!sp_input_press_context_point(window, NULL, NULL),
            @"direct pointer focus: the press context is removed after view dispatch");
        check(NSApp.currentEvent == currentEvent17,
            @"direct pointer focus: synthetic dispatch leaves the AppKit current event unchanged");
        BOOL reportedLoss17 = NO;
        for (NSString *eventStr in collectedEvents) {
            if ([eventStr rangeOfString:@"\"focused\":false"].location != NSNotFound) reportedLoss17 = YES;
        }
        NSMutableArray *responderCallbacks17 = [NSMutableArray array];
        for (NSDictionary *record in inputRecords17) {
            if (![record[@"name"] isEqual:@"native.input.callback"]) continue;
            NSDictionary *fields = record[@"fields"];
            NSString *call = fields[@"call"];
            if (![call isEqual:@"becomeFirstResponder"] && ![call isEqual:@"resignFirstResponder"]) continue;
            [responderCallbacks17 addObject:@{ @"call": call, @"before": fields[@"before"][@"focus"],
                @"after": fields[@"after"][@"focus"] }];
        }
        check(!reportedLoss17,
            [NSString stringWithFormat:@"direct pointer focus: a press inside the focused region does not report focus loss (events %@, responder callbacks %@)",
                collectedEvents, responderCallbacks17]);
        check(window.firstResponder == (NSResponder *)region17,
            [NSString stringWithFormat:@"direct pointer focus: the region remains first responder after the click (got %@)",
                NSStringFromClass(window.firstResponder.class)]);
        sp_region_close(region17);
    }

    [window close];
    [window release];

    return failures ? 1 : 0;
}}
