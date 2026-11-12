// The owning native measurement checks the size and checksum of the compressed file before it reads pixels. A frame file holds
// three uint32 (width, height, row stride), eight float64 (content x/y/width/height, content scale, scale, the request time and
// the completion time of its still in ms), the marker LZ4S, the uint32 compressed byte count and the uint32 CRC-32 of the pixels.
// The decoded frame keeps the 76 bytes before the marker and then the pixels, from kCaptureFrameHeader.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#include <math.h>
#include <compression.h>
#include <zlib.h>

static const size_t kCaptureFrameHeader = 12 + 8 * sizeof(double);

static NSData *readCaptureFrame(NSData *file) {
    const uint8_t *bytes = file.bytes;
    if (file.length < kCaptureFrameHeader + 12 || memcmp(bytes + kCaptureFrameHeader, "LZ4S", 4) != 0) {
        fprintf(stderr, "capture frame has no complete LZ4S header (%lu bytes)\n", (unsigned long)file.length);
        return nil;
    }
    uint32_t dimensions[3], encoded, checksum;
    memcpy(dimensions, bytes, sizeof dimensions);
    memcpy(&encoded, bytes + kCaptureFrameHeader + 4, sizeof encoded);
    memcpy(&checksum, bytes + kCaptureFrameHeader + 8, sizeof checksum);
    uint64_t expected = (uint64_t)dimensions[2] * dimensions[1];
    if (dimensions[0] == 0 || dimensions[1] == 0 || dimensions[2] < (uint64_t)dimensions[0] * 4 ||
        expected > UINT32_MAX || encoded == 0 || file.length != kCaptureFrameHeader + 12 + (uint64_t)encoded) {
        fprintf(stderr, "capture frame has invalid dimensions or block length\n"); return nil;
    }
    NSMutableData *decoded = [NSMutableData dataWithLength:kCaptureFrameHeader + (size_t)expected + 1];
    uint8_t *output = decoded.mutableBytes;
    memcpy(output, bytes, kCaptureFrameHeader);
    size_t count = compression_decode_buffer(output + kCaptureFrameHeader, (size_t)expected + 1,
        bytes + kCaptureFrameHeader + 12, encoded, NULL, COMPRESSION_LZ4_RAW);
    if (count != expected || crc32(0, output + kCaptureFrameHeader, (uInt)count) != checksum) {
        fprintf(stderr, "capture frame has invalid decoded size or pixel checksum (%zu/%llu)\n",
            count, (unsigned long long)expected); return nil;
    }
    [decoded setLength:kCaptureFrameHeader + (size_t)expected];
    return decoded;
}

// The colour space of the frames of a recording folder: the ICC profile file color-<hash>.icc that the stills wrote (the row field
// colorProfile of stills.jsonl). NULL when the folder holds no profile or more than one, which a check reports. The caller
// releases the space.
__attribute__((unused)) static CGColorSpaceRef captureFolderColorSpace(NSString *folder) {
    NSString *found = nil;
    for (NSString *name in [NSFileManager.defaultManager contentsOfDirectoryAtPath:folder error:NULL]) {
        if (![name hasPrefix:@"color-"] || ![name.pathExtension isEqualToString:@"icc"]) continue;
        if (found != nil) return NULL;
        found = name;
    }
    NSData *profile = found ? [NSData dataWithContentsOfFile:[folder stringByAppendingPathComponent:found]] : nil;
    return profile ? CGColorSpaceCreateWithICCData((CFDataRef)profile) : NULL;
}

// The BGRA pixel at the byte offset of a frame in space, read through the ICC profile of space as 8-bit sRGB red, green and
// blue. A check with a tolerance compares this with an sRGB constant; a check without one compares the frame bytes with a
// reference patch of the same frame.
__attribute__((unused)) static void captureFramePixelSRGB(const uint8_t *bgra, CGColorSpaceRef space, uint8_t rgb[3]) {
    CGFloat components[4] = { bgra[2] / 255.0, bgra[1] / 255.0, bgra[0] / 255.0, 1 };
    CGColorRef color = space ? CGColorCreate(space, components) : NULL;
    CGColorSpaceRef srgb = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGColorRef matched = color ? CGColorCreateCopyByMatchingToColorSpace(srgb, kCGRenderingIntentDefault, color, NULL) : NULL;
    const CGFloat *values = matched ? CGColorGetComponents(matched) : NULL;
    for (int index = 0; index < 3; index++)
        rgb[index] = values ? (uint8_t)lround(fmin(fmax(values[index], 0), 1) * 255) : 0;
    if (matched) CGColorRelease(matched);
    if (color) CGColorRelease(color);
    CGColorSpaceRelease(srgb);
}
