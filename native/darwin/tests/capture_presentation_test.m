// Records a window whose CAMetalLayer presents seven drawables, with a still every half refresh, and stops at the last
// presentation. Which drawables the window server shows is the window server's: Metal gives a drawable that it did not show the
// presented time 0, and the first drawable of a window that has just been ordered can be such a drawable. The check needs the
// presented time of the last drawable, where the stop ends; the presented times of the others are evidence. The recording loses no still up to its last request: no failed still, no still not requested before the last
// request and no late still; the stills after the last request of the plan, which the stop ends, are not lost. Every written
// still has a frame file of the declared format, and the request times increase. The pixels are evidence and are not judged.
// The check does not activate the application.
#import <Cocoa/Cocoa.h>
#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>
#import <QuartzCore/CATransaction.h>
#import <mach/mach_time.h>
#include <math.h>
#include <limits.h>
#import "capture.h"
#import "support/run_until.h"
#import "support/temporary_folder.h"
#import "support/capture_frame.m"

static const NSUInteger frameCount = 7;
static int failures;
static void check(BOOL ok, NSString *label) {
    fprintf(ok ? stdout : stderr, "%s: %s\n", ok ? "PASS" : "FAIL", label.UTF8String);
    if (!ok) failures++;
}
// Runs the run loop until done holds (support/run_until.h).
static void until(NSString *what, BOOL (^done)(void)) {
    sp_run_until(what.UTF8String, done);
}

static const MTLClearColor colors[] = {
    {1,0,0,1}, {0,1,0,1}, {0,0,1,1}, {1,1,0,1}, {0,1,1,1}, {1,0,1,1}, {1,1,1,1}
};

@interface SPMetalFrames : NSObject
@property(nonatomic, assign) CAMetalLayer *layer;
@property(nonatomic, retain) id<MTLCommandQueue> queue;
@property(nonatomic, retain) NSMutableArray *presentations;
@property(nonatomic) NSUInteger nextID;
@property(nonatomic) BOOL drawFailed;
- (void)submitNext;
- (void)draw:(NSUInteger)frameID;
- (void)recordSkippedFrameID:(NSUInteger)frameID drawableID:(NSUInteger)drawableID submitted:(uint64_t)submitted;
- (NSUInteger)completedPresentationCount;
@end
@implementation SPMetalFrames
- (instancetype)init {
    self = [super init];
    if (self) {
        _presentations = [[NSMutableArray alloc] initWithCapacity:frameCount];
        for (NSUInteger i = 0; i < frameCount; i++) [_presentations addObject:[NSNull null]];
    }
    return self;
}
- (void)draw:(NSUInteger)frameID {
    id<CAMetalDrawable> drawable = [self.layer nextDrawable];
    uint64_t submitted = mach_absolute_time();
    if (drawable == nil) {
        self.drawFailed = YES;
        [self recordSkippedFrameID:frameID drawableID:NSUIntegerMax submitted:submitted];
        dispatch_async(dispatch_get_main_queue(), ^{ [self submitNext]; });
        return;
    }
    MTLRenderPassDescriptor *pass = [MTLRenderPassDescriptor renderPassDescriptor];
    pass.colorAttachments[0].texture = drawable.texture;
    pass.colorAttachments[0].loadAction = MTLLoadActionClear;
    pass.colorAttachments[0].storeAction = MTLStoreActionStore;
    pass.colorAttachments[0].clearColor = colors[frameID];
    id<MTLCommandBuffer> command = [self.queue commandBuffer];
    id<MTLRenderCommandEncoder> encoder = [command renderCommandEncoderWithDescriptor:pass];
    if (command == nil || encoder == nil) {
        self.drawFailed = YES;
        [self recordSkippedFrameID:frameID drawableID:drawable.drawableID submitted:submitted];
        dispatch_async(dispatch_get_main_queue(), ^{ [self submitNext]; });
        return;
    }
    [encoder endEncoding];
    [drawable addPresentedHandler:^(id<MTLDrawable> shown) {
        NSDictionary *record = @{ @"id": @(frameID), @"drawable": @(shown.drawableID),
            @"submitted": @(submitted), @"presentedTime": @(shown.presentedTime) };
        @synchronized (self) { self.presentations[frameID] = record; }
        dispatch_async(dispatch_get_main_queue(), ^{ [self submitNext]; });
    }];
    [command presentDrawable:drawable];
    [command commit];
}
- (void)recordSkippedFrameID:(NSUInteger)frameID drawableID:(NSUInteger)drawableID submitted:(uint64_t)submitted {
    NSDictionary *record = @{ @"id": @(frameID), @"drawable": @(drawableID),
        @"submitted": @(submitted), @"presentedTime": @0 };
    @synchronized (self) { self.presentations[frameID] = record; }
}
- (void)submitNext {
    if (self.nextID >= frameCount) return;
    NSUInteger frameID = self.nextID++;
    [self draw:frameID];
}
- (NSUInteger)completedPresentationCount {
    NSUInteger count = 0;
    @synchronized (self) {
        for (id record in self.presentations) if (record != [NSNull null]) count++;
    }
    return count;
}
- (void)dealloc { [_queue release]; [_presentations release]; [super dealloc]; }
@end

static BOOL onScreen(NSWindow *window) {
    NSArray *info = [(NSArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow,
        (CGWindowID)window.windowNumber) autorelease];
    return info.count == 1 && [info[0][(id)kCGWindowIsOnscreen] boolValue];
}

int main(void) { @autoreleasepool {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: a recording of a presenting Metal window loses no still\n");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    check(device != nil, @"the system has a Metal device");
    if (device == nil) return 1;
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(90, 90, 240, 160)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    window.backgroundColor = [NSColor colorWithWhite:0.35 alpha:1];
    NSView *view = [[NSView alloc] initWithFrame:window.contentView.bounds];
    CAMetalLayer *layer = [CAMetalLayer layer];
    layer.device = device;
    layer.pixelFormat = MTLPixelFormatBGRA8Unorm;
    layer.framebufferOnly = YES;
    layer.contentsScale = window.backingScaleFactor;
    layer.frame = view.bounds;
    layer.drawableSize = CGSizeMake(view.bounds.size.width * layer.contentsScale, view.bounds.size.height * layer.contentsScale);
    layer.backgroundColor = [NSColor colorWithWhite:0.35 alpha:1].CGColor;
    // The layer is set before wantsLayer, so the view hosts it and AppKit does not draw into it as a layer-backed view.
    view.layer = layer;
    view.wantsLayer = YES;
    [window.contentView addSubview:view];
    [window orderFrontRegardless];
    // A capture reads the window from the window server whatever covers it, so the check does not wait until no other window
    // covers it: a window of another application can cover it for as long as that window stays. The display and the flush commit
    // the order and the first frame of the window to the window server, which lists the window on screen from then on.
    [window displayIfNeeded];
    [CATransaction flush];
    check(onScreen(window), @"the inactive control window is on screen");
    if (!onScreen(window)) { [window close]; [view release]; [window release]; return 1; }

    NSString *directory = temporaryFolder(@"soksak-capture-presentation-");
    char *operationError = NULL;
    BOOL opened = sp_capture_open(window.windowNumber, false, &operationError);
    check(opened, [NSString stringWithFormat:@"the control window opens for a recording (%s)", operationError ?: ""]);
    free(operationError); operationError = NULL;
    // Half the shortest refresh interval of the display: every drawable stays on screen for at least one refresh.
    double gap = MAX(1, window.screen.minimumRefreshInterval * 1000 / 2);
    BOOL started = opened && sp_capture_start(directory.fileSystemRepresentation, gap, 0, 4096, 1, &operationError);
    check(started, [NSString stringWithFormat:@"the recording of the control window starts (%s)", operationError ?: ""]);
    free(operationError); operationError = NULL;
    if (!started) { [window close]; [view release]; [window release]; return 1; }

    SPMetalFrames *driver = [SPMetalFrames new];
    driver.layer = layer;
    id<MTLCommandQueue> commandQueue = [device newCommandQueue];
    check(commandQueue != nil, @"the Metal command queue is created");
    driver.queue = commandQueue;
    [commandQueue release];
    [driver submitNext];
    until(@"every drawable has its presentation callback", ^BOOL { return driver.completedPresentationCount == frameCount; });
    check(driver.nextID == frameCount && !driver.drawFailed,
        [NSString stringWithFormat:@"all %lu distinct drawable IDs are submitted (%lu submitted, draw failure %d)",
            (unsigned long)frameCount, (unsigned long)driver.nextID, driver.drawFailed]);
    check(driver.completedPresentationCount == frameCount,
        [NSString stringWithFormat:@"every submitted drawable has a presentation callback (%lu of %lu)",
            (unsigned long)driver.completedPresentationCount, (unsigned long)frameCount]);
    if (driver.completedPresentationCount == frameCount) {
        for (NSUInteger i = 0; i < frameCount; i++) {
            NSDictionary *record;
            @synchronized (driver) { record = [[driver.presentations[i] retain] autorelease]; }
            check([record[@"id"] unsignedIntegerValue] == i,
                [NSString stringWithFormat:@"the presentation callback of drawable %lu names it (%@)", (unsigned long)i, record]);
            if (i == frameCount - 1) check([record[@"presentedTime"] doubleValue] > 0,
                [NSString stringWithFormat:@"the last drawable has a nonzero presented time, where the stop ends (%@)", record]);
            fprintf(stdout, "PRESENT id=%lu drawable=%llu submitted=%llu presented=%.9f\n", (unsigned long)i,
                [record[@"drawable"] unsignedLongLongValue], [record[@"submitted"] unsignedLongLongValue],
                [record[@"presentedTime"] doubleValue]);
        }
    }
    // The stop waits for a still requested at or after the last presentation.
    double lastPresented = 0;
    @synchronized (driver) {
        for (id record in driver.presentations)
            if (record != [NSNull null]) lastPresented = MAX(lastPresented, [record[@"presentedTime"] doubleValue] * 1000);
    }
    // The plan is longer than the test needs and the stop ends it, so the stills after the last request stay not requested.
    int written = sp_capture_stop(lastPresented > 0 ? lastPresented : sp_capture_clock(), 2);
    NSString *stopError = [NSString stringWithUTF8String:sp_capture_error()];
    int late = sp_capture_late();
    NSString *rowsText = [NSString stringWithContentsOfFile:[directory stringByAppendingPathComponent:@"stills.jsonl"]
        encoding:NSUTF8StringEncoding error:NULL];
    NSMutableArray<NSDictionary *> *rows = [NSMutableArray array], *allRows = [NSMutableArray array];
    for (NSString *line in [rowsText componentsSeparatedByString:@"\n"]) {
        if (line.length == 0) continue;
        NSDictionary *row = [NSJSONSerialization JSONObjectWithData:[line dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL];
        if (![row isKindOfClass:NSDictionary.class]) continue;
        [allRows addObject:row];
        if ([row[@"outcome"] isEqual:@"written"]) [rows addObject:row];
    }
    // A lost still: a failed still, a still not requested before the last requested still, or a late still (more than one gap
    // after its planned time).
    NSInteger lastRequested = -1;
    for (NSDictionary *row in allRows) if ([row[@"requested"] isKindOfClass:NSString.class]) lastRequested = [row[@"index"] integerValue];
    NSUInteger failed = 0, skipped = 0;
    for (NSDictionary *row in allRows) {
        if ([row[@"outcome"] isEqual:@"failed"]) failed++;
        if ([row[@"outcome"] isEqual:@"not-requested"] && [row[@"index"] integerValue] < lastRequested) skipped++;
    }
    check(written > 0 && stopError.length == 0 && failed == 0 && skipped == 0 && late == 0,
        [NSString stringWithFormat:@"the recording loses no still up to its last request (%d written, %lu failed, %lu not requested "
            "before still %ld, %d late, %@)", written, (unsigned long)failed, (unsigned long)skipped, (long)lastRequested, late, stopError]);
    // Every written still has a frame file of the declared format at the device-pixel size of the window, and the request times
    // of the written stills increase in still order. The pixels are evidence and are not judged.
    CGFloat scale = window.backingScaleFactor;
    uint32_t pixelWidth = (uint32_t)llround(window.frame.size.width * scale), pixelHeight = (uint32_t)llround(window.frame.size.height * scale);
    NSUInteger unreadable = 0, wrongSize = 0, unordered = 0;
    uint64_t previousRequest = 0;
    for (NSDictionary *row in rows) {
        NSData *frame = readCaptureFrame([NSData dataWithContentsOfFile:[directory stringByAppendingPathComponent:row[@"frame"]]]);
        uint32_t dimensions[3] = {0, 0, 0};
        if (frame.length >= kCaptureFrameHeader) [frame getBytes:dimensions length:sizeof dimensions];
        if (frame == nil) unreadable++;
        else if (dimensions[0] != pixelWidth || dimensions[1] != pixelHeight) wrongSize++;
        uint64_t requested = strtoull([row[@"requested"] UTF8String], NULL, 10);
        if (previousRequest != 0 && requested <= previousRequest) unordered++;
        previousRequest = requested;
    }
    check(unreadable == 0 && wrongSize == 0, [NSString stringWithFormat:@"every written still has a frame file of the window's "
        "device-pixel size (%lu unreadable, %lu of another size, window %ux%u)", (unsigned long)unreadable, (unsigned long)wrongSize,
        pixelWidth, pixelHeight]);
    check(unordered == 0, [NSString stringWithFormat:@"the request times of the written stills increase in still order (%lu do not)",
        (unsigned long)unordered]);
    [driver release];

    [window close]; [view release]; [window release];
    check(!NSApp.isActive, @"the control test does not activate the application");
    // The frames, stills.jsonl and the colour profile of a failing check are its evidence.
    if (failures) keepTemporaryFolder(directory);
    fprintf(stderr, "%s: a recording of a presenting Metal window loses no still (%.1fms)\n",
        failures ? "FAIL" : "PASS", (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
