// 실제 샘플 쓰기 경로의 저장량과 무손실 코덱 비용을 같은 픽셀로 측정한다.
#import "../src/capture.m"
#include <compression.h>
#include <zlib.h>

static int failures;
static void check(BOOL ok, NSString *label) {
    fprintf(stderr, "%s: %s\n", ok ? "PASS" : "FAIL", label.UTF8String);
    if (!ok) failures++;
}

static CMSampleBufferRef sample(BOOL noise, NSData **original) {
    CVPixelBufferRef pixels = NULL;
    CVReturn created = CVPixelBufferCreate(NULL, 2400, 1520, kCVPixelFormatType_32BGRA, NULL, &pixels);
    check(created == kCVReturnSuccess, @"the storage fixture has a full-resolution pixel buffer");
    if (created != kCVReturnSuccess) return NULL;
    CVPixelBufferLockBaseAddress(pixels, 0);
    size_t stride = CVPixelBufferGetBytesPerRow(pixels);
    uint8_t *base = CVPixelBufferGetBaseAddress(pixels);
    uint32_t random = 123456789;
    for (size_t y = 0; y < 1520; y++) {
        for (size_t x = 0; x < stride; x++) {
            random ^= random << 13; random ^= random >> 17; random ^= random << 5;
            // 평면 배경과 작은 글자 영역, 행 패딩도 복원 비교에 포함한다.
            base[y * stride + x] = noise ? (uint8_t)random
                : (x / 4 % 113 < 7 && y % 29 < 9 ? 180 : (uint8_t[]){29, 26, 25, 255}[x % 4]);
        }
    }
    *original = [NSData dataWithBytes:base length:stride * 1520];
    CVPixelBufferUnlockBaseAddress(pixels, 0);
    CMVideoFormatDescriptionRef format = NULL;
    OSStatus formatted = CMVideoFormatDescriptionCreateForImageBuffer(NULL, pixels, &format);
    check(formatted == noErr, @"the storage fixture has an image format");
    CMSampleBufferRef result = NULL;
    if (formatted == noErr) {
        CMSampleTimingInfo timing = {kCMTimeInvalid, kCMTimeZero, kCMTimeInvalid};
        check(CMSampleBufferCreateReadyWithImageBuffer(NULL, pixels, format, &timing, &result) == noErr,
            @"the storage fixture has a ready sample");
    }
    if (result != NULL) {
        CFMutableDictionaryRef attachments = (CFMutableDictionaryRef)CFArrayGetValueAtIndex(
            CMSampleBufferGetSampleAttachmentsArray(result, true), 0);
        NSDictionary *rect = [(NSDictionary *)CGRectCreateDictionaryRepresentation(CGRectMake(0, 0, 1200, 760)) autorelease];
        NSDictionary *metadata = @{SCStreamFrameInfoStatus: @(SCFrameStatusComplete),
            SCStreamFrameInfoDisplayTime: @(mach_absolute_time()), SCStreamFrameInfoContentRect: rect,
            SCStreamFrameInfoContentScale: @1, SCStreamFrameInfoScaleFactor: @2};
        for (NSString *key in metadata) CFDictionarySetValue(attachments, key, metadata[key]);
    }
    if (format != NULL) CFRelease(format);
    CVPixelBufferRelease(pixels);
    return result;
}

static void measure(NSData *pixels, NSString *label) {
    size_t capacity = MAX(compressBound(pixels.length), pixels.length + pixels.length / 255 + 16);
    uint8_t *encoded = malloc(capacity), *decoded = malloc(pixels.length);
    check(encoded != NULL && decoded != NULL, @"codec measurement buffers are allocated");
    if (encoded == NULL || decoded == NULL) { free(encoded); free(decoded); return; }
    for (int codec = 0; codec < 3; codec++) {
        NSString *name = @[@"zlib-speed", @"lz4-raw", @"lzfse"][codec];
        CFTimeInterval began = CACurrentMediaTime();
        size_t size = 0;
        if (codec == 0) {
            uLongf count = capacity;
            int result = compress2(encoded, &count, pixels.bytes, pixels.length, Z_BEST_SPEED);
            check(result == Z_OK, @"zlib compression succeeds");
            if (result == Z_OK) size = count;
        } else {
            size = compression_encode_buffer(encoded, capacity, pixels.bytes, pixels.length, NULL,
                codec == 1 ? COMPRESSION_LZ4_RAW : COMPRESSION_LZFSE);
        }
        double encodeMs = (CACurrentMediaTime() - began) * 1000;
        check(size > 0, [NSString stringWithFormat:@"%@ encodes every input", name]);
        began = CACurrentMediaTime();
        size_t restored = 0;
        if (codec == 0 && size > 0) {
            uLongf count = pixels.length;
            int result = uncompress(decoded, &count, encoded, size);
            check(result == Z_OK, @"zlib decompression succeeds");
            if (result == Z_OK) restored = count;
        } else if (size > 0) {
            restored = compression_decode_buffer(decoded, pixels.length, encoded, size, NULL,
                codec == 1 ? COMPRESSION_LZ4_RAW : COMPRESSION_LZFSE);
        }
        double decodeMs = (CACurrentMediaTime() - began) * 1000;
        check(restored == pixels.length && memcmp(decoded, pixels.bytes, pixels.length) == 0,
            [NSString stringWithFormat:@"%@ restores all pixels and row padding", name]);
        fprintf(stderr, "MEASURE: %s %s raw=%lu encoded=%lu encode=%.3fms decode=%.3fms\n",
            label.UTF8String, name.UTF8String, (unsigned long)pixels.length, (unsigned long)size, encodeMs, decodeMs);
    }
    free(encoded); free(decoded);
}

int main(void) { @autoreleasepool {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: native capture lossless storage measurement\n");
    [NSApplication sharedApplication];
    char path[] = "/tmp/soksak-capture-storage-XXXXXX";
    if (mkdtemp(path) == NULL) { check(NO, @"the storage fixture directory is created"); return 1; }
    NSString *directory = [NSString stringWithUTF8String:path];
    captureWriter = dispatch_queue_create("capture.test.storage", DISPATCH_QUEUE_SERIAL);
    capturePending = dispatch_semaphore_create(kCapturePending);
    captureFirstFrame = dispatch_semaphore_create(0);
    captureSink = [SPCapture new]; captureSink.directory = directory;
    static int statuses[6]; captureSink.statuses = statuses;
    clearCaptureError(); captureBefore = 0; captureStartedAt = 0;
    for (int index = 0; index < 2; index++) {
        NSData *pixels = nil;
        CMSampleBufferRef frame = sample(index == 1, &pixels);
        if (frame == NULL) continue;
        CFTimeInterval writeBegan = CACurrentMediaTime();
        [captureSink write:frame]; dispatch_sync(captureWriter, ^{});
        check(strlen(sp_capture_error()) == 0 && captureSink.written == index + 1,
            @"the actual sample writer commits the measurement frame");
        NSString *file = [directory stringByAppendingPathComponent:[NSString stringWithFormat:@"frame-%04d.bgra", index + 1]];
        NSData *stored = [NSData dataWithContentsOfFile:file];
        check(stored != nil, @"the measurement frame file exists");
        fprintf(stderr, "MEASURE: %s actual stored=%lu write=%.3fms\n", index ? "noise" : "document",
            (unsigned long)stored.length, (CACurrentMediaTime() - writeBegan) * 1000);
        measure(pixels, index ? @"noise" : @"document");
        const uint8_t *bytes = stored.bytes;
        BOOL marked = stored.length >= 80 && memcmp(bytes + 68, "LZ4B", 4) == 0;
        check(marked, @"the actual writer emits the declared lossless LZ4 block header");
        if (marked) {
            uint32_t encodedBytes = 0, checksum = 0;
            memcpy(&encodedBytes, bytes + 72, sizeof encodedBytes);
            memcpy(&checksum, bytes + 76, sizeof checksum);
            BOOL whole = stored.length == 80 + (size_t)encodedBytes;
            check(whole, @"the stored block has exactly the declared byte count");
            uint8_t *decoded = malloc(pixels.length + 1);
            check(decoded != NULL, @"the actual stored frame can allocate its decoded pixels");
            if (whole && decoded != NULL) {
                size_t count = compression_decode_buffer(decoded, pixels.length + 1,
                    bytes + 80, encodedBytes, NULL, COMPRESSION_LZ4_RAW);
                check(count == pixels.length && memcmp(decoded, pixels.bytes, pixels.length) == 0,
                    @"the actual stored block restores every pixel and padding byte");
                check(count == pixels.length && crc32(0, decoded, (uInt)count) == checksum,
                    @"the actual stored block preserves its pixel checksum");
            }
            free(decoded);
        }
        if (index == 0) check(stored.length < pixels.length / 10,
            @"the document fixture removes raw-pixel disk pressure without reducing resolution");
        CFRelease(frame);
    }
    NSError *error = nil;
    check([[NSFileManager defaultManager] removeItemAtPath:directory error:&error],
        [NSString stringWithFormat:@"measurement files are removed (%@)", error]);
    fprintf(stderr, "%s: native capture lossless storage measurement (%.1fms)\n", failures ? "FAIL" : "PASS",
        (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
