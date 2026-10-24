#import "image_capture_match.h"
#import <Foundation/Foundation.h>
#import <CommonCrypto/CommonDigest.h>
#include <string.h>
#include <math.h>
#include <stdio.h>
#include <stdatomic.h>

static const size_t kImageCaptureHistoryLimit = 64 * 1024 * 1024;
static const NSUInteger kImageCaptureHistoryCountLimit = 512;

@interface SPImageCaptureSource : NSObject
@property sp_image_capture_identity identity;
@property(retain) NSData *pixels;
@property size_t width;
@property size_t height;
@property size_t stride;
@property CGRect screenBounds;
@property double scale;
@property(copy) NSString *colorSpace;
@property BOOL artifactScheduled;
@end

@implementation SPImageCaptureSource
- (void)dealloc {
    [_pixels release];
    [_colorSpace release];
    [super dealloc];
}
@end

static NSLock *historyLock;
static NSMutableArray<SPImageCaptureSource *> *history;
static size_t historyBytes;
static size_t historyDrops;
static atomic_bool historyEnabled;
static size_t artifactBytes;
static NSUInteger artifactCount;
static size_t artifactDrops;
static size_t artifactWriteFailures;
static size_t artifactCleanupFailures;
static NSMutableArray<NSDictionary *> *artifactRecords;
static NSMutableDictionary<NSString *, NSNumber *> *artifactDropReasons;
static NSMutableArray<NSDictionary *> *artifactCleanupErrors;
static NSMutableDictionary<NSString *, SPImageCaptureSource *> *artifactIdentitySources;

static void recordArtifactDrop(NSString *reason);

static void initializeHistory(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        historyLock = [NSLock new];
        history = [NSMutableArray new];
        artifactRecords = [NSMutableArray new];
        artifactDropReasons = [NSMutableDictionary new];
        artifactCleanupErrors = [NSMutableArray new];
        artifactIdentitySources = [NSMutableDictionary new];
    });
}

void sp_image_capture_match_begin(void) {
    initializeHistory();
    [historyLock lock];
    [history removeAllObjects];
    historyBytes = 0;
    historyDrops = 0;
    artifactBytes = 0;
    artifactCount = 0;
    artifactDrops = 0;
    artifactWriteFailures = 0;
    artifactCleanupFailures = 0;
    [artifactRecords removeAllObjects];
    [artifactDropReasons removeAllObjects];
    [artifactCleanupErrors removeAllObjects];
    [artifactIdentitySources removeAllObjects];
    atomic_store(&historyEnabled, true);
    [historyLock unlock];
}

void sp_image_capture_match_end(void) {
    initializeHistory();
    [historyLock lock];
    atomic_store(&historyEnabled, false);
    [history removeAllObjects];
    historyBytes = 0;
    artifactBytes = 0;
    artifactCount = 0;
    artifactDrops = 0;
    artifactWriteFailures = 0;
    artifactCleanupFailures = 0;
    [artifactRecords removeAllObjects];
    [artifactDropReasons removeAllObjects];
    [artifactCleanupErrors removeAllObjects];
    [artifactIdentitySources removeAllObjects];
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
    SPImageCaptureSource *artifactSource = artifactIdentitySources[identityKey];
    if (artifactSource) {
        NSString *scheduledColor = artifactSource.colorSpace ?: @"<null>";
        BOOL sameMetadata = artifactSource.width == width && artifactSource.height == height
            && artifactSource.stride == stride && CGRectEqualToRect(artifactSource.screenBounds, screen_bounds)
            && artifactSource.scale == scale && [scheduledColor isEqualToString:colorSpace ?: @"<null>"];
        BOOL samePixels = sameMetadata && artifactSource.pixels.length == byteCount
            && memcmp(artifactSource.pixels.bytes, pixels, byteCount) == 0;
        if (samePixels) { [historyLock unlock]; return true; }
        historyDrops++;
        recordArtifactDrop(@"identity-conflict");
        [historyLock unlock];
        return false;
    }
    while ((historyBytes + byteCount > kImageCaptureHistoryLimit || history.count >= kImageCaptureHistoryCountLimit)
        && history.count > 0) {
        SPImageCaptureSource *oldest = history.firstObject;
        historyBytes -= oldest.pixels.length;
        [history removeObjectAtIndex:0];
        historyDrops++;
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

void sp_image_capture_match_write_sources(const char *capture_directory, dispatch_queue_t writer_queue) {
    initializeHistory();
    if (!capture_directory || !writer_queue) {
        [historyLock lock];
        if (atomic_load(&historyEnabled)) recordArtifactDrop(@"writer-unavailable");
        [historyLock unlock];
        return;
    }
    NSString *directory = [NSString stringWithUTF8String:capture_directory];
    if (!directory) {
        [historyLock lock];
        if (atomic_load(&historyEnabled)) recordArtifactDrop(@"invalid-directory");
        [historyLock unlock];
        return;
    }

    [historyLock lock];
    if (!atomic_load(&historyEnabled)) { [historyLock unlock]; return; }
    NSMutableArray<SPImageCaptureSource *> *pending = [NSMutableArray array];
    for (SPImageCaptureSource *source in history) {
        if (source.artifactScheduled) continue;
        source.artifactScheduled = YES;
        if (artifactCount >= kImageCaptureHistoryCountLimit
            || source.pixels.length > kImageCaptureHistoryLimit - artifactBytes) {
            recordArtifactDrop(@"capacity");
            continue;
        }
        artifactBytes += source.pixels.length;
        artifactCount++;
        NSString *identityKey = [NSString stringWithFormat:@"%llu-%llu-%d", (unsigned long long)source.identity.generation,
            (unsigned long long)source.identity.raster, source.identity.sequence];
        artifactIdentitySources[identityKey] = source;
        [pending addObject:source];
    }
    [historyLock unlock];

    NSString *sourceDirectory = [directory stringByAppendingPathComponent:@"sources"];
    for (SPImageCaptureSource *source in pending) {
        dispatch_async(writer_queue, ^{
            NSFileManager *manager = NSFileManager.defaultManager;
            NSError *error = nil;
            if (![manager createDirectoryAtPath:sourceDirectory withIntermediateDirectories:YES attributes:nil error:&error]) {
                [historyLock lock];
                artifactBytes -= source.pixels.length;
                artifactCount--;
                artifactWriteFailures++;
                recordArtifactDrop(@"directory");
                [historyLock unlock];
                return;
            }
            NSString *fileName = artifactName(source.identity);
            NSString *path = [sourceDirectory stringByAppendingPathComponent:fileName];
            NSString *partial = [path stringByAppendingString:@".partial"];
            NSData *pixels = source.pixels;
            if (![pixels writeToFile:partial options:NSDataWritingAtomic error:&error]
                || ![manager moveItemAtPath:partial toPath:path error:&error]) {
                NSError *cleanupError = nil;
                BOOL partialExists = [manager fileExistsAtPath:partial];
                BOOL cleanupSucceeded = !partialExists || [manager removeItemAtPath:partial error:&cleanupError];
                [historyLock lock];
                artifactBytes -= pixels.length;
                artifactCount--;
                NSString *identityKey = [NSString stringWithFormat:@"%llu-%llu-%d",
                    (unsigned long long)source.identity.generation, (unsigned long long)source.identity.raster,
                    source.identity.sequence];
                [artifactIdentitySources removeObjectForKey:identityKey];
                artifactWriteFailures++;
                recordArtifactDrop(@"write");
                if (!cleanupSucceeded) {
                    artifactCleanupFailures++;
                    recordArtifactDrop(@"partial-cleanup");
                    if (artifactCleanupErrors.count < 32) {
                        [artifactCleanupErrors addObject:@{ @"path": partial, @"error": cleanupError.localizedDescription ?: @"unknown cleanup error" }];
                    }
                }
                [historyLock unlock];
                return;
            }
            unsigned char digest[CC_SHA256_DIGEST_LENGTH];
            CC_SHA256(pixels.bytes, (CC_LONG)pixels.length, digest);
            NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
            for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) [hex appendFormat:@"%02x", digest[index]];
            NSDictionary *record = artifactRecord(source, fileName, hex);
            [historyLock lock];
            [artifactRecords addObject:record];
            [historyLock unlock];
        });
    }
}

bool sp_image_capture_match_write_manifest(const char *capture_directory) {
    initializeHistory();
    if (!capture_directory) return false;
    NSString *directory = [NSString stringWithUTF8String:capture_directory];
    if (!directory) return false;
    [historyLock lock];
    NSDictionary *manifest = @{
        @"format": @1, @"pixelFormat": @"BGRA8", @"alpha": @"premultiplied-first",
        @"limits": @{ @"bytes": @(kImageCaptureHistoryLimit), @"identities": @(kImageCaptureHistoryCountLimit) },
        @"artifacts": [artifactRecords copy], @"droppedSources": @(artifactDrops),
        @"dropReasons": [artifactDropReasons copy], @"writeFailures": @(artifactWriteFailures),
        @"cleanupFailures": @(artifactCleanupFailures), @"cleanupErrors": [artifactCleanupErrors copy],
        @"cleanupErrorsOmitted": @(artifactCleanupFailures - artifactCleanupErrors.count),
    };
    BOOL noWriteFailures = artifactWriteFailures == 0;
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
    return data && [data writeToFile:path options:NSDataWritingAtomic error:&error] && noWriteFailures;
}

static BOOL equalPixels(const SPImageCaptureSource *source, const uint8_t *pixels,
    size_t width, size_t height, size_t stride) {
    if (source.width != width || source.height != height) return NO;
    const uint8_t *sourceBytes = source.pixels.bytes;
    for (size_t row = 0; row < height; row++) {
        if (memcmp(sourceBytes + row * source.stride, pixels + row * stride, width * 4) != 0) return NO;
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
        || CGRectGetMaxY(bounds) > CGRectGetMaxY(screen_rect)) return NO;
    double left = CGRectGetMinX(content_rect) + (CGRectGetMinX(bounds) - CGRectGetMinX(screen_rect)) * pixels_per_point;
    double top = CGRectGetMinY(content_rect) + (CGRectGetMinY(bounds) - CGRectGetMinY(screen_rect)) * pixels_per_point;
    double width = CGRectGetWidth(bounds) * pixels_per_point;
    double height = CGRectGetHeight(bounds) * pixels_per_point;
    double rounded_left = nearbyint(left), rounded_top = nearbyint(top);
    double rounded_width = nearbyint(width), rounded_height = nearbyint(height);
    if (fabs(left - rounded_left) > 0.000001 || fabs(top - rounded_top) > 0.000001
        || fabs(width - rounded_width) > 0.000001 || fabs(height - rounded_height) > 0.000001
        || rounded_left < 0 || rounded_top < 0 || rounded_width != source.width || rounded_height != source.height
        || rounded_left + rounded_width > frame_width || rounded_top + rounded_height > frame_height) return NO;
    *crop = CGRectMake(rounded_left, rounded_top, rounded_width, rounded_height);
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
