// 네이티브 측정 리더는 선언한 압축 바이트 전체와 복원 체크섬을 검증한다.
#import "support/capture_frame.m"

static int failures;
static void check(BOOL ok, const char *label) {
    fprintf(stderr, "%s: %s\n", ok ? "PASS" : "FAIL", label);
    if (!ok) failures++;
}

int main(void) { @autoreleasepool {
    CFTimeInterval began = [NSDate timeIntervalSinceReferenceDate];
    fprintf(stderr, "START: native capture frame decoder\n");
    NSMutableData *frame = [NSMutableData dataWithLength:114];
    uint8_t *bytes = frame.mutableBytes;
    uint32_t dimensions[3] = {3, 2, 16}, length = 34;
    memcpy(bytes, dimensions, sizeof dimensions);
    memcpy(bytes + 68, "LZ4B", 4); memcpy(bytes + 72, &length, sizeof length);
    bytes[80] = 0xf0; bytes[81] = 17;
    for (int i = 0; i < 32; i++) bytes[82 + i] = i;
    uint32_t checksum = (uint32_t)crc32(0, bytes + 82, 32);
    memcpy(bytes + 76, &checksum, sizeof checksum);
    NSData *decoded = readCaptureFrame(frame);
    check(decoded.length == 100 && memcmp((const uint8_t *)decoded.bytes + 68, bytes + 82, 32) == 0,
        "a valid literal block restores every pixel and row-padding byte");
    // 파일 길이를 수정해도 블록 뒤 쓰레기를 정상 픽셀로 받아들이면 안 된다.
    uint8_t extra = 0;
    [frame appendBytes:&extra length:1];
    length++;
    memcpy((uint8_t *)frame.mutableBytes + 72, &length, sizeof length);
    check(readCaptureFrame(frame) == nil, "a block with trailing undecompressed input is rejected");
    fprintf(stderr, "%s: native capture frame decoder (%.1fms)\n", failures ? "FAIL" : "PASS",
        ([NSDate timeIntervalSinceReferenceDate] - began) * 1000);
    return failures ? 1 : 0;
}}
