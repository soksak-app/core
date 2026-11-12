// The native measurement reader verifies the entire declared compressed bytes and the restored checksum.
#import "support/capture_frame.m"

static int failures;
static void check(BOOL ok, const char *label) {
    fprintf(stderr, "%s: %s\n", ok ? "PASS" : "FAIL", label);
    if (!ok) failures++;
}

int main(void) { @autoreleasepool {
    CFTimeInterval began = [NSDate timeIntervalSinceReferenceDate];
    fprintf(stderr, "START: native capture frame decoder\n");
    // Three uint32 and eight float64 (76 bytes), the marker, the block length and the checksum: the block starts at byte 88.
    NSMutableData *frame = [NSMutableData dataWithLength:122];
    uint8_t *bytes = frame.mutableBytes;
    uint32_t dimensions[3] = {3, 2, 16}, length = 34;
    memcpy(bytes, dimensions, sizeof dimensions);
    double times[2] = {1234.5, 1235.25};
    memcpy(bytes + 12 + 6 * sizeof(double), times, sizeof times);
    memcpy(bytes + 76, "LZ4S", 4); memcpy(bytes + 80, &length, sizeof length);
    bytes[88] = 0xf0; bytes[89] = 17;
    for (int i = 0; i < 32; i++) bytes[90 + i] = i;
    uint32_t checksum = (uint32_t)crc32(0, bytes + 90, 32);
    memcpy(bytes + 84, &checksum, sizeof checksum);
    NSData *decoded = readCaptureFrame(frame);
    check(decoded.length == 108 && memcmp((const uint8_t *)decoded.bytes + 76, bytes + 90, 32) == 0,
        "a valid literal block restores every pixel and row-padding byte");
    check(decoded.length == 108 && memcmp((const uint8_t *)decoded.bytes + 60, times, sizeof times) == 0,
        "the request and completion times of the still stay in the header");
    // A frame of the earlier format, with seven float64 and the marker LZ4B, is not read as this format.
    NSMutableData *earlier = [NSMutableData dataWithData:frame];
    memcpy((uint8_t *)earlier.mutableBytes + 76, "LZ4B", 4);
    check(readCaptureFrame(earlier) == nil, "a frame with another marker is rejected");
    // Even when the file length is corrected, garbage after the block must not be accepted as valid pixels.
    uint8_t extra = 0;
    [frame appendBytes:&extra length:1];
    length++;
    memcpy((uint8_t *)frame.mutableBytes + 80, &length, sizeof length);
    check(readCaptureFrame(frame) == nil, "a block with trailing undecompressed input is rejected");
    fprintf(stderr, "%s: native capture frame decoder (%.1fms)\n", failures ? "FAIL" : "PASS",
        ([NSDate timeIntervalSinceReferenceDate] - began) * 1000);
    return failures ? 1 : 0;
}}
