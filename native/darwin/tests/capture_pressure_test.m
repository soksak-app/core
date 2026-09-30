// 실제 샘플 처리기에 큐 용량과 파일 쓰기 결함을 주입한다. 캡처 내부 상태는 소유 검사에서만 접근한다.
#import "../src/capture.m"

static int failures;
static void check(BOOL ok, NSString *label) {
    fprintf(ok ? stdout : stderr, "%s: %s\n", ok ? "PASS" : "FAIL", label.UTF8String);
    if (!ok) failures++;
}

@interface CaptureStopFixture : NSObject
@end
@implementation CaptureStopFixture
- (void)stopCaptureWithCompletionHandler:(void (^)(NSError *))completion {
    completion([NSError errorWithDomain:@"capture.test" code:1
        userInfo:@{NSLocalizedDescriptionKey: @"fixture stop failure"}]);
}
@end

static CMSampleBufferRef sample(void) {
    CVPixelBufferRef pixels = NULL;
    check(CVPixelBufferCreate(NULL, 4, 4, kCVPixelFormatType_32BGRA, NULL, &pixels) == kCVReturnSuccess,
        @"the controlled sample has a pixel buffer");
    CMVideoFormatDescriptionRef format = NULL;
    check(CMVideoFormatDescriptionCreateForImageBuffer(NULL, pixels, &format) == noErr,
        @"the controlled sample has an image format");
    CMSampleTimingInfo timing = { kCMTimeInvalid, kCMTimeZero, kCMTimeInvalid };
    CMSampleBufferRef result = NULL;
    check(CMSampleBufferCreateReadyWithImageBuffer(NULL, pixels, format, &timing, &result) == noErr,
        @"the controlled sample is ready");
    CFMutableDictionaryRef attachments = (CFMutableDictionaryRef)CFArrayGetValueAtIndex(
        CMSampleBufferGetSampleAttachmentsArray(result, true), 0);
    NSDictionary *metadata = @{
        SCStreamFrameInfoStatus: @(SCFrameStatusComplete),
        SCStreamFrameInfoDisplayTime: @(mach_absolute_time()),
        SCStreamFrameInfoScaleFactor: @1, SCStreamFrameInfoContentScale: @1,
        SCStreamFrameInfoContentRect: (NSDictionary *)[(__bridge NSDictionary *)
            CGRectCreateDictionaryRepresentation(CGRectMake(0, 0, 4, 4)) autorelease],
    };
    for (NSString *key in metadata) CFDictionarySetValue(attachments, key, metadata[key]);
    CFRelease(format); CVPixelBufferRelease(pixels);
    return result;
}

static void reset(NSString *directory, long capacity) {
    clearCaptureError();
    captureBefore = 0; captureStartedAt = 0; captureLimitReached = false;
    [captureSink release]; captureSink = [SPCapture new];
    captureSink.directory = directory;
    static int counts[6]; memset(counts, 0, sizeof counts); captureSink.statuses = counts;
    if (capturePending) dispatch_release(capturePending);
    capturePending = dispatch_semaphore_create(capacity);
    if (captureFirstFrame) dispatch_release(captureFirstFrame);
    captureFirstFrame = dispatch_semaphore_create(0);
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    char path[] = "/tmp/soksak-capture-pressure-XXXXXX";
    check(mkdtemp(path) != NULL, @"a private fault-injection directory is created");
    NSString *directory = [NSString stringWithUTF8String:path];
    captureWriter = dispatch_queue_create("capture.test.writer", DISPATCH_QUEUE_SERIAL);
    CMSampleBufferRef frame = sample();
    reset(directory, 0);
    dispatch_semaphore_t completed = dispatch_semaphore_create(0);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        [captureSink write:frame]; dispatch_semaphore_signal(completed);
    });
    BOOL finished = dispatch_semaphore_wait(completed, dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC)) == 0;
    check(finished, @"exhausted writer capacity never blocks the sample callback");
    // 잘못된 대기를 재현해도 테스트 큐를 해제해서 뒤의 검사를 실행한다.
    dispatch_semaphore_signal(capturePending);
    if (!finished) check(dispatch_semaphore_wait(completed, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC)) == 0,
        @"the blocked Red callback is released for cleanup");
    dispatch_sync(captureWriter, ^{});
    check(strstr(sp_capture_error(), "pending") != NULL,
        @"exhausted writer capacity reports an explicit recording error");
    check(captureSink.queued == 0 && captureSink.written == 0,
        @"an exhausted recording does not accept a delayed frame");
    dispatch_release(completed);

    reset(directory, 1);
    [captureSink write:frame]; dispatch_sync(captureWriter, ^{});
    check(strlen(sp_capture_error()) == 0 && captureSink.queued == 1 && captureSink.written == 1,
        @"available writer capacity preserves a complete frame");

    captureStream = (SCStream *)[NSObject new];
    check(sp_capture_wait() == 1,
        @"a written first frame without recording errors is ready");
    [captureStream release]; captureStream = nil;

    reset(directory, 1);
    [captureSink write:frame]; dispatch_sync(captureWriter, ^{});
    captureStream = (SCStream *)[NSObject new];
    [captureSink stream:captureStream didStopWithError:
        [NSError errorWithDomain:@"capture.test" code:2
            userInfo:@{NSLocalizedDescriptionKey: @"fixture ready stream failure"}]];
    check(captureSink.written == 1,
        @"the stream-error readiness fixture retains a complete first frame");
    check(sp_capture_wait() == 0,
        @"a known stream failure rejects a written first frame readiness");
    check(strstr(sp_capture_error(), "fixture ready stream failure") != NULL,
        @"first-frame readiness preserves the original stream failure");
    [captureStream release]; captureStream = nil;

    reset(directory, 1);
    [captureSink write:frame]; dispatch_sync(captureWriter, ^{});
    captureStream = (SCStream *)[NSObject new];
    // 비동기 시작 완료가 기록하는 동일한 오류 경계를 첫 프레임 뒤에 주입한다.
    setCaptureError(@"capture did not start: fixture asynchronous start failure");
    check(sp_capture_wait() == 0,
        @"a known asynchronous start failure rejects written first frame readiness");
    check(strstr(sp_capture_error(), "fixture asynchronous start failure") != NULL,
        @"first-frame readiness preserves the asynchronous start failure");
    [captureStream release]; captureStream = nil;

    reset([directory stringByAppendingPathComponent:@"missing"], 1);
    [captureSink write:frame]; dispatch_sync(captureWriter, ^{});
    check(strstr(sp_capture_error(), "not written") != NULL,
        @"the controlled file-write failure is observable before stop");
    captureStream = (SCStream *)[CaptureStopFixture new];
    captureQueue = dispatch_queue_create("capture.test.samples", DISPATCH_QUEUE_SERIAL);
    sp_capture_stop(0);
    check(strstr(sp_capture_error(), "not written") != NULL,
        @"stop preserves the earlier recording write error");
    check(strstr(sp_capture_error(), "no frame arrived") != NULL,
        @"stop also reports its separate delivery deadline error");
    check(strstr(sp_capture_error(), "fixture stop failure") != NULL,
        @"stop reports the stream completion error alongside earlier failures");
    CFRelease(frame);
    NSError *error = nil;
    check([[NSFileManager defaultManager] removeItemAtPath:directory error:&error],
        [NSString stringWithFormat:@"fault-injection files are removed (%@)", error]);
    return failures ? 1 : 0;
}}
