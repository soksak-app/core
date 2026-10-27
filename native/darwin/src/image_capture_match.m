#import "image_capture_match.h"
#import "capture_frame_identity.h"
#import <Foundation/Foundation.h>
#import <CommonCrypto/CommonDigest.h>
#include <string.h>
#include <math.h>
#include <stdio.h>
#include <limits.h>
#include <stdatomic.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#import <mach/mach_time.h>

static const size_t kImageCaptureHistoryLimit = 64 * 1024 * 1024;
static const NSUInteger kImageCaptureHistoryCountLimit = 512;
static const size_t kImageCaptureArtifactPendingLimit = 64 * 1024 * 1024;
// The budget includes ordered record completion after decode; crop bytes keep their independent 64 MiB limit.
static const NSUInteger kIdentityDecodePendingJobLimit = 16;

static NSString *identityCapacityMessage(NSString *stage, uint64_t frame, NSUInteger pendingJobs,
    size_t pendingCropBytes, size_t incomingCropBytes, size_t artifactPendingBytes,
    BOOL jobLimitExceeded, BOOL byteLimitExceeded) {
    return [NSString stringWithFormat:
        @"frame identity decoder pending capacity was exceeded: stage=%@ frame=%llu pendingJobs=%lu jobLimit=%lu pendingCropBytes=%zu incomingCropBytes=%zu artifactPendingBytes=%zu byteLimit=%zu jobLimitExceeded=%d byteLimitExceeded=%d",
        stage, (unsigned long long)frame, (unsigned long)pendingJobs,
        (unsigned long)kIdentityDecodePendingJobLimit, pendingCropBytes, incomingCropBytes,
        artifactPendingBytes, kImageCaptureArtifactPendingLimit,
        jobLimitExceeded, byteLimitExceeded];
}

@interface SPImageCaptureSource : NSObject
@property sp_image_capture_identity identity;
@property(retain) NSData *pixels;
@property size_t width;
@property size_t height;
@property size_t stride;
@property CGRect screenBounds;
@property double scale;
@property(copy) NSString *colorSpace;
@end

@implementation SPImageCaptureSource
- (void)dealloc {
    [_pixels release];
    [_colorSpace release];
    [super dealloc];
}
@end

@interface SPImageCaptureIdentityArtifact : NSObject
@property sp_image_capture_identity identity;
@property CGRect roi;
@property size_t width;
@property size_t height;
@property size_t stride;
@property(retain) NSData *pixels;
@property(copy) NSString *regionToken;
@property(copy) NSString *nonce;
@property(copy) NSString *payload;
@property(copy) NSString *colorSpace;
@end

@implementation SPImageCaptureIdentityArtifact
- (void)dealloc {
    [_pixels release];
    [_regionToken release];
    [_nonce release];
    [_payload release];
    [_colorSpace release];
    [super dealloc];
}
@end

static NSCondition *historyLock;
static NSMutableArray<SPImageCaptureSource *> *history;
static size_t historyBytes;
static size_t historyDrops;
static size_t historyEvictions;
static atomic_bool historyEnabled;
static size_t artifactBytes;
static size_t artifactPendingBytes;
static NSUInteger artifactCount;
static size_t artifactDrops;
static size_t artifactWriteFailures;
static size_t artifactCleanupFailures;
static NSMutableArray<NSDictionary *> *artifactRecords;
static NSMutableDictionary<NSString *, NSNumber *> *artifactDropReasons;
static NSMutableArray<NSDictionary *> *artifactCleanupErrors;
static NSMutableDictionary<NSString *, SPImageCaptureSource *> *pendingArtifactSources;
static NSMutableDictionary<NSString *, NSDictionary *> *artifactIdentityRecords;
static NSString *artifactDirectory;
static dispatch_queue_t artifactWriterQueue;
static NSUInteger artifactComparisons;
static bool identitySessionActive;
static bool identitySessionStarted;
static atomic_bool identitySessionEnabled;
static NSMutableData *identityCaptureNonce;
static NSMutableDictionary<NSString *, NSMutableDictionary<NSString *, NSString *> *> *identityIssuedPayloads;
static NSMutableDictionary<NSString *, NSMutableSet<NSString *> *> *identityRegionsBySource;
static NSMutableDictionary<NSString *, NSMutableSet<NSString *> *> *identityRetiredRegionsBySource;
static NSMutableDictionary<NSString *, NSMutableDictionary<NSString *, NSString *> *> *identityRetiredPayloads;
static NSMutableArray<NSString *> *identityRetiredOrder;
static NSUInteger identityRetiredCount;
static NSMutableDictionary<NSString *, SPImageCaptureIdentityArtifact *> *pendingIdentityArtifacts;
static NSMutableDictionary<NSString *, NSString *> *identityArtifactSignatures;
static NSMutableArray<NSDictionary *> *identityArtifactRecords;
static NSString *identitySessionFailure;
static NSUInteger identityIssuedCount;
static size_t identityArtifactBytes;
static NSUInteger identityArtifactCount;
static size_t identityArtifactDrops;
static size_t identityArtifactWriteFailures;
static size_t identityArtifactCleanupFailures;
static NSMutableArray<NSDictionary *> *identityArtifactCleanupErrors;
static size_t identityDecodedFrameCount;
static size_t identityDecodedRecordCount;
static size_t identityDocumentDecodedRecords;
static size_t identityDocumentMatchedRecords;
static size_t identityDocumentUnknownRecords;
static size_t identityDocumentCompleteSamples;
static uint64_t identityDocumentMaxMatchedSequence;
static size_t identityDecodedWriteFailures;
static NSDictionary *identityDocumentFrame;
static dispatch_queue_t identityDecodeQueue;
static NSOperationQueue *identityDecodeWorkerQueue;
static NSUInteger identityDecodePendingJobs;
static size_t identityDecodePendingBytes;
static BOOL identityDecodeAccepting;

@interface SPIdentityDecodeJob : NSObject
@property uint64_t frame;
@property uint64_t displayTime;
@property uint64_t enqueuedTime;
@property(retain) NSArray<NSDictionary *> *groups;
@property(copy) NSString *unknownReason;
@property BOOL coverageMarker;
@property BOOL retentionMarker;
@property size_t cropBytes;
@property(retain) NSArray<NSDictionary *> *decodedRecords;
@property(retain) NSString *decodeFailure;
@end

@implementation SPIdentityDecodeJob
- (void)dealloc {
    [_groups release];
    [_unknownReason release];
    [_decodedRecords release];
    [_decodeFailure release];
    [super dealloc];
}
@end

static void recordArtifactDrop(NSString *reason);
static NSString *artifactName(sp_image_capture_identity identity);
static NSDictionary *artifactRecord(SPImageCaptureSource *source, NSString *fileName, NSString *digest);
static void writeArtifact(SPImageCaptureSource *source, NSString *directory, NSString *identityKey);
static void writeIdentityArtifact(SPImageCaptureIdentityArtifact *artifact, NSString *directory, NSString *artifactKey);
static void identityEvictSourceLocked(sp_image_capture_identity identity);
static bool identityFailure(char **error, const char *message);
static bool identityEnqueueFailure(char **error, const char *message);
static NSString *identitySourceKey(sp_image_capture_identity identity);
static NSString *identityArtifactKey(NSString *regionKey, NSString *sourceKey);
static NSString *identityArtifactPayloadLocked(NSString *regionKey, NSString *sourceKey);
static NSString *identityRecordSourceKey(NSDictionary *record);
static NSString *identityNonceLocked(const uint8_t token[16]);
static bool identityFromArtifactRecord(NSDictionary *record, sp_image_capture_identity *identity);
static bool validIdentityROI(CGRect roi, size_t width, size_t height);

static void clearIdentitySessionLocked(void) {
    if (identityCaptureNonce.length) memset(identityCaptureNonce.mutableBytes, 0, identityCaptureNonce.length);
    [identityCaptureNonce release];
    identityCaptureNonce = nil;
    [identityIssuedPayloads removeAllObjects];
    [identityRegionsBySource removeAllObjects];
    [identityRetiredRegionsBySource removeAllObjects];
    [identityRetiredPayloads removeAllObjects];
    [identityRetiredOrder removeAllObjects];
    identityRetiredCount = 0;
    [pendingIdentityArtifacts removeAllObjects];
    [identityArtifactSignatures removeAllObjects];
    [identityArtifactRecords removeAllObjects];
    [identitySessionFailure release];
    identitySessionFailure = nil;
    identitySessionStarted = false;
    identityIssuedCount = 0;
    identityArtifactBytes = 0;
    identityArtifactCount = 0;
    identityArtifactDrops = 0;
    identityArtifactWriteFailures = 0;
    identityArtifactCleanupFailures = 0;
    [identityArtifactCleanupErrors removeAllObjects];
    identityDecodedFrameCount = 0;
    identityDecodedRecordCount = 0;
    identityDocumentDecodedRecords = 0;
    identityDocumentMatchedRecords = 0;
    identityDocumentUnknownRecords = 0;
    identityDocumentCompleteSamples = 0;
    identityDocumentMaxMatchedSequence = 0;
    identityDecodedWriteFailures = 0;
    [identityDocumentFrame release];
    identityDocumentFrame = nil;
    identitySessionActive = false;
    atomic_store(&identitySessionEnabled, false);
}

static void initializeHistory(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        historyLock = [NSCondition new];
        history = [NSMutableArray new];
        artifactRecords = [NSMutableArray new];
        artifactDropReasons = [NSMutableDictionary new];
        artifactCleanupErrors = [NSMutableArray new];
        pendingArtifactSources = [NSMutableDictionary new];
        artifactIdentityRecords = [NSMutableDictionary new];
        identityIssuedPayloads = [NSMutableDictionary new];
        identityRegionsBySource = [NSMutableDictionary new];
        identityRetiredRegionsBySource = [NSMutableDictionary new];
        identityRetiredPayloads = [NSMutableDictionary new];
        identityRetiredOrder = [NSMutableArray new];
        pendingIdentityArtifacts = [NSMutableDictionary new];
        identityArtifactSignatures = [NSMutableDictionary new];
        identityArtifactRecords = [NSMutableArray new];
        identityArtifactCleanupErrors = [NSMutableArray new];
    });
}

static void closeAndDrainIdentityDecoder(void) {
    initializeHistory();
    [historyLock lock];
    identityDecodeAccepting = NO;
    atomic_store(&identitySessionEnabled, false);
    dispatch_queue_t queue = identityDecodeQueue;
    if (queue) dispatch_retain(queue);
    [historyLock unlock];
    if (queue) {
        dispatch_sync(queue, ^{});
        dispatch_release(queue);
    }
}

static void finishIdentityDecodePendingJob(void) {
    initializeHistory();
    [historyLock lock];
    if (identityDecodePendingJobs == 0) {
        if (!identitySessionFailure)
            identitySessionFailure = [@"frame identity decoder pending job accounting became inconsistent" copy];
        atomic_store(&identitySessionEnabled, false);
    } else {
        identityDecodePendingJobs--;
    }
    [historyLock broadcast];
    [historyLock unlock];
}

void sp_image_capture_match_begin(const char *capture_directory, dispatch_queue_t writer_queue) {
    initializeHistory();
    NSString *directory = capture_directory ? [NSString stringWithUTF8String:capture_directory] : nil;
    [historyLock lock];
    if (artifactWriterQueue) dispatch_release(artifactWriterQueue);
    [artifactDirectory release];
    artifactDirectory = [directory copy];
    clearIdentitySessionLocked();
    artifactWriterQueue = writer_queue;
    if (artifactWriterQueue) dispatch_retain(artifactWriterQueue);
    [history removeAllObjects];
    historyBytes = 0;
    historyDrops = 0;
    historyEvictions = 0;
    artifactBytes = 0;
    artifactPendingBytes = 0;
    artifactCount = 0;
    artifactDrops = 0;
    artifactWriteFailures = 0;
    artifactCleanupFailures = 0;
    [artifactRecords removeAllObjects];
    [artifactDropReasons removeAllObjects];
    [artifactCleanupErrors removeAllObjects];
    [pendingArtifactSources removeAllObjects];
    [artifactIdentityRecords removeAllObjects];
    artifactComparisons = 0;
    atomic_store(&historyEnabled, true);
    [historyLock unlock];
}

void sp_image_capture_match_end(void) {
    initializeHistory();
    closeAndDrainIdentityDecoder();
    [historyLock lock];
    atomic_store(&historyEnabled, false);
    while (artifactComparisons != 0) [historyLock wait];
    dispatch_queue_t writer_queue = artifactWriterQueue;
    if (writer_queue) dispatch_retain(writer_queue);
    [historyLock unlock];
    if (writer_queue) {
        dispatch_sync(writer_queue, ^{});
        dispatch_release(writer_queue);
    }
    [historyLock lock];
    clearIdentitySessionLocked();
    [history removeAllObjects];
    historyBytes = 0;
    artifactBytes = 0;
    artifactPendingBytes = 0;
    artifactCount = 0;
    artifactDrops = 0;
    artifactWriteFailures = 0;
    artifactCleanupFailures = 0;
    [artifactRecords removeAllObjects];
    [artifactDropReasons removeAllObjects];
    [artifactCleanupErrors removeAllObjects];
    [pendingArtifactSources removeAllObjects];
    [artifactIdentityRecords removeAllObjects];
    [artifactDirectory release];
    artifactDirectory = nil;
    if (artifactWriterQueue) dispatch_release(artifactWriterQueue);
    artifactWriterQueue = NULL;
    if (identityDecodeQueue) dispatch_release(identityDecodeQueue);
    identityDecodeQueue = NULL;
    [identityDecodeWorkerQueue release];
    identityDecodeWorkerQueue = nil;
    identityDecodePendingJobs = 0;
    identityDecodePendingBytes = 0;
    [historyLock unlock];
}

bool sp_image_capture_match_active(void) {
    return atomic_load(&historyEnabled);
}

void sp_image_capture_match_drop(void) {
    initializeHistory();
    [historyLock lock];
    if (atomic_load(&historyEnabled)) historyDrops++;
    [historyLock unlock];
}

bool sp_image_capture_match_retain(sp_image_capture_identity identity, const uint8_t *pixels,
    size_t width, size_t height, size_t stride, CGRect screen_bounds, double scale, const char *color_space) {
    initializeHistory();
    if (!pixels || !width || !height || width > SIZE_MAX / 4 || stride < width * 4
        || !stride || height > SIZE_MAX / stride) {
        sp_image_capture_match_drop();
        return false;
    }
    if (!atomic_load(&historyEnabled)) return true;
    size_t byteCount = stride * height;
    if (byteCount > kImageCaptureHistoryLimit) {
        sp_image_capture_match_drop();
        return false;
    }
    NSString *colorSpace = color_space ? [NSString stringWithUTF8String:color_space] : nil;
    NSString *identityKey = [NSString stringWithFormat:@"%llu-%llu-%d", (unsigned long long)identity.generation,
        (unsigned long long)identity.raster, identity.sequence];
    [historyLock lock];
    if (!atomic_load(&historyEnabled)) { [historyLock unlock]; return true; }
    for (SPImageCaptureSource *retained in history) {
        if (retained.identity.generation != identity.generation || retained.identity.raster != identity.raster
            || retained.identity.sequence != identity.sequence) continue;
        NSString *retainedColor = retained.colorSpace ?: @"<null>";
        BOOL sameMetadata = retained.width == width && retained.height == height && retained.stride == stride
            && CGRectEqualToRect(retained.screenBounds, screen_bounds) && retained.scale == scale
            && [retainedColor isEqualToString:colorSpace ?: @"<null>"];
        BOOL samePixels = sameMetadata && retained.pixels.length == byteCount
            && memcmp(retained.pixels.bytes, pixels, byteCount) == 0;
        if (samePixels) { [historyLock unlock]; return true; }
        historyDrops++;
        recordArtifactDrop(@"identity-conflict");
        [historyLock unlock];
        return false;
    }
    SPImageCaptureSource *pendingSource = pendingArtifactSources[identityKey];
    if (pendingSource) {
        NSString *pendingColor = pendingSource.colorSpace ?: @"<null>";
        BOOL sameMetadata = pendingSource.width == width && pendingSource.height == height
            && pendingSource.stride == stride && CGRectEqualToRect(pendingSource.screenBounds, screen_bounds)
            && pendingSource.scale == scale && [pendingColor isEqualToString:colorSpace ?: @"<null>"];
        BOOL samePixels = sameMetadata && pendingSource.pixels.length == byteCount
            && memcmp(pendingSource.pixels.bytes, pixels, byteCount) == 0;
        if (samePixels) { [historyLock unlock]; return true; }
        historyDrops++;
        recordArtifactDrop(@"identity-conflict");
        [historyLock unlock];
        return false;
    }
    NSDictionary *artifactRecordForIdentity = artifactIdentityRecords[identityKey];
    if (artifactRecordForIdentity) {
        NSDictionary *record = [artifactRecordForIdentity retain];
        NSString *directory = [artifactDirectory copy];
        dispatch_queue_t writer_queue = artifactWriterQueue;
        if (writer_queue) dispatch_retain(writer_queue);
        artifactComparisons++;
        [historyLock unlock];

        CGRect recordBounds = CGRectMake([record[@"screenBounds"][@"x"] doubleValue],
            [record[@"screenBounds"][@"y"] doubleValue], [record[@"screenBounds"][@"width"] doubleValue],
            [record[@"screenBounds"][@"height"] doubleValue]);
        NSString *recordColor = record[@"colorSpace"] == NSNull.null ? nil : record[@"colorSpace"];
        BOOL sameMetadata = [record[@"generation"] isEqual:[NSString stringWithFormat:@"%llu", (unsigned long long)identity.generation]]
            && [record[@"raster"] isEqual:[NSString stringWithFormat:@"%llu", (unsigned long long)identity.raster]]
            && [record[@"sequence"] isEqual:@(identity.sequence)]
            && [record[@"width"] isEqual:@(width)] && [record[@"height"] isEqual:@(height)]
            && [record[@"stride"] isEqual:@(stride)] && CGRectEqualToRect(recordBounds, screen_bounds)
            && [record[@"scale"] isEqual:@(scale)]
            && [(recordColor ?: @"<null>") isEqualToString:colorSpace ?: @"<null>"]
            && [record[@"byteCount"] isEqual:@(byteCount)];
        __block int fileMatch = sameMetadata ? -1 : 0;
        if (sameMetadata && writer_queue && directory) {
            NSString *path = [[directory stringByAppendingPathComponent:@"sources"]
                stringByAppendingPathComponent:artifactName(identity)];
            dispatch_sync(writer_queue, ^{
                int descriptor = open(path.fileSystemRepresentation, O_RDONLY);
                if (descriptor < 0) return;
                struct stat status;
                if (fstat(descriptor, &status) != 0 || status.st_size < 0 || (uint64_t)status.st_size != byteCount) {
                    fileMatch = 0;
                    close(descriptor);
                    return;
                }
                uint8_t chunk[64 * 1024];
                size_t offset = 0;
                fileMatch = 1;
                while (offset < byteCount) {
                    size_t wanted = MIN(sizeof(chunk), byteCount - offset);
                    ssize_t count = read(descriptor, chunk, wanted);
                    if (count < 0 && errno == EINTR) continue;
                    if (count <= 0) { fileMatch = -1; break; }
                    if (memcmp(chunk, pixels + offset, (size_t)count) != 0) { fileMatch = 0; break; }
                    offset += (size_t)count;
                }
                if (close(descriptor) != 0 && fileMatch == 1) fileMatch = -1;
            });
        }
        if (writer_queue) dispatch_release(writer_queue);
        [directory release];
        [record release];
        [historyLock lock];
        artifactComparisons--;
        [historyLock broadcast];
        if (fileMatch == 1) { [historyLock unlock]; return true; }
        historyDrops++;
        if (fileMatch < 0) {
            artifactWriteFailures++;
            recordArtifactDrop(@"identity-read");
        } else {
            recordArtifactDrop(@"identity-conflict");
        }
        [historyLock unlock];
        return false;
    }

    if (artifactWriterQueue && artifactDirectory) {
        if (artifactCount >= kImageCaptureHistoryCountLimit
            || byteCount > kImageCaptureArtifactPendingLimit
            || artifactPendingBytes > kImageCaptureArtifactPendingLimit - byteCount
            || identityDecodePendingBytes > kImageCaptureArtifactPendingLimit - artifactPendingBytes - byteCount) {
            historyDrops++;
            recordArtifactDrop(@"capacity");
            [historyLock unlock];
            return false;
        }
    }
    while ((historyBytes + byteCount > kImageCaptureHistoryLimit || history.count >= kImageCaptureHistoryCountLimit)
        && history.count > 0) {
        SPImageCaptureSource *oldest = history.firstObject;
        identityEvictSourceLocked(oldest.identity);
        historyBytes -= oldest.pixels.length;
        [history removeObjectAtIndex:0];
        historyDrops++;
        historyEvictions++;
    }
    SPImageCaptureSource *source = [SPImageCaptureSource new];
    source.identity = identity;
    source.pixels = [NSData dataWithBytes:pixels length:byteCount];
    source.width = width;
    source.height = height;
    source.stride = stride;
    source.screenBounds = screen_bounds;
    source.scale = scale;
    source.colorSpace = colorSpace;
    [history addObject:source];
    historyBytes += byteCount;
    if (artifactWriterQueue && artifactDirectory) {
        artifactPendingBytes += byteCount;
        artifactBytes += byteCount;
        artifactCount++;
        pendingArtifactSources[identityKey] = source;
        NSString *directory = [artifactDirectory copy];
        [source retain];
        dispatch_async(artifactWriterQueue, ^{
            writeArtifact(source, directory, identityKey);
            [source release];
            [directory release];
        });
    }
    [source release];
    [historyLock unlock];
    return true;
}

static NSString *artifactName(sp_image_capture_identity identity) {
    return [NSString stringWithFormat:@"%llu-%llu-%d.bgra", (unsigned long long)identity.generation,
        (unsigned long long)identity.raster, identity.sequence];
}

static void recordArtifactDrop(NSString *reason) {
    artifactDrops++;
    artifactDropReasons[reason] = @([artifactDropReasons[reason] unsignedLongLongValue] + 1);
}

static NSDictionary *artifactRecord(SPImageCaptureSource *source, NSString *fileName, NSString *digest) {
    CGRect bounds = source.screenBounds;
    return @{
        @"generation": [NSString stringWithFormat:@"%llu", (unsigned long long)source.identity.generation],
        @"raster": [NSString stringWithFormat:@"%llu", (unsigned long long)source.identity.raster],
        @"sequence": @(source.identity.sequence), @"file": fileName,
        @"width": @(source.width), @"height": @(source.height), @"stride": @(source.stride),
        @"pixelFormat": @"BGRA8", @"alpha": @"premultiplied-first",
        @"screenBounds": @{ @"x": @(CGRectGetMinX(bounds)), @"y": @(CGRectGetMinY(bounds)),
            @"width": @(CGRectGetWidth(bounds)), @"height": @(CGRectGetHeight(bounds)) },
        @"scale": @(source.scale), @"colorSpace": source.colorSpace ?: (id)NSNull.null,
        @"byteCount": @(source.pixels.length), @"sha256": digest,
    };
}

static void writeArtifact(SPImageCaptureSource *source, NSString *directory, NSString *identityKey) {
    NSString *sourceDirectory = [directory stringByAppendingPathComponent:@"sources"];
    NSFileManager *manager = NSFileManager.defaultManager;
    NSError *error = nil;
    NSString *fileName = artifactName(source.identity);
    NSString *path = [sourceDirectory stringByAppendingPathComponent:fileName];
    NSString *partial = [path stringByAppendingString:@".partial"];
    NSData *pixels = source.pixels;
    BOOL created = [manager createDirectoryAtPath:sourceDirectory withIntermediateDirectories:YES attributes:nil error:&error];
    BOOL written = created && [pixels writeToFile:partial options:NSDataWritingAtomic error:&error]
        && [manager moveItemAtPath:partial toPath:path error:&error];
    NSError *cleanupError = nil;
    BOOL partialExists = [manager fileExistsAtPath:partial];
    BOOL cleanupSucceeded = !partialExists || [manager removeItemAtPath:partial error:&cleanupError];
    NSDictionary *record = nil;
    if (written) {
        unsigned char digest[CC_SHA256_DIGEST_LENGTH];
        CC_SHA256(pixels.bytes, (CC_LONG)pixels.length, digest);
        NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
        for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) [hex appendFormat:@"%02x", digest[index]];
        record = artifactRecord(source, fileName, hex);
    }

    [historyLock lock];
    artifactPendingBytes -= pixels.length;
    [pendingArtifactSources removeObjectForKey:identityKey];
    if (written) {
        [artifactRecords addObject:record];
        artifactIdentityRecords[identityKey] = record;
    } else {
        artifactBytes -= pixels.length;
        artifactCount--;
        artifactWriteFailures++;
        recordArtifactDrop(created ? @"write" : @"directory");
        if (!cleanupSucceeded) {
            artifactCleanupFailures++;
            recordArtifactDrop(@"partial-cleanup");
            if (artifactCleanupErrors.count < 32) {
                [artifactCleanupErrors addObject:@{ @"path": partial,
                    @"error": cleanupError.localizedDescription ?: @"unknown cleanup error" }];
            }
        }
    }
    [historyLock broadcast];
    [historyLock unlock];
}

static NSDictionary *identityArtifactManifestRecord(SPImageCaptureIdentityArtifact *artifact,
    NSString *fileName, NSString *digest) {
    return @{
        @"generation": [NSString stringWithFormat:@"%llu", (unsigned long long)artifact.identity.generation],
        @"raster": [NSString stringWithFormat:@"%llu", (unsigned long long)artifact.identity.raster],
        @"sequence": @(artifact.identity.sequence), @"regionToken": artifact.regionToken,
        @"nonce": artifact.nonce, @"payload": artifact.payload,
        @"roi": @{ @"x": @(artifact.roi.origin.x), @"y": @(artifact.roi.origin.y),
            @"width": @(artifact.roi.size.width), @"height": @(artifact.roi.size.height) },
        @"file": fileName, @"width": @(artifact.width), @"height": @(artifact.height),
        @"stride": @(artifact.stride), @"pixelFormat": @"BGRA8", @"alpha": @"premultiplied-first",
        @"colorSpace": artifact.colorSpace ?: (id)NSNull.null,
        @"byteCount": @(artifact.pixels.length), @"sha256": digest,
    };
}

static void writeIdentityArtifact(SPImageCaptureIdentityArtifact *artifact, NSString *directory, NSString *artifactKey) {
    NSString *identityDirectory = [directory stringByAppendingPathComponent:@"frame-identities"];
    NSFileManager *manager = NSFileManager.defaultManager;
    NSError *error = nil;
    NSString *fileName = [artifactKey stringByAppendingString:@".bgra"];
    NSString *path = [identityDirectory stringByAppendingPathComponent:fileName];
    NSString *partial = [path stringByAppendingString:@".partial"];
    NSData *pixels = artifact.pixels;
    BOOL created = [manager createDirectoryAtPath:identityDirectory withIntermediateDirectories:YES attributes:nil error:&error];
    BOOL written = created && [pixels writeToFile:partial options:NSDataWritingAtomic error:&error]
        && [manager moveItemAtPath:partial toPath:path error:&error];
    NSError *cleanupError = nil;
    BOOL partialExists = [manager fileExistsAtPath:partial];
    BOOL cleanupSucceeded = !partialExists || [manager removeItemAtPath:partial error:&cleanupError];
    NSString *digestHex = nil;
    if (written) {
        uint8_t digest[CC_SHA256_DIGEST_LENGTH];
        CC_SHA256(pixels.bytes, (CC_LONG)pixels.length, digest);
        NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
        for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) [hex appendFormat:@"%02x", digest[index]];
        digestHex = hex;
    }
    NSDictionary *record = written ? identityArtifactManifestRecord(artifact, fileName, digestHex) : nil;

    [historyLock lock];
    artifactPendingBytes -= pixels.length;
    [pendingIdentityArtifacts removeObjectForKey:artifactKey];
    if (written) {
        identityArtifactBytes += pixels.length;
        [identityArtifactRecords addObject:record];
    } else {
        identityArtifactCount--;
        identityArtifactWriteFailures++;
        identityArtifactDrops++;
        if (!identitySessionFailure) {
            NSString *reason = error.localizedDescription ?: @"no file error was provided";
            identitySessionFailure = [[NSString alloc] initWithFormat:@"frame identity artifact write failed: %@", reason];
        }
        atomic_store(&identitySessionEnabled, false);
        if (!cleanupSucceeded) {
            identityArtifactCleanupFailures++;
            if (identityArtifactCleanupErrors.count < 32) {
                [identityArtifactCleanupErrors addObject:@{ @"path": partial,
                    @"error": cleanupError.localizedDescription ?: @"unknown cleanup error" }];
            }
        }
    }
    [historyLock broadcast];
    [historyLock unlock];
}

bool sp_image_capture_match_write_manifest(const char *capture_directory) {
    initializeHistory();
    if (!capture_directory) return false;
    NSString *directory = [NSString stringWithUTF8String:capture_directory];
    if (!directory) return false;

    closeAndDrainIdentityDecoder();
    [historyLock lock];
    atomic_store(&historyEnabled, false);
    while (artifactComparisons != 0) [historyLock wait];
    dispatch_queue_t writer_queue = artifactWriterQueue;
    if (writer_queue) dispatch_retain(writer_queue);
    [historyLock unlock];
    if (writer_queue) {
        dispatch_sync(writer_queue, ^{});
        dispatch_release(writer_queue);
    }

    [historyLock lock];
    if ([identityDocumentFrame[@"issuedSlots"] isKindOfClass:NSNumber.class]
        && identityDocumentMaxMatchedSequence > [identityDocumentFrame[@"issuedSlots"] unsignedLongLongValue]
        && !identitySessionFailure) {
        identitySessionFailure = [@"document frame identity matched a sequence above its final issued count" copy];
        atomic_store(&identitySessionEnabled, false);
    }
    if (artifactDirectory && ![artifactDirectory isEqualToString:directory]) {
        [historyLock unlock];
        return false;
    }
    NSDictionary *manifest = @{
        @"format": @2, @"pixelFormat": @"BGRA8", @"alpha": @"premultiplied-first",
        @"limits": @{ @"historyBytes": @(kImageCaptureHistoryLimit),
            @"historyIdentities": @(kImageCaptureHistoryCountLimit),
            @"pendingArtifactBytes": @(kImageCaptureArtifactPendingLimit),
            @"artifactIdentities": @(kImageCaptureHistoryCountLimit) },
        @"artifactBytes": @(artifactBytes),
        @"artifacts": [artifactRecords copy], @"droppedSources": @(artifactDrops),
        @"dropReasons": [artifactDropReasons copy], @"writeFailures": @(artifactWriteFailures),
        @"cleanupFailures": @(artifactCleanupFailures), @"cleanupErrors": [artifactCleanupErrors copy],
        @"cleanupErrorsOmitted": @(artifactCleanupFailures - artifactCleanupErrors.count),
    };
    BOOL noWriteFailures = artifactWriteFailures == 0;
    BOOL identityStarted = identitySessionStarted;
    NSArray<NSDictionary *> *identityRecords = [identityArtifactRecords copy];
    NSArray<NSDictionary *> *identityCleanupErrors = [identityArtifactCleanupErrors copy];
    NSString *identityFailure = [identitySessionFailure copy];
    size_t identityBytes = identityArtifactBytes;
    size_t identityDrops = identityArtifactDrops;
    size_t identityWriteFailures = identityArtifactWriteFailures;
    size_t identityCleanupFailures = identityArtifactCleanupFailures;
    size_t decodedFrameCount = identityDecodedFrameCount;
    size_t decodedRecordCount = identityDecodedRecordCount;
    NSDictionary *documentFrame = [identityDocumentFrame copy];
    size_t documentCompleteSamples = identityDocumentCompleteSamples;
    size_t documentDecodedRecords = identityDocumentDecodedRecords;
    size_t documentMatchedRecords = identityDocumentMatchedRecords;
    size_t documentUnknownRecords = identityDocumentUnknownRecords;
    size_t decodedWriteFailures = identityDecodedWriteFailures;
    [historyLock unlock];
    NSString *sourceDirectory = [directory stringByAppendingPathComponent:@"sources"];
    NSError *error = nil;
    if (![NSFileManager.defaultManager createDirectoryAtPath:sourceDirectory withIntermediateDirectories:YES attributes:nil error:&error]) {
        [manifest[@"artifacts"] release];
        [manifest[@"dropReasons"] release];
        [manifest[@"cleanupErrors"] release];
        return false;
    }
    NSData *data = [NSJSONSerialization dataWithJSONObject:manifest options:NSJSONWritingPrettyPrinted error:&error];
    [manifest[@"artifacts"] release];
    [manifest[@"dropReasons"] release];
    [manifest[@"cleanupErrors"] release];
    NSString *path = [sourceDirectory stringByAppendingPathComponent:@"manifest.json"];
    BOOL sourceManifestWritten = data && [data writeToFile:path options:NSDataWritingAtomic error:&error];
    BOOL identityManifestWritten = YES;
    if (identityStarted) {
        NSMutableDictionary *identityManifest = [@{
            @"format": @1, @"pixelFormat": @"BGRA8",
            @"limits": @{ @"issuedIdentities": @(kImageCaptureHistoryCountLimit),
                @"pendingArtifactBytes": @(kImageCaptureArtifactPendingLimit) },
            @"artifactBytes": @(identityBytes), @"artifacts": identityRecords,
            @"droppedArtifacts": @(identityDrops), @"writeFailures": @(identityWriteFailures),
            @"cleanupFailures": @(identityCleanupFailures), @"cleanupErrors": identityCleanupErrors,
            @"cleanupErrorsOmitted": @(identityCleanupFailures - identityCleanupErrors.count),
            @"decodedFramesFile": @"decoded-frames.jsonl", @"decodedFrames": @(decodedFrameCount),
            @"decodedRecords": @(decodedRecordCount), @"decodedWriteFailures": @(decodedWriteFailures),
            @"identityFailure": identityFailure ?: (id)NSNull.null,
        } mutableCopy];
        NSString *identityDirectory = [directory stringByAppendingPathComponent:@"frame-identities"];
        NSError *identityError = nil;
        identityManifestWritten = [NSFileManager.defaultManager createDirectoryAtPath:identityDirectory
            withIntermediateDirectories:YES attributes:nil error:&identityError];
        if (identityManifestWritten && documentFrame) {
            NSData *atlas = [documentFrame[@"atlasPNG"] isKindOfClass:[NSData class]] ? documentFrame[@"atlasPNG"] : nil;
            id issuedValue = documentFrame[@"issuedSlots"];
            identityManifestWritten = atlas.length > 0 && issuedValue != NSNull.null;
            NSString *atlasFile = @"document-atlas.png";
            NSString *atlasPath = [identityDirectory stringByAppendingPathComponent:atlasFile];
            if (identityManifestWritten)
                identityManifestWritten = [atlas writeToFile:atlasPath options:NSDataWritingAtomic error:&identityError];
            NSUInteger slots = [documentFrame[@"atlasSlots"] unsignedIntegerValue];
            NSUInteger issued = [issuedValue respondsToSelector:@selector(unsignedIntegerValue)]
                ? [issuedValue unsignedIntegerValue] : 0;
            NSUInteger incomplete = documentCompleteSamples > documentDecodedRecords
                ? (NSUInteger)(documentCompleteSamples - documentDecodedRecords) : 0;
            identityManifest[@"documentFrameIdentity"] = @{
                @"generation": documentFrame[@"generation"], @"raster": documentFrame[@"raster"],
                @"regionToken": documentFrame[@"region"], @"screenROI": documentFrame[@"screenROI"],
                @"atlasFile": atlasFile, @"atlasSlots": @(slots), @"issuedSlots": @(issued),
                @"generatedIdentities": documentFrame[@"sourceIdentities"],
                @"decodedRecords": @(documentDecodedRecords), @"matchedRecords": @(documentMatchedRecords),
                @"unknownRecords": @(documentUnknownRecords), @"incompleteSamples": @(incomplete),
            };
        }
        NSData *identityData = identityManifestWritten
            ? [NSJSONSerialization dataWithJSONObject:identityManifest options:NSJSONWritingPrettyPrinted error:&identityError]
            : nil;
        NSString *identityManifestPath = [identityDirectory stringByAppendingPathComponent:@"manifest.json"];
        identityManifestWritten = identityData
            && [identityData writeToFile:identityManifestPath options:NSDataWritingAtomic error:&identityError];
        [identityManifest release];
    }
    [identityRecords release]; [identityCleanupErrors release]; [identityFailure release]; [documentFrame release];
    return sourceManifestWritten && noWriteFailures && identityManifestWritten
        && identityFailure == nil && identityWriteFailures == 0;
}

static BOOL equalPixels(const SPImageCaptureSource *source, const uint8_t *pixels,
    size_t width, size_t height, size_t stride) {
    if (source.width != width || source.height != height) return NO; // silent: dimension mismatch makes this source unequal, so matching continues.
    const uint8_t *sourceBytes = source.pixels.bytes;
    for (size_t row = 0; row < height; row++) {
        if (memcmp(sourceBytes + row * source.stride, pixels + row * stride, width * 4) != 0) return NO; // silent: byte mismatch makes this source unequal, so matching continues.
    }
    return YES;
}

static void pixelDifference(const SPImageCaptureSource *source, const uint8_t *pixels,
    size_t stride, sp_image_capture_match_result *result) {
    const uint8_t *sourceBytes = source.pixels.bytes;
    for (size_t y = 0; y < source.height; y++) {
        for (size_t x = 0; x < source.width; x++) {
            const uint8_t *expected = sourceBytes + y * source.stride + x * 4;
            const uint8_t *actual = pixels + y * stride + x * 4;
            if (memcmp(expected, actual, 4) == 0) continue;
            if (!result->has_pixel_difference) {
                result->has_pixel_difference = true;
                result->first_difference_x = x;
                result->first_difference_y = y;
                memcpy(result->expected_bgra, expected, 4);
                memcpy(result->actual_bgra, actual, 4);
            }
            result->different_pixels++;
        }
    }
}

static void latestSourceFacts(sp_image_capture_match_result *result, SPImageCaptureSource *source) {
    result->has_latest_source = source != nil;
    if (!source) return;
    result->latest_source = source.identity;
    result->latest_width = source.width;
    result->latest_height = source.height;
    result->latest_stride = source.stride;
    result->latest_screen_bounds = source.screenBounds;
    result->latest_scale = source.scale;
    if (source.colorSpace) snprintf(result->latest_color_space, sizeof(result->latest_color_space), "%s", source.colorSpace.UTF8String);
}

static BOOL mapSourceCrop(const SPImageCaptureSource *source, CGRect content_rect, CGRect screen_rect,
    double pixels_per_point, size_t frame_width, size_t frame_height, CGRect *crop) {
    CGRect bounds = source.screenBounds;
    if (CGRectIsEmpty(bounds) || CGRectIsNull(bounds)
        || CGRectGetMinX(bounds) < CGRectGetMinX(screen_rect)
        || CGRectGetMaxX(bounds) > CGRectGetMaxX(screen_rect)
        || CGRectGetMinY(bounds) < CGRectGetMinY(screen_rect)
        || CGRectGetMaxY(bounds) > CGRectGetMaxY(screen_rect)) return NO; // silent: invalid bounds leave the caller without a mapped crop and produce unknown geometry.
    double left = CGRectGetMinX(content_rect) + (CGRectGetMinX(bounds) - CGRectGetMinX(screen_rect)) * pixels_per_point;
    double top = CGRectGetMinY(content_rect) + (CGRectGetMinY(bounds) - CGRectGetMinY(screen_rect)) * pixels_per_point;
    double width = CGRectGetWidth(bounds) * pixels_per_point;
    double height = CGRectGetHeight(bounds) * pixels_per_point;
    double rounded_left = nearbyint(left), rounded_top = nearbyint(top);
    double rounded_width = nearbyint(width), rounded_height = nearbyint(height);
    if (fabs(left - rounded_left) > 0.000001 || fabs(top - rounded_top) > 0.000001
        || fabs(width - rounded_width) > 0.000001 || fabs(height - rounded_height) > 0.000001
        || rounded_left < 0 || rounded_top < 0 || rounded_width != source.width || rounded_height != source.height
        || rounded_left + rounded_width > frame_width || rounded_top + rounded_height > frame_height) return NO; // silent: invalid crop geometry produces an unknown or unmapped result at the caller.
    *crop = CGRectMake(rounded_left, rounded_top, rounded_width, rounded_height);
    return YES;
}

static BOOL mapScreenROI(CGRect bounds, CGRect content_rect, CGRect screen_rect, double pixels_per_point,
    size_t frame_width, size_t frame_height, CGRect *crop) {
    if (CGRectIsEmpty(bounds) || CGRectIsNull(bounds)
        || CGRectGetMinX(bounds) < CGRectGetMinX(screen_rect)
        || CGRectGetMaxX(bounds) > CGRectGetMaxX(screen_rect)
        || CGRectGetMinY(bounds) < CGRectGetMinY(screen_rect)
        || CGRectGetMaxY(bounds) > CGRectGetMaxY(screen_rect)) return NO;
    double left = CGRectGetMinX(content_rect) + (CGRectGetMinX(bounds) - CGRectGetMinX(screen_rect)) * pixels_per_point;
    double top = CGRectGetMinY(content_rect) + (CGRectGetMinY(bounds) - CGRectGetMinY(screen_rect)) * pixels_per_point;
    double width = CGRectGetWidth(bounds) * pixels_per_point;
    double height = CGRectGetHeight(bounds) * pixels_per_point;
    double rounded_left = nearbyint(left), rounded_top = nearbyint(top);
    double rounded_width = nearbyint(width), rounded_height = nearbyint(height);
    if (fabs(left - rounded_left) > 0.000001 || fabs(top - rounded_top) > 0.000001
        || fabs(width - rounded_width) > 0.000001 || fabs(height - rounded_height) > 0.000001
        || rounded_left < 0 || rounded_top < 0 || rounded_width <= 0 || rounded_height <= 0
        || rounded_left + rounded_width > frame_width || rounded_top + rounded_height > frame_height) return NO;
    *crop = CGRectMake(rounded_left, rounded_top, rounded_width, rounded_height);
    return YES;
}

static NSDictionary *identityTupleRecord(sp_image_capture_identity identity) {
    return @{ @"generation": [NSString stringWithFormat:@"%llu", (unsigned long long)identity.generation],
        @"raster": [NSString stringWithFormat:@"%llu", (unsigned long long)identity.raster],
        @"sequence": @(identity.sequence) };
}

static NSDictionary *identityDecodeRecord(uint64_t frame, uint64_t display_time, NSString *region,
    CGRect roi, NSString *status, NSString *reason, sp_image_capture_identity identity, BOOL has_identity,
    NSString *source_kind) {
    return @{ @"frame": @(frame), @"displayTime": [NSString stringWithFormat:@"%llu", (unsigned long long)display_time],
        @"region": region ?: (id)NSNull.null,
        @"roi": CGRectIsNull(roi) ? (id)NSNull.null : @{ @"x": @(CGRectGetMinX(roi)), @"y": @(CGRectGetMinY(roi)),
            @"width": @(CGRectGetWidth(roi)), @"height": @(CGRectGetHeight(roi)) },
        @"status": status, @"identity": has_identity ? identityTupleRecord(identity) : (id)NSNull.null,
        @"reason": reason ?: (id)NSNull.null, @"sourceKind": source_kind ?: (id)NSNull.null };
}

static NSString *identityDecodeReason(NSString *helperReason) {
    if ([helperReason isEqual:@"no-code-in-expected-roi"]) return @"no-code";
    if ([helperReason isEqual:@"ambiguous-code-count"]) return @"ambiguous";
    if ([helperReason isEqual:@"payload-unissued"] || [helperReason isEqual:@"payload-malformed"]
        || [helperReason isEqual:@"payload-checksum-invalid"]) return @"unissued";
    if ([helperReason isEqual:@"code-outside-expected-roi"] || [helperReason isEqual:@"payload-unreadable"])
        return @"cropped";
    return @"unissued";
}

static BOOL appendIdentityDecodeRecords(NSArray<NSDictionary *> *records, uint64_t frame_number, char **error) {
    if (error) *error = NULL;
    if (!error) return NO; // silent: the public decoder validates its required error output before calling this helper.
    NSMutableData *lines = [NSMutableData data];
    for (NSDictionary *record in records) {
        NSError *encodingError = nil;
        NSData *line = [NSJSONSerialization dataWithJSONObject:record options:0 error:&encodingError];
        if (!line) return identityFailure(error, encodingError.localizedDescription.UTF8String
            ?: "decoded frame identity record could not be encoded");
        [lines appendData:line];
        [lines appendBytes:"\n" length:1];
    }
    initializeHistory();
    [historyLock lock];
    BOOL writerAvailable = artifactWriterQueue != NULL;
    NSString *directory = [artifactDirectory copy];
    [historyLock unlock];
    if (!writerAvailable || !directory) {
        [directory release];
        return identityFailure(error, "decoded frame identity writer is unavailable");
    }
    NSData *ownedLines = [lines copy];
    NSString *identityDirectory = [directory stringByAppendingPathComponent:@"frame-identities"];
    NSString *path = [identityDirectory stringByAppendingPathComponent:@"decoded-frames.jsonl"];
    NSError *writeError = nil;
    BOOL created = [NSFileManager.defaultManager createDirectoryAtPath:identityDirectory
        withIntermediateDirectories:YES attributes:nil error:&writeError];
    FILE *file = created ? fopen(path.fileSystemRepresentation, "ab") : NULL;
    BOOL written = file && fwrite(ownedLines.bytes, ownedLines.length, 1, file) == 1;
    int savedErrno = errno;
    BOOL closed = file ? fclose(file) == 0 : NO;
    if (written && !closed) { written = NO; savedErrno = errno; }
    [historyLock lock];
    if (written) {
        identityDecodedFrameCount++;
        identityDecodedRecordCount += records.count;
        for (NSDictionary *record in records) {
            id sourceKind = record[@"sourceKind"];
            if (![sourceKind isKindOfClass:NSString.class] || ![sourceKind isEqualToString:@"document"]) continue;
            identityDocumentDecodedRecords++;
            if ([record[@"status"] isEqualToString:@"matched"]) {
                identityDocumentMatchedRecords++;
                uint64_t sequence = [record[@"identity"][@"sequence"] unsignedLongLongValue];
                identityDocumentMaxMatchedSequence = MAX(identityDocumentMaxMatchedSequence, sequence);
            }
            else identityDocumentUnknownRecords++;
        }
    } else {
        identityDecodedWriteFailures++;
    }
    [historyLock broadcast];
    [historyLock unlock];
    NSString *failureReason = written ? nil : [(writeError.localizedDescription
        ?: [NSString stringWithFormat:@"decoded identity frame %llu could not be appended: %s",
            (unsigned long long)frame_number, strerror(savedErrno)]) copy];
    [ownedLines release];
    [directory release];
    if (!written) {
        BOOL failed = identityFailure(error, failureReason.UTF8String
            ?: "decoded frame identity artifact could not be appended");
        [failureReason release];
        return failed;
    }
    return YES;
}

static SPImageCaptureSource *sourceFromArtifactRecord(NSDictionary *record) {
    NSString *sourceKey = identityRecordSourceKey(record);
    sp_image_capture_identity identity = {};
    NSDictionary *bounds = record[@"screenBounds"];
    if (![bounds isKindOfClass:[NSDictionary class]]) return nil;
    for (NSString *field in @[@"x", @"y", @"width", @"height"])
        if (![bounds[field] respondsToSelector:@selector(doubleValue)]) return nil;
    if (!sourceKey || !identityFromArtifactRecord(record, &identity)
        || ![record[@"width"] respondsToSelector:@selector(unsignedLongLongValue)]
        || ![record[@"height"] respondsToSelector:@selector(unsignedLongLongValue)]
        || ![record[@"stride"] respondsToSelector:@selector(unsignedLongLongValue)]
        || ![record[@"scale"] respondsToSelector:@selector(doubleValue)]) return nil;
    SPImageCaptureSource *source = [SPImageCaptureSource new];
    source.identity = identity;
    source.width = [record[@"width"] unsignedLongLongValue];
    source.height = [record[@"height"] unsignedLongLongValue];
    source.stride = [record[@"stride"] unsignedLongLongValue];
    source.screenBounds = CGRectMake([bounds[@"x"] doubleValue], [bounds[@"y"] doubleValue],
        [bounds[@"width"] doubleValue], [bounds[@"height"] doubleValue]);
    source.scale = [record[@"scale"] doubleValue];
    id color = record[@"colorSpace"];
    if ([color isKindOfClass:[NSString class]]) source.colorSpace = color;
    if (!source.width || !source.height || source.width > SIZE_MAX / 4 || source.stride < source.width * 4
        || source.height > SIZE_MAX / source.stride || !isfinite(source.scale)) {
        [source release];
        return nil;
    }
    return source;
}

static bool sameSourceMetadata(SPImageCaptureSource *left, SPImageCaptureSource *right) {
    NSString *leftColor = left.colorSpace ?: @"<null>";
    NSString *rightColor = right.colorSpace ?: @"<null>";
    return left.identity.generation == right.identity.generation && left.identity.raster == right.identity.raster
        && left.identity.sequence == right.identity.sequence && left.width == right.width && left.height == right.height
        && left.stride == right.stride && CGRectEqualToRect(left.screenBounds, right.screenBounds)
        && left.scale == right.scale && [leftColor isEqualToString:rightColor];
}

static NSDictionary *identityArtifactRecordFromPending(SPImageCaptureIdentityArtifact *artifact) {
    CGRect roi = artifact.roi;
    return @{ @"generation": [NSString stringWithFormat:@"%llu", (unsigned long long)artifact.identity.generation],
        @"raster": [NSString stringWithFormat:@"%llu", (unsigned long long)artifact.identity.raster],
        @"sequence": @(artifact.identity.sequence), @"regionToken": artifact.regionToken ?: @"",
        @"nonce": artifact.nonce ?: @"", @"payload": artifact.payload ?: @"",
        @"roi": @{ @"x": @(roi.origin.x), @"y": @(roi.origin.y),
            @"width": @(roi.size.width), @"height": @(roi.size.height) },
        @"file": (id)NSNull.null, @"width": @(artifact.width), @"height": @(artifact.height),
        @"stride": @(artifact.stride), @"pixelFormat": @"BGRA8", @"alpha": @"premultiplied-first",
        @"colorSpace": artifact.colorSpace ?: (id)NSNull.null,
        @"byteCount": @(artifact.pixels.length), @"sha256": (id)NSNull.null };
}

static bool identityRegionTokenBytes(NSString *regionKey, uint8_t token[16]) {
    if (regionKey.length != 32 || !token) return false;
    for (NSUInteger index = 0; index < 16; index++) {
        unichar high = [regionKey characterAtIndex:index * 2];
        unichar low = [regionKey characterAtIndex:index * 2 + 1];
        int highValue = high >= '0' && high <= '9' ? high - '0'
            : high >= 'a' && high <= 'f' ? high - 'a' + 10 : -1;
        int lowValue = low >= '0' && low <= '9' ? low - '0'
            : low >= 'a' && low <= 'f' ? low - 'a' + 10 : -1;
        if (highValue < 0 || lowValue < 0) return false;
        token[index] = (uint8_t)((highValue << 4) | lowValue);
    }
    return true;
}

static bool identityArtifactROI(NSDictionary *record, size_t width, size_t height, CGRect *roi) {
    NSDictionary *value = record[@"roi"];
    if (![value isKindOfClass:[NSDictionary class]]) return false;
    for (NSString *field in @[@"x", @"y", @"width", @"height"])
        if (![value[field] respondsToSelector:@selector(doubleValue)]) return false;
    CGRect parsed = CGRectMake([value[@"x"] doubleValue], [value[@"y"] doubleValue],
        [value[@"width"] doubleValue], [value[@"height"] doubleValue]);
    if (!validIdentityROI(parsed, width, height)) return false;
    *roi = parsed;
    return true;
}

static bool identityArtifactRecordValid(NSDictionary *record, NSString *regionKey,
    sp_image_capture_identity identity, SPImageCaptureSource *source, CGRect *sourceROI) {
    NSString *recordPayload = record[@"payload"];
    NSString *recordNonce = record[@"nonce"];
    if (![record[@"regionToken"] isKindOfClass:[NSString class]]
        || ![record[@"regionToken"] isEqualToString:regionKey]
        || ![recordPayload isKindOfClass:[NSString class]] || ![recordNonce isKindOfClass:[NSString class]]
        || !source || !identityArtifactROI(record, source.width, source.height, sourceROI)
        || [record[@"width"] unsignedLongLongValue] != source.width
        || [record[@"height"] unsignedLongLongValue] != source.height
        || [record[@"stride"] unsignedLongLongValue] != source.stride
        || ![record[@"pixelFormat"] isKindOfClass:[NSString class]]
        || ![record[@"pixelFormat"] isEqualToString:@"BGRA8"]
        || ![record[@"alpha"] isKindOfClass:[NSString class]]
        || ![record[@"alpha"] isEqualToString:@"premultiplied-first"]
        || source.height > SIZE_MAX / source.stride
        || [record[@"byteCount"] unsignedLongLongValue] != source.stride * source.height) return false;
    id recordColor = record[@"colorSpace"];
    NSString *color = [recordColor isKindOfClass:[NSString class]] ? recordColor : nil;
    if (![(source.colorSpace ?: @"<null>") isEqualToString:(color ?: @"<null>")]) return false;
    uint8_t regionToken[16];
    if (!identityRegionTokenBytes(regionKey, regionToken)) return false;
    NSString *expectedNonce = identityNonceLocked(regionToken);
    if (![recordNonce isEqualToString:expectedNonce]) return false;
    SPCaptureFrameIdentity payloadIdentity = { identity.generation, identity.raster, (uint64_t)identity.sequence };
    NSString *expectedPayload = nil, *payloadError = nil;
    bool payloadValid = sp_capture_frame_identity_payload(expectedNonce, payloadIdentity, &expectedPayload, &payloadError)
        && [expectedPayload isEqualToString:recordPayload];
    [expectedPayload release]; [payloadError release];
    return payloadValid;
}

static void addIdentityArtifactPairLocked(NSDictionary *record,
    NSMutableDictionary<NSString *, SPImageCaptureSource *> *sources,
    NSMutableDictionary<NSString *, NSMutableDictionary *> *groups,
    CGRect content_rect, CGRect screen_rect, double pixels_per_point, size_t frame_width, size_t frame_height,
    NSMutableSet<NSString *> *seenPairs, BOOL *coverageComplete) {
    NSString *sourceKey = identityRecordSourceKey(record);
    NSString *regionKey = record[@"regionToken"];
    NSString *payload = record[@"payload"];
    if (!sourceKey || ![regionKey isKindOfClass:[NSString class]] || ![payload isKindOfClass:[NSString class]]) {
        *coverageComplete = NO;
        return;
    }
    NSString *pairKey = identityArtifactKey(regionKey, sourceKey);
    if ([seenPairs containsObject:pairKey]) {
        *coverageComplete = NO;
        return;
    }
    [seenPairs addObject:pairKey];

    sp_image_capture_identity identity = {};
    if (!identityFromArtifactRecord(record, &identity)) {
        *coverageComplete = NO;
        return;
    }
    SPImageCaptureSource *source = sources[sourceKey];
    CGRect sourceROI = CGRectNull;
    BOOL hasSourceArtifact = artifactIdentityRecords[sourceKey] != nil || pendingArtifactSources[sourceKey] != nil;
    BOOL validPair = source && hasSourceArtifact && identityArtifactSignatures[pairKey] != nil
        && identityArtifactRecordValid(record, regionKey, identity, source, &sourceROI);
    if (!validPair) *coverageComplete = NO;

    NSString *issuedPayload = identityIssuedPayloads[regionKey][sourceKey];
    NSString *retiredPayload = identityRetiredPayloads[regionKey][sourceKey];
    if ((issuedPayload && ![issuedPayload isEqualToString:payload])
        || (retiredPayload && ![retiredPayload isEqualToString:payload])) {
        validPair = NO;
        *coverageComplete = NO;
    }
    BOOL retired = retiredPayload != nil;
    CGRect crop = CGRectNull;
    BOOL mapped = validPair && fabs(source.scale - pixels_per_point) <= 0.000001
        && mapSourceCrop(source, content_rect, screen_rect, pixels_per_point,
            frame_width, frame_height, &crop);
    CGRect roi = mapped ? CGRectMake(CGRectGetMinX(crop) + CGRectGetMinX(sourceROI),
        CGRectGetMinY(crop) + CGRectGetMinY(sourceROI), sourceROI.size.width, sourceROI.size.height) : CGRectNull;
    NSString *roiKey = mapped ? [NSString stringWithFormat:@"%.0f:%.0f:%.0f:%.0f",
        CGRectGetMinX(roi), CGRectGetMinY(roi), CGRectGetWidth(roi), CGRectGetHeight(roi)] : @"unknown";
    NSString *groupKey = [NSString stringWithFormat:@"%@:%@", regionKey, roiKey];
    NSMutableDictionary *group = groups[groupKey];
    if (!group) {
        group = [@{ @"region": regionKey, @"roi": [NSValue value:&roi withObjCType:@encode(CGRect)],
            @"payloads": [NSMutableSet set], @"sourceKeys": [NSMutableSet set],
            @"eligibleSourceKeys": [NSMutableSet set], @"retiredSourceKeys": [NSMutableSet set],
            @"mapped": @(mapped) } mutableCopy];
        groups[groupKey] = group;
        [group release];
    } else if ([group[@"mapped"] boolValue] != mapped) {
        *coverageComplete = NO;
    }
    [group[@"sourceKeys"] addObject:sourceKey];
    if (validPair) [group[@"payloads"] addObject:payload];
    if (validPair && retired) [group[@"retiredSourceKeys"] addObject:sourceKey];
    if (validPair && !retired) [group[@"eligibleSourceKeys"] addObject:sourceKey];
}

static void decodeIdentityJob(SPIdentityDecodeJob *job) {
    NSMutableArray<NSDictionary *> *records = nil;
    NSString *decodeFailure = nil;
    NSString *activeUnknownReason = nil;
    NSString *activeDecodeError = nil;
    @try {
        records = [NSMutableArray array];
        for (NSDictionary *group in job.groups) {
            NSString *region = group[@"region"];
            CGRect roi = CGRectNull;
            [group[@"roi"] getValue:&roi];
            BOOL mapped = [group[@"mapped"] boolValue];
            NSString *status = @"unknown";
            NSString *reason = nil;
            sp_image_capture_identity identity = {0};
            BOOL hasIdentity = NO;
            uint64_t decodeStarted = 0, decodeComplete = 0;
            BOOL decoderRan = NO;
            if (!mapped) {
                reason = @"unknown-geometry";
            } else if ([group[@"duplicate"] boolValue]) {
                reason = @"duplicate-roi";
            } else {
                NSData *pixels = group[@"pixels"];
                size_t width = (size_t)CGRectGetWidth(roi), height = (size_t)CGRectGetHeight(roi);
                if (!pixels || !width || width > SIZE_MAX / 4 || height > SIZE_MAX / (width * 4)
                    || pixels.length != width * height * 4) {
                    decodeFailure = [@"frame identity compact ROI byte dimensions are invalid" copy];
                    break;
                }
                SPCaptureFrameIdentity decoded = {};
                decodeStarted = mach_absolute_time();
                decoderRan = YES;
                BOOL decodedOK = sp_capture_frame_identity_decode(pixels.bytes, pixels.length,
                    width, height, width * 4, CGRectMake(0, 0, width, height), group[@"payloads"], &decoded,
                    &activeUnknownReason, &activeDecodeError);
                decodeComplete = mach_absolute_time();
                if (activeDecodeError) {
                    decodeFailure = [activeDecodeError copy];
                    [activeUnknownReason release]; activeUnknownReason = nil;
                    [activeDecodeError release]; activeDecodeError = nil;
                    break;
                }
                if (decodedOK) {
                    identity = (sp_image_capture_identity){ decoded.generation, decoded.raster, (int)decoded.sequence };
                    NSString *sourceKey = identitySourceKey(identity);
                    BOOL known = [group[@"sourceKeys"] containsObject:sourceKey];
                    BOOL retired = known && [group[@"retiredSourceKeys"] containsObject:sourceKey];
                    id finalIssuedValue = group[@"finalIssuedSlots"];
                    BOOL aboveFinalIssued = [finalIssuedValue isKindOfClass:NSNumber.class]
                        && decoded.sequence > [finalIssuedValue unsignedLongLongValue];
                    if (known && !retired && !aboveFinalIssued
                        && [group[@"eligibleSourceKeys"] containsObject:sourceKey]) {
                        status = @"matched";
                        hasIdentity = YES;
                    } else {
                        reason = retired ? @"unknown-retention" : @"unissued";
                    }
                } else {
                    reason = identityDecodeReason(activeUnknownReason);
                }
                [activeUnknownReason release]; activeUnknownReason = nil;
            }
            NSMutableDictionary *record = [identityDecodeRecord(job.frame, job.displayTime, region, roi,
                status, reason, identity, hasIdentity, group[@"sourceKind"]) mutableCopy];
            record[@"decodeEnqueuedTime"] = decoderRan
                ? [NSString stringWithFormat:@"%llu", (unsigned long long)job.enqueuedTime] : (id)NSNull.null;
            record[@"decodeStartTime"] = decoderRan
                ? [NSString stringWithFormat:@"%llu", (unsigned long long)decodeStarted] : (id)NSNull.null;
            record[@"decodeCompleteTime"] = decoderRan
                ? [NSString stringWithFormat:@"%llu", (unsigned long long)decodeComplete] : (id)NSNull.null;
            [records addObject:record];
            [record release];
        }
        if (!decodeFailure && job.groups.count == 0) {
            [records addObject:identityDecodeRecord(job.frame, job.displayTime, nil, CGRectNull,
                @"unknown", job.unknownReason ?: @"unknown-geometry", (sp_image_capture_identity){0}, NO, nil)];
        } else if (!decodeFailure && job.coverageMarker) {
            [records addObject:identityDecodeRecord(job.frame, job.displayTime, nil, CGRectNull,
                @"unknown", job.retentionMarker ? @"unknown-retention" : @"unknown-geometry",
                (sp_image_capture_identity){0}, NO, nil)];
        }
        if (!decodeFailure) {
            for (NSUInteger index = 0; index < records.count; index++) {
                NSDictionary *record = records[index];
                if (record[@"decodeEnqueuedTime"]) continue;
                NSMutableDictionary *recordWithNullTiming = [record mutableCopy];
                recordWithNullTiming[@"decodeEnqueuedTime"] = (id)NSNull.null;
                recordWithNullTiming[@"decodeStartTime"] = (id)NSNull.null;
                recordWithNullTiming[@"decodeCompleteTime"] = (id)NSNull.null;
                records[index] = recordWithNullTiming;
                [recordWithNullTiming release];
            }
        }
        NSArray *ownedRecords = decodeFailure ? nil : [records copy];
        job.decodedRecords = ownedRecords;
        [ownedRecords release];
        job.decodeFailure = decodeFailure;
        [decodeFailure release];
        decodeFailure = nil;
    } @catch (NSException *exception) { // silent: retain the exception as the explicit session failure reported by ordered commit.
        [decodeFailure release];
        decodeFailure = [[NSString alloc] initWithFormat:
            @"frame identity QR decoder raised %@: %@", exception.name,
            exception.reason ?: @"no reason"];
        job.decodedRecords = nil;
        job.decodeFailure = decodeFailure;
        [decodeFailure release];
        decodeFailure = nil;
    } @finally {
        [decodeFailure release];
        [activeUnknownReason release];
        [activeDecodeError release];
        job.groups = nil;
        initializeHistory();
        [historyLock lock];
        if (identityDecodePendingBytes < job.cropBytes) {
            if (!identitySessionFailure)
                identitySessionFailure = [@"frame identity decoder pending accounting became inconsistent" copy];
            atomic_store(&identitySessionEnabled, false);
        } else {
            identityDecodePendingBytes -= job.cropBytes;
        }
        [historyLock broadcast];
        [historyLock unlock];
    }
}

static void commitIdentityDecodeJob(SPIdentityDecodeJob *job, NSOperation *operation) {
    [operation waitUntilFinished];
    if (job.decodeFailure || !job.decodedRecords) {
        char *failure = NULL;
        const char *message = job.decodeFailure.UTF8String
            ?: "decoded frame identity records could not be queued";
        sp_image_capture_match_identity_session_fail(message, &failure);
        free(failure);
        finishIdentityDecodePendingJob();
        return;
    }
    char *error = NULL;
    BOOL appended = appendIdentityDecodeRecords(job.decodedRecords, job.frame, &error);
    if (!appended) {
        char *failure = NULL;
        sp_image_capture_match_identity_session_fail(error
            ?: "decoded frame identity records could not be appended", &failure);
        free(failure);
    }
    finishIdentityDecodePendingJob();
    free(error);
}

bool sp_image_capture_match_identity_enqueue_frame(const uint8_t *pixels, size_t frame_width, size_t frame_height,
    size_t frame_stride, CGColorSpaceRef color_space, CGRect content_rect, CGRect screen_rect,
    double content_scale, double scale_factor, uint64_t frame_number, uint64_t display_time, char **error) {
    if (error) *error = NULL;
    if (!pixels || !frame_width || !frame_height || frame_width > SIZE_MAX / 4 || frame_stride < frame_width * 4
        || frame_height > SIZE_MAX / frame_stride || !color_space || !frame_number || !error
        || !isfinite(content_scale) || !isfinite(scale_factor) || content_scale <= 0 || scale_factor <= 0)
        return identityFailure(error, "decoded frame identity sample or geometry is invalid");
    initializeHistory();
    NSString *sessionFailure = nil;
    NSMutableDictionary<NSString *, NSMutableDictionary *> *groups = [NSMutableDictionary dictionary];
    BOOL hadHistoryDrops = NO, onlyHistoryEvictions = NO, coverageComplete = YES;
    [historyLock lock];
    if (!identitySessionActive || identitySessionFailure || !identityDecodeAccepting
        || !identityDecodeQueue || !identityDecodeWorkerQueue) {
        sessionFailure = [identitySessionFailure copy];
        [historyLock unlock];
        BOOL failed = identityFailure(error, sessionFailure.UTF8String ?: "frame identity decoder is not accepting samples");
        [sessionFailure release];
        return failed;
    }
    if (identityDocumentFrame && identityDocumentCompleteSamples < SIZE_MAX) identityDocumentCompleteSamples++;
    hadHistoryDrops = historyDrops != 0;
    onlyHistoryEvictions = hadHistoryDrops && historyDrops == historyEvictions;
    coverageComplete = !hadHistoryDrops || onlyHistoryEvictions;
    if (artifactDrops || artifactWriteFailures || artifactCleanupFailures || identityArtifactDrops
        || identityArtifactWriteFailures || identityArtifactCleanupFailures || identityDecodedWriteFailures)
        coverageComplete = NO;
    double pixelsPerPoint = scale_factor / content_scale;
    NSMutableDictionary<NSString *, SPImageCaptureSource *> *sources = [NSMutableDictionary dictionary];
    for (SPImageCaptureSource *source in history) {
        NSString *sourceKey = identitySourceKey(source.identity);
        if (sourceKey) sources[sourceKey] = source;
    }
    for (NSString *sourceKey in pendingArtifactSources) {
        SPImageCaptureSource *source = pendingArtifactSources[sourceKey];
        SPImageCaptureSource *existing = sources[sourceKey];
        if (existing && !sameSourceMetadata(existing, source)) coverageComplete = NO;
        if (!existing) sources[sourceKey] = source;
    }
    for (NSString *sourceKey in artifactIdentityRecords) {
        SPImageCaptureSource *recorded = sourceFromArtifactRecord(artifactIdentityRecords[sourceKey]);
        if (!recorded) { coverageComplete = NO; continue; }
        SPImageCaptureSource *existing = sources[sourceKey];
        if (existing && !sameSourceMetadata(existing, recorded)) coverageComplete = NO;
        if (!existing) sources[sourceKey] = recorded;
        [recorded release];
    }
    NSMutableArray<NSDictionary *> *tagArtifacts = [NSMutableArray arrayWithArray:identityArtifactRecords];
    for (NSString *pairKey in pendingIdentityArtifacts)
        [tagArtifacts addObject:identityArtifactRecordFromPending(pendingIdentityArtifacts[pairKey])];
    if (tagArtifacts.count != identityArtifactSignatures.count) coverageComplete = NO;
    NSMutableSet<NSString *> *seenPairs = [NSMutableSet set];
    for (NSDictionary *tagArtifact in tagArtifacts)
        addIdentityArtifactPairLocked(tagArtifact, sources, groups, content_rect, screen_rect,
            pixelsPerPoint, frame_width, frame_height, seenPairs, &coverageComplete);

    NSDictionary *documentFrame = identityDocumentFrame;
    if (documentFrame) {
        NSDictionary *screenROI = documentFrame[@"screenROI"];
        CGRect bounds = CGRectMake([screenROI[@"x"] doubleValue], [screenROI[@"y"] doubleValue],
            [screenROI[@"width"] doubleValue], [screenROI[@"height"] doubleValue]);
        CGRect roi = CGRectNull;
        BOOL mapped = mapScreenROI(bounds, content_rect, screen_rect, pixelsPerPoint,
            frame_width, frame_height, &roi);
        NSString *region = documentFrame[@"region"];
        NSString *roiKey = mapped ? [NSString stringWithFormat:@"%.0f:%.0f:%.0f:%.0f",
            CGRectGetMinX(roi), CGRectGetMinY(roi), CGRectGetWidth(roi), CGRectGetHeight(roi)] : @"unknown";
        NSString *groupKey = [NSString stringWithFormat:@"document:%@:%@", region, roiKey];
        NSMutableDictionary *group = [@{
            @"region": region, @"roi": [NSValue value:&roi withObjCType:@encode(CGRect)],
            @"payloads": documentFrame[@"payloads"], @"sourceKeys": documentFrame[@"sourceKeys"],
            @"eligibleSourceKeys": documentFrame[@"sourceKeys"],
                @"finalIssuedSlots": documentFrame[@"issuedSlots"],
            @"retiredSourceKeys": [NSSet set], @"mapped": @(mapped), @"sourceKind": @"document",
        } mutableCopy];
        groups[groupKey] = group;
        [group release];
    }

    NSMutableSet<NSString *> *overlappingGroups = [NSMutableSet set];
    NSArray<NSString *> *keys = [[groups allKeys] sortedArrayUsingSelector:@selector(compare:)];
    for (NSUInteger left = 0; left < keys.count; left++) {
        NSMutableDictionary *leftGroup = groups[keys[left]];
        if (![leftGroup[@"mapped"] boolValue]) continue;
        CGRect leftROI = CGRectNull; [leftGroup[@"roi"] getValue:&leftROI];
        for (NSUInteger right = left + 1; right < keys.count; right++) {
            NSMutableDictionary *rightGroup = groups[keys[right]];
            if (![rightGroup[@"mapped"] boolValue]) continue;
            CGRect rightROI = CGRectNull; [rightGroup[@"roi"] getValue:&rightROI];
            if (CGRectIntersectsRect(leftROI, rightROI)) {
                [overlappingGroups addObject:keys[left]];
                [overlappingGroups addObject:keys[right]];
            }
        }
    }
    NSMutableArray<NSDictionary *> *snapshots = [NSMutableArray array];
    size_t cropBytes = 0;
    for (NSString *key in keys) {
        NSMutableDictionary *group = groups[key];
        CGRect roi = CGRectNull; [group[@"roi"] getValue:&roi];
        BOOL mapped = [group[@"mapped"] boolValue];
        NSMutableDictionary *snapshot = [@{
            @"region": group[@"region"], @"roi": [NSValue value:&roi withObjCType:@encode(CGRect)],
            @"mapped": @(mapped), @"duplicate": @([overlappingGroups containsObject:key]),
            @"payloads": [NSSet setWithSet:group[@"payloads"]],
            @"sourceKeys": [NSSet setWithSet:group[@"sourceKeys"]],
            @"eligibleSourceKeys": [NSSet setWithSet:group[@"eligibleSourceKeys"]],
            @"finalIssuedSlots": group[@"finalIssuedSlots"] ?: (id)NSNull.null,
            @"retiredSourceKeys": [NSSet setWithSet:group[@"retiredSourceKeys"]],
            @"sourceKind": group[@"sourceKind"] ?: @"image",
        } mutableCopy];
        if (mapped && ![overlappingGroups containsObject:key]) {
            size_t roiWidth = (size_t)CGRectGetWidth(roi), roiHeight = (size_t)CGRectGetHeight(roi);
            if (roiWidth > SIZE_MAX / 4 || roiHeight > SIZE_MAX / (roiWidth * 4)
                || CGRectGetMinX(roi) < 0 || CGRectGetMinY(roi) < 0
                || CGRectGetMaxX(roi) > frame_width || CGRectGetMaxY(roi) > frame_height) {
                [snapshot release];
                [historyLock unlock];
                return identityEnqueueFailure(error, "frame identity mapped ROI is outside the sample raster");
            }
            size_t bytes = roiWidth * roiHeight * 4;
            BOOL byteLimitExceeded = bytes > kImageCaptureArtifactPendingLimit
                || artifactPendingBytes > kImageCaptureArtifactPendingLimit - bytes
                || identityDecodePendingBytes > kImageCaptureArtifactPendingLimit - artifactPendingBytes - bytes
                || cropBytes > kImageCaptureArtifactPendingLimit - artifactPendingBytes
                    - identityDecodePendingBytes - bytes;
            if (byteLimitExceeded) {
                NSString *capacityError = identityCapacityMessage(@"roi-copy", frame_number,
                    identityDecodePendingJobs, identityDecodePendingBytes, cropBytes + bytes,
                    artifactPendingBytes, NO, YES);
                if (!identitySessionFailure) identitySessionFailure = [capacityError copy];
                atomic_store(&identitySessionEnabled, false);
                [snapshot release];
                [historyLock unlock];
                return identityFailure(error, capacityError.UTF8String);
            }
            NSMutableData *crop = [[NSMutableData alloc] initWithLength:bytes];
            if (!crop) {
                [snapshot release]; [historyLock unlock];
                return identityEnqueueFailure(error, "frame identity compact ROI allocation failed");
            }
            for (size_t row = 0; row < roiHeight; row++) {
                const uint8_t *source = pixels + ((size_t)CGRectGetMinY(roi) + row) * frame_stride
                    + (size_t)CGRectGetMinX(roi) * 4;
                memcpy((uint8_t *)crop.mutableBytes + row * roiWidth * 4, source, roiWidth * 4);
            }
            NSData *ownedCrop = [crop copy]; [crop release];
            snapshot[@"pixels"] = ownedCrop;
            [ownedCrop release];
            if (cropBytes > SIZE_MAX - bytes) {
                [snapshot release]; [historyLock unlock];
                return identityEnqueueFailure(error, "frame identity ROI byte count overflowed");
            }
            cropBytes += bytes;
        }
        [snapshots addObject:snapshot];
        [snapshot release];
    }
    NSString *unknownReason = snapshots.count == 0 ? (hadHistoryDrops ? @"unknown-retention" : @"unknown-geometry") : nil;
    BOOL coverageMarker = snapshots.count != 0 && !coverageComplete;
    BOOL retentionMarker = hadHistoryDrops && (!onlyHistoryEvictions || !coverageComplete);
    uint64_t now = mach_absolute_time();
    SPIdentityDecodeJob *job = [SPIdentityDecodeJob new];
    if (!job) {
        [historyLock unlock];
        return identityEnqueueFailure(error, "frame identity decode job allocation failed");
    }
    job.frame = frame_number;
    job.displayTime = display_time;
    job.enqueuedTime = now;
    job.groups = snapshots;
    job.unknownReason = unknownReason;
    job.coverageMarker = coverageMarker;
    job.retentionMarker = retentionMarker;
    job.cropBytes = cropBytes;
    BOOL jobLimitExceeded = identityDecodePendingJobs >= kIdentityDecodePendingJobLimit;
    BOOL byteLimitExceeded = cropBytes > kImageCaptureArtifactPendingLimit
        || artifactPendingBytes > kImageCaptureArtifactPendingLimit - cropBytes
        || identityDecodePendingBytes > kImageCaptureArtifactPendingLimit - artifactPendingBytes - cropBytes;
    if (!identityDecodeAccepting || jobLimitExceeded || byteLimitExceeded) {
        if (!identityDecodeAccepting) {
            [historyLock unlock];
            [job release];
            return identityFailure(error, "frame identity decoder intake is closed");
        }
        NSString *capacityError = identityCapacityMessage(@"job-admission", frame_number,
            identityDecodePendingJobs, identityDecodePendingBytes, cropBytes, artifactPendingBytes,
            jobLimitExceeded, byteLimitExceeded);
        if (!identitySessionFailure) identitySessionFailure = [capacityError copy];
        atomic_store(&identitySessionEnabled, false);
        [historyLock unlock];
        [job release];
        return identityFailure(error, capacityError.UTF8String);
    }
    identityDecodePendingJobs++;
    identityDecodePendingBytes += cropBytes;
    NSBlockOperation *operation = [[NSBlockOperation alloc] init];
    if (!operation) {
        identityDecodePendingJobs--;
        identityDecodePendingBytes -= cropBytes;
        [historyLock unlock];
        [job release];
        return identityEnqueueFailure(error, "frame identity decoder operation allocation failed");
    }
    [operation addExecutionBlock:^{ @autoreleasepool { decodeIdentityJob(job); } }];
    [identityDecodeWorkerQueue addOperation:operation];
    dispatch_async(identityDecodeQueue, ^{
        @autoreleasepool { commitIdentityDecodeJob(job, operation); }
    });
    [operation release];
    [historyLock unlock];
    [job release];
    return YES;
}

const char *sp_image_capture_match_state_name(sp_image_capture_match_state state) {
    switch (state) {
        case SP_IMAGE_CAPTURE_MATCHED: return "matched";
        case SP_IMAGE_CAPTURE_AMBIGUOUS: return "ambiguous";
        case SP_IMAGE_CAPTURE_UNMATCHED: return "unmatched";
        case SP_IMAGE_CAPTURE_UNKNOWN_GEOMETRY: return "unknown-geometry";
        case SP_IMAGE_CAPTURE_UNKNOWN_SCALE: return "unknown-scale";
        case SP_IMAGE_CAPTURE_UNKNOWN_COLOR: return "unknown-color";
        case SP_IMAGE_CAPTURE_UNKNOWN_RETENTION: return "unknown-retention";
    }
    return "unknown-state";
}

sp_image_capture_match_result sp_image_capture_match_sample(const uint8_t *pixels,
    size_t frame_width, size_t frame_height, size_t frame_stride, CGRect content_rect, CGRect screen_rect,
    double content_scale, double scale_factor, const char *color_space, uint64_t display_time) {
    initializeHistory();
    sp_image_capture_match_result result = { .state = SP_IMAGE_CAPTURE_UNKNOWN_GEOMETRY,
        .display_time = display_time };
    if (!pixels || !frame_width || !frame_height || frame_width > SIZE_MAX / 4
        || frame_stride < frame_width * 4 || !frame_stride || frame_height > SIZE_MAX / frame_stride
        || !isfinite(content_scale) || !isfinite(scale_factor) || content_scale <= 0 || scale_factor <= 0
        || !isfinite(content_rect.origin.x) || !isfinite(content_rect.origin.y)
        || !isfinite(content_rect.size.width) || !isfinite(content_rect.size.height)
        || !isfinite(screen_rect.origin.x) || !isfinite(screen_rect.origin.y)
        || !isfinite(screen_rect.size.width) || !isfinite(screen_rect.size.height)
        || content_rect.size.width <= 0 || content_rect.size.height <= 0
        || screen_rect.size.width <= 0 || screen_rect.size.height <= 0) return result;

    [historyLock lock];
    result.dropped_snapshots = historyDrops;
    if (!atomic_load(&historyEnabled) || history.count == 0) {
        result.state = SP_IMAGE_CAPTURE_UNKNOWN_RETENTION;
        [historyLock unlock];
        return result;
    }
    latestSourceFacts(&result, history.lastObject);
    double pixelsPerPoint = scale_factor / content_scale;
    NSString *capturedColor = color_space ? [NSString stringWithUTF8String:color_space] : nil;
    BOOL sawBounds = NO, sawScale = NO, sawColor = NO, sawCrop = NO;
    NSMutableArray<NSValue *> *matches = [NSMutableArray array];
    for (SPImageCaptureSource *source in history) {
        CGRect bounds = source.screenBounds;
        if (CGRectIsEmpty(bounds) || CGRectIsNull(bounds)
            || CGRectGetMinX(bounds) < CGRectGetMinX(screen_rect)
            || CGRectGetMaxX(bounds) > CGRectGetMaxX(screen_rect)
            || CGRectGetMinY(bounds) < CGRectGetMinY(screen_rect)
            || CGRectGetMaxY(bounds) > CGRectGetMaxY(screen_rect)) continue;
        sawBounds = YES;
        if (fabs(source.scale - pixelsPerPoint) > 0.000001) continue;
        sawScale = YES;
        CGRect crop = CGRectZero;
        if (!mapSourceCrop(source, content_rect, screen_rect, pixelsPerPoint, frame_width, frame_height, &crop)) continue;
        sawCrop = YES;
        if (source == history.lastObject) {
            result.has_latest_crop = true;
            result.latest_crop = crop;
        }
        if (!source.colorSpace || !capturedColor || ![source.colorSpace isEqualToString:capturedColor]) continue;
        sawColor = YES;
        const uint8_t *crop_pixels = pixels + (size_t)CGRectGetMinY(crop) * frame_stride + (size_t)CGRectGetMinX(crop) * 4;
        if (!equalPixels(source, crop_pixels, source.width, source.height, frame_stride)) continue;
        sp_image_capture_identity identity = source.identity;
        [matches addObject:[NSValue valueWithBytes:&identity objCType:@encode(sp_image_capture_identity)]];
    }
    if (matches.count) {
        result.candidate_count = matches.count;
        result.candidates = calloc(matches.count, sizeof(*result.candidates));
        if (!result.candidates) {
            result.candidate_count = 0;
            result.state = SP_IMAGE_CAPTURE_UNKNOWN_RETENTION;
        } else {
            for (NSUInteger index = 0; index < matches.count; index++)
                [matches[index] getValue:&result.candidates[index]];
            result.state = result.dropped_snapshots ? SP_IMAGE_CAPTURE_UNKNOWN_RETENTION
                : matches.count == 1 ? SP_IMAGE_CAPTURE_MATCHED : SP_IMAGE_CAPTURE_AMBIGUOUS;
        }
    } else if (sawColor) {
        for (SPImageCaptureSource *source in [history reverseObjectEnumerator]) {
            CGRect crop = CGRectZero;
            if (CGRectIsEmpty(source.screenBounds) || CGRectIsNull(source.screenBounds)
                || CGRectGetMinX(source.screenBounds) < CGRectGetMinX(screen_rect)
                || CGRectGetMaxX(source.screenBounds) > CGRectGetMaxX(screen_rect)
                || CGRectGetMinY(source.screenBounds) < CGRectGetMinY(screen_rect)
                || CGRectGetMaxY(source.screenBounds) > CGRectGetMaxY(screen_rect)
                || fabs(source.scale - pixelsPerPoint) > 0.000001
                || !mapSourceCrop(source, content_rect, screen_rect, pixelsPerPoint, frame_width, frame_height, &crop)
                || !source.colorSpace || !capturedColor || ![source.colorSpace isEqualToString:capturedColor]) continue;
            const uint8_t *crop_pixels = pixels + (size_t)CGRectGetMinY(crop) * frame_stride + (size_t)CGRectGetMinX(crop) * 4;
            pixelDifference(source, crop_pixels, frame_stride, &result);
            if (result.has_pixel_difference) break;
        }
        result.state = result.dropped_snapshots ? SP_IMAGE_CAPTURE_UNKNOWN_RETENTION : SP_IMAGE_CAPTURE_UNMATCHED;
    } else if (!sawBounds) result.state = result.dropped_snapshots ? SP_IMAGE_CAPTURE_UNKNOWN_RETENTION : SP_IMAGE_CAPTURE_UNKNOWN_GEOMETRY;
    else if (!sawScale) result.state = SP_IMAGE_CAPTURE_UNKNOWN_SCALE;
    else if (!sawColor) result.state = SP_IMAGE_CAPTURE_UNKNOWN_COLOR;
    else if (!sawCrop) result.state = SP_IMAGE_CAPTURE_UNKNOWN_GEOMETRY;
    else result.state = SP_IMAGE_CAPTURE_UNMATCHED;
    [historyLock unlock];
    return result;
}

void sp_image_capture_match_result_dispose(sp_image_capture_match_result *result) {
    if (!result) return;
    free(result->candidates);
    result->candidates = NULL;
    result->candidate_count = 0;
}

static bool identityFailure(char **error, const char *message) {
    if (error) *error = strdup(message);
    return false;
}

static bool identityEnqueueFailure(char **error, const char *message) {
    identityFailure(error, message);
    char *sessionError = NULL;
    sp_image_capture_match_identity_session_fail(message, &sessionError);
    free(sessionError);
    return false;
}

static NSString *identityRegionKey(const uint8_t token[16]) {
    if (!token) return nil;
    NSMutableString *key = [NSMutableString stringWithCapacity:32];
    for (NSUInteger index = 0; index < 16; index++) [key appendFormat:@"%02x", token[index]];
    return key;
}

static NSString *identitySourceKey(sp_image_capture_identity identity) {
    if (!identity.generation || !identity.raster || identity.sequence <= 0) return nil;
    return [NSString stringWithFormat:@"%llu-%llu-%d", (unsigned long long)identity.generation,
        (unsigned long long)identity.raster, identity.sequence];
}

static void identityForgetRetiredLocked(NSString *regionKey, NSString *sourceKey) {
    NSMutableDictionary *payloads = identityRetiredPayloads[regionKey];
    if (!payloads[sourceKey]) return;
    [payloads removeObjectForKey:sourceKey];
    if (!payloads.count) [identityRetiredPayloads removeObjectForKey:regionKey];
    NSMutableSet *regions = identityRetiredRegionsBySource[sourceKey];
    [regions removeObject:regionKey];
    if (!regions.count) [identityRetiredRegionsBySource removeObjectForKey:sourceKey];
    NSString *orderKey = [NSString stringWithFormat:@"%@/%@", regionKey, sourceKey];
    NSUInteger index = [identityRetiredOrder indexOfObject:orderKey];
    if (index != NSNotFound) [identityRetiredOrder removeObjectAtIndex:index];
    identityRetiredCount--;
}

static void identityRememberRetiredLocked(NSString *regionKey, NSString *sourceKey, NSString *payload) {
    if (!payload) return;
    if (identityRetiredPayloads[regionKey][sourceKey]) identityForgetRetiredLocked(regionKey, sourceKey);
    NSMutableDictionary *payloads = identityRetiredPayloads[regionKey];
    if (!payloads) identityRetiredPayloads[regionKey] = payloads = [NSMutableDictionary dictionary];
    payloads[sourceKey] = payload;
    NSMutableSet *regions = identityRetiredRegionsBySource[sourceKey];
    if (!regions) identityRetiredRegionsBySource[sourceKey] = regions = [NSMutableSet set];
    [regions addObject:regionKey];
    [identityRetiredOrder addObject:[NSString stringWithFormat:@"%@/%@", regionKey, sourceKey]];
    identityRetiredCount++;
    while (identityRetiredCount > kImageCaptureHistoryCountLimit) {
        NSString *oldest = [[identityRetiredOrder.firstObject copy] autorelease];
        [identityRetiredOrder removeObjectAtIndex:0];
        NSRange separator = [oldest rangeOfString:@"/"];
        if (separator.location == NSNotFound) continue;
        NSString *oldRegion = [oldest substringToIndex:separator.location];
        NSString *oldSource = [oldest substringFromIndex:NSMaxRange(separator)];
        if (identityRetiredPayloads[oldRegion][oldSource]) {
            if (identityArtifactSignatures[identityArtifactKey(oldRegion, oldSource)]) {
                if (!identitySessionFailure)
                    identitySessionFailure = [@"frame identity retired artifact disposition capacity was exceeded" copy];
                atomic_store(&identitySessionEnabled, false);
            }
            NSMutableDictionary *oldPayloads = identityRetiredPayloads[oldRegion];
            [oldPayloads removeObjectForKey:oldSource];
            if (!oldPayloads.count) [identityRetiredPayloads removeObjectForKey:oldRegion];
            NSMutableSet *oldRegions = identityRetiredRegionsBySource[oldSource];
            [oldRegions removeObject:oldRegion];
            if (!oldRegions.count) [identityRetiredRegionsBySource removeObjectForKey:oldSource];
            identityRetiredCount--;
        }
    }
}

static void identityEvictSourceLocked(sp_image_capture_identity identity) {
    NSString *sourceKey = identitySourceKey(identity);
    NSSet<NSString *> *regions = [identityRegionsBySource[sourceKey] copy];
    for (NSString *regionKey in regions) {
        NSMutableDictionary *issued = identityIssuedPayloads[regionKey];
        if (issued[sourceKey]) {
            [issued removeObjectForKey:sourceKey];
            identityIssuedCount--;
            if (!issued.count) [identityIssuedPayloads removeObjectForKey:regionKey];
        }
    }
    [regions release];
    [identityRegionsBySource removeObjectForKey:sourceKey];
}

static NSString *identityNonceLocked(const uint8_t token[16]) {
    uint8_t input[48];
    memcpy(input, identityCaptureNonce.bytes, 32);
    memcpy(input + 32, token, 16);
    uint8_t digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(input, (CC_LONG)sizeof(input), digest);
    NSMutableString *hex = [NSMutableString stringWithCapacity:32];
    for (NSUInteger index = 0; index < 16; index++) [hex appendFormat:@"%02x", digest[index]];
    return [[hex copy] autorelease];
}

bool sp_image_capture_match_identity_session_begin(char **error) {
    if (error) *error = NULL;
    if (!error) return false;
    initializeHistory();
    [historyLock lock];
    if (!atomic_load(&historyEnabled)) {
        [historyLock unlock];
        return identityFailure(error, "frame identity session requires active diagnostic matching");
    }
    if (identitySessionActive) {
        [historyLock unlock];
        return identityFailure(error, "frame identity session is already active");
    }
    NSMutableData *nonce = [[NSMutableData alloc] initWithLength:32];
    if (!nonce) {
        [historyLock unlock];
        return identityFailure(error, "frame identity capture nonce allocation failed");
    }
    arc4random_buf(nonce.mutableBytes, nonce.length);
    identityCaptureNonce = nonce;
    identitySessionActive = true;
    identitySessionStarted = true;
    identityDecodeQueue = dispatch_queue_create("sp.capture.identity-decoder", DISPATCH_QUEUE_SERIAL);
    identityDecodeWorkerQueue = [[NSOperationQueue alloc] init];
    [identityDecodeWorkerQueue setMaxConcurrentOperationCount:2];
    if (!identityDecodeQueue || !identityDecodeWorkerQueue) {
        if (identityDecodeQueue) dispatch_release(identityDecodeQueue);
        identityDecodeQueue = NULL;
        [identityDecodeWorkerQueue release];
        identityDecodeWorkerQueue = nil;
        clearIdentitySessionLocked();
        [historyLock unlock];
        return identityFailure(error, "frame identity decoder queues could not be created");
    }
    identityDecodePendingJobs = 0;
    identityDecodePendingBytes = 0;
    identityDecodeAccepting = YES;
    atomic_store(&identitySessionEnabled, true);
    [historyLock unlock];
    return true;
}

bool sp_image_capture_match_identity_prepare_decoder(char **error) {
    if (error) *error = NULL;
    if (!error) return false;
    uint8_t region[16];
    arc4random_buf(region, sizeof(region));
    const sp_image_capture_identity expected = { 1, 1, 1 };
    NSString *nonce = nil, *payload = nil, *encodeError = nil;
    char *identityError = NULL;
    if (!sp_image_capture_match_identity_region_nonce(region, &nonce, &identityError)
        || !sp_image_capture_match_identity_issue(region, expected, &payload, &identityError)) {
        NSString *reason = [NSString stringWithUTF8String:identityError ?: "identity readiness tuple could not be issued"];
        free(identityError); [nonce release]; [payload release];
        return identityFailure(error, reason.UTF8String);
    }
    const size_t width = 256, height = 256, stride = width * 4;
    NSMutableData *pixels = [[NSMutableData alloc] initWithLength:stride * height];
    CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
    CGImageRef image = NULL;
    NSData *taggedPixels = nil;
    NSString *encodedPayload = nil;
    CGRect roi = CGRectMake(width - 192, 0, 192, 192);
    BOOL encoded = pixels && colorSpace && sp_capture_frame_identity_encode(pixels.bytes, width, height,
        stride, colorSpace, roi, nonce,
        (SPCaptureFrameIdentity){ expected.generation, expected.raster, (uint64_t)expected.sequence },
        &image, &taggedPixels, &encodedPayload, &encodeError);
    SPCaptureFrameIdentity decoded = {};
    NSString *unknownReason = nil, *decodeError = nil;
    BOOL ready = encoded && sp_capture_frame_identity_decode(taggedPixels.bytes, taggedPixels.length,
        width, height, stride, roi, [NSSet setWithObject:payload],
        &decoded, &unknownReason, &decodeError)
        && decoded.generation == expected.generation && decoded.raster == expected.raster
        && decoded.sequence == (uint64_t)expected.sequence;
    if (!ready) {
        NSString *reason = decodeError ?: encodeError ?: unknownReason ?: @"QR decoder readiness returned a different identity";
        identityFailure(error, [[NSString stringWithFormat:@"frame identity QR decoder readiness failed: %@", reason] UTF8String]);
    }
    if (image) CGImageRelease(image);
    if (colorSpace) CGColorSpaceRelease(colorSpace);
    [pixels release]; [taggedPixels release]; [encodedPayload release]; [encodeError release];
    [unknownReason release]; [decodeError release];
    [nonce release]; [payload release];
    char *evictError = NULL;
    BOOL evicted = sp_image_capture_match_identity_evict(region, expected, &evictError);
    if (!evicted && ready) {
        identityFailure(error, evictError ?: "frame identity readiness payload cleanup failed");
        ready = NO;
    }
    free(evictError);
    return ready;
}

bool sp_image_capture_match_identity_region_nonce(const uint8_t region_token[16], NSString **nonce, char **error) {
    if (nonce) *nonce = nil;
    if (error) *error = NULL;
    if (!nonce || !error || !region_token) return identityFailure(error, "frame identity region token or output is invalid");
    initializeHistory();
    [historyLock lock];
    if (!identitySessionActive || identitySessionFailure) {
        NSString *reason = [identitySessionFailure copy];
        [historyLock unlock];
        bool failed = identityFailure(error, reason.UTF8String ?: "frame identity session is not active");
        [reason release];
        return failed;
    }
    *nonce = [identityNonceLocked(region_token) copy];
    [historyLock unlock];
    if (!*nonce) return identityFailure(error, "frame identity region nonce allocation failed");
    return true;
}

bool sp_image_capture_match_identity_issue(const uint8_t region_token[16], sp_image_capture_identity identity,
    NSString **payload, char **error) {
    if (payload) *payload = nil;
    if (error) *error = NULL;
    if (!payload || !error || !region_token) return identityFailure(error, "frame identity region token or output is invalid");
    NSString *sourceKey = identitySourceKey(identity);
    if (!sourceKey) return identityFailure(error, "frame identity source identity is invalid");
    initializeHistory();
    NSString *regionKey = identityRegionKey(region_token);
    [historyLock lock];
    if (!identitySessionActive || identitySessionFailure) {
        NSString *reason = [identitySessionFailure copy];
        [historyLock unlock];
        bool failed = identityFailure(error, reason.UTF8String ?: "frame identity session is not active");
        [reason release];
        return failed;
    }
    NSMutableDictionary *issued = identityIssuedPayloads[regionKey];
    NSString *existing = issued[sourceKey];
    if (existing) {
        *payload = [existing copy];
        [historyLock unlock];
        if (!*payload) return identityFailure(error, "frame identity payload allocation failed");
        return true;
    }
    if (identityIssuedCount >= kImageCaptureHistoryCountLimit) {
        [historyLock unlock];
        return identityFailure(error, "frame identity issued payload limit reached");
    }
    NSString *nonce = identityNonceLocked(region_token);
    SPCaptureFrameIdentity frameIdentity = { identity.generation, identity.raster, (uint64_t)identity.sequence };
    NSString *created = nil, *payloadError = nil;
    if (!sp_capture_frame_identity_payload(nonce, frameIdentity, &created, &payloadError)) {
        const char *message = payloadError.UTF8String ?: "frame identity payload generation failed";
        bool failed = identityFailure(error, message);
        [payloadError release];
        [historyLock unlock];
        return failed;
    }
    NSString *returnedPayload = [created copy];
    if (!returnedPayload) {
        [created release];
        [historyLock unlock];
        return identityFailure(error, "frame identity payload allocation failed");
    }
    if (!issued) {
        issued = [NSMutableDictionary new];
        identityIssuedPayloads[regionKey] = issued;
        [issued release];
    }
    issued[sourceKey] = created;
    identityIssuedCount++;
    NSMutableSet<NSString *> *regions = identityRegionsBySource[sourceKey];
    if (!regions) {
        regions = [NSMutableSet new];
        identityRegionsBySource[sourceKey] = regions;
        [regions release];
    }
    [regions addObject:regionKey];
    *payload = returnedPayload;
    [created release];
    [historyLock unlock];
    return true;
}

bool sp_image_capture_match_identity_document_begin(const uint8_t region_token[16], uint64_t generation,
    CGRect screen_roi, NSUInteger atlas_slots, NSArray<NSString *> **payloads, NSData **session_nonce, char **error) {
    if (payloads) *payloads = nil;
    if (session_nonce) *session_nonce = nil;
    if (error) *error = NULL;
    if (!region_token || !generation || !atlas_slots || atlas_slots > kImageCaptureHistoryCountLimit
        || !payloads || !session_nonce || !error || !isfinite(screen_roi.origin.x) || !isfinite(screen_roi.origin.y)
        || !isfinite(screen_roi.size.width) || !isfinite(screen_roi.size.height)
        || screen_roi.size.width <= 0 || screen_roi.size.height <= 0) {
        return identityFailure(error, "document frame identity source arguments are invalid");
    }
    initializeHistory();
    [historyLock lock];
    BOOL available = identitySessionActive && !identitySessionFailure && !identityDocumentFrame;
    NSString *sessionFailure = [identitySessionFailure copy];
    NSData *sessionNonce = available ? [identityCaptureNonce copy] : nil;
    [historyLock unlock];
    if (!available) {
        bool failed = identityFailure(error, sessionFailure.UTF8String
            ?: "document frame identity requires one active frame identity capture");
        [sessionFailure release];
        return failed;
    }
    [sessionFailure release];
    if (!sessionNonce) return identityFailure(error, "document frame identity capture nonce is unavailable");

    NSString *region = identityRegionKey(region_token);
    NSString *nonce = nil;
    [historyLock lock];
    if (identitySessionActive && [identityCaptureNonce isEqualToData:sessionNonce])
        nonce = [identityNonceLocked(region_token) copy];
    [historyLock unlock];
    if (!nonce) {
        [sessionNonce release];
        return identityFailure(error, "document frame identity capture session changed before registration");
    }
    NSMutableArray<NSString *> *issuedPayloads = [NSMutableArray arrayWithCapacity:atlas_slots];
    NSMutableSet<NSString *> *sourceKeys = [NSMutableSet setWithCapacity:atlas_slots];
    NSMutableArray<NSDictionary *> *sourceIdentities = [NSMutableArray arrayWithCapacity:atlas_slots];
    for (NSUInteger index = 0; index < atlas_slots; index++) {
        if (index >= INT_MAX) {
            [nonce release];
            [sessionNonce release];
            return identityFailure(error, "document frame identity atlas sequence exceeds its bound");
        }
        sp_image_capture_identity identity = { generation, UINT64_MAX, (int)index + 1 };
        SPCaptureFrameIdentity frameIdentity = { generation, UINT64_MAX, (uint64_t)identity.sequence };
        NSString *payload = nil, *payloadError = nil;
        if (!sp_capture_frame_identity_payload(nonce, frameIdentity, &payload, &payloadError)) {
            const char *message = payloadError.UTF8String ?: "document frame identity payload generation failed";
            BOOL failed = identityFailure(error, message);
            [payloadError release];
            [nonce release];
            [sessionNonce release];
            return failed;
        }
        NSString *sourceKey = identitySourceKey(identity);
        if (!sourceKey || !payload) {
            [payload release];
            [nonce release];
            [sessionNonce release];
            return identityFailure(error, "document frame identity atlas payload is invalid");
        }
        [issuedPayloads addObject:payload];
        [sourceKeys addObject:sourceKey];
        [sourceIdentities addObject:@{
            @"generation": [NSString stringWithFormat:@"%llu", (unsigned long long)identity.generation],
            @"raster": [NSString stringWithFormat:@"%llu", (unsigned long long)identity.raster],
            @"sequence": @(identity.sequence), @"payload": payload,
        }];
        [payload release];
    }
    [nonce release];
    NSDictionary *screenROI = @{
        @"x": @(CGRectGetMinX(screen_roi)), @"y": @(CGRectGetMinY(screen_roi)),
        @"width": @(CGRectGetWidth(screen_roi)), @"height": @(CGRectGetHeight(screen_roi)),
    };
    NSDictionary *state = @{
        @"region": region, @"generation": [NSString stringWithFormat:@"%llu", (unsigned long long)generation],
        @"raster": [NSString stringWithFormat:@"%llu", (unsigned long long)UINT64_MAX],
        @"screenROI": screenROI, @"atlasSlots": @(atlas_slots),
        @"issuedSlots": [NSNull null], @"sourceIdentities": sourceIdentities,
        @"payloads": [NSSet setWithArray:issuedPayloads], @"sourceKeys": sourceKeys,
    };
    [historyLock lock];
    if (!identitySessionActive || identitySessionFailure || identityDocumentFrame
        || ![identityCaptureNonce isEqualToData:sessionNonce]) {
        [historyLock unlock];
        [sessionNonce release];
        return identityFailure(error, "document frame identity registration lost its capture session");
    }
    NSArray *returnedPayloads = [issuedPayloads copy];
    NSData *returnedSessionNonce = [sessionNonce copy];
    if (!returnedPayloads || !returnedSessionNonce) {
        [returnedPayloads release];
        [returnedSessionNonce release];
        [historyLock unlock];
        [sessionNonce release];
        return identityFailure(error, "document frame identity registration outputs could not be allocated");
    }
    identityDocumentFrame = [state copy];
    *payloads = returnedPayloads;
    *session_nonce = returnedSessionNonce;
    [historyLock unlock];
    [sessionNonce release];
    return true;
}

bool sp_image_capture_match_identity_document_finish(NSData *session_nonce, NSData *atlas_png,
    NSUInteger issued_slots, char **error) {
    if (error) *error = NULL;
    if (!error || !session_nonce.length || !atlas_png || !atlas_png.length) {
        return identityFailure(error, "document frame identity session nonce, final atlas, or error output is invalid");
    }
    initializeHistory();
    [historyLock lock];
    NSDictionary *state = identityDocumentFrame;
    NSUInteger atlas_slots = [state[@"atlasSlots"] unsignedIntegerValue];
    if (!identitySessionActive || ![identityCaptureNonce isEqualToData:session_nonce] || !state || issued_slots > atlas_slots
        || identityDocumentMaxMatchedSequence > issued_slots) {
        if (identitySessionActive && [identityCaptureNonce isEqualToData:session_nonce]
            && state && identityDocumentMaxMatchedSequence > issued_slots && !identitySessionFailure) {
            identitySessionFailure = [@"document frame identity matched a sequence above its final issued count" copy];
            atomic_store(&identitySessionEnabled, false);
        }
        [historyLock unlock];
        return identityFailure(error, "document frame identity final count does not match observed source identities");
    }
    NSMutableDictionary *finished = [state mutableCopy];
    finished[@"issuedSlots"] = @(issued_slots);
    NSData *ownedAtlas = [atlas_png copy];
    finished[@"atlasPNG"] = ownedAtlas;
    [ownedAtlas release];
    [identityDocumentFrame release];
    identityDocumentFrame = [finished copy];
    [finished release];
    [historyLock unlock];
    return true;
}

bool sp_image_capture_match_identity_evict(const uint8_t region_token[16], sp_image_capture_identity identity,
    char **error) {
    if (error) *error = NULL;
    if (!error || !region_token) return identityFailure(error, "frame identity region token or error output is invalid");
    NSString *sourceKey = identitySourceKey(identity);
    if (!sourceKey) return identityFailure(error, "frame identity source identity is invalid");
    initializeHistory();
    NSString *regionKey = identityRegionKey(region_token);
    [historyLock lock];
    if (!identitySessionActive) {
        [historyLock unlock];
        return identityFailure(error, "frame identity session is not active");
    }
    NSMutableDictionary *issued = identityIssuedPayloads[regionKey];
    NSString *payload = issued[sourceKey] ?: identityArtifactPayloadLocked(regionKey, sourceKey);
    if (payload) {
        identityRememberRetiredLocked(regionKey, sourceKey, payload);
    }
    if (issued[sourceKey]) {
        [issued removeObjectForKey:sourceKey];
        identityIssuedCount--;
        if (!issued.count) [identityIssuedPayloads removeObjectForKey:regionKey];
    }
    NSMutableSet<NSString *> *regions = identityRegionsBySource[sourceKey];
    [regions removeObject:regionKey];
    if (!regions.count) [identityRegionsBySource removeObjectForKey:sourceKey];
    [historyLock unlock];
    return true;
}

bool sp_image_capture_match_identity_copy_payloads(const uint8_t region_token[16], NSSet<NSString *> **payloads,
    char **error) {
    if (payloads) *payloads = nil;
    if (error) *error = NULL;
    if (!payloads || !error || !region_token) return identityFailure(error, "frame identity region token or output is invalid");
    initializeHistory();
    NSString *regionKey = identityRegionKey(region_token);
    [historyLock lock];
    if (!identitySessionActive || identitySessionFailure) {
        NSString *reason = [identitySessionFailure copy];
        [historyLock unlock];
        bool failed = identityFailure(error, reason.UTF8String ?: "frame identity session is not active");
        [reason release];
        return failed;
    }
    NSDictionary *issued = identityIssuedPayloads[regionKey];
    *payloads = [[NSSet alloc] initWithArray:issued.allValues ?: @[]];
    [historyLock unlock];
    if (!*payloads) return identityFailure(error, "frame identity issued payload copy failed");
    return true;
}

void sp_image_capture_match_identity_session_end(void) {
    initializeHistory();
    closeAndDrainIdentityDecoder();
    [historyLock lock];
    dispatch_queue_t writer_queue = artifactWriterQueue;
    if (writer_queue) dispatch_retain(writer_queue);
    [historyLock unlock];
    if (writer_queue) {
        dispatch_sync(writer_queue, ^{});
        dispatch_release(writer_queue);
    }
    [historyLock lock];
    clearIdentitySessionLocked();
    if (identityDecodeQueue) dispatch_release(identityDecodeQueue);
    identityDecodeQueue = NULL;
    [identityDecodeWorkerQueue release];
    identityDecodeWorkerQueue = nil;
    identityDecodePendingJobs = 0;
    identityDecodePendingBytes = 0;
    [historyLock unlock];
}

bool sp_image_capture_match_identity_session_active(void) {
    return atomic_load(&identitySessionEnabled) && atomic_load(&historyEnabled);
}

bool sp_image_capture_match_identity_session_fail(const char *reason, char **error) {
    if (error) *error = NULL;
    if (!error || !reason || !reason[0]) return identityFailure(error, "frame identity failure reason or error output is invalid");
    NSString *message = [NSString stringWithUTF8String:reason];
    if (!message) return identityFailure(error, "frame identity failure reason is not valid UTF-8");
    initializeHistory();
    [historyLock lock];
    if (!identitySessionActive) {
        [historyLock unlock];
        return identityFailure(error, "frame identity session is not active");
    }
    if (!identitySessionFailure) identitySessionFailure = [message copy];
    atomic_store(&identitySessionEnabled, false);
    [historyLock unlock];
    return true;
}

bool sp_image_capture_match_identity_session_fail_for_nonce(NSData *session_nonce, const char *reason, char **error) {
    if (error) *error = NULL;
    if (!error || session_nonce.length != 32 || !reason || !reason[0])
        return identityFailure(error, "capture nonce, failure reason, and error output are required");
    NSString *message = [NSString stringWithUTF8String:reason];
    if (!message) return identityFailure(error, "frame identity failure reason is not valid UTF-8");
    initializeHistory();
    [historyLock lock];
    if (!identitySessionActive || ![identityCaptureNonce isEqualToData:session_nonce]) {
        [historyLock unlock];
        return false;
    }
    if (!identitySessionFailure) identitySessionFailure = [message copy];
    atomic_store(&identitySessionEnabled, false);
    [historyLock unlock];
    return true;
}

char *sp_image_capture_match_identity_session_error_copy(void) {
    initializeHistory();
    [historyLock lock];
    const char *message = identitySessionFailure.UTF8String;
    char *copy = message ? strdup(message) : NULL;
    [historyLock unlock];
    return copy;
}

static bool validIdentityRaster(const uint8_t *pixels, size_t width, size_t height, size_t stride) {
    return pixels && width && height && width <= SIZE_MAX / 4 && stride >= width * 4
        && height <= SIZE_MAX / stride;
}

static bool validIdentityROI(CGRect roi, size_t width, size_t height) {
    return isfinite(roi.origin.x) && isfinite(roi.origin.y) && isfinite(roi.size.width)
        && isfinite(roi.size.height) && roi.origin.x >= 0 && roi.origin.y >= 0
        && roi.size.width > 0 && roi.size.height > 0 && CGRectGetMaxX(roi) <= width
        && CGRectGetMaxY(roi) <= height && floor(roi.origin.x) == roi.origin.x
        && floor(roi.origin.y) == roi.origin.y && floor(roi.size.width) == roi.size.width
        && floor(roi.size.height) == roi.size.height;
}

static NSString *identityArtifactKey(NSString *regionKey, NSString *sourceKey) {
    return [NSString stringWithFormat:@"%@-%@", regionKey, sourceKey];
}

static bool identityFromArtifactRecord(NSDictionary *record, sp_image_capture_identity *identity) {
    if (![record isKindOfClass:[NSDictionary class]] || !identity) return false;
    NSString *generationField = record[@"generation"];
    NSString *rasterField = record[@"raster"];
    id sequenceField = record[@"sequence"];
    uint64_t generation = 0, raster = 0, sequence = 0;
    if (![generationField isKindOfClass:[NSString class]] || ![rasterField isKindOfClass:[NSString class]]
        || ![sequenceField isKindOfClass:[NSNumber class]]
        || !sp_capture_frame_identity_parse_canonical_uint64(generationField, &generation)
        || !sp_capture_frame_identity_parse_canonical_uint64(rasterField, &raster)
        || !sp_capture_frame_identity_parse_canonical_uint64([sequenceField stringValue], &sequence)
        || sequence > INT_MAX) return false;
    *identity = (sp_image_capture_identity){ generation, raster, (int)sequence };
    return true;
}

static NSString *identityRecordSourceKey(NSDictionary *record) {
    sp_image_capture_identity identity = {};
    if (!identityFromArtifactRecord(record, &identity)) return nil;
    return identitySourceKey(identity);
}

static NSString *identityArtifactPayloadLocked(NSString *regionKey, NSString *sourceKey) {
    NSString *artifactKey = identityArtifactKey(regionKey, sourceKey);
    SPImageCaptureIdentityArtifact *pending = pendingIdentityArtifacts[artifactKey];
    if (pending) return pending.payload;
    for (NSDictionary *record in identityArtifactRecords) {
        if ([record[@"regionToken"] isEqualToString:regionKey]
            && [identityRecordSourceKey(record) isEqualToString:sourceKey]) return record[@"payload"];
    }
    return nil;
}

bool sp_image_capture_match_identity_record(const uint8_t region_token[16], sp_image_capture_identity identity,
    CGRect roi, const uint8_t *tagged_pixels, size_t width, size_t height, size_t stride,
    const char *color_space, char **error) {
    if (error) *error = NULL;
    if (!error || !region_token || !validIdentityRaster(tagged_pixels, width, height, stride)
        || !validIdentityROI(roi, width, height)) {
        return identityFailure(error, "frame identity artifact arguments are invalid");
    }
    NSString *sourceKey = identitySourceKey(identity);
    if (!sourceKey) return identityFailure(error, "frame identity source identity is invalid");
    NSString *regionKey = identityRegionKey(region_token);
    NSString *colorSpace = color_space ? [NSString stringWithUTF8String:color_space] : nil;
    size_t byteCount = stride * height;
    if (byteCount > UINT32_MAX) return identityFailure(error, "frame identity artifact exceeds the digest input bound");
    uint8_t digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(tagged_pixels, (CC_LONG)byteCount, digest);
    NSMutableString *digestHex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
    for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) [digestHex appendFormat:@"%02x", digest[index]];
    NSString *signature = [NSString stringWithFormat:@"%zu:%zu:%zu:%.0f:%.0f:%.0f:%.0f:%@:%@",
        width, height, stride, roi.origin.x, roi.origin.y, roi.size.width, roi.size.height,
        colorSpace ?: @"<null>", digestHex];
    NSString *key = identityArtifactKey(regionKey, sourceKey);

    initializeHistory();
    [historyLock lock];
    if (!identitySessionActive || identitySessionFailure) {
        NSString *reason = [identitySessionFailure copy];
        [historyLock unlock];
        bool failed = identityFailure(error, reason.UTF8String ?: "frame identity session is not active");
        [reason release];
        return failed;
    }
    NSString *issuedPayload = identityIssuedPayloads[regionKey][sourceKey];
    if (!issuedPayload) {
        [historyLock unlock];
        return identityFailure(error, "frame identity artifact has no issued payload");
    }
    NSString *existingSignature = identityArtifactSignatures[key];
    if (existingSignature) {
        bool sameArtifact = [existingSignature isEqualToString:signature];
        if (!sameArtifact && !identitySessionFailure)
            identitySessionFailure = [@"frame identity artifact conflicts with a repeated source tuple" copy];
        if (!sameArtifact) atomic_store(&identitySessionEnabled, false);
        else identityForgetRetiredLocked(regionKey, sourceKey);
        [historyLock unlock];
        if (!sameArtifact) return identityFailure(error, "frame identity artifact conflicts with a repeated source tuple");
        return true;
    }
    if (identityArtifactCount >= kImageCaptureHistoryCountLimit || byteCount > kImageCaptureArtifactPendingLimit
        || artifactPendingBytes > kImageCaptureArtifactPendingLimit - byteCount
        || identityDecodePendingBytes > kImageCaptureArtifactPendingLimit - artifactPendingBytes - byteCount) {
        identityArtifactDrops++;
        identitySessionFailure = [@"frame identity artifact pending capacity was exceeded" copy];
        atomic_store(&identitySessionEnabled, false);
        [historyLock unlock];
        return identityFailure(error, "frame identity artifact pending capacity was exceeded");
    }
    NSString *nonce = identityNonceLocked(region_token);
    NSString *payload = [issuedPayload copy];
    NSString *nonceCopy = [nonce copy];
    identityArtifactSignatures[key] = signature;
    identityArtifactCount++;
    if (!artifactWriterQueue || !artifactDirectory) {
        CGRect roiCopy = roi;
        NSDictionary *record = @{ @"generation": @(identity.generation), @"raster": @(identity.raster),
            @"sequence": @(identity.sequence), @"regionToken": regionKey, @"nonce": nonceCopy,
            @"payload": payload, @"roi": @{ @"x": @(roiCopy.origin.x), @"y": @(roiCopy.origin.y),
                @"width": @(roiCopy.size.width), @"height": @(roiCopy.size.height) },
            @"width": @(width), @"height": @(height), @"stride": @(stride),
            @"colorSpace": colorSpace ?: (id)NSNull.null, @"byteCount": @(byteCount),
            @"sha256": digestHex, @"file": (id)NSNull.null };
        [identityArtifactRecords addObject:record];
        identityForgetRetiredLocked(regionKey, sourceKey);
        [payload release]; [nonceCopy release];
        [historyLock unlock];
        return true;
    }
    NSData *pixels = [[NSData alloc] initWithBytes:tagged_pixels length:byteCount];
    SPImageCaptureIdentityArtifact *artifact = [SPImageCaptureIdentityArtifact new];
    artifact.identity = identity;
    artifact.roi = roi;
    artifact.width = width;
    artifact.height = height;
    artifact.stride = stride;
    artifact.pixels = pixels;
    artifact.regionToken = regionKey;
    artifact.nonce = nonceCopy;
    artifact.payload = payload;
    artifact.colorSpace = colorSpace;
    [pixels release]; [nonceCopy release]; [payload release];
    if (!artifact.pixels) {
        [artifact release];
        [identityArtifactSignatures removeObjectForKey:key];
        identityArtifactCount--;
        identitySessionFailure = [@"frame identity artifact raster copy failed" copy];
        atomic_store(&identitySessionEnabled, false);
        [historyLock unlock];
        return identityFailure(error, "frame identity artifact raster copy failed");
    }
    pendingIdentityArtifacts[key] = artifact;
    artifactPendingBytes += byteCount;
    identityForgetRetiredLocked(regionKey, sourceKey);
    NSString *directory = [artifactDirectory copy];
    dispatch_queue_t queue = artifactWriterQueue;
    [artifact retain];
    [artifact release];
    dispatch_async(queue, ^{
        writeIdentityArtifact(artifact, directory, key);
        [artifact release];
        [directory release];
    });
    [historyLock unlock];
    return true;
}
