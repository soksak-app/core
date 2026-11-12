// The owning native measurement checks the size and checksum of the compressed file before it reads pixels. A frame file holds
// three uint32 (width, height, row stride), eight float64 (content x/y/width/height, content scale, scale, the request time and
// the completion time of its still in ms), the marker LZ4S, the uint32 compressed byte count and the uint32 CRC-32 of the pixels.
// The decoded frame keeps the 76 bytes before the marker and then the pixels, from kCaptureFrameHeader.
#import <Foundation/Foundation.h>
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
