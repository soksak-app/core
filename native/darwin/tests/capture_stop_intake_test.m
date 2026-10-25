// Verifies that the qualifying stop boundary seals sample intake before ScreenCaptureKit stop completes.
#import "../src/capture.m"
#import "support/records.h"
#include <errno.h>
#include <stdlib.h>

static int failures;
static CMSampleBufferRef stopSample;
static NSArray<NSDictionary *> *stopSampleEvents;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static CMSampleBufferRef idleSample(void) {
    CMSampleTimingInfo timing = {kCMTimeInvalid, kCMTimeZero, kCMTimeInvalid};
    CMSampleBufferRef result = NULL;
    if (CMSampleBufferCreate(NULL, NULL, true, NULL, NULL, NULL, 1, 1, &timing, 0, NULL, &result) != noErr
        || result == NULL) return NULL;
    CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(result, true);
    if (attachments == NULL || CFArrayGetCount(attachments) != 1) {
        CFRelease(result);
        return NULL;
    }
    CFMutableDictionaryRef fields = (CFMutableDictionaryRef)CFArrayGetValueAtIndex(attachments, 0);
    CFDictionarySetValue(fields, SCStreamFrameInfoStatus, @((int)SCFrameStatusIdle));
    return result;
}

@interface HeldStopFixture : NSObject
@property (nonatomic, copy) void (^completion)(NSError *);
@property (nonatomic) BOOL acceptingSamplesAtStopRequest;
@end

@implementation HeldStopFixture
- (void)stopCaptureWithCompletionHandler:(void (^)(NSError *))completion {
    self.acceptingSamplesAtStopRequest = captureAcceptingSamples;
    self.completion = completion;
    stopSampleEvents = capturedEvents(^{
        dispatch_sync(captureQueue, ^{
            [captureSink stream:(SCStream *)self didOutputSampleBuffer:stopSample ofType:SCStreamOutputTypeScreen];
        });
    });
    void (^reply)(NSError *) = [self.completion copy];
    self.completion = nil;
    reply(nil);
    [reply release];
}
@end

int main(void) { @autoreleasepool {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: capture stop seals sample intake at the boundary\n");
    char directoryPath[] = "/tmp/soksak-capture-stop-intake-XXXXXX";
    BOOL directoryCreated = mkdtemp(directoryPath) != NULL;
    check(directoryCreated, directoryCreated ? @"the stop-intake capture directory is created" :
        [NSString stringWithFormat:@"the stop-intake capture directory cannot be created: %s", strerror(errno)]);
    if (!directoryCreated) return 1;

    const int8_t policy[SP_CLASS_COUNT] = {SP_EVENT_DEBUG, SP_EVENT_ERROR, SP_EVENT_ERROR, SP_EVENT_ERROR, SP_EVENT_ERROR};
    check(sp_event_set_policy(policy), @"the test enables capture lifecycle events");
    captureSink = [[SPCapture alloc] init];
    captureSink.directory = [NSString stringWithUTF8String:directoryPath];
    static int statuses[6];
    captureSink.statuses = statuses;
    captureWriter = dispatch_queue_create("capture.stop-intake.writer", DISPATCH_QUEUE_SERIAL);
    capturePending = dispatch_semaphore_create(kCapturePending);
    captureQueue = dispatch_queue_create("capture.stop-intake.samples", DISPATCH_QUEUE_SERIAL);
    captureStartDone = dispatch_semaphore_create(1);
    sp_image_capture_match_begin(directoryPath, captureWriter);
    captureBefore = 0;
    captureAcceptingSamples = YES;
    captureResizing = NO;
    captureCaughtUp = NULL;
    captureStopAfter = 0;
    clearCaptureError();

    HeldStopFixture *stream = [HeldStopFixture new];
    [stream retain]; // sp_capture_stop consumes the captureStream ownership on return.
    captureStream = (SCStream *)stream;
    SPCaptureAttempt *attempt = [[SPCaptureAttempt alloc] init];
    attempt.session = @"capture-stop-intake";
    attempt.requestMachTicks = mach_absolute_time();
    mach_timebase_info_data_t timebase;
    mach_timebase_info(&timebase);
    attempt.timebase = timebase;
    attempt.startCompletionSeen = YES;
    objc_setAssociatedObject(stream, &captureAttemptAssociationKey, attempt, OBJC_ASSOCIATION_RETAIN);
    captureSink.latestCallbackSeen = YES;
    captureSink.latestCallbackStatusPresent = YES;
    captureSink.latestCallbackStatus = SCFrameStatusIdle;
    captureSink.latestCallbackDisplayTimePresent = YES;
    captureSink.latestCallbackDisplayTimeMachTicks = UINT64_MAX;
    stopSample = idleSample();
    check(stopSample != NULL, @"the post-boundary idle sample fixture is created");

    sp_capture_stop(0);
    // sp_capture_stop releases the sample queue after draining the stop transaction.
    captureQueue = NULL;

    check(!stream.acceptingSamplesAtStopRequest,
        @"sample intake is closed before the asynchronous stream stop is requested");
    check(captureSink.idle == 0 && captureSink.queued == 0 && captureSink.complete == 0
        && captureSink.written == 0 && captureSink.statuses[SCFrameStatusIdle] == 0
        && captureSink.callbackStatusTrace.count == 0,
        @"a callback during the held stop completion does not mutate counts, status, or writer output");
    NSDictionary *discarded = nil;
    for (NSDictionary *event in stopSampleEvents) {
        if ([event[@"name"] isEqual:@"native.capture.lifecycle"]
            && [event[@"fields"][@"phase"] isEqual:@"sample-discarded"]) discarded = event;
    }
    check([discarded[@"fields"][@"session"] isEqual:@"capture-stop-intake"]
        && [discarded[@"fields"][@"reason"] isEqual:@"sample-intake-closed"],
        @"the post-fence callback remains attributed to its attempt with the intake-closed reason");
    check(strcmp(sp_capture_error(), "") == 0, @"a discarded post-fence callback does not create a capture error");

    if (stopSample != NULL) CFRelease(stopSample);
    [attempt release];
    [stream release];
    captureStream = nil;
    if (captureStartDone != NULL) { dispatch_release(captureStartDone); captureStartDone = NULL; }
    if (capturePending != NULL) { dispatch_release(capturePending); capturePending = NULL; }
    if (captureWriter != NULL) { dispatch_release(captureWriter); captureWriter = NULL; }
    [captureSink release];
    captureSink = nil;
    NSError *removeError = nil;
    check([[NSFileManager defaultManager] removeItemAtPath:[NSString stringWithUTF8String:directoryPath] error:&removeError],
        [NSString stringWithFormat:@"the stop-intake capture directory is removed (%@)", removeError]);
    fprintf(stderr, "%s: capture stop sample intake (%.1fms)\n", failures ? "FAIL" : "PASS",
        (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
