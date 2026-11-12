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

// The pixels of a still PNG (diagnostics.capture.still) in the colour space that the PNG names. A still holds the bytes of the
// display colour space, so a check reads a pixel through that space as sRGB; NSBitmapImageRep colorAtX:y: does not apply the
// profile of the PNG and is not used. The caller releases the pixels.
typedef struct {
    size_t width, height, stride;
    BOOL alphaFirst;
    CFDataRef data;
    CGColorSpaceRef space;
    uint32_t cachedRaw, cachedRGB;
    BOOL cached;
} SPStillPixels;

__attribute__((unused)) static SPStillPixels captureStillPixels(CGImageRef image) {
    SPStillPixels still = {0};
    if (image == NULL || CGImageGetBitsPerComponent(image) != 8 || CGImageGetBitsPerPixel(image) != 32) return still;
    CGBitmapInfo info = CGImageGetBitmapInfo(image);
    CGImageAlphaInfo alpha = CGImageGetAlphaInfo(image);
    BOOL little = (info & kCGBitmapByteOrderMask) == kCGBitmapByteOrder32Little;
    BOOL first = alpha == kCGImageAlphaFirst || alpha == kCGImageAlphaPremultipliedFirst || alpha == kCGImageAlphaNoneSkipFirst;
    BOOL last = alpha == kCGImageAlphaLast || alpha == kCGImageAlphaPremultipliedLast || alpha == kCGImageAlphaNoneSkipLast;
    // Read as bytes: little-endian alpha first is B G R A, the default order with alpha last is R G B A.
    if (!((little && first) || (!little && last))) return still;
    still.width = CGImageGetWidth(image);
    still.height = CGImageGetHeight(image);
    still.stride = CGImageGetBytesPerRow(image);
    still.alphaFirst = little && first;
    still.data = CGDataProviderCopyData(CGImageGetDataProvider(image));
    still.space = CGColorSpaceRetain(CGImageGetColorSpace(image));
    return still;
}

__attribute__((unused)) static BOOL captureStillPixelSRGB(SPStillPixels *still, size_t x, size_t y, uint8_t rgb[3]) {
    if (still->data == NULL || x >= still->width || y >= still->height) return NO;
    const uint8_t *p = CFDataGetBytePtr(still->data) + y * still->stride + x * 4;
    uint8_t bgra[4] = { still->alphaFirst ? p[0] : p[2], p[1], still->alphaFirst ? p[2] : p[0], 255 };
    uint32_t raw = (uint32_t)bgra[2] << 16 | (uint32_t)bgra[1] << 8 | bgra[0];
    if (!still->cached || still->cachedRaw != raw) {
        uint8_t read[3];
        captureFramePixelSRGB(bgra, still->space, read);
        still->cachedRaw = raw;
        still->cachedRGB = (uint32_t)read[0] << 16 | (uint32_t)read[1] << 8 | read[2];
        still->cached = YES;
    }
    rgb[0] = still->cachedRGB >> 16; rgb[1] = still->cachedRGB >> 8 & 0xff; rgb[2] = still->cachedRGB & 0xff;
    return YES;
}

__attribute__((unused)) static void captureStillPixelsRelease(SPStillPixels *still) {
    if (still->data) CFRelease(still->data);
    if (still->space) CGColorSpaceRelease(still->space);
    *still = (SPStillPixels){0};
}
