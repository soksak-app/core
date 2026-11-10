// Checks that a stop waits for a stop completion that arrives late and returns its result: the stop has no deadline, so the
// completion error belongs to the stopped recording and is reported to the diagnostic output. The fixture holds the stop
// completion and delivers it from another queue.
#import "../src/capture.m"
#import "support/records.h"
#import "support/temporary_folder.h"
#include <stdlib.h>

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

@interface HeldStopFixture : NSObject
@property (nonatomic, copy) void (^completion)(NSError *);
@end
@implementation HeldStopFixture
- (void)stopCaptureWithCompletionHandler:(void (^)(NSError *))completion {
    self.completion = completion;
    // The stop has handed its completion over and goes on to wait for it; the completion arrives on another queue.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
        self.completion([NSError errorWithDomain:@"capture.test" code:1
            userInfo:@{NSLocalizedDescriptionKey: @"fixture late stop failure"}]);
    });
}
@end

int main(void) { @autoreleasepool {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: late stop completion\n");
    captureSink = [[SPCapture alloc] init];
    captureSink.directory = temporaryFolder(@"soksak-capture-stop-late-");
    static int statuses[6];
    captureSink.statuses = statuses;
    // A callback at the stop boundary has already arrived, so the stop waits only for the stop completion.
    captureSink.latestCallbackSeen = YES;
    captureSink.latestCallbackDisplayTimePresent = YES;
    captureSink.latestCallbackDisplayTimeMachTicks = UINT64_MAX;
    captureWriter = dispatch_queue_create("capture.test.writer", DISPATCH_QUEUE_SERIAL);
    capturePending = dispatch_semaphore_create(kCapturePending);
    captureQueue = dispatch_queue_create("capture.test.samples", DISPATCH_QUEUE_SERIAL);
    captureStartDone = dispatch_semaphore_create(1);
    HeldStopFixture *held = [HeldStopFixture new];
    captureStream = (SCStream *)held;
    SPCaptureAttempt *attempt = [[SPCaptureAttempt alloc] init];
    attempt.session = @"capture-stop-late";
    attempt.startCompletionSeen = YES;
    objc_setAssociatedObject(held, &captureAttemptAssociationKey, attempt, OBJC_ASSOCIATION_RETAIN);
    clearCaptureError();
    NSString *observed = capturedRecords(^{ sp_capture_stop(0); });
    check(held.completion != nil, @"the stop returns after its late completion");
    check(strstr(sp_capture_error(), "fixture late stop failure") != NULL,
        [NSString stringWithFormat:@"the late stop error belongs to the stopped recording (%s)", sp_capture_error()]);
    check(strstr(sp_capture_error(), "within") == NULL, @"the stop reports no deadline");
    fprintf(stderr, "%s", observed.UTF8String);
    check([observed containsString:@"fixture late stop failure"], @"the late stop error is reported instead of discarded");
    [held release];
    [attempt release];
    fprintf(stderr, "%s: late stop completion (%.1fms)\n", failures ? "FAIL" : "PASS",
        (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
