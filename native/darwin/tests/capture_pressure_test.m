// 실제 샘플 처리기에 큐 용량과 파일 쓰기 결함을 주입한다. 캡처 내부 상태는 소유 검사에서만 접근한다.
#import "../src/capture.m"
#import <objc/runtime.h>

static int failures;
static void check(BOOL ok, NSString *label) {
    fprintf(ok ? stdout : stderr, "%s: %s\n", ok ? "PASS" : "FAIL", label.UTF8String);
    if (!ok) failures++;
}

// 실제 10초 제한 뒤 콜백을 전달하여 호출별 상태의 수명을 확인한다.
static void (^heldStillReply)(SCShareableContent *, NSError *);
static void holdStillQuery(id receiver, SEL selector, void (^reply)(SCShareableContent *, NSError *)) {
    heldStillReply = [reply copy];
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
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: capture pressure and still-result isolation\n");
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

    reset(directory, 1);
    [captureSink write:frame]; dispatch_sync(captureWriter, ^{});
    captureStream = (SCStream *)[NSObject new];
    setCaptureError(@"fixture active recording failure");
    char *stillError = NULL;
    check(!sp_capture_still(-1, NULL, &stillError), @"a null still path is rejected during recording");
    check(strstr(sp_capture_error(), "fixture active recording failure") != NULL,
        @"a failed still request preserves the existing recording error");
    check(stillError != NULL && strstr(stillError, "needs a path") != NULL,
        @"the still call returns its own path failure");
    free(stillError); stillError = NULL;
    [captureStream release]; captureStream = nil;

    reset(directory, 1);
    [captureSink write:frame]; dispatch_sync(captureWriter, ^{});
    captureStream = (SCStream *)[NSObject new];
    NSString *stillPath = [directory stringByAppendingPathComponent:@"invalid-window.png"];
    check(!sp_capture_still(-1, stillPath.UTF8String, &stillError),
        @"an asynchronous invalid-window still capture is rejected");
    check(sp_capture_wait() == 1,
        @"an unrelated asynchronous still failure preserves healthy recording readiness");
    [captureStream release]; captureStream = nil;
    check(stillError != NULL && strstr(stillError, "not found") != NULL,
        @"the asynchronous still call returns its own window failure");
    free(stillError); stillError = NULL;
    BOOL invalidRejected = NO;
    @try { invalidRejected = !sp_capture_still(-1, "\xff", &stillError); }
    @catch (NSException *exception) {
        fprintf(stderr, "UTF8 fixture exception: %s\n", exception.reason.UTF8String);
    }
    check(invalidRejected, @"invalid UTF-8 still paths return an explicit failure without exceptions");
    check(stillError != NULL && strstr(stillError, "UTF-8") != NULL,
        @"invalid UTF-8 has its own explicit still error");
    free(stillError);

    fprintf(stderr, "START: still timeout and retained late callback\n");
    Method query = class_getClassMethod([SCShareableContent class],
        @selector(getCurrentProcessShareableContentWithCompletionHandler:));
    check(query != NULL, @"the still-query fault boundary is available");
    if (query != NULL) {
        IMP original = method_setImplementation(query, (IMP)holdStillQuery);
        stillError = NULL;
        BOOL timedOut = !sp_capture_still(-1, stillPath.UTF8String, &stillError);
        method_setImplementation(query, original);
        check(timedOut && stillError != NULL && strstr(stillError, "timed out") != NULL,
            @"a held still query returns its own bounded timeout error");
        check(heldStillReply != nil, @"the delayed still callback is retained");
        clearCaptureError(); setCaptureError(@"fixture later recording failure");
        if (heldStillReply != nil) {
            heldStillReply(nil, [NSError errorWithDomain:@"capture.test" code:3
                userInfo:@{NSLocalizedDescriptionKey: @"fixture late still failure"}]);
            [heldStillReply release]; heldStillReply = nil;
        }
        check(strstr(sp_capture_error(), "fixture later recording failure") != NULL,
            @"a late still callback cannot replace a later recording error");
        check(stillError != NULL && strstr(stillError, "timed out") != NULL,
            @"a returned still timeout error remains owned by its caller");
        free(stillError);
    }
    fprintf(stderr, "END: still timeout and retained late callback\n");

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
    fprintf(stderr, "%s: capture pressure and still-result isolation (%.1fms)\n",
        failures ? "FAIL" : "PASS", (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
