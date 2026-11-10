// Checks the use count of an IOSurface that a layer presents, which the lease presentation of an image region relies on:
// the host's lookup and retain of a surface do not mark it in use, the window server marks it in use while a layer of an
// on-screen window presents it, and the window server clears that mark once a later surface is presented after the one
// that replaced it. Whether one replacement alone clears the mark depends on the machine: it reports that time and does
// not judge it. The check opens a window behind the other windows and does not activate the application.
#import <Cocoa/Cocoa.h>
#import <CoreVideo/CoreVideo.h>
#import <IOSurface/IOSurface.h>
#import <QuartzCore/QuartzCore.h>
#import "support/event_wait.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Waits until done() holds, with an autorelease pool for each turn of the run loop: the condition drains the pool of the turn
// before it judges, so the objects that a turn autoreleases are released at its end, as a turn of NSApp run does.
static void waitTurns(NSString *what, BOOL (^done)(void)) {
    __block NSAutoreleasePool *turn = [[NSAutoreleasePool alloc] init];
    eventWait(what, ^BOOL {
        [turn drain];
        turn = [[NSAutoreleasePool alloc] init];
        return done();
    });
    [turn drain];
}

// Counts the refreshes of the display. Each refresh is a source of the main run loop, so a wait for a mark that the window
// server sets or clears, which no source of this process reports, judges the mark again at each refresh.
@interface SPRefreshes : NSObject
@property(nonatomic) NSUInteger ticks;
- (void)tick:(CADisplayLink *)link;
@end

@implementation SPRefreshes
- (void)tick:(CADisplayLink *)link {
    (void)link;
    self.ticks++;
}
@end

// The refreshes after the replacing surface is in use during which the mark of the replaced surface is watched without a
// later presentation. The window server presents at most one frame per refresh, so these refreshes show whether the
// replacement alone clears the mark.
static const NSUInteger kReplacedRefreshes = 60;

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
    waitTurns(@"the window is on screen", ^BOOL { return (window.occlusionState & NSWindowOcclusionStateVisible) != 0 || window.isVisible; });
    check(window.isVisible, @"the window is on screen");
    SPRefreshes *refreshes = [[SPRefreshes alloc] init];
    CADisplayLink *link = [[window.screen displayLinkWithTarget:refreshes selector:@selector(tick:)] retain];
    [link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];

    size_t width = (size_t)(240 * window.backingScaleFactor);
    IOSurfaceRef first = createSurface(width, width, 0xFF2060A0);
    IOSurfaceRef second = createSurface(width, width, 0xFFA06020);
    IOSurfaceRef third = createSurface(width, width, 0xFF20A060);
    check(first && second && third, @"three surfaces are created");
    check(!IOSurfaceIsInUse(first), @"a new surface is not in use");

    // The host looks the surface up by its identifier and retains it, as it does for every transfer image.
    IOSurfaceRef held = IOSurfaceLookup(IOSurfaceGetID(first));
    check(held != NULL && !IOSurfaceIsInUse(first),
        [NSString stringWithFormat:@"the lookup and retain of the host do not mark the surface in use (in use %d)", held ? IOSurfaceIsInUse(first) : -1]);

    NSDate *start = [NSDate date];
    present(layer, held);
    waitTurns(@"the window server marks the presented surface in use", ^BOOL { return IOSurfaceIsInUse(first); });
    check(IOSurfaceIsInUse(first), [NSString stringWithFormat:@"the window server marks the presented surface in use (%.3f s)", [NSDate.date timeIntervalSinceDate:start]]);

    // Another surface replaces it and the host drops its reference, as a lease ends at a committed swap.
    start = [NSDate date];
    present(layer, second);
    CFRelease(held);
    waitTurns(@"the window server marks the replacing surface in use", ^BOOL { return IOSurfaceIsInUse(second); });
    check(IOSurfaceIsInUse(second), @"the replacing surface is in use while presented");
    NSUInteger replacedAt = refreshes.ticks;
    waitTurns(@"the mark of the replaced surface clears or the refreshes of the replacement pass", ^BOOL {
        return !IOSurfaceIsInUse(first) || refreshes.ticks - replacedAt >= kReplacedRefreshes;
    });
    BOOL clearedByOne = !IOSurfaceIsInUse(first);
    printf("MEASURE: one replacement %s the mark of the replaced surface after %lu of %lu refreshes (%.3f s)\n",
        clearedByOne ? "cleared" : "did not clear", (unsigned long)(refreshes.ticks - replacedAt),
        (unsigned long)kReplacedRefreshes, [NSDate.date timeIntervalSinceDate:start]);

    // A later surface replaces the second one, as the next frame of a supplier does.
    start = [NSDate date];
    present(layer, third);
    waitTurns(@"the window server clears the mark of the replaced surface", ^BOOL { return !IOSurfaceIsInUse(first); });
    check(!IOSurfaceIsInUse(first), [NSString stringWithFormat:@"the window server clears the mark of a replaced surface once a later surface is presented (%.3f s)",
        [NSDate.date timeIntervalSinceDate:start]]);

    [link invalidate];
    [link release];
    [refreshes release];
    [window orderOut:nil];
    present(layer, NULL);
    CFRelease(first);
    CFRelease(second);
    CFRelease(third);
    printf("%s\n", failures ? "FAIL: iosurface_use_count_test" : "PASS: iosurface_use_count_test");
    return failures ? 1 : 0;
}}
