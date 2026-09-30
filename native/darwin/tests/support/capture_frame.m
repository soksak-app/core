// 소유 네이티브 측정은 압축 파일의 크기와 체크섬을 검사한 뒤 픽셀을 읽는다.
#import <Foundation/Foundation.h>
#include <compression.h>
#include <zlib.h>

static NSData *readCaptureFrame(NSData *file) {
    const uint8_t *bytes = file.bytes;
    if (file.length < 80 || memcmp(bytes + 68, "LZ4B", 4) != 0) {
        fprintf(stderr, "capture frame has no complete LZ4 header (%lu bytes)\n", (unsigned long)file.length);
        return nil;
    }
    uint32_t dimensions[3], encoded, checksum;
    memcpy(dimensions, bytes, sizeof dimensions);
    memcpy(&encoded, bytes + 72, sizeof encoded); memcpy(&checksum, bytes + 76, sizeof checksum);
    uint64_t expected = (uint64_t)dimensions[2] * dimensions[1];
    if (dimensions[0] == 0 || dimensions[1] == 0 || dimensions[2] < (uint64_t)dimensions[0] * 4 ||
        expected > UINT32_MAX || encoded == 0 || file.length != 80 + (uint64_t)encoded) {
        fprintf(stderr, "capture frame has invalid dimensions or block length\n"); return nil;
    }
    NSMutableData *decoded = [NSMutableData dataWithLength:68 + (size_t)expected + 1];
    uint8_t *output = decoded.mutableBytes;
    memcpy(output, bytes, 68);
    size_t count = compression_decode_buffer(output + 68, (size_t)expected + 1,
        bytes + 80, encoded, NULL, COMPRESSION_LZ4_RAW);
    if (count != expected || crc32(0, output + 68, (uInt)count) != checksum) {
        fprintf(stderr, "capture frame has invalid decoded size or pixel checksum (%zu/%llu)\n",
            count, (unsigned long long)expected); return nil;
    }
    [decoded setLength:68 + (size_t)expected];
    return decoded;
}
