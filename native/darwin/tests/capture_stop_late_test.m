// Checks the two ends of a stop whose completion arrives late. A stop has no deadline: it waits for a completion that arrives
// later from another queue, and the completion error belongs to the stopped recording. A stop whose wait sp_capture_end_wait
// ended returns with that end, and its completion that arrives afterwards changes neither the error nor the result of the next
// recording. Both completion errors are reported to the diagnostic output instead of being dropped.
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
// Whether the fixture delivers the completion itself, from another queue; otherwise it holds it for the test.
@property (nonatomic) BOOL delivers;
@end
@implementation HeldStopFixture
- (void)stopCaptureWithCompletionHandler:(void (^)(NSError *))completion {
    self.completion = completion;
    if (!self.delivers) return;
    // The stop has handed its completion over and goes on to wait for it; the completion arrives on another queue.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
        self.completion([NSError errorWithDomain:@"capture.test" code:1
            userInfo:@{NSLocalizedDescriptionKey: @"fixture late stop failure"}]);
    });
}
@end

// Prepares a recording of held whose callback at the stop boundary has already arrived, so its stop waits only for the stop
// completion, and returns its attempt.
static SPCaptureAttempt *prepareStop(HeldStopFixture *held, NSString *session) {
    captureSink = [[SPCapture alloc] init];
    captureSink.directory = temporaryFolder(@"soksak-capture-stop-late-");
    static int statuses[6];
    memset(statuses, 0, sizeof(statuses));
    captureSink.statuses = statuses;
    captureSink.latestCallbackSeen = YES;
    captureSink.latestCallbackDisplayTimePresent = YES;
    captureSink.latestCallbackDisplayTimeMachTicks = UINT64_MAX;
    captureWriter = dispatch_queue_create("capture.test.writer", DISPATCH_QUEUE_SERIAL);
    capturePending = dispatch_semaphore_create(kCapturePending);
    captureQueue = dispatch_queue_create("capture.test.samples", DISPATCH_QUEUE_SERIAL);
    captureStartDone = dispatch_semaphore_create(1);
    captureStream = (SCStream *)held;
    SPCaptureAttempt *attempt = [[SPCaptureAttempt alloc] init];
    attempt.session = session;
    attempt.startCompletionSeen = YES;
    objc_setAssociatedObject(held, &captureAttemptAssociationKey, attempt, OBJC_ASSOCIATION_RETAIN);
    clearCaptureError();
    return attempt;
}

int main(void) { @autoreleasepool {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: late stop completion\n");
    // A stop without an end waits for the completion that arrives later.
    HeldStopFixture *delivered = [HeldStopFixture new];
    delivered.delivers = YES;
    SPCaptureAttempt *deliveredAttempt = prepareStop(delivered, @"capture-stop-late");
    NSString *observed = capturedRecords(^{ sp_capture_stop(0, 1); });
    check(delivered.completion != nil, @"the stop returns after its late completion");
    check(strstr(sp_capture_error(), "fixture late stop failure") != NULL,
        [NSString stringWithFormat:@"the late stop error belongs to the stopped recording (%s)", sp_capture_error()]);
    check(strstr(sp_capture_error(), "within") == NULL, @"the stop reports no deadline");
    fprintf(stderr, "%s", observed.UTF8String);
    check([observed containsString:@"fixture late stop failure"], @"the late stop error is reported instead of discarded");
    [delivered release];
    [deliveredAttempt release];

    // A stop whose wait ended returns with that end, and its later completion leaves the next recording unchanged.
    HeldStopFixture *held = [HeldStopFixture new];
    SPCaptureAttempt *attempt = prepareStop(held, @"capture-stop-late-ended");
    // The end comes before the stop waits, so the waits for the boundary and for the held completion end without a race.
    sp_capture_end_wait(2, "the fixture ended the stop");
    sp_capture_stop(0, 2);
    check(strstr(sp_capture_error(), "capture stop did not complete before the fixture ended the stop") != NULL,
        [NSString stringWithFormat:@"the stop whose wait ended reports that end (%s)", sp_capture_error()]);
    check(held.completion != nil, @"the fixture holds the stop completion");

    // The next recording is in progress without an error.
    clearCaptureError();
    captureStream = (SCStream *)[NSObject new];
    NSString *lateObserved = capturedRecords(^{
        if (held.completion != nil) {
            held.completion([NSError errorWithDomain:@"capture.test" code:1
                userInfo:@{NSLocalizedDescriptionKey: @"fixture late stop failure"}]);
        }
    });
    check(strcmp(sp_capture_error(), "") == 0,
        [NSString stringWithFormat:@"a late stop completion leaves the later recording error unchanged (%s)", sp_capture_error()]);
    fprintf(stderr, "%s", lateObserved.UTF8String);
    check([lateObserved containsString:@"fixture late stop failure"],
        @"the stop completion after the end of its wait is reported instead of discarded");
    [held release];
    [attempt release];
    fprintf(stderr, "%s: late stop completion (%.1fms)\n", failures ? "FAIL" : "PASS",
        (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
