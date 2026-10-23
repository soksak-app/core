// Checks through the real write path that the recording path rejects with an explicit error a sample that lacks a required field of a completed frame (state, presentation time, window rectangle, scale, image),
// and that an idle frame without an image is only counted.
#import "../src/capture.m"

static int failures;
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

static NSString *recordSequence(NSArray *frames, SPCapture **used) {
    beginSequence(used);
    for (id frame in frames) [captureSink write:(CMSampleBufferRef)[frame pointerValue]];
    dispatch_sync(captureWriter, ^{});
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

    CMSampleBufferRef completeBefore = sample(YES, @{SCStreamFrameInfoStatus: @(SCFrameStatusComplete),
        SCStreamFrameInfoDisplayTime: @((uint64_t)1000000001), SCStreamFrameInfoContentRect: complete(nil)[SCStreamFrameInfoContentRect],
        SCStreamFrameInfoContentScale: @1, SCStreamFrameInfoScaleFactor: @2});
    CMSampleBufferRef idle = sample(NO, @{SCStreamFrameInfoStatus: @(SCFrameStatusIdle),
        SCStreamFrameInfoDisplayTime: @((uint64_t)1010000002)});
    CMSampleBufferRef blankWithoutTime = sample(NO, @{SCStreamFrameInfoStatus: @(SCFrameStatusBlank)});
    CMSampleBufferRef completeAfter = sample(YES, @{SCStreamFrameInfoStatus: @(SCFrameStatusComplete),
        SCStreamFrameInfoDisplayTime: @((uint64_t)1035000003), SCStreamFrameInfoContentRect: complete(nil)[SCStreamFrameInfoContentRect],
        SCStreamFrameInfoContentScale: @1, SCStreamFrameInfoScaleFactor: @2});
    NSArray *sequence = @[[NSValue valueWithPointer:completeBefore], [NSValue valueWithPointer:idle],
        [NSValue valueWithPointer:blankWithoutTime], [NSValue valueWithPointer:completeAfter]];
    error = recordSequence(sequence, &used);
    BOOL hasTrace = [used respondsToSelector:@selector(callbackStatusTrace)];
    check(hasTrace, @"each callback records its status and display time");
    if (hasTrace) {
        NSArray *trace = [used valueForKey:@"callbackStatusTrace"];
        check(trace.count == 4, [NSString stringWithFormat:@"the callback trace has all four entries (%lu)", (unsigned long)trace.count]);
        if (trace.count == 4) {
            check([trace[0][@"status"] intValue] == SCFrameStatusComplete
                && [trace[0][@"displayTime"] isEqual:@"1000000001"]
                && [trace[1][@"status"] intValue] == SCFrameStatusIdle
                && [trace[1][@"displayTime"] isEqual:@"1010000002"]
                && [trace[2][@"sequence"] isEqual:@3]
                && [trace[2][@"status"] intValue] == SCFrameStatusBlank
                && trace[2][@"displayTime"] == [NSNull null]
                && [trace[3][@"status"] intValue] == SCFrameStatusComplete
                && [trace[3][@"displayTime"] isEqual:@"1035000003"],
                @"the callback trace preserves complete and idle times and explicit missing metadata in order");
            check(writeCaptureCallbackStatusTrace(used), @"the callback status artifact is written");
            NSString *tracePath = [directory stringByAppendingPathComponent:kCaptureCallbackStatusFile];
            NSString *traceText = [NSString stringWithContentsOfFile:tracePath encoding:NSUTF8StringEncoding error:nil];
            NSArray *lines = [traceText componentsSeparatedByString:@"\n"];
            NSDictionary *idleRecord = lines.count > 1
                ? [NSJSONSerialization JSONObjectWithData:[lines[1] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil]
                : nil;
            check([idleRecord[@"sequence"] isEqual:@2] && [idleRecord[@"status"] intValue] == SCFrameStatusIdle
                && [idleRecord[@"displayTime"] isEqual:@"1010000002"],
                @"the callback status artifact preserves the idle callback and exact display time");
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
        && [NSString stringWithUTF8String:sp_capture_error()].length > 0,
        @"a callback without status records null status, exact display time and a capture error");
    check(writeCaptureCallbackStatusTrace(used), @"a callback with missing status is still written to the trace");
    NSString *missingStatusText = [NSString stringWithContentsOfFile:
        [directory stringByAppendingPathComponent:kCaptureCallbackStatusFile] encoding:NSUTF8StringEncoding error:nil];
    NSDictionary *missingStatusJSON = [NSJSONSerialization JSONObjectWithData:
        [missingStatusText dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    check(missingStatusJSON[@"status"] == [NSNull null]
        && [missingStatusJSON[@"displayTime"] isEqual:@"1025000002"],
        @"the callback status JSONL encodes missing status as null and preserves display time");

    beginSequence(&used);
    [used.callbackStatusTrace addObject:@{@"sequence": @1, @"status": @1, @"displayTime": @"1"}];
    [used.callbackStatusTrace addObject:@{@"sequence": @2, @"status": [[[NSObject alloc] init] autorelease], @"displayTime": @"2"}];
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
