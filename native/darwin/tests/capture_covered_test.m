// A window behind another window is captured with the pixels of its three kinds of layers: a web view registered as a
// host registers it, a Metal layer and an IOSurface layer, and with its child window, as a modal stands over it. Each
// layer changes while the window stays covered, and the capture shows the change. The check uses no activation, no real input and no window position outside the screen.
// A recording of the covered window takes a still every refresh for three seconds while a marker changes every refresh, and each
// frame shows what the window server showed between the request of its still and its completion (docs/spec/diagnostics.md).
// The capture asks the window server for the windows of its own process, so it needs no screen recording permission: the check
// prints whether the process has it, and with --without-screen-recording, which a launch of its bundle by LaunchServices gives
// (make test-capture-without-screen-recording), it requires that the process has it not.
#import <Cocoa/Cocoa.h>
#import <IOSurface/IOSurface.h>
#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>
#import <QuartzCore/QuartzCore.h>
#import <WebKit/WebKit.h>
#import "capture.h"
#import "window_facts.h"
#import "private/webkit.h"
#import "support/run_until.h"
#import "support/temporary_folder.h"
#import "support/capture_frame.m"

@interface WKWebView (Presentation)
- (void)_doAfterNextPresentationUpdate:(void (^)(void))update;
@end

static int failures;
static const CGFloat kWidth = 480, kHeight = 320;

static void check(BOOL condition, NSString *message) {
    fprintf(stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}
// Runs the run loop until done holds (support/run_until.h).
static void until(NSString *what, BOOL (^done)(void)) {
    sp_run_until(what.UTF8String, done);
}

typedef struct { size_t width, height; uint8_t *bytes; } Image;
static NSUInteger captures;

static Image capture(NSWindow *window, NSString *directory, NSString *name) {
    NSString *path = [directory stringByAppendingPathComponent:[name stringByAppendingString:@".png"]];
    char *error = NULL;
    // The capture finds the child windows of the window itself.
    bool written = sp_capture_still(window.windowNumber, path.fileSystemRepresentation, &error);
    captures++;
    check(written && error == NULL, [NSString stringWithFormat:@"the %@ capture has no error (%s)", name, error ?: ""]);
    free(error);
    Image image = {0, 0, NULL};
    if (!written) return image;
    CGImageSourceRef source = CGImageSourceCreateWithData((CFDataRef)[NSData dataWithContentsOfFile:path], NULL);
    CGImageRef decoded = CGImageSourceCreateImageAtIndex(source, 0, NULL);
    image.width = CGImageGetWidth(decoded);
    image.height = CGImageGetHeight(decoded);
    image.bytes = calloc(image.width * image.height, 4);
    CGColorSpaceRef srgb = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(image.bytes, image.width, image.height, 8, image.width * 4, srgb,
        (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
    CGContextSetBlendMode(context, kCGBlendModeCopy);
    CGContextDrawImage(context, CGRectMake(0, 0, image.width, image.height), decoded);
    CGContextRelease(context);
    CGColorSpaceRelease(srgb);
    CGImageRelease(decoded);
    CFRelease(source);
    return image;
}
// x and y are points in the content view from its top left.
static uint32_t pixelAt(Image image, CGFloat scale, CGFloat x, CGFloat y) {
    size_t top = image.height - (size_t)(kHeight * scale);
    const uint8_t *p = image.bytes + ((top + (size_t)(y * scale)) * image.width + (size_t)(x * scale)) * 4;
    return (uint32_t)p[0] << 16 | (uint32_t)p[1] << 8 | p[2];
}
static void expectPixel(Image image, CGFloat scale, CGFloat x, CGFloat y, uint32_t want, NSString *what) {
    uint32_t got = image.bytes == NULL ? 0xffffffff : pixelAt(image, scale, x, y);
    check(got == want, [NSString stringWithFormat:@"%@ is %06x (got %06x)", what, want, got]);
}
static NSUInteger pixelsOfColor(Image image, uint32_t color) {
    NSUInteger count = 0;
    for (size_t i = 0; i < image.width * image.height; i++) {
        const uint8_t *p = image.bytes + i * 4;
        if (((uint32_t)p[0] << 16 | (uint32_t)p[1] << 8 | p[2]) == color) count++;
    }
    return count;
}

// The pixels that differ above the content view, in its first row, and in the rest of it, and the first row that differs.
static NSString *differences(Image a, Image b, CGFloat scale) {
    if (a.bytes == NULL || b.bytes == NULL) return @"a capture is missing";
    if (a.width != b.width || a.height != b.height) return [NSString stringWithFormat:@"sizes %zux%zu and %zux%zu", a.width, a.height, b.width, b.height];
    size_t top = a.height - (size_t)(kHeight * scale), above = 0, first = 0, rest = 0;
    long firstRow = -1, firstColumn = -1;
    for (size_t y = 0; y < a.height; y++) {
        for (size_t x = 0; x < a.width; x++) {
            size_t at = (y * a.width + x) * 4;
            if (memcmp(a.bytes + at, b.bytes + at, 4) == 0) continue;
            if (firstRow < 0) { firstRow = y; firstColumn = x; }
            if (y < top) above++; else if (y == top) first++; else rest++;
        }
    }
    return [NSString stringWithFormat:@"title bar %zu, first content row %zu, content %zu, first at row %ld column %ld, content starts at row %zu",
        above, first, rest, firstRow, firstColumn, top];
}
static void paintMetal(CAMetalLayer *layer, id<MTLCommandQueue> queue, uint8_t red) {
    size_t width = layer.drawableSize.width, height = layer.drawableSize.height;
    id<MTLBuffer> buffer = [[layer.device newBufferWithLength:width * height * 4 options:MTLResourceStorageModeShared] autorelease];
    uint8_t *bytes = buffer.contents;
    // The left 30 percent is opaque, the rest is the hole through which the web view shows.
    for (size_t y = 0; y < height; y++) {
        for (size_t x = 0; x < width * 3 / 10; x++) {
            uint8_t *p = bytes + (y * width + x) * 4;
            p[0] = 0x20; p[1] = 0xa8; p[2] = red; p[3] = 0xff;
        }
    }
    id<CAMetalDrawable> drawable = [layer nextDrawable];
    id<MTLCommandBuffer> command = [queue commandBuffer];
    id<MTLBlitCommandEncoder> blit = [command blitCommandEncoder];
    [blit copyFromBuffer:buffer sourceOffset:0 sourceBytesPerRow:width * 4 sourceBytesPerImage:width * height * 4
        sourceSize:MTLSizeMake(width, height, 1) toTexture:drawable.texture destinationSlice:0 destinationLevel:0
        destinationOrigin:MTLOriginMake(0, 0, 0)];
    [blit endEncoding];
    [command presentDrawable:drawable];
    [command commit];
    // The window is behind other windows, and the compositor may not present a drawable of an occluded window, so the frame is
    // judged by the completion of its commands; the web view presentation update that follows commits the window's layers.
    [command waitUntilCompleted];
    check(command.status == MTLCommandBufferStatusCompleted, @"the Metal frame completes");
}
static IOSurfaceRef surfaceOf(size_t width, size_t height, uint8_t blue) {
    IOSurfaceRef surface = IOSurfaceCreate((CFDictionaryRef)@{(id)kIOSurfaceWidth: @(width), (id)kIOSurfaceHeight: @(height),
        (id)kIOSurfaceBytesPerElement: @4, (id)kIOSurfacePixelFormat: @(0x42475241u)});
    IOSurfaceSetValue(surface, kIOSurfaceColorSpace, kCGColorSpaceSRGB);
    IOSurfaceLock(surface, 0, NULL);
    uint8_t *bytes = IOSurfaceGetBaseAddress(surface);
    size_t row = IOSurfaceGetBytesPerRow(surface);
    for (size_t y = 0; y < height; y++) {
        for (size_t x = 0; x < width; x++) {
            uint8_t *p = bytes + y * row + x * 4;
            p[0] = blue; p[1] = 0x32; p[2] = 0x10; p[3] = 0xff;
        }
    }
    IOSurfaceUnlock(surface, 0, NULL);
    return surface;
}
static void showSurface(CALayer *layer, IOSurfaceRef surface) {
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    layer.contents = (id)surface;
    [CATransaction commit];
    [CATransaction flush];
}
static void waitForPresentation(WKWebView *web) {
    __block BOOL presented = NO;
    [web _doAfterNextPresentationUpdate:^{ presented = YES; }];
    until(@"the web view presents", ^BOOL { return presented; });
}
static id evaluate(WKWebView *web, NSString *script) {
    __block BOOL done = NO;
    __block NSString *failure = nil;
    __block id value = nil;
    [web evaluateJavaScript:script completionHandler:^(id result, NSError *error) {
        failure = [error.localizedDescription copy];
        value = [result retain];
        done = YES;
    }];
    until(@"the page script answers", ^BOOL { return done; });
    check(failure == nil, [NSString stringWithFormat:@"the page script runs (%@)", failure ?: @""]);
    [failure release];
    return [value autorelease];
}
// The marker of the recording: from x 360 at y 20 to 28 of the content view, a white and a black square of 8 points, then twelve
// squares that hold the step from its highest bit, white for 1. Black and white read the same in any color space.
static const CGFloat kMarkerX = 360, kMarkerY = 20;
static const int kMarkerBits = 12;
// The step of a frame, -1 when its guard squares do not read. The frame holds the window with its title bar, and the content
// view is its bottom kHeight points.
static long markerStep(NSData *frame) {
    const uint8_t *bytes = frame.bytes;
    uint32_t dimensions[3];
    memcpy(dimensions, bytes, sizeof dimensions);
    double scale;
    memcpy(&scale, bytes + 12 + 5 * sizeof(double), sizeof scale);
    const uint8_t *pixels = bytes + kCaptureFrameHeader;
    size_t top = dimensions[1] - (size_t)llround(kHeight * scale), stride = dimensions[2];
    long (^green)(CGFloat) = ^long(CGFloat x) {
        const uint8_t *p = pixels + (top + (size_t)((kMarkerY + 4) * scale)) * stride + (size_t)(x * scale) * 4;
        return p[1];
    };
    if (green(kMarkerX + 4) < 200 || green(kMarkerX + 12) > 55) return -1;
    long step = 0;
    for (int bit = 0; bit < kMarkerBits; bit++) step = step << 1 | (green(kMarkerX + 20 + bit * 8) >= 128 ? 1 : 0);
    return step;
}
// The BGRA pixel of a frame at a point of the content view, as 0xRRGGBB.
static uint32_t framePixel(NSData *frame, CGFloat x, CGFloat y) {
    const uint8_t *bytes = frame.bytes;
    uint32_t dimensions[3];
    memcpy(dimensions, bytes, sizeof dimensions);
    double scale;
    memcpy(&scale, bytes + 12 + 5 * sizeof(double), sizeof scale);
    size_t top = dimensions[1] - (size_t)llround(kHeight * scale);
    const uint8_t *p = bytes + kCaptureFrameHeader + (top + (size_t)(y * scale)) * dimensions[2] + (size_t)(x * scale) * 4;
    return (uint32_t)p[2] << 16 | (uint32_t)p[1] << 8 | p[0];
}

// Changes the marker at every refresh of the window, on the main thread, and keeps when each step began and when its commit was
// sent to the window server, on the clock of the recorded frames.
@interface MarkerDriver : NSObject
@property (nonatomic, retain) NSArray<NSView *> *bits;
@property (nonatomic) long step;
@property (nonatomic) BOOL changing;
@property (nonatomic, retain) NSMutableArray<NSNumber *> *began, *sent, *refreshes;
@end
@implementation MarkerDriver
- (void)refresh:(CADisplayLink *)link {
    [self.refreshes addObject:@(link.timestamp * 1000)];
    if (!self.changing) return;
    long step = self.step + 1;
    double begin = sp_capture_clock();
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    for (int bit = 0; bit < kMarkerBits; bit++) self.bits[bit].layer.backgroundColor = CGColorGetConstantColor(
        (step >> (kMarkerBits - 1 - bit)) & 1 ? kCGColorWhite : kCGColorBlack);
    [CATransaction commit];
    [CATransaction flush];
    self.step = step;
    [self.began addObject:@(begin)];
    [self.sent addObject:@(sp_capture_clock())];
}
@end

static double median(NSArray<NSNumber *> *values) {
    NSArray<NSNumber *> *sorted = [values sortedArrayUsingSelector:@selector(compare:)];
    return sorted.count == 0 ? 0 : sorted[sorted.count / 2].doubleValue;
}
static double ticksToMilliseconds(id value, double numerator, double denominator) {
    return [value isKindOfClass:NSString.class] ? strtoull([value UTF8String], NULL, 10) * numerator / denominator / 1e6 : NAN;
}

int main(int argc, char **argv) { @autoreleasepool {
    fprintf(stderr, "START: covered window capture\n");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    BOOL permitted = CGPreflightScreenCaptureAccess();
    fprintf(stderr, "screen recording permission: %s\n", permitted ? "granted" : "not granted");
    if (argc > 1 && strcmp(argv[1], "--without-screen-recording") == 0)
        check(!permitted, @"the process runs without the screen recording permission");
    NSString *directory = temporaryFolder(@"soksak-capture-covered-");

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(160, 160, kWidth, kHeight)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    window.backgroundColor = [NSColor colorWithSRGBRed:0.2 green:0.2 blue:0.25 alpha:1];
    NSView *content = window.contentView;
    content.wantsLayer = YES;
    WKWebView *web = [[WKWebView alloc] initWithFrame:content.bounds configuration:[[WKWebViewConfiguration new] autorelease]];
    [web setValue:@NO forKey:@"drawsBackground"];
    [content addSubview:web];
    [window orderBack:nil];
    check(sp_window_set_main_webview(window, web) != NULL, @"the web view is registered as a host registers it");
    __block BOOL loaded = NO;
    [web loadHTMLString:@"<!doctype html><style>html,body{margin:0;background:transparent;overflow:hidden}"
        "div,canvas{position:absolute}#page{left:0;top:0;width:480px;height:160px;background:#c83232}"
        "#gl{left:216px;top:176px;width:72px;height:64px}"
        "#composited{left:298px;top:208px;width:86px;height:80px;background:#32c8c8;transform:translateZ(0);will-change:transform}</style>"
        "<div id=page></div><canvas id=gl width=144 height=128></canvas><div id=composited></div><script>"
        "const gl=document.getElementById('gl').getContext('webgl',{preserveDrawingBuffer:true});"
        "function paint(r,g,b){gl.clearColor(r,g,b,1);gl.clear(gl.COLOR_BUFFER_BIT)};paint(0.9,0.7,0.1);"
        "</script>" baseURL:nil];
    until(@"the page load ends", ^BOOL { return !web.isLoading; });
    loaded = !web.isLoading;
    check(loaded, @"the page loads behind other windows");

    CGFloat scale = window.backingScaleFactor;
    NSView *metalView = [[NSView alloc] initWithFrame:content.bounds];
    CAMetalLayer *metal = [CAMetalLayer layer];
    metal.device = [MTLCreateSystemDefaultDevice() autorelease];
    metal.pixelFormat = MTLPixelFormatBGRA8Unorm;
    metal.framebufferOnly = NO;
    metal.opaque = NO;
    CGColorSpaceRef srgb = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    metal.colorspace = srgb;
    CGColorSpaceRelease(srgb);
    metal.contentsScale = scale;
    metal.drawableSize = CGSizeMake(kWidth * scale, kHeight * scale);
    metalView.layer = metal;
    metalView.wantsLayer = YES;
    [content addSubview:metalView];
    id<MTLCommandQueue> queue = [metal.device newCommandQueue];
    NSView *surfaceView = [[NSView alloc] initWithFrame:NSMakeRect(288, kHeight - 192, 144, 128)];
    surfaceView.wantsLayer = YES;
    surfaceView.layer.contentsGravity = kCAGravityResize;
    surfaceView.layer.contentsScale = scale;
    [content addSubview:surfaceView];
    paintMetal(metal, queue, 0x10);
    IOSurfaceRef surface = surfaceOf(144 * scale, 128 * scale, 0xc0);
    showSurface(surfaceView.layer, surface);
    // A child window stands over the window from x 150 to 210 and y 250 to 310 of the content view, as a modal does.
    NSWindow *child = [[NSWindow alloc] initWithContentRect:[window convertRectToScreen:
        [content convertRect:NSMakeRect(150, kHeight - 310, 60, 60) toView:nil]]
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    child.releasedWhenClosed = NO;
    child.animationBehavior = NSWindowAnimationBehaviorNone;
    child.backgroundColor = [NSColor colorWithSRGBRed:0x28 / 255.0 green:0xc8 / 255.0 blue:0x50 / 255.0 alpha:1];
    [window addChildWindow:child ordered:NSWindowAbove];
    [child displayIfNeeded];
    [CATransaction flush];
    waitForPresentation(web);

    // The window has no title bar buttons after its own appearance and its presentations: standardWindowButton: is nil, and a
    // capture holds a title bar without them, while the capture of the covered window has them. In the window run they were
    // there only after the cover was ordered behind the window, a still capture of the window was taken and the next
    // presentation followed; after the order and two presentations, and right after the still, there were none. So the cover is
    // made first and ordered behind the window, where it covers nothing of it, and this still is that capture.
    NSWindow *cover = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, kWidth + 160, kHeight + 160)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    cover.releasedWhenClosed = NO;
    cover.animationBehavior = NSWindowAnimationBehaviorNone;
    cover.backgroundColor = [NSColor colorWithSRGBRed:1 green:0 blue:1 alpha:1];
    [cover orderWindow:NSWindowBelow relativeTo:window.windowNumber];
    [CATransaction flush];
    Image rendered = capture(window, directory, @"rendered");
    free(rendered.bytes);
    waitForPresentation(web);
    check([window standardWindowButton:NSWindowCloseButton] != nil && [window standardWindowButton:NSWindowMiniaturizeButton] != nil
        && [window standardWindowButton:NSWindowZoomButton] != nil,
        @"the window has its three title bar buttons before the first capture");

    // The window controls of a window that has just appeared can still change: the state before the cover is the first
    // capture that equals the capture before it.
    Image first = capture(window, directory, @"first");
    Image back = capture(window, directory, @"back");
    for (;;) {
        fprintf(stderr, "two captures before the cover: %s\n", differences(first, back, scale).UTF8String);
        BOOL same = first.bytes != NULL && back.bytes != NULL && first.width == back.width && first.height == back.height
            && memcmp(first.bytes, back.bytes, first.width * first.height * 4) == 0;
        if (same || first.bytes == NULL || back.bytes == NULL) break;
        free(first.bytes);
        first = back;
        back = capture(window, directory, @"back");
    }
    if (back.bytes != NULL) expectPixel(back, scale, 180, 280, 0x28c850, @"the child window");

    [cover orderWindow:NSWindowAbove relativeTo:window.windowNumber];
    // AppKit keeps the order in the open Core Animation transaction of the thread until the run loop commits it, so the window
    // server lists the cover only after this commit.
    [CATransaction flush];
    // A window behind other windows is occluded already, so the place of the cover in the window list says that it covers.
    __block NSInteger targetIndex = -1, childIndex = -1, coverIndex = -1;
    BOOL (^coverIsOver)(void) = ^BOOL {
        NSArray *stack = [(NSArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID) autorelease];
        targetIndex = childIndex = coverIndex = -1;
        NSInteger index = 0;
        for (NSDictionary *entry in stack) {
            if ([entry[(id)kCGWindowNumber] longValue] == window.windowNumber) targetIndex = index;
            if ([entry[(id)kCGWindowNumber] longValue] == child.windowNumber) childIndex = index;
            if ([entry[(id)kCGWindowNumber] longValue] == cover.windowNumber) coverIndex = index;
            index++;
        }
        return coverIndex >= 0 && targetIndex > coverIndex && childIndex > coverIndex;
    };
    // The commit of the order returns after the window server has placed the cover.
    BOOL coverOver = coverIsOver();
    check(coverOver && NSContainsRect(cover.frame, window.frame) && NSContainsRect(cover.frame, child.frame),
        [NSString stringWithFormat:@"the cover is over the whole window and its child (cover %ld, window %ld, child %ld)",
            (long)coverIndex, (long)targetIndex, (long)childIndex]);
    check((window.occlusionState & NSWindowOcclusionStateVisible) == 0, @"the window server reports the window as occluded");
    // WebKit hides the document of an occluded window after a delay, only while it detects the occlusion of the window. The
    // registered web view does not detect it, so its document stays shown.
    check(!web._windowOcclusionDetectionEnabled, @"the registered web view does not detect the occlusion of its window");
    check([evaluate(web, @"document.visibilityState") isEqual:@"visible"], @"the document of the covered window stays visible");

    Image covered = capture(window, directory, @"covered");
    check(back.bytes != NULL && covered.bytes != NULL && back.width == covered.width && back.height == covered.height
        && memcmp(back.bytes, covered.bytes, back.width * back.height * 4) == 0,
        [NSString stringWithFormat:@"the capture of the covered window equals its capture before the cover, byte for byte (%@)",
            differences(back, covered, scale)]);
    if (covered.bytes != NULL) {
        expectPixel(covered, scale, 240, 100, 0xc83232, @"the web view");
        expectPixel(covered, scale, 250, 205, 0xe5b21a, @"the WebGL canvas of the web view");
        expectPixel(covered, scale, 340, 250, 0x32c8c8, @"the composited layer of the web view");
        expectPixel(covered, scale, 70, 160, 0x10a820, @"the Metal layer");
        expectPixel(covered, scale, 360, 128, 0x1032c0, @"the IOSurface layer");
        expectPixel(covered, scale, 240, 285, 0x333340, @"the window background");
        expectPixel(covered, scale, 180, 280, 0x28c850, @"the child window of the covered window");
        // The cover is a window of the same application outside the list: the capture holds the listed windows only.
        check(pixelsOfColor(covered, 0xff00ff) == 0, @"no pixel of the cover is in the capture");
    }

    // Every layer changes while the window stays covered.
    evaluate(web, @"document.getElementById('page').style.background='#3278c8';"
        "document.getElementById('composited').style.background='#c8c832';paint(0.1,0.7,0.9);");
    paintMetal(metal, queue, 0x90);
    IOSurfaceRef changedSurface = surfaceOf(144 * scale, 128 * scale, 0x40);
    showSurface(surfaceView.layer, changedSurface);
    waitForPresentation(web);
    Image changed = capture(window, directory, @"changed");
    if (changed.bytes != NULL) {
        expectPixel(changed, scale, 240, 100, 0x3278c8, @"the changed web view");
        expectPixel(changed, scale, 250, 205, 0x1ab2e5, @"the changed WebGL canvas");
        expectPixel(changed, scale, 340, 250, 0xc8c832, @"the changed composited layer");
        expectPixel(changed, scale, 70, 160, 0x90a820, @"the changed Metal layer");
        expectPixel(changed, scale, 360, 128, 0x103240, @"the changed IOSurface layer");
        expectPixel(changed, scale, 180, 280, 0x28c850, @"the child window after the change");
        check(pixelsOfColor(changed, 0xff00ff) == 0, @"no pixel of the cover is in the changed capture");
    }

    // A recording of the covered window: a still every refresh for three seconds, while the marker changes at every refresh.
    NSView *marker = [[[NSView alloc] initWithFrame:NSMakeRect(kMarkerX, kHeight - kMarkerY - 8, 8 * (kMarkerBits + 2), 8)] autorelease];
    marker.wantsLayer = YES;
    NSMutableArray<NSView *> *bits = [NSMutableArray array];
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    for (int index = 0; index < kMarkerBits + 2; index++) {
        NSView *square = [[[NSView alloc] initWithFrame:NSMakeRect(index * 8, 0, 8, 8)] autorelease];
        square.wantsLayer = YES;
        square.layer.backgroundColor = CGColorGetConstantColor(index == 0 ? kCGColorWhite : kCGColorBlack);
        [marker addSubview:square];
        if (index >= 2) [bits addObject:square];
    }
    [content addSubview:marker positioned:NSWindowAbove relativeTo:nil];
    [CATransaction commit];
    [CATransaction flush];
    waitForPresentation(web);
    MarkerDriver *driver = [[MarkerDriver new] autorelease];
    driver.bits = bits;
    driver.began = [NSMutableArray array];
    driver.sent = [NSMutableArray array];
    driver.refreshes = [NSMutableArray array];
    CADisplayLink *link = [window displayLinkWithTarget:driver selector:@selector(refresh:)];
    [link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
    // The refresh period of the display of the window, as the window observes it, is the gap of the recording.
    until(@"the window observes 13 refreshes", ^BOOL { return driver.refreshes.count >= 13; });
    NSMutableArray<NSNumber *> *periods = [NSMutableArray array];
    for (NSUInteger index = 1; index < driver.refreshes.count; index++)
        [periods addObject:@(driver.refreshes[index].doubleValue - driver.refreshes[index - 1].doubleValue)];
    double period = median(periods);
    fprintf(stderr, "refresh period %.3f ms\n", period);
    driver.changing = YES;
    until(@"the marker changes", ^BOOL { return driver.step >= 2; });
    NSString *recorded = [directory stringByAppendingPathComponent:@"recording"];
    [NSFileManager.defaultManager createDirectoryAtPath:recorded withIntermediateDirectories:NO attributes:nil error:NULL];
    char *error = NULL;
    check(sp_capture_open(window.windowNumber, false, &error), [NSString stringWithFormat:@"the covered window opens for a recording (%s)", error ?: ""]);
    free(error); error = NULL;
    double length = 3000, beforeStart = sp_capture_clock();
    bool started = sp_capture_start(recorded.fileSystemRepresentation, period, length / 1000, 0, false, 1, &error);
    check(started, [NSString stringWithFormat:@"the recording of the covered window starts (%s)", error ?: ""]);
    free(error); error = NULL;
    // The last still is planned at or after this time, so the stop waits for the whole plan.
    double after = beforeStart + length - period;
    if (started) until(@"the plan of the recording reaches its last still", ^BOOL { return sp_capture_clock() >= after; });
    int count = started ? sp_capture_stop(after, 2) : 0;
    driver.changing = NO;
    [link invalidate];
    const char *stopped = sp_capture_error();
    check(started && stopped != NULL && strlen(stopped) == 0, [NSString stringWithFormat:@"the recording stops without error (%s)", stopped ?: ""]);
    NSUInteger planned = (NSUInteger)ceil(length / period);
    check(count == (int)planned && sp_capture_missed() == 0 && sp_capture_late() == 0,
        [NSString stringWithFormat:@"the covered window gives every planned still: %lu planned, %d written, %d missed, %d late",
            (unsigned long)planned, count, sp_capture_missed(), sp_capture_late()]);

    NSString *rowsText = [NSString stringWithContentsOfFile:[recorded stringByAppendingPathComponent:@"stills.jsonl"]
        encoding:NSUTF8StringEncoding error:NULL];
    NSMutableArray<NSDictionary *> *rows = [NSMutableArray array];
    for (NSString *line in [rowsText componentsSeparatedByString:@"\n"]) {
        if (line.length == 0) continue;
        NSDictionary *row = [NSJSONSerialization JSONObjectWithData:[line dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL];
        if ([row isKindOfClass:NSDictionary.class]) [rows addObject:row];
    }
    check(rows.count == planned, [NSString stringWithFormat:@"stills.jsonl holds a row for each planned still (%lu rows)", (unsigned long)rows.count]);
    // Each frame shows a step that had begun by the completion of its still, and no step older than the last one whose commit was
    // sent two refresh periods before the request: the window server shows a commit at the latest at the second refresh after it.
    // A step sent shortly before the request may or may not be in the frame, which is what the window server showed then.
    NSUInteger unread = 0, future = 0, stale = 0, behind = 0, wrongChild = 0, coverPixels = 0, wrongWindows = 0, missing = 0, longGaps = 0;
    double previousRequest = NAN, longestRequestGap = 0;
    NSMutableString *firstFailures = [NSMutableString string];
    for (NSDictionary *row in rows) {
        double numerator = [row[@"machTimebaseNumerator"] doubleValue], denominator = [row[@"machTimebaseDenominator"] doubleValue];
        double requested = ticksToMilliseconds(row[@"requested"], numerator, denominator);
        double completed = ticksToMilliseconds(row[@"completed"], numerator, denominator);
        NSArray *windows = row[@"windows"];
        if (![windows isKindOfClass:NSArray.class] || windows.count != 2 || [windows[0] longValue] != child.windowNumber
            || [windows[1] longValue] != window.windowNumber) wrongWindows++;
        if (!isnan(previousRequest) && requested - previousRequest > 2 * period) longGaps++;
        if (!isnan(previousRequest)) longestRequestGap = MAX(longestRequestGap, requested - previousRequest);
        previousRequest = requested;
        NSData *frame = [row[@"frame"] isKindOfClass:NSString.class]
            ? readCaptureFrame([NSData dataWithContentsOfFile:[recorded stringByAppendingPathComponent:row[@"frame"]]]) : nil;
        if (frame == nil) { missing++; continue; }
        if (framePixel(frame, 180, 280) != 0x28c850) wrongChild++;
        {
            uint32_t dimensions[3];
            memcpy(dimensions, frame.bytes, sizeof dimensions);
            const uint8_t *pixels = (const uint8_t *)frame.bytes + kCaptureFrameHeader;
            for (size_t y = 0; y < dimensions[1]; y++)
                for (size_t x = 0; x < dimensions[0]; x++) {
                    const uint8_t *p = pixels + y * dimensions[2] + x * 4;
                    if (p[2] == 0xff && p[1] == 0 && p[0] == 0xff) coverPixels++;
                }
        }
        long step = markerStep(frame);
        if (step < 1 || step > (long)driver.began.count) { unread++; continue; }
        NSUInteger latest = 0;
        for (NSUInteger index = 0; index < driver.sent.count; index++)
            if (driver.sent[index].doubleValue <= requested - 2 * period) latest = index + 1;
        NSUInteger shownBefore = 0;
        for (NSUInteger index = 0; index < driver.sent.count; index++)
            if (driver.sent[index].doubleValue <= requested) shownBefore = index + 1;
        BOOL early = driver.began[step - 1].doubleValue > completed, old = (NSUInteger)step < latest;
        if (early) future++;
        if (old) stale++;
        if ((NSUInteger)step < shownBefore) behind++;
        if ((early || old) && firstFailures.length < 600)
            [firstFailures appendFormat:@" [still %@ requested %.2f completed %.2f shows step %ld begun %.2f; step %lu sent at %.2f]",
                row[@"index"], requested, completed, step, driver.began[step - 1].doubleValue, (unsigned long)latest,
                latest ? driver.sent[latest - 1].doubleValue : NAN];
    }
    check(missing == 0, [NSString stringWithFormat:@"every row names a frame that reads (%lu do not)", (unsigned long)missing]);
    check(wrongWindows == 0, [NSString stringWithFormat:@"every still holds the child window, then the window (%lu do not)", (unsigned long)wrongWindows]);
    check(longGaps == 0, [NSString stringWithFormat:@"no two stills are requested more than two refresh periods apart (%lu are; longest %.2f ms)",
        (unsigned long)longGaps, longestRequestGap]);
    check(unread == 0, [NSString stringWithFormat:@"the marker reads in every frame (%lu do not)", (unsigned long)unread]);
    check(future == 0 && stale == 0, [NSString stringWithFormat:
        @"every frame shows what the window showed between the request and the completion of its still (%lu later, %lu older)%@",
        (unsigned long)future, (unsigned long)stale, firstFailures]);
    fprintf(stderr, "frames that show a step older than the last one sent before the request: %lu of %lu\n", (unsigned long)behind,
        (unsigned long)rows.count);
    check(wrongChild == 0 && coverPixels == 0, [NSString stringWithFormat:
        @"every frame holds the child window and no pixel of the cover (%lu without the child, %lu with the cover)",
        (unsigned long)wrongChild, (unsigned long)coverPixels]);
    [marker removeFromSuperview];

    check(!NSApp.isActive, @"the capture does not activate the application");
    // Which other application is in front belongs to the other processes, so the check judges only this process.
    check(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != getpid()
        && !NSRunningApplication.currentApplication.isActive, @"the capture does not bring the application to the front");
    [cover close];
    [window removeChildWindow:child];
    [child close];
    [window close];
    CFRelease(surface);
    CFRelease(changedSurface);
    free(first.bytes); free(back.bytes); free(covered.bytes); free(changed.bytes);
    // The images of a failed run are its evidence.
    if (failures) keepTemporaryFolder(directory);
    if (failures == 0) fprintf(stderr, "PASS: covered window capture\n");
    return failures == 0 ? 0 : 1;
} }
