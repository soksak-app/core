// Checks through the real write path that the recording path rejects with an explicit error a sample that lacks a required field of a completed frame (state, presentation time, window rectangle, scale, image),
// and that an idle frame without an image is only counted.
#import "../src/capture.m"

static int failures;
static uint64_t controlledTimes[3];
static int controlledTimeIndex;
static uint64_t controlledRawClock(void) {
    if (controlledTimeIndex >= 3) return 0;
    return controlledTimes[controlledTimeIndex++];
}
static kern_return_t failedTimebase(mach_timebase_info_data_t *timebase) {
    (void)timebase;
    return KERN_FAILURE;
}
static CVReturn injectedLockResult = kCVReturnSuccess;
static CVReturn injectedUnlockResult = kCVReturnSuccess;
static int injectedLockCalls;
static int injectedUnlockCalls;
static int injectedBaseAddressCalls;
static CVPixelBufferLockFlags injectedLockFlags;
static CVPixelBufferLockFlags injectedUnlockFlags;
static CVReturn injectedLock(CVPixelBufferRef buffer, CVPixelBufferLockFlags flags) {
    (void)buffer;
    injectedLockCalls++;
    injectedLockFlags = flags;
    return injectedLockResult;
}
static CVReturn injectedUnlock(CVPixelBufferRef buffer, CVPixelBufferLockFlags flags) {
    injectedUnlockCalls++;
    injectedUnlockFlags = flags;
    CVReturn actual = CVPixelBufferUnlockBaseAddress(buffer, flags);
    return actual == kCVReturnSuccess ? injectedUnlockResult : actual;
}
static void *countingBaseAddress(CVPixelBufferRef buffer) {
    injectedBaseAddressCalls++;
    return CVPixelBufferGetBaseAddress(buffer);
}

static void check(BOOL ok, NSString *label) {
    fprintf(stderr, "%s: %s\n", ok ? "PASS" : "FAIL", label.UTF8String);
    if (!ok) failures++;
}

// Builds a sample with a small image and the given frame information. With image NO the sample has no image.
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

// All fields that a completed frame holds. Returns the dictionary without the key named by without.
static NSDictionary *complete(NSString *without) {
    NSDictionary *rect = [(NSDictionary *)CGRectCreateDictionaryRepresentation(CGRectMake(0, 0, 4, 2)) autorelease];
    NSMutableDictionary *metadata = [[@{SCStreamFrameInfoStatus: @(SCFrameStatusComplete),
        SCStreamFrameInfoDisplayTime: @(mach_absolute_time()), SCStreamFrameInfoContentRect: rect,
        SCStreamFrameInfoContentScale: @1, SCStreamFrameInfoScaleFactor: @2} mutableCopy] autorelease];
    if (without != nil) [metadata removeObjectForKey:without];
    return metadata;
}

static NSString *directory;

// Writes one sample in a new recording state, waits for the recording to finish, and returns the error string.
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

static void beginSequence(SPCapture **used) {
    static int statuses[6];
    memset(statuses, 0, sizeof statuses);
    [captureSink release];
    captureSink = [SPCapture new];
    captureSink.directory = directory;
    captureSink.statuses = statuses;
    clearCaptureError(); captureBefore = 0; captureStartedAt = 0;
    *used = captureSink;
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

    CVReturn (*originalLock)(CVPixelBufferRef, CVPixelBufferLockFlags) = captureLockBaseAddress;
    CVReturn (*originalUnlock)(CVPixelBufferRef, CVPixelBufferLockFlags) = captureUnlockBaseAddress;
    void *(*originalBaseAddress)(CVPixelBufferRef) = captureGetBaseAddress;
    captureLockBaseAddress = injectedLock;
    captureUnlockBaseAddress = injectedUnlock;
    captureGetBaseAddress = countingBaseAddress;
    injectedLockResult = kCVReturnError;
    injectedUnlockResult = kCVReturnSuccess;
    injectedLockCalls = injectedUnlockCalls = injectedBaseAddressCalls = 0;
    error = record(sample(YES, complete(nil)), &used);
    long pendingAfterLockFailure = dispatch_semaphore_wait(capturePending, DISPATCH_TIME_NOW);
    if (pendingAfterLockFailure == 0) dispatch_semaphore_signal(capturePending);
    check([error containsString:@"pixel buffer lock failed"] && [error containsString:@"-6660"]
        && injectedLockCalls == 1 && injectedLockFlags == kCVPixelBufferLock_ReadOnly
        && injectedUnlockCalls == 0 && injectedBaseAddressCalls == 0 && used.queued == 0 && used.written == 0
        && pendingAfterLockFailure == 0,
        @"a failed pixel-buffer lock rejects the frame before base access or unlock and releases writer capacity");

    injectedLockResult = kCVReturnSuccess;
    injectedUnlockResult = kCVReturnError;
    injectedLockCalls = injectedUnlockCalls = injectedBaseAddressCalls = 0;
    error = record(sample(YES, complete(nil)), &used);
    pendingAfterLockFailure = dispatch_semaphore_wait(capturePending, DISPATCH_TIME_NOW);
    if (pendingAfterLockFailure == 0) dispatch_semaphore_signal(capturePending);
    check([error containsString:@"pixel buffer unlock failed"] && [error containsString:@"-6660"]
        && injectedLockCalls == 1 && injectedLockFlags == kCVPixelBufferLock_ReadOnly
        && injectedUnlockCalls == 1 && injectedUnlockFlags == kCVPixelBufferLock_ReadOnly
        && injectedBaseAddressCalls == 1 && used.queued == 0 && used.written == 0
        && pendingAfterLockFailure == 0,
        @"a failed pixel-buffer unlock rejects the copied frame and releases writer capacity");
    captureLockBaseAddress = originalLock;
    captureUnlockBaseAddress = originalUnlock;
    captureGetBaseAddress = originalBaseAddress;

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

    beginSequence(&used);
    NSMutableDictionary *measuredMetadata = [complete(nil) mutableCopy];
    measuredMetadata[SCStreamFrameInfoDisplayTime] = @987654321;
    CMSampleBufferRef measured = sample(YES, measuredMetadata);
    [measuredMetadata release];
    controlledTimes[0] = 100;
    controlledTimes[1] = 200;
    controlledTimes[2] = 250;
    controlledTimeIndex = 0;
    uint64_t (*originalClock)(void) = captureRawClock;
    captureRawClock = controlledRawClock;
    SCStream *testStream = (SCStream *)[NSObject new];
    [used stream:testStream didOutputSampleBuffer:measured ofType:SCStreamOutputTypeScreen];
    [testStream release];
    captureRawClock = originalClock;
    dispatch_sync(captureWriter, ^{});
    CFRelease(measured);
    NSDictionary *measuredCallback = used.callbackStatusTrace.firstObject;
    mach_timebase_info_data_t measuredTimebase = {};
    kern_return_t measuredTimebaseResult = mach_timebase_info(&measuredTimebase);
    check(controlledTimeIndex == 3
        && [measuredCallback[@"callbackTime"] isEqual:@"100"]
        && [measuredCallback[@"writeStartTime"] isEqual:@"200"]
        && [measuredCallback[@"writeCompleteTime"] isEqual:@"250"]
        && [measuredCallback[@"machTimebaseNumerator"] unsignedIntValue] == measuredTimebase.numer
        && [measuredCallback[@"machTimebaseDenominator"] unsignedIntValue] == measuredTimebase.denom
        && measuredTimebaseResult == KERN_SUCCESS
        && [measuredCallback[@"displayTime"] isEqual:@"987654321"]
        && [measuredCallback[@"frame"] isEqual:@"frame-0001.bgra"],
        @"the real delegate path records controlled raw arrival, processing bounds, the system timebase, display time and exact frame marker");
    check(writeCaptureCallbackStatusTrace(used), @"the measured callback metadata is written as JSONL");
    NSString *measuredTraceText = [NSString stringWithContentsOfFile:
        [directory stringByAppendingPathComponent:kCaptureCallbackStatusFile] encoding:NSUTF8StringEncoding error:nil];
    NSDictionary *measuredJSON = [NSJSONSerialization JSONObjectWithData:
        [measuredTraceText dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    check([measuredJSON[@"callbackTime"] isEqual:@"100"]
        && [measuredJSON[@"writeStartTime"] isEqual:@"200"]
        && [measuredJSON[@"writeCompleteTime"] isEqual:@"250"]
        && [measuredJSON[@"machTimebaseNumerator"] unsignedIntValue] == measuredTimebase.numer
        && [measuredJSON[@"machTimebaseDenominator"] unsignedIntValue] == measuredTimebase.denom,
        @"the callback artifact preserves the raw timing values and actual mach timebase");

    beginSequence(&used);
    controlledTimes[0] = 300;
    controlledTimes[1] = 400;
    controlledTimeIndex = 0;
    originalClock = captureRawClock;
    kern_return_t (*originalTimebaseReader)(mach_timebase_info_data_t *) = captureReadTimebase;
    captureRawClock = controlledRawClock;
    captureReadTimebase = failedTimebase;
    CMSampleBufferRef noTimebaseFrame = sample(NO, @{SCStreamFrameInfoStatus: @(SCFrameStatusIdle),
        SCStreamFrameInfoDisplayTime: @987654322});
    testStream = (SCStream *)[NSObject new];
    [used stream:testStream didOutputSampleBuffer:noTimebaseFrame ofType:SCStreamOutputTypeScreen];
    [testStream release];
    CFRelease(noTimebaseFrame);
    captureRawClock = originalClock;
    captureReadTimebase = originalTimebaseReader;
    check(controlledTimeIndex == 2 && used.callbackStatusTrace.count == 0
        && [[NSString stringWithUTF8String:sp_capture_error()] containsString:@"capture callback mach timebase failed"],
        @"a timebase failure rejects the callback with an explicit capture error before writing an incomplete record");

    error = record(sample(NO, @{SCStreamFrameInfoStatus: @(SCFrameStatusIdle),
        SCStreamFrameInfoDisplayTime: @(mach_absolute_time())}), &used);
    check(error.length == 0 && used.idle == 1 && used.written == 0,
        [NSString stringWithFormat:@"an idle frame without an image is counted and not an error (%@, idle %d)", error, used.idle]);

    CMSampleBufferRef completeBefore = sample(YES, @{SCStreamFrameInfoStatus: @(SCFrameStatusComplete),
        SCStreamFrameInfoDisplayTime: @((uint64_t)1000000001), SCStreamFrameInfoContentRect: complete(nil)[SCStreamFrameInfoContentRect],
        SCStreamFrameInfoContentScale: @1, SCStreamFrameInfoScaleFactor: @2});
    CMSampleBufferRef idle = sample(NO, @{SCStreamFrameInfoStatus: @(SCFrameStatusIdle),
        SCStreamFrameInfoDisplayTime: @((uint64_t)1010000002)});
    CMSampleBufferRef blankWithoutTime = sample(NO, @{SCStreamFrameInfoStatus: @(SCFrameStatusBlank)});
    CMSampleBufferRef completeAfter = sample(YES, @{SCStreamFrameInfoStatus: @(SCFrameStatusComplete),
        SCStreamFrameInfoDisplayTime: @((uint64_t)1035000003), SCStreamFrameInfoContentRect: complete(nil)[SCStreamFrameInfoContentRect],
        SCStreamFrameInfoContentScale: @1, SCStreamFrameInfoScaleFactor: @2});
    CMSampleBufferRef secondCompleteAfter = sample(YES, @{SCStreamFrameInfoStatus: @(SCFrameStatusComplete),
        SCStreamFrameInfoDisplayTime: @((uint64_t)1070000005), SCStreamFrameInfoContentRect: complete(nil)[SCStreamFrameInfoContentRect],
        SCStreamFrameInfoContentScale: @1, SCStreamFrameInfoScaleFactor: @2});
    NSArray *sequence = @[[NSValue valueWithPointer:completeBefore], [NSValue valueWithPointer:idle],
        [NSValue valueWithPointer:blankWithoutTime], [NSValue valueWithPointer:completeAfter],
        [NSValue valueWithPointer:secondCompleteAfter]];
    beginSequence(&used);
    captureStartedAt = 1030000000;
    for (NSValue *frame in sequence) [captureSink write:(CMSampleBufferRef)frame.pointerValue];
    dispatch_sync(captureWriter, ^{});
    error = [NSString stringWithUTF8String:sp_capture_error()];
    check(error.length == 0 && used.written == 2,
        [NSString stringWithFormat:@"the capture writes only the two complete frames after its start boundary (%@, %d)", error, used.written]);
    BOOL hasTrace = [used respondsToSelector:@selector(callbackStatusTrace)];
    check(hasTrace, @"each callback records its status and display time");
    if (hasTrace) {
        NSArray *trace = [used valueForKey:@"callbackStatusTrace"];
        check(trace.count == 5, [NSString stringWithFormat:@"the callback trace has all five entries (%lu)", (unsigned long)trace.count]);
        BOOL hasTimingForEveryCallback = trace.count == 5;
        for (NSDictionary *callback in trace) {
            id callbackTime = callback[@"callbackTime"];
            id writeStartTime = callback[@"writeStartTime"];
            id writeCompleteTime = callback[@"writeCompleteTime"];
            hasTimingForEveryCallback = hasTimingForEveryCallback
                && [callbackTime isKindOfClass:[NSString class]]
                && [writeStartTime isKindOfClass:[NSString class]]
                && [writeCompleteTime isKindOfClass:[NSString class]]
                && [callbackTime longLongValue] <= [writeStartTime longLongValue]
                && [writeStartTime longLongValue] <= [writeCompleteTime longLongValue]
                && [callback[@"machTimebaseNumerator"] unsignedIntValue] > 0
                && [callback[@"machTimebaseDenominator"] unsignedIntValue] > 0;
        }
        check(hasTimingForEveryCallback,
            @"every complete, idle, cached and blank callback records ordered raw timestamps and a timebase");
        if (trace.count == 5) {
            check([trace[0][@"status"] intValue] == SCFrameStatusComplete
                && [trace[0][@"displayTime"] isEqual:@"1000000001"]
                && trace[0][@"frame"] == [NSNull null]
                && [trace[1][@"status"] intValue] == SCFrameStatusIdle
                && [trace[1][@"displayTime"] isEqual:@"1010000002"]
                && trace[1][@"frame"] == [NSNull null]
                && [trace[2][@"sequence"] isEqual:@3]
                && [trace[2][@"status"] intValue] == SCFrameStatusBlank
                && trace[2][@"displayTime"] == [NSNull null]
                && trace[2][@"frame"] == [NSNull null]
                && [trace[3][@"status"] intValue] == SCFrameStatusComplete
                && [trace[3][@"displayTime"] isEqual:@"1035000003"]
                && [trace[3][@"frame"] isEqual:@"frame-0001.bgra"]
                && [trace[4][@"status"] intValue] == SCFrameStatusComplete
                && [trace[4][@"displayTime"] isEqual:@"1070000005"]
                && [trace[4][@"frame"] isEqual:@"frame-0002.bgra"],
                @"the callback trace identifies each written frame and marks cached, idle and blank callbacks without files");
            check([[NSFileManager defaultManager] fileExistsAtPath:[directory stringByAppendingPathComponent:@"frame-0001.bgra"]]
                && [[NSFileManager defaultManager] fileExistsAtPath:[directory stringByAppendingPathComponent:@"frame-0002.bgra"]],
                @"the exact frame filenames in the callback trace exist in the recording directory");
            check(writeCaptureCallbackStatusTrace(used), @"the callback status artifact is written");
            NSString *tracePath = [directory stringByAppendingPathComponent:kCaptureCallbackStatusFile];
            NSString *traceText = [NSString stringWithContentsOfFile:tracePath encoding:NSUTF8StringEncoding error:nil];
            NSArray *lines = [traceText componentsSeparatedByString:@"\n"];
            NSDictionary *idleRecord = lines.count > 1
                ? [NSJSONSerialization JSONObjectWithData:[lines[1] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil]
                : nil;
            check([idleRecord[@"sequence"] isEqual:@2] && [idleRecord[@"status"] intValue] == SCFrameStatusIdle
                && [idleRecord[@"displayTime"] isEqual:@"1010000002"]
                && idleRecord[@"frame"] == [NSNull null],
                @"the callback status artifact preserves the idle callback and marks its absent frame");
            NSDictionary *writtenFrameRecord = lines.count > 3
                ? [NSJSONSerialization JSONObjectWithData:[lines[3] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil]
                : nil;
            check([writtenFrameRecord[@"sequence"] isEqual:@4]
                && [writtenFrameRecord[@"frame"] isEqual:@"frame-0001.bgra"],
                @"the callback status artifact names the exact written frame file");
        }
    }
    [sequence enumerateObjectsUsingBlock:^(NSValue *value, NSUInteger index, BOOL *stop) {
        (void)index; (void)stop; CFRelease((CMSampleBufferRef)value.pointerValue);
    }];

    beginSequence(&used);
    CMSampleBufferRef missingStatus = sample(NO, @{SCStreamFrameInfoDisplayTime: @((uint64_t)1025000002)});
    [used write:missingStatus];
    CFRelease(missingStatus);
    NSDictionary *missingStatusRecord = used.callbackStatusTrace.firstObject;
    check(used.callbackStatusTrace.count == 1
        && missingStatusRecord[@"status"] == [NSNull null]
        && [missingStatusRecord[@"displayTime"] isEqual:@"1025000002"]
        && [missingStatusRecord[@"writeCompleteTime"] isKindOfClass:[NSString class]]
        && missingStatusRecord[@"frame"] == [NSNull null]
        && [NSString stringWithUTF8String:sp_capture_error()].length > 0,
        @"a callback without status records null status, exact display time and a capture error");
    check(writeCaptureCallbackStatusTrace(used), @"a callback with missing status is still written to the trace");
    NSString *missingStatusText = [NSString stringWithContentsOfFile:
        [directory stringByAppendingPathComponent:kCaptureCallbackStatusFile] encoding:NSUTF8StringEncoding error:nil];
    NSDictionary *missingStatusJSON = [NSJSONSerialization JSONObjectWithData:
        [missingStatusText dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    check(missingStatusJSON[@"status"] == [NSNull null]
        && [missingStatusJSON[@"displayTime"] isEqual:@"1025000002"]
        && missingStatusJSON[@"frame"] == [NSNull null],
        @"the callback status JSONL encodes missing status as null and preserves display time");

    beginSequence(&used);
    [used.callbackStatusTrace addObject:@{@"sequence": @1, @"status": @1, @"displayTime": @"1", @"frame": [NSNull null]}];
    [used.callbackStatusTrace addObject:@{@"sequence": @2, @"status": [[[NSObject alloc] init] autorelease], @"displayTime": @"2", @"frame": [NSNull null]}];
    check(!writeCaptureCallbackStatusTrace(used)
        && [[NSString stringWithUTF8String:sp_capture_error()] containsString:@"could not encode record 2:"],
        @"a callback status encode error reports its one-based record number");

    beginSequence(&used);
    used.directory = @"/dev/null";
    check(!writeCaptureCallbackStatusTrace(used)
        && [[NSString stringWithUTF8String:sp_capture_error()] containsString:@"could not write"],
        @"a callback status artifact write failure fails the capture");
    used.directory = directory;

    beginSequence(&used);
    CMSampleBufferRef repeatedIdle = sample(NO, @{SCStreamFrameInfoStatus: @(SCFrameStatusIdle),
        SCStreamFrameInfoDisplayTime: @((uint64_t)1040000004)});
    for (int index = 0; index < 4097; index++) [used write:repeatedIdle];
    CFRelease(repeatedIdle);
    check([NSString stringWithUTF8String:sp_capture_error()].length > 0
        && [[NSString stringWithUTF8String:sp_capture_error()] containsString:@"callback status trace capacity exceeded"],
        @"trace overflow fails the recording explicitly");
    check(used.callbackStatusTrace.count == 4096, @"the callback trace never exceeds its declared bound");

    NSError *removal = nil;
    check([[NSFileManager defaultManager] removeItemAtPath:directory error:&removal],
        [NSString stringWithFormat:@"fixture files are removed (%@)", removal]);
    fprintf(stderr, "%s: native capture frame metadata validation (%.1fms)\n", failures ? "FAIL" : "PASS",
        (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
