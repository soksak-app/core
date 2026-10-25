// Checks that a stop completion that arrives after the real 5000 ms limit changes neither the error nor the result of the next recording, and that the error is reported
// to the diagnostic output instead of being dropped. The fixture holds the stop completion and delivers it late.
#import "../src/capture.m"
#import "support/records.h"
#include <errno.h>
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
- (void)stopCaptureWithCompletionHandler:(void (^)(NSError *))completion { self.completion = completion; }
@end

int main(void) { @autoreleasepool {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: late stop completion isolation\n");
    char directoryPath[] = "/tmp/soksak-capture-stop-late-XXXXXX";
    BOOL directoryCreated = mkdtemp(directoryPath) != NULL;
    check(directoryCreated, directoryCreated ? @"the late-stop capture directory is created" :
        [NSString stringWithFormat:@"the late-stop capture directory cannot be created: %s", strerror(errno)]);
    if (!directoryCreated) return 1;
    captureSink = [[SPCapture alloc] init];
    captureSink.directory = [NSString stringWithUTF8String:directoryPath];
    static int statuses[6];
    captureSink.statuses = statuses;
    captureWriter = dispatch_queue_create("capture.test.writer", DISPATCH_QUEUE_SERIAL);
    capturePending = dispatch_semaphore_create(kCapturePending);
    captureQueue = dispatch_queue_create("capture.test.samples", DISPATCH_QUEUE_SERIAL);
    captureStartDone = dispatch_semaphore_create(1);
    HeldStopFixture *held = [HeldStopFixture new];
    captureStream = (SCStream *)held;
    clearCaptureError();
    sp_capture_stop(0);
    check(strstr(sp_capture_error(), "did not complete within 5000ms") != NULL,
        @"the stop that outlives its deadline reports its timeout");
    check(held.completion != nil, @"the fixture holds the stop completion");

    // The next recording is in progress without an error.
    clearCaptureError();
    captureStream = (SCStream *)[NSObject new];
    NSString *observed = capturedRecords(^{
        if (held.completion != nil) {
            held.completion([NSError errorWithDomain:@"capture.test" code:1
                userInfo:@{NSLocalizedDescriptionKey: @"fixture late stop failure"}]);
        }
    });
    check(strcmp(sp_capture_error(), "") == 0,
        [NSString stringWithFormat:@"a late stop completion leaves the later recording error unchanged (%s)", sp_capture_error()]);
    fprintf(stderr, "%s", observed.UTF8String);
    check([observed containsString:@"fixture late stop failure"], @"the late stop error is reported instead of discarded");
    [captureStream release]; captureStream = nil;
    [held release];
    NSError *removeError = nil;
    check([[NSFileManager defaultManager] removeItemAtPath:captureSink.directory error:&removeError],
        [NSString stringWithFormat:@"the late-stop capture directory is removed (%@)", removeError]);
    fprintf(stderr, "%s: late stop completion isolation (%.1fms)\n", failures ? "FAIL" : "PASS",
        (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
