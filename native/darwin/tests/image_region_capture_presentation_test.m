// Compares an anonymized P86 BGRA patch with the captured image-region pixels without activating the window.
#import <Cocoa/Cocoa.h>
#import <IOSurface/IOSurface.h>
#import <WebKit/WebKit.h>
#import <CommonCrypto/CommonDigest.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>
#import "capture.h"
#import "image_region.h"
#import "webview_geometry.h"
#import "support/capture_frame.m"

static const size_t sourceWidth = 96;
static const size_t sourceHeight = 32;
static int failures;
typedef struct { size_t x, y; uint8_t expected[4], captured[4]; } SPP86MismatchPixel;
static const SPP86MismatchPixel p86ReferenceDifferences[] = {
    {83,5,{81,72,70,255},{81,72,69,255}}, {50,9,{98,89,87,255},{98,89,86,255}},
    {83,11,{81,72,70,255},{81,72,69,255}}, {83,12,{81,72,70,255},{81,72,69,255}},
    {8,14,{81,72,70,255},{81,72,69,255}}, {76,15,{39,30,28,255},{39,30,29,255}},
    {17,16,{113,104,102,255},{113,104,101,255}}, {81,16,{39,30,28,255},{39,30,29,255}},
    {50,23,{113,104,102,255},{113,104,101,255}},
};

static void check(BOOL ok, NSString *label) {
    fprintf(ok ? stdout : stderr, "%s: %s\n", ok ? "PASS" : "FAIL", label.UTF8String);
    fflush(ok ? stdout : stderr);
    if (!ok) failures++;
}

static void discardRegionEvent(void *context, const char *json) { (void)context; (void)json; }

static void expired(int signalNumber) {
    (void)signalNumber;
    const char message[] = "FAIL: image-region presentation test exceeded 30000ms\n";
    write(STDERR_FILENO, message, sizeof message - 1);
    _exit(1);
}

static void spinUntil(BOOL (^condition)(void), NSTimeInterval timeout) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
    while (!condition() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
            beforeDate:[NSDate dateWithTimeIntervalSinceNow:MIN(0.01, deadline.timeIntervalSinceNow)]];
    }
}

static BOOL onScreen(NSWindow *window) {
    NSArray *info = [(NSArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow,
        (CGWindowID)window.windowNumber) autorelease];
    return info.count == 1 && [info[0][(id)kCGWindowIsOnscreen] boolValue];
}

static IOSurfaceRef fixtureSurface(unsigned char nonce[16], NSData **sourceBytes) {
    IOSurfaceRef surface = IOSurfaceCreate((CFDictionaryRef)@{
        (id)kIOSurfaceWidth: @(sourceWidth), (id)kIOSurfaceHeight: @(sourceHeight),
        (id)kIOSurfaceBytesPerElement: @4, (id)kIOSurfacePixelFormat: @(kCVPixelFormatType_32BGRA),
    });
    if (!surface) return NULL;
    arc4random_buf(nonce, 16);
    IOSurfaceSetValue(surface, CFSTR("soksak.frame"), [NSData dataWithBytes:nonce length:16]);
    CGColorSpaceRef srgb = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CFPropertyListRef colorProperties = srgb ? CGColorSpaceCopyPropertyList(srgb) : NULL;
    BOOL tagged = colorProperties != NULL;
    if (tagged) IOSurfaceSetValue(surface, kIOSurfaceColorSpace, colorProperties);
    if (colorProperties) CFRelease(colorProperties);
    if (srgb) CGColorSpaceRelease(srgb);
    IOSurfaceLock(surface, 0, NULL);
    uint8_t *base = IOSurfaceGetBaseAddress(surface);
    size_t stride = IOSurfaceGetBytesPerRow(surface);
    BOOL valid = base && stride >= sourceWidth * 4;
    if (valid) {
        for (size_t y = 0; y < sourceHeight; y++) {
            uint8_t *row = base + y * stride;
            memset(row, 0, sourceWidth * 4);
            for (size_t x = 0; x < sourceWidth; x++) row[x * 4 + 3] = 255;
        }
        // These opaque colors and coordinates are the only retained pixel facts from the earlier measurement.
        for (size_t i = 0; i < sizeof(p86ReferenceDifferences) / sizeof(p86ReferenceDifferences[0]); i++) {
            const SPP86MismatchPixel *sample = &p86ReferenceDifferences[i];
            uint8_t *pixel = base + sample->y * stride + sample->x * 4;
            memcpy(pixel, sample->expected, sizeof(sample->expected));
        }
        NSMutableData *tight = [NSMutableData dataWithLength:sourceWidth * sourceHeight * 4];
        for (size_t y = 0; y < sourceHeight; y++)
            memcpy((uint8_t *)tight.mutableBytes + y * sourceWidth * 4, base + y * stride, sourceWidth * 4);
        *sourceBytes = [tight copy];
    }
    IOSurfaceUnlock(surface, 0, NULL);
    if (!valid || !tagged) { CFRelease(surface); return NULL; }
    return surface;
}

static NSString *sha256(NSData *data) {
    unsigned char digest[CC_SHA256_DIGEST_LENGTH] = {0};
    CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
    NSMutableString *value = [NSMutableString string];
    for (NSUInteger i = 0; i < sizeof(digest); i++) [value appendFormat:@"%02x", digest[i]];
    return value;
}

static NSString *colorSpaceICC_SHA256(CGColorSpaceRef colorSpace) {
    CFDataRef profile = colorSpace ? CGColorSpaceCopyICCData(colorSpace) : NULL;
    NSString *fingerprint = nil;
    if (profile) fingerprint = sha256((NSData *)profile);
    if (profile) CFRelease(profile);
    return fingerprint ?: @"unavailable";
}

static NSData *tightImageBytes(CGImageRef image) {
    if (!image || CGImageGetBitsPerPixel(image) != 32 || CGImageGetBitsPerComponent(image) != 8) return nil;
    size_t width = CGImageGetWidth(image), height = CGImageGetHeight(image), stride = CGImageGetBytesPerRow(image);
    if (!width || !height || width > SIZE_MAX / 4 || stride < width * 4 || height > SIZE_MAX / stride) return nil;
    CGDataProviderRef provider = CGImageGetDataProvider(image);
    CFDataRef data = provider ? CGDataProviderCopyData(provider) : NULL;
    if (!data || (size_t)CFDataGetLength(data) < stride * height) {
        if (data) CFRelease(data);
        return nil;
    }
    NSMutableData *tight = [NSMutableData dataWithLength:width * height * 4];
    const uint8_t *source = CFDataGetBytePtr(data);
    for (size_t row = 0; row < height; row++)
        memcpy((uint8_t *)tight.mutableBytes + row * width * 4, source + row * stride, width * 4);
    CFRelease(data);
    return tight;
}

static NSDictionary *firstImageMatchRecord(NSString *directory) {
    NSString *path = [directory stringByAppendingPathComponent:@"callback-status.jsonl"];
    NSString *contents = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:NULL];
    for (NSString *line in [contents componentsSeparatedByString:@"\n"]) {
        NSData *data = [line dataUsingEncoding:NSUTF8StringEncoding];
        NSDictionary *row = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
        if ([row[@"status"] integerValue] == 0 && [row[@"imageMatch"] isKindOfClass:NSDictionary.class])
            return row;
    }
    return nil;
}

static NSData *cropFrame(NSData *decoded, uint32_t width, uint32_t height, uint32_t stride,
    size_t x, size_t y, size_t cropWidth, size_t cropHeight) {
    if (!decoded || stride < width * 4 || x > width || y > height || cropWidth > width - x
        || cropHeight > height - y || decoded.length < 68 + (uint64_t)stride * height) return nil;
    NSMutableData *crop = [NSMutableData dataWithLength:cropWidth * cropHeight * 4];
    const uint8_t *pixels = (const uint8_t *)decoded.bytes + 68;
    for (size_t row = 0; row < cropHeight; row++)
        memcpy((uint8_t *)crop.mutableBytes + row * cropWidth * 4,
            pixels + (y + row) * stride + x * 4, cropWidth * 4);
    return crop;
}

int main(int argc, const char **argv) { @autoreleasepool {
    signal(SIGALRM, expired); alarm(30);
    check(argc == 1, @"the test receives no reproduction-mode argument");
    if (argc != 1) return 1;
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    char directory[] = "/tmp/soksak-image-region-pixels-XXXXXX";
    BOOL directoryReady = mkdtemp(directory) != NULL;
    check(directoryReady, @"a private capture-artifact directory is created");

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 120, 240, 160)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO; window.animationBehavior = NSWindowAnimationBehaviorNone;
    NSView *content = [[NSView alloc] initWithFrame:window.contentView.bounds];
    window.contentView = content;
    WKWebView *main = [[WKWebView alloc] initWithFrame:content.bounds];
    [content addSubview:main];
    void *surfaceHost = sp_surface_create(main);
    CGFloat backingScale = window.backingScaleFactor;
    WKWebView *surface = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0,
        sourceWidth / backingScale, sourceHeight / backingScale)];
    [content addSubview:surface];
    if (surfaceHost) webviewAttachSurface(surface, main);
    webviewSetFrame(surface, 0, 0, sourceWidth / backingScale, sourceHeight / backingScale);
    void *region = surfaceHost ? sp_region_create(surface, "pixel-fixture", discardRegionEvent, NULL) : NULL;
    if (region) sp_region_place(region, 0, 0, 0, 0, true);
    check(region != NULL, @"the native image region is created through the normal surface composition");
    [window orderFrontRegardless];
    spinUntil(^BOOL { return onScreen(window); }, 5);
    check(onScreen(window), @"the nonactivating fixture window is on screen");
    double raster[3] = {0};
    BOOL rasterReady = region && sp_region_raster(region, raster)
        && raster[0] == sourceWidth && raster[1] == sourceHeight;
    check(rasterReady, @"the region raster matches the 96x32 pixel fixture");
    unsigned char nonce[16] = {0};
    NSData *sourceBytes = nil;
    IOSurfaceRef source = fixtureSurface(nonce, &sourceBytes);
    check(source && sourceBytes.length == sourceWidth * sourceHeight * 4,
        @"the anonymized opaque BGRA fixture and sRGB IOSurface are complete");
    BOOL presented = source && region && rasterReady && sp_region_present(region, IOSurfaceGetID(source), nonce,
        sourceWidth, sourceHeight, raster[2], 2, 1, 1);
    check(presented, @"sp_region_present accepts the exact opaque fixture");
    check(!NSApp.isActive, @"the fixture remains inactive before recording");
    // Match the capture owner’s settled-window path so the first sample is a complete recorded frame.
    NSDate *settled = [NSDate dateWithTimeIntervalSinceNow:3];
    while (settled.timeIntervalSinceNow > 0)
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
            beforeDate:[NSDate dateWithTimeIntervalSinceNow:MIN(0.01, settled.timeIntervalSinceNow)]];
    char *captureError = NULL;
    BOOL opened = directoryReady && sp_capture_open(window.windowNumber, false, &captureError);
    check(opened, [NSString stringWithFormat:@"the nonactivating window opens for recording (%s)", captureError ?: ""]);
    free(captureError); captureError = NULL;
    BOOL started = opened && sp_capture_start(directory, false, &captureError);
    check(started, [NSString stringWithFormat:@"the ordinary sRGB/BGRA capture starts (%s)", captureError ?: ""]);
    free(captureError); captureError = NULL;
    int firstFrame = started ? sp_capture_wait() : 0;
    check(firstFrame == 1, [NSString stringWithFormat:@"a complete capture frame arrives (%s)", sp_capture_error()]);
    int frameCount = started ? sp_capture_stop(0) : 0;
    check(started && frameCount > 0 && sp_capture_error() && strlen(sp_capture_error()) == 0,
        [NSString stringWithFormat:@"the capture artifact finalizes (%d, %s)", frameCount, sp_capture_error() ?: ""]);
    NSData *encoded = [NSData dataWithContentsOfFile:[NSString stringWithFormat:@"%s/frame-0001.bgra", directory]];
    NSData *decoded = readCaptureFrame(encoded);
    uint32_t dimensions[3] = {0}; double captureInfo[7] = {0};
    if (decoded.length >= 68) { memcpy(dimensions, decoded.bytes, sizeof(dimensions)); memcpy(captureInfo, (const uint8_t *)decoded.bytes + 12, sizeof(captureInfo)); }
    NSDictionary *statusRow = firstImageMatchRecord([NSString stringWithUTF8String:directory]);
    NSDictionary *captureFacts = statusRow[@"imageMatch"][@"captureFrame"];
    id captureColorValue = captureFacts[@"colorSpace"];
    NSString *captureColorName = [captureColorValue isKindOfClass:NSString.class] ? captureColorValue : nil;
    CGColorSpaceRef captureProfile = captureColorName
        ? CGColorSpaceCreateWithName((__bridge CFStringRef)captureColorName) : NULL;
    NSString *captureICCReference = colorSpaceICC_SHA256(captureProfile);
    if (captureProfile) CGColorSpaceRelease(captureProfile);
    CALayer *imageLayer = (CALayer *)((NSView *)region).layer.sublayers.firstObject;
    NSData *layerBytes = tightImageBytes((CGImageRef)imageLayer.contents);
    BOOL sourceLayerExact = sourceBytes && layerBytes && [sourceBytes isEqualToData:layerBytes];
    NSColorSpace *windowColorSpace = window.colorSpace;
    NSString *windowColorName = windowColorSpace.localizedName ?: @"unavailable";
    NSString *windowICC = colorSpaceICC_SHA256(windowColorSpace.CGColorSpace);
    CGColorSpaceRef sourceProfile = imageLayer.contents
        ? CGImageGetColorSpace((CGImageRef)imageLayer.contents) : NULL;
    NSString *sourceICC = colorSpaceICC_SHA256(sourceProfile);
    NSView *regionView = (NSView *)region;
    NSRect localRegion = [regionView convertRect:regionView.bounds toView:nil];
    NSRect screenRegion = [window convertRectToScreen:localRegion];
    NSScreen *primary = NSScreen.screens.firstObject;
    if (primary) screenRegion.origin.y = NSMaxY(primary.frame) - NSMaxY(screenRegion);
    NSDictionary *screenRectValue = captureFacts[@"screenRect"];
    NSDictionary *contentRectValue = captureFacts[@"contentRect"];
    double pixelsPerPoint = [captureFacts[@"scaleFactor"] doubleValue] / [captureFacts[@"contentScale"] doubleValue];
    double cropXValue = [contentRectValue[@"x"] doubleValue]
        + (screenRegion.origin.x - [screenRectValue[@"x"] doubleValue]) * pixelsPerPoint;
    double cropYValue = [contentRectValue[@"y"] doubleValue]
        + (screenRegion.origin.y - [screenRectValue[@"y"] doubleValue]) * pixelsPerPoint;
    size_t cropX = (size_t)llround(cropXValue), cropY = (size_t)llround(cropYValue);
    NSData *capturedCrop = captureFacts && fabs(cropXValue - cropX) < 0.000001
        && fabs(cropYValue - cropY) < 0.000001 && fabs(pixelsPerPoint - raster[2]) < 0.000001
        ? cropFrame(decoded, dimensions[0], dimensions[1], dimensions[2], cropX, cropY, sourceWidth, sourceHeight) : nil;
    BOOL actualGeometry = rasterReady && raster[2] == backingScale
        && [captureFacts[@"scaleFactor"] doubleValue] == backingScale
        && [captureFacts[@"contentScale"] doubleValue] == 1
        && dimensions[0] == (uint32_t)llround(window.contentView.bounds.size.width * backingScale)
        && dimensions[1] == (uint32_t)llround(window.contentView.bounds.size.height * backingScale);
    NSMutableArray *differences = [NSMutableArray array];
    NSMutableArray *historicalDifferences = [NSMutableArray array];
    for (size_t i = 0; i < sizeof(p86ReferenceDifferences) / sizeof(p86ReferenceDifferences[0]); i++) {
        const SPP86MismatchPixel *sample = &p86ReferenceDifferences[i];
        NSMutableArray *expected = [NSMutableArray array], *captured = [NSMutableArray array];
        for (size_t c = 0; c < 4; c++) {
            [expected addObject:@(sample->expected[c])];
            [captured addObject:@(sample->captured[c])];
        }
        [historicalDifferences addObject:@{@"x": @(sample->x), @"y": @(sample->y),
            @"expectedBGRA": expected, @"capturedBGRA": captured}];
    }
    if (sourceBytes && capturedCrop) {
        const uint8_t *expected = sourceBytes.bytes, *actual = capturedCrop.bytes;
        for (size_t y = 0; y < sourceHeight; y++) for (size_t x = 0; x < sourceWidth; x++) {
            size_t offset = (y * sourceWidth + x) * 4;
            if (memcmp(expected + offset, actual + offset, 4) != 0) {
                NSMutableArray *e = [NSMutableArray array], *a = [NSMutableArray array];
                for (size_t c = 0; c < 4; c++) { [e addObject:@(expected[offset + c])]; [a addObject:@(actual[offset + c])]; }
                [differences addObject:@{@"x": @(x), @"y": @(y), @"expectedBGRA": e, @"actualBGRA": a}];
            }
        }
    }
    NSDictionary *evidence = @{
        @"source": @{@"width": @(sourceWidth), @"height": @(sourceHeight), @"stride": @(sourceWidth * 4),
            @"pixelFormat": @"BGRA8", @"colorSpace": @"kCGColorSpaceSRGB", @"iccSHA256": sourceICC,
            @"sha256": sourceBytes ? sha256(sourceBytes) : @"unavailable"},
        @"imageLayer": @{@"pixelFormat": @"BGRA8", @"alpha": @"premultiplied-first",
            @"colorSpaceICC_SHA256": sourceICC, @"tightBytesSHA256": layerBytes ? sha256(layerBytes) : @"unavailable",
            @"matchesSourceBytes": @(sourceLayerExact)},
        @"windowBackingColorSpace": @{@"localizedName": windowColorName, @"iccSHA256": windowICC},
        @"capture": captureFacts ?: @{}, @"crop": @{@"x": @(cropX), @"y": @(cropY), @"width": @(sourceWidth),
            @"height": @(sourceHeight), @"sha256": capturedCrop ? sha256(capturedCrop) : @"unavailable"},
        @"captureICCReferenceSHA256": captureICCReference,
        @"historicalP86Reference": @{@"scaleFactor": @2, @"differenceCount": @(historicalDifferences.count),
            @"differences": historicalDifferences},
        @"displayTimeMach": statusRow[@"displayTime"] ?: NSNull.null,
        @"callbackTimeMach": statusRow[@"callbackTime"] ?: NSNull.null,
        @"captureHeaderContentRect": @{@"x": @(captureInfo[0]), @"y": @(captureInfo[1]),
            @"width": @(captureInfo[2]), @"height": @(captureInfo[3])},
        @"actualGeometry": @(actualGeometry),
        @"exact": @(sourceBytes && capturedCrop && [sourceBytes isEqualToData:capturedCrop]),
        @"differenceCount": @(differences.count), @"differences": differences,
        @"windowActive": @(NSApp.isActive),
    };
    NSData *json = [NSJSONSerialization dataWithJSONObject:evidence options:NSJSONWritingPrettyPrinted error:NULL];
    fprintf(stdout, "IMAGE_REGION_CAPTURE_EVIDENCE %s\n", json ? [[[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] UTF8String] : "{}");
    fflush(stdout);
    BOOL exact = sourceBytes && capturedCrop && [sourceBytes isEqualToData:capturedCrop];
    check(!NSApp.isActive, @"recording and comparison do not activate the application");
    check(sourceLayerExact, @"the image-layer CGImage provider bytes equal the opaque IOSurface source bytes");
    check(actualGeometry,
        [NSString stringWithFormat:@"the source and capture match actual backing geometry (region %.0fx%.0f pixels at scale %.0f; capture %ux%u, factor %.0f)",
            raster[0], raster[1], raster[2], dimensions[0], dimensions[1], [captureFacts[@"scaleFactor"] doubleValue]]);
    check(exact, [NSString stringWithFormat:@"the captured image-region crop equals the source bytes (%lu differences)",
        (unsigned long)differences.count]);

    if (source) CFRelease(source);
    [sourceBytes release];
    sp_region_close(region);
    if (surfaceHost) sp_surface_close(surfaceHost);
    [surface release]; [main release]; [window close]; [content release]; [window release];
    if (exact) [[NSFileManager defaultManager] removeItemAtPath:[NSString stringWithUTF8String:directory] error:NULL];
    return failures ? 1 : 0;
} }
