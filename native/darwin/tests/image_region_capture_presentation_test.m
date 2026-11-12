// Presents an image region through the normal surface composition, with and without identity tagging and in the copy and the
// lease mode, and records the window without activating it. The tagged presentation keeps the production IOSurface layer type,
// the sRGB profile and the supplier bytes, changes only the declared QR area, and the stop of the recording restores the
// untagged presentation. The recording writes its still with the declared frame file at the backing geometry of the window; the
// still is evidence of the presentation and its pixels are not judged.
#import <Cocoa/Cocoa.h>
#import <IOSurface/IOSurface.h>
#import <WebKit/WebKit.h>
#import <CommonCrypto/CommonDigest.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#import "support/event_wait.h"
#import "support/layer_contents.h"
#import "capture.h"
#import "image_region.h"
#import "image_capture_match.h"
#import "capture_frame_identity.h"
#import "webview_geometry.h"
#import "window_facts.h"
#import "support/surface_view.h"
#import "support/temporary_folder.h"
#import "support/capture_frame.m"

static size_t sourceWidth = 96;
static size_t sourceHeight = 32;
static int failures;
static void check(BOOL ok, NSString *label) {
    fprintf(ok ? stdout : stderr, "%s: %s\n", ok ? "PASS" : "FAIL", label.UTF8String);
    fflush(ok ? stdout : stderr);
    if (!ok) failures++;
}

static void discardRegionEvent(void *context, const char *json) { (void)context; (void)json; }
static void discardedLease(void *context, uint64_t generation, uint64_t raster, int sequence) {
    (void)context; (void)generation; (void)raster; (void)sequence;
}

static BOOL outsideQRExact(NSData *expected, NSData *actual, BOOL tagged) {
    if (!expected || !actual || expected.length != actual.length) return NO;
    const uint8_t *a = expected.bytes, *b = actual.bytes;
    for (size_t y = 0; y < sourceHeight; y++) for (size_t x = 0; x < sourceWidth; x++) {
        if (tagged && x >= sourceWidth - 192 && y < 192) continue;
        if (memcmp(a + (y * sourceWidth + x) * 4, b + (y * sourceWidth + x) * 4, 4)) return NO;
    }
    return YES;
}

static NSData *tightSurfaceBytes(IOSurfaceRef surface) {
    if (!surface || IOSurfaceLock(surface, kIOSurfaceLockReadOnly, NULL) != kIOReturnSuccess) return nil;
    NSMutableData *data = [NSMutableData dataWithLength:sourceWidth * sourceHeight * 4];
    for (size_t y = 0; y < sourceHeight; y++) memcpy((uint8_t *)data.mutableBytes + y * sourceWidth * 4,
        (uint8_t *)IOSurfaceGetBaseAddress(surface) + y * IOSurfaceGetBytesPerRow(surface), sourceWidth * 4);
    IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, NULL);
    return data;
}

// Counts the refreshes of the display. Each refresh is a source of the run loop, so a wait for a state of the window server
// judges it again at every refresh.
@interface SPRefreshes : NSObject
@property long count;
@end

@implementation SPRefreshes
- (void)refresh:(CADisplayLink *)link {
    (void)link;
    self.count++;
}
@end

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
            for (size_t x = 0; x < sourceWidth; x++) {
                row[x * 4] = (uint8_t)(x * 3); row[x * 4 + 1] = (uint8_t)(y * 5); row[x * 4 + 2] = (uint8_t)(x + y);
                row[x * 4 + 3] = 255;
            }
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
    NSString *path = [directory stringByAppendingPathComponent:@"stills.jsonl"];
    NSString *contents = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:NULL];
    for (NSString *line in [contents componentsSeparatedByString:@"\n"]) {
        NSData *data = [line dataUsingEncoding:NSUTF8StringEncoding];
        NSDictionary *row = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
        if ([row[@"outcome"] isEqual:@"written"] && [row[@"imageMatch"] isKindOfClass:NSDictionary.class])
            return row;
    }
    return nil;
}

static void runPresentationCase(BOOL tagged, BOOL lease) { @autoreleasepool {
    sourceWidth = tagged ? 320 : 96;
    sourceHeight = tagged ? 256 : 32;
    fprintf(stdout, "PRESENTATION_CASE tagged=%d lease=%d\n", tagged, lease);
    int failuresBefore = failures;
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    const char *directory = temporaryFolder(@"soksak-image-region-pixels-").fileSystemRepresentation;

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 120, 240, 160)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO; window.animationBehavior = NSWindowAnimationBehaviorNone;
    NSView *content = [[NSView alloc] initWithFrame:window.contentView.bounds];
    window.contentView = content;
    WKWebView *main = [[WKWebView alloc] initWithFrame:content.bounds];
    [content addSubview:main];
    void *surfaceHost = sp_surface_create(sp_window_set_main_webview(main.window, main));
    CGFloat backingScale = window.backingScaleFactor;
    WKWebView *page = [[WKWebView alloc] initWithFrame:NSZeroRect];
    BOOL placed = surfaceHost && SPPlaceSurfaceView(surfaceHost, page);
    check(placed, @"the view web view is placed in the surface host");
    webviewSetFrame(surfaceHost, 0, 0, sourceWidth / backingScale, sourceHeight / backingScale);
    webviewSetSurfaceHidden(surfaceHost, false);
    void *region = placed ? sp_region_create(surfaceHost, "pixel-fixture", discardRegionEvent, NULL) : NULL;
    if (region) sp_region_place(region, 0, 0, 0, 0, true);
    if (region && lease) sp_region_lease(region, discardedLease, NULL);
    check(region != NULL, @"the native image region is created through the normal surface composition");
    SPRefreshes *refreshes = [[SPRefreshes new] autorelease];
    CADisplayLink *link = [(window.screen ?: NSScreen.mainScreen) displayLinkWithTarget:refreshes selector:@selector(refresh:)];
    [link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
    [window orderFrontRegardless];
    eventWait(@"the window server puts the fixture window on screen", ^BOOL { return onScreen(window); });
    check(onScreen(window), @"the nonactivating fixture window is on screen");
    double raster[3] = {0};
    BOOL rasterReady = region && sp_region_raster(region, raster)
        && raster[0] == sourceWidth && raster[1] == sourceHeight;
    check(rasterReady, @"the region raster matches the declared pixel fixture");
    unsigned char nonce[16] = {0};
    NSData *sourceBytes = nil;
    IOSurfaceRef source = fixtureSurface(nonce, &sourceBytes);
    check(source && sourceBytes.length == sourceWidth * sourceHeight * 4,
        @"the anonymized opaque BGRA fixture and sRGB IOSurface are complete");
    dispatch_queue_t identityWriter = NULL;
    if (tagged) {
        NSString *issuedDirectory = [[NSString stringWithUTF8String:directory] stringByAppendingPathComponent:@"tagged-issued"];
        [[NSFileManager defaultManager] createDirectoryAtPath:issuedDirectory withIntermediateDirectories:YES attributes:nil error:NULL];
        identityWriter = dispatch_queue_create("soksak.presentation-test.identity-writer", DISPATCH_QUEUE_SERIAL);
        sp_image_capture_match_begin(issuedDirectory.fileSystemRepresentation, identityWriter);
    }
    char *identityError = NULL;
    BOOL identityReady = !tagged || sp_image_capture_match_identity_session_begin(&identityError);
    check(identityReady, [NSString stringWithFormat:@"the requested identity session starts (%s)", identityError ?: ""]);
    free(identityError);
    BOOL presented = identityReady && source && region && rasterReady && sp_region_present(region, IOSurfaceGetID(source), nonce,
        sourceWidth, sourceHeight, raster[2], 2, 1, 1);
    check(presented, @"sp_region_present accepts the exact opaque fixture");
    CALayer *presentedLayer = (CALayer *)((NSView *)region).layer.sublayers.firstObject;
    check(presentedLayer.contents && CFGetTypeID((__bridge CFTypeRef)presentedLayer.contents) == IOSurfaceGetTypeID(),
        @"identity diagnostics preserve the production IOSurface layer presentation type");
    check([sourceBytes isEqualToData:tightSurfaceBytes(source)], @"presentation never mutates supplier pixels in copy or lease mode");
    NSSet<NSString *> *issuedPayloads = nil;
    if (tagged) {
        char *payloadError = NULL;
        unsigned char regionToken[16] = {0};
        if (region) sp_region_identity_token(region, regionToken);
        BOOL copiedPayloads = sp_image_capture_match_identity_copy_payloads(regionToken, &issuedPayloads, &payloadError);
        check(copiedPayloads && issuedPayloads.count == 1,
            [NSString stringWithFormat:@"the active region exposes exactly its actual issued payload (%s)", payloadError ?: ""]);
        free(payloadError);
        // End acquisition without replacing the presented tagged contents. The
        // following ordinary still recording captures that presentation.
        sp_image_capture_match_identity_session_end();
        sp_image_capture_match_end();
        dispatch_release(identityWriter);
    }
    check(!NSApp.isActive, @"the fixture remains inactive before recording");
    // Still 0 is requested when the screen already shows the presentation: the refresh after the presentation composites its
    // committed transaction and the refresh after that shows the composited window.
    long presentedAt = refreshes.count;
    eventWait(@"the display refreshes twice after the presentation", ^BOOL { return refreshes.count >= presentedAt + 2; });
    [link invalidate];
    char *captureError = NULL;
    BOOL opened = sp_capture_open(window.windowNumber, false, &captureError);
    check(opened, [NSString stringWithFormat:@"the nonactivating window opens for recording (%s)", captureError ?: ""]);
    free(captureError); captureError = NULL;
    // One still: the start answers once it is written.
    BOOL started = opened && sp_capture_start(directory, 1000.0 / 60, 0, 1, false, 1, &captureError);
    check(started, [NSString stringWithFormat:@"the ordinary sRGB/BGRA recording writes its first still (%s)", captureError ?: ""]);
    free(captureError); captureError = NULL;
    // Stop restores the supplier presentation. Retain the actually recorded
    // tagged layer bytes/profile before that lifecycle transition occurs.
    CALayer *imageLayer = (CALayer *)((NSView *)region).layer.sublayers.firstObject;
    CGImageRef activeLayerImage = layerContentsImage(imageLayer);
    NSData *layerBytes = [tightImageBytes(activeLayerImage) copy];
    NSString *sourceICC = [colorSpaceICC_SHA256(activeLayerImage ? CGImageGetColorSpace(activeLayerImage) : NULL) copy];
    int frameCount = started ? sp_capture_stop(0, 2) : 0;
    check(started && frameCount > 0 && sp_capture_error() && strlen(sp_capture_error()) == 0,
        [NSString stringWithFormat:@"the capture artifact finalizes (%d, %s)", frameCount, sp_capture_error() ?: ""]);
    // Join the frame filename that the written still declares.
    NSDictionary *statusRow = firstImageMatchRecord([NSString stringWithUTF8String:directory]);
    NSString *frameName = statusRow[@"frame"];
    BOOL validFrameName = [frameName isKindOfClass:NSString.class]
        && [frameName.lastPathComponent isEqualToString:frameName];
    check(validFrameName, @"the written still declares its exact recorded frame filename");
    NSData *encoded = validFrameName ? [NSData dataWithContentsOfFile:
        [[NSString stringWithUTF8String:directory] stringByAppendingPathComponent:frameName]] : nil;
    NSData *decoded = readCaptureFrame(encoded);
    uint32_t dimensions[3] = {0}; double captureInfo[8] = {0};
    if (decoded.length >= kCaptureFrameHeader) { memcpy(dimensions, decoded.bytes, sizeof(dimensions)); memcpy(captureInfo, (const uint8_t *)decoded.bytes + 12, sizeof(captureInfo)); }
    NSDictionary *captureFacts = statusRow[@"imageMatch"][@"captureFrame"];
    check(decoded && dimensions[0] == [captureFacts[@"width"] unsignedIntValue]
        && dimensions[1] == [captureFacts[@"height"] unsignedIntValue]
        && dimensions[2] == [captureFacts[@"stride"] unsignedIntValue],
        @"the recorded still dimensions and stride agree with the decoded capture file");
    BOOL sourceLayerExact = outsideQRExact(sourceBytes, layerBytes, tagged);
    if (tagged) check(layerBytes && ![sourceBytes isEqualToData:layerBytes] && sourceLayerExact,
        @"identity tagging changes actual QR pixels and preserves every source pixel outside the declared ROI");
    NSColorSpace *windowColorSpace = window.colorSpace;
    NSString *windowColorName = windowColorSpace.localizedName ?: @"unavailable";
    NSString *windowICC = colorSpaceICC_SHA256(windowColorSpace.CGColorSpace);
    check(imageLayer.contents && CFGetTypeID((__bridge CFTypeRef)imageLayer.contents) == IOSurfaceGetTypeID()
        && [sourceBytes isEqualToData:tightImageBytes(layerContentsImage(imageLayer))],
        @"capture stop restores the complete untagged supplier presentation");
    BOOL actualGeometry = rasterReady && raster[2] == backingScale
        && [captureFacts[@"scaleFactor"] doubleValue] == backingScale
        && [captureFacts[@"contentScale"] doubleValue] == 1
        && dimensions[0] == (uint32_t)llround(window.contentView.bounds.size.width * backingScale)
        && dimensions[1] == (uint32_t)llround(window.contentView.bounds.size.height * backingScale);
    NSDictionary *evidence = @{
        @"source": @{@"width": @(sourceWidth), @"height": @(sourceHeight), @"stride": @(sourceWidth * 4),
            @"pixelFormat": @"BGRA8", @"colorSpace": @"kCGColorSpaceSRGB", @"iccSHA256": sourceICC,
            @"sha256": sourceBytes ? sha256(sourceBytes) : @"unavailable"},
        @"imageLayer": @{@"pixelFormat": @"BGRA8", @"alpha": @"premultiplied-first",
            @"colorSpaceICC_SHA256": sourceICC, @"tightBytesSHA256": layerBytes ? sha256(layerBytes) : @"unavailable",
            @"matchesSourcePixelsOutsideQR": @(sourceLayerExact)},
        @"windowBackingColorSpace": @{@"localizedName": windowColorName, @"iccSHA256": windowICC},
        @"capture": captureFacts ?: @{},
        @"requestedMach": statusRow[@"requested"] ?: NSNull.null,
        @"completedMach": statusRow[@"completed"] ?: NSNull.null,
        @"captureHeaderContentRect": @{@"x": @(captureInfo[0]), @"y": @(captureInfo[1]),
            @"width": @(captureInfo[2]), @"height": @(captureInfo[3])},
        @"actualGeometry": @(actualGeometry),
        @"identityTagged": @(tagged), @"lease": @(lease),
        @"windowActive": @(NSApp.isActive),
    };
    NSData *json = [NSJSONSerialization dataWithJSONObject:evidence options:NSJSONWritingPrettyPrinted error:NULL];
    fprintf(stdout, "IMAGE_REGION_CAPTURE_EVIDENCE %s\n", json ? [[[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] UTF8String] : "{}");
    fflush(stdout);
    check(!NSApp.isActive, @"recording does not activate the application");
    check(sourceLayerExact, @"the presented IOSurface snapshot preserves source pixels outside the QR");
    CGColorSpaceRef declaredSRGB = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    check([sourceICC isEqualToString:colorSpaceICC_SHA256(declaredSRGB)], @"identity presentation preserves the source sRGB profile");
    if (declaredSRGB) CGColorSpaceRelease(declaredSRGB);
    check([sourceBytes isEqualToData:tightSurfaceBytes(source)], @"recording leaves supplier bytes immutable in copy or lease mode");
    check(actualGeometry,
        [NSString stringWithFormat:@"the source and capture match actual backing geometry (region %.0fx%.0f pixels at scale %.0f; capture %ux%u, factor %.0f)",
            raster[0], raster[1], raster[2], dimensions[0], dimensions[1], [captureFacts[@"scaleFactor"] doubleValue]]);
    if (source) CFRelease(source);
    [sourceBytes release];
    [layerBytes release]; [sourceICC release];
    [issuedPayloads release];
    sp_region_close(region);
    sp_surface_unplace_view(page);
    [page removeFromSuperview];
    if (surfaceHost) sp_surface_close(surfaceHost);
    [page release]; [main release]; [window close]; [content release]; [window release];
    // The recorded frames and stills.jsonl of a failing case are its evidence.
    if (failures > failuresBefore) keepTemporaryFolder([NSString stringWithUTF8String:directory]);
} }

int main(int argc, const char **argv) {
    (void)argv;
    if (argc != 1) return 1;
    runPresentationCase(NO, NO);
    runPresentationCase(YES, NO);
    runPresentationCase(YES, YES);
    return failures ? 1 : 0;
}
