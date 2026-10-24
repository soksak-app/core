#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <IOSurface/IOSurface.h>
#import <CoreVideo/CoreVideo.h>
#import "event_ring.h"
#import "image_region.h"
#import "webview_geometry.h"

static int failures = 0;
static NSMutableArray<NSDictionary *> *events = nil;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void regionEvent(void *context, const char *json) {
    NSDictionary *event = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json length:strlen(json)]
        options:0 error:NULL];
    if (event) [events addObject:event];
}

static IOSurfaceRef createColoredSurface(size_t width, size_t height, unsigned char nonce[16]) {
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
    IOSurfaceLock(surface, 0, NULL);
    void *base = IOSurfaceGetBaseAddress(surface);
    size_t stride = IOSurfaceGetBytesPerRow(surface);
    if (base) {
        for (size_t y = 0; y < height; y++) {
            uint32_t *row = (uint32_t *)((uint8_t *)base + y * stride);
            for (size_t x = 0; x < width; x++) row[x] = 0xFF20C020;
        }
    }
    IOSurfaceUnlock(surface, 0, NULL);
    return surface;
}

static NSBitmapImageRep *render(NSView *view) {
    NSBitmapImageRep *image = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
    if (!image) return nil;
    [view cacheDisplayInRect:view.bounds toBitmapImageRep:image];
    return image;
}

static BOOL hasSentinelAtLayerCenter(NSBitmapImageRep *image, NSView *view, CALayer *layer, NSString **measurement) {
    CGFloat scaleX = image.pixelsWide / NSWidth(view.bounds);
    CGFloat scaleY = image.pixelsHigh / NSHeight(view.bounds);
    NSInteger x = (NSInteger)floor((NSMidX(layer.frame) - NSMinX(view.bounds)) * scaleX);
    NSInteger y = (NSInteger)floor((NSMidY(layer.frame) - NSMinY(view.bounds)) * scaleY);
    if (x < 0 || y < 0 || x >= image.pixelsWide || y >= image.pixelsHigh) {
        if (measurement) *measurement = [NSString stringWithFormat:@"sample (%ld,%ld) outside %ldx%ld cache",
            (long)x, (long)y, (long)image.pixelsWide, (long)image.pixelsHigh];
        return NO;
    }
    NSColor *color = [[image colorAtX:x y:y] colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
    if (measurement) *measurement = [NSString stringWithFormat:@"sample (%ld,%ld)=%@ targetColorSpace=%@",
        (long)x, (long)y, color, image.colorSpaceName];
    if (!color) return NO;
    // AppKit color-manages the DeviceRGB source into the NSCalibratedRGB cache; the known green sentinel is
    // checked after that conversion by its measured green-channel separation, not by source-channel equality.
    return color.greenComponent >= 0.6 && color.greenComponent - color.redComponent >= 0.30
        && color.greenComponent - color.blueComponent >= 0.30;
}

static NSUInteger bluePixelCount(NSBitmapImageRep *image) {
    NSUInteger count = 0;
    for (NSInteger y = 0; y < image.pixelsHigh; y++) {
        for (NSInteger x = 0; x < image.pixelsWide; x++) {
            NSColor *color = [[image colorAtX:x y:y] colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
            if (color && color.blueComponent > 0.45 && color.blueComponent > color.redComponent * 1.35
                && color.blueComponent > color.greenComponent * 1.15) count++;
        }
    }
    return count;
}

static NSDictionary *lastInputTransaction(void) {
    for (NSDictionary *event in events.reverseObjectEnumerator) if ([event[@"type"] isEqual:@"input"]) return event;
    return nil;
}

static NSDictionary *lastInsertAction(NSDictionary *transaction) {
    for (NSDictionary *action in [transaction[@"actions"] reverseObjectEnumerator]) {
        if ([action[@"type"] isEqual:@"insert"]) return action;
    }
    return nil;
}

int main(void) { @autoreleasepool {
    check(sp_event_set_boot("native-decoration-test"), @"the diagnostic event run has a boot identifier");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    WKWebView *surface = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    [window.contentView addSubview:surface];
    [window orderBack:nil];
    void *mainSurface = sp_surface_create(main);
    check(mainSurface != NULL, @"the main webview creates the native surface composition");
    if (!mainSurface) return 1;
    webviewAttachSurface(surface, main);
    webviewSetFrame(surface, 0, 0, 500, 400);
    events = [NSMutableArray array];
    void *region = sp_region_create(surface, "decoration", regionEvent, NULL);
    check(region != NULL, @"the declared region interface creates the native image region");
    if (!region) return 1;
    sp_region_place(region, 0, 0, 180, 40, true);
    NSTextView *view = (NSTextView *)region;
    check(!view.hidden, @"the placed image region stays visible");

    double raster[3] = {0};
    BOOL hasRaster = sp_region_raster(region, raster);
    check(hasRaster, @"the placed image region reports its native raster dimensions");
    unsigned char nonce[16];
    IOSurfaceRef source = hasRaster ? createColoredSurface((size_t)raster[0], (size_t)raster[1], nonce) : NULL;
    check(source != NULL, @"the test creates a known-color sidecar raster");
    BOOL imagePresented = source && sp_region_present(region, IOSurfaceGetID(source), nonce,
        raster[0], raster[1], raster[2], 1, 1, 1);
    check(imagePresented, @"the image region accepts the known-color sidecar raster");
    CALayer *imageLayer = [view.layer.sublayers firstObject];
    CGImageRef imageSnapshot = (CGImageRef)imageLayer.contents;
    CFDataRef imageBytes = imageSnapshot ? CGDataProviderCopyData(CGImageGetDataProvider(imageSnapshot)) : NULL;
    check(imageSnapshot && CGImageGetWidth(imageSnapshot) == (size_t)raster[0]
        && CGImageGetHeight(imageSnapshot) == (size_t)raster[1]
        && imageBytes && *(const uint32_t *)CFDataGetBytePtr(imageBytes) == 0xFF20C020,
        @"the child image layer retains the exact known-color sidecar raster");
    if (imageBytes) CFRelease(imageBytes);

    NSAttributedString *first = [[[NSAttributedString alloc] initWithString:@"ㅏ"
        attributes:@{NSForegroundColorAttributeName: NSColor.clearColor,
            NSUnderlineStyleAttributeName: @(NSUnderlineStyleSingle),
            NSUnderlineColorAttributeName: NSColor.systemBlueColor}] autorelease];
    [view setMarkedText:first selectedRange:NSMakeRange(1, 0) replacementRange:NSMakeRange(NSNotFound, 0)];
    NSBitmapImageRep *firstFrame = render(view);
    check(firstFrame != nil, @"the offscreen image region renders the first controlled marked-text frame");
    NSDictionary *firstInput = lastInputTransaction();
    check([firstInput[@"preedit"][@"text"] isEqual:@"ㅏ"]
        && [firstInput[@"preedit"][@"markedRange"][@"length"] unsignedIntegerValue] == 1,
        @"the first marked-text callback still reports its composition and marked range");
    NSString *compositeMeasurement = @"no rendered bitmap";
    BOOL sentinelVisible = firstFrame && hasSentinelAtLayerCenter(firstFrame, view, imageLayer, &compositeMeasurement);
    check(sentinelVisible, [NSString stringWithFormat:
        @"the offscreen image-region composite shows the sidecar sentinel at the image-layer center (%@)",
        compositeMeasurement]);
    NSUInteger firstBlue = firstFrame ? bluePixelCount(firstFrame) : 0;
    check(firstBlue == 0, [NSString stringWithFormat:
        @"the native input view paints no blue marked-text underline (measured %lu pixels)", (unsigned long)firstBlue]);

    NSAttributedString *second = [[[NSAttributedString alloc] initWithString:@"ㅏㅏ"
        attributes:@{NSForegroundColorAttributeName: NSColor.clearColor,
            NSUnderlineStyleAttributeName: @(NSUnderlineStyleSingle),
            NSUnderlineColorAttributeName: NSColor.systemBlueColor}] autorelease];
    [view setMarkedText:second selectedRange:NSMakeRange(2, 0) replacementRange:NSMakeRange(NSNotFound, 0)];
    NSBitmapImageRep *secondFrame = render(view);
    check(secondFrame != nil, @"the offscreen image region renders the repeated marked-text frame");
    NSDictionary *secondInput = lastInputTransaction();
    check([secondInput[@"preedit"][@"text"] isEqual:@"ㅏㅏ"]
        && [secondInput[@"preedit"][@"markedRange"][@"length"] unsignedIntegerValue] == 2,
        @"the repeated marked-text callback still reports its composition and marked range");
    NSUInteger secondBlue = secondFrame ? bluePixelCount(secondFrame) : 0;
    check(secondBlue == 0, [NSString stringWithFormat:
        @"repeated input paints no blue native underline pixels (measured %lu)", (unsigned long)secondBlue]);

    [view unmarkText];
    [view doCommandBySelector:@selector(insertNewline:)];
    NSBitmapImageRep *clearedFrame = render(view);
    check(clearedFrame != nil, @"the offscreen image region renders after Enter-equivalent input");
    NSUInteger clearedBlue = clearedFrame ? bluePixelCount(clearedFrame) : 0;
    check(clearedBlue == 0, [NSString stringWithFormat:
        @"Enter-equivalent input leaves no native underline pixels (measured %lu)", (unsigned long)clearedBlue]);
    check([[lastInsertAction(lastInputTransaction()) objectForKey:@"text"] isEqual:@"ㅏㅏ"],
        @"Enter-equivalent input still commits the complete marked text once");

    sp_region_close(region);
    webviewDetachSurface(surface);
    sp_surface_close(mainSurface);
    [window close];
    [window release];
    if (source) CFRelease(source);
    return failures == 0 ? 0 : 1;
} }
