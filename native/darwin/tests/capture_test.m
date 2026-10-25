#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <IOSurface/IOSurface.h>
#import <WebKit/WebKit.h>
#import "capture.h"
#import "image_capture_match.h"
#import "image_region.h"
#import "webview_geometry.h"
#import "support/capture_frame.m"

static int failures;
static void discardRegionEvent(void *context, const char *json) { (void)context; (void)json; }
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static IOSurfaceRef identitySurface(size_t width, size_t height, unsigned char nonce[16], NSData **rawBytes) {
    IOSurfaceRef surface = IOSurfaceCreate((CFDictionaryRef)@{
        (id)kIOSurfaceWidth: @(width), (id)kIOSurfaceHeight: @(height),
        (id)kIOSurfaceBytesPerElement: @4, (id)kIOSurfacePixelFormat: @(kCVPixelFormatType_32BGRA),
    });
    if (!surface) return NULL;
    for (NSUInteger index = 0; index < 16; index++) nonce[index] = (unsigned char)(width + height + index + 1);
    IOSurfaceSetValue(surface, CFSTR("soksak.frame"), [NSData dataWithBytes:nonce length:16]);
    IOSurfaceLock(surface, 0, NULL);
    uint8_t *bytes = IOSurfaceGetBaseAddress(surface);
    size_t stride = IOSurfaceGetBytesPerRow(surface);
    for (size_t y = 0; y < height; y++) {
        for (size_t x = 0; x < width; x++) {
            uint8_t *pixel = bytes + y * stride + x * 4;
            pixel[0] = (uint8_t)(x + 17); pixel[1] = (uint8_t)(y + 31);
            pixel[2] = (uint8_t)(x + y + 47); pixel[3] = 255;
        }
    }
    *rawBytes = [NSData dataWithBytes:bytes length:stride * height];
    IOSurfaceUnlock(surface, 0, NULL);
    return surface;
}

static BOOL regionMatchesSurfaceBytes(void *handle, IOSurfaceRef surface, NSData *expected) {
    CALayer *layer = (CALayer *)((NSView *)handle).layer.sublayers.firstObject;
    CGImageRef image = (CGImageRef)layer.contents;
    if (!image || !surface || !expected) return NO;
    CGDataProviderRef provider = CGImageGetDataProvider(image);
    CFDataRef actual = provider ? CGDataProviderCopyData(provider) : NULL;
    BOOL equal = actual && (NSUInteger)CFDataGetLength(actual) == expected.length
        && memcmp(CFDataGetBytePtr(actual), expected.bytes, expected.length) == 0;
    if (actual) CFRelease(actual);
    return equal;
}

static BOOL regionDiffersFromSurfaceBytes(void *handle, IOSurfaceRef surface, NSData *expected) {
    return !regionMatchesSurfaceBytes(handle, surface, expected);
}

static void drainMainQueueThroughSentinel(void) {
    dispatch_async(dispatch_get_main_queue(), ^{ CFRunLoopStop(CFRunLoopGetMain()); });
    CFRunLoopRun();
}

int main(void) { @autoreleasepool {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: native capture acceptance\n");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    char directory[] = "/tmp/soksak-capture-test-XXXXXX";
    check(mkdtemp(directory) != NULL, @"a private capture directory is created");
    char *operationError = NULL;
    check(!sp_capture_open(-1, false, &operationError), @"an invalid window is rejected by the native capture boundary");
    check(operationError != NULL && strlen(operationError) > 0, @"open failure is observable to the caller");
    free(operationError); operationError = NULL;
    check(!sp_capture_start(directory, true, &operationError), @"identity capture without a prepared target is rejected");
    check(operationError != NULL && strstr(operationError, "capture has no prepared window") != NULL,
        @"identity start validates its capture target before creating a session");
    free(operationError); operationError = NULL;
    check(!sp_capture_start(directory, false, &operationError), @"starting without a capture target is rejected");
    check(operationError != NULL && strlen(operationError) > 0, @"start failure is observable to the caller");
    free(operationError); operationError = NULL;
    check(sp_capture_wait() == 0, @"an invalid window cannot produce a capture frame");
    check(sp_capture_stop(0) == 0, @"stopping an invalid capture reports no written frames");
    NSError *listError = nil;
    NSArray *files = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:
        [NSString stringWithUTF8String:directory] error:&listError];
    // A folder whose listing failed is not accepted as an empty folder.
    check(files != nil && files.count == 0,
        [NSString stringWithFormat:@"an invalid capture leaves no frame files (listing error %@)", listError]);
    // Still capture: captures a window that is not activated as PNG. It is observation data; the content is checked by size and color.
    NSString *still = [[NSString stringWithUTF8String:directory] stringByAppendingPathComponent:@"still.png"];
    char *stillError = NULL;
    check(!sp_capture_still(-1, still.UTF8String, &stillError) && stillError != NULL && strlen(stillError) > 0,
        @"a still capture of a missing window reports an error");
    free(stillError); stillError = NULL;
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 120, 200, 100)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    // A window during the appearing animation is composited as a small rectangle.
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    window.backgroundColor = [NSColor colorWithSRGBRed:1 green:0 blue:0 alpha:1];
    // Puts the window in front without activating the application. When the occlusion state becomes visible, the window server has composited the window.
    [window orderFrontRegardless];
    // Captures after the window server has put the window on screen. A window before that has no screen rectangle. Other windows may cover it.
    BOOL (^onScreen)(void) = ^BOOL {
        NSArray *info = [(NSArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow,
            (CGWindowID)window.windowNumber) autorelease];
        return info.count == 1 && [info[0][(id)kCGWindowIsOnscreen] boolValue];
    };
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!onScreen() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    check(onScreen(), @"the window server shows the capture window");
    bool stillWritten = sp_capture_still(window.windowNumber, still.UTF8String, &stillError);
    check(stillWritten, [NSString stringWithFormat:@"a still capture of an inactive window is written (%@)",
        [NSString stringWithUTF8String:stillError == NULL ? "" : stillError]]);
    free(stillError);
    NSBitmapImageRep *image = [NSBitmapImageRep imageRepWithData:[NSData dataWithContentsOfFile:still]];
    CGFloat scale = window.backingScaleFactor;
    check(image != nil && image.pixelsWide == (NSInteger)(200 * scale) && image.pixelsHigh == (NSInteger)(100 * scale),
        [NSString stringWithFormat:@"the still image has the window's device-pixel size (got %ldx%ld)",
            (long)image.pixelsWide, (long)image.pixelsHigh]);
    NSColor *centre = [[image colorAtX:image.pixelsWide / 2 y:image.pixelsHigh / 2] colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
    check(centre.redComponent > 0.9 && centre.greenComponent < 0.3 && centre.blueComponent < 0.1,
        [NSString stringWithFormat:@"the still image shows the window content (centre %@)", centre]);
    check(!NSApp.isActive, @"the still capture does not activate the application");
    // The recording target does not change long enough for the initial compositor frame to become idle.
    NSDate *settled = [NSDate dateWithTimeIntervalSinceNow:3];
    while (settled.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:
            [NSDate dateWithTimeIntervalSinceNow:MIN(0.01, settled.timeIntervalSinceNow)]];
    }
    check(sp_capture_open(window.windowNumber, false, &operationError), @"a visible inactive window opens for recording");
    free(operationError); operationError = NULL;
    bool recordingStarted = sp_capture_start(directory, false, &operationError);
    check(recordingStarted, [NSString stringWithFormat:@"recording starts on an unchanged inactive window (%@)",
        [NSString stringWithUTF8String:operationError == NULL ? "" : operationError]]);
    free(operationError);
    if (recordingStarted) {
        int firstFrame = sp_capture_wait();
        check(firstFrame == 1, [NSString stringWithFormat:@"an unchanged inactive window produces a first frame (%@)",
            [NSString stringWithUTF8String:sp_capture_error()]]);
        int frames = sp_capture_stop(0);
        const char *stopError = sp_capture_error();
        check(stopError != NULL && strlen(stopError) == 0,
            [NSString stringWithFormat:@"recording stops without error (%s)", stopError]);
        check(frames > 0, [NSString stringWithFormat:@"recording writes a complete frame (got %d)", frames]);
        // Both the still image and the recording preserve the device pixel size of the window.
        NSString *first = [[NSString stringWithUTF8String:directory] stringByAppendingPathComponent:@"frame-0001.bgra"];
        NSData *recorded = [NSData dataWithContentsOfFile:first];
        uint32_t dimensions[3] = {0, 0, 0};
        if (recorded.length >= sizeof(dimensions)) [recorded getBytes:dimensions length:sizeof(dimensions)];
        check(recorded.length >= sizeof(dimensions) && dimensions[0] == (uint32_t)(200 * scale)
            && dimensions[1] == (uint32_t)(100 * scale),
            [NSString stringWithFormat:@"the recording has the window's device-pixel size (got %ux%u, expected %.0fx%.0f at scale %.1f)",
                dimensions[0], dimensions[1], 200 * scale, 100 * scale, scale]);
        NSData *decoded = readCaptureFrame(recorded);
        uint64_t header = sizeof(dimensions) + 7 * sizeof(double);
        uint64_t payload = (uint64_t)dimensions[2] * dimensions[1];
        check(dimensions[0] > 0 && dimensions[1] > 0 && dimensions[2] >= (uint64_t)dimensions[0] * 4
            && decoded != nil && decoded.length == header + payload,
            [NSString stringWithFormat:@"the recording contains complete metadata and BGRA bytes (got %lu, expected %llu)",
                (unsigned long)decoded.length, (unsigned long long)(header + payload)]);
    }
    check(!NSApp.isActive, @"recording an unchanged window does not activate the application");
    check(sp_capture_open(window.windowNumber, false, &operationError),
        @"the window reopens for an opt-in identity recording");
    free(operationError); operationError = NULL;
    bool identityRecordingStarted = sp_capture_start(directory, true, &operationError);
    check(identityRecordingStarted, [NSString stringWithFormat:@"opt-in identity recording starts (%s)",
        operationError == NULL ? "" : operationError]);
    free(operationError); operationError = NULL;
    if (identityRecordingStarted) {
        WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
        main.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        [window.contentView addSubview:main positioned:NSWindowBelow relativeTo:nil];
        void *surfaceHost = sp_surface_create(main);
        WKWebView *surface = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
        surface.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        if (surfaceHost) webviewAttachSurface(surface, main);
        webviewSetFrame(surface, 0, 0, 200, 100);
        void *regionA = surfaceHost ? sp_region_create(surface, "capture-identity-a", discardRegionEvent, NULL) : NULL;
        void *regionB = surfaceHost ? sp_region_create(surface, "capture-identity-b", discardRegionEvent, NULL) : NULL;
        sp_region_place(regionA, 0, 0, 100, 0, true);
        sp_region_place(regionB, 100, 0, 0, 0, true);
        double rasterA[3] = {0}, rasterB[3] = {0};
        BOOL regionsReady = surfaceHost && sp_region_raster(regionA, rasterA) && sp_region_raster(regionB, rasterB)
            && rasterA[0] >= 192 && rasterA[1] >= 192 && rasterB[0] >= 192 && rasterB[1] >= 192;
        check(regionsReady, @"opt-in capture stop fixture creates two image regions that fit the identity code");
        unsigned char nonceA[16], nonceB[16];
        NSData *rawA = nil, *rawB = nil;
        IOSurfaceRef imageA = regionsReady ? identitySurface((size_t)rasterA[0], (size_t)rasterA[1], nonceA, &rawA) : NULL;
        IOSurfaceRef imageB = regionsReady ? identitySurface((size_t)rasterB[0], (size_t)rasterB[1], nonceB, &rawB) : NULL;
        int firstIdentityFrame = sp_capture_wait();
        check(firstIdentityFrame == 1, [NSString stringWithFormat:@"opt-in recording produces a first frame (%s)",
            sp_capture_error()]);
        BOOL presentedA = imageA && sp_region_present(regionA, IOSurfaceGetID(imageA), nonceA,
            rasterA[0], rasterA[1], rasterA[2], 71, 10, 1);
        BOOL presentedB = imageB && sp_region_present(regionB, IOSurfaceGetID(imageB), nonceB,
            rasterB[0], rasterB[1], rasterB[2], 72, 10, 1);
        check(presentedA && presentedB, @"opt-in capture presents tagged images in both static regions");
        CALayer *layerA = (CALayer *)((NSView *)regionA).layer.sublayers.firstObject;
        CALayer *layerB = (CALayer *)((NSView *)regionB).layer.sublayers.firstObject;
        check(layerA.contents != NULL && layerB.contents != NULL,
            @"opt-in capture has both tagged layers before stop");
        int identityFrames = sp_capture_stop(0);
        check(identityFrames > 0 && strlen(sp_capture_error()) == 0,
            [NSString stringWithFormat:@"opt-in recording finalizes without error (%d, %s)",
                identityFrames, sp_capture_error()]);
        check(regionMatchesSurfaceBytes(regionA, imageA, rawA) && regionMatchesSurfaceBytes(regionB, imageB, rawB),
            @"identity capture stop restores both raw image provider byte arrays without another producer frame");
        NSString *identityManifest = [[NSString stringWithUTF8String:directory]
            stringByAppendingPathComponent:@"frame-identities/manifest.json"];
        NSDictionary *identityMetadata = [NSJSONSerialization JSONObjectWithData:
            [NSData dataWithContentsOfFile:identityManifest] options:0 error:NULL];
        check(identityMetadata != nil && [identityMetadata[@"artifacts"] isKindOfClass:NSArray.class],
            @"opt-in identity capture writes its separate tagged artifact manifest");

        bool failedCaptureStarted = sp_capture_start(directory, true, &operationError);
        check(failedCaptureStarted, [NSString stringWithFormat:@"a second identity capture starts for delayed-cleanup coverage (%s)",
            operationError == NULL ? "" : operationError]);
        free(operationError); operationError = NULL;
        if (failedCaptureStarted) {
            check(sp_capture_wait() == 1, @"the second identity capture receives its first frame");
            BOOL failedA = sp_region_present(regionA, IOSurfaceGetID(imageA), nonceA,
                rasterA[0], rasterA[1], rasterA[2], 73, 10, 1);
            BOOL failedB = sp_region_present(regionB, IOSurfaceGetID(imageB), nonceB,
                rasterB[0], rasterB[1], rasterB[2], 74, 10, 1);
            check(failedA && failedB, @"capture A tags both static regions before its controlled error");
            dispatch_semaphore_t errorReported = dispatch_semaphore_create(0);
            dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
                sp_capture_test_report_error("controlled identity capture failure");
                dispatch_semaphore_signal(errorReported);
            });
            check(dispatch_semaphore_wait(errorReported, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) == 0,
                @"a background capture failure queues its main-thread cleanup");
            dispatch_release(errorReported);
            check(!sp_image_capture_match_identity_session_active(),
                @"capture A disables identity tagging as soon as its error is recorded");
            BOOL afterErrorA = sp_region_present(regionA, IOSurfaceGetID(imageA), nonceA,
                rasterA[0], rasterA[1], rasterA[2], 73, 10, 2);
            BOOL afterErrorB = sp_region_present(regionB, IOSurfaceGetID(imageB), nonceB,
                rasterB[0], rasterB[1], rasterB[2], 74, 10, 2);
            check(afterErrorA && afterErrorB && regionMatchesSurfaceBytes(regionA, imageA, rawA)
                && regionMatchesSurfaceBytes(regionB, imageB, rawB),
                @"capture A presents raw frames after failure without retagging");
            sp_capture_stop(0);
            check(strstr(sp_capture_error(), "controlled identity capture failure") != NULL,
                @"capture A finalization preserves the injected failure");

            bool captureBStarted = sp_capture_start(directory, true, &operationError);
            check(captureBStarted, [NSString stringWithFormat:@"capture B starts after capture A finalizes (%s)",
                operationError == NULL ? "" : operationError]);
            free(operationError); operationError = NULL;
            if (captureBStarted) {
                check(sp_capture_wait() == 1, @"capture B receives its first frame");
                BOOL taggedB1 = sp_region_present(regionA, IOSurfaceGetID(imageA), nonceA,
                    rasterA[0], rasterA[1], rasterA[2], 75, 10, 1);
                BOOL taggedB2 = sp_region_present(regionB, IOSurfaceGetID(imageB), nonceB,
                    rasterB[0], rasterB[1], rasterB[2], 76, 10, 1);
                check(taggedB1 && taggedB2 && regionDiffersFromSurfaceBytes(regionA, imageA, rawA)
                    && regionDiffersFromSurfaceBytes(regionB, imageB, rawB),
                    @"capture B tags both layers before delayed capture A cleanup runs");
                drainMainQueueThroughSentinel();
                check(regionDiffersFromSurfaceBytes(regionA, imageA, rawA)
                    && regionDiffersFromSurfaceBytes(regionB, imageB, rawB),
                    @"delayed cleanup from capture A preserves both capture B tags");
                sp_capture_stop(0);
                check(regionMatchesSurfaceBytes(regionA, imageA, rawA)
                    && regionMatchesSurfaceBytes(regionB, imageB, rawB),
                    @"capture B stop restores both latest raw provider byte arrays");
            }
        }
        sp_region_close(regionA); sp_region_close(regionB);
        webviewDetachSurface(surface);
        if (surfaceHost) sp_surface_close(surfaceHost);
        if (imageA) CFRelease(imageA);
        if (imageB) CFRelease(imageB);
    }
    [window close];
    [window release];
    NSError *removeError = nil;
    check([[NSFileManager defaultManager] removeItemAtPath:[NSString stringWithUTF8String:directory] error:&removeError],
        [NSString stringWithFormat:@"the capture directory and its recordings are removed (%@)", removeError]);
    fprintf(stderr, "%s: native capture acceptance (%.1fms)\n", failures ? "FAIL" : "PASS",
        (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
