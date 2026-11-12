// Compares actual CAMetalLayer drawable presentations with the exact pixel IDs that the stills of the window recording hold.
// The recording requests a still every half refresh, so each drawable, which the window shows for at least one refresh, falls in
// some still. It classifies only this controlled Metal capture path and does not activate the application.
#import <Cocoa/Cocoa.h>
#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>
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

// The seven RGB-cube corners have separated pixel values. Gray background and any value outside these exact
// threshold regions remain unknown instead of being assigned to a nearby frame ID.
static NSInteger pixelFrameID(uint8_t blue, uint8_t green, uint8_t red) {
    int bits[3];
    uint8_t values[] = {red, green, blue};
    for (int i = 0; i < 3; i++) {
        if (values[i] <= 48) bits[i] = 0;
        else if (values[i] >= 207) bits[i] = 1;
        else return -1;
    }
    for (NSUInteger i = 0; i < frameCount; i++) {
        if ((int)colors[i].red == bits[0] && (int)colors[i].green == bits[1] && (int)colors[i].blue == bits[2])
            return (NSInteger)i;
    }
    return -1;
}

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
    fprintf(stderr, "START: correlate actual Metal drawable presentation with captured window pixels\n");
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
    until(@"the window is visible", ^BOOL { return (window.occlusionState & NSWindowOcclusionStateVisible) != 0; });
    check(onScreen(window), @"the inactive control window is on screen");
    if (!onScreen(window)) { [window close]; [view release]; [window release]; return 1; }

    NSString *directory = temporaryFolder(@"soksak-capture-presentation-");
    char *operationError = NULL;
    BOOL opened = sp_capture_open(window.windowNumber, false, &operationError);
    check(opened, [NSString stringWithFormat:@"the control window opens for a recording (%s)", operationError ?: ""]);
    free(operationError); operationError = NULL;
    // Half the shortest refresh interval of the display: every drawable stays on screen for at least one refresh.
    double gap = MAX(1, window.screen.minimumRefreshInterval * 1000 / 2);
    BOOL started = opened && sp_capture_start(directory.fileSystemRepresentation, gap, 0, 4096, false, 1, &operationError);
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
            check([record[@"id"] unsignedIntegerValue] == i && [record[@"presentedTime"] doubleValue] > 0,
                [NSString stringWithFormat:@"drawable %lu has a nonzero actual presentation time (%@)", (unsigned long)i, record]);
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
    int written = sp_capture_stop(lastPresented > 0 ? lastPresented : sp_capture_clock(), 2);
    NSString *stopError = [NSString stringWithUTF8String:sp_capture_error()];
    check(written > 0 && stopError.length == 0 && sp_capture_missed() == 0,
        [NSString stringWithFormat:@"the recording writes every still it requested (%d written, %d missed, %@)", written,
            sp_capture_missed(), stopError]);
    NSString *rowsText = [NSString stringWithContentsOfFile:[directory stringByAppendingPathComponent:@"stills.jsonl"]
        encoding:NSUTF8StringEncoding error:NULL];
    NSMutableArray<NSDictionary *> *rows = [NSMutableArray array];
    for (NSString *line in [rowsText componentsSeparatedByString:@"\n"]) {
        if (line.length == 0) continue;
        NSDictionary *row = [NSJSONSerialization JSONObjectWithData:[line dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL];
        if ([row[@"outcome"] isEqual:@"written"]) [rows addObject:row];
    }
    // The pixel ID at the centre of each written still, in the order of the requests.
    NSMutableArray<NSNumber *> *stillIDs = [NSMutableArray array];
    NSMutableArray<NSString *> *stillErrors = [NSMutableArray array];
    for (NSDictionary *row in rows) {
        NSData *frame = readCaptureFrame([NSData dataWithContentsOfFile:[directory stringByAppendingPathComponent:row[@"frame"]]]);
        uint32_t dimensions[3] = {0, 0, 0};
        if (frame.length >= kCaptureFrameHeader) [frame getBytes:dimensions length:sizeof dimensions];
        if (frame == nil || dimensions[0] == 0 || dimensions[1] == 0) {
            [stillErrors addObject:[NSString stringWithFormat:@"%@ has no readable pixels", row[@"frame"]]];
            [stillIDs addObject:@(-1)];
            continue;
        }
        const uint8_t *center = (const uint8_t *)frame.bytes + kCaptureFrameHeader + (dimensions[1] / 2) * dimensions[2]
            + (dimensions[0] / 2) * 4;
        [stillIDs addObject:@(pixelFrameID(center[0], center[1], center[2]))];
    }
    check([stillIDs containsObject:@(frameCount - 1)],
        [NSString stringWithFormat:@"the recording observes the final exact pixel ID (%lu written stills)", (unsigned long)rows.count]);

    mach_timebase_info_data_t timebase = {0};
    kern_return_t timebaseResult = mach_timebase_info(&timebase);
    check(timebaseResult == KERN_SUCCESS && timebase.numer > 0 && timebase.denom > 0,
        [NSString stringWithFormat:@"the runtime mach timebase is valid (%u/%u, result %d)", timebase.numer, timebase.denom, timebaseResult]);
    if (timebaseResult == KERN_SUCCESS && timebase.numer > 0 && timebase.denom > 0
        && driver.completedPresentationCount == frameCount) {
        uint64_t presentationTicks[7] = {0};
        BOOL clockValuesValid = YES;
        BOOL presentationOrderValid = YES;
        uint64_t previousPresentation = 0;
        for (NSUInteger i = 0; i < frameCount; i++) {
            NSDictionary *record = driver.presentations[i];
            double presentedTime = [record[@"presentedTime"] doubleValue];
            if (presentedTime == 0) { clockValuesValid = NO; continue; }
            long double ticks = (long double)presentedTime * 1000000000.0L
                * (long double)timebase.denom / (long double)timebase.numer;
            if (!isfinite((double)ticks) || ticks <= 0 || ticks > (long double)LLONG_MAX) {
                clockValuesValid = NO;
                continue;
            }
            presentationTicks[i] = (uint64_t)llroundl(ticks);
            if (previousPresentation > 0 && presentationTicks[i] <= previousPresentation) presentationOrderValid = NO;
            previousPresentation = presentationTicks[i];
        }
        BOOL everyPresented = clockValuesValid && presentationOrderValid;
        check(everyPresented, @"every exact drawable ID has an actual non-skipped presentation time in presentation order");
        {
            uint64_t largestPresentationGap = 0, largestCaptureGap = 0;
            for (NSUInteger i = 1; i < frameCount; i++)
                if (presentationTicks[i] > 0 && presentationTicks[i - 1] > 0)
                    largestPresentationGap = MAX(largestPresentationGap, presentationTicks[i] - presentationTicks[i - 1]);
            NSMutableArray<NSNumber *> *captureIDs = [NSMutableArray array];
            uint64_t previousRequest = 0;
            for (NSString *failure in stillErrors)
                check(NO, [NSString stringWithFormat:@"every written still has observable pixels (%@)", failure]);
            BOOL sawMarker = NO;
            NSInteger previousCaptureID = -1;
            for (NSUInteger index = 0; index < rows.count; index++) {
                NSDictionary *row = rows[index];
                NSInteger frameID = stillIDs[index].integerValue;
                uint64_t requested = strtoull([row[@"requested"] UTF8String], NULL, 10);
                uint64_t completed = strtoull([row[@"completed"] UTF8String], NULL, 10);
                if (frameID < 0) {
                    if (sawMarker) check(NO, @"a still after the first marker has a recognized exact ID");
                    fprintf(stdout, "CAPTURE id=unknown still=%ld requested=%llu completed=%llu\n", [row[@"index"] longValue], requested, completed);
                    continue;
                }
                sawMarker = YES;
                if (frameID < previousCaptureID)
                    check(NO, @"captured pixel IDs remain in their submitted order in the order of the requests");
                BOOL repeatedPixel = [captureIDs containsObject:@(frameID)];
                previousCaptureID = frameID;
                uint64_t expectedPresentation = presentationTicks[frameID];
                if (expectedPresentation == 0)
                    check(NO, [NSString stringWithFormat:@"captured pixel ID %ld has an actual presentation timestamp", (long)frameID]);
                if (previousRequest != 0) {
                    check(requested > previousRequest, @"the request times of the written stills increase in still order");
                    if (requested > previousRequest) largestCaptureGap = MAX(largestCaptureGap, requested - previousRequest);
                }
                previousRequest = requested;
                [captureIDs addObject:@(frameID)];
                // The still showed its pixels at some time between its request and its completion, and the window showed drawable n
                // from its presentation until the presentation of drawable n + 1: the two intervals meet.
                uint64_t nextPresentation = (NSUInteger)frameID + 1 < frameCount ? presentationTicks[frameID + 1] : 0;
                check(expectedPresentation == 0 || (completed >= expectedPresentation
                        && (nextPresentation == 0 || requested < nextPresentation)),
                    [NSString stringWithFormat:@"the still that holds drawable %ld was taken while the window showed it", (long)frameID]);
                int64_t requestSkew = (int64_t)requested - (int64_t)expectedPresentation;
                int64_t completionSkew = (int64_t)completed - (int64_t)expectedPresentation;
                fprintf(stdout, "CAPTURE id=%ld repeated-pixel=%d still=%ld requested=%llu completed=%llu presentation=%llu "
                    "requested-minus-present=%.6fms completed-minus-present=%.6fms\n",
                    (long)frameID, repeatedPixel, [row[@"index"] longValue], requested, completed, expectedPresentation,
                    (double)((long double)requestSkew * timebase.numer / timebase.denom / 1000000.0L),
                    (double)((long double)completionSkew * timebase.numer / timebase.denom / 1000000.0L));
            }
            NSMutableArray<NSNumber *> *missing = [NSMutableArray array];
            for (NSUInteger i = 0; i < frameCount; i++) if (![captureIDs containsObject:@(i)]) [missing addObject:@(i)];
            check(missing.count == 0, [NSString stringWithFormat:@"all unique presented pixel IDs have a captured still (missing %@)", missing]);
            double presentationGapMS = (double)((long double)largestPresentationGap * timebase.numer / timebase.denom / 1000000.0L);
            double captureGapMS = (double)((long double)largestCaptureGap * timebase.numer / timebase.denom / 1000000.0L);
            fprintf(stdout, "CLASSIFICATION max-presented-gap=%.6fms max-captured-gap=%.6fms missing-captured-ids=%s timebase=%u/%u\n",
                presentationGapMS, captureGapMS, missing.description.UTF8String, timebase.numer, timebase.denom);
            if (!everyPresented || missing.count > 0) fprintf(stdout, "RESULT: incomplete evidence; skipped drawable or missing pixel ID prevents cadence classification\n");
            else if (presentationGapMS > 33.0) fprintf(stdout, "RESULT: controlled drawable presentation gap exceeds 33ms\n");
            else if (captureGapMS > 33.0 || missing.count > 0)
                fprintf(stdout, "RESULT: controlled presented pixels are missing or spaced by the still requests\n");
            else fprintf(stdout, "RESULT: no 33ms gap reproduced in the controlled Metal capture path\n");
        }
    }
    [driver release];

    [window close]; [view release]; [window release];
    check(!NSApp.isActive, @"the control test does not activate the application");
    fprintf(stderr, "%s: correlate actual Metal drawable presentation with captured window pixels (%.1fms)\n",
        failures ? "FAIL" : "PASS", (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
