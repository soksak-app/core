// 실제로 기록한 파일을 크기 헤더까지만 남겨 인수 검사의 불완전한 버퍼 거부를 검사한다.
#import <Cocoa/Cocoa.h>
#import "capture.h"
#include <unistd.h>

static NSString *recordingDirectory;
static BOOL faultApplied;
static bool startWithDirectory(const char *directory) {
    bool started = sp_capture_start(directory);
    if (started) recordingDirectory = [[NSString stringWithUTF8String:directory] copy];
    return started;
}
static int stopWithTruncatedFrame(double after) {
    int count = sp_capture_stop(after);
    if (count > 0) {
        NSString *file = [recordingDirectory stringByAppendingPathComponent:@"frame-0001.bgra"];
        faultApplied = truncate(file.UTF8String, 3 * sizeof(uint32_t)) == 0;
        if (!faultApplied) fprintf(stderr, "fixture frame truncation failed: %s\n", strerror(errno));
    }
    return count;
}

#define sp_capture_start startWithDirectory
#define sp_capture_stop stopWithTruncatedFrame
#define main captureAcceptanceMain
#import "capture_test.m"
#undef main
#undef sp_capture_stop
#undef sp_capture_start

int main(void) {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: native capture file completeness checker\n");
    int result = captureAcceptanceMain();
    BOOL rejected = faultApplied && result != 0 && failures == 1;
    fprintf(stderr,
        "%s: capture acceptance rejects a dimension-only frame (fault=%d, result=%d, failures=%d, %.1fms)\n",
        rejected ? "PASS" : "FAIL", faultApplied, result, failures, (CACurrentMediaTime() - began) * 1000);
    [recordingDirectory release];
    return rejected ? 0 : 1;
}
