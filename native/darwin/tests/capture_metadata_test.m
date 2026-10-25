// Checks through the real write path that the recording path rejects with an explicit error a sample that lacks a required field of a completed frame (state, presentation time, window rectangle, scale, image),
// and that an idle frame without an image is only counted.
#import "../src/capture.m"
#import "../src/capture_frame_identity.h"
#import "support/records.h"
#import <CommonCrypto/CommonDigest.h>
#import "event_ring.h"
#include <sys/stat.h>

static int failures;
static uint64_t controlledTimes[7];
static int controlledTimeIndex;
static int controlledTimeLimit = 3;
static uint64_t controlledRawClock(void) {
    if (controlledTimeIndex >= controlledTimeLimit) return 0;
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

static int displayWindowLastReleaseThread = -1;
static int trackDisplayWindowReleases;
static dispatch_semaphore_t displayLinkWindowLookupReached;
static dispatch_semaphore_t displayLinkWindowLookupResume;
static int displayLinkWindowLookupHookWaitResult = -1;
static int displayLinkWindowLookupFound;
static int displayLinkLookupRaceStopReturned;
static dispatch_semaphore_t displayLinkClockReadEntered;
static dispatch_semaphore_t displayLinkClockReadResume;
static kern_return_t delayedFailedDisplayLinkTimebase(mach_timebase_info_data_t *timebase) {
    (void)timebase;
    dispatch_semaphore_signal(displayLinkClockReadEntered);
    dispatch_semaphore_wait(displayLinkClockReadResume, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
    return KERN_FAILURE;
}
static void pauseDisplayLinkInstallationAfterWindowLookup(NSWindow *window) {
    __atomic_store_n(&displayLinkWindowLookupFound, window != nil ? 1 : 0, __ATOMIC_RELAXED);
    dispatch_semaphore_signal(displayLinkWindowLookupReached);
    displayLinkWindowLookupHookWaitResult = (int)dispatch_semaphore_wait(displayLinkWindowLookupResume,
        dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
}
@interface SPDisplayWindowReleaseProbe : NSWindow
@end
@implementation SPDisplayWindowReleaseProbe
- (oneway void)release {
    if (__atomic_load_n(&trackDisplayWindowReleases, __ATOMIC_RELAXED)) {
        __atomic_store_n(&displayWindowLastReleaseThread, [NSThread isMainThread] ? 1 : 0, __ATOMIC_RELAXED);
    }
    [super release];
}
@end

@interface SPFakeDisplayLink : NSObject
@property (nonatomic) NSUInteger invalidationCount;
- (void)invalidate;
@end
@implementation SPFakeDisplayLink
- (void)invalidate { self.invalidationCount++; }
@end
static void *countingBaseAddress(CVPixelBufferRef buffer) {
    injectedBaseAddressCalls++;
    return CVPixelBufferGetBaseAddress(buffer);
}

static uint64_t rawMachForMediaTime(double seconds, mach_timebase_info_data_t timebase) {
    return (uint64_t)roundl((long double)seconds * 1e9L * (long double)timebase.denom / (long double)timebase.numer);
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
    sp_image_capture_match_result mismatch = { .state = SP_IMAGE_CAPTURE_UNMATCHED,
        .display_time = 123456789, .has_pixel_difference = true, .different_pixels = 2,
        .first_difference_x = 3, .first_difference_y = 4,
        .expected_bgra = { 1, 2, 3, 4 }, .actual_bgra = { 5, 6, 7, 8 } };
    NSDictionary *mismatchRecord = imageMatchRecord(mismatch, 0.25, 20, 10, 80,
        CGRectMake(0, 0, 10, 5), CGRectMake(0, 0, 10, 5), YES, 1, 1, kCVPixelFormatType_32BGRA, "kCGColorSpaceSRGB");
    NSDictionary *firstDifference = mismatchRecord[@"firstDifference"];
    check([mismatchRecord[@"differentPixels"] isEqual:@2]
        && [firstDifference[@"x"] isEqual:@3] && [firstDifference[@"y"] isEqual:@4]
        && [firstDifference[@"expectedBGRA"] isEqual:@[@1, @2, @3, @4]]
        && [firstDifference[@"actualBGRA"] isEqual:@[@5, @6, @7, @8]],
        @"the callback record preserves the bounded exact pixel mismatch details");
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
    NSDictionary *firstFrameTrace = used.callbackStatusTrace.lastObject;
    check([firstFrameTrace[@"imageMatch"] isKindOfClass:NSDictionary.class]
        && [firstFrameTrace[@"imageMatch"][@"displayTime"] isKindOfClass:NSString.class]
        && [firstFrameTrace[@"imageMatch"][@"state"] isKindOfClass:NSString.class],
        @"each captured image frame records an explicit source match state and its display time");

    const uint8_t artifactSource[] = { 11, 12, 13, 255, 21, 22, 23, 255, 31, 32, 33, 255, 41, 42, 43, 255 };
    sp_image_capture_identity artifactIdentity = { 7, 11, 13 };
    sp_image_capture_match_begin(directory.fileSystemRepresentation, captureWriter);
    check(sp_image_capture_match_retain(artifactIdentity, artifactSource, 2, 2, 8,
        CGRectMake(10, 20, 2, 2), 1, "kCGColorSpaceSRGB"),
        @"diagnostic capture retains the source used by the artifact fixture");
    check(sp_image_capture_match_retain(artifactIdentity, artifactSource, 2, 2, 8,
        CGRectMake(10, 20, 2, 2), 1, "kCGColorSpaceSRGB"),
        @"repeated identical source identities do not schedule duplicate artifact paths");
    error = record(sample(YES, complete(nil)), &used);
    NSString *sourceArtifactPath = [[directory stringByAppendingPathComponent:@"sources"]
        stringByAppendingPathComponent:@"7-11-13.bgra"];
    NSData *sourceArtifact = [NSData dataWithContentsOfFile:sourceArtifactPath];
    check(error.length == 0 && [sourceArtifact isEqualToData:[NSData dataWithBytes:artifactSource length:sizeof artifactSource]],
        @"diagnostic capture writes the source artifact with the exact retained BGRA bytes and identity");
    check(sp_image_capture_match_write_manifest(directory.fileSystemRepresentation),
        @"diagnostic capture writes the source artifact manifest after its writer queue drains");
    NSString *manifestPath = [[directory stringByAppendingPathComponent:@"sources"] stringByAppendingPathComponent:@"manifest.json"];
    NSData *manifestData = [NSData dataWithContentsOfFile:manifestPath];
    NSDictionary *manifest = manifestData
        ? [NSJSONSerialization JSONObjectWithData:manifestData options:0 error:nil] : nil;
    NSArray *artifacts = manifest[@"artifacts"];
    NSDictionary *artifact = artifacts.count == 1 ? artifacts.firstObject : nil;
    unsigned char artifactDigest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(artifactSource, (CC_LONG)sizeof artifactSource, artifactDigest);
    NSMutableString *artifactDigestHex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
    for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++)
        [artifactDigestHex appendFormat:@"%02x", artifactDigest[index]];
    NSDictionary *artifactBounds = artifact[@"screenBounds"];
    check([manifest[@"format"] isEqual:@2]
        && [artifact[@"generation"] isEqual:@"7"] && [artifact[@"raster"] isEqual:@"11"]
        && [artifact[@"sequence"] isEqual:@13] && [artifact[@"file"] isEqual:@"7-11-13.bgra"]
        && [artifact[@"width"] isEqual:@2] && [artifact[@"height"] isEqual:@2]
        && [artifact[@"stride"] isEqual:@8] && [artifact[@"pixelFormat"] isEqual:@"BGRA8"]
        && [artifact[@"alpha"] isEqual:@"premultiplied-first"]
        && [artifact[@"colorSpace"] isEqual:@"kCGColorSpaceSRGB"]
        && [artifactBounds[@"x"] isEqual:@10] && [artifactBounds[@"y"] isEqual:@20]
        && [artifactBounds[@"width"] isEqual:@2] && [artifactBounds[@"height"] isEqual:@2]
        && [artifact[@"scale"] isEqual:@1] && [artifact[@"byteCount"] isEqual:@(sizeof artifactSource)]
        && [artifact[@"sha256"] isEqual:artifactDigestHex] && [manifest[@"droppedSources"] isEqual:@0],
        @"the bounded source manifest records exact identity, pixel layout, geometry, color, byte count and SHA-256 once");
    sp_image_capture_match_end();

    NSString *cleanupDirectory = [directory stringByAppendingPathComponent:@"cleanup-failure"];
    NSString *cleanupSourceDirectory = [cleanupDirectory stringByAppendingPathComponent:@"sources"];
    NSString *partialPath = [cleanupSourceDirectory stringByAppendingPathComponent:@"77-1-1.bgra.partial"];
    NSError *cleanupSetupError = nil;
    BOOL cleanupFixtureReady = [[NSFileManager defaultManager] createDirectoryAtPath:cleanupSourceDirectory
        withIntermediateDirectories:YES attributes:nil error:&cleanupSetupError]
        && [@"retain" writeToFile:partialPath atomically:YES encoding:NSUTF8StringEncoding error:&cleanupSetupError];
    check(cleanupFixtureReady, [NSString stringWithFormat:@"the artifact cleanup fixture is prepared (%@)", cleanupSetupError]);
    sp_image_capture_match_begin(cleanupDirectory.fileSystemRepresentation, captureWriter);
    sp_image_capture_identity cleanupIdentity = { 77, 1, 1 };
    BOOL cleanupPermissionSet = chmod(cleanupSourceDirectory.fileSystemRepresentation, 0500) == 0;
    check(cleanupPermissionSet, @"the artifact cleanup fixture prevents partial-file replacement and removal");
    check(sp_image_capture_match_retain(cleanupIdentity, artifactSource, 2, 2, 8,
        CGRectMake(10, 20, 2, 2), 1, "kCGColorSpaceSRGB"),
        @"the artifact cleanup fixture retains its source raster");
    dispatch_sync(captureWriter, ^{});
    BOOL cleanupPermissionRestored = chmod(cleanupSourceDirectory.fileSystemRepresentation, 0700) == 0;
    check(cleanupPermissionRestored, @"the artifact cleanup fixture restores directory permissions");
    BOOL cleanupManifestWritten = sp_image_capture_match_write_manifest(cleanupDirectory.fileSystemRepresentation);
    NSString *cleanupManifestPath = [cleanupSourceDirectory stringByAppendingPathComponent:@"manifest.json"];
    NSData *cleanupManifestData = [NSData dataWithContentsOfFile:cleanupManifestPath];
    NSDictionary *cleanupManifest = cleanupManifestData
        ? [NSJSONSerialization JSONObjectWithData:cleanupManifestData options:0 error:nil] : nil;
    NSArray *cleanupErrors = cleanupManifest[@"cleanupErrors"];
    check(!cleanupManifestWritten && [cleanupManifest[@"cleanupFailures"] isEqual:@1]
        && cleanupErrors.count == 1 && [cleanupErrors.firstObject[@"error"] isKindOfClass:NSString.class],
        @"a failed partial-file cleanup is reported in the manifest and fails the artifact write");
    sp_image_capture_match_end();

    NSString *countBoundDirectory = [directory stringByAppendingPathComponent:@"count-bound"];
    sp_image_capture_match_begin(countBoundDirectory.fileSystemRepresentation, captureWriter);
    BOOL retainedCountFixture = YES;
    for (int sequence = 1; sequence <= 513; sequence++) {
        sp_image_capture_identity identity = { 8, 3, sequence };
        uint8_t pixel[4] = { (uint8_t)sequence, 22, 33, 255 };
        BOOL retained = sp_image_capture_match_retain(identity, pixel, 1, 1, sizeof pixel,
            CGRectMake(10, 20, 1, 1), 1, "kCGColorSpaceSRGB");
        if (sequence <= 512 ? !retained : retained) retainedCountFixture = NO;
    }
    check(retainedCountFixture, @"the source artifact count fixture accepts 512 identities and refuses the 513th");
    check(sp_image_capture_match_write_manifest(countBoundDirectory.fileSystemRepresentation),
        @"the source artifact count-bound manifest is written after queued artifacts finish");
    NSString *countManifestPath = [[countBoundDirectory stringByAppendingPathComponent:@"sources"]
        stringByAppendingPathComponent:@"manifest.json"];
    NSData *countManifestData = [NSData dataWithContentsOfFile:countManifestPath];
    NSDictionary *countManifest = countManifestData
        ? [NSJSONSerialization JSONObjectWithData:countManifestData options:0 error:nil] : nil;
    NSString *droppedArtifact = [[countBoundDirectory stringByAppendingPathComponent:@"sources"]
        stringByAppendingPathComponent:@"8-3-513.bgra"];
    NSString *droppedPartial = [droppedArtifact stringByAppendingString:@".partial"];
    check([countManifest[@"artifacts"] count] == 512
        && [countManifest[@"droppedSources"] isEqual:@1]
        && [countManifest[@"dropReasons"][@"capacity"] isEqual:@1]
        && ![NSFileManager.defaultManager fileExistsAtPath:droppedArtifact]
        && ![NSFileManager.defaultManager fileExistsAtPath:droppedPartial],
        @"the 513th unique source is dropped explicitly without a partial file when the 512-artifact bound is reached");
    sp_image_capture_match_end();

    NSString *byteBoundDirectory = [directory stringByAppendingPathComponent:@"byte-bound"];
    sp_image_capture_match_begin(byteBoundDirectory.fileSystemRepresentation, captureWriter);
    size_t byteLimit = 64 * 1024 * 1024;
    uint8_t *largeSource = calloc(byteLimit, 1);
    check(largeSource != NULL, @"the byte-bound fixture allocates exactly 64 MiB");
    if (largeSource) {
        sp_image_capture_identity largeIdentity = { 9, 4, 1 };
        check(sp_image_capture_match_retain(largeIdentity, largeSource, byteLimit / 4, 1, byteLimit,
            CGRectMake(10, 20, byteLimit / 4, 1), 1, "kCGColorSpaceSRGB"),
            @"the source artifact byte-bound fixture retains exactly 64 MiB");
        dispatch_sync(captureWriter, ^{});
        sp_image_capture_identity excessIdentity = { 9, 4, 2 };
        uint8_t excessPixel[4] = { 1, 2, 3, 255 };
        check(sp_image_capture_match_retain(excessIdentity, excessPixel, 1, 1, sizeof excessPixel,
            CGRectMake(10, 20, 1, 1), 1, "kCGColorSpaceSRGB"),
            @"the source artifact byte-bound fixture retains a source after its first raster");
        check(sp_image_capture_match_write_manifest(byteBoundDirectory.fileSystemRepresentation),
            @"the source artifact byte-bound manifest is written after queued artifacts finish");
        NSString *byteManifestPath = [[byteBoundDirectory stringByAppendingPathComponent:@"sources"]
            stringByAppendingPathComponent:@"manifest.json"];
        NSData *byteManifestData = [NSData dataWithContentsOfFile:byteManifestPath];
        NSDictionary *byteManifest = byteManifestData
            ? [NSJSONSerialization JSONObjectWithData:byteManifestData options:0 error:nil] : nil;
        check([byteManifest[@"artifacts"] count] == 2
            && [byteManifest[@"artifacts"][0][@"byteCount"] isEqual:@(byteLimit)]
            && [byteManifest[@"artifactBytes"] isEqual:@(byteLimit + sizeof excessPixel)]
            && [byteManifest[@"droppedSources"] isEqual:@0],
            @"the artifact stream preserves source bytes beyond the former aggregate byte limit");
        free(largeSource);
    }
    sp_image_capture_match_end();

    NSString *multiFrameDirectory = [directory stringByAppendingPathComponent:@"multi-frame-source-retention"];
    check([[NSFileManager defaultManager] createDirectoryAtPath:multiFrameDirectory
        withIntermediateDirectories:YES attributes:nil error:nil],
        @"the multi-frame source fixture directory is created");
    sp_image_capture_match_begin(multiFrameDirectory.fileSystemRepresentation, captureWriter);
    size_t sourceBytesCount = 1520 * 573 * 4;
    uint8_t *sourceBytes = malloc(sourceBytesCount);
    check(sourceBytes != NULL, @"the multi-frame source fixture allocates one native-sized raster");
    if (sourceBytes) {
        BOOL retainedEverySource = YES;
        for (int sequence = 1; sequence <= 20; sequence++) {
            memset(sourceBytes, sequence, sourceBytesCount);
            sp_image_capture_identity identity = { 12, 4, sequence };
            if (!sp_image_capture_match_retain(identity, sourceBytes, 1520, 573, 1520 * 4,
                CGRectMake(10, 20, 760, 286.5), 2, "kCGColorSpaceSRGB")) retainedEverySource = NO;
            dispatch_sync(captureWriter, ^{});
        }
        check(retainedEverySource,
            @"the matcher accepts every source identity across a multi-frame gesture");
        memset(sourceBytes, 1, sourceBytesCount);
        sp_image_capture_identity firstStreamedIdentity = { 12, 4, 1 };
        BOOL oldIdentityRepeatIsIdempotent = sp_image_capture_match_retain(firstStreamedIdentity,
            sourceBytes, 1520, 573, 1520 * 4, CGRectMake(10, 20, 760, 286.5), 2, "kCGColorSpaceSRGB");
        sourceBytes[0] ^= 1;
        BOOL oldIdentityConflictIsRejected = !sp_image_capture_match_retain(firstStreamedIdentity,
            sourceBytes, 1520, 573, 1520 * 4, CGRectMake(10, 20, 760, 286.5), 2, "kCGColorSpaceSRGB");
        check(oldIdentityRepeatIsIdempotent && oldIdentityConflictIsRejected,
            @"artifact deduplication compares exact bytes after matcher history evicts the source");
        check(sp_image_capture_match_write_manifest(multiFrameDirectory.fileSystemRepresentation),
            @"the multi-frame source manifest is written after source artifacts finish");
        NSString *multiFrameSources = [multiFrameDirectory stringByAppendingPathComponent:@"sources"];
        NSData *multiFrameManifestData = [NSData dataWithContentsOfFile:
            [multiFrameSources stringByAppendingPathComponent:@"manifest.json"]];
        NSDictionary *multiFrameManifest = multiFrameManifestData
            ? [NSJSONSerialization JSONObjectWithData:multiFrameManifestData options:0 error:nil] : nil;
        NSArray *multiFrameArtifacts = multiFrameManifest[@"artifacts"];
        BOOL everyArtifactPresent = multiFrameArtifacts.count == 20
            && [multiFrameManifest[@"artifactBytes"] isEqual:@(sourceBytesCount * 20)]
            && [multiFrameManifest[@"droppedSources"] isEqual:@1]
            && [multiFrameManifest[@"dropReasons"][@"identity-conflict"] isEqual:@1];
        for (int sequence = 1; sequence <= 20; sequence++) {
            NSString *artifactPath = [multiFrameSources stringByAppendingPathComponent:
                [NSString stringWithFormat:@"12-4-%d.bgra", sequence]];
            NSData *artifact = [NSData dataWithContentsOfFile:artifactPath];
            if (artifact.length != sourceBytesCount || ((const uint8_t *)artifact.bytes)[0] != sequence
                || ((const uint8_t *)artifact.bytes)[sourceBytesCount - 1] != sequence) {
                everyArtifactPresent = NO;
            }
        }
        check(everyArtifactPresent,
            @"all exact source identities above the former 64 MiB aggregate limit have artifacts");
        free(sourceBytes);
    }
    sp_image_capture_match_end();

    NSString *pendingBoundDirectory = [directory stringByAppendingPathComponent:@"pending-source-bound"];
    check([[NSFileManager defaultManager] createDirectoryAtPath:pendingBoundDirectory
        withIntermediateDirectories:YES attributes:nil error:nil],
        @"the pending source fixture directory is created");
    dispatch_semaphore_t writerGate = dispatch_semaphore_create(0);
    dispatch_semaphore_t writerBlocked = dispatch_semaphore_create(0);
    dispatch_async(captureWriter, ^{
        dispatch_semaphore_signal(writerBlocked);
        dispatch_semaphore_wait(writerGate, DISPATCH_TIME_FOREVER);
    });
    dispatch_semaphore_wait(writerBlocked, DISPATCH_TIME_FOREVER);
    sp_image_capture_match_begin(pendingBoundDirectory.fileSystemRepresentation, captureWriter);
    size_t pendingSourceBytesCount = 1520 * 573 * 4;
    uint8_t *pendingSourceBytes = malloc(pendingSourceBytesCount);
    check(pendingSourceBytes != NULL, @"the pending source fixture allocates one native-sized raster");
    if (pendingSourceBytes) {
        BOOL acceptedWithinPendingBound = YES;
        for (int sequence = 1; sequence <= 20; sequence++) {
            memset(pendingSourceBytes, sequence, pendingSourceBytesCount);
            sp_image_capture_identity identity = { 13, 4, sequence };
            BOOL retained = sp_image_capture_match_retain(identity, pendingSourceBytes, 1520, 573, 1520 * 4,
                CGRectMake(10, 20, 760, 286.5), 2, "kCGColorSpaceSRGB");
            if (sequence <= 19 ? !retained : retained) acceptedWithinPendingBound = NO;
        }
        check(acceptedWithinPendingBound,
            @"the bounded source writer accepts a burst that fits its byte budget and rejects overflow explicitly");
        dispatch_semaphore_signal(writerGate);
        check(sp_image_capture_match_write_manifest(pendingBoundDirectory.fileSystemRepresentation),
            @"the pending-bound source manifest is written after queued artifacts finish");
        NSString *pendingSources = [pendingBoundDirectory stringByAppendingPathComponent:@"sources"];
        NSData *pendingManifestData = [NSData dataWithContentsOfFile:
            [pendingSources stringByAppendingPathComponent:@"manifest.json"]];
        NSDictionary *pendingManifest = pendingManifestData
            ? [NSJSONSerialization JSONObjectWithData:pendingManifestData options:0 error:nil] : nil;
        NSString *overflowArtifact = [pendingSources stringByAppendingPathComponent:@"13-4-20.bgra"];
        check([pendingManifest[@"artifacts"] count] == 19
            && [pendingManifest[@"droppedSources"] isEqual:@1]
            && [pendingManifest[@"dropReasons"][@"capacity"] isEqual:@1]
            && ![NSFileManager.defaultManager fileExistsAtPath:overflowArtifact],
            @"pending byte overflow is recorded and does not create an incomplete source artifact");
        free(pendingSourceBytes);
    } else {
        dispatch_semaphore_signal(writerGate);
    }
    dispatch_release(writerBlocked);
    dispatch_release(writerGate);
    sp_image_capture_match_end();

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
    controlledTimes[2] = 210;
    controlledTimes[3] = 230;
    controlledTimes[4] = 250;
    controlledTimeIndex = 0;
    controlledTimeLimit = 5;
    uint64_t (*originalClock)(void) = captureRawClock;
    captureRawClock = controlledRawClock;
    SCStream *testStream = (SCStream *)[NSObject new];
    SCStream *savedCallbackStream = captureStream;
    BOOL savedCallbackAcceptance = captureAcceptingSamples;
    @synchronized ([SPCapture class]) {
        captureStream = testStream;
        captureAcceptingSamples = YES;
    }
    [used stream:testStream didOutputSampleBuffer:measured ofType:SCStreamOutputTypeScreen];
    @synchronized ([SPCapture class]) {
        captureStream = savedCallbackStream;
        captureAcceptingSamples = savedCallbackAcceptance;
    }
    [testStream release];
    captureRawClock = originalClock;
    dispatch_sync(captureWriter, ^{});
    CFRelease(measured);
    NSDictionary *measuredCallback = used.callbackStatusTrace.firstObject;
    mach_timebase_info_data_t measuredTimebase = {};
    kern_return_t measuredTimebaseResult = mach_timebase_info(&measuredTimebase);
    check(controlledTimeIndex == 5
        && [measuredCallback[@"callbackTime"] isEqual:@"100"]
        && [measuredCallback[@"writeStartTime"] isEqual:@"200"]
        && [measuredCallback[@"imageMatchStartTime"] isEqual:@"210"]
        && [measuredCallback[@"imageMatchCompleteTime"] isEqual:@"230"]
        && measuredCallback[@"identityDecodeEnqueueStartTime"] == [NSNull null]
        && measuredCallback[@"identityDecodeEnqueueCompleteTime"] == [NSNull null]
        && measuredCallback[@"frameIdentityDecodeStartTime"] == [NSNull null]
        && measuredCallback[@"frameIdentityDecodeCompleteTime"] == [NSNull null]
        && [measuredCallback[@"writeCompleteTime"] isEqual:@"250"]
        && [measuredCallback[@"machTimebaseNumerator"] unsignedIntValue] == measuredTimebase.numer
        && [measuredCallback[@"machTimebaseDenominator"] unsignedIntValue] == measuredTimebase.denom
        && measuredTimebaseResult == KERN_SUCCESS
        && [measuredCallback[@"displayTime"] isEqual:@"987654321"]
        && [measuredCallback[@"frame"] isEqual:@"frame-0001.bgra"],
        @"the real delegate path records callback and image-match raw bounds, absent identity-stage ticks, the timebase, display time and frame marker");
    check(writeCaptureCallbackStatusTrace(used), @"the measured callback metadata is written as JSONL");
    NSString *measuredTraceText = [NSString stringWithContentsOfFile:
        [directory stringByAppendingPathComponent:kCaptureCallbackStatusFile] encoding:NSUTF8StringEncoding error:nil];
    NSDictionary *measuredJSON = [NSJSONSerialization JSONObjectWithData:
        [measuredTraceText dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    check([measuredJSON[@"callbackTime"] isEqual:@"100"]
        && [measuredJSON[@"writeStartTime"] isEqual:@"200"]
        && [measuredJSON[@"imageMatchStartTime"] isEqual:@"210"]
        && [measuredJSON[@"imageMatchCompleteTime"] isEqual:@"230"]
        && measuredJSON[@"identityDecodeEnqueueStartTime"] == [NSNull null]
        && measuredJSON[@"identityDecodeEnqueueCompleteTime"] == [NSNull null]
        && measuredJSON[@"frameIdentityDecodeStartTime"] == [NSNull null]
        && measuredJSON[@"frameIdentityDecodeCompleteTime"] == [NSNull null]
        && [measuredJSON[@"writeCompleteTime"] isEqual:@"250"]
        && [measuredJSON[@"machTimebaseNumerator"] unsignedIntValue] == measuredTimebase.numer
        && [measuredJSON[@"machTimebaseDenominator"] unsignedIntValue] == measuredTimebase.denom,
        @"the callback artifact preserves stage ticks as decimal strings, absent stages as null, and the actual mach timebase");

    NSString *identityTimingDirectory = [directory stringByAppendingPathComponent:@"identity-timing"];
    check([[NSFileManager defaultManager] createDirectoryAtPath:identityTimingDirectory
        withIntermediateDirectories:YES attributes:nil error:nil], @"the identity timing fixture directory is created");
    sp_image_capture_match_begin(identityTimingDirectory.fileSystemRepresentation, captureWriter);
    char *identityTimingError = NULL;
    BOOL identityTimingStarted = sp_image_capture_match_identity_session_begin(&identityTimingError);
    check(identityTimingStarted, [NSString stringWithFormat:@"the identity timing session starts (%s)",
        identityTimingError ?: ""]);
    free(identityTimingError); identityTimingError = NULL;
    const size_t identityWidth = 200, identityHeight = 200, identityStride = identityWidth * 4;
    NSMutableData *identitySourcePixels = [NSMutableData dataWithLength:identityStride * identityHeight];
    for (size_t offset = 3; offset < identitySourcePixels.length; offset += 4)
        ((uint8_t *)identitySourcePixels.mutableBytes)[offset] = 255;
    uint8_t identityRegionToken[16] = { 1, 2, 3, 4 };
    sp_image_capture_identity identitySource = { 17, 19, 23 };
    NSString *identityNonce = nil, *identityPayload = nil, *identityEncodedPayload = nil, *identityEncodeError = nil;
    const CGRect identityTagROI = CGRectMake(8, 0, 192, 192);
    CGColorSpaceRef identityColorSpace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGImageRef identityTaggedImage = NULL;
    NSData *identityTaggedPixels = nil;
    char *identityArtifactError = NULL;
    BOOL identitySourceReady = identityTimingStarted
        && identityColorSpace
        && sp_image_capture_match_identity_region_nonce(identityRegionToken, &identityNonce, &identityTimingError)
        && sp_image_capture_match_identity_issue(identityRegionToken, identitySource, &identityPayload, &identityTimingError)
        && sp_image_capture_match_retain(identitySource, identitySourcePixels.bytes, identityWidth, identityHeight,
            identityStride, CGRectMake(0, 0, identityWidth, identityHeight), 1, "kCGColorSpaceSRGB")
        && sp_capture_frame_identity_encode(identitySourcePixels.bytes, identityWidth, identityHeight, identityStride,
            identityColorSpace, identityTagROI, identityNonce,
            (SPCaptureFrameIdentity){ identitySource.generation, identitySource.raster, (uint64_t)identitySource.sequence },
            &identityTaggedImage, &identityTaggedPixels, &identityEncodedPayload, &identityEncodeError)
        && [identityPayload isEqualToString:identityEncodedPayload]
        && sp_image_capture_match_identity_record(identityRegionToken, identitySource, identityTagROI,
            identityTaggedPixels.bytes, identityWidth, identityHeight, identityStride, "kCGColorSpaceSRGB",
            &identityArtifactError);
    check(identitySourceReady, [NSString stringWithFormat:@"the identity timing tag artifact is issued and retained (%s, %@)",
        identityTimingError ?: identityArtifactError ?: "", identityEncodeError ?: @""]);
    free(identityTimingError); identityTimingError = NULL;
    free(identityArtifactError); identityArtifactError = NULL;
    [identityNonce release]; [identityPayload release]; [identityEncodedPayload release]; [identityEncodeError release];
    [identityTaggedPixels release];
    if (identityTaggedImage) CGImageRelease(identityTaggedImage);
    if (identityColorSpace) CGColorSpaceRelease(identityColorSpace);

    CVPixelBufferRef identityBuffer = NULL;
    CMVideoFormatDescriptionRef identityFormat = NULL;
    CMSampleBufferRef identityFrame = NULL;
    CVReturn identityBufferResult = CVPixelBufferCreate(NULL, identityWidth, identityHeight,
        kCVPixelFormatType_32BGRA, NULL, &identityBuffer);
    BOOL identityBufferReady = identityBufferResult == kCVReturnSuccess && identityBuffer != NULL;
    if (identityBufferReady) {
        identityBufferReady = CVPixelBufferLockBaseAddress(identityBuffer, 0) == kCVReturnSuccess;
        if (identityBufferReady) {
            uint8_t *base = (uint8_t *)CVPixelBufferGetBaseAddress(identityBuffer);
            size_t bufferStride = CVPixelBufferGetBytesPerRow(identityBuffer);
            for (size_t row = 0; row < identityHeight; row++)
                memcpy(base + row * bufferStride, (const uint8_t *)identitySourcePixels.bytes + row * identityStride,
                    identityStride);
            identityBufferReady = CVPixelBufferUnlockBaseAddress(identityBuffer, 0) == kCVReturnSuccess;
        }
    }
    CGRect identityRectValue = CGRectMake(0, 0, identityWidth, identityHeight);
    NSDictionary *identityRect = [(NSDictionary *)CGRectCreateDictionaryRepresentation(identityRectValue) autorelease];
    NSDictionary *identityMetadata = @{
        SCStreamFrameInfoStatus: @(SCFrameStatusComplete),
        SCStreamFrameInfoDisplayTime: @987654323,
        SCStreamFrameInfoContentRect: identityRect,
        SCStreamFrameInfoScreenRect: identityRect,
        SCStreamFrameInfoContentScale: @1,
        SCStreamFrameInfoScaleFactor: @1,
    };
    CMSampleTimingInfo identityTiming = {kCMTimeInvalid, kCMTimeZero, kCMTimeInvalid};
    if (identityBufferReady && CMVideoFormatDescriptionCreateForImageBuffer(NULL, identityBuffer, &identityFormat) == noErr)
        CMSampleBufferCreateReadyWithImageBuffer(NULL, identityBuffer, identityFormat, &identityTiming, &identityFrame);
    if (identityFormat) CFRelease(identityFormat);
    if (identityBuffer) CVPixelBufferRelease(identityBuffer);
    if (identityFrame) {
        CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(identityFrame, true);
        if (attachments && CFArrayGetCount(attachments) == 1) {
            CFMutableDictionaryRef values = (CFMutableDictionaryRef)CFArrayGetValueAtIndex(attachments, 0);
            for (NSString *key in identityMetadata) CFDictionarySetValue(values, (__bridge CFStringRef)key,
                (__bridge CFTypeRef)identityMetadata[key]);
        }
    }
    check(identityFrame != NULL, @"the identity timing sample has complete frame metadata and a BGRA buffer");
    controlledTimes[0] = 300;
    controlledTimes[1] = 310;
    controlledTimes[2] = 320;
    controlledTimes[3] = 330;
    controlledTimes[4] = 340;
    controlledTimes[5] = 350;
    controlledTimes[6] = 360;
    controlledTimeIndex = 0;
    controlledTimeLimit = 7;
    originalClock = captureRawClock;
    captureRawClock = controlledRawClock;
    if (identityFrame) [used write:identityFrame callbackTime:captureRawClock()];
    captureRawClock = originalClock;
    if (identityFrame) CFRelease(identityFrame);
    dispatch_sync(captureWriter, ^{});
    BOOL identityTraceFinalized = sp_image_capture_match_write_manifest(identityTimingDirectory.fileSystemRepresentation);
    NSDictionary *identityTimedCallback = used.callbackStatusTrace.lastObject;
    NSString *identityDecodeTracePath = [identityTimingDirectory stringByAppendingPathComponent:
        @"frame-identities/decoded-frames.jsonl"];
    NSString *identityDecodeTrace = [NSString stringWithContentsOfFile:identityDecodeTracePath
        encoding:NSUTF8StringEncoding error:nil];
    NSString *identityTimingFailure = [NSString stringWithFormat:
        @"sourceReady=%@ clockIndex=%d callback=%@ writeStart=%@ imageMatch=%@..%@ enqueue=%@..%@ writeComplete=%@ decodedTrace=%@ captureError=%@",
        identitySourceReady ? @"YES" : @"NO", controlledTimeIndex, identityTimedCallback[@"callbackTime"],
        identityTimedCallback[@"writeStartTime"], identityTimedCallback[@"imageMatchStartTime"],
        identityTimedCallback[@"imageMatchCompleteTime"], identityTimedCallback[@"identityDecodeEnqueueStartTime"],
        identityTimedCallback[@"identityDecodeEnqueueCompleteTime"], identityTimedCallback[@"writeCompleteTime"],
        identityDecodeTrace ?: @"<missing>", [NSString stringWithUTF8String:sp_capture_error()]];
    check(identityTraceFinalized && identitySourceReady && controlledTimeIndex == 7
        && [identityTimedCallback[@"callbackTime"] isEqual:@"300"]
        && [identityTimedCallback[@"writeStartTime"] isEqual:@"310"]
        && [identityTimedCallback[@"imageMatchStartTime"] isEqual:@"320"]
        && [identityTimedCallback[@"imageMatchCompleteTime"] isEqual:@"330"]
        && [identityTimedCallback[@"identityDecodeEnqueueStartTime"] isEqual:@"340"]
        && [identityTimedCallback[@"identityDecodeEnqueueCompleteTime"] isEqual:@"350"]
        && identityTimedCallback[@"frameIdentityDecodeStartTime"] == [NSNull null]
        && identityTimedCallback[@"frameIdentityDecodeCompleteTime"] == [NSNull null]
        && [identityTimedCallback[@"writeCompleteTime"] isEqual:@"360"]
        && [identityDecodeTrace containsString:@"no-code"]
        && [identityDecodeTrace containsString:@"decodeEnqueuedTime"]
        && [identityDecodeTrace containsString:@"decodeStartTime"]
        && [identityDecodeTrace containsString:@"decodeCompleteTime"]
        && [NSString stringWithUTF8String:sp_capture_error()].length == 0,
        [NSString stringWithFormat:@"the active identity callback records snapshot/enqueue bounds and its asynchronous no-code result without errors (%@)",
            identityTimingFailure]);
    sp_image_capture_match_end();

    sp_image_capture_match_begin(directory.fileSystemRepresentation, captureWriter);
    check(finalizeCaptureArtifacts(used), @"the stopped recording finalizes its source manifest and callback trace");
    check([[NSFileManager defaultManager] fileExistsAtPath:
        [directory stringByAppendingPathComponent:kCaptureCallbackStatusFile]],
        @"the finalizer preserves the callback artifact path");
    NSString *displayLinkPath = [directory stringByAppendingPathComponent:@"display-link.json"];
    NSData *displayLinkData = [NSData dataWithContentsOfFile:displayLinkPath];
    NSDictionary *displayLinkRecord = displayLinkData
        ? [NSJSONSerialization JSONObjectWithData:displayLinkData options:0 error:nil] : nil;
    check([displayLinkRecord[@"state"] isEqual:@"unavailable"]
        && [displayLinkRecord[@"reason"] isKindOfClass:NSString.class]
        && [displayLinkRecord[@"observations"] isEqual:@[]]
        && [displayLinkRecord[@"omittedObservations"] isEqual:@0],
        @"finalization reports an explicit unavailable display-link trace when no observation was recorded");
    clearCaptureError();
    sp_image_capture_match_begin(directory.fileSystemRepresentation, captureWriter);
    char *failedSessionStartError = NULL;
    BOOL failedSessionStarted = sp_image_capture_match_identity_session_begin(&failedSessionStartError);
    free(failedSessionStartError);
    char *injectedSessionError = NULL;
    BOOL failureRecorded = failedSessionStarted
        && sp_image_capture_match_identity_session_fail("controlled asynchronous Vision failure", &injectedSessionError);
    free(injectedSessionError);
    BOOL failedFinalization = finalizeCaptureArtifacts(used);
    check(failureRecorded && !failedFinalization
        && strstr(sp_capture_error(), "controlled asynchronous Vision failure") != NULL,
        @"finalization reports an asynchronous identity decoder failure after draining its queues");
    clearCaptureError();
    kern_return_t (*displayLinkOriginalTimebaseReader)(mach_timebase_info_data_t *) = captureReadTimebase;
    captureReadTimebase = failedTimebase;
    [used displayLinkDidRefresh:nil];
    captureReadTimebase = displayLinkOriginalTimebaseReader;
    check([used.displayLinkState isEqual:@"unavailable"] && [NSString stringWithUTF8String:sp_capture_error()].length == 0,
        @"a late display-link callback after stop cannot report a timebase error into the next capture");

    SPCapture *windowReleaseFixture = [SPCapture new];
    NSWindow *retainedWindow = [[SPDisplayWindowReleaseProbe alloc] initWithContentRect:NSMakeRect(0, 0, 10, 10)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    windowReleaseFixture.displayWindow = retainedWindow;
    [retainedWindow release];
    displayWindowLastReleaseThread = -1;
    trackDisplayWindowReleases = 1;
    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        [windowReleaseFixture stopDisplayLinkObservation];
    });
    NSDate *windowReleaseDeadline = [NSDate dateWithTimeIntervalSinceNow:2];
    while (!windowReleaseFixture.displayLinkInvalidated
        && windowReleaseDeadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:
            [NSDate dateWithTimeIntervalSinceNow:MIN(0.01, windowReleaseDeadline.timeIntervalSinceNow)]];
    }
    trackDisplayWindowReleases = 0;
    check(windowReleaseFixture.displayLinkInvalidated
        && __atomic_load_n(&displayWindowLastReleaseThread, __ATOMIC_RELAXED) == 1,
        @"a retained capture window without a display link is released on the main thread after background stop");
    [windowReleaseFixture.displayWindow close];
    [windowReleaseFixture release];

    SPCapture *queuedInvalidationFixture = [SPCapture new];
    SPFakeDisplayLink *queuedLink = [SPFakeDisplayLink new];
    queuedInvalidationFixture.displayLink = (CADisplayLink *)queuedLink;
    queuedInvalidationFixture.displayLinkStopped = NO;
    queuedInvalidationFixture.displayLinkInvalidated = NO;
    dispatch_semaphore_t stopReturned = dispatch_semaphore_create(0);
    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        [queuedInvalidationFixture stopDisplayLinkObservation];
        dispatch_semaphore_signal(stopReturned);
    });
    long stopWait = dispatch_semaphore_wait(stopReturned, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
    check(stopWait == 0, @"the linked background stop returns after queuing main-thread invalidation");
    [queuedInvalidationFixture stopDisplayLinkObservation];
    check(!queuedInvalidationFixture.displayLinkInvalidated && queuedLink.invalidationCount == 0,
        @"a second resource-free stop does not complete or duplicate a queued invalidation");
    NSDate *queuedInvalidationDeadline = [NSDate dateWithTimeIntervalSinceNow:2];
    while (!queuedInvalidationFixture.displayLinkInvalidated && queuedInvalidationDeadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:
            [NSDate dateWithTimeIntervalSinceNow:MIN(0.01, queuedInvalidationDeadline.timeIntervalSinceNow)]];
    }
    check(queuedInvalidationFixture.displayLinkInvalidated && queuedLink.invalidationCount == 1,
        @"the original queued invalidation completes once on the main run loop");
    [queuedLink release];
    [queuedInvalidationFixture release];

    NSWindow *lookupWindow = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 10, 10)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    lookupWindow.releasedWhenClosed = NO;
    SPCapture *lookupRaceFixture = [SPCapture new];
    displayLinkWindowLookupReached = dispatch_semaphore_create(0);
    displayLinkWindowLookupResume = dispatch_semaphore_create(0);
    displayLinkWindowLookupHookWaitResult = -1;
    displayLinkWindowLookupFound = 0;
    displayLinkLookupRaceStopReturned = 0;
    captureDisplayLinkAfterWindowLookup = pauseDisplayLinkInstallationAfterWindowLookup;
    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        [lookupRaceFixture startDisplayLinkObservationForWindowNumber:lookupWindow.windowNumber];
        long lookupWait = dispatch_semaphore_wait(displayLinkWindowLookupReached,
            dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
        if (lookupWait == 0) [lookupRaceFixture stopDisplayLinkObservation];
        __atomic_store_n(&displayLinkLookupRaceStopReturned, lookupWait == 0 ? 1 : 2, __ATOMIC_RELAXED);
        dispatch_semaphore_signal(displayLinkWindowLookupResume);
    });
    NSDate *lookupRaceDeadline = [NSDate dateWithTimeIntervalSinceNow:3];
    while (__atomic_load_n(&displayLinkLookupRaceStopReturned, __ATOMIC_RELAXED) == 0
        && lookupRaceDeadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:
            [NSDate dateWithTimeIntervalSinceNow:MIN(0.01, lookupRaceDeadline.timeIntervalSinceNow)]];
    }
    captureDisplayLinkAfterWindowLookup = NULL;
    check(__atomic_load_n(&displayLinkLookupRaceStopReturned, __ATOMIC_RELAXED) == 1
        && displayLinkWindowLookupHookWaitResult == 0
        && __atomic_load_n(&displayLinkWindowLookupFound, __ATOMIC_RELAXED) == 1
        && lookupRaceFixture.displayLinkStopped
        && lookupRaceFixture.displayWindow == nil && lookupRaceFixture.displayLink == nil,
        @"a stop during window lookup prevents the installer from retaining or creating resources afterward");
    [lookupWindow close];
    [lookupWindow release];
    [lookupRaceFixture release];
    dispatch_release(displayLinkWindowLookupResume);
    dispatch_release(displayLinkWindowLookupReached);

    SPCapture *lateFailureFixture = [SPCapture new];
    displayLinkClockReadEntered = dispatch_semaphore_create(0);
    displayLinkClockReadResume = dispatch_semaphore_create(0);
    dispatch_semaphore_t lateCallbackFinished = dispatch_semaphore_create(0);
    kern_return_t (*originalDisplayLinkTimebaseReader)(mach_timebase_info_data_t *) = captureReadTimebase;
    clearCaptureError();
    captureReadTimebase = delayedFailedDisplayLinkTimebase;
    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        [lateFailureFixture displayLinkDidRefresh:nil];
        dispatch_semaphore_signal(lateCallbackFinished);
    });
    long callbackEntered = dispatch_semaphore_wait(displayLinkClockReadEntered,
        dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
    [lateFailureFixture stopDisplayLinkObservation];
    dispatch_semaphore_signal(displayLinkClockReadResume);
    long callbackFinished = dispatch_semaphore_wait(lateCallbackFinished,
        dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
    captureReadTimebase = originalDisplayLinkTimebaseReader;
    check(callbackEntered == 0 && callbackFinished == 0
        && [lateFailureFixture.displayLinkState isEqual:@"unavailable"]
        && lateFailureFixture.omittedDisplayLinkObservations == 0
        && [NSString stringWithUTF8String:sp_capture_error()].length == 0,
        @"a callback clock failure completing after stop cannot taint the next capture");
    [lateFailureFixture release];
    dispatch_release(lateCallbackFinished);
    dispatch_release(displayLinkClockReadResume);
    dispatch_release(displayLinkClockReadEntered);

    NSString *observationDirectory = [directory stringByAppendingPathComponent:@"display-link-observations"];
    NSError *observationDirectoryError = nil;
    BOOL observationDirectoryCreated = [[NSFileManager defaultManager] createDirectoryAtPath:observationDirectory
        withIntermediateDirectories:YES attributes:nil error:&observationDirectoryError];
    check(observationDirectoryCreated, [NSString stringWithFormat:@"the display-link fixture directory is created (%@)", observationDirectoryError]);
    SPCapture *observationFixture = [SPCapture new];
    observationFixture.directory = observationDirectory;
    mach_timebase_info_data_t observationTimebase = {};
    mach_timebase_info(&observationTimebase);
    uint64_t firstCallbackTime = mach_absolute_time();
    double firstMediaTime = CACurrentMediaTime();
    uint64_t firstMediaClockAfter = mach_absolute_time();
    double firstTimestamp = firstMediaTime - 0.05;
    [observationFixture recordDisplayLinkTimestamp:firstTimestamp targetTimestamp:firstTimestamp + 0.016 duration:0.016
        callbackTime:firstCallbackTime mediaClockTime:firstMediaTime mediaClockAfter:firstMediaClockAfter
        timebase:observationTimebase windowNumber:41 displayID:@(7)
        visible:YES occluded:NO applicationActive:NO];
    uint64_t secondCallbackTime = mach_absolute_time();
    double secondMediaTime = CACurrentMediaTime();
    uint64_t secondMediaClockAfter = mach_absolute_time();
    double secondTimestamp = firstTimestamp + 0.001;
    [observationFixture recordDisplayLinkTimestamp:secondTimestamp targetTimestamp:secondTimestamp + 0.016 duration:0.016
        callbackTime:secondCallbackTime mediaClockTime:secondMediaTime mediaClockAfter:secondMediaClockAfter
        timebase:observationTimebase windowNumber:41 displayID:@(7)
        visible:YES occluded:YES applicationActive:NO];
    sp_image_capture_match_begin(observationDirectory.fileSystemRepresentation, captureWriter);
    check(finalizeCaptureArtifacts(observationFixture), @"the finalizer writes a controlled display-link observation trace");
    NSData *observationData = [NSData dataWithContentsOfFile:
        [observationDirectory stringByAppendingPathComponent:kCaptureDisplayLinkFile]];
    NSDictionary *observationTrace = observationData
        ? [NSJSONSerialization JSONObjectWithData:observationData options:0 error:nil] : nil;
    NSArray *observations = observationTrace[@"observations"];
    NSDictionary *firstObservation = observations.count > 0 ? observations[0] : nil;
    NSDictionary *secondObservation = observations.count > 1 ? observations[1] : nil;
    check([observationTrace[@"state"] isEqual:@"available"] && observations.count == 2
        && [firstObservation[@"sequence"] isEqual:@1] && [secondObservation[@"sequence"] isEqual:@2]
        && [firstObservation[@"windowNumber"] isEqual:@41] && [firstObservation[@"displayID"] isEqual:@7]
        && [firstObservation[@"visible"] isEqual:@YES] && [firstObservation[@"occluded"] isEqual:@NO]
        && [secondObservation[@"occluded"] isEqual:@YES] && [secondObservation[@"applicationActive"] isEqual:@NO]
        && [firstObservation[@"callbackTime"] isKindOfClass:NSString.class]
        && [firstObservation[@"callbackMediaTime"] isKindOfClass:NSNumber.class]
        && [firstObservation[@"mediaClockAfter"] isKindOfClass:NSString.class]
        && [firstObservation[@"machTimebaseNumerator"] unsignedIntValue] == observationTimebase.numer
        && [firstObservation[@"machTimebaseDenominator"] unsignedIntValue] == observationTimebase.denom,
        [NSString stringWithFormat:@"the finalized display-link trace preserves ordered timestamps, raw callback clock, timebase, and window state (%@)", observationTrace]);
    [observationFixture release];

    NSString *visibilityDirectory = [directory stringByAppendingPathComponent:@"display-link-visibility"];
    [[NSFileManager defaultManager] createDirectoryAtPath:visibilityDirectory withIntermediateDirectories:YES attributes:nil error:nil];
    SPCapture *visibilityFixture = [SPCapture new];
    visibilityFixture.directory = visibilityDirectory;
    uint64_t visibilityBefore = mach_absolute_time();
    double visibilityMedia = CACurrentMediaTime();
    uint64_t visibilityAfter = mach_absolute_time();
    double visibilityTimestamp = visibilityMedia - 0.02;
    [visibilityFixture recordDisplayLinkTimestamp:visibilityTimestamp targetTimestamp:visibilityTimestamp + 0.016 duration:0.016
        callbackTime:visibilityBefore mediaClockTime:visibilityMedia mediaClockAfter:visibilityAfter
        timebase:observationTimebase windowNumber:41 displayID:@7 visible:YES occluded:NO applicationActive:YES];
    uint64_t hiddenBefore = mach_absolute_time();
    double hiddenMedia = CACurrentMediaTime();
    uint64_t hiddenAfter = mach_absolute_time();
    double hiddenTimestamp = visibilityTimestamp + 0.001;
    [visibilityFixture recordDisplayLinkTimestamp:hiddenTimestamp targetTimestamp:hiddenTimestamp + 0.016 duration:0.016
        callbackTime:hiddenBefore mediaClockTime:hiddenMedia mediaClockAfter:hiddenAfter
        timebase:observationTimebase windowNumber:41 displayID:@7 visible:NO occluded:YES applicationActive:YES];
    uint64_t offDisplayBefore = mach_absolute_time();
    double offDisplayMedia = CACurrentMediaTime();
    uint64_t offDisplayAfter = mach_absolute_time();
    double offDisplayTimestamp = hiddenTimestamp + 0.001;
    [visibilityFixture recordDisplayLinkTimestamp:offDisplayTimestamp targetTimestamp:offDisplayTimestamp + 0.016 duration:0.016
        callbackTime:offDisplayBefore mediaClockTime:offDisplayMedia mediaClockAfter:offDisplayAfter
        timebase:observationTimebase windowNumber:41 displayID:nil visible:YES occluded:NO applicationActive:YES];
    sp_image_capture_match_begin(visibilityDirectory.fileSystemRepresentation, captureWriter);
    check(finalizeCaptureArtifacts(visibilityFixture), @"the hidden-window display-link trace is finalized");
    NSData *visibilityData = [NSData dataWithContentsOfFile:
        [visibilityDirectory stringByAppendingPathComponent:kCaptureDisplayLinkFile]];
    NSDictionary *visibilityTrace = visibilityData
        ? [NSJSONSerialization JSONObjectWithData:visibilityData options:0 error:nil] : nil;
    NSArray *visibilityObservations = visibilityTrace[@"observations"];
    NSDictionary *offDisplayObservation = visibilityObservations.count > 2 ? visibilityObservations[2] : nil;
    NSDictionary *hiddenObservation = visibilityObservations.count > 1 ? visibilityObservations[1] : nil;
    check([visibilityTrace[@"state"] isEqual:@"unavailable"]
        && visibilityObservations.count == 3
        && [visibilityTrace[@"reason"] isEqual:@"the captured window had no display during a display-link observation"]
        && [hiddenObservation[@"visible"] isEqual:@NO]
        && [offDisplayObservation[@"displayID"] isEqual:NSNull.null],
        [NSString stringWithFormat:@"hidden and off-display observations remain recorded but cannot claim available refresh coverage (%@)", visibilityTrace]);
    [visibilityFixture release];

    NSString *invalidDirectory = [directory stringByAppendingPathComponent:@"display-link-invalid"];
    [[NSFileManager defaultManager] createDirectoryAtPath:invalidDirectory withIntermediateDirectories:YES attributes:nil error:nil];
    SPCapture *invalidFixture = [SPCapture new];
    invalidFixture.directory = invalidDirectory;
    uint64_t invalidCallbackTime = mach_absolute_time();
    double invalidMediaTime = CACurrentMediaTime();
    uint64_t invalidMediaClockAfter = mach_absolute_time();
    double invalidTimestamp = invalidMediaTime - 0.02;
    [invalidFixture recordDisplayLinkTimestamp:invalidTimestamp targetTimestamp:invalidTimestamp + 0.016 duration:0.016
        callbackTime:invalidCallbackTime mediaClockTime:invalidMediaTime mediaClockAfter:invalidMediaClockAfter
        timebase:observationTimebase windowNumber:41 displayID:@7
        visible:YES occluded:NO applicationActive:YES];
    double regressedMediaTime = CACurrentMediaTime();
    uint64_t regressedAfter = mach_absolute_time();
    double regressedTimestamp = regressedMediaTime - 0.01;
    [invalidFixture recordDisplayLinkTimestamp:regressedTimestamp targetTimestamp:regressedTimestamp - 0.001 duration:0.016
        callbackTime:invalidCallbackTime - 1 mediaClockTime:regressedMediaTime mediaClockAfter:regressedAfter
        timebase:observationTimebase windowNumber:41 displayID:@7
        visible:YES occluded:NO applicationActive:YES];
    check([invalidFixture.displayLinkState isEqual:@"incomplete"]
        && invalidFixture.omittedDisplayLinkObservations == 1
        && invalidFixture.displayLinkObservations.count == 1
        && [[NSString stringWithUTF8String:sp_capture_error()] containsString:@"display-link trace incomplete"],
        @"a regressed display-link callback clock is rejected without discarding its valid prefix");
    sp_image_capture_match_begin(invalidDirectory.fileSystemRepresentation, captureWriter);
    check(finalizeCaptureArtifacts(invalidFixture), @"a clock-invalid display-link trace still writes its final artifact");
    NSData *invalidData = [NSData dataWithContentsOfFile:
        [invalidDirectory stringByAppendingPathComponent:kCaptureDisplayLinkFile]];
    NSDictionary *invalidTrace = invalidData
        ? [NSJSONSerialization JSONObjectWithData:invalidData options:0 error:nil] : nil;
    check([invalidTrace[@"state"] isEqual:@"incomplete"]
        && [invalidTrace[@"observations"] count] == 1
        && [invalidTrace[@"omittedObservations"] isEqual:@1],
        @"the clock-invalid artifact preserves its valid prefix and omitted observation count");
    [invalidFixture release];
    clearCaptureError();

    NSString *boundaryDirectory = [directory stringByAppendingPathComponent:@"display-link-clock-boundary"];
    [[NSFileManager defaultManager] createDirectoryAtPath:boundaryDirectory withIntermediateDirectories:YES attributes:nil error:nil];
    SPCapture *boundaryFixture = [SPCapture new];
    boundaryFixture.directory = boundaryDirectory;
    uint64_t boundaryCallbackTime = mach_absolute_time();
    double boundaryMediaTime = CACurrentMediaTime();
    uint64_t boundaryMediaClockAfter = mach_absolute_time();
    [boundaryFixture recordDisplayLinkTimestamp:1e20 targetTimestamp:1e20 + 1e10 duration:0.016
        callbackTime:boundaryCallbackTime mediaClockTime:boundaryMediaTime mediaClockAfter:boundaryMediaClockAfter
        timebase:observationTimebase windowNumber:41 displayID:@7
        visible:YES occluded:NO applicationActive:YES];
    check([boundaryFixture.displayLinkState isEqual:@"incomplete"]
        && boundaryFixture.omittedDisplayLinkObservations == 1
        && boundaryFixture.displayLinkObservations.count == 0,
        @"a timestamp whose Mach conversion exceeds the unsigned clock range is rejected");
    [boundaryFixture release];
    clearCaptureError();

    NSString *timebaseDirectory = [directory stringByAppendingPathComponent:@"display-link-timebase-change"];
    [[NSFileManager defaultManager] createDirectoryAtPath:timebaseDirectory withIntermediateDirectories:YES attributes:nil error:nil];
    SPCapture *timebaseFixture = [SPCapture new];
    timebaseFixture.directory = timebaseDirectory;
    uint64_t timebaseBefore = mach_absolute_time();
    double timebaseMedia = CACurrentMediaTime();
    uint64_t timebaseAfter = mach_absolute_time();
    double timebaseTimestamp = timebaseMedia - 0.02;
    [timebaseFixture recordDisplayLinkTimestamp:timebaseTimestamp targetTimestamp:timebaseTimestamp + 0.016 duration:0.016
        callbackTime:timebaseBefore mediaClockTime:timebaseMedia mediaClockAfter:timebaseAfter
        timebase:observationTimebase windowNumber:41 displayID:@7 visible:YES occluded:NO applicationActive:YES];
    mach_timebase_info_data_t changedTimebase = observationTimebase;
    changedTimebase.numer++;
    uint64_t changedBefore = mach_absolute_time();
    double changedMedia = CACurrentMediaTime();
    uint64_t changedAfter = mach_absolute_time();
    double changedTimestamp = timebaseTimestamp + 0.001;
    [timebaseFixture recordDisplayLinkTimestamp:changedTimestamp targetTimestamp:changedTimestamp + 0.016 duration:0.016
        callbackTime:changedBefore mediaClockTime:changedMedia mediaClockAfter:changedAfter
        timebase:changedTimebase windowNumber:41 displayID:@7 visible:YES occluded:NO applicationActive:YES];
    check([timebaseFixture.displayLinkState isEqual:@"incomplete"]
        && timebaseFixture.omittedDisplayLinkObservations == 1
        && timebaseFixture.displayLinkObservations.count == 1,
        @"a changed Mach timebase invalidates the clock correlation and preserves its valid prefix");
    [timebaseFixture release];
    clearCaptureError();

    NSString *overflowDirectory = [directory stringByAppendingPathComponent:@"display-link-overflow"];
    [[NSFileManager defaultManager] createDirectoryAtPath:overflowDirectory withIntermediateDirectories:YES attributes:nil error:nil];
    SPCapture *overflowFixture = [SPCapture new];
    overflowFixture.directory = overflowDirectory;
    double overflowBase = CACurrentMediaTime();
    for (NSUInteger index = 0; index < 4097; index++) {
        double timestamp = overflowBase + (double)index * 0.001;
        double mediaClockTime = timestamp + 0.00025;
        uint64_t callbackTime = rawMachForMediaTime(timestamp + 0.0002, observationTimebase);
        uint64_t mediaClockAfter = rawMachForMediaTime(timestamp + 0.0003, observationTimebase);
        [overflowFixture recordDisplayLinkTimestamp:timestamp targetTimestamp:timestamp + 0.016 duration:0.016
            callbackTime:callbackTime mediaClockTime:mediaClockTime mediaClockAfter:mediaClockAfter
            timebase:observationTimebase windowNumber:41 displayID:@7
            visible:YES occluded:NO applicationActive:YES];
    }
    check(overflowFixture.displayLinkObservations.count == 4096
        && overflowFixture.omittedDisplayLinkObservations == 1
        && [overflowFixture.displayLinkState isEqual:@"incomplete"]
        && [[NSString stringWithUTF8String:sp_capture_error()] containsString:@"capacity exceeded"],
        @"the display-link trace records its 4096 bound, omitted count, incomplete state, and explicit error");
    sp_image_capture_match_begin(overflowDirectory.fileSystemRepresentation, captureWriter);
    check(finalizeCaptureArtifacts(overflowFixture), @"an incomplete display-link trace still writes its final artifact");
    NSData *overflowData = [NSData dataWithContentsOfFile:
        [overflowDirectory stringByAppendingPathComponent:kCaptureDisplayLinkFile]];
    NSDictionary *overflowTrace = overflowData
        ? [NSJSONSerialization JSONObjectWithData:overflowData options:0 error:nil] : nil;
    check([overflowTrace[@"state"] isEqual:@"incomplete"]
        && [overflowTrace[@"observations"] count] == 4096
        && [overflowTrace[@"omittedObservations"] isEqual:@1]
        && [overflowTrace[@"reason"] isEqual:@"display-link observation capacity exceeded (4096 records)"],
        @"the incomplete artifact preserves all accepted records and the exact omitted callback count");
    [overflowFixture release];
    clearCaptureError();

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
    savedCallbackStream = captureStream;
    savedCallbackAcceptance = captureAcceptingSamples;
    @synchronized ([SPCapture class]) {
        captureStream = testStream;
        captureAcceptingSamples = YES;
    }
    [used stream:testStream didOutputSampleBuffer:noTimebaseFrame ofType:SCStreamOutputTypeScreen];
    @synchronized ([SPCapture class]) {
        captureStream = savedCallbackStream;
        captureAcceptingSamples = savedCallbackAcceptance;
    }
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

    beginSequence(&used);
    SCStream *previousStream = (SCStream *)[NSObject new];
    SCStream *currentStream = (SCStream *)[NSObject new];
    SPCaptureAttempt *previousAttempt = [[SPCaptureAttempt alloc] init];
    previousAttempt.session = @"capture-previous";
    SPCaptureAttempt *currentAttempt = [[SPCaptureAttempt alloc] init];
    currentAttempt.session = @"capture-current";
    objc_setAssociatedObject(previousStream, &captureAttemptAssociationKey, previousAttempt, OBJC_ASSOCIATION_RETAIN);
    objc_setAssociatedObject(currentStream, &captureAttemptAssociationKey, currentAttempt, OBJC_ASSOCIATION_RETAIN);
    SCStream *savedStream = captureStream;
    BOOL savedAcceptingSamples = captureAcceptingSamples;
    @synchronized([SPCapture class]) {
        captureStream = currentStream;
        captureAcceptingSamples = YES;
    }
    dispatch_semaphore_t savedCaughtUp = captureCaughtUp;
    dispatch_semaphore_t fixtureCaughtUp = dispatch_semaphore_create(0);
    captureCaughtUp = fixtureCaughtUp;
    dispatch_semaphore_t savedFirstFrame = captureFirstFrame;
    dispatch_semaphore_t fixtureFirstFrame = dispatch_semaphore_create(0);
    captureFirstFrame = fixtureFirstFrame;
    uint64_t savedStopAfter = captureStopAfter;
    uint64_t savedStartedAt = captureStartedAt;
    BOOL savedResizing = captureResizing;
    captureResizing = NO;
    captureStartedAt = 0;
    CMSampleBufferRef previousSample = sample(YES, complete(nil));
    CMSampleBufferRef repeatedPreviousSample = sample(YES, complete(nil));
    uint64_t previousDisplayTime = 0;
    BOOL hasPreviousDisplayTime = previousSample != NULL && displayTime(previousSample, &previousDisplayTime);
    captureStopAfter = previousDisplayTime;
    int writtenBeforeStale = used.written;
    int queuedBeforeStale = used.queued;
    NSUInteger traceBeforeStale = used.callbackStatusTrace.count;
    __block long staleStopSignal = 0;
    __block long staleReadySignal = 0;
    const int8_t captureTracePolicy[SP_CLASS_COUNT] = {SP_EVENT_DEBUG, SP_EVENT_ERROR, SP_EVENT_ERROR,
        SP_EVENT_ERROR, SP_EVENT_ERROR};
    const int8_t defaultCapturePolicy[SP_CLASS_COUNT] = {SP_EVENT_ERROR, SP_EVENT_ERROR, SP_EVENT_ERROR,
        SP_EVENT_ERROR, SP_EVENT_ERROR};
    check(sp_event_set_policy(captureTracePolicy), @"the fixture enables lifecycle debug events before capture");
    NSArray<NSDictionary *> *staleEvents = capturedEvents(^{
        if (previousSample != NULL)
            [used stream:previousStream didOutputSampleBuffer:previousSample ofType:SCStreamOutputTypeScreen];
        if (repeatedPreviousSample != NULL)
            [used stream:previousStream didOutputSampleBuffer:repeatedPreviousSample ofType:SCStreamOutputTypeScreen];
        dispatch_sync(captureWriter, ^{});
        staleStopSignal = dispatch_semaphore_wait(captureCaughtUp, DISPATCH_TIME_NOW);
        staleReadySignal = dispatch_semaphore_wait(captureFirstFrame, DISPATCH_TIME_NOW);
    });
    check(sp_event_set_policy(defaultCapturePolicy), @"the fixture restores the default error-only event policy");
    NSMutableArray<NSDictionary *> *discardedCallbacks = [NSMutableArray array];
    for (NSDictionary *event in staleEvents) {
        NSDictionary *fields = event[@"fields"];
        if ([event[@"name"] isEqual:@"native.capture.lifecycle"]
            && [fields[@"phase"] isEqual:@"sample-discarded"])
            [discardedCallbacks addObject:event];
    }
    check(previousSample != NULL && hasPreviousDisplayTime && previousAttempt.firstSampleSeen
        && !currentAttempt.firstSampleSeen && used.written == writtenBeforeStale
        && used.queued == queuedBeforeStale && used.callbackStatusTrace.count == traceBeforeStale
        && captureStopAfter == previousDisplayTime && staleStopSignal != 0 && staleReadySignal != 0
        && strlen(sp_capture_error()) == 0 && discardedCallbacks.count == 2
        && [discardedCallbacks[0][@"fields"][@"session"] isEqual:previousAttempt.session]
        && [discardedCallbacks[1][@"fields"][@"session"] isEqual:previousAttempt.session]
        && [discardedCallbacks[0][@"fields"][@"reason"] isEqual:@"stream-replaced"]
        && [discardedCallbacks[1][@"fields"][@"reason"] isEqual:@"stream-replaced"],
        [NSString stringWithFormat:@"repeated valid late samples record only their old attempt and leave current capture state unchanged (old %p current %p, old attempt %d, current attempt %d, discarded %lu, written %d/%d, queued %d/%d, trace %lu/%lu, stop %llu/%llu, stop signaled %d, ready signaled %d, error %@)",
            previousStream, currentStream,
            previousAttempt.firstSampleSeen, currentAttempt.firstSampleSeen,
            (unsigned long)discardedCallbacks.count,
            used.written, writtenBeforeStale, used.queued, queuedBeforeStale,
            (unsigned long)used.callbackStatusTrace.count, (unsigned long)traceBeforeStale,
            (unsigned long long)captureStopAfter, (unsigned long long)previousDisplayTime,
            staleStopSignal == 0, staleReadySignal == 0, [NSString stringWithUTF8String:sp_capture_error()]]);
    if (previousSample != NULL) CFRelease(previousSample);
    if (repeatedPreviousSample != NULL) CFRelease(repeatedPreviousSample);

    CMSampleBufferRef currentSample = sample(YES, complete(nil));
    uint64_t currentDisplayTime = 0;
    BOOL hasCurrentDisplayTime = currentSample != NULL && displayTime(currentSample, &currentDisplayTime);
    captureStopAfter = currentDisplayTime;
    long currentStopSignal = -1;
    long currentReadySignal = -1;
    if (currentSample != NULL) {
        [used stream:currentStream didOutputSampleBuffer:currentSample ofType:SCStreamOutputTypeScreen];
        dispatch_sync(captureWriter, ^{});
        currentStopSignal = dispatch_semaphore_wait(captureCaughtUp, DISPATCH_TIME_NOW);
        currentReadySignal = dispatch_semaphore_wait(captureFirstFrame, DISPATCH_TIME_NOW);
    }
    check(currentSample != NULL && hasCurrentDisplayTime && currentAttempt.firstSampleSeen
        && used.written == writtenBeforeStale + 1
        && used.queued == queuedBeforeStale + 1 && used.callbackStatusTrace.count == traceBeforeStale + 1
        && captureStopAfter == 0 && currentStopSignal == 0 && currentReadySignal == 0
        && strlen(sp_capture_error()) == 0,
        [NSString stringWithFormat:@"the current stream sample still updates its recording and satisfies the stop boundary (current %p, attempt %d, written %d, queued %d, trace %lu, stop %llu, stop signaled %d, ready signaled %d, error %@)",
            currentStream, currentAttempt.firstSampleSeen, used.written, used.queued, (unsigned long)used.callbackStatusTrace.count,
            (unsigned long long)captureStopAfter, currentStopSignal == 0, currentReadySignal == 0,
            [NSString stringWithUTF8String:sp_capture_error()]]);
    if (currentSample != NULL) CFRelease(currentSample);

    CMSampleBufferRef retiredSample = sample(YES, complete(nil));
    uint64_t retiredDisplayTime = 0;
    BOOL hasRetiredDisplayTime = retiredSample != NULL && displayTime(retiredSample, &retiredDisplayTime);
    captureStopAfter = retiredDisplayTime;
    int writtenBeforeRetired = used.written;
    int queuedBeforeRetired = used.queued;
    NSUInteger traceBeforeRetired = used.callbackStatusTrace.count;
    closeCaptureSampleIntake(currentStream);
    check(sp_event_set_policy(captureTracePolicy), @"the fixture enables lifecycle debug events for the retired stream");
    __block long retiredStopSignal = -1;
    __block long retiredReadySignal = -1;
    NSArray<NSDictionary *> *retiredEvents = capturedEvents(^{
        if (retiredSample != NULL)
            [used stream:currentStream didOutputSampleBuffer:retiredSample ofType:SCStreamOutputTypeScreen];
        dispatch_sync(captureWriter, ^{});
        retiredStopSignal = dispatch_semaphore_wait(captureCaughtUp, DISPATCH_TIME_NOW);
        retiredReadySignal = dispatch_semaphore_wait(captureFirstFrame, DISPATCH_TIME_NOW);
    });
    check(sp_event_set_policy(defaultCapturePolicy), @"the fixture restores the default error-only event policy");
    NSMutableArray<NSDictionary *> *retiredCallbacks = [NSMutableArray array];
    for (NSDictionary *event in retiredEvents) {
        NSDictionary *fields = event[@"fields"];
        if ([event[@"name"] isEqual:@"native.capture.lifecycle"]
            && [fields[@"phase"] isEqual:@"sample-discarded"])
            [retiredCallbacks addObject:event];
    }
    check(retiredSample != NULL && hasRetiredDisplayTime && used.written == writtenBeforeRetired
        && used.queued == queuedBeforeRetired && used.callbackStatusTrace.count == traceBeforeRetired
        && captureStopAfter == retiredDisplayTime && retiredStopSignal != 0 && retiredReadySignal != 0
        && strlen(sp_capture_error()) == 0 && retiredCallbacks.count == 1
        && [retiredCallbacks[0][@"fields"][@"session"] isEqual:currentAttempt.session]
        && [retiredCallbacks[0][@"fields"][@"reason"] isEqual:@"sample-intake-closed"],
        [NSString stringWithFormat:@"a callback queued after the sample-intake fence is recorded against the stopped attempt without mutating it (written %d/%d, queued %d/%d, trace %lu/%lu, stop %llu/%llu, stop signaled %d, ready signaled %d, discarded %lu, error %@)",
            used.written, writtenBeforeRetired, used.queued, queuedBeforeRetired,
            (unsigned long)used.callbackStatusTrace.count, (unsigned long)traceBeforeRetired,
            (unsigned long long)captureStopAfter, (unsigned long long)retiredDisplayTime,
            retiredStopSignal == 0, retiredReadySignal == 0, (unsigned long)retiredCallbacks.count,
            [NSString stringWithUTF8String:sp_capture_error()]]);
    if (retiredSample != NULL) CFRelease(retiredSample);

    SCStream *unattributedStream = (SCStream *)[NSObject new];
    CMSampleBufferRef unattributedSample = sample(YES, complete(nil));
    int writtenBeforeUnattributed = used.written;
    int queuedBeforeUnattributed = used.queued;
    NSString *unattributedRecord = capturedRecords(^{
        if (unattributedSample != NULL)
            [used stream:unattributedStream didOutputSampleBuffer:unattributedSample ofType:SCStreamOutputTypeScreen];
        dispatch_sync(captureWriter, ^{});
    });
    check(unattributedSample != NULL && used.written == writtenBeforeUnattributed
        && used.queued == queuedBeforeUnattributed
        && [unattributedRecord containsString:@"error native capture sample: discarded callback has no stream attempt context"],
        @"a discarded callback without an attempt context is reported without changing the recording");
    if (unattributedSample != NULL) CFRelease(unattributedSample);
    [unattributedStream release];

    objc_setAssociatedObject(previousStream, &captureAttemptAssociationKey, nil, OBJC_ASSOCIATION_ASSIGN);
    objc_setAssociatedObject(currentStream, &captureAttemptAssociationKey, nil, OBJC_ASSOCIATION_ASSIGN);
    [previousAttempt release];
    [currentAttempt release];
    @synchronized([SPCapture class]) {
        captureStream = savedStream;
        captureAcceptingSamples = savedAcceptingSamples;
    }
    captureStopAfter = savedStopAfter;
    captureStartedAt = savedStartedAt;
    captureResizing = savedResizing;
    captureCaughtUp = savedCaughtUp;
    captureFirstFrame = savedFirstFrame;
    dispatch_release(fixtureCaughtUp);
    dispatch_release(fixtureFirstFrame);
    [previousStream release];
    [currentStream release];

    NSError *removal = nil;
    check([[NSFileManager defaultManager] removeItemAtPath:directory error:&removal],
        [NSString stringWithFormat:@"fixture files are removed (%@)", removal]);
    fprintf(stderr, "%s: native capture frame metadata validation (%.1fms)\n", failures ? "FAIL" : "PASS",
        (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
