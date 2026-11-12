// Checks the metadata that a still recording writes beside its frames, through the real still path (processStill, the frame
// writer and finalizeCaptureArtifacts) with a hand-built recording and target, so it needs no window:
// - the source artifacts of the image match: the manifest, the source files only when their reader needs them, a failed
//   partial-file cleanup, the 512-identity bound, sources beyond 64 MiB, a multi-frame burst and the pending byte bound;
// - the row of each still in stills.jsonl: the request and completion times with the read of the pixels between them, the
//   stage ticks as decimal strings, absent stages as null, the mach timebase, the image match, the frame marker and the
//   asynchronous writer bounds;
// - the identity decode of an identity session, and its asynchronous failure at finalization;
// - the display-link trace in display-link.json: unavailable without observations, ordered observations with window state,
//   hidden and off-display observations, rejected clocks, a changed timebase and the 4096-record bound;
// - the release of the display-link resources on the main thread;
// - the lifecycle debug events of a recording (start, first-still, still-failed, stop, end) and their fields.
#import "../src/capture.m"
#import "../src/capture_frame_identity.h"
#import "support/records.h"
#import "support/run_until.h"
#import "support/temporary_folder.h"
#import "support/capture_frame.m"
#import <CommonCrypto/CommonDigest.h>
#import "event_ring.h"
#include <sys/stat.h>
#include <stdatomic.h>

static int failures;

static void check(BOOL ok, NSString *label) {
    fprintf(stderr, "%s: %s\n", ok ? "PASS" : "FAIL", label.UTF8String);
    if (!ok) failures++;
}

static uint64_t rawMachForMediaTime(double seconds, mach_timebase_info_data_t timebase) {
    return (uint64_t)roundl((long double)seconds * 1e9L * (long double)timebase.denom / (long double)timebase.numer);
}

@interface SPFakeDisplayLink : NSObject
@property (nonatomic) NSUInteger invalidationCount;
@property (nonatomic) int invalidationThread;
- (void)invalidate;
@end
@implementation SPFakeDisplayLink
- (void)invalidate {
    self.invalidationCount++;
    self.invalidationThread = NSThread.isMainThread ? 1 : 0;
}
@end

static int displayWindowReleaseThread = -1;
static int trackDisplayWindowReleases;
@interface SPDisplayWindowReleaseProbe : NSWindow
@end
@implementation SPDisplayWindowReleaseProbe
- (oneway void)release {
    if (__atomic_load_n(&trackDisplayWindowReleases, __ATOMIC_RELAXED))
        __atomic_store_n(&displayWindowReleaseThread, NSThread.isMainThread ? 1 : 0, __ATOMIC_RELAXED);
    [super release];
}
@end

// An sRGB BGRA image of pixels, width x height, as the window server gives a still.
static CGImageRef imageOf(NSData *pixels, size_t width, size_t height) {
    CGColorSpaceRef colorSpace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGDataProviderRef provider = CGDataProviderCreateWithCFData((CFDataRef)pixels);
    CGImageRef image = colorSpace && provider ? CGImageCreate(width, height, 8, 32, width * 4, colorSpace,
        (CGBitmapInfo)kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little, provider, NULL, false,
        kCGRenderingIntentDefault) : NULL;
    if (provider) CGDataProviderRelease(provider);
    if (colorSpace) CGColorSpaceRelease(colorSpace);
    return image;
}

static NSData *opaquePixels(size_t width, size_t height, uint8_t value) {
    NSMutableData *pixels = [NSMutableData dataWithLength:width * height * 4];
    uint8_t *bytes = pixels.mutableBytes;
    for (size_t offset = 0; offset < pixels.length; offset++) bytes[offset] = offset % 4 == 3 ? 255 : value;
    return pixels;
}

// A recording of planned stills in directory without a window, with the rows that sp_capture_start makes: every stage absent,
// the gap, the actual mach timebase and the planned time of each still.
static SPCaptureRecording *makeRecording(NSString *directory, NSUInteger planned) {
    SPCaptureRecording *recording = [[SPCaptureRecording alloc] init];
    mach_timebase_info_data_t timebase = {};
    mach_timebase_info(&timebase);
    recording.session = @"capture-metadata-test";
    recording.directory = directory;
    recording.windowNumber = 41;
    recording.gap = 1;
    recording.planned = planned;
    recording.timebase = timebase;
    recording.gapTicks = 1e6 * timebase.denom / timebase.numer;
    recording.startTicks = mach_absolute_time();
    for (NSUInteger index = 0; index < planned; index++) {
        [recording.rows addObject:[NSMutableDictionary dictionaryWithDictionary:@{
            @"index": @(index), @"planned": tickString([recording plannedTicks:index]), @"requested": NSNull.null,
            @"completed": NSNull.null, @"outcome": @"not-requested", @"error": NSNull.null, @"frame": NSNull.null,
            @"windows": NSNull.null, @"colorSpace": NSNull.null, @"colorProfile": NSNull.null, @"requestedGap": @(recording.gap),
            @"machTimebaseNumerator": @(timebase.numer), @"machTimebaseDenominator": @(timebase.denom),
            @"writeStartTime": NSNull.null, @"writeCompleteTime": NSNull.null, @"writerEnqueuedTime": NSNull.null,
            @"writerStartTime": NSNull.null, @"writerCompleteTime": NSNull.null,
            @"imageMatchStartTime": NSNull.null, @"imageMatchCompleteTime": NSNull.null,
            @"identityDecodeEnqueueStartTime": NSNull.null, @"identityDecodeEnqueueCompleteTime": NSNull.null,
            @"frameIdentityDecodeStartTime": NSNull.null, @"frameIdentityDecodeCompleteTime": NSNull.null,
        }]];
    }
    return recording;
}

// Hands still index the image of pixels covering screen, requested at requested and completed at completed, as the window server
// gives it, and waits for the frame writer. A NULL pixels hands no image, as a window server that gave none.
static void stillImage(SPCaptureRecording *recording, NSUInteger index, NSData *pixels, size_t width, size_t height, CGRect screen,
    uint64_t requested, uint64_t completed) {
    CGImageRef image = pixels ? imageOf(pixels, width, height) : NULL;
    check(pixels == nil || image != NULL, @"the still fixture has an image");
    SPCaptureTarget *target = [[[SPCaptureTarget alloc] init] autorelease];
    target.display = YES;
    target.request = screen;
    target.screen = screen;
    target.windows = @[@(recording.windowNumber)];
    @synchronized (recording) {
        recording.nextIndex = MAX(recording.nextIndex, index + 1);
        recording.rows[index][@"requested"] = tickString(requested);
        recording.rows[index][@"completed"] = tickString(completed);
        recording.rows[index][@"windows"] = target.windows;
        recording.completedCount++;
    }
    processStill(recording, index, target, image, requested, completed);
    if (image) CGImageRelease(image);
    dispatch_sync(captureWriter, ^{});
}

// A clock that gives 100, 200, ... in the order of its reads, and a timebase reader that fails.
static _Atomic uint64_t fixedClockReads;
static uint64_t fixedClock(void) { return 100 * (atomic_fetch_add(&fixedClockReads, 1) + 1); }
static kern_return_t failingTimebase(mach_timebase_info_t info) { (void)info; return KERN_FAILURE; }

// A window server image whose provider reads the capture clock at the first read of its pixels: the image that the window server
// returns reads the window surfaces only when its pixels are read. Its pixels are #32c8c8 in Display P3, a colour that a conversion
// to sRGB changes, as the window server gives the pixels in the colour space of the display.
static NSData *lazyPixels(void) {
    NSMutableData *pixels = [NSMutableData dataWithLength:8 * 4 * 4];
    uint8_t *bytes = pixels.mutableBytes;
    for (size_t offset = 0; offset < pixels.length; offset += 4) {
        bytes[offset] = 0xc8; bytes[offset + 1] = 0xc8; bytes[offset + 2] = 0x32; bytes[offset + 3] = 0xff;
    }
    return pixels;
}
static _Atomic uint64_t lazyReadTick;
static size_t lazyBytes(void *info, void *buffer, off_t position, size_t count) {
    uint64_t unread = 0, now = captureTicks();
    atomic_compare_exchange_strong(&lazyReadTick, &unread, now);
    memcpy(buffer, (const uint8_t *)((NSData *)info).bytes + position, count);
    return count;
}
static void lazyRelease(void *info) { [(NSData *)info release]; }
static CGImageRef lazyWindowImage(CGRect rect, CFArrayRef windows, CGWindowImageOption options) {
    (void)rect; (void)windows; (void)options;
    NSData *pixels = [lazyPixels() retain];
    CGDataProviderDirectCallbacks callbacks = { 0, NULL, NULL, lazyBytes, lazyRelease };
    CGDataProviderRef provider = CGDataProviderCreateDirect(pixels, (off_t)pixels.length, &callbacks);
    CGColorSpaceRef colorSpace = CGColorSpaceCreateWithName(kCGColorSpaceDisplayP3);
    CGImageRef image = CGImageCreate(8, 4, 8, 32, 32, colorSpace,
        (CGBitmapInfo)kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little, provider, NULL, false, kCGRenderingIntentDefault);
    CGColorSpaceRelease(colorSpace);
    CGDataProviderRelease(provider);
    return image;
}

static NSArray<NSString *> *stageTicks(NSDictionary *row, NSArray<NSString *> *names) {
    NSMutableArray *values = [NSMutableArray array];
    for (NSString *name in names) [values addObject:[row[name] isKindOfClass:NSString.class] ? row[name] : @"<absent>"];
    return values;
}

static uint64_t ticks(id value) {
    return [value isKindOfClass:NSString.class] ? strtoull([value UTF8String], NULL, 10) : 0;
}

static NSDictionary *jsonFile(NSString *path) {
    NSData *data = [NSData dataWithContentsOfFile:path];
    return data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
}

static NSArray<NSDictionary *> *stillRows(NSString *directory) {
    NSString *text = [NSString stringWithContentsOfFile:[directory stringByAppendingPathComponent:kCaptureStillsFile]
        encoding:NSUTF8StringEncoding error:nil];
    NSMutableArray *rows = [NSMutableArray array];
    for (NSString *line in [text componentsSeparatedByString:@"\n"]) {
        if (line.length == 0) continue;
        id row = [NSJSONSerialization JSONObjectWithData:[line dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
        if (row) [rows addObject:row];
    }
    return rows;
}

static NSString *subdirectory(NSString *directory, NSString *name) {
    NSString *path = [directory stringByAppendingPathComponent:name];
    NSError *error = nil;
    check([NSFileManager.defaultManager createDirectoryAtPath:path withIntermediateDirectories:YES attributes:nil error:&error],
        [NSString stringWithFormat:@"the %@ fixture directory is created (%@)", name, error]);
    return path;
}

int main(void) { @autoreleasepool {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: native capture still metadata validation\n");
    [NSApplication sharedApplication];
    NSString *directory = temporaryFolder(@"soksak-capture-metadata-");
    prepareCaptureQueues();
    clearCaptureError();
    mach_timebase_info_data_t actualTimebase = {};
    kern_return_t timebaseResult = mach_timebase_info(&actualTimebase);
    check(timebaseResult == KERN_SUCCESS, @"the fixture reads the actual mach timebase");

    sp_image_capture_match_result mismatch = { .state = SP_IMAGE_CAPTURE_UNMATCHED,
        .display_time = 123456789, .has_pixel_difference = true, .different_pixels = 2,
        .first_difference_x = 3, .first_difference_y = 4,
        .expected_bgra = { 1, 2, 3, 4 }, .actual_bgra = { 5, 6, 7, 8 } };
    NSDictionary *mismatchRecord = imageMatchRecord(mismatch, 0.25, 20, 10, 80,
        CGRectMake(0, 0, 10, 5), CGRectMake(0, 0, 10, 5), 1, 1, "kCGColorSpaceSRGB");
    NSDictionary *firstDifference = mismatchRecord[@"firstDifference"];
    check([mismatchRecord[@"differentPixels"] isEqual:@2]
        && [firstDifference[@"x"] isEqual:@3] && [firstDifference[@"y"] isEqual:@4]
        && [firstDifference[@"expectedBGRA"] isEqual:@[@1, @2, @3, @4]]
        && [firstDifference[@"actualBGRA"] isEqual:@[@5, @6, @7, @8]],
        @"the image-match record preserves the bounded exact pixel mismatch details");

    // Source artifacts.
    const uint8_t artifactSource[] = { 11, 12, 13, 255, 21, 22, 23, 255, 31, 32, 33, 255, 41, 42, 43, 255 };
    sp_image_capture_identity artifactIdentity = { 7, 11, 13 };
    NSString *manifestDirectory = subdirectory(directory, @"source-manifest");
    sp_image_capture_match_begin(manifestDirectory.fileSystemRepresentation, captureWriter);
    check(sp_image_capture_match_retain(artifactIdentity, artifactSource, 2, 2, 8,
        CGRectMake(10, 20, 2, 2), 1, "kCGColorSpaceSRGB"),
        @"diagnostic capture retains the source used by the artifact fixture");
    check(sp_image_capture_match_retain(artifactIdentity, artifactSource, 2, 2, 8,
        CGRectMake(10, 20, 2, 2), 1, "kCGColorSpaceSRGB"),
        @"repeated identical source identities do not schedule duplicate artifact paths");
    check(sp_image_capture_match_write_manifest(manifestDirectory.fileSystemRepresentation),
        @"diagnostic capture writes the source artifact manifest after its writer queue drains");
    NSString *manifestSources = [manifestDirectory stringByAppendingPathComponent:@"sources"];
    NSData *sourceArtifact = [NSData dataWithContentsOfFile:[manifestSources stringByAppendingPathComponent:@"7-11-13.bgra"]];
    check([sourceArtifact isEqualToData:[NSData dataWithBytes:artifactSource length:sizeof artifactSource]],
        @"diagnostic capture writes the source artifact with the exact retained BGRA bytes and identity");
    NSDictionary *manifest = jsonFile([manifestSources stringByAppendingPathComponent:@"manifest.json"]);
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

    for (int kept = 0; kept < 2; kept++) {
        bool sourceFiles = kept == 1;
        NSString *folder = subdirectory(directory, sourceFiles ? @"with-source-files" : @"without-source-files");
        check(beginCaptureSourceArtifacts(folder, sourceFiles), @"the source retention of the capture starts");
        check(sp_image_capture_match_retain(artifactIdentity, artifactSource, 2, 2, 8, CGRectMake(10, 20, 2, 2), 1, "kCGColorSpaceSRGB"),
            @"a capture retains its source for matching with or without its file");
        check(sp_image_capture_match_write_manifest(folder.fileSystemRepresentation), @"a capture writes its source manifest");
        endCaptureSourceArtifacts();
        NSString *sources = [folder stringByAppendingPathComponent:@"sources"];
        NSDictionary *written = jsonFile([sources stringByAppendingPathComponent:@"manifest.json"]);
        check([NSFileManager.defaultManager fileExistsAtPath:[sources stringByAppendingPathComponent:@"7-11-13.bgra"]] == sourceFiles,
            @"a capture writes the source file only when its reader needs it");
        check([written[@"sourceFiles"] boolValue] == sourceFiles && [written[@"artifacts"] count] == (sourceFiles ? 1u : 0u),
            @"the source manifest states whether the capture holds source files and lists only those it holds");
    }

    NSString *cleanupDirectory = [directory stringByAppendingPathComponent:@"cleanup-failure"];
    NSString *cleanupSourceDirectory = [cleanupDirectory stringByAppendingPathComponent:@"sources"];
    NSString *partialPath = [cleanupSourceDirectory stringByAppendingPathComponent:@"77-1-1.bgra.partial"];
    NSError *cleanupSetupError = nil;
    BOOL cleanupFixtureReady = [NSFileManager.defaultManager createDirectoryAtPath:cleanupSourceDirectory
        withIntermediateDirectories:YES attributes:nil error:&cleanupSetupError]
        && [@"retain" writeToFile:partialPath atomically:YES encoding:NSUTF8StringEncoding error:&cleanupSetupError];
    check(cleanupFixtureReady, [NSString stringWithFormat:@"the artifact cleanup fixture is prepared (%@)", cleanupSetupError]);
    sp_image_capture_match_begin(cleanupDirectory.fileSystemRepresentation, captureWriter);
    sp_image_capture_identity cleanupIdentity = { 77, 1, 1 };
    check(chmod(cleanupSourceDirectory.fileSystemRepresentation, 0500) == 0,
        @"the artifact cleanup fixture prevents partial-file replacement and removal");
    check(sp_image_capture_match_retain(cleanupIdentity, artifactSource, 2, 2, 8,
        CGRectMake(10, 20, 2, 2), 1, "kCGColorSpaceSRGB"),
        @"the artifact cleanup fixture retains its source raster");
    dispatch_sync(captureWriter, ^{});
    check(chmod(cleanupSourceDirectory.fileSystemRepresentation, 0700) == 0,
        @"the artifact cleanup fixture restores directory permissions");
    BOOL cleanupManifestWritten = sp_image_capture_match_write_manifest(cleanupDirectory.fileSystemRepresentation);
    NSDictionary *cleanupManifest = jsonFile([cleanupSourceDirectory stringByAppendingPathComponent:@"manifest.json"]);
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
    NSString *countSources = [countBoundDirectory stringByAppendingPathComponent:@"sources"];
    NSDictionary *countManifest = jsonFile([countSources stringByAppendingPathComponent:@"manifest.json"]);
    NSString *droppedArtifact = [countSources stringByAppendingPathComponent:@"8-3-513.bgra"];
    check([countManifest[@"artifacts"] count] == 512
        && [countManifest[@"droppedSources"] isEqual:@1]
        && [countManifest[@"dropReasons"][@"capacity"] isEqual:@1]
        && ![NSFileManager.defaultManager fileExistsAtPath:droppedArtifact]
        && ![NSFileManager.defaultManager fileExistsAtPath:[droppedArtifact stringByAppendingString:@".partial"]],
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
        NSDictionary *byteManifest = jsonFile([[byteBoundDirectory stringByAppendingPathComponent:@"sources"]
            stringByAppendingPathComponent:@"manifest.json"]);
        check([byteManifest[@"artifacts"] count] == 2
            && [byteManifest[@"artifacts"][0][@"byteCount"] isEqual:@(byteLimit)]
            && [byteManifest[@"artifactBytes"] isEqual:@(byteLimit + sizeof excessPixel)]
            && [byteManifest[@"droppedSources"] isEqual:@0],
            @"the artifact stream preserves source bytes beyond the former aggregate byte limit");
        free(largeSource);
    }
    sp_image_capture_match_end();

    NSString *multiFrameDirectory = subdirectory(directory, @"multi-frame-source-retention");
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
        check(retainedEverySource, @"the matcher accepts every source identity across a multi-frame gesture");
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
        NSDictionary *multiFrameManifest = jsonFile([multiFrameSources stringByAppendingPathComponent:@"manifest.json"]);
        BOOL everyArtifactPresent = [multiFrameManifest[@"artifacts"] count] == 20
            && [multiFrameManifest[@"artifactBytes"] isEqual:@(sourceBytesCount * 20)]
            && [multiFrameManifest[@"droppedSources"] isEqual:@1]
            && [multiFrameManifest[@"dropReasons"][@"identity-conflict"] isEqual:@1];
        for (int sequence = 1; sequence <= 20; sequence++) {
            NSData *stored = [NSData dataWithContentsOfFile:[multiFrameSources stringByAppendingPathComponent:
                [NSString stringWithFormat:@"12-4-%d.bgra", sequence]]];
            if (stored.length != sourceBytesCount || ((const uint8_t *)stored.bytes)[0] != sequence
                || ((const uint8_t *)stored.bytes)[sourceBytesCount - 1] != sequence) everyArtifactPresent = NO;
        }
        check(everyArtifactPresent, @"all exact source identities above the former 64 MiB aggregate limit have artifacts");
        free(sourceBytes);
    }
    sp_image_capture_match_end();

    NSString *pendingBoundDirectory = subdirectory(directory, @"pending-source-bound");
    dispatch_semaphore_t writerGate = dispatch_semaphore_create(0);
    dispatch_semaphore_t writerBlocked = dispatch_semaphore_create(0);
    dispatch_async(captureWriter, ^{
        dispatch_semaphore_signal(writerBlocked);
        dispatch_semaphore_wait(writerGate, DISPATCH_TIME_FOREVER);
    });
    dispatch_semaphore_wait(writerBlocked, DISPATCH_TIME_FOREVER);
    sp_image_capture_match_begin(pendingBoundDirectory.fileSystemRepresentation, captureWriter);
    uint8_t *pendingSourceBytes = malloc(sourceBytesCount);
    check(pendingSourceBytes != NULL, @"the pending source fixture allocates one native-sized raster");
    if (pendingSourceBytes) {
        BOOL acceptedWithinPendingBound = YES;
        for (int sequence = 1; sequence <= 20; sequence++) {
            memset(pendingSourceBytes, sequence, sourceBytesCount);
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
        NSDictionary *pendingManifest = jsonFile([pendingSources stringByAppendingPathComponent:@"manifest.json"]);
        check([pendingManifest[@"artifacts"] count] == 19
            && [pendingManifest[@"droppedSources"] isEqual:@1]
            && [pendingManifest[@"dropReasons"][@"capacity"] isEqual:@1]
            && ![NSFileManager.defaultManager fileExistsAtPath:[pendingSources stringByAppendingPathComponent:@"13-4-20.bgra"]],
            @"pending byte overflow is recorded and does not create an incomplete source artifact");
        free(pendingSourceBytes);
    } else {
        dispatch_semaphore_signal(writerGate);
    }
    dispatch_release(writerBlocked);
    dispatch_release(writerGate);
    sp_image_capture_match_end();

    // The row of a still. An 8x4 image covering a 4x2 rectangle is a still of scale 2.
    NSString *stillDirectory = subdirectory(directory, @"still-row");
    clearCaptureError();
    check(beginCaptureSourceArtifacts(stillDirectory, false), @"the still fixture starts its source artifacts");
    SPCaptureRecording *recording = makeRecording(stillDirectory, 2);
    uint64_t stillRequested = mach_absolute_time();
    uint64_t stillCompleted = stillRequested + 1000;
    stillImage(recording, 0, opaquePixels(8, 4, 90), 8, 4, CGRectMake(0, 0, 4, 2), stillRequested, stillCompleted);
    NSDictionary *row = nil;
    @synchronized (recording) { row = [[recording.rows[0] copy] autorelease]; }
    NSDictionary *imageMatch = row[@"imageMatch"];
    NSData *frameFile = [NSData dataWithContentsOfFile:[stillDirectory stringByAppendingPathComponent:@"frame-0000.bgra"]];
    double frameTimes[2] = {0, 0};
    if (frameFile.length >= kFrameEncodedHeader) memcpy(frameTimes, (const uint8_t *)frameFile.bytes + 3 * sizeof(uint32_t) + 6 * sizeof(double),
        sizeof frameTimes);
    uint64_t writeStart = ticks(row[@"writeStartTime"]), matchStart = ticks(row[@"imageMatchStartTime"]);
    uint64_t matchComplete = ticks(row[@"imageMatchCompleteTime"]), writeComplete = ticks(row[@"writeCompleteTime"]);
    check(strlen(sp_capture_error()) == 0 && recording.written == 1
        && [row[@"outcome"] isEqual:@"written"] && [row[@"frame"] isEqual:@"frame-0000.bgra"] && frameFile != nil
        && [row[@"requested"] isEqual:tickString(stillRequested)] && [row[@"completed"] isEqual:tickString(stillCompleted)]
        && frameTimes[0] == ticksToMilliseconds(stillRequested, actualTimebase)
        && frameTimes[1] == ticksToMilliseconds(stillCompleted, actualTimebase)
        && writeStart > 0 && matchStart >= writeStart && matchComplete >= matchStart && writeComplete >= matchComplete
        && row[@"identityDecodeEnqueueStartTime"] == NSNull.null
        && row[@"identityDecodeEnqueueCompleteTime"] == NSNull.null
        && row[@"frameIdentityDecodeStartTime"] == NSNull.null
        && row[@"frameIdentityDecodeCompleteTime"] == NSNull.null
        && [row[@"machTimebaseNumerator"] unsignedIntValue] == actualTimebase.numer
        && [row[@"machTimebaseDenominator"] unsignedIntValue] == actualTimebase.denom
        && [imageMatch[@"state"] isKindOfClass:NSString.class]
        && [imageMatch[@"displayTime"] isEqual:tickString(stillCompleted)]
        && [imageMatch[@"captureFrame"][@"scaleFactor"] isEqual:@2],
        [NSString stringWithFormat:@"the still path records image-match raw bounds, absent identity-stage ticks, the timebase, request and completion times and the frame marker (%@, %s)",
            row, sp_capture_error()]);
    stillImage(recording, 1, nil, 0, 0, CGRectMake(0, 0, 4, 2), stillRequested + 2000, stillRequested + 3000);
    check(recording.written == 1 && [recording.rows[1][@"outcome"] isEqual:@"failed"]
        && recording.rows[1][@"frame"] == NSNull.null && recording.rows[1][@"writerEnqueuedTime"] == NSNull.null
        && recording.rows[1][@"writerStartTime"] == NSNull.null && recording.rows[1][@"writerCompleteTime"] == NSNull.null
        && [[NSString stringWithUTF8String:sp_capture_error()] containsString:@"still 1: the window server gave no image of window 41"],
        [NSString stringWithFormat:@"a still without an image fails with an explicit error and reports absent writer stages as null (%s)",
            sp_capture_error()]);
    clearCaptureError();
    check(finalizeCaptureArtifacts(recording), [NSString stringWithFormat:@"the still recording finalizes its artifacts (%s)",
        sp_capture_error()]);
    NSArray<NSDictionary *> *rows = stillRows(stillDirectory);
    NSDictionary *stored = rows.count == 2 ? rows[0] : nil;
    uint64_t writerEnqueued = ticks(stored[@"writerEnqueuedTime"]), writerStarted = ticks(stored[@"writerStartTime"]);
    uint64_t writerCompleted = ticks(stored[@"writerCompleteTime"]);
    check([stored[@"writerEnqueuedTime"] isKindOfClass:NSString.class]
        && [stored[@"writerStartTime"] isKindOfClass:NSString.class]
        && [stored[@"writerCompleteTime"] isKindOfClass:NSString.class]
        && writerEnqueued >= ticks(stored[@"writeCompleteTime"]) && writerStarted >= writerEnqueued
        && writerCompleted >= writerStarted,
        @"the frame artifact preserves actual enqueue and asynchronous writer bounds as ordered raw ticks");
    check([stored[@"planned"] isKindOfClass:NSString.class]
        && [stored[@"requested"] isEqual:tickString(stillRequested)] && [stored[@"completed"] isEqual:tickString(stillCompleted)]
        && [stored[@"writeStartTime"] isEqual:row[@"writeStartTime"]]
        && [stored[@"imageMatchStartTime"] isEqual:row[@"imageMatchStartTime"]]
        && [stored[@"imageMatchCompleteTime"] isEqual:row[@"imageMatchCompleteTime"]]
        && [stored[@"writeCompleteTime"] isEqual:row[@"writeCompleteTime"]]
        && stored[@"identityDecodeEnqueueStartTime"] == NSNull.null
        && stored[@"identityDecodeEnqueueCompleteTime"] == NSNull.null
        && stored[@"frameIdentityDecodeStartTime"] == NSNull.null
        && stored[@"frameIdentityDecodeCompleteTime"] == NSNull.null
        && [stored[@"machTimebaseNumerator"] unsignedIntValue] == actualTimebase.numer
        && [stored[@"machTimebaseDenominator"] unsignedIntValue] == actualTimebase.denom
        && [stored[@"frame"] isEqual:@"frame-0000.bgra"]
        && rows[1][@"frame"] == NSNull.null && [rows[1][@"outcome"] isEqual:@"failed"],
        @"the still row preserves stage ticks as decimal strings, absent stages as null, and the actual mach timebase");
    // Each stage keeps the tick of its own clock read: with a clock that gives 100, 200, ... in the order of its reads, the stages
    // of a still hold the values of their reads in the order of the still path.
    NSString *fixedDirectory = subdirectory(directory, @"still-fixed-clock");
    check(beginCaptureSourceArtifacts(fixedDirectory, false), @"the fixed-clock fixture starts its source artifacts");
    SPCaptureRecording *fixedRecording = makeRecording(fixedDirectory, 1);
    atomic_store(&fixedClockReads, 0);
    captureRawClock = fixedClock;
    stillImage(fixedRecording, 0, opaquePixels(8, 4, 90), 8, 4, CGRectMake(0, 0, 4, 2), stillRequested, stillCompleted);
    captureRawClock = mach_absolute_time;
    NSDictionary *fixedRow = nil;
    @synchronized (fixedRecording) { fixedRow = [[fixedRecording.rows[0] copy] autorelease]; }
    NSArray *fixedStages = stageTicks(fixedRow, @[@"writeStartTime", @"imageMatchStartTime", @"imageMatchCompleteTime",
        @"writeCompleteTime", @"writerEnqueuedTime", @"writerStartTime", @"writerCompleteTime"]);
    check([fixedStages isEqual:@[@"100", @"200", @"300", @"400", @"500", @"600", @"700"]]
        && fixedRow[@"identityDecodeEnqueueStartTime"] == NSNull.null && [fixedRow[@"outcome"] isEqual:@"written"],
        [NSString stringWithFormat:@"each still stage holds the tick of its own clock read (%@)", fixedStages]);
    clearCaptureError();
    check(finalizeCaptureArtifacts(fixedRecording), [NSString stringWithFormat:@"the fixed-clock recording finalizes (%s)",
        sp_capture_error()]);
    [fixedRecording release];
    clearCaptureError();
    // A still reads the pixels of its image between its request and its completion: with the clock that gives 100, 200, ...,
    // the request is read at 200, the pixels at 300 and the completion at 400, and the frame holds the pixels.
    NSString *lazyDirectory = subdirectory(directory, @"still-pixel-read");
    check(beginCaptureSourceArtifacts(lazyDirectory, false), @"the pixel-read fixture starts its source artifacts");
    SPCaptureRecording *lazyRecording = makeRecording(lazyDirectory, 1);
    lazyRecording.function = lazyWindowImage;
    lazyRecording.nextIndex = 1;
    SPCaptureTarget *lazyTarget = [[[SPCaptureTarget alloc] init] autorelease];
    lazyTarget.windows = @[@(lazyRecording.windowNumber)];
    lazyTarget.request = CGRectNull;
    lazyTarget.screen = CGRectMake(0, 0, 4, 2);
    atomic_store(&lazyReadTick, 0);
    atomic_store(&fixedClockReads, 0);
    captureRawClock = fixedClock;
    takeStill(lazyRecording, 0, lazyTarget);
    dispatch_sync(captureWriter, ^{});
    captureRawClock = mach_absolute_time;
    NSDictionary *lazyRow = nil;
    @synchronized (lazyRecording) { lazyRow = [[lazyRecording.rows[0] copy] autorelease]; }
    check([lazyRow[@"requested"] isEqual:@"200"] && atomic_load(&lazyReadTick) == 300 && [lazyRow[@"completed"] isEqual:@"400"]
        && [lazyRow[@"outcome"] isEqual:@"written"],
        [NSString stringWithFormat:@"a still reads the pixels of its image between its request and its completion (requested %@, "
            "pixels read %llu, completed %@, %@)", lazyRow[@"requested"], (unsigned long long)atomic_load(&lazyReadTick),
            lazyRow[@"completed"], lazyRow[@"outcome"]]);
    // The frame holds the bytes of the image in its own colour space, and the row names that space and its ICC profile file.
    NSData *lazyFrame = [lazyRow[@"frame"] isKindOfClass:NSString.class] ? readCaptureFrame([NSData dataWithContentsOfFile:
        [lazyDirectory stringByAppendingPathComponent:lazyRow[@"frame"]]]) : nil;
    NSData *lazyFramePixels = lazyFrame.length > kCaptureFrameHeader
        ? [lazyFrame subdataWithRange:NSMakeRange(kCaptureFrameHeader, lazyFrame.length - kCaptureFrameHeader)] : nil;
    check([lazyFramePixels isEqualToData:lazyPixels()], [NSString stringWithFormat:
        @"a frame holds the bytes of its image in the colour space of the image, unconverted (%@)",
        lazyFramePixels.length >= 4 ? [lazyFramePixels subdataWithRange:NSMakeRange(0, 4)] : lazyFramePixels]);
    CGColorSpaceRef displayP3 = CGColorSpaceCreateWithName(kCGColorSpaceDisplayP3);
    NSData *displayP3Profile = [(NSData *)CGColorSpaceCopyICCData(displayP3) autorelease];
    CGColorSpaceRelease(displayP3);
    unsigned char profileDigest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(displayP3Profile.bytes, (CC_LONG)displayP3Profile.length, profileDigest);
    NSMutableString *profileName = [NSMutableString stringWithString:@"color-"];
    for (int index = 0; index < 8; index++) [profileName appendFormat:@"%02x", profileDigest[index]];
    [profileName appendString:@".icc"];
    NSData *writtenProfile = [NSData dataWithContentsOfFile:[lazyDirectory stringByAppendingPathComponent:profileName]];
    check([lazyRow[@"colorSpace"] isEqual:(NSString *)kCGColorSpaceDisplayP3] && [lazyRow[@"colorProfile"] isEqual:profileName]
        && [writtenProfile isEqualToData:displayP3Profile], [NSString stringWithFormat:
        @"a still row names the colour space of its frame and the ICC profile file of that space (%@, %@, expected %@, file %lu bytes)",
        lazyRow[@"colorSpace"], lazyRow[@"colorProfile"], profileName, (unsigned long)writtenProfile.length]);
    clearCaptureError();
    check(finalizeCaptureArtifacts(lazyRecording), [NSString stringWithFormat:@"the pixel-read recording finalizes (%s)",
        sp_capture_error()]);
    [lazyRecording release];
    clearCaptureError();

    NSDictionary *unobserved = jsonFile([stillDirectory stringByAppendingPathComponent:kCaptureDisplayLinkFile]);
    check([unobserved[@"state"] isEqual:@"unavailable"]
        && [unobserved[@"reason"] isKindOfClass:NSString.class]
        && [unobserved[@"observations"] isEqual:@[]]
        && [unobserved[@"omittedObservations"] isEqual:@0],
        @"finalization reports an explicit unavailable display-link trace when no observation was recorded");
    [recording displayLinkDidRefresh:nil];
    check([recording.displayLinkState isEqual:@"unavailable"] && recording.displayLinkObservations.count == 0
        && strlen(sp_capture_error()) == 0,
        @"a late display-link callback after stop records nothing and reports no error into the next capture");

    // A display-link callback whose timebase read fails is rejected with an explicit capture error and records nothing; after the
    // stop, a callback whose timebase read would fail records nothing and leaves no error for the next capture.
    SPCaptureRecording *timebaseFailure = makeRecording(subdirectory(directory, @"display-link-timebase-failure"), 0);
    SPFakeDisplayLink *liveLink = [SPFakeDisplayLink new];
    timebaseFailure.displayLink = (CADisplayLink *)liveLink;
    clearCaptureError();
    captureReadTimebase = failingTimebase;
    [timebaseFailure displayLinkDidRefresh:(CADisplayLink *)liveLink];
    captureReadTimebase = mach_timebase_info;
    check([timebaseFailure.displayLinkState isEqual:@"incomplete"] && timebaseFailure.displayLinkObservations.count == 0
        && timebaseFailure.omittedDisplayLinkObservations == 1
        && [[NSString stringWithUTF8String:sp_capture_error()]
            isEqual:@"display-link trace incomplete: mach_timebase_info failed for a display-link callback"],
        [NSString stringWithFormat:@"a timebase failure rejects the callback with an explicit capture error before writing an incomplete record (%s)",
            sp_capture_error()]);
    [timebaseFailure stopDisplayLinkObservation];
    clearCaptureError();
    captureReadTimebase = failingTimebase;
    atomic_store(&fixedClockReads, 0);
    captureRawClock = fixedClock;
    [timebaseFailure displayLinkDidRefresh:(CADisplayLink *)liveLink];
    captureRawClock = mach_absolute_time;
    captureReadTimebase = mach_timebase_info;
    check(timebaseFailure.omittedDisplayLinkObservations == 1 && timebaseFailure.displayLinkObservations.count == 0
        && atomic_load(&fixedClockReads) == 0 && strlen(sp_capture_error()) == 0,
        @"a late display-link callback after stop whose clock and timebase would fail records nothing and reports no error into the next capture");
    [timebaseFailure release];
    [liveLink release];

    SPCaptureRecording *unencodable = makeRecording(subdirectory(directory, @"stills-encode"), 2);
    unencodable.rows[1][@"error"] = [[[NSObject alloc] init] autorelease];
    check(!writeCaptureStills(unencodable)
        && [[NSString stringWithUTF8String:sp_capture_error()] containsString:@"stills.jsonl could not encode the row of still 1:"],
        @"a stills.jsonl encode error names its still");
    [unencodable release];
    clearCaptureError();
    SPCaptureRecording *unwritable = makeRecording(@"/dev/null", 1);
    check(!writeCaptureStills(unwritable)
        && [[NSString stringWithUTF8String:sp_capture_error()] containsString:@"stills.jsonl could not be written"],
        @"a stills.jsonl write failure fails the capture");
    [unwritable release];
    clearCaptureError();

    // The identity decode of an identity session, through the still path.
    NSString *identityTimingDirectory = subdirectory(directory, @"identity-timing");
    sp_image_capture_match_begin(identityTimingDirectory.fileSystemRepresentation, captureWriter);
    char *identityTimingError = NULL;
    BOOL identityTimingStarted = sp_image_capture_match_identity_session_begin(&identityTimingError);
    check(identityTimingStarted, [NSString stringWithFormat:@"the identity timing session starts (%s)", identityTimingError ?: ""]);
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
    BOOL identitySourceReady = identityTimingStarted && identityColorSpace
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
    SPCaptureRecording *identityRecording = makeRecording(identityTimingDirectory, 1);
    uint64_t identityRequested = mach_absolute_time();
    atomic_store(&fixedClockReads, 0);
    captureRawClock = fixedClock;
    stillImage(identityRecording, 0, identitySourcePixels, identityWidth, identityHeight,
        CGRectMake(0, 0, identityWidth, identityHeight), identityRequested, identityRequested + 1000);
    captureRawClock = mach_absolute_time;
    BOOL identityTraceFinalized = sp_image_capture_match_write_manifest(identityTimingDirectory.fileSystemRepresentation);
    NSDictionary *identityRow = nil;
    @synchronized (identityRecording) { identityRow = [[identityRecording.rows[0] copy] autorelease]; }
    NSString *identityDecodeTrace = [NSString stringWithContentsOfFile:[identityTimingDirectory
        stringByAppendingPathComponent:@"frame-identities/decoded-frames.jsonl"] encoding:NSUTF8StringEncoding error:nil];
    NSArray *identityStages = stageTicks(identityRow, @[@"writeStartTime", @"imageMatchStartTime", @"imageMatchCompleteTime",
        @"identityDecodeEnqueueStartTime", @"identityDecodeEnqueueCompleteTime", @"writeCompleteTime", @"writerEnqueuedTime",
        @"writerStartTime", @"writerCompleteTime"]);
    check([identityStages isEqual:@[@"100", @"200", @"300", @"400", @"500", @"600", @"700", @"800", @"900"]],
        [NSString stringWithFormat:@"each stage of an identity still holds the tick of its own clock read (%@)", identityStages]);
    uint64_t enqueueStart = ticks(identityRow[@"identityDecodeEnqueueStartTime"]);
    uint64_t enqueueComplete = ticks(identityRow[@"identityDecodeEnqueueCompleteTime"]);
    check(identityTraceFinalized && identitySourceReady && [identityRow[@"outcome"] isEqual:@"written"]
        && enqueueStart >= ticks(identityRow[@"imageMatchCompleteTime"]) && enqueueStart > 0
        && enqueueComplete >= enqueueStart && ticks(identityRow[@"writeCompleteTime"]) >= enqueueComplete
        && identityRow[@"frameIdentityDecodeStartTime"] == NSNull.null
        && identityRow[@"frameIdentityDecodeCompleteTime"] == NSNull.null
        && [identityDecodeTrace containsString:@"no-code"]
        && [identityDecodeTrace containsString:@"decodeEnqueuedTime"]
        && [identityDecodeTrace containsString:@"decodeStartTime"]
        && [identityDecodeTrace containsString:@"decodeCompleteTime"]
        && strlen(sp_capture_error()) == 0,
        [NSString stringWithFormat:@"an identity session still records its enqueue bounds and its asynchronous no-code result without errors (%@, %@, %s)",
            identityRow, identityDecodeTrace ?: @"<missing>", sp_capture_error()]);
    sp_image_capture_match_identity_session_end();
    sp_image_capture_match_end();

    NSString *failedSessionDirectory = subdirectory(directory, @"identity-failure");
    check(beginCaptureSourceArtifacts(failedSessionDirectory, false), @"the identity failure fixture starts its source artifacts");
    char *failedSessionStartError = NULL;
    BOOL failedSessionStarted = sp_image_capture_match_identity_session_begin(&failedSessionStartError);
    free(failedSessionStartError);
    char *injectedSessionError = NULL;
    BOOL failureRecorded = failedSessionStarted
        && sp_image_capture_match_identity_session_fail("controlled asynchronous Vision failure", &injectedSessionError);
    free(injectedSessionError);
    SPCaptureRecording *failedSessionRecording = makeRecording(failedSessionDirectory, 1);
    BOOL failedFinalization = finalizeCaptureArtifacts(failedSessionRecording);
    check(failureRecorded && !failedFinalization
        && strstr(sp_capture_error(), "controlled asynchronous Vision failure") != NULL,
        @"finalization reports an asynchronous identity decoder failure after draining its queues");
    sp_image_capture_match_identity_session_end();
    [failedSessionRecording release];
    clearCaptureError();

    // The release of the display-link resources.
    SPCaptureRecording *releaseFixture = [SPCaptureRecording new];
    NSWindow *retainedWindow = [[SPDisplayWindowReleaseProbe alloc] initWithContentRect:NSMakeRect(0, 0, 10, 10)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    retainedWindow.releasedWhenClosed = NO;
    SPFakeDisplayLink *fakeLink = [SPFakeDisplayLink new];
    fakeLink.invalidationThread = -1;
    releaseFixture.displayWindow = retainedWindow;
    releaseFixture.displayLink = (CADisplayLink *)fakeLink;
    __block int backgroundStopReturned = 0;
    displayWindowReleaseThread = -1;
    trackDisplayWindowReleases = 1;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
        [releaseFixture stopDisplayLinkObservation];
        __atomic_store_n(&backgroundStopReturned, 1, __ATOMIC_RELAXED);
    });
    // The background stop runs the invalidation and the release on the main queue, which the run loop of this thread serves.
    sp_run_until("the background stop of the display link", ^BOOL {
        return __atomic_load_n(&backgroundStopReturned, __ATOMIC_RELAXED) != 0;
    });
    trackDisplayWindowReleases = 0;
    check(fakeLink.invalidationCount == 1 && fakeLink.invalidationThread == 1
        && __atomic_load_n(&displayWindowReleaseThread, __ATOMIC_RELAXED) == 1
        && releaseFixture.displayLinkStopped && releaseFixture.displayLink == nil && releaseFixture.displayWindow == nil,
        @"a background stop invalidates the display link and releases the retained window on the main thread");
    [releaseFixture stopDisplayLinkObservation];
    check(fakeLink.invalidationCount == 1, @"a second stop does not invalidate the display link again");
    [retainedWindow close];
    [retainedWindow release];
    [fakeLink release];
    [releaseFixture release];

    // The display-link trace.
    NSString *observationDirectory = subdirectory(directory, @"display-link-observations");
    SPCaptureRecording *observationFixture = makeRecording(observationDirectory, 0);
    mach_timebase_info_data_t observationTimebase = actualTimebase;
    uint64_t firstCallbackTime = mach_absolute_time();
    double firstMediaTime = CACurrentMediaTime();
    uint64_t firstMediaClockAfter = mach_absolute_time();
    double firstTimestamp = firstMediaTime - 0.05;
    [observationFixture recordDisplayLinkTimestamp:firstTimestamp targetTimestamp:firstTimestamp + 0.016 duration:0.016
        callbackTime:firstCallbackTime mediaClockTime:firstMediaTime mediaClockAfter:firstMediaClockAfter
        timebase:observationTimebase windowNumber:41 displayID:@(7)
        visible:YES occluded:NO applicationActive:NO inFront:nil];
    uint64_t secondCallbackTime = mach_absolute_time();
    double secondMediaTime = CACurrentMediaTime();
    uint64_t secondMediaClockAfter = mach_absolute_time();
    double secondTimestamp = firstTimestamp + 0.001;
    NSArray *cover = @[@{ @"number": @9, @"owner": @"Cover", @"pid": @300, @"layer": @0, @"x": @0, @"y": @25, @"width": @1800,
        @"height": @1100 }];
    [observationFixture recordDisplayLinkTimestamp:secondTimestamp targetTimestamp:secondTimestamp + 0.016 duration:0.016
        callbackTime:secondCallbackTime mediaClockTime:secondMediaTime mediaClockAfter:secondMediaClockAfter
        timebase:observationTimebase windowNumber:41 displayID:@(7)
        visible:YES occluded:YES applicationActive:NO inFront:cover];
    check(beginCaptureSourceArtifacts(observationDirectory, false)
        && finalizeCaptureArtifacts(observationFixture), @"the finalizer writes a controlled display-link observation trace");
    NSDictionary *observationTrace = jsonFile([observationDirectory stringByAppendingPathComponent:kCaptureDisplayLinkFile]);
    NSArray *observations = observationTrace[@"observations"];
    NSDictionary *firstObservation = observations.count > 0 ? observations[0] : nil;
    NSDictionary *secondObservation = observations.count > 1 ? observations[1] : nil;
    check([observationTrace[@"state"] isEqual:@"available"] && observations.count == 2
        && [firstObservation[@"sequence"] isEqual:@1] && [secondObservation[@"sequence"] isEqual:@2]
        && [firstObservation[@"windowNumber"] isEqual:@41] && [firstObservation[@"displayID"] isEqual:@7]
        && [firstObservation[@"visible"] isEqual:@YES] && [firstObservation[@"occluded"] isEqual:@NO]
        && [secondObservation[@"occluded"] isEqual:@YES] && [secondObservation[@"applicationActive"] isEqual:@NO]
        && [firstObservation[@"timestamp"] doubleValue] < [secondObservation[@"timestamp"] doubleValue]
        && [firstObservation[@"callbackTime"] isEqual:tickString(firstCallbackTime)]
        && [firstObservation[@"callbackMediaTime"] isKindOfClass:NSNumber.class]
        && [firstObservation[@"mediaClockAfter"] isEqual:tickString(firstMediaClockAfter)]
        && [firstObservation[@"machTimebaseNumerator"] unsignedIntValue] == observationTimebase.numer
        && [firstObservation[@"machTimebaseDenominator"] unsignedIntValue] == observationTimebase.denom,
        [NSString stringWithFormat:@"the finalized display-link trace preserves ordered timestamps, raw callback clock, timebase, and window state (%@)", observationTrace]);
    check(firstObservation[@"inFront"] == nil && [secondObservation[@"inFront"] isEqual:cover],
        [NSString stringWithFormat:@"the finalized display-link trace keeps the windows in front of a covered window on the callback "
            "that read them and on no other (%@)", observations]);
    [observationFixture release];

    NSString *visibilityDirectory = subdirectory(directory, @"display-link-visibility");
    SPCaptureRecording *visibilityFixture = makeRecording(visibilityDirectory, 0);
    uint64_t visibilityBefore = mach_absolute_time();
    double visibilityMedia = CACurrentMediaTime();
    uint64_t visibilityAfter = mach_absolute_time();
    double visibilityTimestamp = visibilityMedia - 0.02;
    [visibilityFixture recordDisplayLinkTimestamp:visibilityTimestamp targetTimestamp:visibilityTimestamp + 0.016 duration:0.016
        callbackTime:visibilityBefore mediaClockTime:visibilityMedia mediaClockAfter:visibilityAfter
        timebase:observationTimebase windowNumber:41 displayID:@7 visible:YES occluded:NO applicationActive:YES inFront:nil];
    uint64_t hiddenBefore = mach_absolute_time();
    double hiddenMedia = CACurrentMediaTime();
    uint64_t hiddenAfter = mach_absolute_time();
    double hiddenTimestamp = visibilityTimestamp + 0.001;
    [visibilityFixture recordDisplayLinkTimestamp:hiddenTimestamp targetTimestamp:hiddenTimestamp + 0.016 duration:0.016
        callbackTime:hiddenBefore mediaClockTime:hiddenMedia mediaClockAfter:hiddenAfter
        timebase:observationTimebase windowNumber:41 displayID:@7 visible:NO occluded:YES applicationActive:YES inFront:nil];
    uint64_t offDisplayBefore = mach_absolute_time();
    double offDisplayMedia = CACurrentMediaTime();
    uint64_t offDisplayAfter = mach_absolute_time();
    double offDisplayTimestamp = hiddenTimestamp + 0.001;
    [visibilityFixture recordDisplayLinkTimestamp:offDisplayTimestamp targetTimestamp:offDisplayTimestamp + 0.016 duration:0.016
        callbackTime:offDisplayBefore mediaClockTime:offDisplayMedia mediaClockAfter:offDisplayAfter
        timebase:observationTimebase windowNumber:41 displayID:nil visible:YES occluded:NO applicationActive:YES inFront:nil];
    check(beginCaptureSourceArtifacts(visibilityDirectory, false)
        && finalizeCaptureArtifacts(visibilityFixture), @"the hidden-window display-link trace is finalized");
    NSDictionary *visibilityTrace = jsonFile([visibilityDirectory stringByAppendingPathComponent:kCaptureDisplayLinkFile]);
    NSArray *visibilityObservations = visibilityTrace[@"observations"];
    NSDictionary *hiddenObservation = visibilityObservations.count > 1 ? visibilityObservations[1] : nil;
    NSDictionary *offDisplayObservation = visibilityObservations.count > 2 ? visibilityObservations[2] : nil;
    check([visibilityTrace[@"state"] isEqual:@"unavailable"] && visibilityObservations.count == 3
        && [visibilityTrace[@"reason"] isEqual:@"the captured window had no display during a display-link observation"]
        && [hiddenObservation[@"visible"] isEqual:@NO]
        && [offDisplayObservation[@"displayID"] isEqual:NSNull.null],
        [NSString stringWithFormat:@"hidden and off-display observations remain recorded but cannot claim available refresh coverage (%@)", visibilityTrace]);
    [visibilityFixture release];

    NSString *invalidDirectory = subdirectory(directory, @"display-link-invalid");
    SPCaptureRecording *invalidFixture = makeRecording(invalidDirectory, 0);
    uint64_t invalidCallbackTime = mach_absolute_time();
    double invalidMediaTime = CACurrentMediaTime();
    uint64_t invalidMediaClockAfter = mach_absolute_time();
    double invalidTimestamp = invalidMediaTime - 0.02;
    [invalidFixture recordDisplayLinkTimestamp:invalidTimestamp targetTimestamp:invalidTimestamp + 0.016 duration:0.016
        callbackTime:invalidCallbackTime mediaClockTime:invalidMediaTime mediaClockAfter:invalidMediaClockAfter
        timebase:observationTimebase windowNumber:41 displayID:@7 visible:YES occluded:NO applicationActive:YES inFront:nil];
    double regressedMediaTime = CACurrentMediaTime();
    uint64_t regressedAfter = mach_absolute_time();
    double regressedTimestamp = regressedMediaTime - 0.01;
    [invalidFixture recordDisplayLinkTimestamp:regressedTimestamp targetTimestamp:regressedTimestamp - 0.001 duration:0.016
        callbackTime:invalidCallbackTime - 1 mediaClockTime:regressedMediaTime mediaClockAfter:regressedAfter
        timebase:observationTimebase windowNumber:41 displayID:@7 visible:YES occluded:NO applicationActive:YES inFront:nil];
    check([invalidFixture.displayLinkState isEqual:@"incomplete"]
        && invalidFixture.omittedDisplayLinkObservations == 1
        && invalidFixture.displayLinkObservations.count == 1
        && [[NSString stringWithUTF8String:sp_capture_error()] containsString:@"display-link trace incomplete"],
        @"a regressed display-link callback clock is rejected without discarding its valid prefix");
    clearCaptureError();
    check(beginCaptureSourceArtifacts(invalidDirectory, false)
        && finalizeCaptureArtifacts(invalidFixture), @"a clock-invalid display-link trace still writes its final artifact");
    NSDictionary *invalidTrace = jsonFile([invalidDirectory stringByAppendingPathComponent:kCaptureDisplayLinkFile]);
    check([invalidTrace[@"state"] isEqual:@"incomplete"]
        && [invalidTrace[@"observations"] count] == 1
        && [invalidTrace[@"omittedObservations"] isEqual:@1],
        @"the clock-invalid artifact preserves its valid prefix and omitted observation count");
    [invalidFixture release];
    clearCaptureError();

    SPCaptureRecording *boundaryFixture = makeRecording(directory, 0);
    uint64_t boundaryCallbackTime = mach_absolute_time();
    double boundaryMediaTime = CACurrentMediaTime();
    uint64_t boundaryMediaClockAfter = mach_absolute_time();
    [boundaryFixture recordDisplayLinkTimestamp:1e20 targetTimestamp:1e20 + 1e10 duration:0.016
        callbackTime:boundaryCallbackTime mediaClockTime:boundaryMediaTime mediaClockAfter:boundaryMediaClockAfter
        timebase:observationTimebase windowNumber:41 displayID:@7 visible:YES occluded:NO applicationActive:YES inFront:nil];
    check([boundaryFixture.displayLinkState isEqual:@"incomplete"]
        && boundaryFixture.omittedDisplayLinkObservations == 1
        && boundaryFixture.displayLinkObservations.count == 0,
        @"a timestamp whose Mach conversion exceeds the unsigned clock range is rejected");
    [boundaryFixture release];
    clearCaptureError();

    SPCaptureRecording *timebaseFixture = makeRecording(directory, 0);
    uint64_t timebaseBefore = mach_absolute_time();
    double timebaseMedia = CACurrentMediaTime();
    uint64_t timebaseAfter = mach_absolute_time();
    double timebaseTimestamp = timebaseMedia - 0.02;
    [timebaseFixture recordDisplayLinkTimestamp:timebaseTimestamp targetTimestamp:timebaseTimestamp + 0.016 duration:0.016
        callbackTime:timebaseBefore mediaClockTime:timebaseMedia mediaClockAfter:timebaseAfter
        timebase:observationTimebase windowNumber:41 displayID:@7 visible:YES occluded:NO applicationActive:YES inFront:nil];
    mach_timebase_info_data_t changedTimebase = observationTimebase;
    changedTimebase.numer++;
    uint64_t changedBefore = mach_absolute_time();
    double changedMedia = CACurrentMediaTime();
    uint64_t changedAfter = mach_absolute_time();
    double changedTimestamp = timebaseTimestamp + 0.001;
    [timebaseFixture recordDisplayLinkTimestamp:changedTimestamp targetTimestamp:changedTimestamp + 0.016 duration:0.016
        callbackTime:changedBefore mediaClockTime:changedMedia mediaClockAfter:changedAfter
        timebase:changedTimebase windowNumber:41 displayID:@7 visible:YES occluded:NO applicationActive:YES inFront:nil];
    check([timebaseFixture.displayLinkState isEqual:@"incomplete"]
        && timebaseFixture.omittedDisplayLinkObservations == 1
        && timebaseFixture.displayLinkObservations.count == 1,
        @"a changed Mach timebase invalidates the clock correlation and preserves its valid prefix");
    [timebaseFixture release];
    clearCaptureError();

    NSString *overflowDirectory = subdirectory(directory, @"display-link-overflow");
    SPCaptureRecording *overflowFixture = makeRecording(overflowDirectory, 0);
    double overflowBase = CACurrentMediaTime();
    for (NSUInteger index = 0; index < 4097; index++) {
        double timestamp = overflowBase + (double)index * 0.001;
        double mediaClockTime = timestamp + 0.00025;
        uint64_t callbackTime = rawMachForMediaTime(timestamp + 0.0002, observationTimebase);
        uint64_t mediaClockAfter = rawMachForMediaTime(timestamp + 0.0003, observationTimebase);
        [overflowFixture recordDisplayLinkTimestamp:timestamp targetTimestamp:timestamp + 0.016 duration:0.016
            callbackTime:callbackTime mediaClockTime:mediaClockTime mediaClockAfter:mediaClockAfter
            timebase:observationTimebase windowNumber:41 displayID:@7 visible:YES occluded:NO applicationActive:YES inFront:nil];
    }
    check(overflowFixture.displayLinkObservations.count == 4096
        && overflowFixture.omittedDisplayLinkObservations == 1
        && [overflowFixture.displayLinkState isEqual:@"incomplete"]
        && [[NSString stringWithUTF8String:sp_capture_error()] containsString:@"capacity exceeded"],
        @"the display-link trace records its 4096 bound, omitted count, incomplete state, and explicit error");
    clearCaptureError();
    check(beginCaptureSourceArtifacts(overflowDirectory, false)
        && finalizeCaptureArtifacts(overflowFixture), @"an incomplete display-link trace still writes its final artifact");
    NSDictionary *overflowTrace = jsonFile([overflowDirectory stringByAppendingPathComponent:kCaptureDisplayLinkFile]);
    check([overflowTrace[@"state"] isEqual:@"incomplete"]
        && [overflowTrace[@"observations"] count] == 4096
        && [overflowTrace[@"omittedObservations"] isEqual:@1]
        && [overflowTrace[@"reason"] isEqual:@"display-link observation capacity exceeded (4096 records)"],
        @"the incomplete artifact preserves all accepted records and the exact omitted callback count");
    [overflowFixture release];
    clearCaptureError();

    // The lifecycle debug events of a recording of two stills: still 0 written and still 1 without an image.
    NSString *lifecycleDirectory = subdirectory(directory, @"lifecycle");
    check(beginCaptureSourceArtifacts(lifecycleDirectory, false), @"the lifecycle fixture starts its source artifacts");
    SPCaptureRecording *lifecycle = makeRecording(lifecycleDirectory, 2);
    lifecycle.session = @"capture-lifecycle-test";
    const int8_t lifecyclePolicy[SP_CLASS_COUNT] = {SP_EVENT_DEBUG, SP_EVENT_ERROR, SP_EVENT_ERROR, SP_EVENT_ERROR, SP_EVENT_ERROR};
    const int8_t defaultPolicy[SP_CLASS_COUNT] = {SP_EVENT_ERROR, SP_EVENT_ERROR, SP_EVENT_ERROR, SP_EVENT_ERROR, SP_EVENT_ERROR};
    uint64_t lifecycleRequested = mach_absolute_time();
    check(sp_event_set_policy(lifecyclePolicy), @"the fixture enables lifecycle debug events before the recording");
    NSArray<NSDictionary *> *events = capturedEvents(^{
        emitLifecycle(lifecycle, @"start", SP_EVENT_DEBUG, nil, nil);
        stillImage(lifecycle, 0, opaquePixels(8, 4, 60), 8, 4, CGRectMake(0, 0, 4, 2), lifecycleRequested, lifecycleRequested + 1000);
        stillImage(lifecycle, 1, nil, 0, 0, CGRectMake(0, 0, 4, 2), lifecycleRequested + 2000, lifecycleRequested + 3000);
        emitLifecycle(lifecycle, @"stop", SP_EVENT_DEBUG, nil, nil);
        finishRecording(lifecycle);
    });
    check(sp_event_set_policy(defaultPolicy), @"the fixture restores the default error-only event policy");
    NSMutableDictionary<NSString *, NSDictionary *> *phases = [NSMutableDictionary dictionary];
    NSMutableArray<NSString *> *order = [NSMutableArray array];
    for (NSDictionary *event in events) {
        if (![event[@"name"] isEqual:@"native.capture.lifecycle"]) continue;
        NSDictionary *fields = event[@"fields"];
        [order addObject:fields[@"phase"]];
        phases[fields[@"phase"]] = event;
    }
    NSDictionary *firstStill = phases[@"first-still"][@"fields"];
    NSDictionary *failedStill = phases[@"still-failed"][@"fields"];
    NSDictionary *ended = phases[@"end"][@"fields"];
    check([order isEqual:@[@"start", @"first-still", @"still-failed", @"stop", @"end"]],
        [NSString stringWithFormat:@"a recording emits start, first-still, still-failed, stop and end in order (%@)", order]);
    BOOL everyEventHasFields = order.count == 5;
    for (NSString *phase in order) {
        NSDictionary *fields = phases[phase][@"fields"];
        everyEventHasFields = everyEventHasFields && [fields[@"session"] isEqual:@"capture-lifecycle-test"]
            && [fields[@"windowNumber"] isEqual:@41] && [fields[@"display"] isEqual:@NO] && [fields[@"gap"] isEqual:@1]
            && [fields[@"plannedStills"] isEqual:@2]
            && [fields[@"machTimebaseNumerator"] unsignedIntValue] == actualTimebase.numer
            && [fields[@"machTimebaseDenominator"] unsignedIntValue] == actualTimebase.denom
            && fields[@"written"] != nil && fields[@"settled"] != nil && fields[@"reason"] != nil;
    }
    check(everyEventHasFields, @"every lifecycle event carries the session, window, plan, timebase and outcome counts");
    check([firstStill[@"index"] isEqual:@0] && [firstStill[@"plannedMachTicks"] isEqual:lifecycle.rows[0][@"planned"]]
        && [firstStill[@"requestedMachTicks"] isEqual:tickString(lifecycleRequested)]
        && [firstStill[@"completedMachTicks"] isEqual:tickString(lifecycleRequested + 1000)]
        && [phases[@"first-still"][@"level"] isEqual:@(SP_EVENT_DEBUG)] && firstStill[@"reason"] == NSNull.null,
        [NSString stringWithFormat:@"the first-still event carries the index and the planned, requested and completed ticks of still 0 (%@)", firstStill]);
    check([failedStill[@"index"] isEqual:@1] && [phases[@"still-failed"][@"level"] isEqual:@(SP_EVENT_ERROR)]
        && [failedStill[@"reason"] isEqual:@"the window server gave no image of window 41"],
        [NSString stringWithFormat:@"the still-failed event is an error with the index and reason of the failed still (%@)", failedStill]);
    check(phases[@"start"][@"fields"][@"index"] == NSNull.null && [phases[@"end"][@"level"] isEqual:@(SP_EVENT_ERROR)]
        && [ended[@"written"] isEqual:@1] && [ended[@"settled"] isEqual:@2]
        && [ended[@"reason"] containsString:@"still 1: the window server gave no image of window 41"]
        && sp_capture_missed() == 1,
        [NSString stringWithFormat:@"the end event of a failed recording is an error with its counts and the recording error (%@)", ended]);
    [lifecycle release];
    clearCaptureError();

    fprintf(stderr, "%s: native capture still metadata validation (%.1fms)\n", failures ? "FAIL" : "PASS",
        (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
