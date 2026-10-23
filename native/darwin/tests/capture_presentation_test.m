// Compares actual CAMetalLayer drawable presentations with the exact pixel IDs and display times returned by a window-filtered ScreenCaptureKit stream.
// It classifies only this controlled Metal capture path and does not activate the application.
#import <Cocoa/Cocoa.h>
#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <mach/mach_time.h>
#include <math.h>
#include <limits.h>
#include <signal.h>
#include <unistd.h>

static const NSUInteger frameCount = 7;
static int failures;
static void check(BOOL ok, NSString *label) {
    fprintf(ok ? stdout : stderr, "%s: %s\n", ok ? "PASS" : "FAIL", label.UTF8String);
    if (!ok) failures++;
}
static void expired(int signalNumber) {
    (void)signalNumber;
    const char message[] = "FAIL: capture presentation test exceeded 30000ms\n";
    write(STDERR_FILENO, message, sizeof message - 1);
    _exit(1);
}
static void spinUntil(BOOL (^condition)(void), NSTimeInterval seconds) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (!condition() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:
            [NSDate dateWithTimeIntervalSinceNow:MIN(0.005, deadline.timeIntervalSinceNow)]];
    }
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

@interface SPCapturedFrame : NSObject
@property(nonatomic) NSInteger frameID;
@property(nonatomic) SCFrameStatus status;
@property(nonatomic) uint64_t displayTime;
@property(nonatomic) uint64_t callbackTime;
@property(nonatomic, copy) NSString *error;
@end
@implementation SPCapturedFrame
- (void)dealloc { [_error release]; [super dealloc]; }
@end

@interface SPCaptureOutput : NSObject <SCStreamOutput>
@property(nonatomic, retain) NSMutableArray<SPCapturedFrame *> *frames;
@property(nonatomic, retain) NSCondition *condition;
- (BOOL)containsFrame:(NSUInteger)frameID;
@end
@implementation SPCaptureOutput
- (instancetype)init {
    self = [super init];
    if (self) { _frames = [NSMutableArray new]; _condition = [NSCondition new]; }
    return self;
}
- (BOOL)containsFrame:(NSUInteger)frameID {
    [self.condition lock];
    BOOL found = NO;
    for (SPCapturedFrame *frame in self.frames) if (frame.frameID == (NSInteger)frameID) { found = YES; break; }
    [self.condition unlock];
    return found;
}
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer ofType:(SCStreamOutputType)type {
    (void)stream;
    SPCapturedFrame *record = [SPCapturedFrame new];
    record.frameID = -1;
    record.status = (SCFrameStatus)-1;
    record.callbackTime = mach_absolute_time();
    if (type != SCStreamOutputTypeScreen) record.error = [NSString stringWithFormat:@"unexpected stream output type %ld", (long)type];
    if (!CMSampleBufferIsValid(sampleBuffer)) record.error = @"stream output sample is invalid";
    CFArrayRef attachments = record.error == nil ? CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, false) : NULL;
    CFDictionaryRef metadata = attachments != NULL && CFArrayGetCount(attachments) > 0
        ? (CFDictionaryRef)CFArrayGetValueAtIndex(attachments, 0) : NULL;
    NSNumber *status = metadata == NULL ? nil : (id)CFDictionaryGetValue(metadata, SCStreamFrameInfoStatus);
    NSNumber *displayTime = metadata == NULL ? nil : (id)CFDictionaryGetValue(metadata, SCStreamFrameInfoDisplayTime);
    if (status != nil) record.status = (SCFrameStatus)status.integerValue;
    if (displayTime != nil && displayTime.unsignedLongLongValue > 0) record.displayTime = displayTime.unsignedLongLongValue;
    if (record.error == nil && status == nil) record.error = @"sample has no frame status";
    if (record.status == SCFrameStatusComplete) {
        CVPixelBufferRef pixels = CMSampleBufferGetImageBuffer(sampleBuffer);
        if (record.displayTime == 0) record.error = @"complete sample has no positive display time";
        if (pixels != NULL && record.error == nil) {
            CVReturn locked = CVPixelBufferLockBaseAddress(pixels, kCVPixelBufferLock_ReadOnly);
            if (locked == kCVReturnSuccess) {
                size_t width = CVPixelBufferGetWidth(pixels), height = CVPixelBufferGetHeight(pixels);
                size_t stride = CVPixelBufferGetBytesPerRow(pixels);
                uint8_t *base = CVPixelBufferGetBaseAddress(pixels);
                if (base != NULL && width > 0 && height > 0 && stride >= width * 4) {
                    uint8_t *center = base + (height / 2) * stride + (width / 2) * 4;
                    record.frameID = pixelFrameID(center[0], center[1], center[2]);
                } else record.error = [NSString stringWithFormat:@"invalid pixel buffer layout (%zux%zu stride %zu)", width, height, stride];
                CVReturn unlocked = CVPixelBufferUnlockBaseAddress(pixels, kCVPixelBufferLock_ReadOnly);
                if (unlocked != kCVReturnSuccess) record.error = [NSString stringWithFormat:@"pixel-buffer unlock failed (%d)", unlocked];
            } else record.error = [NSString stringWithFormat:@"pixel-buffer lock failed (%d)", locked];
        } else if (pixels == NULL && record.error == nil) record.error = @"complete sample has no pixel buffer";
    }
    [self.condition lock];
    [self.frames addObject:record];
    [self.condition broadcast];
    [self.condition unlock];
    [record release];
}
- (void)dealloc { [_frames release]; [_condition release]; [super dealloc]; }
@end

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
    signal(SIGALRM, expired); alarm(30);
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
    view.wantsLayer = YES;
    CAMetalLayer *layer = [CAMetalLayer layer];
    layer.device = device;
    layer.pixelFormat = MTLPixelFormatBGRA8Unorm;
    layer.framebufferOnly = YES;
    layer.contentsScale = window.backingScaleFactor;
    layer.frame = view.bounds;
    layer.drawableSize = CGSizeMake(view.bounds.size.width * layer.contentsScale, view.bounds.size.height * layer.contentsScale);
    layer.backgroundColor = [NSColor colorWithWhite:0.35 alpha:1].CGColor;
    view.layer = layer;
    [window.contentView addSubview:view];
    [window orderFrontRegardless];
    spinUntil(^BOOL { return onScreen(window); }, 10);
    check(onScreen(window), @"the inactive control window is on screen");
    if (!onScreen(window)) { [window close]; [view release]; [window release]; return 1; }

    __block SCShareableContent *content = nil;
    __block NSError *queryError = nil;
    dispatch_semaphore_t queried = dispatch_semaphore_create(0);
    [SCShareableContent getCurrentProcessShareableContentWithCompletionHandler:^(SCShareableContent *value, NSError *error) {
        content = [value retain]; queryError = [error retain]; dispatch_semaphore_signal(queried);
    }];
    long queryWait = dispatch_semaphore_wait(queried, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC));
    dispatch_release(queried);
    SCWindow *target = nil;
    if (queryWait == 0 && queryError == nil) for (SCWindow *candidate in content.windows)
        if (candidate.windowID == (CGWindowID)window.windowNumber) { target = candidate; break; }
    check(target != nil, [NSString stringWithFormat:@"ScreenCaptureKit finds the control window (%@)", queryError]);
    if (target == nil) { [queryError release]; [content release]; [window close]; [view release]; [window release]; return 1; }

    SCContentFilter *filter = [[[SCContentFilter alloc] initWithDesktopIndependentWindow:target] autorelease];
    SCStreamConfiguration *configuration = [[[SCStreamConfiguration alloc] init] autorelease];
    configuration.width = (size_t)(filter.contentRect.size.width * filter.pointPixelScale);
    configuration.height = (size_t)(filter.contentRect.size.height * filter.pointPixelScale);
    configuration.pixelFormat = kCVPixelFormatType_32BGRA;
    configuration.colorSpaceName = kCGColorSpaceSRGB;
    configuration.showsCursor = NO;
    configuration.minimumFrameInterval = CMTimeMake(1, 120);
    configuration.queueDepth = 8;
    SCStream *stream = [[SCStream alloc] initWithFilter:filter configuration:configuration delegate:nil];
    SPCaptureOutput *output = [SPCaptureOutput new];
    dispatch_queue_t callbackQueue = dispatch_queue_create("soksak.capture.presentation.test", DISPATCH_QUEUE_SERIAL);
    NSError *operationError = nil;
    BOOL added = [stream addStreamOutput:output type:SCStreamOutputTypeScreen sampleHandlerQueue:callbackQueue error:&operationError];
    dispatch_semaphore_t started = NULL;
    __block NSError *startError = nil;
    check(added, [NSString stringWithFormat:@"the window stream registers its output (%@)", operationError]);
    if (!added) goto cleanup;
    started = dispatch_semaphore_create(0);
    [stream startCaptureWithCompletionHandler:^(NSError *error) { startError = [error retain]; dispatch_semaphore_signal(started); }];
    long startWait = dispatch_semaphore_wait(started, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC));
    dispatch_release(started);
    check(startWait == 0 && startError == nil, [NSString stringWithFormat:@"the window stream starts (%@)", startError]);
    if (startWait != 0 || startError != nil) { [startError release]; goto cleanup; }
    [startError release];

    SPMetalFrames *driver = [SPMetalFrames new];
    driver.layer = layer;
    id<MTLCommandQueue> commandQueue = [device newCommandQueue];
    check(commandQueue != nil, @"the Metal command queue is created");
    driver.queue = commandQueue;
    [commandQueue release];
    [driver submitNext];
    spinUntil(^BOOL { return driver.completedPresentationCount == frameCount; }, 10);
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
    spinUntil(^BOOL { return [output containsFrame:frameCount - 1]; }, 10);
    check([output containsFrame:frameCount - 1], @"the capture stream observes the final exact pixel ID");

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
            uint64_t previousCaptureTime = 0;
            [output.condition lock];
            NSArray<SPCapturedFrame *> *capturedFrames = [output.frames copy];
            [output.condition unlock];
            BOOL sawMarker = NO;
            NSInteger previousCaptureID = -1;
            for (SPCapturedFrame *record in capturedFrames) {
                if (record.error != nil) {
                    check(NO, [NSString stringWithFormat:@"capture callback metadata and pixels are observable (%@)", record.error]);
                    continue;
                }
                if (record.status != SCFrameStatusComplete) continue;
                if (record.frameID < 0) {
                    if (sawMarker) check(NO, @"a complete captured pixel after the first marker has a recognized exact ID");
                    fprintf(stdout, "CAPTURE id=unknown display=%llu status=%ld callback=%llu\n",
                        record.displayTime, (long)record.status, record.callbackTime);
                    continue;
                }
                sawMarker = YES;
                if (record.frameID < previousCaptureID)
                    check(NO, @"captured pixel IDs remain in their submitted order without sorting");
                BOOL repeatedPixel = [captureIDs containsObject:@(record.frameID)];
                previousCaptureID = record.frameID;
                uint64_t expectedPresentation = presentationTicks[record.frameID];
                if (expectedPresentation == 0)
                    check(NO, [NSString stringWithFormat:@"captured pixel ID %ld has an actual presentation timestamp", (long)record.frameID]);
                if (previousCaptureTime != 0) {
                    check(record.displayTime > previousCaptureTime,
                        @"captured `displayTime` increases in callback order without sorting");
                    if (record.displayTime > previousCaptureTime)
                        largestCaptureGap = MAX(largestCaptureGap, record.displayTime - previousCaptureTime);
                }
                previousCaptureTime = record.displayTime;
                [captureIDs addObject:@(record.frameID)];
                int64_t skew = record.displayTime >= expectedPresentation
                    ? (int64_t)(record.displayTime - expectedPresentation) : -(int64_t)(expectedPresentation - record.displayTime);
                double skewMS = (double)((long double)skew * timebase.numer / timebase.denom / 1000000.0L);
                fprintf(stdout, "CAPTURE id=%ld repeated-pixel=%d display=%llu callback=%llu presentation=%llu display-minus-present=%lldticks %.6fms\n",
                    (long)record.frameID, repeatedPixel,
                    record.displayTime, record.callbackTime, expectedPresentation,
                    (long long)skew, skewMS);
            }
            [capturedFrames release];
            NSMutableArray<NSNumber *> *missing = [NSMutableArray array];
            for (NSUInteger i = 0; i < frameCount; i++) if (![captureIDs containsObject:@(i)]) [missing addObject:@(i)];
            check(missing.count == 0, [NSString stringWithFormat:@"all unique presented pixel IDs have a captured sample (missing %@)", missing]);
            double presentationGapMS = (double)((long double)largestPresentationGap * timebase.numer / timebase.denom / 1000000.0L);
            double captureGapMS = (double)((long double)largestCaptureGap * timebase.numer / timebase.denom / 1000000.0L);
            fprintf(stdout, "CLASSIFICATION max-presented-gap=%.6fms max-captured-gap=%.6fms missing-captured-ids=%s timebase=%u/%u\n",
                presentationGapMS, captureGapMS, missing.description.UTF8String, timebase.numer, timebase.denom);
            if (!everyPresented || missing.count > 0) fprintf(stdout, "RESULT: incomplete evidence; skipped drawable or missing pixel ID prevents cadence classification\n");
            else if (presentationGapMS > 33.0) fprintf(stdout, "RESULT: controlled drawable presentation gap exceeds 33ms\n");
            else if (captureGapMS > 33.0 || missing.count > 0)
                fprintf(stdout, "RESULT: controlled presented pixels are missing or spaced by the capture path\n");
            else fprintf(stdout, "RESULT: no 33ms gap reproduced in the controlled Metal capture path\n");
        }
    }
    [driver release];

cleanup:
    if (stream != nil) {
        dispatch_semaphore_t stopped = dispatch_semaphore_create(0);
        __block NSError *stopError = nil;
        [stream stopCaptureWithCompletionHandler:^(NSError *error) { stopError = [error retain]; dispatch_semaphore_signal(stopped); }];
        long stopWait = dispatch_semaphore_wait(stopped, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC));
        dispatch_release(stopped);
        check(stopWait == 0 && stopError == nil, [NSString stringWithFormat:@"the window stream stops (%@)", stopError]);
        [stopError release];
    }
    if (callbackQueue != NULL) dispatch_release(callbackQueue);
    [stream release]; [output release]; [queryError release]; [content release];
    [window close]; [view release]; [window release];
    check(!NSApp.isActive, @"the control test does not activate the application");
    fprintf(stderr, "%s: correlate actual Metal drawable presentation with captured window pixels (%.1fms)\n",
        failures ? "FAIL" : "PASS", (CACurrentMediaTime() - began) * 1000);
    alarm(0);
    return failures ? 1 : 0;
}}
