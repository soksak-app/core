#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <IOSurface/IOSurface.h>
#import <WebKit/WebKit.h>
#import "support/layer_contents.h"
#import "support/run_until.h"
#import "capture.h"
#import "image_capture_match.h"
#import "image_region.h"
#import "webview_geometry.h"
#import "window_facts.h"
#import "support/surface_view.h"
#import "support/temporary_folder.h"
#import "support/capture_frame.m"

static int failures;
static void discardRegionEvent(void *context, const char *json) { (void)context; (void)json; }
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

#import "support/capture_boundary.m"

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
    CGImageRef image = layerContentsImage(layer);
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
    const char *directory = temporaryFolder(@"soksak-capture-test-").fileSystemRepresentation;
    checkCaptureBoundary(directory);
    char *operationError = NULL;
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
    sp_run_until("the window is visible", ^BOOL { return (window.occlusionState & NSWindowOcclusionStateVisible) != 0; });
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
    // A recording of five stills, one every 1/60 s. The stop waits for the last planned still.
    NSString *root = [NSString stringWithUTF8String:directory];
    NSString *(^folder)(NSString *) = ^NSString *(NSString *name) {
        NSString *path = [root stringByAppendingPathComponent:name];
        [NSFileManager.defaultManager createDirectoryAtPath:path withIntermediateDirectories:NO attributes:nil error:NULL];
        return path;
    };
    NSString *plain = folder(@"plain");
    check(sp_capture_open(window.windowNumber, false, &operationError), @"a visible inactive window opens for recording");
    free(operationError); operationError = NULL;
    double gap = 1000.0 / 60, beforeStart = sp_capture_clock();
    int planned = 5;
    bool recordingStarted = sp_capture_start(plain.fileSystemRepresentation, gap, 0, planned, false, 1, &operationError);
    check(recordingStarted, [NSString stringWithFormat:@"recording starts on an unchanged inactive window (%@)",
        [NSString stringWithUTF8String:operationError == NULL ? "" : operationError]]);
    free(operationError); operationError = NULL;
    if (recordingStarted) {
        // The start answers once still 0 is written.
        check([NSFileManager.defaultManager fileExistsAtPath:[plain stringByAppendingPathComponent:@"frame-0000.bgra"]],
            @"the start answers after the first still is written");
        double after = beforeStart + (planned - 1) * gap;
        sp_run_until("the plan reaches its last still", ^BOOL { return sp_capture_clock() >= after; });
        int frames = sp_capture_stop(after, 2);
        const char *stopError = sp_capture_error();
        check(stopError != NULL && strlen(stopError) == 0,
            [NSString stringWithFormat:@"recording stops without error (%s)", stopError]);
        check(frames == planned && sp_capture_missed() == 0 && sp_capture_late() == 0,
            [NSString stringWithFormat:@"recording writes every planned still (%d written of %d, %d missed, %d late)", frames,
                planned, sp_capture_missed(), sp_capture_late()]);
        NSString *rowsText = [NSString stringWithContentsOfFile:[plain stringByAppendingPathComponent:@"stills.jsonl"]
            encoding:NSUTF8StringEncoding error:NULL];
        NSArray<NSString *> *lines = [[rowsText ?: @"" stringByTrimmingCharactersInSet:NSCharacterSet.newlineCharacterSet]
            componentsSeparatedByString:@"\n"];
        check(rowsText != nil && lines.count == (NSUInteger)planned,
            [NSString stringWithFormat:@"stills.jsonl holds one row for each planned still (%lu rows)", (unsigned long)lines.count]);
        double firstPlanned = NAN;
        for (NSUInteger index = 0; index < lines.count; index++) {
            NSDictionary *row = [NSJSONSerialization JSONObjectWithData:[lines[index] dataUsingEncoding:NSUTF8StringEncoding]
                options:0 error:NULL];
            double numerator = [row[@"machTimebaseNumerator"] doubleValue], denominator = [row[@"machTimebaseDenominator"] doubleValue];
            double (^ms)(NSString *) = ^double(NSString *key) {
                return [row[key] isKindOfClass:NSString.class]
                    ? strtoull([row[key] UTF8String], NULL, 10) * numerator / denominator / 1e6 : NAN;
            };
            double plannedTime = ms(@"planned"), requested = ms(@"requested"), completed = ms(@"completed");
            if (index == 0) firstPlanned = plannedTime;
            NSString *name = [NSString stringWithFormat:@"frame-%04lu.bgra", (unsigned long)index];
            check([row[@"index"] isEqual:@(index)] && [row[@"outcome"] isEqual:@"written"] && row[@"error"] == NSNull.null
                && [row[@"frame"] isEqual:name] && fabs([row[@"requestedGap"] doubleValue] - gap) < 1e-9
                && [row[@"windows"] isEqual:@[@(window.windowNumber)]],
                [NSString stringWithFormat:@"row %lu names its still, its frame, the requested gap and the window (%@)", (unsigned long)index, row]);
            check(fabs(plannedTime - firstPlanned - index * gap) < 0.001 && requested >= plannedTime - 0.001 && completed >= requested,
                [NSString stringWithFormat:@"still %lu is planned at the start plus %lu gaps, requested at or after that, and completed after "
                    "its request (planned %.3f, requested %.3f, completed %.3f)", (unsigned long)index, (unsigned long)index,
                    plannedTime - firstPlanned, requested - firstPlanned, completed - firstPlanned]);
            NSData *recorded = [NSData dataWithContentsOfFile:[plain stringByAppendingPathComponent:name]];
            uint32_t dimensions[3] = {0, 0, 0};
            if (recorded.length >= sizeof(dimensions)) [recorded getBytes:dimensions length:sizeof(dimensions)];
            check(dimensions[0] == (uint32_t)(200 * scale) && dimensions[1] == (uint32_t)(100 * scale),
                [NSString stringWithFormat:@"frame %lu has the window's device-pixel size (got %ux%u, expected %.0fx%.0f at scale %.1f)",
                    (unsigned long)index, dimensions[0], dimensions[1], 200 * scale, 100 * scale, scale]);
            NSData *decoded = readCaptureFrame(recorded);
            uint64_t payload = (uint64_t)dimensions[2] * dimensions[1];
            check(decoded != nil && decoded.length == kCaptureFrameHeader + payload,
                [NSString stringWithFormat:@"frame %lu holds its header and BGRA bytes (got %lu, expected %llu)", (unsigned long)index,
                    (unsigned long)decoded.length, (unsigned long long)(kCaptureFrameHeader + payload)]);
            // The header before the compressed block holds the times, so they are read from the file as it was written.
            double header[8] = {0};
            if (recorded.length >= kCaptureFrameHeader) [recorded getBytes:header range:NSMakeRange(12, sizeof header)];
            check(fabs(header[6] - requested) < 1e-6 && fabs(header[7] - completed) < 1e-6,
                [NSString stringWithFormat:@"frame %lu holds the request and completion times of its still (%.6f %.6f against %.6f %.6f)",
                    (unsigned long)index, header[6], header[7], requested, completed]);
        }
    }
    // A stop without a time requests no later still: it waits for the stills already requested, and the rest of the plan stays
    // not requested.
    NSString *early = folder(@"early");
    check(sp_capture_open(window.windowNumber, false, &operationError), @"the window opens for a recording that stops early");
    free(operationError); operationError = NULL;
    bool earlyStarted = sp_capture_start(early.fileSystemRepresentation, gap, 0, 4096, false, 3, &operationError);
    check(earlyStarted, [NSString stringWithFormat:@"a recording of 4096 planned stills starts (%s)", operationError ?: ""]);
    free(operationError); operationError = NULL;
    if (earlyStarted) {
        int written = sp_capture_stop(0, 4);
        NSString *rowsText = [NSString stringWithContentsOfFile:[early stringByAppendingPathComponent:@"stills.jsonl"]
            encoding:NSUTF8StringEncoding error:NULL];
        NSArray<NSString *> *lines = [[rowsText ?: @"" stringByTrimmingCharactersInSet:NSCharacterSet.newlineCharacterSet]
            componentsSeparatedByString:@"\n"];
        NSDictionary *last = lines.count ? [NSJSONSerialization JSONObjectWithData:[lines.lastObject dataUsingEncoding:NSUTF8StringEncoding]
            options:0 error:NULL] : nil;
        check(written >= 1 && sp_capture_missed() == 4096 - written && lines.count == 4096
            && [last[@"outcome"] isEqual:@"not-requested"] && last[@"requested"] == NSNull.null && last[@"frame"] == NSNull.null,
            [NSString stringWithFormat:@"an early stop keeps every planned still and counts the not requested ones as missed "
                "(%d written, %d missed, %lu rows, last %@)", written, sp_capture_missed(), (unsigned long)lines.count, last]);
    }
    check(!NSApp.isActive, @"recording an unchanged window does not activate the application");
    // The identity fixture places two side-by-side image regions. Each region needs the full reserved 192-pixel QR ROI.
    [window setContentSize:NSMakeSize(384, 192)];
    check(sp_capture_open(window.windowNumber, false, &operationError),
        @"the window reopens for an opt-in identity recording");
    free(operationError); operationError = NULL;
    // The identity recordings plan more stills than they take, and each stops after the state it judges.
    NSString *identityFolder = folder(@"identity");
    bool identityRecordingStarted = sp_capture_start(identityFolder.fileSystemRepresentation, gap, 0, 4096, true, 5,
        &operationError);
    check(identityRecordingStarted, [NSString stringWithFormat:@"opt-in identity recording starts (%s)",
        operationError == NULL ? "" : operationError]);
    free(operationError); operationError = NULL;
    if (identityRecordingStarted) {
        WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
        main.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        [window.contentView addSubview:main positioned:NSWindowBelow relativeTo:nil];
        void *surfaceHost = sp_surface_create(sp_window_set_main_webview(main.window, main));
        WKWebView *page = [[[WKWebView alloc] initWithFrame:NSZeroRect] autorelease];
        BOOL placed = surfaceHost && SPPlaceSurfaceView(surfaceHost, page);
        webviewSetFrame(surfaceHost, 0, 0, NSWidth(window.contentView.bounds), NSHeight(window.contentView.bounds));
        webviewSetSurfaceHidden(surfaceHost, false);
        void *regionA = placed ? sp_region_create(surfaceHost, "capture-identity-a", discardRegionEvent, NULL) : NULL;
        void *regionB = placed ? sp_region_create(surfaceHost, "capture-identity-b", discardRegionEvent, NULL) : NULL;
        sp_region_place(regionA, 0, 0, 192, 0, true);
        sp_region_place(regionB, 192, 0, 0, 0, true);
        double rasterA[3] = {0}, rasterB[3] = {0};
        BOOL rasterAReady = sp_region_raster(regionA, rasterA);
        BOOL rasterBReady = sp_region_raster(regionB, rasterB);
        check(surfaceHost != NULL, @"opt-in identity fixture creates its surface host");
        check(placed, @"opt-in identity fixture places its view web view in the surface host");
        check(regionA != NULL && regionB != NULL, @"opt-in identity fixture creates both image regions");
        check(rasterAReady && rasterBReady && rasterA[0] >= 192 && rasterA[1] >= 192
            && rasterB[0] >= 192 && rasterB[1] >= 192,
            [NSString stringWithFormat:
                @"opt-in identity regions meet the reserved 192x192 pixel ROI (raster A %.0fx%.0f, B %.0fx%.0f; available %d/%d)",
                rasterA[0], rasterA[1], rasterB[0], rasterB[1], rasterAReady, rasterBReady]);
        BOOL regionsReady = surfaceHost && regionA && regionB && rasterAReady && rasterBReady
            && rasterA[0] >= 192 && rasterA[1] >= 192 && rasterB[0] >= 192 && rasterB[1] >= 192;
        unsigned char nonceA[16], nonceB[16];
        NSData *rawA = nil, *rawB = nil;
        IOSurfaceRef imageA = regionsReady ? identitySurface((size_t)rasterA[0], (size_t)rasterA[1], nonceA, &rawA) : NULL;
        IOSurfaceRef imageB = regionsReady ? identitySurface((size_t)rasterB[0], (size_t)rasterB[1], nonceB, &rawB) : NULL;
        BOOL presentedA = imageA && sp_region_present(regionA, IOSurfaceGetID(imageA), nonceA,
            rasterA[0], rasterA[1], rasterA[2], 71, 10, 1);
        BOOL presentedB = imageB && sp_region_present(regionB, IOSurfaceGetID(imageB), nonceB,
            rasterB[0], rasterB[1], rasterB[2], 72, 10, 1);
        check(presentedA && presentedB, @"opt-in capture presents tagged images in both static regions");
        CALayer *layerA = (CALayer *)((NSView *)regionA).layer.sublayers.firstObject;
        CALayer *layerB = (CALayer *)((NSView *)regionB).layer.sublayers.firstObject;
        check(layerA.contents != NULL && layerB.contents != NULL,
            @"opt-in capture has both tagged layers before stop");
        int identityFrames = sp_capture_stop(sp_capture_clock(), 6);
        check(identityFrames > 0 && strlen(sp_capture_error()) == 0,
            [NSString stringWithFormat:@"opt-in recording finalizes without error (%d, %s)",
                identityFrames, sp_capture_error()]);
        check(regionMatchesSurfaceBytes(regionA, imageA, rawA) && regionMatchesSurfaceBytes(regionB, imageB, rawB),
            @"identity capture stop restores both raw image provider byte arrays without another producer frame");
        NSString *identityManifest = [identityFolder stringByAppendingPathComponent:@"frame-identities/manifest.json"];
        NSDictionary *identityMetadata = [NSJSONSerialization JSONObjectWithData:
            [NSData dataWithContentsOfFile:identityManifest] options:0 error:NULL];
        check(identityMetadata != nil && [identityMetadata[@"artifacts"] isKindOfClass:NSArray.class],
            @"opt-in identity capture writes its separate tagged artifact manifest");

        bool failedCaptureStarted = sp_capture_start(folder(@"identity-a").fileSystemRepresentation, gap, 0, 4096, true, 7,
            &operationError);
        check(failedCaptureStarted, [NSString stringWithFormat:@"a second identity capture starts for delayed-cleanup coverage (%s)",
            operationError == NULL ? "" : operationError]);
        free(operationError); operationError = NULL;
        if (failedCaptureStarted) {
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
            // A background capture failure queues its main-thread cleanup before it returns.
            dispatch_semaphore_wait(errorReported, DISPATCH_TIME_FOREVER);
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
            sp_capture_stop(0, 8);
            check(strstr(sp_capture_error(), "controlled identity capture failure") != NULL,
                @"capture A finalization preserves the injected failure");

            bool captureBStarted = sp_capture_start(folder(@"identity-b").fileSystemRepresentation, gap, 0, 4096, true, 9,
                &operationError);
            check(captureBStarted, [NSString stringWithFormat:@"capture B starts after capture A finalizes (%s)",
                operationError == NULL ? "" : operationError]);
            free(operationError); operationError = NULL;
            if (captureBStarted) {
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
                sp_capture_stop(0, 10);
                check(regionMatchesSurfaceBytes(regionA, imageA, rawA)
                    && regionMatchesSurfaceBytes(regionB, imageB, rawB),
                    @"capture B stop restores both latest raw provider byte arrays");
            }
        }
        sp_image_capture_match_begin(NULL, NULL);
        char *startupIdentityError = NULL;
        BOOL startupIdentity = sp_image_capture_match_identity_session_begin(&startupIdentityError);
        check(startupIdentity && startupIdentityError == NULL,
            @"a startup-failure fixture begins identity tagging without a stream");
        free(startupIdentityError);
        BOOL startupTaggedA = sp_region_present(regionA, IOSurfaceGetID(imageA), nonceA,
            rasterA[0], rasterA[1], rasterA[2], 81, 10, 1);
        BOOL startupTaggedB = sp_region_present(regionB, IOSurfaceGetID(imageB), nonceB,
            rasterB[0], rasterB[1], rasterB[2], 82, 10, 1);
        check(startupTaggedA && startupTaggedB && regionDiffersFromSurfaceBytes(regionA, imageA, rawA)
            && regionDiffersFromSurfaceBytes(regionB, imageB, rawB),
            @"a failed startup leaves both regions tagged before error cleanup");
        dispatch_semaphore_t startupFailureReported = dispatch_semaphore_create(0);
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            sp_capture_test_report_startup_failure("controlled identity startup failure");
            dispatch_semaphore_signal(startupFailureReported);
        });
        // A background startup failure ends the matcher state and queues its cleanup before it returns.
        dispatch_semaphore_wait(startupFailureReported, DISPATCH_TIME_FOREVER);
        dispatch_release(startupFailureReported);
        drainMainQueueThroughSentinel();
        check(regionMatchesSurfaceBytes(regionA, imageA, rawA)
            && regionMatchesSurfaceBytes(regionB, imageB, rawB),
            @"startup failure cleanup restores both raw layers without a current stream");

        sp_image_capture_match_begin(NULL, NULL);
        startupIdentityError = NULL;
        startupIdentity = sp_image_capture_match_identity_session_begin(&startupIdentityError);
        check(startupIdentity && startupIdentityError == NULL,
            @"a newer pre-stream identity session starts while old startup cleanup is queued");
        free(startupIdentityError);
        dispatch_semaphore_t delayedStartupFailure = dispatch_semaphore_create(0);
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            sp_capture_test_report_startup_failure("controlled delayed startup failure");
            dispatch_semaphore_signal(delayedStartupFailure);
        });
        // A second startup failure queues its cleanup before a replacement session starts.
        dispatch_semaphore_wait(delayedStartupFailure, DISPATCH_TIME_FOREVER);
        dispatch_release(delayedStartupFailure);
        sp_image_capture_match_begin(NULL, NULL);
        startupIdentityError = NULL;
        startupIdentity = sp_image_capture_match_identity_session_begin(&startupIdentityError);
        check(startupIdentity && startupIdentityError == NULL,
            @"replacement identity session is active before the old cleanup callback runs");
        free(startupIdentityError);
        BOOL replacementTaggedA = sp_region_present(regionA, IOSurfaceGetID(imageA), nonceA,
            rasterA[0], rasterA[1], rasterA[2], 83, 10, 1);
        BOOL replacementTaggedB = sp_region_present(regionB, IOSurfaceGetID(imageB), nonceB,
            rasterB[0], rasterB[1], rasterB[2], 84, 10, 1);
        check(replacementTaggedA && replacementTaggedB,
            @"the replacement pre-stream identity session tags both regions");
        drainMainQueueThroughSentinel();
        check(regionDiffersFromSurfaceBytes(regionA, imageA, rawA)
            && regionDiffersFromSurfaceBytes(regionB, imageB, rawB),
            @"old no-stream cleanup preserves tags from a newer active identity session");
        sp_image_capture_match_identity_session_end();
        sp_image_capture_match_end();
        sp_region_restore_capture_identity();
        sp_region_close(regionA); sp_region_close(regionB);
        sp_surface_unplace_view(page);
        [page removeFromSuperview];
        if (surfaceHost) sp_surface_close(surfaceHost);
        if (imageA) CFRelease(imageA);
        if (imageB) CFRelease(imageB);
    }
    [window close];
    [window release];
    fprintf(stderr, "%s: native capture acceptance (%.1fms)\n", failures ? "FAIL" : "PASS",
        (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
