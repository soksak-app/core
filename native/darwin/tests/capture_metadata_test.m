// 녹화 경로가 완성 프레임의 필수 정보(상태, 표시 시각, 창 사각형, 배율, 이미지)가 빠진 샘플을 명시적 오류로
// 거부하고, 이미지가 없는 idle 프레임은 계속 세기만 하는지 실제 쓰기 경로로 검사한다.
#import "../src/capture.m"

static int failures;
static void check(BOOL ok, NSString *label) {
    fprintf(stderr, "%s: %s\n", ok ? "PASS" : "FAIL", label.UTF8String);
    if (!ok) failures++;
}

// 작은 이미지와 지정한 프레임 정보를 가진 샘플을 만든다. image 가 NO 이면 이미지 없는 샘플이다.
static CMSampleBufferRef sample(BOOL image, NSDictionary *metadata) {
    CMSampleBufferRef result = NULL;
    CMSampleTimingInfo timing = {kCMTimeInvalid, kCMTimeZero, kCMTimeInvalid};
    if (image) {
        CVPixelBufferRef pixels = NULL;
        if (CVPixelBufferCreate(NULL, 8, 4, kCVPixelFormatType_32BGRA, NULL, &pixels) != kCVReturnSuccess) {
            check(NO, @"the fixture has a pixel buffer");
            return NULL;
        }
        CMVideoFormatDescriptionRef format = NULL;
        if (CMVideoFormatDescriptionCreateForImageBuffer(NULL, pixels, &format) == noErr) {
            CMSampleBufferCreateReadyWithImageBuffer(NULL, pixels, format, &timing, &result);
            CFRelease(format);
        }
        CVPixelBufferRelease(pixels);
    } else {
        CMSampleBufferCreate(NULL, NULL, true, NULL, NULL, NULL, 1, 1, &timing, 0, NULL, &result);
    }
    check(result != NULL, @"the fixture has a sample");
    if (result == NULL) return NULL;
    CFArrayRef list = CMSampleBufferGetSampleAttachmentsArray(result, true);
    check(list != NULL && CFArrayGetCount(list) == 1, @"the fixture sample has one attachment dictionary");
    if (list == NULL || CFArrayGetCount(list) != 1) { CFRelease(result); return NULL; }
    CFMutableDictionaryRef attachments = (CFMutableDictionaryRef)CFArrayGetValueAtIndex(list, 0);
    for (NSString *key in metadata) CFDictionarySetValue(attachments, key, metadata[key]);
    return result;
}

// 완성 프레임이 가지는 모든 정보. without 이름을 뺀 사전을 돌려준다.
static NSDictionary *complete(NSString *without) {
    NSDictionary *rect = [(NSDictionary *)CGRectCreateDictionaryRepresentation(CGRectMake(0, 0, 4, 2)) autorelease];
    NSMutableDictionary *metadata = [[@{SCStreamFrameInfoStatus: @(SCFrameStatusComplete),
        SCStreamFrameInfoDisplayTime: @(mach_absolute_time()), SCStreamFrameInfoContentRect: rect,
        SCStreamFrameInfoContentScale: @1, SCStreamFrameInfoScaleFactor: @2} mutableCopy] autorelease];
    if (without != nil) [metadata removeObjectForKey:without];
    return metadata;
}

static NSString *directory;

// 새 녹화 상태에서 샘플 하나를 쓰고 기록이 끝나기를 기다린 뒤, 오류 문자열을 돌려준다.
static NSString *record(CMSampleBufferRef frame, SPCapture **used) {
    static int statuses[6];
    memset(statuses, 0, sizeof statuses);
    [captureSink release];
    captureSink = [SPCapture new];
    captureSink.directory = directory;
    captureSink.statuses = statuses;
    clearCaptureError(); captureBefore = 0; captureStartedAt = 0;
    if (frame != NULL) {
        [captureSink write:frame];
        dispatch_sync(captureWriter, ^{});
        CFRelease(frame);
    }
    *used = captureSink;
    return [NSString stringWithUTF8String:sp_capture_error()];
}

int main(void) { @autoreleasepool {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: native capture frame metadata validation\n");
    [NSApplication sharedApplication];
    char path[] = "/tmp/soksak-capture-metadata-XXXXXX";
    if (mkdtemp(path) == NULL) { check(NO, @"the fixture directory is created"); return 1; }
    directory = [NSString stringWithUTF8String:path];
    captureWriter = dispatch_queue_create("capture.test.metadata", DISPATCH_QUEUE_SERIAL);
    capturePending = dispatch_semaphore_create(kCapturePending);
    captureFirstFrame = dispatch_semaphore_create(0);
    SPCapture *used = nil;

    NSString *error = record(sample(YES, complete(nil)), &used);
    check(error.length == 0 && used.written == 1, [NSString stringWithFormat:@"a complete frame with every field is written (%@)", error]);

    NSDictionary *names = @{SCStreamFrameInfoStatus: @"status", SCStreamFrameInfoDisplayTime: @"display time",
        SCStreamFrameInfoContentRect: @"content rectangle", SCStreamFrameInfoContentScale: @"content scale",
        SCStreamFrameInfoScaleFactor: @"scale factor"};
    for (NSString *key in @[SCStreamFrameInfoStatus, SCStreamFrameInfoDisplayTime, SCStreamFrameInfoContentRect,
             SCStreamFrameInfoContentScale, SCStreamFrameInfoScaleFactor]) {
        error = record(sample(YES, complete(key)), &used);
        check([error containsString:[NSString stringWithFormat:@"has no %@", names[key]]] && used.written == 0,
            [NSString stringWithFormat:@"a frame without its %@ rejects the recording (%@, written %d)",
                names[key], error, used.written]);
    }

    error = record(sample(NO, complete(nil)), &used);
    check([error containsString:@"has no image buffer"],
        [NSString stringWithFormat:@"a complete frame without an image buffer rejects the recording (%@)", error]);

    error = record(sample(NO, @{SCStreamFrameInfoStatus: @(SCFrameStatusIdle),
        SCStreamFrameInfoDisplayTime: @(mach_absolute_time())}), &used);
    check(error.length == 0 && used.idle == 1 && used.written == 0,
        [NSString stringWithFormat:@"an idle frame without an image is counted and not an error (%@, idle %d)", error, used.idle]);

    NSError *removal = nil;
    check([[NSFileManager defaultManager] removeItemAtPath:directory error:&removal],
        [NSString stringWithFormat:@"fixture files are removed (%@)", removal]);
    fprintf(stderr, "%s: native capture frame metadata validation (%.1fms)\n", failures ? "FAIL" : "PASS",
        (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
