// Checks that opt-in ScreenCaptureKit samples record a separate decoded identity result without changing raw frames.
#import "../src/capture.m"
#import "../src/capture_frame_identity.h"

static int failures;
static void check(BOOL condition, NSString *label) {
    fprintf(stderr, "%s: %s\n", condition ? "PASS" : "FAIL", label.UTF8String);
    if (!condition) failures++;
}

static CMSampleBufferRef sampleBGRA(NSData *pixels, size_t width, size_t height, CGRect bounds) {
    CVPixelBufferRef buffer = NULL;
    NSDictionary *attributes = @{ (id)kCVPixelBufferCGImageCompatibilityKey: @YES,
        (id)kCVPixelBufferCGBitmapContextCompatibilityKey: @YES };
    if (CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA,
        (CFDictionaryRef)attributes, &buffer) != kCVReturnSuccess) return NULL;
    if (CVPixelBufferLockBaseAddress(buffer, 0) != kCVReturnSuccess) { CVPixelBufferRelease(buffer); return NULL; }
    size_t stride = CVPixelBufferGetBytesPerRow(buffer);
    uint8_t *destination = CVPixelBufferGetBaseAddress(buffer);
    for (size_t y = 0; y < height; y++) memcpy(destination + y * stride, (const uint8_t *)pixels.bytes + y * width * 4, width * 4);
    CVPixelBufferUnlockBaseAddress(buffer, 0);
    CGColorSpaceRef colorSpace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    if (colorSpace) {
        CVBufferSetAttachment(buffer, kCVImageBufferCGColorSpaceKey, colorSpace, kCVAttachmentMode_ShouldPropagate);
        CGColorSpaceRelease(colorSpace);
    }
    CMVideoFormatDescriptionRef format = NULL;
    CMSampleBufferRef result = NULL;
    CMSampleTimingInfo timing = {kCMTimeInvalid, kCMTimeZero, kCMTimeInvalid};
    if (CMVideoFormatDescriptionCreateForImageBuffer(kCFAllocatorDefault, buffer, &format) == noErr)
        CMSampleBufferCreateReadyWithImageBuffer(kCFAllocatorDefault, buffer, format, &timing, &result);
    if (format) CFRelease(format);
    CVPixelBufferRelease(buffer);
    if (!result) return NULL;
    NSDictionary *content = [(NSDictionary *)CGRectCreateDictionaryRepresentation(CGRectMake(0, 0, bounds.size.width, bounds.size.height)) autorelease];
    NSDictionary *screen = [(NSDictionary *)CGRectCreateDictionaryRepresentation(bounds) autorelease];
    NSDictionary *metadata = @{ SCStreamFrameInfoStatus: @(SCFrameStatusComplete),
        SCStreamFrameInfoDisplayTime: @(mach_absolute_time()), SCStreamFrameInfoContentRect: content,
        SCStreamFrameInfoScreenRect: screen, SCStreamFrameInfoContentScale: @1, SCStreamFrameInfoScaleFactor: @1 };
    CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(result, true);
    if (!attachments || CFArrayGetCount(attachments) != 1) { CFRelease(result); return NULL; }
    CFMutableDictionaryRef values = (CFMutableDictionaryRef)CFArrayGetValueAtIndex(attachments, 0);
    for (NSString *key in metadata) CFDictionarySetValue(values, (__bridge CFStringRef)key, (__bridge CFTypeRef)metadata[key]);
    return result;
}

int main(void) { @autoreleasepool {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: native capture frame identity recording\n");
    [NSApplication sharedApplication];
    char path[] = "/tmp/soksak-frame-identity-capture-XXXXXX";
    if (mkdtemp(path) == NULL) {
        check(NO, @"the capture identity fixture directory is created");
        return 1;
    }
    NSString *directory = [[NSString alloc] initWithUTF8String:path];
    captureWriter = dispatch_queue_create("capture.test.identity", DISPATCH_QUEUE_SERIAL);
    capturePending = dispatch_semaphore_create(kCapturePending);
    captureFirstFrame = dispatch_semaphore_create(0);
    static int statuses[6];
    memset(statuses, 0, sizeof statuses);

    sp_image_capture_match_begin(directory.fileSystemRepresentation, captureWriter);
    char *identityError = NULL;
    BOOL identityStarted = sp_image_capture_match_identity_session_begin(&identityError);
    check(identityStarted, [NSString stringWithFormat:@"the identity session starts (%s)", identityError ?: ""]);
    free(identityError);

    const size_t sourceWidth = 200, sourceHeight = 200, sourceStride = sourceWidth * 4;
    NSMutableData *sourcePixels = [NSMutableData dataWithLength:sourceStride * sourceHeight];
    uint8_t *sourceBytes = sourcePixels.mutableBytes;
    for (size_t y = 0; y < sourceHeight; y++) for (size_t x = 0; x < sourceWidth; x++) {
        uint8_t *pixel = sourceBytes + y * sourceStride + x * 4;
        pixel[0] = 90; pixel[1] = 110; pixel[2] = 130; pixel[3] = 255;
    }
    uint8_t regionToken[16] = {1, 2, 3, 4};
    sp_image_capture_identity identity = { 19, 23, 29 };
    NSString *nonce = nil, *issuedPayload = nil, *encodedPayload = nil, *encodeError = nil;
    CGColorSpaceRef colorSpace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGRect tagROI = CGRectMake(8, 0, 192, 192);
    CGImageRef taggedImage = NULL;
    NSData *taggedPixels = nil;
    BOOL sourcePrepared = colorSpace
        && sp_image_capture_match_identity_region_nonce(regionToken, &nonce, &identityError)
        && sp_image_capture_match_identity_issue(regionToken, identity, &issuedPayload, &identityError)
        && sp_image_capture_match_retain(identity, sourceBytes, sourceWidth, sourceHeight, sourceStride,
            CGRectMake(0, 0, sourceWidth, sourceHeight), 1, "kCGColorSpaceSRGB")
        && sp_capture_frame_identity_encode(sourceBytes, sourceWidth, sourceHeight, sourceStride, colorSpace,
            tagROI, nonce, (SPCaptureFrameIdentity){ identity.generation, identity.raster, identity.sequence },
            &taggedImage, &taggedPixels, &encodedPayload, &encodeError)
        && [issuedPayload isEqualToString:encodedPayload]
        && sp_image_capture_match_identity_record(regionToken, identity, tagROI, taggedPixels.bytes,
            sourceWidth, sourceHeight, sourceStride, "kCGColorSpaceSRGB", &identityError);
    check(sourcePrepared, [NSString stringWithFormat:@"the source tag is issued and retained (%s, %@)",
        identityError ?: "", encodeError ?: @""]);
    free(identityError);
    NSString *firstRegionNonce = [nonce copy];
    [nonce release]; [issuedPayload release]; [encodedPayload release]; [encodeError release];
    if (taggedImage) CGImageRelease(taggedImage);
    if (colorSpace) CGColorSpaceRelease(colorSpace);
    uint8_t secondRegionToken[16] = {5, 6, 7, 8};
    sp_image_capture_identity secondIdentity = { 31, 37, 41 };
    NSString *secondNonce = nil, *secondIssuedPayload = nil, *secondEncodedPayload = nil, *secondEncodeError = nil;
    CGColorSpaceRef secondColorSpace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGImageRef secondTaggedImage = NULL;
    NSData *secondTaggedPixels = nil;
    BOOL secondSourcePrepared = secondColorSpace
        && sp_image_capture_match_identity_region_nonce(secondRegionToken, &secondNonce, &identityError)
        && sp_image_capture_match_identity_issue(secondRegionToken, secondIdentity, &secondIssuedPayload, &identityError)
        && sp_image_capture_match_retain(secondIdentity, sourceBytes, sourceWidth, sourceHeight, sourceStride,
            CGRectMake(sourceWidth, 0, sourceWidth, sourceHeight), 1, "kCGColorSpaceSRGB")
        && sp_capture_frame_identity_encode(sourceBytes, sourceWidth, sourceHeight, sourceStride, secondColorSpace,
            tagROI, secondNonce, (SPCaptureFrameIdentity){ secondIdentity.generation, secondIdentity.raster, secondIdentity.sequence },
            &secondTaggedImage, &secondTaggedPixels, &secondEncodedPayload, &secondEncodeError)
        && [secondIssuedPayload isEqualToString:secondEncodedPayload]
        && sp_image_capture_match_identity_record(secondRegionToken, secondIdentity, tagROI, secondTaggedPixels.bytes,
            sourceWidth, sourceHeight, sourceStride, "kCGColorSpaceSRGB", &identityError);
    check(secondSourcePrepared, [NSString stringWithFormat:@"a second disjoint region has its own issued identity (%s, %@)",
        identityError ?: "", secondEncodeError ?: @""]);
    free(identityError); identityError = NULL;
    [secondNonce release]; [secondIssuedPayload release]; [secondEncodedPayload release]; [secondEncodeError release];
    if (secondTaggedImage) CGImageRelease(secondTaggedImage);
    if (secondColorSpace) CGColorSpaceRelease(secondColorSpace);
    SPCapture *sink = [SPCapture new];
    sink.directory = directory;
    sink.statuses = statuses;
    captureSink = [sink retain];
    captureBefore = 0;
    captureStartedAt = 0;
    clearCaptureError();

    NSDictionary *content = [(NSDictionary *)CGRectCreateDictionaryRepresentation(CGRectMake(0, 0, 4, 2)) autorelease];
    NSDictionary *screen = [(NSDictionary *)CGRectCreateDictionaryRepresentation(CGRectMake(0, 0, 4, 2)) autorelease];
    CMSampleBufferRef frame = NULL;
    CVPixelBufferRef buffer = NULL;
    CMVideoFormatDescriptionRef format = NULL;
    CMSampleTimingInfo timing = {kCMTimeInvalid, kCMTimeZero, kCMTimeInvalid};
    NSDictionary *metadata = @{
        SCStreamFrameInfoStatus: @(SCFrameStatusComplete),
        SCStreamFrameInfoDisplayTime: @(mach_absolute_time()),
        SCStreamFrameInfoContentRect: content,
        SCStreamFrameInfoScreenRect: screen,
        SCStreamFrameInfoContentScale: @1,
        SCStreamFrameInfoScaleFactor: @1,
    };
    CVPixelBufferCreate(NULL, 8, 4, kCVPixelFormatType_32BGRA, NULL, &buffer);
    if (buffer && CMVideoFormatDescriptionCreateForImageBuffer(NULL, buffer, &format) == noErr)
        CMSampleBufferCreateReadyWithImageBuffer(NULL, buffer, format, &timing, &frame);
    if (buffer) CVPixelBufferRelease(buffer);
    if (format) CFRelease(format);
    check(frame != NULL, @"the complete ScreenCaptureKit sample fixture is created");
    if (frame) {
        CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(frame, true);
        if (attachments && CFArrayGetCount(attachments) == 1) {
            CFMutableDictionaryRef values = (CFMutableDictionaryRef)CFArrayGetValueAtIndex(attachments, 0);
            for (NSString *key in metadata) CFDictionarySetValue(values, (__bridge CFStringRef)key,
                (__bridge CFTypeRef)metadata[key]);
        }
        [sink write:frame callbackTime:mach_absolute_time()];
        CFRelease(frame);
    }
    NSMutableData *composite = [NSMutableData dataWithLength:sourceStride * sourceHeight * 2];
    for (size_t y = 0; y < sourceHeight; y++) {
        memcpy((uint8_t *)composite.mutableBytes + y * sourceStride * 2,
            (const uint8_t *)taggedPixels.bytes + y * sourceStride, sourceStride);
        memcpy((uint8_t *)composite.mutableBytes + y * sourceStride * 2 + sourceStride,
            (const uint8_t *)secondTaggedPixels.bytes + y * sourceStride, sourceStride);
    }
    CMSampleBufferRef taggedFrame = sampleBGRA(composite, sourceWidth * 2, sourceHeight,
        CGRectMake(0, 0, sourceWidth * 2, sourceHeight));
    check(taggedFrame != NULL, @"the captured sample fixture contains two disjoint issued region tags");
    if (taggedFrame) {
        [sink write:taggedFrame callbackTime:mach_absolute_time()];
        CFRelease(taggedFrame);
    }
    CMSampleBufferRef untaggedFrame = sampleBGRA(sourcePixels, sourceWidth, sourceHeight,
        CGRectMake(0, 0, sourceWidth, sourceHeight));
    if (untaggedFrame) {
        [sink write:untaggedFrame callbackTime:mach_absolute_time()];
        CFRelease(untaggedFrame);
    }
    NSMutableData *partialPixels = [taggedPixels mutableCopy];
    for (size_t y = 0; y < 192; y++) for (size_t x = 100; x < 200; x++) {
        uint8_t *pixel = (uint8_t *)partialPixels.mutableBytes + y * sourceStride + x * 4;
        pixel[0] = pixel[1] = pixel[2] = pixel[3] = 255;
    }
    CMSampleBufferRef partialFrame = sampleBGRA(partialPixels, sourceWidth, sourceHeight,
        CGRectMake(0, 0, sourceWidth, sourceHeight));
    if (partialFrame) {
        [sink write:partialFrame callbackTime:mach_absolute_time()];
        CFRelease(partialFrame);
    }
    [partialPixels release];
    CMSampleBufferRef unissuedFrame = sampleBGRA(secondTaggedPixels, sourceWidth, sourceHeight,
        CGRectMake(0, 0, sourceWidth, sourceHeight));
    if (unissuedFrame) {
        [sink write:unissuedFrame callbackTime:mach_absolute_time()];
        CFRelease(unissuedFrame);
    }
    sp_image_capture_identity secondIssuedIdentity = { 59, 61, 67 };
    NSString *secondIssuedCode = nil, *secondCodeError = nil;
    BOOL secondCodeIssued = sp_image_capture_match_identity_issue(regionToken, secondIssuedIdentity,
        &secondIssuedCode, &identityError);
    free(identityError); identityError = NULL;
    CGColorSpaceRef ambiguityColor = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGImageRef firstSmallImage = NULL, secondSmallImage = NULL;
    NSData *firstSmallCode = nil, *secondSmallCode = nil;
    NSString *firstSmallPayload = nil, *firstSmallError = nil, *secondSmallPayload = nil;
    CGRect firstSmallROI = CGRectMake(8, 0, 96, 96), secondSmallROI = CGRectMake(104, 96, 96, 96);
    BOOL ambiguityPrepared = secondCodeIssued && ambiguityColor
        && sp_capture_frame_identity_encode(sourceBytes, sourceWidth, sourceHeight, sourceStride, ambiguityColor,
            firstSmallROI, firstRegionNonce, (SPCaptureFrameIdentity){ identity.generation, identity.raster, identity.sequence },
            &firstSmallImage, &firstSmallCode, &firstSmallPayload, &firstSmallError)
        && sp_capture_frame_identity_encode(sourceBytes, sourceWidth, sourceHeight, sourceStride, ambiguityColor,
            secondSmallROI, firstRegionNonce, (SPCaptureFrameIdentity){ secondIssuedIdentity.generation, secondIssuedIdentity.raster,
                secondIssuedIdentity.sequence }, &secondSmallImage, &secondSmallCode, &secondSmallPayload, &secondCodeError);
    NSMutableData *ambiguousPixels = [firstSmallCode mutableCopy];
    if (ambiguityPrepared) for (size_t y = 96; y < 192; y++)
        memcpy((uint8_t *)ambiguousPixels.mutableBytes + y * sourceStride + 104 * 4,
            (const uint8_t *)secondSmallCode.bytes + y * sourceStride + 104 * 4, 96 * 4);
    check(ambiguityPrepared, [NSString stringWithFormat:@"two independently issued codes fit inside one expected ROI (%@, %@)",
        firstSmallError ?: @"", secondCodeError ?: @""]);
    CMSampleBufferRef ambiguousFrame = ambiguityPrepared
        ? sampleBGRA(ambiguousPixels, sourceWidth, sourceHeight, CGRectMake(0, 0, sourceWidth, sourceHeight)) : NULL;
    if (ambiguousFrame) {
        [sink write:ambiguousFrame callbackTime:mach_absolute_time()];
        CFRelease(ambiguousFrame);
    }
    [ambiguousPixels release];
    [secondIssuedCode release]; [secondCodeError release];
    if (firstSmallImage) CGImageRelease(firstSmallImage);
    if (secondSmallImage) CGImageRelease(secondSmallImage);
    [firstSmallCode release]; [secondSmallCode release];
    [firstSmallPayload release]; [firstSmallError release]; [secondSmallPayload release];
    [firstRegionNonce release];
    if (ambiguityColor) CGColorSpaceRelease(ambiguityColor);
    uint8_t duplicateRegionToken[16] = {9, 10, 11, 12};
    sp_image_capture_identity duplicateIdentity = { 43, 47, 53 };
    NSString *duplicateNonce = nil, *duplicateIssued = nil, *duplicateEncoded = nil, *duplicateError = nil;
    CGColorSpaceRef duplicateColor = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGImageRef duplicateImage = NULL;
    NSData *duplicatePixels = nil;
    BOOL duplicatePrepared = duplicateColor
        && sp_image_capture_match_identity_region_nonce(duplicateRegionToken, &duplicateNonce, &identityError)
        && sp_image_capture_match_identity_issue(duplicateRegionToken, duplicateIdentity, &duplicateIssued, &identityError)
        && sp_image_capture_match_retain(duplicateIdentity, sourceBytes, sourceWidth, sourceHeight, sourceStride,
            CGRectMake(0, 0, sourceWidth, sourceHeight), 1, "kCGColorSpaceSRGB")
        && sp_capture_frame_identity_encode(sourceBytes, sourceWidth, sourceHeight, sourceStride, duplicateColor,
            tagROI, duplicateNonce, (SPCaptureFrameIdentity){ duplicateIdentity.generation, duplicateIdentity.raster, duplicateIdentity.sequence },
            &duplicateImage, &duplicatePixels, &duplicateEncoded, &duplicateError)
        && [duplicateIssued isEqualToString:duplicateEncoded]
        && sp_image_capture_match_identity_record(duplicateRegionToken, duplicateIdentity, tagROI, duplicatePixels.bytes,
            sourceWidth, sourceHeight, sourceStride, "kCGColorSpaceSRGB", &identityError);
    check(duplicatePrepared, [NSString stringWithFormat:@"the overlapping region fixture has a distinct issued tag (%s, %@)",
        identityError ?: "", duplicateError ?: @""]);
    free(identityError); identityError = NULL;
    [duplicateNonce release]; [duplicateIssued release]; [duplicateEncoded release]; [duplicateError release];
    if (duplicateImage) CGImageRelease(duplicateImage);
    if (duplicateColor) CGColorSpaceRelease(duplicateColor);
    CMSampleBufferRef duplicateFrame = sampleBGRA(taggedPixels, sourceWidth, sourceHeight,
        CGRectMake(0, 0, sourceWidth, sourceHeight));
    if (duplicateFrame) {
        [sink write:duplicateFrame callbackTime:mach_absolute_time()];
        CFRelease(duplicateFrame);
    }
    BOOL evicted = sp_image_capture_match_identity_evict(secondRegionToken, secondIdentity, &identityError);
    check(evicted, [NSString stringWithFormat:@"the second region payload can be explicitly evicted (%s)", identityError ?: ""]);
    free(identityError); identityError = NULL;
    CMSampleBufferRef retiredFrame = sampleBGRA(secondTaggedPixels, sourceWidth, sourceHeight,
        CGRectMake(sourceWidth, 0, sourceWidth, sourceHeight));
    if (retiredFrame) {
        [sink write:retiredFrame callbackTime:mach_absolute_time()];
        CFRelease(retiredFrame);
    }
    dispatch_sync(captureWriter, ^{});
    NSDictionary *record = sink.callbackStatusTrace.lastObject;
    check([record[@"frame"] isEqual:@"frame-0008.bgra"] && sink.written == 8,
        @"the ordinary raw sample frame remains recorded in its existing path");
    check(finalizeCaptureArtifacts(sink), @"the capture finalizes its identity artifact without changing the raw path");
    NSString *decodedPath = [directory stringByAppendingPathComponent:@"frame-identities/decoded-frames.jsonl"];
    NSData *decoded = [NSData dataWithContentsOfFile:decodedPath];
    check(decoded.length > 0, @"capture finalization writes decoded sample identity records separately");
    NSString *decodedText = decoded ? [[NSString alloc] initWithData:decoded encoding:NSUTF8StringEncoding] : nil;
    NSArray<NSString *> *decodedLines = [decodedText componentsSeparatedByString:@"\n"];
    NSMutableArray<NSDictionary *> *decodedRecords = [NSMutableArray array];
    for (NSString *line in decodedLines) if (line.length) {
        NSDictionary *item = [NSJSONSerialization JSONObjectWithData:[line dataUsingEncoding:NSUTF8StringEncoding]
            options:NSJSONReadingFragmentsAllowed error:nil];
        if (item) [decodedRecords addObject:item];
    }
    NSPredicate *frameOneUnknown = [NSPredicate predicateWithBlock:^BOOL(NSDictionary *item, NSDictionary *bindings) {
        (void)bindings; return [item[@"frame"] isEqual:@1] && [item[@"reason"] isEqual:@"unknown-geometry"];
    }];
    NSArray *frameOne = [decodedRecords filteredArrayUsingPredicate:frameOneUnknown];
    check(frameOne.count == 2,
        @"a sample without a mapped source region reports unknown geometry instead of inferring identity");
    NSPredicate *frameTwoMatched = [NSPredicate predicateWithBlock:^BOOL(NSDictionary *item, NSDictionary *bindings) {
        (void)bindings; return [item[@"frame"] isEqual:@2] && [item[@"status"] isEqual:@"matched"];
    }];
    NSArray *frameTwo = [decodedRecords filteredArrayUsingPredicate:frameTwoMatched];
    check(frameTwo.count == 2 && [frameTwo valueForKeyPath:@"identity.generation"]
        && [[NSSet setWithArray:[frameTwo valueForKeyPath:@"identity.generation"]] isEqualToSet:[NSSet setWithArray:@[@"19", @"31"]]],
        @"separate disjoint ROIs decode each region-scoped issued identity");
    NSPredicate *frameThreeNoCode = [NSPredicate predicateWithBlock:^BOOL(NSDictionary *item, NSDictionary *bindings) {
        (void)bindings; return [item[@"frame"] isEqual:@3] && [item[@"reason"] isEqual:@"no-code"];
    }];
    check([decodedRecords filteredArrayUsingPredicate:frameThreeNoCode].count == 1,
        @"a missing tag produces an explicit no-code result");
    NSPredicate *frameFourUnissued = [NSPredicate predicateWithBlock:^BOOL(NSDictionary *item, NSDictionary *bindings) {
        (void)bindings; return [item[@"frame"] isEqual:@5] && [item[@"reason"] isEqual:@"unissued"];
    }];
    check([decodedRecords filteredArrayUsingPredicate:frameFourUnissued].count == 1,
        @"a valid QR issued for another region is reported as unissued");
    NSPredicate *frameFourPartial = [NSPredicate predicateWithBlock:^BOOL(NSDictionary *item, NSDictionary *bindings) {
        (void)bindings; return [item[@"frame"] isEqual:@4] && [item[@"status"] isEqual:@"unknown"];
    }];
    check([decodedRecords filteredArrayUsingPredicate:frameFourPartial].count == 2,
        @"a cropped partial tag remains an explicit unknown result");
    NSPredicate *frameSixAmbiguous = [NSPredicate predicateWithBlock:^BOOL(NSDictionary *item, NSDictionary *bindings) {
        (void)bindings; return [item[@"frame"] isEqual:@6] && [item[@"reason"] isEqual:@"ambiguous"];
    }];
    check([decodedRecords filteredArrayUsingPredicate:frameSixAmbiguous].count == 1,
        @"multiple complete codes inside one expected ROI are ambiguous");
    NSPredicate *frameFiveDuplicate = [NSPredicate predicateWithBlock:^BOOL(NSDictionary *item, NSDictionary *bindings) {
        (void)bindings; return [item[@"frame"] isEqual:@7] && [item[@"reason"] isEqual:@"duplicate-roi"];
    }];
    check([decodedRecords filteredArrayUsingPredicate:frameFiveDuplicate].count == 2,
        @"two regions claiming the same captured ROI are both unknown instead of sharing one code");
    NSPredicate *frameSixRetention = [NSPredicate predicateWithBlock:^BOOL(NSDictionary *item, NSDictionary *bindings) {
        (void)bindings; return [item[@"frame"] isEqual:@8] && [item[@"reason"] isEqual:@"unknown-retention"];
    }];
    check([decodedRecords filteredArrayUsingPredicate:frameSixRetention].count == 1,
        @"an evicted source payload is classified as unknown retention rather than a match");
    check([sink.callbackStatusTrace.lastObject[@"imageMatch"][@"state"] isEqual:@"unmatched"],
        @"QR bytes do not relax the exact source matcher");
    [decodedText release];
    [taggedPixels release];
    [secondTaggedPixels release];
    [duplicatePixels release];
    sp_image_capture_match_end();
    [sink release];
    [captureSink release]; captureSink = nil;

    NSString *retentionDirectory = [directory stringByAppendingPathComponent:@"retention"];
    sp_image_capture_match_begin(retentionDirectory.fileSystemRepresentation, captureWriter);
    identityError = NULL;
    BOOL retentionSessionStarted = sp_image_capture_match_identity_session_begin(&identityError);
    sp_image_capture_match_drop();
    SPCapture *retentionSink = [SPCapture new];
    retentionSink.directory = retentionDirectory;
    retentionSink.statuses = statuses;
    captureSink = [retentionSink retain];
    clearCaptureError(); captureBefore = 0; captureStartedAt = 0;
    NSData *smallPixels = [NSMutableData dataWithLength:8 * 4 * 4];
    CMSampleBufferRef retentionFrame = sampleBGRA(smallPixels, 8, 4, CGRectMake(0, 0, 4, 2));
    if (retentionFrame) { [retentionSink write:retentionFrame callbackTime:mach_absolute_time()]; CFRelease(retentionFrame); }
    dispatch_sync(captureWriter, ^{});
    BOOL retentionFinalized = finalizeCaptureArtifacts(retentionSink);
    NSData *retentionData = [NSData dataWithContentsOfFile:
        [retentionDirectory stringByAppendingPathComponent:@"frame-identities/decoded-frames.jsonl"]];
    NSDictionary *retentionRecord = retentionData ? [NSJSONSerialization JSONObjectWithData:retentionData
        options:NSJSONReadingFragmentsAllowed error:nil] : nil;
    check(retentionSessionStarted && retentionFinalized
        && [retentionRecord[@"reason"] isEqual:@"unknown-retention"],
        @"source-history loss emits an explicit unknown-retention record");
    free(identityError);
    sp_image_capture_match_end();
    [retentionSink release]; [captureSink release]; captureSink = nil;

    NSString *failedDirectory = [directory stringByAppendingPathComponent:@"decode-write-failure"];
    sp_image_capture_match_begin(failedDirectory.fileSystemRepresentation, captureWriter);
    identityError = NULL;
    BOOL failedSessionStarted = sp_image_capture_match_identity_session_begin(&identityError);
    NSString *identityDirectory = [failedDirectory stringByAppendingPathComponent:@"frame-identities"];
    NSError *directoryError = nil;
    BOOL identityDirectoryCreated = [NSFileManager.defaultManager createDirectoryAtPath:identityDirectory
        withIntermediateDirectories:YES attributes:nil error:&directoryError];
    BOOL identityDirectoryLocked = chmod(identityDirectory.fileSystemRepresentation, 0500) == 0;
    SPCapture *failedSink = [SPCapture new];
    failedSink.directory = failedDirectory;
    failedSink.statuses = statuses;
    captureSink = [failedSink retain];
    clearCaptureError(); captureBefore = 0; captureStartedAt = 0;
    CMSampleBufferRef failedFrame = sampleBGRA(smallPixels, 8, 4, CGRectMake(0, 0, 4, 2));
    if (failedFrame) { [failedSink write:failedFrame callbackTime:mach_absolute_time()]; CFRelease(failedFrame); }
    dispatch_sync(captureWriter, ^{});
    BOOL failedFinalize = finalizeCaptureArtifacts(failedSink);
    NSString *finalError = [NSString stringWithUTF8String:sp_capture_error()];
    BOOL identityDirectoryUnlocked = chmod(identityDirectory.fileSystemRepresentation, 0700) == 0;
    check(failedSessionStarted && identityDirectoryCreated && identityDirectoryLocked && !failedFinalize
        && [finalError containsString:@"frame identity decode artifact write failed"] && identityDirectoryUnlocked,
        [NSString stringWithFormat:@"a decoded-frame artifact write error fails finalization (%@, %@)",
            finalError, directoryError.localizedDescription ?: @""]);
    free(identityError);
    sp_image_capture_match_end();
    [failedSink release]; [captureSink release]; captureSink = nil;

    [directory release];
    if (capturePending) dispatch_release(capturePending); capturePending = NULL;
    if (captureFirstFrame) dispatch_release(captureFirstFrame); captureFirstFrame = NULL;
    if (captureWriter) dispatch_release(captureWriter); captureWriter = NULL;
    fprintf(stderr, "%s: native capture frame identity recording (%.3fs)\n",
        failures == 0 ? "PASS" : "FAIL", CACurrentMediaTime() - began);
    return failures ? 1 : 0;
} }
