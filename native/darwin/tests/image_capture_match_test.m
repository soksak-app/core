#import "../src/image_capture_match.h"
#import "../src/capture_frame_identity.h"
#import <ImageIO/ImageIO.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdatomic.h>
#include <fcntl.h>
#include <unistd.h>

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

static NSData *bgraPixelsForImage(CGImageRef image) {
    if (!image) return nil;
    size_t width = CGImageGetWidth(image), height = CGImageGetHeight(image);
    if (!width || !height || width > SIZE_MAX / 4 || height > SIZE_MAX / (width * 4)) return nil;
    NSMutableData *pixels = [NSMutableData dataWithLength:width * height * 4];
    CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
    CGContextRef context = colorSpace ? CGBitmapContextCreate(pixels.mutableBytes, width, height, 8,
        width * 4, colorSpace, kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst) : NULL;
    if (colorSpace) CGColorSpaceRelease(colorSpace);
    if (!context) return nil;
    CGContextTranslateCTM(context, 0, height);
    CGContextScaleCTM(context, 1, -1);
    CGContextSetInterpolationQuality(context, kCGInterpolationNone);
    CGContextDrawImage(context, CGRectMake(0, 0, width, height), image);
    CGContextRelease(context);
    return pixels;
}

static void frameIdentityDocumentChecks(void) {
    char directoryTemplate[] = "/tmp/soksak-document-frame-identity-XXXXXX";
    char *directory = mkdtemp(directoryTemplate);
    dispatch_queue_t writer = dispatch_queue_create("test.document-frame-identity.writer", DISPATCH_QUEUE_SERIAL);
    check(directory != NULL && writer != NULL, @"the document frame identity matcher fixture allocates its capture resources");
    if (!directory || !writer) return;
    sp_image_capture_match_begin(directory, writer);
    char *error = NULL;
    BOOL session = sp_image_capture_match_identity_session_begin(&error) && error == NULL;
    check(session, @"the document frame identity matcher fixture starts a capture session");
    free(error); error = NULL;
    const uint8_t documentRegion[16] = { 8, 6, 7, 5, 3, 0, 9 };
    NSArray<NSString *> *payloads = nil;
    NSData *sessionNonce = nil;
    BOOL generated = session && sp_image_capture_match_identity_document_begin(documentRegion, 53,
        CGRectMake(0, 0, 128, 128), 512, &payloads, &sessionNonce, &error);
    check(generated && payloads.count == 512 && error == NULL,
        @"the document atlas generates 512 identities without entering the native-image issued set");
    free(error); error = NULL;

    const uint8_t imageRegion[16] = { 1, 3, 3, 7, 9, 2, 4 };
    BOOL imageCapacityRemains = generated;
    for (int sequence = 1; sequence <= 512 && imageCapacityRemains; sequence++) {
        NSString *payload = nil;
        imageCapacityRemains = sp_image_capture_match_identity_issue(imageRegion,
            (sp_image_capture_identity){ 79, 1, sequence }, &payload, &error) && error == NULL;
        [payload release]; free(error); error = NULL;
    }
    check(imageCapacityRemains,
        @"document atlas generation leaves the complete shared 512-entry native-image identity bound available");

    NSData *atlasPNG = nil;
    NSString *atlasError = nil;
    BOOL atlasMade = generated && sp_capture_frame_identity_atlas(payloads, 128, 8, &atlasPNG, &atlasError);
    check(atlasMade && atlasPNG.length > 0 && atlasError == nil, @"the document identities encode into a bounded atlas");
    BOOL frozen = atlasMade && sp_image_capture_match_identity_document_finish(sessionNonce, atlasPNG, 1, &error);
    check(frozen && error == NULL, @"the document matcher records the one-based final issued slot count");
    free(error); error = NULL; [atlasError release]; [payloads release]; [sessionNonce release];

    CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)atlasPNG, NULL);
    CGImageRef atlas = source ? CGImageSourceCreateImageAtIndex(source, 0, NULL) : NULL;
    CGImageRef firstCell = atlas ? CGImageCreateWithImageInRect(atlas, CGRectMake(0, 0, 128, 128)) : NULL;
    CGImageRef secondCell = atlas ? CGImageCreateWithImageInRect(atlas, CGRectMake(128, 0, 128, 128)) : NULL;
    NSData *firstPixels = bgraPixelsForImage(firstCell), *secondPixels = bgraPixelsForImage(secondCell);
    [atlasPNG release];
    check(firstPixels.length == 128 * 128 * 4 && secondPixels.length == 128 * 128 * 4,
        @"the matcher fixture extracts exact 128-pixel QR cells from the immutable atlas");
    CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
    BOOL firstAccepted = frozen && firstPixels && colorSpace && sp_image_capture_match_identity_enqueue_frame(
        firstPixels.bytes, 128, 128, 128 * 4, colorSpace, CGRectMake(0, 0, 128, 128),
        CGRectMake(0, 0, 128, 128), 1, 1, 1, 111, &error);
    check(firstAccepted && error == NULL, @"a complete captured sample admits its exact first document atlas cell");
    free(error); error = NULL;
    BOOL secondAccepted = frozen && secondPixels && colorSpace && sp_image_capture_match_identity_enqueue_frame(
        secondPixels.bytes, 128, 128, 128 * 4, colorSpace, CGRectMake(0, 0, 128, 128),
        CGRectMake(0, 0, 128, 128), 1, 1, 2, 222, &error);
    check(secondAccepted && error == NULL, @"a second complete sample admits the next generated document atlas cell");
    free(error); error = NULL;
    if (colorSpace) CGColorSpaceRelease(colorSpace);
    if (firstCell) CGImageRelease(firstCell); if (secondCell) CGImageRelease(secondCell);
    if (atlas) CGImageRelease(atlas); if (source) CFRelease(source);

    BOOL finalized = sp_image_capture_match_write_manifest(directory);
    char *manifestError = sp_image_capture_match_identity_session_error_copy();
    check(finalized, [NSString stringWithFormat:@"the document QR source rows and final issued bound write a complete matcher manifest (%s)",
        manifestError ?: ""]);
    free(manifestError);
    NSString *rowsPath = [NSString stringWithFormat:@"%s/frame-identities/decoded-frames.jsonl", directory];
    NSArray<NSString *> *lines = [[NSString stringWithContentsOfFile:rowsPath encoding:NSUTF8StringEncoding error:nil]
        componentsSeparatedByString:@"\n"];
    NSMutableArray<NSDictionary *> *rows = [NSMutableArray array];
    for (NSString *line in lines) {
        if (!line.length) continue;
        NSDictionary *row = [NSJSONSerialization JSONObjectWithData:[line dataUsingEncoding:NSUTF8StringEncoding]
            options:0 error:nil];
        if (row) [rows addObject:row];
    }
    check(rows.count == 2 && [rows[0][@"sourceKind"] isEqual:@"document"]
        && [rows[0][@"status"] isEqual:@"matched"]
        && [rows[0][@"identity"][@"generation"] isEqual:@"53"]
        && [rows[0][@"identity"][@"raster"] isEqual:@"18446744073709551615"]
        && [rows[0][@"identity"][@"sequence"] unsignedIntegerValue] == 1
        && [rows[0][@"displayTime"] isEqual:@"111"],
        @"the exact issued document QR is recorded as matched with its SCK displayTime and document tuple");
    check(rows.count == 2 && [rows[1][@"sourceKind"] isEqual:@"document"]
        && [rows[1][@"status"] isEqual:@"unknown"] && [rows[1][@"reason"] isEqual:@"unissued"]
        && [rows[1][@"identity"] isEqual:NSNull.null] && [rows[1][@"displayTime"] isEqual:@"222"],
        @"a generated atlas cell above the final issued count remains unknown instead of being credited");
    NSString *manifestPath = [NSString stringWithFormat:@"%s/frame-identities/manifest.json", directory];
    NSDictionary *manifest = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:manifestPath]
        options:0 error:nil];
    NSDictionary *document = manifest[@"documentFrameIdentity"];
    check([document[@"atlasSlots"] unsignedIntegerValue] == 512 && [document[@"issuedSlots"] unsignedIntegerValue] == 1
        && [document[@"generatedIdentities"] count] == 512 && [document[@"matchedRecords"] unsignedIntegerValue] == 1
        && [document[@"unknownRecords"] unsignedIntegerValue] == 1
        && [document[@"incompleteSamples"] unsignedIntegerValue] == 0,
        @"the manifest distinguishes generated atlas capacity, actually issued slots, decoded rows, and incomplete samples");
    sp_image_capture_match_end();
    NSError *removeError = nil;
    check([[NSFileManager defaultManager] removeItemAtPath:[NSString stringWithUTF8String:directory]
        error:&removeError], [NSString stringWithFormat:@"the document QR matcher fixture is removed (%@)",
            removeError.localizedDescription ?: @"no removal error"]);
    dispatch_release(writer);
}

static void staleDocumentFrameIdentitySessionChecks(void) {
    char directoryTemplate[] = "/tmp/soksak-document-frame-identity-session-XXXXXX";
    char *directory = mkdtemp(directoryTemplate);
    dispatch_queue_t writer = dispatch_queue_create("test.document-frame-identity-session.writer", DISPATCH_QUEUE_SERIAL);
    check(directory != NULL && writer != NULL, @"the document identity session fixture allocates capture resources");
    if (!directory || !writer) return;
    sp_image_capture_match_begin(directory, writer);
    char *error = NULL;
    BOOL oldStarted = sp_image_capture_match_identity_session_begin(&error) && error == NULL;
    check(oldStarted, @"the stale producer fixture starts its original capture session");
    free(error); error = NULL;
    const uint8_t oldRegion[16] = { 2, 4, 6, 8, 10, 12, 14 };
    NSArray<NSString *> *oldPayloads = nil;
    NSData *oldNonce = nil;
    BOOL oldDocumentStarted = oldStarted && sp_image_capture_match_identity_document_begin(oldRegion, 901,
        CGRectMake(0, 0, 128, 128), 2, &oldPayloads, &oldNonce, &error);
    check(oldDocumentStarted && oldNonce.length == 32,
        @"the retired document producer retains its capture-specific failure token");
    free(error); error = NULL;
    [oldPayloads release];
    sp_image_capture_match_identity_session_end();
    BOOL currentStarted = sp_image_capture_match_identity_session_begin(&error) && error == NULL;
    check(currentStarted, @"the stale producer fixture starts a replacement capture session");
    free(error); error = NULL;
    const uint8_t currentRegion[16] = { 3, 5, 7, 9, 11, 13, 15 };
    NSArray<NSString *> *currentPayloads = nil;
    NSData *currentNonce = nil;
    BOOL currentDocumentStarted = currentStarted && sp_image_capture_match_identity_document_begin(currentRegion, 902,
        CGRectMake(0, 0, 128, 128), 2, &currentPayloads, &currentNonce, &error);
    check(currentDocumentStarted && currentNonce.length == 32,
        @"the replacement document producer receives its own capture-specific failure token");
    free(error); error = NULL;
    BOOL staleFailureReturned = !sp_image_capture_match_identity_session_fail_for_nonce(oldNonce,
        "old document producer closed", &error);
    BOOL currentSurvived = staleFailureReturned && error == NULL
        && sp_image_capture_match_identity_session_active();
    check(currentSurvived,
        @"a late failure from a retired document producer cannot fail a replacement capture session");
    free(error); error = NULL;
    NSData *lateAtlas = [@"old atlas" dataUsingEncoding:NSUTF8StringEncoding];
    BOOL staleFinishRejected = !sp_image_capture_match_identity_document_finish(oldNonce, lateAtlas, 1, &error);
    BOOL currentFinishUntouched = staleFinishRejected && error != NULL
        && sp_image_capture_match_identity_session_active();
    check(currentFinishUntouched,
        @"a late finish from a retired document producer cannot commit into a replacement matcher session");
    free(error); error = NULL;
    BOOL currentFailureRecorded = sp_image_capture_match_identity_session_fail_for_nonce(currentNonce,
        "current document producer closed", &error);
    check(currentFailureRecorded && error == NULL && !sp_image_capture_match_identity_session_active(),
        @"the current document producer can fail only its own active capture session");
    free(error);
    [currentPayloads release]; [currentNonce release]; [oldNonce release];
    sp_image_capture_match_end();
    NSError *removeError = nil;
    check([[NSFileManager defaultManager] removeItemAtPath:[NSString stringWithUTF8String:directory]
        error:&removeError], [NSString stringWithFormat:@"the document identity session fixture is removed (%@)",
            removeError.localizedDescription ?: @"no removal error"]);
    dispatch_release(writer);
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
    for (uint64_t frame = 3; frame <= 16; frame++) {
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
        17, 17000, &overflowError);
    BOOL overflowHasMeasuredCapacity = overflowError
        && strstr(overflowError, "stage=job-admission")
        && strstr(overflowError, "frame=17")
        && strstr(overflowError, "pendingJobs=16")
        && strstr(overflowError, "jobLimit=16")
        && strstr(overflowError, "pendingCropBytes=")
        && strstr(overflowError, "incomingCropBytes=147456")
        && strstr(overflowError, "artifactPendingBytes=")
        && strstr(overflowError, "byteLimit=67108864")
        && strstr(overflowError, "jobLimitExceeded=1")
        && strstr(overflowError, "byteLimitExceeded=0");
    check(acceptedThroughLimit && !overflowAccepted && overflowError != NULL
        && strstr(overflowError, "pending capacity") != NULL && overflowHasMeasuredCapacity,
        @"the decoder admits sixteen pending jobs and reports the rejected branch with its job and byte counts");
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
    BOOL orderedFrames = decodedFrames.count == 16;
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
        18, 18000, &error);
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

static NSArray<NSNumber *> *identityDecodedFrameNumbers(NSString *path) {
    NSData *data = [NSData dataWithContentsOfFile:path];
    NSString *text = data ? [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease] : nil;
    NSMutableArray<NSNumber *> *frames = [NSMutableArray array];
    for (NSString *line in [text componentsSeparatedByString:@"\n"]) {
        if (!line.length) continue;
        NSData *lineData = [line dataUsingEncoding:NSUTF8StringEncoding];
        NSDictionary *record = lineData ? [NSJSONSerialization JSONObjectWithData:lineData options:0 error:nil] : nil;
        if ([record[@"frame"] respondsToSelector:@selector(unsignedLongLongValue)])
            [frames addObject:record[@"frame"]];
    }
    return frames;
}

static BOOL identityFramesAreOrdered(NSArray<NSNumber *> *frames, NSUInteger expectedCount) {
    if (frames.count != expectedCount) return NO;
    for (NSUInteger index = 0; index < expectedCount; index++)
        if ([frames[index] unsignedLongLongValue] != index + 1) return NO;
    return YES;
}

static void frameIdentityCommitDoesNotWaitForArtifactWriter(void) {
    char directoryTemplate[] = "/tmp/soksak-frame-identity-commit-XXXXXX";
    char *directory = mkdtemp(directoryTemplate);
    NSString *directoryPath = directory ? [NSString stringWithUTF8String:directory] : nil;
    NSString *identityDirectory = [directoryPath stringByAppendingPathComponent:@"frame-identities"];
    NSString *decodedPath = [identityDirectory stringByAppendingPathComponent:@"decoded-frames.jsonl"];
    NSError *directoryError = nil;
    BOOL prepared = directoryPath && [[NSFileManager defaultManager] createDirectoryAtPath:identityDirectory
        withIntermediateDirectories:YES attributes:nil error:&directoryError];
    int decodedFD = prepared ? open(decodedPath.fileSystemRepresentation, O_CREAT | O_RDWR, 0600) : -1;
    dispatch_queue_t writer = dispatch_queue_create("test.frame-identity.blocked-artifacts", DISPATCH_QUEUE_SERIAL);
    dispatch_semaphore_t writerEntered = dispatch_semaphore_create(0);
    dispatch_semaphore_t writerRelease = dispatch_semaphore_create(0);
    dispatch_semaphore_t rowsReady = dispatch_semaphore_create(0);
    dispatch_semaphore_t sourceCancelled = dispatch_semaphore_create(0);
    __block NSUInteger requestedRows = 8;
    __block BOOL rowsNotified = NO;
    dispatch_source_t rowsSource = decodedFD >= 0
        ? dispatch_source_create(DISPATCH_SOURCE_TYPE_VNODE, (uintptr_t)decodedFD, DISPATCH_VNODE_WRITE,
            dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0)) : NULL;
    check(prepared && decodedFD >= 0 && rowsSource != NULL,
        [NSString stringWithFormat:@"the ordered-commit fixture prepares a decoded-row file watcher (%@)",
            directoryError.localizedDescription ?: @"no directory error"]);
    if (rowsSource) {
        dispatch_source_set_event_handler(rowsSource, ^{
            NSArray<NSNumber *> *frames = identityDecodedFrameNumbers(decodedPath);
            if (frames.count >= requestedRows && !rowsNotified) {
                rowsNotified = YES;
                dispatch_semaphore_signal(rowsReady);
            }
        });
        dispatch_source_set_cancel_handler(rowsSource, ^{
            if (decodedFD >= 0) close(decodedFD);
            dispatch_semaphore_signal(sourceCancelled);
        });
        dispatch_resume(rowsSource);
    } else if (decodedFD >= 0) {
        close(decodedFD);
        decodedFD = -1;
    }

    const uint8_t sample[4 * 4 * 4] = { 0 };
    CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
    char *error = NULL;
    sp_image_capture_match_begin(directory, writer);
    BOOL sessionStarted = sp_image_capture_match_identity_session_begin(&error) && error == NULL;
    check(sessionStarted, @"the ordered-commit fixture starts an identity session");
    free(error); error = NULL;
    dispatch_async(writer, ^{
        dispatch_semaphore_signal(writerEntered);
        dispatch_semaphore_wait(writerRelease, DISPATCH_TIME_FOREVER);
    });
    long writerWait = dispatch_semaphore_wait(writerEntered, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
    check(writerWait == 0, @"the controlled artifact writer is held before identity rows are enqueued");

    BOOL admittedEight = sessionStarted && colorSpace != NULL && writerWait == 0 && rowsSource != NULL;
    for (uint64_t frame = 1; frame <= 8 && admittedEight; frame++) {
        error = NULL;
        BOOL accepted = sp_image_capture_match_identity_enqueue_frame(sample, 4, 4, 16, colorSpace,
            CGRectMake(0, 0, 4, 4), CGRectMake(0, 0, 4, 4), 1, 1, frame, frame * 1000, &error);
        admittedEight = accepted && error == NULL;
        free(error); error = NULL;
    }
    check(admittedEight, @"eight ordered identity rows are admitted while artifact output is blocked");
    long rowsWait = rowsSource && admittedEight
        ? dispatch_semaphore_wait(rowsReady, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)) : -1;
    NSArray<NSNumber *> *blockedWriterFrames = identityDecodedFrameNumbers(decodedPath);
    BOOL committedWhileBlocked = rowsWait == 0 && identityFramesAreOrdered(blockedWriterFrames, 8);
    check(committedWhileBlocked,
        @"eight decoded JSONL rows commit in order while the shared raw/source artifact writer remains blocked");

    dispatch_semaphore_signal(writerRelease);
    sp_image_capture_match_identity_session_end();
    NSArray<NSNumber *> *drainedFrames = identityDecodedFrameNumbers(decodedPath);
    check(identityFramesAreOrdered(drainedFrames, 8),
        @"writer release drains every accepted decoded row exactly once in sample order");
    sp_image_capture_match_end();
    if (rowsSource) {
        dispatch_source_cancel(rowsSource);
        dispatch_semaphore_wait(sourceCancelled, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
        dispatch_release(rowsSource);
    }
    if (colorSpace) CGColorSpaceRelease(colorSpace);
    dispatch_release(writerEntered); dispatch_release(writerRelease); dispatch_release(rowsReady);
    dispatch_release(sourceCancelled); dispatch_release(writer);
    NSError *removeError = nil;
    check(directoryPath && [[NSFileManager defaultManager] removeItemAtPath:directoryPath error:&removeError],
        [NSString stringWithFormat:@"the ordered-commit fixture removes its files (%@)",
            removeError.localizedDescription ?: @"no removal error"]);
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
    staleDocumentFrameIdentitySessionChecks();
    frameIdentityDocumentChecks();
    frameIdentityArtifactChecks();
    frameIdentityCropByteBoundChecks();
    frameIdentityDecodeDoesNotBlockSampleQueue();
    frameIdentityCommitDoesNotWaitForArtifactWriter();
    frameIdentityRetentionEvictionChecks();
    fprintf(stderr, "%s: native image capture identity matching\n", failures ? "FAIL" : "PASS");
    return failures ? 1 : 0;
} }
