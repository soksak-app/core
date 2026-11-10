// A window behind another window is captured with the pixels of its three kinds of layers: a web view registered as a
// host registers it, a Metal layer and an IOSurface layer, and with its child window, as a modal stands over it. Each
// layer changes while the window stays covered, and the capture shows the change. The check uses no activation, no real input and no window position outside the screen.
// A failure of ScreenCaptureKit keeps its error code, because its text depends on the language of the person.
#import <Cocoa/Cocoa.h>
#import <IOSurface/IOSurface.h>
#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>
#import <QuartzCore/QuartzCore.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#include <signal.h>
#include <unistd.h>
#import "capture.h"
#import "window_facts.h"
#import "support/temporary_folder.h"

@interface WKWebView (Presentation)
- (void)_doAfterNextPresentationUpdate:(void (^)(void))update;
@end

static int failures;
static const CGFloat kWidth = 480, kHeight = 320;

static void check(BOOL condition, NSString *message) {
    fprintf(stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}
static void expired(int signalNumber) {
    const char message[] = "FAIL: covered capture test exceeded 90000ms\n";
    write(STDERR_FILENO, message, sizeof message - 1);
    _exit(1);
}
static BOOL pumpUntil(double seconds, BOOL (^done)(void)) {
    NSDate *until = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (!done() && until.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    return done();
}
static void settle(double seconds) {
    NSDate *until = [NSDate dateWithTimeIntervalSinceNow:seconds];
    pumpUntil(seconds + 1, ^BOOL { return until.timeIntervalSinceNow <= 0; });
}

// The system paths are observed, and one failure is injected at a time. The general content query is never forwarded:
// it is the path that asks the person for the screen recording permission.
static NSUInteger generalContentQueries;
static NSUInteger stillRequests, stillRequestsWithCursor;
static NSError *contentFailure, *stillFailure, *startFailure;
static IMP realCurrentContent, realStill, realStart;

static void observedGeneralContent(id self, SEL _cmd, void (^reply)(SCShareableContent *, NSError *)) {
    generalContentQueries++;
    reply(nil, [NSError errorWithDomain:SCStreamErrorDomain code:SCStreamErrorUserDeclined userInfo:nil]);
}
static void observedCurrentContent(id self, SEL _cmd, void (^reply)(SCShareableContent *, NSError *)) {
    if (contentFailure != nil) { reply(nil, contentFailure); return; }
    ((void (*)(id, SEL, id))realCurrentContent)(self, _cmd, reply);
}
static void observedStill(id self, SEL _cmd, SCContentFilter *filter, SCStreamConfiguration *config,
    void (^reply)(CGImageRef, NSError *)) {
    stillRequests++;
    if (config.showsCursor) stillRequestsWithCursor++;
    if (stillFailure != nil) { reply(NULL, stillFailure); return; }
    ((void (*)(id, SEL, id, id, id))realStill)(self, _cmd, filter, config, reply);
}
static void observedStart(id self, SEL _cmd, void (^reply)(NSError *)) {
    if (startFailure != nil) { reply(startFailure); return; }
    ((void (*)(id, SEL, id))realStart)(self, _cmd, reply);
}
static void observeSystemPaths(void) {
    Class content = SCShareableContent.class;
    method_setImplementation(class_getClassMethod(content, @selector(getShareableContentWithCompletionHandler:)),
        (IMP)observedGeneralContent);
    realCurrentContent = method_setImplementation(
        class_getClassMethod(content, @selector(getCurrentProcessShareableContentWithCompletionHandler:)),
        (IMP)observedCurrentContent);
    realStill = method_setImplementation(class_getClassMethod(SCScreenshotManager.class,
        @selector(captureImageWithFilter:configuration:completionHandler:)), (IMP)observedStill);
    realStart = method_setImplementation(class_getInstanceMethod(SCStream.class,
        @selector(startCaptureWithCompletionHandler:)), (IMP)observedStart);
}

typedef struct { size_t width, height; uint8_t *bytes; } Image;

static Image capture(NSWindow *window, NSString *directory, NSString *name) {
    NSString *path = [directory stringByAppendingPathComponent:[name stringByAppendingString:@".png"]];
    char *error = NULL;
    // The window first, then its child windows, as a host lists them.
    NSMutableArray<NSNumber *> *listed = [NSMutableArray arrayWithObject:@(window.windowNumber)];
    for (NSWindow *child in window.childWindows) [listed addObject:@(child.windowNumber)];
    long numbers[listed.count];
    for (NSUInteger index = 0; index < listed.count; index++) numbers[index] = listed[index].longValue;
    bool written = sp_capture_still(numbers, (int)listed.count, path.fileSystemRepresentation, &error);
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
    check(pumpUntil(10, ^BOOL { return presented; }), @"the web view presents");
    settle(0.5);
}
static void evaluate(WKWebView *web, NSString *script) {
    __block BOOL done = NO;
    __block NSString *failure = nil;
    [web evaluateJavaScript:script completionHandler:^(id result, NSError *error) {
        failure = [error.localizedDescription copy];
        done = YES;
    }];
    check(pumpUntil(10, ^BOOL { return done; }) && failure == nil,
        [NSString stringWithFormat:@"the page script runs (%@)", failure ?: @""]);
}
// The system gives a failure a description of its own, in the language of the person, that names no code.
static NSError *systemFailure(long code) {
    return [NSError errorWithDomain:SCStreamErrorDomain code:code
        userInfo:@{NSLocalizedDescriptionKey: @"the stream failed"}];
}
static void expectError(char *error, NSString *what, long code) {
    NSString *text = error == NULL ? @"" : [NSString stringWithUTF8String:error];
    NSString *want = [NSString stringWithFormat:@"%@ %ld", SCStreamErrorDomain, code];
    check([text containsString:want], [NSString stringWithFormat:@"%@ keeps the error code %@ (got \"%@\")", what, want, text]);
}

int main(void) { @autoreleasepool {
    signal(SIGALRM, expired);
    alarm(90);
    fprintf(stderr, "START: covered window capture\n");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    observeSystemPaths();
    pid_t front = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
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
    pumpUntil(10, ^BOOL { return !web.isLoading; });
    loaded = !web.isLoading;
    check(loaded, @"the page loads behind other windows");

    pumpUntil(5, ^BOOL { return window.backingScaleFactor > 0; });
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
    settle(1);
    waitForPresentation(web);

    Image first = capture(window, directory, @"first");
    settle(3);
    // The window controls of a window that has just appeared can still change: the second capture is the state before the cover.
    Image back = capture(window, directory, @"back");
    fprintf(stderr, "two captures before the cover: %s\n", differences(first, back, scale).UTF8String);
    if (back.bytes != NULL) expectPixel(back, scale, 180, 280, 0x28c850, @"the child window");

    NSWindow *cover = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, kWidth + 160, kHeight + 160)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    cover.releasedWhenClosed = NO;
    cover.animationBehavior = NSWindowAnimationBehaviorNone;
    cover.backgroundColor = [NSColor colorWithSRGBRed:1 green:0 blue:1 alpha:1];
    [cover orderWindow:NSWindowAbove relativeTo:window.windowNumber];
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
    BOOL coverOver = pumpUntil(10, coverIsOver);
    check(coverOver && NSContainsRect(cover.frame, window.frame) && NSContainsRect(cover.frame, child.frame),
        [NSString stringWithFormat:@"the cover is over the whole window and its child (cover %ld, window %ld, child %ld)",
            (long)coverIndex, (long)targetIndex, (long)childIndex]);
    check((window.occlusionState & NSWindowOcclusionStateVisible) == 0, @"the window server reports the window as occluded");
    // WebKit hides the document of an occluded window after a delay. It stays shown with the registered web view.
    settle(3);

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
    settle(0.5);
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
    check(generalContentQueries == 0, @"the capture does not query the content that needs the screen recording permission");
    check(stillRequests == 4 && stillRequestsWithCursor == 0,
        [NSString stringWithFormat:@"the %lu captures ask for no cursor (%lu with one)", (unsigned long)stillRequests, (unsigned long)stillRequestsWithCursor]);

    // A failure of the system keeps its code at each entry point.
    NSString *path = [directory stringByAppendingPathComponent:@"failed.png"];
    char *error = NULL;
    stillFailure = systemFailure(SCStreamErrorInternalError);
    check(!sp_capture_still((long[]){window.windowNumber}, 1, path.fileSystemRepresentation, &error), @"a failed still capture reports failure");
    expectError(error, @"a failed still capture", SCStreamErrorInternalError);
    free(error); error = NULL;
    stillFailure = nil;
    contentFailure = systemFailure(SCStreamErrorNoWindowList);
    check(!sp_capture_still((long[]){window.windowNumber}, 1, path.fileSystemRepresentation, &error), @"a failed content query reports failure");
    expectError(error, @"the content query of a still capture", SCStreamErrorNoWindowList);
    free(error); error = NULL;
    check(!sp_capture_open(window.windowNumber, false, &error), @"a failed content query fails a recording");
    expectError(error, @"the content query of a recording", SCStreamErrorNoWindowList);
    free(error); error = NULL;
    contentFailure = nil;
    startFailure = systemFailure(SCStreamErrorFailedToStart);
    check(sp_capture_open(window.windowNumber, false, &error), @"a recording opens the covered window");
    free(error); error = NULL;
    check(sp_capture_start(directory.fileSystemRepresentation, false, &error), @"the start request of a recording is sent");
    free(error); error = NULL;
    pumpUntil(5, ^BOOL { return strlen(sp_capture_error()) > 0; });
    expectError((char *)sp_capture_error(), @"a failed recording start", SCStreamErrorFailedToStart);
    sp_capture_stop(0);
    startFailure = nil;

    check(!NSApp.isActive, @"the capture does not activate the application");
    check(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == front, @"the front application does not change");
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
