// Checks that the stills of an opt-in identity recording record a separate decoded identity result without changing raw frames.
// The test hands images to the still processing of the recording (processStill) as the window server would give them, with
// the screen rectangle that each image covers, so it needs no display.
#import "../src/capture.m"
#import "../src/capture_frame_identity.h"
#import "support/temporary_folder.h"

static int failures;
static void check(BOOL condition, NSString *label) {
    fprintf(stderr, "%s: %s\n", condition ? "PASS" : "FAIL", label.UTF8String);
    if (!condition) failures++;
}

// An sRGB BGRA image of pixels, the format in which the recording draws every still.
static CGImageRef imageBGRA(NSData *pixels, size_t width, size_t height) {
    CGColorSpaceRef colorSpace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGDataProviderRef provider = CGDataProviderCreateWithCFData((CFDataRef)pixels);
    CGImageRef image = colorSpace && provider ? CGImageCreate(width, height, 8, 32, width * 4, colorSpace,
        (CGBitmapInfo)kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little, provider, NULL, false,
        kCGRenderingIntentDefault) : NULL;
    if (provider) CGDataProviderRelease(provider);
    if (colorSpace) CGColorSpaceRelease(colorSpace);
    return image;
}

// A recording of planned stills in directory, without a window: the stills are handed to it by stillImage.
static SPCaptureRecording *makeRecording(NSString *directory, NSUInteger planned) {
    SPCaptureRecording *recording = [[SPCaptureRecording alloc] init];
    mach_timebase_info_data_t timebase;
    mach_timebase_info(&timebase);
    recording.session = @"capture-frame-identity-test";
    recording.directory = directory;
    recording.windowNumber = 1;
    recording.gap = 1;
    recording.planned = planned;
    recording.timebase = timebase;
    recording.gapTicks = 1e6 * timebase.denom / timebase.numer;
    for (NSUInteger index = 0; index < planned; index++)
        [recording.rows addObject:[NSMutableDictionary dictionaryWithDictionary:@{ @"index": @(index), @"outcome": @"not-requested" }]];
    return recording;
}

// Hands still index the image of pixels covering screen, as the window server gives it at the request of that still.
static BOOL stillImage(SPCaptureRecording *recording, NSUInteger index, NSData *pixels, size_t width, size_t height, CGRect screen) {
    CGImageRef image = imageBGRA(pixels, width, height);
    if (image == NULL) return NO;
    SPCaptureTarget *target = [[[SPCaptureTarget alloc] init] autorelease];
    target.display = YES;
    target.request = screen;
    target.screen = screen;
    uint64_t requested = captureTicks(), completed = captureTicks();
    @synchronized (recording) {
        recording.nextIndex = MAX(recording.nextIndex, index + 1);
        recording.rows[index][@"requested"] = tickString(requested);
        recording.rows[index][@"completed"] = tickString(completed);
    }
    processStill(recording, index, target, image, requested, completed);
    CGImageRelease(image);
    return YES;
}

int main(void) { @autoreleasepool {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: native capture frame identity recording\n");
    [NSApplication sharedApplication];
    NSString *directory = temporaryFolder(@"soksak-frame-identity-capture-");
    prepareCaptureQueues();

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
    SPCaptureRecording *sink = makeRecording(directory, 8);
    clearCaptureError();

    // A still of an empty image, whose screen rectangle holds no retained source.
    check(stillImage(sink, 0, [NSMutableData dataWithLength:8 * 4 * 4], 8, 4, CGRectMake(0, 0, 4, 2)),
        @"the still of an empty image is handed to the recording");
    NSMutableData *composite = [NSMutableData dataWithLength:sourceStride * sourceHeight * 2];
    for (size_t y = 0; y < sourceHeight; y++) {
        memcpy((uint8_t *)composite.mutableBytes + y * sourceStride * 2,
            (const uint8_t *)taggedPixels.bytes + y * sourceStride, sourceStride);
        memcpy((uint8_t *)composite.mutableBytes + y * sourceStride * 2 + sourceStride,
            (const uint8_t *)secondTaggedPixels.bytes + y * sourceStride, sourceStride);
    }
    check(stillImage(sink, 1, composite, sourceWidth * 2, sourceHeight, CGRectMake(0, 0, sourceWidth * 2, sourceHeight)),
        @"the captured still fixture contains two disjoint issued region tags");
    stillImage(sink, 2, sourcePixels, sourceWidth, sourceHeight, CGRectMake(0, 0, sourceWidth, sourceHeight));
    NSMutableData *partialPixels = [taggedPixels mutableCopy];
    for (size_t y = 0; y < 192; y++) for (size_t x = 100; x < 200; x++) {
        uint8_t *pixel = (uint8_t *)partialPixels.mutableBytes + y * sourceStride + x * 4;
        pixel[0] = pixel[1] = pixel[2] = pixel[3] = 255;
    }
    stillImage(sink, 3, partialPixels, sourceWidth, sourceHeight, CGRectMake(0, 0, sourceWidth, sourceHeight));
    [partialPixels release];
    stillImage(sink, 4, secondTaggedPixels, sourceWidth, sourceHeight, CGRectMake(0, 0, sourceWidth, sourceHeight));
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
    if (ambiguityPrepared) stillImage(sink, 5, ambiguousPixels, sourceWidth, sourceHeight, CGRectMake(0, 0, sourceWidth, sourceHeight));
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
    stillImage(sink, 6, taggedPixels, sourceWidth, sourceHeight, CGRectMake(0, 0, sourceWidth, sourceHeight));
    BOOL evicted = sp_image_capture_match_identity_evict(secondRegionToken, secondIdentity, &identityError);
    check(evicted, [NSString stringWithFormat:@"the second region payload can be explicitly evicted (%s)", identityError ?: ""]);
    free(identityError); identityError = NULL;
    stillImage(sink, 7, secondTaggedPixels, sourceWidth, sourceHeight, CGRectMake(sourceWidth, 0, sourceWidth, sourceHeight));
    dispatch_sync(captureWriter, ^{});
    NSDictionary *record = sink.rows.lastObject;
    check([record[@"frame"] isEqual:@"frame-0007.bgra"] && sink.written == 8,
        @"the ordinary raw still frames remain recorded in their existing path");
    check(finalizeCaptureArtifacts(sink), @"the capture finalizes its identity artifact without changing the raw path");
    NSString *decodedPath = [directory stringByAppendingPathComponent:@"frame-identities/decoded-frames.jsonl"];
    NSData *decoded = [NSData dataWithContentsOfFile:decodedPath];
    check(decoded.length > 0, @"capture finalization writes decoded still identity records separately");
    NSString *decodedText = decoded ? [[NSString alloc] initWithData:decoded encoding:NSUTF8StringEncoding] : nil;
    NSArray<NSString *> *decodedLines = [decodedText componentsSeparatedByString:@"\n"];
    NSMutableArray<NSDictionary *> *decodedRecords = [NSMutableArray array];
    for (NSString *line in decodedLines) if (line.length) {
        NSDictionary *item = [NSJSONSerialization JSONObjectWithData:[line dataUsingEncoding:NSUTF8StringEncoding]
            options:NSJSONReadingFragmentsAllowed error:nil];
        if (item) [decodedRecords addObject:item];
    }
    NSPredicate *frameOneUnknown = [NSPredicate predicateWithBlock:^BOOL(NSDictionary *item, NSDictionary *bindings) {
        (void)bindings; return [item[@"index"] isEqual:@0] && [item[@"reason"] isEqual:@"unknown-geometry"];
    }];
    NSArray *frameOne = [decodedRecords filteredArrayUsingPredicate:frameOneUnknown];
    check(frameOne.count == 2,
        @"a still without a mapped source region reports unknown geometry instead of inferring identity");
    NSPredicate *frameTwoMatched = [NSPredicate predicateWithBlock:^BOOL(NSDictionary *item, NSDictionary *bindings) {
        (void)bindings; return [item[@"index"] isEqual:@1] && [item[@"status"] isEqual:@"matched"];
    }];
    NSArray *frameTwo = [decodedRecords filteredArrayUsingPredicate:frameTwoMatched];
    check(frameTwo.count == 2 && [frameTwo valueForKeyPath:@"identity.generation"]
        && [[NSSet setWithArray:[frameTwo valueForKeyPath:@"identity.generation"]] isEqualToSet:[NSSet setWithArray:@[@"19", @"31"]]],
        @"separate disjoint ROIs decode each region-scoped issued identity");
    NSPredicate *frameThreeNoCode = [NSPredicate predicateWithBlock:^BOOL(NSDictionary *item, NSDictionary *bindings) {
        (void)bindings; return [item[@"index"] isEqual:@2] && [item[@"reason"] isEqual:@"no-code"];
    }];
    check([decodedRecords filteredArrayUsingPredicate:frameThreeNoCode].count == 1,
        @"a missing tag produces an explicit no-code result");
    NSPredicate *frameFourUnissued = [NSPredicate predicateWithBlock:^BOOL(NSDictionary *item, NSDictionary *bindings) {
        (void)bindings; return [item[@"index"] isEqual:@4] && [item[@"reason"] isEqual:@"unissued"];
    }];
    check([decodedRecords filteredArrayUsingPredicate:frameFourUnissued].count == 1,
        @"a valid QR issued for another region is reported as unissued");
    NSPredicate *frameFourPartial = [NSPredicate predicateWithBlock:^BOOL(NSDictionary *item, NSDictionary *bindings) {
        (void)bindings; return [item[@"index"] isEqual:@3] && [item[@"status"] isEqual:@"unknown"];
    }];
    check([decodedRecords filteredArrayUsingPredicate:frameFourPartial].count == 2,
        @"a cropped partial tag remains an explicit unknown result");
    NSPredicate *frameSixAmbiguous = [NSPredicate predicateWithBlock:^BOOL(NSDictionary *item, NSDictionary *bindings) {
        (void)bindings; return [item[@"index"] isEqual:@5] && [item[@"reason"] isEqual:@"ambiguous"];
    }];
    check([decodedRecords filteredArrayUsingPredicate:frameSixAmbiguous].count == 1,
        @"multiple complete codes inside one expected ROI are ambiguous");
    NSPredicate *frameFiveDuplicate = [NSPredicate predicateWithBlock:^BOOL(NSDictionary *item, NSDictionary *bindings) {
        (void)bindings; return [item[@"index"] isEqual:@6] && [item[@"reason"] isEqual:@"duplicate-roi"];
    }];
    check([decodedRecords filteredArrayUsingPredicate:frameFiveDuplicate].count == 2,
        @"two regions claiming the same captured ROI are both unknown instead of sharing one code");
    NSPredicate *frameSixRetention = [NSPredicate predicateWithBlock:^BOOL(NSDictionary *item, NSDictionary *bindings) {
        (void)bindings; return [item[@"index"] isEqual:@7] && [item[@"reason"] isEqual:@"unknown-retention"];
    }];
    check([decodedRecords filteredArrayUsingPredicate:frameSixRetention].count == 1,
        @"an evicted source payload is classified as unknown retention rather than a match");
    check([sink.rows.lastObject[@"imageMatch"][@"state"] isEqual:@"unmatched"],
        @"QR bytes do not relax the exact source matcher");
    [decodedText release];
    [taggedPixels release];
    [secondTaggedPixels release];
    [duplicatePixels release];
    sp_image_capture_match_end();
    [sink release];

    NSString *retentionDirectory = [directory stringByAppendingPathComponent:@"retention"];
    check([[NSFileManager defaultManager] createDirectoryAtPath:retentionDirectory
        withIntermediateDirectories:YES attributes:nil error:nil], @"the retention capture directory exists before the first still");
    sp_image_capture_match_begin(retentionDirectory.fileSystemRepresentation, captureWriter);
    identityError = NULL;
    BOOL retentionSessionStarted = sp_image_capture_match_identity_session_begin(&identityError);
    sp_image_capture_match_drop();
    SPCaptureRecording *retentionSink = makeRecording(retentionDirectory, 1);
    clearCaptureError();
    NSData *smallPixels = [NSMutableData dataWithLength:8 * 4 * 4];
    stillImage(retentionSink, 0, smallPixels, 8, 4, CGRectMake(0, 0, 4, 2));
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
    [retentionSink release];

    NSString *historyEvictionDirectory = [directory stringByAppendingPathComponent:@"history-eviction"];
    sp_image_capture_match_begin(historyEvictionDirectory.fileSystemRepresentation, captureWriter);
    identityError = NULL;
    BOOL historyEvictionSessionStarted = sp_image_capture_match_identity_session_begin(&identityError);
    const size_t evictionWidth = 192, evictionHeight = 192, evictionStride = evictionWidth * 4;
    const size_t evictionByteCount = evictionStride * evictionHeight;
    NSMutableData *evictionSource = [NSMutableData dataWithLength:evictionByteCount];
    uint8_t *evictionSourceBytes = evictionSource.mutableBytes;
    for (size_t pixel = 0; pixel < evictionWidth * evictionHeight; pixel++) {
        evictionSourceBytes[pixel * 4] = 90;
        evictionSourceBytes[pixel * 4 + 1] = 110;
        evictionSourceBytes[pixel * 4 + 2] = 130;
        evictionSourceBytes[pixel * 4 + 3] = 255;
    }
    uint8_t evictionRegionToken[16] = {21, 22, 23, 24};
    sp_image_capture_identity evictionIdentity = {73, 79, 83};
    NSString *evictionNonce = nil, *evictionIssued = nil, *evictionEncoded = nil, *evictionEncodeError = nil;
    uint8_t retiredRegionToken[16] = {25, 26, 27, 28};
    sp_image_capture_identity retiredIdentity = {73, 79, 89};
    NSString *retiredNonce = nil, *retiredIssued = nil, *retiredEncoded = nil, *retiredEncodeError = nil;
    CGColorSpaceRef evictionColorSpace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGImageRef evictionImage = NULL, retiredImage = NULL;
    NSData *evictionTaggedPixels = nil, *retiredTaggedPixels = nil;
    BOOL evictionSourceReady = historyEvictionSessionStarted && evictionColorSpace
        && sp_image_capture_match_retain(evictionIdentity, evictionSourceBytes, evictionWidth, evictionHeight,
            evictionStride, CGRectMake(0, 0, evictionWidth, evictionHeight), 1, "kCGColorSpaceSRGB")
        && sp_image_capture_match_identity_region_nonce(evictionRegionToken, &evictionNonce, &identityError)
        && sp_image_capture_match_identity_issue(evictionRegionToken, evictionIdentity, &evictionIssued, &identityError)
        && sp_capture_frame_identity_encode(evictionSourceBytes, evictionWidth, evictionHeight, evictionStride,
            evictionColorSpace, CGRectMake(0, 0, evictionWidth, evictionHeight), evictionNonce,
            (SPCaptureFrameIdentity){ evictionIdentity.generation, evictionIdentity.raster, evictionIdentity.sequence },
            &evictionImage, &evictionTaggedPixels, &evictionEncoded, &evictionEncodeError)
        && [evictionIssued isEqualToString:evictionEncoded]
        && sp_image_capture_match_identity_record(evictionRegionToken, evictionIdentity,
            CGRectMake(0, 0, evictionWidth, evictionHeight), evictionTaggedPixels.bytes,
            evictionWidth, evictionHeight, evictionStride, "kCGColorSpaceSRGB", &identityError);
    BOOL retiredSourceReady = evictionSourceReady
        && sp_image_capture_match_retain(retiredIdentity, evictionSourceBytes, evictionWidth, evictionHeight,
            evictionStride, CGRectMake(evictionWidth, 0, evictionWidth, evictionHeight), 1, "kCGColorSpaceSRGB")
        && sp_image_capture_match_identity_region_nonce(retiredRegionToken, &retiredNonce, &identityError)
        && sp_image_capture_match_identity_issue(retiredRegionToken, retiredIdentity, &retiredIssued, &identityError)
        && sp_capture_frame_identity_encode(evictionSourceBytes, evictionWidth, evictionHeight, evictionStride,
            evictionColorSpace, CGRectMake(0, 0, evictionWidth, evictionHeight), retiredNonce,
            (SPCaptureFrameIdentity){ retiredIdentity.generation, retiredIdentity.raster, retiredIdentity.sequence },
            &retiredImage, &retiredTaggedPixels, &retiredEncoded, &retiredEncodeError)
        && [retiredIssued isEqualToString:retiredEncoded]
        && sp_image_capture_match_identity_record(retiredRegionToken, retiredIdentity,
            CGRectMake(0, 0, evictionWidth, evictionHeight), retiredTaggedPixels.bytes,
            evictionWidth, evictionHeight, evictionStride, "kCGColorSpaceSRGB", &identityError);
    BOOL retiredSourceEvicted = retiredSourceReady
        && sp_image_capture_match_identity_evict(retiredRegionToken, retiredIdentity, &identityError);
    evictionSourceReady = evictionSourceReady && retiredSourceEvicted;
    check(evictionSourceReady, [NSString stringWithFormat:@"the artifact-backed tag source is prepared (%s, %@)",
        identityError ?: "", evictionEncodeError ?: retiredEncodeError ?: @""]);
    free(identityError); identityError = NULL;
    if (evictionImage) CGImageRelease(evictionImage);
    if (retiredImage) CGImageRelease(retiredImage);
    if (evictionColorSpace) CGColorSpaceRelease(evictionColorSpace);
    [evictionNonce release]; [evictionIssued release]; [evictionEncoded release]; [evictionEncodeError release];
    [retiredNonce release]; [retiredIssued release]; [retiredEncoded release]; [retiredEncodeError release];
    dispatch_sync(captureWriter, ^{});
    NSMutableData *fillerPixels = [NSMutableData dataWithLength:evictionByteCount];
    uint8_t *fillerBytes = fillerPixels.mutableBytes;
    BOOL filledHistory = evictionSourceReady;
    for (int index = 0; index < 455 && filledHistory; index++) {
        uint8_t color = (uint8_t)(20 + index % 200);
        for (size_t pixel = 0; pixel < evictionWidth * evictionHeight; pixel++) {
            fillerBytes[pixel * 4] = color;
            fillerBytes[pixel * 4 + 1] = 40;
            fillerBytes[pixel * 4 + 2] = 60;
            fillerBytes[pixel * 4 + 3] = 255;
        }
        sp_image_capture_identity fillerIdentity = {73, 79, 100 + index};
        filledHistory = sp_image_capture_match_retain(fillerIdentity, fillerBytes, evictionWidth, evictionHeight,
            evictionStride, CGRectMake(0, 0, evictionWidth, evictionHeight), 1, "kCGColorSpaceSRGB");
        if (filledHistory) dispatch_sync(captureWriter, ^{});
    }
    check(filledHistory, @"ordinary source snapshots cross the 64 MiB pixel-history eviction boundary");
    SPCaptureRecording *historyEvictionSink = makeRecording(historyEvictionDirectory, 2);
    clearCaptureError();
    NSMutableData *historyEvictionPixels = [NSMutableData dataWithLength:evictionStride * 2 * evictionHeight];
    if (evictionTaggedPixels && retiredTaggedPixels) for (size_t row = 0; row < evictionHeight; row++) {
            memcpy((uint8_t *)historyEvictionPixels.mutableBytes + row * evictionStride * 2,
                evictionTaggedPixels.bytes + row * evictionStride, evictionStride);
            memcpy((uint8_t *)historyEvictionPixels.mutableBytes + row * evictionStride * 2 + evictionStride,
                retiredTaggedPixels.bytes + row * evictionStride, evictionStride);
        }
    stillImage(historyEvictionSink, 0, historyEvictionPixels, evictionWidth * 2, evictionHeight,
        CGRectMake(0, 0, evictionWidth * 2, evictionHeight));
    sp_image_capture_match_drop();
    stillImage(historyEvictionSink, 1, historyEvictionPixels, evictionWidth * 2, evictionHeight,
        CGRectMake(0, 0, evictionWidth * 2, evictionHeight));
    dispatch_sync(captureWriter, ^{});
    BOOL historyEvictionFinalized = finalizeCaptureArtifacts(historyEvictionSink);
    NSDictionary *historyEvictionCallback = historyEvictionSink.rows.firstObject;
    BOOL rawMatcherStillUnknown = [historyEvictionCallback[@"imageMatch"][@"state"] isEqual:@"unknown-retention"];
    NSData *historyEvictionDecodedData = [NSData dataWithContentsOfFile:
        [historyEvictionDirectory stringByAppendingPathComponent:@"frame-identities/decoded-frames.jsonl"]];
    NSString *historyEvictionDecodedText = historyEvictionDecodedData
        ? [[NSString alloc] initWithData:historyEvictionDecodedData encoding:NSUTF8StringEncoding] : nil;
    NSMutableArray<NSDictionary *> *historyEvictionDecodedRows = [NSMutableArray array];
    for (NSString *line in [historyEvictionDecodedText componentsSeparatedByString:@"\n"]) if (line.length) {
        NSDictionary *row = [NSJSONSerialization JSONObjectWithData:[line dataUsingEncoding:NSUTF8StringEncoding]
            options:NSJSONReadingFragmentsAllowed error:nil];
        if (row) [historyEvictionDecodedRows addObject:row];
    }
    NSPredicate *historyEvictionMatched = [NSPredicate predicateWithBlock:^BOOL(NSDictionary *row, NSDictionary *bindings) {
        (void)bindings;
        return [row[@"index"] isEqual:@0] && [row[@"status"] isEqual:@"matched"]
            && [row[@"identity"][@"generation"] isEqual:@"73"]
            && [row[@"identity"][@"raster"] isEqual:@"79"]
            && [row[@"identity"][@"sequence"] isEqual:@83]
            && [row[@"region"] isEqual:@"15161718000000000000000000000000"];
    }];
    NSArray<NSDictionary *> *historyEvictionMatches = [historyEvictionDecodedRows filteredArrayUsingPredicate:historyEvictionMatched];
    NSPredicate *historyEvictionRetired = [NSPredicate predicateWithBlock:^BOOL(NSDictionary *row, NSDictionary *bindings) {
        (void)bindings;
        return [row[@"index"] isEqual:@0] && [row[@"status"] isEqual:@"unknown"]
            && [row[@"reason"] isEqual:@"unknown-retention"]
            && [row[@"region"] isEqual:@"191a1b1c000000000000000000000000"]
            && [row[@"roi"] isKindOfClass:[NSDictionary class]] && [row[@"roi"][@"x"] isEqual:@192];
    }];
    NSArray<NSDictionary *> *historyEvictionRetirements = [historyEvictionDecodedRows filteredArrayUsingPredicate:historyEvictionRetired];
    NSPredicate *historyEvictionUnlocated = [NSPredicate predicateWithBlock:^BOOL(NSDictionary *row, NSDictionary *bindings) {
        (void)bindings; return [row[@"status"] isEqual:@"unknown"] && row[@"roi"] == NSNull.null;
    }];
    NSArray<NSDictionary *> *historyEvictionUnlocatedRows = [historyEvictionDecodedRows filteredArrayUsingPredicate:historyEvictionUnlocated];
    NSPredicate *historyEvictionNonEvictionDrop = [NSPredicate predicateWithBlock:^BOOL(NSDictionary *row, NSDictionary *bindings) {
        (void)bindings; return [row[@"index"] isEqual:@1] && [row[@"status"] isEqual:@"unknown"]
            && [row[@"reason"] isEqual:@"unknown-retention"] && row[@"roi"] == NSNull.null;
    }];
    NSArray<NSDictionary *> *historyEvictionNonEvictionRows =
        [historyEvictionDecodedRows filteredArrayUsingPredicate:historyEvictionNonEvictionDrop];
    NSString *historyEvictionError = [NSString stringWithUTF8String:sp_capture_error()];
    check(historyEvictionFinalized && rawMatcherStillUnknown && historyEvictionMatches.count == 1
        && historyEvictionRetirements.count == 1 && historyEvictionUnlocatedRows.count == 1
        && historyEvictionNonEvictionRows.count == 1,
        [NSString stringWithFormat:@"bounded provenance admits history-evicted tags, preserves explicit retirement, and keeps non-eviction loss unknown (%@, rawUnknown=%@, matches=%lu, retired=%lu, unlocated=%lu, nonEviction=%lu)",
            historyEvictionError ?: @"", rawMatcherStillUnknown ? @"YES" : @"NO",
            (unsigned long)historyEvictionMatches.count, (unsigned long)historyEvictionRetirements.count,
            (unsigned long)historyEvictionUnlocatedRows.count, (unsigned long)historyEvictionNonEvictionRows.count]);
    [historyEvictionDecodedText release];
    [evictionTaggedPixels release]; [retiredTaggedPixels release];
    sp_image_capture_match_end();
    [historyEvictionSink release];

    NSString *failedDirectory = [directory stringByAppendingPathComponent:@"decode-write-failure"];
    sp_image_capture_match_begin(failedDirectory.fileSystemRepresentation, captureWriter);
    identityError = NULL;
    BOOL failedSessionStarted = sp_image_capture_match_identity_session_begin(&identityError);
    NSString *identityDirectory = [failedDirectory stringByAppendingPathComponent:@"frame-identities"];
    NSError *directoryError = nil;
    BOOL identityDirectoryCreated = [NSFileManager.defaultManager createDirectoryAtPath:identityDirectory
        withIntermediateDirectories:YES attributes:nil error:&directoryError];
    BOOL identityDirectoryLocked = chmod(identityDirectory.fileSystemRepresentation, 0500) == 0;
    SPCaptureRecording *failedSink = makeRecording(failedDirectory, 1);
    clearCaptureError();
    stillImage(failedSink, 0, smallPixels, 8, 4, CGRectMake(0, 0, 4, 2));
    dispatch_sync(captureWriter, ^{});
    BOOL failedFinalize = finalizeCaptureArtifacts(failedSink);
    NSString *finalError = [NSString stringWithUTF8String:sp_capture_error()];
    BOOL identityDirectoryUnlocked = chmod(identityDirectory.fileSystemRepresentation, 0700) == 0;
    check(failedSessionStarted && identityDirectoryCreated && identityDirectoryLocked && !failedFinalize
        && [finalError containsString:@"frame identity capture failed"]
        && [finalError containsString:@"decoded identity of still 0 could not be appended"] && identityDirectoryUnlocked,
        [NSString stringWithFormat:@"a decoded-frame artifact write error fails finalization (%@, %@)",
            finalError, directoryError.localizedDescription ?: @""]);
    free(identityError);
    sp_image_capture_match_end();
    [failedSink release];
    fprintf(stderr, "%s: native capture frame identity recording (%.3fs)\n",
        failures == 0 ? "PASS" : "FAIL", CACurrentMediaTime() - began);
    return failures ? 1 : 0;
} }
