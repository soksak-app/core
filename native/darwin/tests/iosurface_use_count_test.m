// Checks the use count of an IOSurface that a layer presents, which the lease presentation of an image region relies on:
// the host's lookup and retain of a surface do not mark it in use, the window server marks it in use while a layer of an
// on-screen window presents it, and the window server clears that mark after another surface replaces it. The check
// opens a window behind the other windows and does not activate the application.
#import <Cocoa/Cocoa.h>
#import <CoreVideo/CoreVideo.h>
#import <IOSurface/IOSurface.h>
#import <QuartzCore/QuartzCore.h>

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Pumps the run loop, one pool per turn, until done() holds or the limit passes. Returns done().
static BOOL pumpUntil(NSTimeInterval limit, BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:limit];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        @autoreleasepool {
            [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.005]];
        }
    }
    return done();
}

static IOSurfaceRef createSurface(size_t width, size_t height, uint32_t color) {
    IOSurfaceRef surface = IOSurfaceCreate((CFDictionaryRef)@{
        (id)kIOSurfaceWidth: @(width),
        (id)kIOSurfaceHeight: @(height),
        (id)kIOSurfaceBytesPerElement: @4,
        (id)kIOSurfacePixelFormat: @(kCVPixelFormatType_32BGRA),
    });
    if (!surface) return NULL;
    IOSurfaceLock(surface, 0, NULL);
    uint8_t *base = IOSurfaceGetBaseAddress(surface);
    size_t stride = IOSurfaceGetBytesPerRow(surface);
    for (size_t row = 0; row < height; row++) {
        uint32_t *pixels = (uint32_t *)(base + row * stride);
        for (size_t column = 0; column < width; column++) pixels[column] = color;
    }
    IOSurfaceUnlock(surface, 0, NULL);
    return surface;
}

// Sets the contents of the layer in one transaction without animation, as the image region swaps its contents.
static void present(CALayer *layer, IOSurfaceRef surface) {
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    layer.contents = (__bridge id)surface;
    [CATransaction commit];
    [CATransaction flush];
}

void sp_test_declare_activation(void);

int main(int argc, char **argv) { @autoreleasepool {
    (void)argc; (void)argv;
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 120, 240, 240)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    NSView *view = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 240, 240)];
    view.wantsLayer = YES;
    window.contentView = view;
    CALayer *layer = [CALayer layer];
    layer.frame = view.bounds;
    [view.layer addSublayer:layer];
    [window orderBack:nil];
    check(pumpUntil(5, ^BOOL { return (window.occlusionState & NSWindowOcclusionStateVisible) != 0 || window.isVisible; }),
        @"the window is on screen");

    size_t width = (size_t)(240 * window.backingScaleFactor);
    IOSurfaceRef first = createSurface(width, width, 0xFF2060A0);
    IOSurfaceRef second = createSurface(width, width, 0xFFA06020);
    check(first && second, @"two surfaces are created");
    check(!IOSurfaceIsInUse(first), @"a new surface is not in use");

    // The host looks the surface up by its identifier and retains it, as it does for every transfer image.
    IOSurfaceRef held = IOSurfaceLookup(IOSurfaceGetID(first));
    check(held != NULL && !IOSurfaceIsInUse(first),
        [NSString stringWithFormat:@"the lookup and retain of the host do not mark the surface in use (in use %d)", held ? IOSurfaceIsInUse(first) : -1]);

    NSDate *start = [NSDate date];
    present(layer, held);
    BOOL shown = pumpUntil(5, ^BOOL { return IOSurfaceIsInUse(first); });
    check(shown, [NSString stringWithFormat:@"the window server marks the presented surface in use (%.3f s)", [NSDate.date timeIntervalSinceDate:start]]);

    // Another surface replaces it and the host drops its reference, as a lease ends at a committed swap.
    start = [NSDate date];
    present(layer, second);
    CFRelease(held);
    BOOL cleared = pumpUntil(5, ^BOOL { return !IOSurfaceIsInUse(first); });
    check(cleared, [NSString stringWithFormat:@"the window server clears the mark after another surface replaces it (%.3f s)",
        [NSDate.date timeIntervalSinceDate:start]]);
    check(pumpUntil(5, ^BOOL { return IOSurfaceIsInUse(second); }), @"the replacing surface is in use while presented");

    [window orderOut:nil];
    present(layer, NULL);
    CFRelease(first);
    CFRelease(second);
    printf("%s\n", failures ? "FAIL: iosurface_use_count_test" : "PASS: iosurface_use_count_test");
    return failures ? 1 : 0;
}}
