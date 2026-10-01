// 실제 5000ms 제한이 지난 뒤 도착한 종료 완료가 다음 녹화의 오류와 결과를 바꾸지 않고, 그 오류를 버리지 않고
// 진단 출력에 보고하는지 검사한다. 종료 완료는 고정 장치가 붙잡았다가 늦게 전달한다.
#import "../src/capture.m"

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
    captureSink = [[SPCapture alloc] init];
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

    // 다음 녹화는 오류 없이 진행 중이다.
    clearCaptureError();
    captureStream = (SCStream *)[NSObject new];
    FILE *log = tmpfile(); int saved = dup(STDERR_FILENO);
    BOOL redirected = log != NULL && saved >= 0 && dup2(fileno(log), STDERR_FILENO) >= 0;
    if (held.completion != nil) {
        held.completion([NSError errorWithDomain:@"capture.test" code:1
            userInfo:@{NSLocalizedDescriptionKey: @"fixture late stop failure"}]);
    }
    fflush(stderr);
    if (redirected) dup2(saved, STDERR_FILENO);
    check(redirected, @"the late completion diagnostic output is observable");
    check(strcmp(sp_capture_error(), "") == 0,
        [NSString stringWithFormat:@"a late stop completion leaves the later recording error unchanged (%s)", sp_capture_error()]);
    char observed[4096] = {0};
    if (log != NULL) { rewind(log); fread(observed, 1, sizeof observed - 1, log); fclose(log); }
    if (saved >= 0) close(saved);
    fprintf(stderr, "%s", observed);
    check(strstr(observed, "fixture late stop failure") != NULL, @"the late stop error is reported instead of discarded");
    [captureStream release]; captureStream = nil;
    [held release];
    fprintf(stderr, "%s: late stop completion isolation (%.1fms)\n", failures ? "FAIL" : "PASS",
        (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
