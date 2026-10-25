#import "../src/image_capture_match.h"
#import "../src/capture_frame_identity.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdatomic.h>

static int failures;
static atomic_uint identityDecodeHookCount;
static dispatch_semaphore_t identityDecodeGateEntered;
static dispatch_semaphore_t identityDecodeSecondEntered;
static dispatch_semaphore_t identityDecodeGateRelease;
static void check(BOOL ok, NSString *label) {
    fprintf(stderr, "%s: %s\n", ok ? "PASS" : "FAIL", label.UTF8String);
    if (!ok) failures++;
}

static bool blockFirstIdentityDecode(void) {
    unsigned index = atomic_fetch_add(&identityDecodeHookCount, 1);
    if (index == 0) {
        dispatch_semaphore_signal(identityDecodeGateEntered);
        dispatch_semaphore_wait(identityDecodeGateRelease, DISPATCH_TIME_FOREVER);
    } else if (index == 1) {
        dispatch_semaphore_signal(identityDecodeSecondEntered);
    }
    return true;
}

static bool failIdentityDecode(void) { return false; }

static bool throwIdentityDecode(void) {
    @throw [NSException exceptionWithName:@"F239146InjectedDecoderException"
        reason:@"controlled QR decoder exception" userInfo:nil];
}

static void frameIdentitySessionChecks(void) {
    const uint8_t regionA[16] = { 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 };
    const uint8_t regionB[16] = { 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 };
    const sp_image_capture_identity identity = { 3, 5, 7 };
    char *error = NULL;
    check(sp_image_capture_match_identity_session_begin(&error) && error == NULL,
        @"an active diagnostic capture starts an identity session");
    free(error); error = NULL;
    check(sp_image_capture_match_identity_prepare_decoder(&error) && error == NULL,
        @"capture identity readiness performs a real QR encode and local decoder decode before sample intake");
    free(error); error = NULL;
    sp_capture_frame_identity_test_set_decode_hook(failIdentityDecode);
    BOOL readinessRejected = !sp_image_capture_match_identity_prepare_decoder(&error)
        && error != NULL && strstr(error, "QR decoder readiness failed") != NULL;
    check(readinessRejected, @"a failed QR decoder readiness decode prevents capture startup with an explicit error");
    free(error); error = NULL;
    sp_capture_frame_identity_test_set_decode_hook(NULL);

    NSString *nonceA = nil, *nonceARepeat = nil, *nonceB = nil;
    check(sp_image_capture_match_identity_region_nonce(regionA, &nonceA, &error) && error == NULL,
        @"an issued region token derives its capture-scoped nonce");
    free(error); error = NULL;
    check(sp_image_capture_match_identity_region_nonce(regionA, &nonceARepeat, &error) && error == NULL
        && [nonceA isEqualToString:nonceARepeat], @"the same region token derives a stable nonce within a session");
    free(error); error = NULL;
    check(sp_image_capture_match_identity_region_nonce(regionB, &nonceB, &error) && error == NULL
        && ![nonceA isEqualToString:nonceB], @"distinct regions receive distinct identity nonces");
    free(error); error = NULL;

    NSString *payloadA = nil, *payloadB = nil;
    check(sp_image_capture_match_identity_issue(regionA, identity, &payloadA, &error) && error == NULL,
        @"the matcher issues an identity payload for a region source");
    free(error); error = NULL;
    check(sp_image_capture_match_identity_issue(regionB, identity, &payloadB, &error) && error == NULL
        && ![payloadA isEqualToString:payloadB], @"the same source tuple in another region has a different payload");
    free(error); error = NULL;
    NSString *payloadARepeat = nil;
    check(sp_image_capture_match_identity_issue(regionA, identity, &payloadARepeat, &error) && error == NULL
        && [payloadA isEqualToString:payloadARepeat], @"reissuing one region source returns the same canonical payload");
    free(error); error = NULL;
    [payloadARepeat release];
    NSSet<NSString *> *issuedA = nil, *issuedB = nil;
    check(sp_image_capture_match_identity_copy_payloads(regionA, &issuedA, &error) && error == NULL
        && [issuedA isEqualToSet:[NSSet setWithObject:payloadA]],
        @"decoder allowlisting contains exactly the issued payload for its region");
    free(error); error = NULL;
    check(sp_image_capture_match_identity_copy_payloads(regionB, &issuedB, &error) && error == NULL
        && [issuedB isEqualToSet:[NSSet setWithObject:payloadB]],
        @"decoder allowlisting is isolated from another region");
    free(error); error = NULL;

    check(sp_image_capture_match_identity_evict(regionA, identity, &error) && error == NULL,
        @"evicting an issued source is an explicit successful operation");
    free(error); error = NULL;
    [issuedA release]; issuedA = nil;
    check(sp_image_capture_match_identity_copy_payloads(regionA, &issuedA, &error) && error == NULL
        && issuedA.count == 0, @"evicting a retained source removes its payload from the decoder allowlist");
    free(error); error = NULL;
    [issuedB release]; issuedB = nil;
    check(sp_image_capture_match_identity_copy_payloads(regionB, &issuedB, &error) && error == NULL
        && [issuedB containsObject:payloadB], @"eviction in one region preserves another region's issued payload");
    free(error); error = NULL;

    bool capacityHeld = true;
    for (int sequence = 100; sequence < 611; sequence++) {
        sp_image_capture_identity next = { 3, 5, sequence };
        NSString *nextPayload = nil;
        if (!sp_image_capture_match_identity_issue(regionA, next, &nextPayload, &error) || error != NULL) {
            capacityHeld = false;
            [nextPayload release]; free(error); error = NULL;
            break;
        }
        [nextPayload release];
    }
    check(capacityHeld, @"the issued identity set accepts entries up to the shared 512-identity bound");
    sp_image_capture_identity overCapacity = { 3, 5, 700 };
    NSString *overCapacityPayload = nil;
    check(!sp_image_capture_match_identity_issue(regionA, overCapacity, &overCapacityPayload, &error)
        && overCapacityPayload == nil && error != NULL && strstr(error, "limit") != NULL,
        @"issuance above the 512-identity bound fails explicitly");
    [overCapacityPayload release]; free(error); error = NULL;
    sp_image_capture_identity releasedCapacity = { 3, 5, 100 };
    check(sp_image_capture_match_identity_evict(regionA, releasedCapacity, &error) && error == NULL,
        @"evicting one bounded identity releases its issued slot");
    free(error); error = NULL;
    check(sp_image_capture_match_identity_issue(regionA, overCapacity, &overCapacityPayload, &error) && error == NULL,
        @"issuance resumes after an identity slot is evicted");
    [overCapacityPayload release]; free(error); error = NULL;

    sp_image_capture_match_identity_session_end();
    [issuedA release]; issuedA = nil;
    [issuedB release]; issuedB = nil;
    [nonceARepeat release]; [nonceB release];
    [payloadA release]; [payloadB release];
    error = NULL;
    check(!sp_image_capture_match_identity_issue(regionA, identity, &payloadA, &error)
        && payloadA == nil && error != NULL, @"an ended session refuses new identity issuance explicitly");
    free(error);
    error = NULL;
    check(sp_image_capture_match_identity_session_begin(&error) && error == NULL,
        @"a stopped identity session can be restarted for a new capture");
    free(error); error = NULL;
    NSString *restartNonce = nil;
    check(sp_image_capture_match_identity_region_nonce(regionA, &restartNonce, &error) && error == NULL
        && ![restartNonce isEqualToString:nonceA], @"a restarted capture receives a fresh region nonce");
    free(error); error = NULL;
    [issuedA release]; issuedA = nil;
    check(sp_image_capture_match_identity_copy_payloads(regionA, &issuedA, &error) && error == NULL
        && issuedA.count == 0, @"a restarted capture has no payloads issued by its predecessor");
    free(error); error = NULL;
    [issuedA release]; [restartNonce release]; [nonceA release];
    sp_image_capture_match_identity_session_end();
}

static void frameIdentityArtifactChecks(void) {
    char directoryTemplate[] = "/tmp/soksak-frame-identity-artifact-XXXXXX";
    char *directory = mkdtemp(directoryTemplate);
    dispatch_queue_t writer = dispatch_queue_create("test.frame-identity.artifact", DISPATCH_QUEUE_SERIAL);
    const uint8_t regionToken[16] = { 9, 8, 7, 6, 5, 4, 3, 2, 1 };
    const size_t width = 256, height = 256, stride = width * 4;
    NSMutableData *raw = [NSMutableData dataWithLength:stride * height];
    memset(raw.mutableBytes, 0x5a, raw.length);
    CGRect roi = CGRectMake((CGFloat)(width - 192), 0, 192, 192);
    sp_image_capture_identity sourceIdentity = { 19, 23, 29 };
    char *identityError = NULL;
    check(directory != NULL, @"the tagged artifact fixture creates its capture directory");
    sp_image_capture_match_begin(directory, writer);
    check(sp_image_capture_match_identity_session_begin(&identityError) && identityError == NULL,
        @"the tagged artifact fixture starts an identity session");
    free(identityError); identityError = NULL;
    check(sp_image_capture_match_retain(sourceIdentity, raw.bytes, width, height, stride,
        CGRectMake(10, 20, 128, 128), 2, "DeviceRGB"), @"the raw source is retained independently");
    NSString *regionNonce = nil, *issuedPayload = nil;
    check(sp_image_capture_match_identity_region_nonce(regionToken, &regionNonce, &identityError)
        && identityError == NULL, @"the artifact region receives its session nonce");
    free(identityError); identityError = NULL;
    check(sp_image_capture_match_identity_issue(regionToken, sourceIdentity, &issuedPayload, &identityError)
        && identityError == NULL, @"the source tuple receives its canonical issued payload");
    free(identityError); identityError = NULL;

    CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
    CGImageRef taggedImage = NULL;
    NSData *taggedPixels = nil;
    NSString *encodedPayload = nil, *encodeError = nil;
    BOOL encoded = sp_capture_frame_identity_encode(raw.bytes, width, height, stride, colorSpace, roi,
        regionNonce, (SPCaptureFrameIdentity){ sourceIdentity.generation, sourceIdentity.raster,
            (uint64_t)sourceIdentity.sequence }, &taggedImage, &taggedPixels, &encodedPayload, &encodeError);
    check(encoded && taggedImage != NULL && taggedPixels.length == raw.length
        && [encodedPayload isEqualToString:issuedPayload], @"the tagged raster carries the exact issued identity");
    check(sp_image_capture_match_identity_record(regionToken, sourceIdentity, roi, taggedPixels.bytes,
        width, height, stride, "DeviceRGB", &identityError) && identityError == NULL,
        @"the tagged raster and region metadata are accepted for the separate artifact");
    free(identityError); identityError = NULL;
    check(sp_image_capture_match_write_manifest(directory),
        @"raw source and tagged identity manifests finalize successfully");
    sp_image_capture_match_end();

    NSString *rawPath = [[NSString stringWithUTF8String:directory]
        stringByAppendingPathComponent:@"sources/19-23-29.bgra"];
    NSDictionary *rawManifest = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:
        [[NSString stringWithUTF8String:directory] stringByAppendingPathComponent:@"sources/manifest.json"]]
        options:0 error:NULL];
    NSDictionary *identityManifest = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:
        [[NSString stringWithUTF8String:directory] stringByAppendingPathComponent:@"frame-identities/manifest.json"]]
        options:0 error:NULL];
    NSArray *taggedRecords = identityManifest[@"artifacts"];
    NSDictionary *taggedRecord = taggedRecords.count == 1 ? taggedRecords[0] : nil;
    NSString *taggedPath = taggedRecord ? [[NSString stringWithUTF8String:directory]
        stringByAppendingPathComponent:[@"frame-identities" stringByAppendingPathComponent:taggedRecord[@"file"]]] : nil;
    NSData *rawArtifact = [NSData dataWithContentsOfFile:rawPath];
    NSData *taggedArtifact = taggedPath ? [NSData dataWithContentsOfFile:taggedPath] : nil;
    check(rawArtifact != nil && [rawArtifact isEqualToData:raw],
        @"the raw source artifact keeps the original untagged BGRA bytes");
    check(taggedArtifact != nil && [taggedArtifact isEqualToData:taggedPixels],
        @"the separate tagged artifact keeps the immutable instrumented BGRA bytes");
    check([rawManifest[@"artifacts"] count] == 1 && taggedRecord != nil
        && [taggedRecord[@"regionToken"] isEqualToString:@"09080706050403020100000000000000"]
        && [taggedRecord[@"nonce"] isEqualToString:regionNonce]
        && [taggedRecord[@"payload"] isEqualToString:issuedPayload]
        && [taggedRecord[@"generation"] isEqualToString:@"19"]
        && [taggedRecord[@"raster"] isEqualToString:@"23"] && [taggedRecord[@"sequence"] intValue] == 29
        && [taggedRecord[@"roi"][@"x"] intValue] == (int)(width - 192)
        && [taggedRecord[@"roi"][@"y"] intValue] == 0,
        @"tagged metadata binds region token, nonce, payload, source tuple, and top-left ROI");
    if (taggedArtifact) {
        BOOL outsideROIMatches = YES;
        for (size_t y = 0; y < height; y++) for (size_t x = 0; x < width; x++) {
            if (x >= (size_t)roi.origin.x && x < (size_t)CGRectGetMaxX(roi)
                && y < (size_t)CGRectGetMaxY(roi)) continue;
            const uint8_t *sourcePixel = (const uint8_t *)raw.bytes + y * stride + x * 4;
            const uint8_t *taggedPixel = (const uint8_t *)taggedArtifact.bytes + y * stride + x * 4;
            if (memcmp(sourcePixel, taggedPixel, 4) != 0) outsideROIMatches = NO;
        }
        check(outsideROIMatches, @"tagged artifact pixels outside the reserved ROI equal the raw artifact");
    }
    [regionNonce release]; [issuedPayload release]; [encodedPayload release]; [encodeError release]; [taggedPixels release];
    if (taggedImage) CGImageRelease(taggedImage);
    if (colorSpace) CGColorSpaceRelease(colorSpace);
    dispatch_release(writer);
    NSError *removeError = nil;
    check([[NSFileManager defaultManager] removeItemAtPath:[NSString stringWithUTF8String:directory]
        error:&removeError], [NSString stringWithFormat:@"the tagged artifact fixture is removed (%@)", removeError]);
}

static void frameIdentityCropByteBoundChecks(void) {
    char directoryTemplate[] = "/tmp/soksak-frame-identity-crop-cap-XXXXXX";
    char *directory = mkdtemp(directoryTemplate);
    dispatch_queue_t writer = dispatch_queue_create("test.frame-identity.crop-cap", DISPATCH_QUEUE_SERIAL);
    const size_t roiSide = 192, sourceStride = roiSide * 4;
    NSMutableData *sourcePixels = [NSMutableData dataWithLength:sourceStride * roiSide];
    memset(sourcePixels.mutableBytes, 0x5a, sourcePixels.length);
    for (size_t offset = 3; offset < sourcePixels.length; offset += 4)
        ((uint8_t *)sourcePixels.mutableBytes)[offset] = 255;
    const size_t columns = 22, count = 456;
    const size_t frameWidth = columns * roiSide, frameHeight = 21 * roiSide, frameStride = frameWidth * 4;
    NSMutableData *samplePixels = [NSMutableData dataWithLength:frameStride * frameHeight];
    CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
    check(directory != NULL && writer != NULL && colorSpace != NULL,
        @"the compact crop byte-bound fixture allocates its matcher resources");
    if (!directory || !writer || !colorSpace) return;
    sp_image_capture_match_begin(directory, writer);
    char *error = NULL;
    BOOL started = sp_image_capture_match_identity_session_begin(&error);
    check(started && error == NULL, @"the crop byte-bound fixture starts an identity session");
    free(error); error = NULL;
    BOOL registered = started;
    for (size_t index = 0; index < count && registered; index++) {
        sp_image_capture_identity identity = { 41, 43, (int)index + 1 };
        uint8_t region[16] = {0};
        memcpy(region, &index, sizeof(index));
        size_t column = index % columns, row = index / columns;
        CGRect bounds = CGRectMake(column * roiSide, row * roiSide, roiSide, roiSide);
        NSString *nonce = nil, *payload = nil;
        registered = sp_image_capture_match_retain(identity, sourcePixels.bytes, roiSide, roiSide,
                sourceStride, bounds, 1, "DeviceRGB")
            && sp_image_capture_match_identity_region_nonce(region, &nonce, &error)
            && sp_image_capture_match_identity_issue(region, identity, &payload, &error)
            && sp_image_capture_match_identity_record(region, identity, CGRectMake(0, 0, roiSide, roiSide),
                sourcePixels.bytes, roiSide, roiSide, sourceStride, "DeviceRGB", &error);
        [nonce release]; [payload release]; free(error); error = NULL;
        if ((index + 1) % 32 == 0) dispatch_sync(writer, ^{});
    }
    dispatch_sync(writer, ^{});
    check(registered, @"456 distinct source regions retain issued artifacts for compact ROI admission");
    error = NULL;
    BOOL admitted = registered && sp_image_capture_match_identity_enqueue_frame(samplePixels.bytes,
        frameWidth, frameHeight, frameStride, colorSpace, CGRectMake(0, 0, frameWidth, frameHeight),
        CGRectMake(0, 0, frameWidth, frameHeight), 1, 1, 1, 1, &error);
    check(!admitted && error != NULL && strstr(error, "pending capacity") != NULL,
        @"compact ROI bytes above the shared 64 MiB pending budget fail explicitly before decoder admission");
    free(error);
    sp_image_capture_match_end();
    CGColorSpaceRelease(colorSpace);
    dispatch_release(writer);
    NSError *removeError = nil;
    check([[NSFileManager defaultManager] removeItemAtPath:[NSString stringWithUTF8String:directory]
        error:&removeError], [NSString stringWithFormat:@"the crop byte-bound fixture is removed (%@)", removeError]);
}

static void frameIdentityDecodeDoesNotBlockSampleQueue(void) {
    char directoryTemplate[] = "/tmp/soksak-frame-identity-queue-XXXXXX";
    char *directory = mkdtemp(directoryTemplate);
    dispatch_queue_t writer = dispatch_queue_create("test.frame-identity.queue-artifact", DISPATCH_QUEUE_SERIAL);
    dispatch_queue_t sampleQueue = dispatch_queue_create("test.frame-identity.sample", DISPATCH_QUEUE_SERIAL);
    const uint8_t regionToken[16] = { 7, 2, 4, 6, 8 };
    const size_t width = 256, height = 256, stride = width * 4;
    NSMutableData *raw = [NSMutableData dataWithLength:stride * height];
    memset(raw.mutableBytes, 0x5a, raw.length);
    const sp_image_capture_identity sourceIdentity = { 19, 23, 29 };
    const CGRect sourceBounds = CGRectMake(0, 0, 128, 128);
    const CGRect roi = CGRectMake(width - 192, 0, 192, 192);
    char *error = NULL;
    check(directory != NULL, @"the callback queue fixture creates its artifact directory");
    sp_image_capture_match_begin(directory, writer);
    check(sp_image_capture_match_identity_session_begin(&error) && error == NULL,
        @"the callback queue fixture starts an identity session");
    free(error); error = NULL;
    check(sp_image_capture_match_retain(sourceIdentity, raw.bytes, width, height, stride,
        sourceBounds, 2, "DeviceRGB"), @"the callback queue fixture retains its raw source");
    NSString *nonce = nil, *payload = nil, *encodedPayload = nil, *encodeError = nil;
    check(sp_image_capture_match_identity_region_nonce(regionToken, &nonce, &error) && error == NULL,
        @"the callback queue fixture issues its region nonce");
    free(error); error = NULL;
    check(sp_image_capture_match_identity_issue(regionToken, sourceIdentity, &payload, &error) && error == NULL,
        @"the callback queue fixture issues its source payload");
    free(error); error = NULL;
    CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
    CGImageRef taggedImage = NULL;
    NSData *taggedPixels = nil;
    BOOL encoded = sp_capture_frame_identity_encode(raw.bytes, width, height, stride, colorSpace, roi, nonce,
        (SPCaptureFrameIdentity){ sourceIdentity.generation, sourceIdentity.raster, sourceIdentity.sequence },
        &taggedImage, &taggedPixels, &encodedPayload, &encodeError);
    check(encoded && taggedImage != NULL, @"the callback queue fixture builds the real tagged sample image");
    check(sp_image_capture_match_identity_record(regionToken, sourceIdentity, roi, taggedPixels.bytes,
        width, height, stride, "DeviceRGB", &error) && error == NULL,
        @"the callback queue fixture records its tagged source artifact");
    free(error); error = NULL;

    atomic_store(&identityDecodeHookCount, 0);
    identityDecodeGateEntered = dispatch_semaphore_create(0);
    identityDecodeSecondEntered = dispatch_semaphore_create(0);
    identityDecodeGateRelease = dispatch_semaphore_create(0);
    sp_capture_frame_identity_test_set_decode_hook(blockFirstIdentityDecode);
    __block BOOL firstEnqueued = NO, secondEnqueued = NO;
    __block char *firstError = NULL, *secondError = NULL;
    dispatch_semaphore_t firstReturned = dispatch_semaphore_create(0);
    dispatch_semaphore_t secondReturned = dispatch_semaphore_create(0);
    NSMutableData *mutableFirstSample = [taggedPixels mutableCopy];
    dispatch_async(sampleQueue, ^{
        firstEnqueued = sp_image_capture_match_identity_enqueue_frame(mutableFirstSample.bytes, width, height,
            stride, colorSpace, CGRectMake(0, 0, 128, 128), CGRectMake(0, 0, 128, 128), 1, 2,
            1, 1000, &firstError);
        dispatch_semaphore_signal(firstReturned);
    });
    long gateWait = dispatch_semaphore_wait(identityDecodeGateEntered,
        dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
    check(gateWait == 0, @"the first sample reaches the controlled QR decoder boundary");
    dispatch_async(sampleQueue, ^{
        secondEnqueued = sp_image_capture_match_identity_enqueue_frame(taggedPixels.bytes, width, height,
            stride, colorSpace, CGRectMake(0, 0, 128, 128), CGRectMake(0, 0, 128, 128), 1, 2,
            2, 2000, &secondError);
        dispatch_semaphore_signal(secondReturned);
    });
    long secondBeforeRelease = dispatch_semaphore_wait(secondReturned, DISPATCH_TIME_NOW);
    long firstWait = dispatch_semaphore_wait(firstReturned, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
    long secondWait = secondBeforeRelease == 0 ? 0 : dispatch_semaphore_wait(secondReturned,
        dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
    check(firstWait == 0 && firstEnqueued && firstError == NULL,
        @"the blocked first frame was admitted without changing its decode input");
    memset(mutableFirstSample.mutableBytes, 0, mutableFirstSample.length);
    dispatch_semaphore_t writerProgress = dispatch_semaphore_create(0);
    dispatch_async(writer, ^{ dispatch_semaphore_signal(writerProgress); });
    long writerProgressWait = dispatch_semaphore_wait(writerProgress,
        dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
    check(writerProgressWait == 0,
        @"the capture artifact writer remains available while QR decoding is blocked");
    dispatch_release(writerProgress);
    check(secondWait == 0 && secondEnqueued && secondError == NULL,
        @"the later sample callback returns while the earlier QR decode remains blocked");
    long secondDecodeBeforeRelease = dispatch_semaphore_wait(identityDecodeSecondEntered,
        dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC));
    check(secondDecodeBeforeRelease == 0,
        @"the second QR decode starts before the blocked first decode is released");
    BOOL acceptedThroughLimit = YES;
    for (uint64_t frame = 3; frame <= 8; frame++) {
        char *enqueueError = NULL;
        BOOL accepted = sp_image_capture_match_identity_enqueue_frame(taggedPixels.bytes, width, height,
            stride, colorSpace, CGRectMake(0, 0, 128, 128), CGRectMake(0, 0, 128, 128), 1, 2,
            frame, frame * 1000, &enqueueError);
        acceptedThroughLimit = acceptedThroughLimit && accepted && enqueueError == NULL;
        free(enqueueError);
    }
    char *overflowError = NULL;
    BOOL overflowAccepted = sp_image_capture_match_identity_enqueue_frame(taggedPixels.bytes, width, height,
        stride, colorSpace, CGRectMake(0, 0, 128, 128), CGRectMake(0, 0, 128, 128), 1, 2,
        9, 9000, &overflowError);
    BOOL overflowHasMeasuredCapacity = overflowError
        && strstr(overflowError, "stage=job-admission")
        && strstr(overflowError, "frame=9")
        && strstr(overflowError, "pendingJobs=8")
        && strstr(overflowError, "jobLimit=8")
        && strstr(overflowError, "pendingCropBytes=")
        && strstr(overflowError, "incomingCropBytes=147456")
        && strstr(overflowError, "artifactPendingBytes=")
        && strstr(overflowError, "byteLimit=67108864")
        && strstr(overflowError, "jobLimitExceeded=1")
        && strstr(overflowError, "byteLimitExceeded=0");
    check(acceptedThroughLimit && !overflowAccepted && overflowError != NULL
        && strstr(overflowError, "pending capacity") != NULL && overflowHasMeasuredCapacity,
        @"the decoder admits eight pending jobs and reports the rejected branch with its job and byte counts");
    free(overflowError);
    char *sessionOverflow = sp_image_capture_match_identity_session_error_copy();
    check(sessionOverflow != NULL && strstr(sessionOverflow, "pending capacity") != NULL,
        @"decoder overflow remains visible as the identity session failure");
    free(sessionOverflow);
    dispatch_queue_t sessionEndQueue = dispatch_queue_create("test.frame-identity.session-end", DISPATCH_QUEUE_SERIAL);
    dispatch_semaphore_t sessionEndStarted = dispatch_semaphore_create(0);
    dispatch_semaphore_t sessionEndReturned = dispatch_semaphore_create(0);
    dispatch_async(sessionEndQueue, ^{
        dispatch_semaphore_signal(sessionEndStarted);
        sp_image_capture_match_identity_session_end();
        dispatch_semaphore_signal(sessionEndReturned);
    });
    dispatch_semaphore_wait(sessionEndStarted, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
    long sessionEndBeforeDecode = dispatch_semaphore_wait(sessionEndReturned, DISPATCH_TIME_NOW);
    check(sessionEndBeforeDecode != 0,
        @"ending an identity session waits for its blocked decoder work to finish");
    dispatch_semaphore_signal(identityDecodeGateRelease);
    long sessionEndWait = dispatch_semaphore_wait(sessionEndReturned, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
    check(sessionEndWait == 0 && !sp_image_capture_match_identity_session_active(),
        @"session end drains accepted decoder and artifact writes before releasing session state");
    dispatch_release(sessionEndStarted); dispatch_release(sessionEndReturned); dispatch_release(sessionEndQueue);
    NSString *decodedPath = [[NSString stringWithUTF8String:directory]
        stringByAppendingPathComponent:@"frame-identities/decoded-frames.jsonl"];
    NSString *decodedText = [NSString stringWithContentsOfFile:decodedPath encoding:NSUTF8StringEncoding error:nil];
    NSArray<NSString *> *decodedLines = [decodedText componentsSeparatedByString:@"\n"];
    NSMutableArray<NSNumber *> *decodedFrames = [NSMutableArray array];
    BOOL measuredEveryDecode = YES;
    for (NSString *line in decodedLines) {
        if (line.length == 0) continue;
        NSDictionary *row = [NSJSONSerialization JSONObjectWithData:[line dataUsingEncoding:NSUTF8StringEncoding]
            options:0 error:nil];
        if (row[@"frame"]) {
            [decodedFrames addObject:row[@"frame"]];
            uint64_t enqueued = [row[@"decodeEnqueuedTime"] longLongValue];
            uint64_t started = [row[@"decodeStartTime"] longLongValue];
            uint64_t completed = [row[@"decodeCompleteTime"] longLongValue];
            measuredEveryDecode = measuredEveryDecode && [row[@"displayTime"] isKindOfClass:NSString.class]
                && [row[@"decodeEnqueuedTime"] isKindOfClass:NSString.class]
                && [row[@"decodeStartTime"] isKindOfClass:NSString.class]
                && [row[@"decodeCompleteTime"] isKindOfClass:NSString.class]
                && enqueued <= started && started <= completed;
        }
    }
    BOOL orderedFrames = decodedFrames.count == 8;
    BOOL firstSnapshotMatched = NO;
    for (NSUInteger index = 0; index < decodedFrames.count && orderedFrames; index++)
        orderedFrames = [decodedFrames[index] unsignedLongLongValue] == index + 1;
    for (NSString *line in decodedLines) {
        if (line.length == 0) continue;
        NSDictionary *row = [NSJSONSerialization JSONObjectWithData:[line dataUsingEncoding:NSUTF8StringEncoding]
            options:0 error:nil];
        if ([row[@"frame"] unsignedLongLongValue] == 1)
            firstSnapshotMatched = [row[@"status"] isEqual:@"matched"];
    }
    check(orderedFrames, @"all admitted frames drain in sample order before session state is released, despite later overflow");
    check(firstSnapshotMatched,
        @"the first frame decodes its intake-time ROI after the caller mutates the source sample");
    check(measuredEveryDecode, @"every decoder result owns ordered enqueue, start, and completion ticks for its display time");
    check(sp_image_capture_match_identity_session_begin(&error) && error == NULL,
        @"a new identity session starts only after the previous decoder drained");
    free(error); error = NULL;
    char *replacementFailure = sp_image_capture_match_identity_session_error_copy();
    check(replacementFailure == NULL, @"the drained predecessor cannot carry its failure into a new decoder session");
    free(replacementFailure);
    NSString *exceptionNonce = nil, *exceptionPayload = nil, *exceptionEncodedPayload = nil, *exceptionEncodeError = nil;
    check(sp_image_capture_match_identity_region_nonce(regionToken, &exceptionNonce, &error) && error == NULL,
        @"the exception fixture receives a fresh session nonce");
    free(error); error = NULL;
    const sp_image_capture_identity exceptionIdentity = { 19, 23, 30 };
    check(sp_image_capture_match_retain(exceptionIdentity, raw.bytes, width, height, stride,
        sourceBounds, 2, "DeviceRGB"), @"the exception fixture retains a distinct source identity");
    check(sp_image_capture_match_identity_issue(regionToken, exceptionIdentity, &exceptionPayload, &error)
        && error == NULL, @"the exception fixture issues its distinct source identity");
    free(error); error = NULL;
    CGImageRef exceptionImage = NULL;
    NSData *exceptionPixels = nil;
    BOOL exceptionEncoded = sp_capture_frame_identity_encode(raw.bytes, width, height, stride, colorSpace,
        roi, exceptionNonce, (SPCaptureFrameIdentity){ exceptionIdentity.generation, exceptionIdentity.raster,
            exceptionIdentity.sequence }, &exceptionImage, &exceptionPixels, &exceptionEncodedPayload,
        &exceptionEncodeError);
    check(exceptionEncoded && exceptionImage != NULL,
        @"the exception fixture builds a sample carrying its new issued identity");
    check(sp_image_capture_match_identity_record(regionToken, exceptionIdentity, roi, exceptionPixels.bytes,
        width, height, stride, "DeviceRGB", &error) && error == NULL,
        @"the exception fixture records its tagged source artifact");
    free(error); error = NULL;
    sp_capture_frame_identity_test_set_decode_hook(throwIdentityDecode);
    BOOL exceptionEnqueued = sp_image_capture_match_identity_enqueue_frame(exceptionPixels.bytes, width,
        height, stride, colorSpace, CGRectMake(0, 0, 128, 128), CGRectMake(0, 0, 128, 128), 1, 2,
        10, 10000, &error);
    check(exceptionEnqueued && error == NULL,
        @"the controlled decoder exception is admitted as an asynchronous decode job");
    free(error); error = NULL;
    BOOL exceptionManifestAccepted = sp_image_capture_match_write_manifest(directory);
    NSString *identityManifestPath = [[NSString stringWithUTF8String:directory]
        stringByAppendingPathComponent:@"frame-identities/manifest.json"];
    NSData *identityManifestData = [NSData dataWithContentsOfFile:identityManifestPath];
    NSDictionary *identityManifest = identityManifestData
        ? [NSJSONSerialization JSONObjectWithData:identityManifestData options:0 error:nil] : nil;
    NSString *identityFailure = identityManifest[@"identityFailure"];
    check(!exceptionManifestAccepted && [identityFailure containsString:@"F239146InjectedDecoderException"],
        [NSString stringWithFormat:@"an asynchronous QR decoder exception is reported and fails manifest finalization after decoder drain (failure=%@)",
            identityFailure ?: @"missing"]);
    check(!sp_image_capture_match_identity_session_active(),
        @"an asynchronous QR decoder exception permanently disables identity intake for the session");
    sp_capture_frame_identity_test_set_decode_hook(NULL);
    if (exceptionImage) CGImageRelease(exceptionImage);
    [exceptionPixels release]; [exceptionNonce release]; [exceptionPayload release];
    [exceptionEncodedPayload release]; [exceptionEncodeError release];
    free(firstError); free(secondError);
    dispatch_release(firstReturned); dispatch_release(secondReturned);
    dispatch_release(identityDecodeGateEntered);
    dispatch_release(identityDecodeSecondEntered);
    dispatch_release(identityDecodeGateRelease);
    [mutableFirstSample release];
    [nonce release]; [payload release]; [encodedPayload release]; [encodeError release]; [taggedPixels release];
    if (taggedImage) CGImageRelease(taggedImage);
    if (colorSpace) CGColorSpaceRelease(colorSpace);
    sp_image_capture_match_end();
    dispatch_release(sampleQueue); dispatch_release(writer);
    NSError *removeError = nil;
    check([[NSFileManager defaultManager] removeItemAtPath:[NSString stringWithUTF8String:directory]
        error:&removeError], [NSString stringWithFormat:@"the callback queue fixture is removed (%@)", removeError]);
}

static void frameIdentityRetentionEvictionChecks(void) {
    const uint8_t regionToken[16] = { 3, 1, 4, 1, 5, 9 };
    const uint8_t sourcePixel[4] = { 0, 0, 0, 255 };
    char *identityError = NULL;
    sp_image_capture_match_begin(NULL, NULL);
    check(sp_image_capture_match_identity_session_begin(&identityError) && identityError == NULL,
        @"the source retention fixture starts an identity session");
    free(identityError); identityError = NULL;
    NSString *firstPayload = nil;
    BOOL accepted = YES;
    for (int sequence = 1; sequence <= 512; sequence++) {
        sp_image_capture_identity identity = { 31, 37, sequence };
        NSString *payload = nil;
        if (!sp_image_capture_match_retain(identity, sourcePixel, 1, 1, 4,
            CGRectMake(0, 0, 1, 1), 1, "DeviceRGB")
            || !sp_image_capture_match_identity_issue(regionToken, identity, &payload, &identityError)) {
            accepted = NO;
            [payload release];
            free(identityError); identityError = NULL;
            break;
        }
        if (sequence == 1) firstPayload = [payload retain];
        [payload release];
        free(identityError); identityError = NULL;
    }
    check(accepted, @"the matcher retains and issues the first 512 source identities");
    sp_image_capture_identity last = { 31, 37, 513 };
    check(sp_image_capture_match_retain(last, sourcePixel, 1, 1, 4,
        CGRectMake(0, 0, 1, 1), 1, "DeviceRGB"),
        @"a new raw source evicts the oldest retained identity under the existing matcher bound");
    NSString *lastPayload = nil;
    check(sp_image_capture_match_identity_issue(regionToken, last, &lastPayload, &identityError)
        && identityError == NULL, @"source-history eviction releases an identity slot for the new source");
    free(identityError); identityError = NULL;
    NSSet<NSString *> *allowlist = nil;
    check(sp_image_capture_match_identity_copy_payloads(regionToken, &allowlist, &identityError)
        && identityError == NULL && allowlist.count == 512 && ![allowlist containsObject:firstPayload]
        && [allowlist containsObject:lastPayload],
        @"the evicted source payload leaves the decoder allowlist while the new one enters");
    free(identityError);
    [firstPayload release]; [lastPayload release]; [allowlist release];
    sp_image_capture_match_identity_session_end();
    sp_image_capture_match_end();
}

int main(void) { @autoreleasepool {
    fprintf(stderr, "START: native image capture identity matching\n");
    const uint8_t source[16] = { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 };
    uint8_t frame[4 * 4 * 4] = { 0 };
    memcpy(frame, source, 8);
    memcpy(frame + 4 * 4, source + 8, 8);
    CGRect bounds = CGRectMake(10, 20, 2, 2);
    sp_image_capture_identity first = { 7, 11, 13 };
    sp_image_capture_match_begin(NULL, NULL);
    check(sp_image_capture_match_retain(first, source, 2, 2, 8, bounds, 1, "DeviceRGB"),
        @"diagnostic matching retains the exact source raster");
    check(sp_image_capture_match_retain(first, source, 2, 2, 8, bounds, 1, "DeviceRGB"),
        @"repeating an identical source identity and raster is idempotent");

    sp_image_capture_match_result result = sp_image_capture_match_sample(frame, 4, 4, 16,
        CGRectMake(0, 0, 4, 4), CGRectMake(10, 20, 4, 4), 1, 1, "DeviceRGB", 987654321);
    check(result.state == SP_IMAGE_CAPTURE_MATCHED && result.candidate_count == 1
        && result.candidates[0].generation == first.generation && result.candidates[0].raster == first.raster
        && result.candidates[0].sequence == first.sequence && result.display_time == 987654321,
        @"the geometrically mapped ScreenCaptureKit crop matches its source identity and preserves displayTime");
    sp_image_capture_match_result_dispose(&result);

    sp_image_capture_match_begin(NULL, NULL);
    check(sp_image_capture_match_retain(first, source, 2, 2, 8, bounds, 1, "DeviceRGB"),
        @"the conflicting-identity fixture retains its first raster");
    uint8_t conflictingSource[sizeof source];
    memcpy(conflictingSource, source, sizeof source);
    conflictingSource[0] ^= 1;
    check(!sp_image_capture_match_retain(first, conflictingSource, 2, 2, 8, bounds, 1, "DeviceRGB"),
        @"the same source identity cannot be reused for different pixels");
    result = sp_image_capture_match_sample(frame, 4, 4, 16,
        CGRectMake(0, 0, 4, 4), CGRectMake(10, 20, 4, 4), 1, 1, "DeviceRGB", 987654330);
    check(result.state == SP_IMAGE_CAPTURE_UNKNOWN_RETENTION && result.dropped_snapshots == 1,
        @"a conflicting source identity is reported as dropped and prevents a confident match");
    sp_image_capture_match_result_dispose(&result);
    sp_image_capture_match_end();

    sp_image_capture_match_begin(NULL, NULL);
    check(sp_image_capture_match_retain(first, source, 2, 2, 8, bounds, 1, "DeviceRGB"),
        @"the ambiguity fixture retains its first source identity");
    sp_image_capture_identity second = { 7, 11, 14 };
    check(sp_image_capture_match_retain(second, source, 2, 2, 8, bounds, 1, "DeviceRGB"),
        @"a repeated source raster is retained as another candidate");
    result = sp_image_capture_match_sample(frame, 4, 4, 16,
        CGRectMake(0, 0, 4, 4), CGRectMake(10, 20, 4, 4), 1, 1, "DeviceRGB", 987654322);
    check(result.state == SP_IMAGE_CAPTURE_AMBIGUOUS && result.candidate_count == 2,
        @"identical pixels preserve both source identities as ambiguous candidates");
    sp_image_capture_match_result_dispose(&result);
    sp_image_capture_match_end();
    sp_image_capture_match_begin(NULL, NULL);
    check(!sp_image_capture_match_retain(first, source, SIZE_MAX / 4 + 1, 1, 4,
        bounds, 1, "DeviceRGB"), @"a source width whose BGRA byte size overflows is rejected");
    sp_image_capture_match_end();
    sp_image_capture_match_begin(NULL, NULL);
    check(sp_image_capture_match_retain(first, source, 2, 2, 8, bounds, 1, "DeviceRGB"),
        @"the next matching fixture starts with a fresh source history");

    result = sp_image_capture_match_sample(frame, 4, 4, 16,
        CGRectMake(0, 0, 4, 4), CGRectMake(10, 20, 4, 4), 1, 2, "DeviceRGB", 987654323);
    check(result.state == SP_IMAGE_CAPTURE_UNKNOWN_SCALE && result.candidate_count == 0,
        @"a capture scale mismatch is an explicit unknown state");
    sp_image_capture_match_result_dispose(&result);

    result = sp_image_capture_match_sample(frame, 4, 4, 16,
        CGRectMake(0, 0, 4, 4), CGRectMake(10, 20, 4, 4), 1, 1, "DisplayP3", 987654324);
    check(result.state == SP_IMAGE_CAPTURE_UNKNOWN_COLOR && result.candidate_count == 0,
        @"a color representation mismatch is an explicit unknown state");
    sp_image_capture_match_result_dispose(&result);

    uint8_t different[sizeof(frame)];
    memcpy(different, frame, sizeof(frame));
    different[0] ^= 1;
    result = sp_image_capture_match_sample(different, 4, 4, 16,
        CGRectMake(0, 0, 4, 4), CGRectMake(10, 20, 4, 4), 1, 1, "DeviceRGB", 987654325);
    check(result.state == SP_IMAGE_CAPTURE_UNMATCHED && result.candidate_count == 0,
        @"a pixel difference is not accepted as a source identity match");
    check(result.has_pixel_difference && result.different_pixels == 1
        && result.first_difference_x == 0 && result.first_difference_y == 0
        && memcmp(result.expected_bgra, source, 4) == 0
        && memcmp(result.actual_bgra, different, 4) == 0,
        @"an unmatched crop reports the differing-pixel count, first crop coordinate, and expected and actual BGRA values");
    sp_image_capture_match_result_dispose(&result);

    result = sp_image_capture_match_sample(frame, 4, 4, 16,
        CGRectMake(0, 0, 4, 4), CGRectMake(50, 50, 4, 4), 1, 1, "DeviceRGB", 987654326);
    check(result.state == SP_IMAGE_CAPTURE_UNKNOWN_GEOMETRY && result.candidate_count == 0,
        @"a source bound outside the captured screen rectangle is explicit unknown geometry");
    sp_image_capture_match_result_dispose(&result);
    result = sp_image_capture_match_sample(frame, SIZE_MAX / 4 + 1, 4, SIZE_MAX,
        CGRectMake(0, 0, 4, 4), CGRectMake(10, 20, 4, 4), 1, 1, "DeviceRGB", 987654329);
    check(result.state == SP_IMAGE_CAPTURE_UNKNOWN_GEOMETRY && result.candidate_count == 0,
        @"a capture width whose BGRA byte size overflows is rejected as unknown geometry");
    sp_image_capture_match_result_dispose(&result);
    sp_image_capture_match_end();

    uint8_t topLeftFrame[sizeof(frame)] = { 0 };
    memcpy(topLeftFrame, source, 8);
    memcpy(topLeftFrame + 4 * 4, source + 8, 8);
    sp_image_capture_match_begin(NULL, NULL);
    check(sp_image_capture_match_retain(first, source, 2, 2, 8, bounds, 1, "DeviceRGB"),
        @"the top-left coordinate fixture retains its source raster");
    result = sp_image_capture_match_sample(topLeftFrame, 4, 4, 16,
        CGRectMake(0, 0, 4, 4), CGRectMake(10, 20, 4, 4), 1, 1, "DeviceRGB", 987654328);
    check(result.state == SP_IMAGE_CAPTURE_MATCHED && result.candidate_count == 1,
        @"ScreenCaptureKit maps a source rectangle at the screenRect top-left origin to the frame top row");
    sp_image_capture_match_result_dispose(&result);
    sp_image_capture_match_end();

    sp_image_capture_match_begin(NULL, NULL);
    const size_t overLimitWidth = (64 * 1024 * 1024) / 4 + 1;
    uint8_t *overLimit = calloc(overLimitWidth, 4);
    check(overLimit != NULL, @"the bounded-retention fixture allocates its over-limit raster");
    if (overLimit) {
        check(sp_image_capture_match_retain(first, source, 2, 2, 8, bounds, 1, "DeviceRGB"),
            @"the bounded-retention fixture has an observed candidate");
        check(!sp_image_capture_match_retain(first, overLimit, overLimitWidth, 1,
            overLimitWidth * 4, bounds, 1, "DeviceRGB"),
            @"a source raster above the diagnostic byte limit is refused");
        free(overLimit);
        result = sp_image_capture_match_sample(frame, 4, 4, 16,
            CGRectMake(0, 0, 4, 4), CGRectMake(10, 20, 4, 4), 1, 1, "DeviceRGB", 987654327);
        check(result.state == SP_IMAGE_CAPTURE_UNKNOWN_RETENTION && result.dropped_snapshots == 1
            && result.candidate_count == 1,
            @"a retention drop prevents a seemingly unique observed candidate from being reported as matched");
        sp_image_capture_match_result_dispose(&result);
    }
    sp_image_capture_match_end();
    sp_image_capture_match_begin(NULL, NULL);
    frameIdentitySessionChecks();
    sp_image_capture_match_end();
    frameIdentityArtifactChecks();
    frameIdentityCropByteBoundChecks();
    frameIdentityDecodeDoesNotBlockSampleQueue();
    frameIdentityRetentionEvictionChecks();
    fprintf(stderr, "%s: native image capture identity matching\n", failures ? "FAIL" : "PASS");
    return failures ? 1 : 0;
} }
