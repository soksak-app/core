// Measures the storage amount of the real still write path (processStill: the sRGB BGRA pixels of an image, the header and the
// frame writer) and the cost of the lossless codecs on the same pixels. The frame on disk restores every pixel of the image.
#import "../src/capture.m"
#import "support/temporary_folder.h"
#include <compression.h>
#include <zlib.h>

static int failures;
static void check(BOOL ok, NSString *label) {
    fprintf(stderr, "%s: %s\n", ok ? "PASS" : "FAIL", label.UTF8String);
    if (!ok) failures++;
}

static const size_t kWidth = 2400, kHeight = 1520;

// A full-resolution sRGB image: a flat background with a small text area, or noise. Every pixel is opaque, so drawing it into
// the sRGB BGRA frame keeps its bytes.
static CGImageRef image(BOOL noise, NSData **original) {
    CGColorSpaceRef srgb = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(NULL, kWidth, kHeight, 8, kWidth * 4, srgb,
        (CGBitmapInfo)kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little);
    CGColorSpaceRelease(srgb);
    check(context != NULL, @"the storage fixture has a full-resolution bitmap");
    if (context == NULL) return NULL;
    uint8_t *base = CGBitmapContextGetData(context);
    size_t stride = CGBitmapContextGetBytesPerRow(context);
    uint32_t random = 123456789;
    for (size_t y = 0; y < kHeight; y++) {
        for (size_t x = 0; x < kWidth * 4; x++) {
            random ^= random << 13; random ^= random >> 17; random ^= random << 5;
            uint8_t value = noise ? (uint8_t)random
                : (x / 4 % 113 < 7 && y % 29 < 9 ? 180 : (uint8_t[]){29, 26, 25, 255}[x % 4]);
            base[y * stride + x] = x % 4 == 3 ? 255 : value;
        }
    }
    NSMutableData *packed = [NSMutableData dataWithLength:kWidth * 4 * kHeight];
    for (size_t y = 0; y < kHeight; y++) memcpy((uint8_t *)packed.mutableBytes + y * kWidth * 4, base + y * stride, kWidth * 4);
    *original = packed;
    CGImageRef made = CGBitmapContextCreateImage(context);
    CGContextRelease(context);
    return made;
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
            [NSString stringWithFormat:@"%@ restores all pixels", name]);
        fprintf(stderr, "MEASURE: %s %s raw=%lu encoded=%lu encode=%.3fms decode=%.3fms\n",
            label.UTF8String, name.UTF8String, (unsigned long)pixels.length, (unsigned long)size, encodeMs, decodeMs);
    }
    free(encoded); free(decoded);
}

int main(void) { @autoreleasepool {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: native capture lossless storage measurement\n");
    [NSApplication sharedApplication];
    NSString *directory = temporaryFolder(@"soksak-capture-storage-");
    prepareCaptureQueues();
    clearCaptureError();
    mach_timebase_info_data_t timebase;
    mach_timebase_info(&timebase);
    // A recording of two stills of a 1200x760 point window at scale 2. The target has no window list, so the still covers the
    // rectangle of the target.
    SPCaptureRecording *recording = [[SPCaptureRecording alloc] init];
    recording.directory = directory;
    recording.windowNumber = 1;
    recording.planned = 2;
    recording.timebase = timebase;
    for (NSUInteger index = 0; index < 2; index++) [recording.rows addObject:[NSMutableDictionary dictionaryWithDictionary:@{
        @"index": @(index), @"outcome": @"not-requested", @"error": NSNull.null, @"frame": NSNull.null }]];
    recording.nextIndex = 2;
    SPCaptureTarget *target = [[[SPCaptureTarget alloc] init] autorelease];
    target.screen = CGRectMake(0, 0, kWidth / 2, kHeight / 2);
    for (int index = 0; index < 2; index++) {
        NSData *pixels = nil;
        CGImageRef frame = image(index == 1, &pixels);
        if (frame == NULL) continue;
        CFTimeInterval writeBegan = CACurrentMediaTime();
        uint64_t requested = mach_absolute_time();
        processStill(recording, (NSUInteger)index, target, frame, requested, mach_absolute_time());
        dispatch_sync(captureWriter, ^{});
        CGImageRelease(frame);
        check(strlen(sp_capture_error()) == 0 && recording.written == index + 1
            && [recording.rows[index][@"outcome"] isEqual:@"written"],
            [NSString stringWithFormat:@"the still write path commits the measurement frame (%s)", sp_capture_error()]);
        NSString *file = [directory stringByAppendingPathComponent:[NSString stringWithFormat:@"frame-%04d.bgra", index]];
        NSData *stored = [NSData dataWithContentsOfFile:file];
        check(stored != nil, @"the measurement frame file exists");
        fprintf(stderr, "MEASURE: %s actual stored=%lu write=%.3fms\n", index ? "noise" : "document",
            (unsigned long)stored.length, (CACurrentMediaTime() - writeBegan) * 1000);
        measure(pixels, index ? @"noise" : @"document");
        const uint8_t *bytes = stored.bytes;
        BOOL marked = stored.length >= kFrameEncodedHeader && memcmp(bytes + kFrameHeader, "LZ4S", 4) == 0;
        check(marked, @"the still writer emits the declared lossless LZ4 block header");
        if (marked) {
            uint32_t dimensions[3] = {0}, encodedBytes = 0, checksum = 0;
            memcpy(dimensions, bytes, sizeof dimensions);
            check(dimensions[0] == kWidth && dimensions[1] == kHeight && dimensions[2] == kWidth * 4,
                [NSString stringWithFormat:@"the frame keeps the full resolution (%ux%u, stride %u)", dimensions[0], dimensions[1],
                    dimensions[2]]);
            memcpy(&encodedBytes, bytes + kFrameHeader + 4, sizeof encodedBytes);
            memcpy(&checksum, bytes + kFrameHeader + 8, sizeof checksum);
            BOOL whole = stored.length == kFrameEncodedHeader + (size_t)encodedBytes;
            check(whole, @"the stored block has exactly the declared byte count");
            uint8_t *decoded = malloc(pixels.length + 1);
            check(decoded != NULL, @"the stored frame can allocate its decoded pixels");
            if (whole && decoded != NULL) {
                size_t count = compression_decode_buffer(decoded, pixels.length + 1,
                    bytes + kFrameEncodedHeader, encodedBytes, NULL, COMPRESSION_LZ4_RAW);
                check(count == pixels.length && memcmp(decoded, pixels.bytes, pixels.length) == 0,
                    @"the stored block restores every pixel of the image");
                check(count == pixels.length && crc32(0, decoded, (uInt)count) == checksum,
                    @"the stored block preserves its pixel checksum");
            }
            free(decoded);
        }
        if (index == 0) check(stored.length < pixels.length / 10,
            @"the document fixture removes raw-pixel disk pressure without reducing resolution");
    }
    [recording release];
    fprintf(stderr, "%s: native capture lossless storage measurement (%.1fms)\n", failures ? "FAIL" : "PASS",
        (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
